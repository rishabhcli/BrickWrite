// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import { appendTransactionBatch } from '../../../convex/model/append'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  cloudFailure,
} from '../protocol'
import { MemoryDriver } from '../../cad/persistence'
import { CloudProjectStore, LocalProjectStore, MirroredProjectStore } from '../projectStore'
import { Outbox } from '../outbox'
import { CadEngine } from '../../cad/engine'
import schema from '../../../convex/schema'
import { ConvexCloudBackend } from '../convexClient'
import { blankProject, commitAll, placements } from './harness'
import { snapshotUploadFor, transactionChecksum } from '../serialize'
import type { AppendTransactionArgs, AppendTransactionsArgs, AppendTransactionsValue, CloudResult } from '../protocol'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const batchRef = makeFunctionReference<'mutation', AppendTransactionsArgs, CloudResult<AppendTransactionsValue>>(
  'transactions:appendBatch',
)
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
async function setup(count = 3) {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = blankProject('batched-sync')
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const history =
    count <= 8
      ? placements(
          base,
          Array.from({ length: count }, (_, i) => `part_${i}`),
        )
      : commitAll(
          base,
          Array.from({ length: count }, (_, i) => [{ type: 'document.rename', name: `Revision ${i + 1}` }]),
        )
  const transactions = history.transactions.map((transaction) => ({
    clientTransactionId: transaction.id,
    baseRevision: transaction.baseRevision,
    resultRevision: transaction.resultRevision,
    transaction,
    checksum: transactionChecksum(transaction),
    schemaVersion: base.schemaVersion,
    catalogVersion: base.catalogVersion,
  }))
  const args = { projectId: project.projectId, branchId: project.defaultBranchId, transactions }
  const appendOne = (transaction: (typeof transactions)[number]) =>
    backend.appendTransaction({
      projectId: project.projectId,
      branchId: project.defaultBranchId,
      ...transaction,
    } as AppendTransactionArgs)
  const counts = () =>
    t.run(async (ctx) => ({
      transactions: (await ctx.db.query('transactions').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
      // One per committed batch, not one per edit: the count is a statement
      // about how many times the outbox actually reached the deployment.
      appendAudits: (await ctx.db.query('auditEvents').collect()).filter(
        (row) => row.action === 'transaction.append',
      ).length,
    }))
  return { deployment, t, backend, base, project, history, transactions, args, appendOne, counts }
}

describe('atomic cloud transaction batches (real Convex functions)', () => {
  it('stores an ordered history in one mutation and acknowledges each original edit', async () => {
    const h = await setup()
    const result = await h.t.mutation(batchRef, h.args)
    expect(result).toMatchObject({
      ok: true,
      value: {
        headRevision: 3,
        transactions: h.transactions.map((entry) => ({
          clientTransactionId: entry.clientTransactionId,
          resultRevision: entry.resultRevision,
          applied: true,
        })),
      },
    })
  })
})

it('round-trips the original payloads and audit entries, not a squashed replacement', async () => {
  const h = await setup()
  const before = await h.counts()
  value(await h.backend.appendTransactions(h.args))
  const restored = value(await new CloudProjectStore(h.backend).loadProject(h.project.projectId))!
  // Both local and cloud replay derive updatedAt from the persisted transaction
  // timestamp, not the separate wall-clock read used by the live engine.
  expect(restored.document).toEqual({ ...h.history.final, updatedAt: h.history.transactions.at(-1)!.timestamp })
  expect(restored.replayed).toEqual(h.history.transactions)
  expect(await h.counts()).toMatchObject({ transactions: 3, appendAudits: before.appendAudits + 1 })
})

it('records one audit event for a batch, naming the range it advanced', async () => {
  /*
   * Per transaction, this was the loudest writer in the deployment, and
   * everything it recorded is already a `transactions` row with more detail.
   * What it cost was the audit trail: `auditTrail` reads the newest events, so
   * on any project being built in, all of them were edits and none were the
   * role or visibility changes an audit is read for.
   */
  const h = await setup()
  const before = await h.counts()
  value(await h.backend.appendTransactions(h.args))

  const after = await h.counts()
  expect(after.transactions).toBe(before.transactions + 3)
  expect(after.appendAudits).toBe(before.appendAudits + 1)

  const event = await h.t.run(async (ctx) =>
    (await ctx.db.query('auditEvents').collect()).findLast((row) => row.action === 'transaction.append'),
  )
  expect(event?.detail).toMatchObject({ count: 3, toRevision: 3 })
  expect(event?.category).toBe('content')
})

it('leaves control events readable on a project full of edits', async () => {
  // The point of the split. A bounded read of the newest events used to be all
  // edits; asking for `control` now answers the question an audit is for.
  const h = await setup()
  value(await h.backend.appendTransactions(h.args))
  value(await h.backend.renameProject({ projectId: h.project.projectId, name: 'Renamed' }))

  const control = value(
    await h.backend.auditTrail({ projectId: h.project.projectId, category: 'control', limit: 50 }),
  )
  expect(control.map((row) => row.action)).toContain('project.rename')
  expect(control.map((row) => row.action)).not.toContain('transaction.append')
})

it.each(['checksum', 'schema', 'envelope', 'gap', 'duplicate', 'order'])(
  'refuses a bad %s in a later edit without committing the valid prefix',
  async (fault) => {
    const h = await setup()
    const args = structuredClone(h.args)
    const second = args.transactions[1]
    if (fault === 'checksum') second.checksum = 'bad'
    if (fault === 'schema') second.schemaVersion += 1
    if (fault === 'envelope') second.transaction.patch.baseRevision += 1
    if (fault === 'gap') args.transactions.splice(1, 1)
    if (fault === 'duplicate') args.transactions[1] = args.transactions[0]
    if (fault === 'order') args.transactions.reverse()
    if (fault === 'envelope') second.checksum = transactionChecksum(second.transaction)
    const before = await h.counts()
    expect((await h.backend.appendTransactions(args)).ok).toBe(false)
    expect(await h.counts()).toEqual(before)
    expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(0)
  },
)

it.each([0, MAX_TRANSACTION_BATCH_COUNT + 1])('rejects a batch containing %i edits without writes', async (count) => {
  const h = await setup()
  const before = await h.counts()
  expect(
    await h.backend.appendTransactions({
      ...h.args,
      transactions: Array.from({ length: count }, () => h.transactions[0]),
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  expect(await h.counts()).toEqual(before)
})

it('bounds total request bytes separately from individual transaction bytes', async () => {
  const h = await setup(5)
  const transactions = h.transactions.map((entry) => {
    const transaction = { ...entry.transaction, label: '界'.repeat(160_000) }
    return { ...entry, transaction, checksum: transactionChecksum(transaction) }
  })
  const before = await h.counts()
  expect(await h.backend.appendTransactions({ ...h.args, transactions })).toMatchObject({
    ok: false,
    error: { code: 'PAYLOAD_TOO_LARGE', details: { limit: MAX_TRANSACTION_BATCH_BYTES } },
  })
  expect(await h.counts()).toEqual(before)
})

it('rejects an oversized later edit even when the complete batch fits its wire budget', async () => {
  const h = await setup()
  const args = structuredClone(h.args)
  args.transactions[1].transaction.label = 'x'.repeat(MAX_TRANSACTION_BYTES)
  args.transactions[1].checksum = transactionChecksum(args.transactions[1].transaction)
  const before = await h.counts()
  expect(await h.backend.appendTransactions(args)).toMatchObject({
    ok: false,
    error: { code: 'PAYLOAD_TOO_LARGE', details: { batchIndex: 1, limit: MAX_TRANSACTION_BYTES } },
  })
  expect(await h.counts()).toEqual(before)
  expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(0)
})

it('accepts the full count ceiling in one transaction', async () => {
  const h = await setup(MAX_TRANSACTION_BATCH_COUNT)
  const result = value(await h.backend.appendTransactions(h.args))
  expect(result.transactions).toHaveLength(MAX_TRANSACTION_BATCH_COUNT)
  expect(result.headRevision).toBe(MAX_TRANSACTION_BATCH_COUNT)
})

it('acknowledges an exact replay without additional edits, audits, or timestamp writes', async () => {
  const h = await setup()
  const first = value(await h.backend.appendTransactions(h.args))
  const before = await h.counts()
  const project = value(await h.backend.getProject({ projectId: h.project.projectId }))
  const second = value(await h.backend.appendTransactions(h.args))
  expect(second.transactions.map((entry) => entry.transactionId)).toEqual(
    first.transactions.map((entry) => entry.transactionId),
  )
  expect(second.transactions.every((entry) => !entry.applied)).toBe(true)
  expect(second.headRevision).toBe(3)
  expect(await h.counts()).toEqual(before)
  expect(value(await h.backend.getProject({ projectId: h.project.projectId })).updatedAt).toBe(project.updatedAt)
})

it('handles a stored prefix from earlier scalar uploads without duplicating it', async () => {
  const h = await setup()
  const original = value(await h.appendOne(h.transactions[0]))
  const result = value(await h.backend.appendTransactions(h.args))
  expect(result.transactions.map((entry) => entry.applied)).toEqual([false, true, true])
  expect(result.transactions[0].transactionId).toBe(original.transactionId)
  expect(result.headRevision).toBe(3)
  expect((await h.counts()).transactions).toBe(3)
})

it('does not silently target the default branch when a scalar caller supplies an invalid empty branch', async () => {
  const h = await setup()
  const before = await h.counts()
  expect(
    (
      await h.backend.appendTransaction({
        projectId: h.project.projectId,
        branchId: '',
        ...h.transactions[0],
      })
    ).ok,
  ).toBe(false)
  expect(await h.counts()).toEqual(before)
})

it('allows an all-retry batch after the branch has advanced beyond its range', async () => {
  const h = await setup()
  value(await h.backend.appendTransactions(h.args))
  const result = value(await h.backend.appendTransactions({ ...h.args, transactions: h.transactions.slice(0, 2) }))
  expect(result.headRevision).toBe(3)
  expect(result.transactions.every((receipt) => !receipt.applied)).toBe(true)
})

it('refuses an id reused with different metadata before appending any suffix', async () => {
  const h = await setup()
  value(await h.appendOne(h.transactions[0]))
  const before = await h.counts()
  const transactions = structuredClone(h.transactions)
  transactions[0].catalogVersion = 'different'
  expect(await h.backend.appendTransactions({ ...h.args, transactions })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT', details: { batchIndex: 0 } },
  })
  expect(await h.counts()).toEqual(before)
})

it('permits exactly one of two concurrent histories at the same head', async () => {
  const h = await setup()
  const competing = h.transactions.map((entry) => {
    const transaction = { ...entry.transaction, id: `competing_${entry.clientTransactionId}` }
    return { ...entry, transaction, clientTransactionId: transaction.id, checksum: transactionChecksum(transaction) }
  })
  const results = await Promise.all([
    h.backend.appendTransactions(h.args),
    h.backend.appendTransactions({ ...h.args, transactions: competing }),
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.find((result) => !result.ok)).toMatchObject({
    error: { code: 'STALE_DOCUMENT', details: { headRevision: 3 } },
  })
  expect((await h.counts()).transactions).toBe(3)
})

it('keeps an interrupted batch stale when another writer took its required revision', async () => {
  const h = await setup()
  value(await h.appendOne(h.transactions[0]))
  const other = {
    ...h.transactions[1],
    transaction: { ...h.transactions[1].transaction, id: 'other-edit' },
    clientTransactionId: 'other-edit',
  }
  other.checksum = transactionChecksum(other.transaction)
  value(await h.appendOne(other))
  const before = await h.counts()
  expect(await h.backend.appendTransactions(h.args)).toMatchObject({
    ok: false,
    error: { code: 'STALE_DOCUMENT', details: { headRevision: 2, batchIndex: 1 } },
  })
  expect(await h.counts()).toEqual(before)
})

it.each(['stranger', 'viewer', 'anonymous', 'restricted'])('does not bypass authorisation for a %s', async (kind) => {
  const h = await setup()
  const identity = {
    subject: kind,
    tokenIdentifier: `hexclave|${kind}`,
    ...(kind === 'anonymous' ? { is_anonymous: true } : {}),
    ...(kind === 'restricted' ? { is_restricted: true } : {}),
  }
  if (kind === 'viewer')
    await h.t.run((ctx) =>
      ctx.db.insert('members', {
        projectId: h.project.projectId as Id<'projects'>,
        subject: 'hexclave|viewer',
        role: 'viewer',
        addedAt: Date.now(),
      }),
    )
  const before = await h.counts()
  const result = await h.deployment.withIdentity(identity).mutation(batchRef, h.args)
  expect(result).toMatchObject({
    ok: false,
    error: { code: kind === 'viewer' ? 'FORBIDDEN' : kind === 'stranger' ? 'NOT_FOUND' : 'UNAUTHENTICATED' },
  })
  expect(await h.counts()).toEqual(before)
})

it('scopes idempotency to the target branch and refuses cross-project branch ids', async () => {
  const h = await setup()
  const branch = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Alternative' }))
  value(await h.backend.appendTransactions(h.args))
  const fork = value(await h.backend.appendTransactions({ ...h.args, branchId: branch.branchId }))
  expect(fork.transactions.every((entry) => entry.applied)).toBe(true)
  expect((await h.counts()).transactions).toBe(6)
  const other = value(
    await h.backend.createProject({
      localProjectId: 'other',
      name: 'Other',
      schemaVersion: 2,
      catalogVersion: h.base.catalogVersion,
    }),
  )
  expect(await h.backend.appendTransactions({ ...h.args, branchId: other.defaultBranchId })).toMatchObject({
    ok: false,
    error: { code: 'NOT_FOUND' },
  })
})

it('rolls back inserts if storage fails after the first transaction write', async () => {
  const h = await setup()
  const before = await h.counts()
  await expect(
    h.t.run(async (ctx) => {
      const db = new Proxy(ctx.db, {
        get(target, key) {
          if (key === 'insert')
            return (...args: Parameters<typeof target.insert>) => {
              if (args[0] === 'auditEvents') throw new Error('Injected storage failure')
              return target.insert(...args)
            }
          return Reflect.get(target, key)
        },
      })
      return appendTransactionBatch({ ...ctx, db }, h.args)
    }),
  ).rejects.toThrow('Injected storage failure')
  expect(await h.counts()).toEqual(before)
  expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(0)
})

it('retains both human and agent authorship through replay', async () => {
  const h = await setup(0)
  const engine = new CadEngine(h.base)
  engine.setAutonomy('build')
  const transactions = (['human', 'agent'] as const).map((author, index) => {
    const transaction = value(
      engine.execute(`Name by ${author}`, [{ type: 'document.rename', name: author }], author, index),
    )
    return {
      transaction,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      checksum: transactionChecksum(transaction),
      schemaVersion: h.base.schemaVersion,
      catalogVersion: h.base.catalogVersion,
    }
  })
  value(await h.backend.appendTransactions({ ...h.args, transactions }))
  const loaded = value(await new CloudProjectStore(h.backend).loadProject(h.project.projectId))!
  expect(loaded.replayed).toEqual(transactions.map((entry) => entry.transaction))
  expect(loaded.replayed.map((entry) => entry.author)).toEqual(['human', 'agent'])
})

function localStack(h: Awaited<ReturnType<typeof setup>>) {
  const driver = new MemoryDriver()
  const local = new LocalProjectStore(driver)
  const cloud = new CloudProjectStore(h.backend)
  const outbox = new Outbox(driver, h.backend)
  const store = new MirroredProjectStore(local, cloud, outbox, h.backend)
  return { driver, local, cloud, outbox, store }
}

async function queueHistory(h: Awaited<ReturnType<typeof setup>>, outbox: Outbox) {
  for (const [index, txn] of h.history.transactions.entries())
    value(await outbox.queueTransaction(h.project.projectId, h.history.documents[index], txn))
}

describe('batched claim and outbox through real Convex functions', () => {
  it('claims 120 edits with three append RPCs, preserving every revision and payload', async () => {
    const h = await setup(120)
    const { local, store, cloud } = localStack(h)
    value(await local.saveCheckpoint(h.base))
    for (const transaction of h.history.transactions) value(await local.appendTransaction(h.base.id, transaction))
    const batches = vi.spyOn(h.backend, 'appendTransactions')
    const singles = vi.spyOn(h.backend, 'appendTransaction')
    const claimed = value(await store.claim(h.base.id))
    expect(claimed).toMatchObject({ headRevision: 120, transactionsUploaded: 120 })
    expect(batches.mock.calls.map(([args]) => args.transactions.length)).toEqual([50, 50, 20])
    expect(singles).not.toHaveBeenCalled()
    const loaded = value(await cloud.loadProject(claimed.projectId))!
    expect(loaded.replayed).toEqual(h.history.transactions)
    expect(loaded.document).toEqual(value(await local.loadProject(h.base.id))!.document)
    expect(await store.links.get(h.base.id)).toMatchObject({ cloudProjectId: claimed.projectId })
  })

  it.each(['before', 'after'])(
    'resumes a claim interrupted %s the second batch commit without duplicating edits',
    async (when) => {
      const h = await setup(120)
      const { local, store } = localStack(h)
      value(await local.saveCheckpoint(h.base))
      for (const transaction of h.history.transactions) value(await local.appendTransaction(h.base.id, transaction))
      const send = h.backend.appendTransactions.bind(h.backend)
      let calls = 0
      vi.spyOn(h.backend, 'appendTransactions').mockImplementation(async (args) => {
        if (++calls === 2) {
          if (when === 'after') value(await send(args))
          return cloudFailure('TRANSPORT_FAILED', 'Interrupted batch delivery', 'Retry')
        }
        return send(args)
      })
      expect(await store.claim(h.base.id)).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
      expect(await store.links.get(h.base.id)).toBeUndefined()
      expect((await h.counts()).transactions).toBe(when === 'before' ? 50 : 100)
      const retried = value(await store.claim(h.base.id))
      expect(retried.transactionsUploaded).toBe(when === 'before' ? 70 : 20)
      expect(retried.headRevision).toBe(120)
      expect(await h.counts()).toMatchObject({ transactions: 120 })
      expect(value(await local.loadProject(h.base.id))?.document).toEqual({
        ...h.history.final,
        updatedAt: h.history.transactions.at(-1)!.timestamp,
      })
    },
  )

  it('drains 120 queued edits in three mutation calls without collapsing their history', async () => {
    const h = await setup(120)
    const { outbox, driver } = localStack(h)
    await queueHistory(h, outbox)
    const batches = vi.spyOn(h.backend, 'appendTransactions')
    const singles = vi.spyOn(h.backend, 'appendTransaction')
    const [first, second] = await Promise.all([outbox.drain(), outbox.drain()])
    expect(first.status).toBe('idle')
    expect(second.pending).toBe(0)
    expect(batches.mock.calls.map(([args]) => args.transactions.length)).toEqual([50, 50, 20])
    expect(singles).not.toHaveBeenCalled()
    expect(await driver.range('meta', 'outbox:')).toEqual([])
    expect((await h.counts()).transactions).toBe(120)
  })

  it('keeps every queued edit after an ambiguous acknowledgement, then safely retries', async () => {
    const h = await setup(65)
    const { outbox, driver } = localStack(h)
    await queueHistory(h, outbox)
    const send = h.backend.appendTransactions.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      value(await send(args))
      return cloudFailure('TRANSPORT_FAILED', 'Lost acknowledgement', 'Retry')
    })
    expect(await outbox.drain()).toMatchObject({ status: 'offline', pending: 65 })
    expect(await driver.range('meta', 'outbox:')).toHaveLength(65)
    expect((await h.counts()).transactions).toBe(50)
    expect(await outbox.reconnected()).toMatchObject({ status: 'idle', pending: 0 })
    expect(await h.counts()).toMatchObject({ transactions: 65 })
  })

  it('refuses a partial success receipt and keeps the outbox retryable', async () => {
    const h = await setup()
    const { outbox } = localStack(h)
    await queueHistory(h, outbox)
    const send = h.backend.appendTransactions.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      const result = value(await send(args))
      return { ok: true, value: { ...result, transactions: result.transactions.slice(0, 2) } }
    })
    expect(await outbox.drain()).toMatchObject({ status: 'offline', pending: 3 })
    expect(await outbox.reconnected()).toMatchObject({ status: 'idle', pending: 0 })
    expect(await h.counts()).toMatchObject({ transactions: 3 })
  })

  it('recovers after local acknowledgement persistence fails partway through a committed batch', async () => {
    const h = await setup(10)
    const { outbox, driver } = localStack(h)
    await queueHistory(h, outbox)
    const remove = driver.delete.bind(driver)
    let deletions = 0
    const fault = vi.spyOn(driver, 'delete').mockImplementation(async (store, key) => {
      if (store === 'meta' && ++deletions === 3) throw new Error('Local storage unavailable')
      return remove(store, key)
    })
    expect(await outbox.drain()).toMatchObject({ status: 'error', pending: 8 })
    expect((await h.counts()).transactions).toBe(10)
    fault.mockRestore()
    const restarted = new Outbox(driver, h.backend)
    expect(await restarted.reconnected()).toMatchObject({ status: 'idle', pending: 0 })
    expect(await h.counts()).toMatchObject({ transactions: 10 })
  })

  it('does not combine transactions across a checkpoint', async () => {
    const h = await setup(4)
    const { outbox } = localStack(h)
    for (const [index, transaction] of h.history.transactions.entries()) {
      value(await outbox.queueTransaction(h.project.projectId, h.history.documents[index], transaction))
      if (index === 1) value(await outbox.queueCheckpoint(h.project.projectId, h.history.documents[index]))
    }
    const batches = vi.spyOn(h.backend, 'appendTransactions')
    const checkpoints = vi.spyOn(h.backend, 'saveCheckpoint')
    expect(await outbox.drain()).toMatchObject({ status: 'idle', pending: 0 })
    expect(batches.mock.calls.map(([args]) => args.transactions.map((entry) => entry.resultRevision))).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(checkpoints).toHaveBeenCalledOnce()
    expect(checkpoints.mock.calls[0][0].snapshot.revision).toBe(2)
  })

  it('isolates a malformed later edit without parking or discarding a valid queue head', async () => {
    const h = await setup()
    const { outbox } = localStack(h)
    h.history.transactions[1].patch.forward = [{ kind: 'unsupported' } as never]
    await queueHistory(h, outbox)
    expect(await outbox.drain()).toMatchObject({ status: 'error', pending: 2, lastError: { code: 'INVALID_ARGUMENT' } })
    expect(outbox.pending[0].payload).toMatchObject({ transaction: { resultRevision: 2 } })
    expect(outbox.pending[0].parked).toBe(true)
    expect((await h.counts()).transactions).toBe(1)
    expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(1)
  })
})

it('does not trust a matching cached checksum when the stored payload differs', async () => {
  const h = await setup()
  const first = value(await h.appendOne(h.transactions[0]))
  await h.t.run(async (ctx) => {
    const row = (await ctx.db.get(first.transactionId as Id<'transactions'>))!
    await ctx.db.patch(row._id, { payload: { ...row.payload, label: 'Different content with the old digest' } })
  })
  const before = await h.counts()
  expect(await h.backend.appendTransactions(h.args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  expect(await h.counts()).toEqual(before)
})

it('keeps project boundaries while batching a shared offline queue', async () => {
  const h = await setup(4)
  const { outbox } = localStack(h)
  const otherBase = blankProject('other-queued-project')
  const other = value(
    await h.backend.createProject({
      localProjectId: otherBase.id,
      name: otherBase.name,
      schemaVersion: otherBase.schemaVersion,
      catalogVersion: otherBase.catalogVersion,
      snapshot: snapshotUploadFor(otherBase),
    }),
  )
  const otherHistory = placements(otherBase, ['other-a', 'other-b'])
  for (let i = 0; i < 2; i++)
    value(await outbox.queueTransaction(h.project.projectId, h.history.documents[i], h.history.transactions[i]))
  for (let i = 0; i < 2; i++)
    value(await outbox.queueTransaction(other.projectId, otherHistory.documents[i], otherHistory.transactions[i]))
  for (let i = 2; i < 4; i++)
    value(await outbox.queueTransaction(h.project.projectId, h.history.documents[i], h.history.transactions[i]))
  const batches = vi.spyOn(h.backend, 'appendTransactions')
  expect(await outbox.drain()).toMatchObject({ status: 'idle', pending: 0 })
  expect(
    batches.mock.calls.map(([args]) => [args.projectId, args.transactions.map((entry) => entry.resultRevision)]),
  ).toEqual([
    [h.project.projectId, [1, 2]],
    [other.projectId, [1, 2]],
    [h.project.projectId, [3, 4]],
  ])
})

it('halts a batch at a corrupted queued checksum instead of sending or discarding the bad edit', async () => {
  const h = await setup()
  const { outbox } = localStack(h)
  await queueHistory(h, outbox)
  const entry = outbox.pending[1]
  if (entry.payload.kind === 'transaction') entry.payload.transaction.label = 'Changed after queueing'
  expect(await outbox.drain()).toMatchObject({ status: 'error', pending: 2, lastError: { code: 'CHECKSUM_MISMATCH' } })
  expect((await h.counts()).transactions).toBe(1)
  expect(outbox.pending[0].key).toBe(entry.key)
})

it.each(['catalogue', 'local history', 'schema', 'backoff', 'parked'])(
  'does not combine an otherwise contiguous tail across a %s boundary',
  async (boundary) => {
    const h = await setup()
    const { outbox } = localStack(h)
    await queueHistory(h, outbox)
    for (const entry of outbox.pending.slice(1)) {
      if (boundary === 'catalogue') entry.catalogVersion = 'new-catalogue'
      if (boundary === 'local history') entry.localProjectId = 'other-local-history'
      if (boundary === 'schema') entry.schemaVersion += 1
      if (boundary === 'backoff') entry.nextAttemptAt = Date.now() + 60_000
      if (boundary === 'parked') entry.parked = true
    }
    const batches = vi.spyOn(h.backend, 'appendTransactions')
    const singles = vi.spyOn(h.backend, 'appendTransaction')
    const state = await outbox.drain()
    expect(singles.mock.calls[0][0].resultRevision).toBe(1)
    expect(batches.mock.calls.every(([args]) => args.transactions[0].resultRevision === 2)).toBe(true)
    const canContinue = boundary === 'catalogue' || boundary === 'local history'
    expect(state.pending).toBe(canContinue ? 0 : 2)
    expect((await h.counts()).transactions).toBe(canContinue ? 3 : 1)
    if (boundary === 'backoff' || boundary === 'parked') expect(batches).not.toHaveBeenCalled()
    if (boundary === 'schema') expect(state.lastError?.code).toBe('SCHEMA_MISMATCH')
  },
)

it('preserves a revision gap instead of batching around the missing edit', async () => {
  const h = await setup()
  const { outbox } = localStack(h)
  for (const index of [0, 2])
    value(await outbox.queueTransaction(h.project.projectId, h.history.documents[index], h.history.transactions[index]))
  const batches = vi.spyOn(h.backend, 'appendTransactions')
  expect(await outbox.drain()).toMatchObject({ status: 'conflict', pending: 1, conflict: { headRevision: 1 } })
  expect(batches).not.toHaveBeenCalled()
  expect((await h.counts()).transactions).toBe(1)
  expect(outbox.pending[0].payload).toMatchObject({ transaction: { resultRevision: 3 } })
})
