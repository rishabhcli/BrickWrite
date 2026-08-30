import { describe, expect, it, vi } from 'vitest'
import { readCompleteHistory } from '../history'
import type { CloudHistoryPage, CloudResult } from '../protocol'
import { transactionChecksum } from '../serialize'
import { claimedProject, commitAll, makeHarness } from './harness'

const okPage = (overrides: Partial<CloudHistoryPage>): CloudResult<CloudHistoryPage> => ({
  ok: true,
  value: {
    branchId: 'main',
    headRevision: 1,
    nextRevision: 0,
    transactions: [],
    done: false,
    ...overrides,
  },
})

describe('complete history client and recovery', () => {
  it('refuses a non-advancing page instead of looping forever', async () => {
    const readHistory = vi.fn().mockResolvedValue(okPage({}))
    expect(await readCompleteHistory({ readHistory }, { projectId: 'project', sinceRevision: 0 })).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
    expect(readHistory).toHaveBeenCalledTimes(1)
  })

  it.each([{ done: true }, { nextRevision: 1, done: true }, { branchId: 'other' }, { headRevision: 99 }])(
    'refuses an inconsistent page contract %j',
    async (overrides) => {
      const readHistory = vi.fn().mockResolvedValue(okPage(overrides))
      expect(
        await readCompleteHistory(
          { readHistory },
          { projectId: 'project', branchId: 'main', sinceRevision: 0, throughRevision: 1 },
        ),
      ).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
    },
  )

  it('reconciles the entire remote tail, not just the first 500 transactions', async () => {
    const h = makeHarness()
    const { document, cloudProjectId } = await claimedProject(h)
    const history = commitAll(
      document,
      Array.from({ length: 503 }, (_, i) => [{ type: 'document.rename', name: `Revision ${i}` }]),
    )
    for (const transaction of history.transactions) {
      expect(
        (
          await h.backend.appendTransaction({
            projectId: cloudProjectId,
            clientTransactionId: transaction.id,
            transaction,
            baseRevision: transaction.baseRevision,
            resultRevision: transaction.resultRevision,
            checksum: transactionChecksum(transaction),
            schemaVersion: document.schemaVersion,
            catalogVersion: document.catalogVersion,
          })
        ).ok,
      ).toBe(true)
    }
    const read = vi.spyOn(h.backend, 'readHistory')
    const resolved = await h.store.resolveDivergence(document.id)
    expect(resolved).toMatchObject({
      ok: true,
      value: { kind: 'fast-forward', document: { revision: 503, name: 'Revision 502' } },
    })
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls.slice(1).every(([args]) => args.throughRevision === 503)).toBe(true)
    expect(await h.local.loadProject(document.id)).toMatchObject({ ok: true, value: { document: { revision: 503 } } })
  })

  it('preserves the local document and queued edits when remote history is incomplete', async () => {
    const h = makeHarness()
    const { document, cloudProjectId } = await claimedProject(h)
    const remote = commitAll(document, [[{ type: 'document.rename', name: 'Remote' }]])
    const transaction = remote.transactions[0]
    expect(
      (
        await h.backend.appendTransaction({
          projectId: cloudProjectId,
          clientTransactionId: transaction.id,
          transaction,
          baseRevision: 0,
          resultRevision: 1,
          checksum: transactionChecksum(transaction),
          schemaVersion: document.schemaVersion,
          catalogVersion: document.catalogVersion,
        })
      ).ok,
    ).toBe(true)
    const local = commitAll(document, [[{ type: 'document.rename', name: 'Keep local' }]])
    await h.store.appendTransaction(document.id, local.transactions[0])
    h.deployment.transactions.splice(0, 1)
    const before = await h.local.loadProject(document.id)
    const queued = structuredClone(h.outbox.pending)
    expect(await h.store.resolveDivergence(document.id)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
    expect(await h.local.loadProject(document.id)).toEqual(before)
    expect(h.outbox.pending).toEqual(queued)
    expect(h.outbox.pending).toHaveLength(1)
  })
})
