// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalProjectStore } from '../projectStore'
import { transactionChecksum } from '../serialize'
import { CloudSyncStatus } from '../SyncStatus'
import { SIGNED_OUT_IDENTITY } from '../runtime'
import type { AppendTransactionArgs } from '../protocol'
import { blankProject, part, placements } from './harness'
import {
  fakeWorkbenchApi,
  makeUiHarness,
  overrideBackend,
  SIGNED_IN,
  withRuntime,
  type UiHarness,
} from './uiHarness'

/**
 * The status readout, driven by a real outbox against the deployment double.
 *
 * The states below are reached the way they are reached in production — by
 * claiming, committing and draining — rather than by handing the component a
 * hand-written state object, because the question these tests answer is whether
 * the line stays honest while real things go wrong.
 */

afterEach(cleanup)

const OPEN = 'doc_ui'

async function claimed(harness: UiHarness) {
  const local = new LocalProjectStore(harness.driver)
  const document = harness.engine.getSnapshot().document
  await local.saveCheckpoint(document)
  const store = harness.runtime.getSnapshot().store
  if (!store) throw new Error('This harness has no cloud store.')
  const outcome = await store.claim(OPEN)
  if (!outcome.ok) throw new Error(outcome.error.message)
  harness.runtime.notifyLinksChanged()
  return { store, document, ...outcome.value }
}

const commit = (harness: UiHarness, id: string) => {
  const revision = harness.engine.getSnapshot().document.revision
  const result = harness.engine.execute(
    `Place ${id}`,
    [{ type: 'part.add', part: part(id) }],
    'human',
    revision,
  )
  if (!result.ok) throw new Error(result.error.message)
}

async function mount(harness: UiHarness, overrides = {}) {
  const api = fakeWorkbenchApi(harness.engine, overrides)
  await act(async () => {
    render(withRuntime(harness.runtime, <CloudSyncStatus api={api} />))
  })
  return api
}

const readout = () => screen.getByTestId('cloud-sync-status')

describe('cloud status readout', () => {
  it('reports the unconfigured deployment, which is this build’s default', async () => {
    const harness = makeUiHarness()
    await mount(harness)
    expect(readout()).toHaveAttribute('data-status', 'unconfigured')
    expect(readout()).toHaveTextContent('Local only')
    expect(readout().getAttribute('aria-label')).toContain('VITE_CONVEX_URL is not set')
  })

  it('reports a signed-out browser without claiming anything is saved', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_OUT_IDENTITY })
    await mount(harness)
    expect(readout()).toHaveAttribute('data-status', 'idle')
    expect(readout()).toHaveTextContent('Local only')
    expect(readout().getAttribute('aria-label')).toContain('Sign in')
  })

  it('does not say "synced" for a claimed project until a change has landed', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimed(harness)
    await mount(harness)
    await waitFor(() => expect(readout()).toHaveTextContent('In the cloud'))
    expect(readout()).not.toHaveTextContent('Synced')
  })

  it('says "synced" once the queue has actually drained', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const scene = await claimed(harness)
    await mount(harness)

    commit(harness, 'p1')
    await act(async () => {
      await harness.runtime.getSnapshot().handle!.flush()
      await harness.runtime.getSnapshot().handle!.outbox.drain()
    })

    await waitFor(() => expect(readout()).toHaveTextContent('Synced'))
    expect(readout()).toHaveAttribute('data-status', 'idle')
    // And the deployment really holds it.
    const log = await harness.backend.listTransactions({
      projectId: scene.projectId,
      sinceRevision: 0,
    })
    expect(log.ok && log.value).toHaveLength(1)
  })

  it('reports a conflict, with the head the local tail must rebase onto', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const scene = await claimed(harness)
    await mount(harness)

    // Somebody else advanced the branch from the same base revision.
    const foreign = placements(scene.document, ['other_part']).transactions[0]
    const args: AppendTransactionArgs = {
      projectId: scene.projectId,
      clientTransactionId: foreign.id,
      baseRevision: foreign.baseRevision,
      resultRevision: foreign.resultRevision,
      transaction: foreign,
      checksum: transactionChecksum(foreign),
      schemaVersion: scene.document.schemaVersion,
      catalogVersion: scene.document.catalogVersion,
    }
    const landed = await harness.backend.appendTransaction(args)
    expect(landed.ok).toBe(true)

    commit(harness, 'p1')
    await act(async () => {
      await harness.runtime.getSnapshot().handle!.flush()
      await harness.runtime.getSnapshot().handle!.outbox.drain()
    })

    await waitFor(() => expect(readout()).toHaveAttribute('data-status', 'conflict'))
    expect(readout()).toHaveTextContent('Conflict')
    expect(readout()).toHaveTextContent('1 queued')
    expect(readout().getAttribute('aria-label')).toMatch(/revision/i)
  })

  it('reports a permanently refused change as an error, and keeps it queued', async () => {
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          appendTransaction: async () => ({
            ok: false,
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: 'That change is larger than the deployment accepts.',
              repair: 'Split the edit, or checkpoint first.',
            },
          }),
        }),
    })
    await claimed(harness)
    await mount(harness)

    commit(harness, 'p1')
    await act(async () => {
      await harness.runtime.getSnapshot().handle!.flush()
      await harness.runtime.getSnapshot().handle!.outbox.drain()
    })

    await waitFor(() => expect(readout()).toHaveAttribute('data-status', 'error'))
    expect(readout()).toHaveTextContent('Sync stopped')
    // Parked, never skipped: the entry is still in the queue.
    expect(harness.runtime.getSnapshot().handle!.outbox.pending).toHaveLength(1)
  })

  it('reports offline rather than an empty-queue "synced"', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN, online: false })
    await claimed(harness)
    await mount(harness, { online: false })
    await waitFor(() => expect(readout()).toHaveAttribute('data-status', 'offline'))
    expect(readout()).toHaveTextContent('Offline')
  })

  it('is a labelled, keyboard-reachable control that opens the version history', async () => {
    const harness = makeUiHarness()
    const api = await mount(harness)
    const button = readout()
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button.getAttribute('aria-label')).toMatch(/^Cloud: Local only\./)

    button.focus()
    expect(document.activeElement).toBe(button)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(api.calls.modal).toEqual(['cloud.version-history'])
  })

  it('never reports a project it has not been told about', async () => {
    // A second document, never claimed, must not inherit the first one's state.
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimed(harness)
    harness.engine.replaceDocument(blankProject('doc_other', 'Something else'))
    await mount(harness)
    await waitFor(() => expect(readout()).toHaveTextContent('Local only'))
    expect(readout().getAttribute('aria-label')).toContain('has not been claimed')
  })
})
