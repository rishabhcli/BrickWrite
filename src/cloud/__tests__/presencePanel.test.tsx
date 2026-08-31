// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudPresencePanel } from '../PresencePanel'
import { LocalProjectStore } from '../projectStore'
import { PRESENCE_TTL_MS } from '../protocol'
import { SIGNED_OUT_IDENTITY } from '../runtime'
import { addMember, BOB } from './harness'
import {
  fakeWorkbenchApi,
  makeUiHarness,
  overrideBackend,
  SIGNED_IN,
  withRuntime,
  type UiHarness,
} from './uiHarness'

/**
 * The roster half of presence.
 *
 * `presence.ts` and `convex/presence.ts` were built and covered long before
 * anything rendered them, so these tests are about the seam rather than the
 * reducer: that a mounted panel announces this tab, reads the others back, and
 * — the part that matters most — that every failure on that path degrades to
 * "you are the only one here" rather than to an error surface. Presence is the
 * one thing in this workstream that is allowed to be lost.
 */

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const OPEN = 'doc_ui'

async function claimOpenProject(harness: UiHarness): Promise<string> {
  const local = new LocalProjectStore(harness.driver)
  await local.saveCheckpoint(harness.engine.getSnapshot().document)
  const store = harness.runtime.getSnapshot().store
  if (!store) throw new Error('This harness has no cloud store.')
  const claimed = await store.claim(OPEN)
  if (!claimed.ok) throw new Error(claimed.error.message)
  harness.runtime.notifyLinksChanged()
  const link = await harness.runtime.getSnapshot().links.get(OPEN)
  if (!link) throw new Error('The claim recorded no link.')
  return link.cloudProjectId
}

async function mount(harness: UiHarness) {
  const api = fakeWorkbenchApi(harness.engine)
  await act(async () => {
    render(withRuntime(harness.runtime, <CloudPresencePanel api={api} />))
  })
  return api
}

describe('the presence roster', () => {
  it('says you are alone rather than erroring, on every path that has no peers to show', async () => {
    // Unconfigured, signed out, and claimed-but-empty are three different
    // situations and one honest sentence. The Share panel owns the explanations
    // and the repairs; a roster that turned "no deployment" into an error would
    // be shouting about something the operator did not ask about.
    for (const harness of [
      makeUiHarness(),
      makeUiHarness({ configured: true, identity: SIGNED_OUT_IDENTITY }),
    ]) {
      await mount(harness)
      expect(screen.getByTestId('cloud-presence-panel')).toHaveTextContent('You are the only one here.')
      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()
    }
  })

  it('announces this tab and lists the peers it reads back', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const cloudProjectId = await claimOpenProject(harness)
    await addMember(harness.deployment, harness.backend, cloudProjectId, BOB, 'editor')

    const bob = harness.deployment.as(BOB)
    const announced = await bob.presenceHeartbeat({
      projectId: cloudProjectId,
      sessionId: 'bob-tab-1',
      revision: harness.engine.getSnapshot().document.revision,
      selection: ['p1', 'p2'],
    })
    expect(announced.ok).toBe(true)

    await mount(harness)
    const peer = await screen.findByTestId('cloud-presence-peer')
    expect(peer).toHaveTextContent('Bob')
    expect(peer).toHaveTextContent('2 parts selected')

    // This tab published itself, and does not appear in its own roster.
    await waitFor(async () => {
      const rows = await bob.listPresence({ projectId: cloudProjectId })
      expect(rows.ok && rows.value.length).toBe(2)
    })
    expect(screen.getAllByTestId('cloud-presence-peer')).toHaveLength(1)
  })

  it('lets go of a stale roster it can no longer refresh', async () => {
    // The case the client-side expiry check exists for: the tab has a list, then
    // loses the deployment. While the server is answering, the server's word is
    // final — a peer it still returns is present. Once it stops answering, the
    // held list ages out on its own rather than showing a room full of people
    // who left.
    let reachable = true
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          listPresence: async (args) =>
            reachable
              ? backend.listPresence(args)
              : {
                  ok: false as const,
                  error: {
                    code: 'OFFLINE' as const,
                    message: 'The cloud is unreachable: fetch failed.',
                    repair: 'Keep working; queued changes are sent when the connection returns.',
                  },
                },
        }),
    })
    const cloudProjectId = await claimOpenProject(harness)
    await addMember(harness.deployment, harness.backend, cloudProjectId, BOB, 'editor')
    await harness.deployment.as(BOB).presenceHeartbeat({
      projectId: cloudProjectId,
      sessionId: 'bob-tab-1',
      revision: 1,
      selection: [],
    })

    await mount(harness)
    await screen.findByTestId('cloud-presence-peer')

    reachable = false
    vi.setSystemTime(Date.now() + PRESENCE_TTL_MS * 2)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_200))
    })
    await waitFor(() => expect(screen.queryByTestId('cloud-presence-peer')).toBeNull())
  }, 15_000)

  it('follows a peer by adopting their selection, and says so', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const cloudProjectId = await claimOpenProject(harness)
    await addMember(harness.deployment, harness.backend, cloudProjectId, BOB, 'editor')
    // Presence selection is advisory, and travels as ids: the panel forwards
    // exactly what the peer reported and lets the editor decide what is real.
    const parts = ['part_hull_01', 'part_hull_02']
    await harness.deployment.as(BOB).presenceHeartbeat({
      projectId: cloudProjectId,
      sessionId: 'bob-tab-1',
      revision: 1,
      selection: parts,
    })

    const api = await mount(harness)
    const follow = await screen.findByRole('button', { name: 'Follow' })
    await act(async () => {
      fireEvent.click(follow)
    })
    expect(screen.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true')
    // Following is a local jump, not a document write: the selection moves and
    // the transaction log does not.
    expect(api.calls.selected.at(-1)).toEqual(parts)
    expect(harness.dispatches).toHaveLength(0)
  })

  it('degrades to silence when the deployment refuses presence', async () => {
    const refusal = {
      ok: false as const,
      error: {
        code: 'OFFLINE' as const,
        message: 'The cloud is unreachable: fetch failed.',
        repair: 'Keep working; queued changes are sent when the connection returns.',
      },
    }
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          presenceHeartbeat: async () => refusal,
          listPresence: async () => refusal,
        }),
    })
    await claimOpenProject(harness)
    await mount(harness)

    // No banner, no notice, no retry storm. An empty roster is the honest
    // answer, and from here "the deployment is unreachable" and "nobody else is
    // here" are the same fact.
    expect(screen.getByTestId('cloud-presence-panel')).toHaveTextContent('You are the only one here.')
    expect(screen.queryByTestId('cloud-presence-peer')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
