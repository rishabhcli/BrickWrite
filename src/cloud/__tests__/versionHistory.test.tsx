// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalProjectStore, type MirroredProjectStore } from '../projectStore'
import { SIGNED_OUT_IDENTITY } from '../runtime'
import { CloudVersionHistory } from '../VersionHistory'
import type { AppendTransactionArgs } from '../protocol'
import { transactionChecksum } from '../serialize'
import { part, placements } from './harness'
import {
  fakeWorkbenchApi,
  makeUiHarness,
  overrideBackend,
  SIGNED_IN,
  withRuntime,
  type UiHarness,
} from './uiHarness'

/**
 * Version history, against the deployment double.
 *
 * The property under test throughout is that a restore is *new work*: it goes
 * through the command bus with the revision it was planned on, it lands on the
 * head, and nothing is rewound or overwritten. The conflict-fork case checks
 * the other half — that when two histories exist, both are drawn.
 */

afterEach(cleanup)

const OPEN = 'doc_ui'

const commit = (harness: UiHarness, id: string) => {
  const revision = harness.engine.getSnapshot().document.revision
  const result = harness.engine.execute(
    `Place ${id}`,
    [{ type: 'part.add', part: part(id, [Number(id.replace(/\D/g, '')) * 100, 0, 0]) }],
    'human',
    revision,
  )
  if (!result.ok) throw new Error(result.error.message)
}

async function claimOpenProject(harness: UiHarness): Promise<MirroredProjectStore> {
  const local = new LocalProjectStore(harness.driver)
  await local.saveCheckpoint(harness.engine.getSnapshot().document)
  const store = harness.runtime.getSnapshot().store
  if (!store) throw new Error('This harness has no cloud store.')
  const claimed = await store.claim(OPEN)
  if (!claimed.ok) throw new Error(claimed.error.message)
  harness.runtime.notifyLinksChanged()
  return store
}

async function mount(harness: UiHarness, overrides = {}) {
  const api = fakeWorkbenchApi(harness.engine, { activeModal: 'cloud.version-history', ...overrides })
  await act(async () => {
    render(withRuntime(harness.runtime, <CloudVersionHistory api={api} />))
  })
  return api
}

describe('Version history — states with nothing to show', () => {
  it('explains an unconfigured deployment, and what the editor keeps instead', async () => {
    const harness = makeUiHarness()
    await mount(harness)
    expect(screen.getByTestId('cloud-version-history')).toHaveAttribute('role', 'presentation')
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('No cloud is configured, so there are no versions')
    expect(note).toHaveTextContent('VITE_CONVEX_URL is not set')
    expect(note).toHaveTextContent('every edit is still recorded, undoable and replayable')
  })

  it('asks a signed-out operator to sign in, without hiding local history', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_OUT_IDENTITY })
    await mount(harness)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent("Sign in to see this project's versions")
    expect(note).toHaveTextContent('Your local history is unaffected')
  })

  it('says plainly that an unclaimed project has no cloud replica', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await mount(harness)
    await waitFor(() =>
      expect(screen.getByRole('note')).toHaveTextContent('This project has no cloud replica'),
    )
    expect(screen.getByRole('note')).toHaveTextContent('Save to cloud')
  })

  it('shows a loading state before the deployment has answered', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    const api = fakeWorkbenchApi(harness.engine, { activeModal: 'cloud.version-history' })
    render(withRuntime(harness.runtime, <CloudVersionHistory api={api} />))
    expect(screen.getByRole('status')).toHaveTextContent(/Checking|Reading/)
    await act(async () => {})
  })

  it('reports a deployment that refuses the read', async () => {
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          listBranches: async () => ({
            ok: false,
            error: {
              code: 'OFFLINE',
              message: 'The cloud is unreachable: fetch failed.',
              repair: 'Keep working; queued changes are sent when the connection returns.',
            },
          }),
        }),
    })
    await claimOpenProject(harness)
    await mount(harness)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The deployment refused part of this read'),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The cloud is unreachable')
  })

  it('says a branch has no pinned versions without implying its log is missing', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByRole('region', { name: /Branch main/ })).toBeInTheDocument())
    expect(screen.getByText(/No versions have been pinned on this branch/)).toBeInTheDocument()
    expect(screen.getByText(/transaction log is still\s+complete on the deployment/)).toBeInTheDocument()
  })
})

describe('Version history — the happy path', () => {
  it('pins a version, compares it, and restores it as new work on the head', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const store = await claimOpenProject(harness)

    commit(harness, 'p1')
    const pinned = await store.createVersion(OPEN, 'Hull complete', harness.engine.getSnapshot().document)
    expect(pinned.ok).toBe(true)
    commit(harness, 'p2')
    expect(harness.engine.getSnapshot().document.revision).toBe(2)

    await mount(harness)
    await waitFor(() => expect(screen.getByText('Hull complete')).toBeInTheDocument())
    expect(screen.getByText('r1')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compare with open document' }))
    })
    const comparison = await screen.findByRole('region', { name: 'Comparison with Hull complete' })
    // The summary reads forward from the version to the open document: a part
    // was added since it. The restore is the inverse, and is spelled out below.
    expect(comparison).toHaveTextContent('Since that version: 1 part added')
    expect(comparison).toHaveTextContent(/would be applied as one transaction/)

    await act(async () => {
      fireEvent.click(within(comparison).getByRole('button', { name: /Restore as a new revision/ }))
    })

    await waitFor(() => expect(screen.getByText(/Restored as revision 3/)).toBeInTheDocument())
    // Through the command bus, with the revision the plan was computed against.
    expect(harness.dispatches).toHaveLength(1)
    expect(harness.dispatches[0].label).toBe('Restore version “Hull complete”')
    expect(harness.dispatches[0].expectedRevision).toBe(2)
    // New work on the head: nothing was rewound.
    const after = harness.engine.getSnapshot().document
    expect(after.revision).toBe(3)
    expect(Object.keys(after.parts)).toEqual(['p1'])
    expect(harness.engine.getSnapshot().transactions).toHaveLength(3)
    // And the restore is itself pinned, so it is as recoverable as anything else.
    const versions = await store.listVersions(OPEN)
    expect(versions.ok && versions.value.map((entry) => entry.label)).toContain(
      'Restored “Hull complete”',
    )
  })

  it('refuses a restore planned against a revision that has moved', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const store = await claimOpenProject(harness)
    commit(harness, 'p1')
    await store.createVersion(OPEN, 'Hull complete', harness.engine.getSnapshot().document)
    commit(harness, 'p2')

    await mount(harness)
    await waitFor(() => expect(screen.getByText('Hull complete')).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compare with open document' }))
    })
    const comparison = await screen.findByRole('region', { name: 'Comparison with Hull complete' })

    // The kernel is the authority on the revision, and the dispatch seam
    // carries the one the plan was made on. Moving the head under the dialog
    // has to be refused, not merged.
    const stale = harness.kernel.dispatch(
      'Restore version “Hull complete”',
      [{ type: 'part.remove', partId: 'p2' }],
      0,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_DOCUMENT')
    expect(comparison).toBeInTheDocument()
  })

  it('pins the current revision as an immutable version', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const store = await claimOpenProject(harness)
    commit(harness, 'p1')
    await mount(harness)
    await waitFor(() => expect(screen.getByRole('region', { name: /Branch main/ })).toBeInTheDocument())

    const field = screen.getByLabelText('Label for a new version of the current revision')
    fireEvent.change(field, { target: { value: 'Before the roof' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save version/ }))
    })

    await waitFor(() => expect(screen.getByText(/Pinned “Before the roof”/)).toBeInTheDocument())
    const versions = await store.listVersions(OPEN)
    expect(versions.ok && versions.value).toHaveLength(1)
    expect(versions.ok && versions.value[0].revision).toBe(1)
  })

  it('creates a named branch from the current head', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const store = await claimOpenProject(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByRole('region', { name: /Branch main/ })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Name for a new branch'), {
      target: { value: 'wider-chassis' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Branch$/ }))
    })

    await waitFor(() => expect(screen.getByText(/Branch “wider-chassis”/)).toBeInTheDocument())
    const branches = await store.listBranches(OPEN)
    expect(branches.ok && branches.value.map((branch) => branch.name).sort()).toEqual([
      'main',
      'wider-chassis',
    ])
  })
})

describe('Version history — a conflict fork', () => {
  it('draws both histories, and says neither was discarded', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const store = await claimOpenProject(harness)
    commit(harness, 'p1')
    await store.createVersion(OPEN, 'Main line', harness.engine.getSnapshot().document)

    const fork = await store.createBranch(OPEN, 'conflict-2026-08-28', {
      kind: 'conflict',
      atRevision: 0,
    })
    expect(fork.ok).toBe(true)
    if (!fork.ok) return
    await store.createVersion(OPEN, 'Diverged tail', harness.engine.getSnapshot().document, {
      branchId: fork.value.branchId,
    })

    await mount(harness)
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Branch conflict-2026-08-28' })).toBeInTheDocument(),
    )

    // Both histories, each under its own branch, with the fork explained.
    expect(screen.getByRole('region', { name: 'Branch main' })).toHaveTextContent('Main line')
    expect(screen.getByRole('region', { name: 'Branch conflict-2026-08-28' })).toHaveTextContent(
      'Diverged tail',
    )
    const notice = screen.getByText(/This project has a conflict fork/).closest('div')!
    expect(notice).toHaveTextContent('Neither was discarded')
    expect(notice).toHaveTextContent('same ids, same')
  })
})

describe('Version history — accessibility', () => {
  it('is a modal dialog that traps focus, closes on Escape and restores it', async () => {
    const harness = makeUiHarness()
    const opener = document.createElement('button')
    opener.textContent = 'Open history'
    document.body.append(opener)
    opener.focus()

    const api = await mount(harness)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Version history')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    // Tab wraps rather than escaping to the page behind.
    const focusable = within(dialog).getAllByRole('button')
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' })
    })
    expect(api.calls.modal).toEqual([null])

    cleanup()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('warns while offline that what is listed may be stale', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN, online: false })
    await claimOpenProject(harness)
    await mount(harness, { online: false })
    await waitFor(() =>
      expect(screen.getByText(/This browser is offline/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/whatever was read before the connection dropped/)).toBeInTheDocument()
  })
})

describe('Version history — sync recovery', () => {
  async function parkConflict(harness: UiHarness) {
    const store = await claimOpenProject(harness)
    const document = harness.engine.getSnapshot().document
    const link = await harness.runtime.getSnapshot().links.get(OPEN)
    if (!link) throw new Error('missing link')
    const foreign = placements(document, ['other_part']).transactions[0]
    const args: AppendTransactionArgs = {
      projectId: link.cloudProjectId,
      clientTransactionId: foreign.id,
      baseRevision: foreign.baseRevision,
      resultRevision: foreign.resultRevision,
      transaction: foreign,
      checksum: transactionChecksum(foreign),
      schemaVersion: document.schemaVersion,
      catalogVersion: document.catalogVersion,
    }
    const landed = await harness.backend.appendTransaction(args)
    expect(landed.ok).toBe(true)
    commit(harness, 'p1')
    await act(async () => {
      await harness.runtime.getSnapshot().handle!.flush()
      await harness.runtime.getSnapshot().handle!.outbox.drain()
    })
    return store
  }

  it('resolves a conflict from the version history dialog', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await parkConflict(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /backfill/i })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    })
    await waitFor(() => expect(screen.getByText(/Divergence reconciled|Both histories preserved/)).toBeInTheDocument())
    expect(harness.runtime.getSnapshot().handle!.outbox.pending.filter((entry) => entry.parked)).toHaveLength(0)
  })

  it('refuses to offer backfill while the head is still parked', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await parkConflict(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /backfill/i })).toBeNull()
  })

  it('re-drains after discardHead rather than reporting idle optimistically', async () => {
    let calls = 0
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          appendTransaction: async (args) => {
            calls += 1
            if (calls === 1) {
              return {
                ok: false as const,
                error: {
                  code: 'PAYLOAD_TOO_LARGE' as const,
                  message: 'That change is larger than the deployment accepts.',
                  repair: 'Split the edit.',
                },
              }
            }
            return backend.appendTransaction(args)
          },
        }),
    })
    await claimOpenProject(harness)
    await mount(harness)
    commit(harness, 'p1')
    commit(harness, 'p2')
    await act(async () => {
      await harness.runtime.getSnapshot().handle!.flush()
      await harness.runtime.getSnapshot().handle!.outbox.drain()
    })
    expect(harness.runtime.getSnapshot().handle!.outbox.pending).toHaveLength(2)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard this queued change' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Discard this queued change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }))
    await waitFor(() => {
      const remaining = harness.runtime.getSnapshot().handle!.outbox.pending[0]
      expect(remaining?.attempts ?? 0).toBeGreaterThan(0)
    })
  })
})
