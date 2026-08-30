// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { expect, it, vi } from 'vitest'
import schema from '../../../convex/schema'
import type { Id } from '../../../convex/_generated/dataModel'
import { ConvexCloudBackend } from '../convexClient'
import { CloudProjectStore, LocalProjectStore, MirroredProjectStore } from '../projectStore'
import { MemoryDriver } from '../../cad/persistence'
import { Outbox } from '../outbox'
import { claimLocalProject } from '../claim'
import { readCompleteHistory } from '../history'
import { sendTransactionBatch } from '../batches'
import type { CloudResult, BatchTransaction } from '../protocol'
import { snapshotUploadFor, transactionChecksum } from '../serialize'
import { blankProject, placements } from './harness'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
async function setup() {
  const t = convexTest(schema, modules).withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = blankProject('transaction-integrity')
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: 2,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const history = placements(base, ['one', 'two'])
  const entry = (index: number): BatchTransaction => {
    const transaction = structuredClone(history.transactions[index])
    return {
      transaction,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      checksum: transactionChecksum(transaction),
      schemaVersion: 2,
      catalogVersion: base.catalogVersion,
    }
  }
  const counts = () =>
    t.run(async (ctx) => ({
      edits: (await ctx.db.query('transactions').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
      head: (await ctx.db.get(project.defaultBranchId as Id<'branches'>))!.headRevision,
    }))
  return { t, backend, base, project, history, entry, counts }
}

it.each(['part', 'inverse', 'touched', 'scope', 'operation'])(
  'rejects checksum-valid malformed %s data before committing a batch',
  async (fault) => {
    const h = await setup()
    const second = h.entry(1)
    const transaction = second.transaction
    if (fault === 'part') {
      const patch = transaction.patch.forward.find((m) => m.kind === 'part')!
      if (patch.kind === 'part' && patch.value) delete (patch.value as Partial<typeof patch.value>).transform
    }
    if (fault === 'inverse')
      transaction.patch = {
        ...transaction.patch,
        inverse: [{ kind: 'part', id: 'two', value: { id: 'two' } } as never],
      }
    if (fault === 'touched') transaction.patch = { ...transaction.patch, touched: undefined as never }
    if (fault === 'scope') transaction.patch = { ...transaction.patch, touched: { partIds: [], subassemblyIds: [] } }
    if (fault === 'operation') transaction.operations = [{ type: 'part.transform', partId: 'two' } as never]
    second.checksum = transactionChecksum(transaction)
    const before = await h.counts()
    expect(
      await h.backend.appendTransactions({ projectId: h.project.projectId, transactions: [h.entry(0), second] }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', details: { batchIndex: 1 } } })
    expect(await h.counts()).toEqual(before)
  },
)

it('refuses already-stored malformed undo data before returning a replayable project', async () => {
  const h = await setup()
  const saved = value(await h.backend.appendTransaction({ projectId: h.project.projectId, ...h.entry(0) }))
  await h.t.run(async (ctx) => {
    const row = (await ctx.db.get(saved.transactionId as Id<'transactions'>))!
    const transaction = structuredClone(row.payload)
    transaction.patch.inverse = [{ kind: 'unknown', value: 'bad undo' }]
    await ctx.db.patch(row._id, { payload: transaction, checksum: transactionChecksum(transaction) })
  })
  expect(await new CloudProjectStore(h.backend).loadProject(h.project.projectId)).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_HISTORY' },
  })
  expect(await h.backend.listTransactions({ projectId: h.project.projectId, sinceRevision: 0 })).toMatchObject({
    ok: false,
    error: { code: 'INCOMPLETE_HISTORY' },
  })
  expect(
    await h.backend.findTransaction({
      projectId: h.project.projectId,
      clientTransactionId: h.history.transactions[0].id,
    }),
  ).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
})

it('validates scalar writes too and preserves a useful field path', async () => {
  const h = await setup()
  const entry = h.entry(0)
  entry.transaction.author = 'robot' as never
  entry.checksum = transactionChecksum(entry.transaction)
  const before = await h.counts()
  expect(await h.backend.appendTransaction({ projectId: h.project.projectId, ...entry })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', details: { path: 'author', batchIndex: 0 } },
  })
  expect(await h.counts()).toEqual(before)
})

it.each(['non-finite', 'unsafe key'])(
  'rejects %s extension data before canonicalization and all writes',
  async (fault) => {
    const h = await setup()
    const entry = h.entry(0)
    Object.assign(entry.transaction, {
      extension: fault === 'non-finite' ? Infinity : JSON.parse('{"constructor":{"bad":true}}'),
    })
    entry.checksum = transactionChecksum(entry.transaction)
    const before = await h.counts()
    expect(await h.backend.appendTransactions({ projectId: h.project.projectId, transactions: [entry] })).toMatchObject(
      { ok: false, error: { code: 'INVALID_ARGUMENT' } },
    )
    expect(await h.counts()).toEqual(before)
  },
)

it('does not create a cloud shell for a local history with malformed undo data', async () => {
  const h = await setup()
  const local = new LocalProjectStore(new MemoryDriver())
  value(await local.saveCheckpoint(h.base))
  value(await local.appendTransaction(h.base.id, h.history.transactions[0]))
  h.history.transactions[0].patch = { ...h.history.transactions[0].patch, inverse: [] }
  const before = await local.readLog(h.base.id)
  const create = vi.spyOn(h.backend, 'createProject')
  expect(await claimLocalProject({ backend: h.backend, local, localProjectId: h.base.id })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
  })
  expect(create).not.toHaveBeenCalled()
  expect(await local.readLog(h.base.id)).toEqual(before)
})

it('rejects unsafe prototype keys locally before the transport can discard them during encoding', async () => {
  const h = await setup()
  const entry = h.entry(0)
  Object.assign(entry.transaction, { extension: JSON.parse('{"__proto__":{"bad":true}}') })
  const send = vi.spyOn(h.backend, 'appendTransaction')
  expect(
    await sendTransactionBatch(h.backend, { projectId: h.project.projectId, transactions: [entry] }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  expect(send).not.toHaveBeenCalled()
})

it.each(['shape', 'cycle'])('parks corrupt %s data in the outbox while sending the valid prefix', async (fault) => {
  const h = await setup()
  const driver = new MemoryDriver()
  const outbox = new Outbox(driver, h.backend)
  for (const [index, transaction] of h.history.transactions.entries())
    value(await outbox.queueTransaction(h.project.projectId, h.history.documents[index], transaction))
  const bad = outbox.pending[1]
  if (bad.payload.kind !== 'transaction') throw new Error('Expected transaction')
  if (fault === 'shape') bad.payload.transaction.patch = { ...bad.payload.transaction.patch, inverse: [] }
  else Object.assign(bad.payload.transaction, { extension: bad.payload.transaction })
  expect(await outbox.drain()).toMatchObject({ status: 'error', pending: 1, lastError: { code: 'INVALID_ARGUMENT' } })
  expect(await h.counts()).toMatchObject({ edits: 1, head: 1 })
  expect((await driver.range('meta', 'outbox:')).length).toBe(1)
  const restarted = new Outbox(driver, h.backend)
  expect(await restarted.drain()).toMatchObject({ status: 'error', pending: 1 })
  expect(restarted.pending[0].key).toBe(bad.key)
})

it('revalidates custom-host responses instead of trusting the server to check their shape', async () => {
  const h = await setup()
  value(await h.backend.appendTransactions({ projectId: h.project.projectId, transactions: [h.entry(0), h.entry(1)] }))
  const response = value(await h.backend.readHistory({ projectId: h.project.projectId, sinceRevision: 0 }))
  response.transactions[1].transaction.patch = {
    ...response.transactions[1].transaction.patch,
    touched: { partIds: [], subassemblyIds: [] },
  }
  response.transactions[1].checksum = transactionChecksum(response.transactions[1].transaction)
  const readHistory = vi.fn().mockResolvedValue({ ok: true, value: response })
  expect(
    await readCompleteHistory({ readHistory }, { projectId: h.project.projectId, sinceRevision: 0 }),
  ).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
})

it('refuses malformed local change-tracking before conflict recovery rewrites any history', async () => {
  const h = await setup()
  const driver = new MemoryDriver()
  const local = new LocalProjectStore(driver)
  const cloud = new CloudProjectStore(h.backend)
  const outbox = new Outbox(driver, h.backend)
  const store = new MirroredProjectStore(local, cloud, outbox, h.backend)
  value(await local.saveCheckpoint(h.base))
  value(await local.appendTransaction(h.base.id, h.history.transactions[0]))
  value(await outbox.queueTransaction(h.project.projectId, h.history.documents[0], h.history.transactions[0]))
  await store.links.put({
    localProjectId: h.base.id,
    cloudProjectId: h.project.projectId,
    branchId: h.project.defaultBranchId,
    claimedAt: new Date().toISOString(),
    syncedRevision: 0,
  })
  h.history.transactions[0].patch = { ...h.history.transactions[0].patch, touched: { partIds: [], subassemblyIds: [] } }
  const before = await local.readLog(h.base.id)
  const clear = vi.spyOn(outbox, 'clearProject')
  expect(await store.resolveDivergence(h.base.id)).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
  expect(clear).not.toHaveBeenCalled()
  expect(await local.readLog(h.base.id)).toEqual(before)
  expect(outbox.pending).toHaveLength(1)
})
