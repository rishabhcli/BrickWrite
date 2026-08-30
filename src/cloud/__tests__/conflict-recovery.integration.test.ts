// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import schema from '../../../convex/schema'
import { ConvexCloudBackend } from '../convexClient'
import { CloudProjectStore, LocalProjectStore, MirroredProjectStore } from '../projectStore'
import { MemoryDriver } from '../../cad/persistence'
import { Outbox } from '../outbox'
import { executeConflictFork, planRebase } from '../rebase'
import { cloudFailure, type CloudResult, type CreateBranchArgs } from '../protocol'
import { snapshotUploadFor, transactionChecksum } from '../serialize'
import { blankProject, commitAll, part } from './harness'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
const lost = () => cloudFailure('TRANSPORT_FAILED', 'Response was lost.', 'Retry.')

async function setup(count = 2) {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = commitAll(blankProject('conflict-recovery'), [[{ type: 'part.add', part: part('p1') }]]).final
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const local = commitAll(
    base,
    Array.from({ length: count }, (_, i) => [{ type: 'part.recolor' as const, partId: 'p1', color: i % 2 ? 4 : 14 }]),
  )
  const remote = commitAll(base, [[{ type: 'part.recolor', partId: 'p1', color: 1 }]])
  value(
    await backend.appendTransaction({
      projectId: project.projectId,
      transaction: remote.transactions[0],
      clientTransactionId: remote.transactions[0].id,
      baseRevision: base.revision,
      resultRevision: base.revision + 1,
      checksum: transactionChecksum(remote.transactions[0]),
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
    }),
  )
  const plan = () => {
    const planned = planRebase({ base, localTail: local.transactions, remoteTail: remote.transactions })
    if (planned.kind !== 'conflict-fork') throw new Error('Expected a conflict')
    return planned
  }
  const counts = () =>
    t.run(async (ctx) => ({
      branches: (await ctx.db.query('branches').collect()).length,
      snapshots: (await ctx.db.query('snapshots').collect()).length,
      transactions: (await ctx.db.query('transactions').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
    }))
  const run = () => executeConflictFork(backend, { projectId: project.projectId, plan: plan() })
  return { deployment, t, backend, base, project, local, remote, plan, counts, run }
}

describe('resumable conflict recovery (real Convex functions)', () => {
  it('reuses the atomically seeded branch after losing its creation response', async () => {
    const h = await setup()
    const create = h.backend.createBranch.bind(h.backend)
    vi.spyOn(h.backend, 'createBranch').mockImplementationOnce(async (args) => {
      value(await create(args))
      return lost()
    })
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    const branches = value(await h.backend.listBranches({ projectId: h.project.projectId }))
    const partial = branches.find((branch) => branch.kind === 'conflict')!
    expect(
      value(await h.backend.latestCheckpoint({ projectId: h.project.projectId, branchId: partial.branchId }))?.document,
    ).toEqual(h.base)
    const recovered = value(await h.run())
    expect(recovered.branchId).toBe(partial.branchId)
    expect((await h.counts()).branches).toBe(2)
    const loaded = value(
      await new CloudProjectStore(h.backend).loadProject(h.project.projectId, { branchId: recovered.branchId }),
    )!
    expect(loaded.document.parts).toEqual(h.local.final.parts)
  })

  it('resumes a committed prefix after a lost append response without duplicate branches or edits', async () => {
    const h = await setup(52)
    const append = h.backend.appendTransactions.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      value(await append(args))
      return lost()
    })
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    const recovered = value(await h.run())
    expect(recovered.preserved).toEqual(h.local.transactions)
    expect((await h.counts()).branches).toBe(2)
    expect((await h.counts()).transactions).toBe(53)
    const before = await h.counts()
    expect(value(await h.run()).branchId).toBe(recovered.branchId)
    expect(await h.counts()).toEqual(before)
  })
})

function request(h: Awaited<ReturnType<typeof setup>>): CreateBranchArgs {
  return {
    projectId: h.project.projectId,
    name: 'Recovery',
    kind: 'conflict',
    fromBranchId: h.project.defaultBranchId,
    atRevision: h.base.revision,
    recovery: { key: 'recovery_key_12345678', snapshot: snapshotUploadFor(h.base) },
  }
}

async function mirror(h: Awaited<ReturnType<typeof setup>>, driver = new MemoryDriver()) {
  const local = new LocalProjectStore(driver)
  const outbox = new Outbox(driver, h.backend)
  const store = new MirroredProjectStore(local, new CloudProjectStore(h.backend), outbox, h.backend)
  await outbox.hydrate()
  return { local, outbox, store, driver }
}

async function seedMirror(h: Awaited<ReturnType<typeof setup>>) {
  const m = await mirror(h)
  value(await m.local.saveCheckpoint(h.base))
  await m.store.links.put({
    localProjectId: h.base.id,
    cloudProjectId: h.project.projectId,
    branchId: h.project.defaultBranchId,
    claimedAt: new Date().toISOString(),
    syncedRevision: h.base.revision,
  })
  for (const tx of h.local.transactions) value(await m.store.appendTransaction(h.base.id, tx))
  return m
}

describe('atomic recovery seeds and authorization', () => {
  it('returns the original branch and seed without changing head, rows or audit on retry', async () => {
    const h = await setup()
    const args = request(h)
    const branch = value(await h.backend.createBranch(args))
    const tx = h.local.transactions[0]
    value(
      await h.backend.appendTransaction({
        projectId: h.project.projectId,
        branchId: branch.branchId,
        clientTransactionId: tx.id,
        baseRevision: tx.baseRevision,
        resultRevision: tx.resultRevision,
        transaction: tx,
        checksum: transactionChecksum(tx),
        schemaVersion: h.base.schemaVersion,
        catalogVersion: h.base.catalogVersion,
      }),
    )
    value(
      await h.backend.saveCheckpoint({
        projectId: h.project.projectId,
        branchId: branch.branchId,
        snapshot: snapshotUploadFor(h.local.documents[0]),
      }),
    )
    const before = await h.counts()
    expect(value(await h.backend.createBranch(args))).toMatchObject({
      branchId: branch.branchId,
      headRevision: tx.resultRevision,
    })
    expect(await h.counts()).toEqual(before)
    expect(
      value(await h.backend.latestCheckpoint({ projectId: h.project.projectId, branchId: branch.branchId }))?.revision,
    ).toBe(tx.resultRevision)
  })

  it.each(['checksum', 'document', 'revision', 'key', 'kind'] as const)(
    'refuses invalid %s before writing anything',
    async (change) => {
      const h = await setup()
      const args = request(h)
      if (change === 'checksum') args.recovery!.snapshot.checksum = 'broken'
      if (change === 'document') args.recovery!.snapshot = snapshotUploadFor({ ...h.base, id: 'wrong-model' })
      if (change === 'revision') args.atRevision! += 1
      if (change === 'key') args.recovery!.key = 'short'
      if (change === 'kind') args.kind = 'named'
      const before = await h.counts()
      expect((await h.backend.createBranch(args)).ok).toBe(false)
      expect(await h.counts()).toEqual(before)
    },
  )

  it.each(['seed', 'name', 'parent', 'revision'] as const)(
    'refuses a retry with changed %s without altering the fork',
    async (change) => {
      const h = await setup()
      const args = request(h)
      value(await h.backend.createBranch(args))
      if (change === 'seed') args.recovery!.snapshot = snapshotUploadFor({ ...h.base, name: 'Changed' })
      if (change === 'name') args.name = 'Changed'
      if (change === 'parent')
        args.fromBranchId = value(
          await h.backend.createBranch({ projectId: h.project.projectId, name: 'Other' }),
        ).branchId
      if (change === 'revision') {
        args.atRevision! += 1
        args.recovery!.snapshot = snapshotUploadFor(h.remote.final)
      }
      const before = await h.counts()
      expect(await h.backend.createBranch(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
      expect(await h.counts()).toEqual(before)
    },
  )

  it('does not hijack a same-name legacy branch that has no recovery receipt', async () => {
    const h = await setup()
    const args = request(h)
    value(await h.backend.createBranch({ ...args, recovery: undefined }))
    const before = await h.counts()
    expect(await h.backend.createBranch(args)).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } })
    expect(await h.counts()).toEqual(before)
  })

  it('does not hide corruption in the immutable seed behind a later checkpoint', async () => {
    const h = await setup()
    const args = request(h)
    const branch = value(await h.backend.createBranch(args))
    value(
      await h.backend.saveCheckpoint({
        projectId: h.project.projectId,
        branchId: branch.branchId,
        snapshot: snapshotUploadFor(h.base),
      }),
    )
    await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query('branches')
        .withIndex('by_project_name', (q) => q.eq('projectId', h.project.projectId as never).eq('name', args.name))
        .unique()
      const chunks = await ctx.db
        .query('snapshots')
        .withIndex('by_group', (q) => q.eq('groupId', row!.recoverySnapshotGroupId!))
        .collect()
      await ctx.db.delete(chunks[0]._id)
    })
    const before = await h.counts()
    expect((await h.backend.createBranch(args)).ok).toBe(false)
    expect(await h.counts()).toEqual(before)
  })

  it.each(['anonymous', 'outsider', 'viewer'] as const)('does not expose recovery receipts to %s', async (role) => {
    const h = await setup()
    const args = request(h)
    value(await h.backend.createBranch(args))
    if (role === 'viewer')
      await h.t.run(async (ctx) => {
        await ctx.db.insert('members', {
          projectId: h.project.projectId as never,
          subject: 'hexclave|bob',
          role: 'viewer',
          addedAt: Date.now(),
        })
      })
    const client =
      role === 'anonymous'
        ? h.deployment
        : h.deployment.withIdentity({ subject: 'bob', tokenIdentifier: 'hexclave|bob' })
    const backend = new ConvexCloudBackend(client as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
    const before = await h.counts()
    expect(await backend.createBranch(args)).toMatchObject({
      ok: false,
      error: { code: role === 'anonymous' ? 'UNAUTHENTICATED' : role === 'viewer' ? 'FORBIDDEN' : 'NOT_FOUND' },
    })
    expect(await h.counts()).toEqual(before)
  })

  it('scopes recovery receipts to the requesting member as well as the project', async () => {
    const h = await setup()
    const args = request(h)
    const alice = value(await h.backend.createBranch(args))
    await h.t.run(async (ctx) => {
      await ctx.db.insert('members', {
        projectId: h.project.projectId as never,
        subject: 'hexclave|bob',
        role: 'editor',
        addedAt: Date.now(),
      })
    })
    const client = h.deployment.withIdentity({ subject: 'bob', tokenIdentifier: 'hexclave|bob' })
    const backend = new ConvexCloudBackend(client as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
    expect(await backend.createBranch(args)).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } })
    const bob = value(await backend.createBranch({ ...args, name: 'Bob recovery' }))
    expect(bob.branchId).not.toBe(alice.branchId)
    expect(bob.createdBySubject).toBe('hexclave|bob')
  })
})

describe('client recovery durability', () => {
  it('retains local history and outbox after a lost reply, then resumes after reconstructing the client', async () => {
    const h = await setup(52)
    const m = await seedMirror(h)
    const localBefore = await m.local.readLog(h.base.id)
    const queueBefore = structuredClone(m.outbox.pending)
    const append = h.backend.appendTransactions.bind(h.backend)
    const spy = vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      value(await append(args))
      return lost()
    })
    expect(await m.store.resolveDivergence(h.base.id)).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    expect(await m.local.readLog(h.base.id)).toEqual(localBefore)
    expect(m.outbox.pending).toEqual(queueBefore)
    spy.mockRestore()
    const fresh = await mirror(h, m.driver)
    const recovered = value(await fresh.store.resolveDivergence(h.base.id))
    expect(recovered.kind).toBe('conflict-fork')
    expect(recovered.fork?.preserved).toEqual(h.local.transactions)
    expect((await h.counts()).branches).toBe(2)
    expect(fresh.outbox.pending).toHaveLength(0)
    expect(value(await fresh.local.loadProject(h.base.id))?.document.parts).toEqual(h.remote.final.parts)
    expect(
      value(
        await new CloudProjectStore(h.backend).loadProject(h.project.projectId, { branchId: recovered.fork!.branchId }),
      )?.document.parts,
    ).toEqual(h.local.final.parts)
  })

  it('retains local work when a successful envelope omits an edit receipt', async () => {
    const h = await setup()
    const m = await seedMirror(h)
    const before = await m.local.readLog(h.base.id)
    const queued = structuredClone(m.outbox.pending)
    const append = h.backend.appendTransactions.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      const receipt = value(await append(args))
      return { ok: true, value: { ...receipt, transactions: receipt.transactions.slice(1) } }
    })
    expect(await m.store.resolveDivergence(h.base.id)).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    expect(await m.local.readLog(h.base.id)).toEqual(before)
    expect(m.outbox.pending).toEqual(queued)
  })

  it('resumes scalar uploads for a host without batching', async () => {
    const h = await setup()
    h.backend.appendTransactions = undefined as never
    const append = h.backend.appendTransaction.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransaction').mockImplementationOnce(async (args) => {
      value(await append(args))
      return lost()
    })
    expect((await h.run()).ok).toBe(false)
    value(await h.run())
    expect((await h.counts()).branches).toBe(2)
    expect((await h.counts()).transactions).toBe(3)
  })

  it.each(['gap', 'duplicate', 'malformed'] as const)('refuses a local %s before creating a branch', async (kind) => {
    const h = await setup()
    if (kind === 'gap') h.local.transactions.splice(0, 1)
    if (kind === 'duplicate') h.local.transactions[1].id = h.local.transactions[0].id
    if (kind === 'malformed') h.local.transactions[1].patch.inverse = []
    const before = await h.counts()
    expect((await h.run()).ok).toBe(false)
    expect(await h.counts()).toEqual(before)
  })

  it('refuses a wrong branch acknowledgement before sending any edits', async () => {
    const h = await setup()
    const create = h.backend.createBranch.bind(h.backend)
    vi.spyOn(h.backend, 'createBranch').mockImplementationOnce(async (args) => ({
      ok: true,
      value: { ...value(await create(args)), baseRevision: 999 },
    }))
    expect(await h.run()).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    expect((await h.counts()).transactions).toBe(1)
  })
})

describe('lossless ancestry and identity reconciliation', () => {
  it('advances the fork base past a landed prefix and preserves every unlanded edit unchanged', async () => {
    const h = await setup()
    const ownTail = commitAll(h.remote.final, [[{ type: 'part.recolor', partId: 'p1', color: 14 }]])
    const otherTail = commitAll(h.remote.final, [[{ type: 'part.recolor', partId: 'p1', color: 4 }]])
    h.local.transactions = [...h.remote.transactions, ...ownTail.transactions]
    const tx = otherTail.transactions[0]
    value(
      await h.backend.appendTransaction({
        projectId: h.project.projectId,
        transaction: tx,
        clientTransactionId: tx.id,
        baseRevision: tx.baseRevision,
        resultRevision: tx.resultRevision,
        checksum: transactionChecksum(tx),
        schemaVersion: h.base.schemaVersion,
        catalogVersion: h.base.catalogVersion,
      }),
    )
    const m = await seedMirror(h)
    const recovered = value(await m.store.resolveDivergence(h.base.id))
    expect(recovered.fork?.forkRevision).toBe(h.remote.final.revision)
    expect(recovered.fork?.preserved).toEqual(ownTail.transactions)
    const fork = value(
      await new CloudProjectStore(h.backend).loadProject(h.project.projectId, { branchId: recovered.fork!.branchId }),
    )!
    expect(fork.document.parts).toEqual(ownTail.final.parts)
    expect(fork.document.revision).toBe(ownTail.final.revision)
    expect(value(await m.local.loadProject(h.base.id))?.document.parts).toEqual(otherTail.final.parts)
    expect((await h.counts()).transactions).toBe(3)
  })

  it('preserves different local content that reuses a cloud transaction id', async () => {
    const h = await setup(1)
    h.local.transactions[0].id = h.remote.transactions[0].id
    const m = await seedMirror(h)
    const recovered = value(await m.store.resolveDivergence(h.base.id))
    expect(recovered.kind).toBe('conflict-fork')
    const fork = value(
      await new CloudProjectStore(h.backend).loadProject(h.project.projectId, { branchId: recovered.fork!.branchId }),
    )!
    expect(fork.document.parts).toEqual(h.local.final.parts)
    expect((await h.counts()).transactions).toBe(2)
  })

  it('forks the actual named source branch rather than silently attaching recovery to main', async () => {
    const h = await setup()
    const source = value(
      await h.backend.createBranch({ projectId: h.project.projectId, name: 'Variant', atRevision: h.base.revision }),
    )
    const tx = h.remote.transactions[0]
    value(
      await h.backend.appendTransaction({
        projectId: h.project.projectId,
        branchId: source.branchId,
        transaction: tx,
        clientTransactionId: tx.id,
        baseRevision: tx.baseRevision,
        resultRevision: tx.resultRevision,
        checksum: transactionChecksum(tx),
        schemaVersion: h.base.schemaVersion,
        catalogVersion: h.base.catalogVersion,
      }),
    )
    const m = await seedMirror(h)
    const link = (await m.store.links.get(h.base.id))!
    await m.store.links.put({ ...link, branchId: source.branchId })
    const recovered = value(await m.store.resolveDivergence(h.base.id))
    const branch = value(await h.backend.listBranches({ projectId: h.project.projectId })).find(
      (b) => b.branchId === recovered.fork!.branchId,
    )!
    expect(branch.forkedFromBranchId).toBe(source.branchId)
    expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(
      h.remote.final.revision,
    )
  })

  it('rejects discontinuous local history without clearing the queue or changing history', async () => {
    const h = await setup()
    const m = await seedMirror(h)
    const log = await m.local.readLog(h.base.id)
    await m.driver.delete('transactions', log[0].key)
    const before = await m.local.readLog(h.base.id)
    const queued = structuredClone(m.outbox.pending)
    expect(await m.store.resolveDivergence(h.base.id)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
    expect(await m.local.readLog(h.base.id)).toEqual(before)
    expect(m.outbox.pending).toEqual(queued)
    expect((await h.counts()).branches).toBe(1)
  })

  it('uses the same recovery identity when only the plan timestamp and remote head change', async () => {
    const h = await setup()
    const first = value(await h.run())
    const extra = commitAll(h.remote.final, [[{ type: 'part.recolor', partId: 'p1', color: 4 }]])
    const planned = planRebase({
      base: h.base,
      localTail: h.local.transactions,
      remoteTail: [...h.remote.transactions, ...extra.transactions],
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    if (planned.kind !== 'conflict-fork') throw new Error('Expected conflict')
    const before = await h.counts()
    const second = value(await executeConflictFork(h.backend, { projectId: h.project.projectId, plan: planned }))
    expect(second.branchId).toBe(first.branchId)
    expect(await h.counts()).toEqual(before)
  })

  it('keeps distinct conflicting tails in distinct forks even when their timestamps match', async () => {
    const h = await setup()
    const first = value(await h.run())
    h.local.transactions[0].label = 'Different local intent'
    const second = value(await h.run())
    expect(second.branchId).not.toBe(first.branchId)
    expect((await h.counts()).branches).toBe(3)
  })
})

it.each(['human', 'agent'] as const)(
  'does not erase a new %s edit made while the conflict upload is in flight',
  async (author) => {
    const h = await setup()
    const m = await seedMirror(h)
    const more = commitAll(h.local.final, [[{ type: 'part.recolor', partId: 'p1', color: 1 }]])
    more.transactions[0].author = author
    const append = h.backend.appendTransactions.bind(h.backend)
    vi.spyOn(h.backend, 'appendTransactions').mockImplementationOnce(async (args) => {
      // This local edit must not wait for the network operation to finish.
      value(await m.store.appendTransaction(h.base.id, more.transactions[0]))
      return append(args)
    })
    expect(await m.store.resolveDivergence(h.base.id)).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
    expect(value(await m.local.loadProject(h.base.id))?.document.parts).toEqual(more.final.parts)
    expect(m.outbox.pending).toHaveLength(h.local.transactions.length + 1)
    expect((await m.local.readLog(h.base.id)).at(-1)?.transaction).toEqual(more.transactions[0])
  },
)

it('serializes two simultaneous recoveries so both cannot rewrite the same local history', async () => {
  const h = await setup()
  const m = await seedMirror(h)
  const replace = vi.spyOn(m.local, 'replaceHistory')
  const outcomes = await Promise.all([m.store.resolveDivergence(h.base.id), m.store.resolveDivergence(h.base.id)])
  expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
  expect(outcomes.filter((r) => !r.ok)[0]).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
  expect(replace).toHaveBeenCalledTimes(1)
  expect((await h.counts()).branches).toBe(2)
  expect(m.outbox.pending).toHaveLength(0)
})

it('preflights the size of the entire local tail before creating a recovery branch', async () => {
  const h = await setup()
  Object.assign(h.local.transactions[1], { extension: 'x'.repeat(512 * 1024) })
  const before = await h.counts()
  expect(await h.run()).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } })
  expect(await h.counts()).toEqual(before)
})

it('allows a human-readable recovery name and reuses it after trimming whitespace', async () => {
  const h = await setup()
  const first = value(
    await executeConflictFork(h.backend, {
      projectId: h.project.projectId,
      plan: h.plan(),
      branchName: '  My recovered work  ',
    }),
  )
  const second = value(
    await executeConflictFork(h.backend, {
      projectId: h.project.projectId,
      plan: h.plan(),
      branchName: 'My recovered work',
    }),
  )
  expect(first.branchName).toBe('My recovered work')
  expect(second.branchId).toBe(first.branchId)
})

it('treats a reused transaction id as a conflict even for otherwise disjoint edits', async () => {
  const h = await setup(1)
  const remote = commitAll(h.base, [[{ type: 'document.rename', name: 'Remote name' }]])
  h.local.transactions[0].id = remote.transactions[0].id
  const plan = planRebase({ base: h.base, localTail: h.local.transactions, remoteTail: remote.transactions })
  expect(plan.kind).toBe('conflict-fork')
  if (plan.kind === 'conflict-fork') expect(plan.localTail).toEqual(h.local.transactions)
})

it('rolls back the branch and seed chunks if storage fails after writing the checkpoint', async () => {
  const h = await setup()
  const snapshots = await import('../../../convex/model/snapshots')
  const write = snapshots.writeSnapshot
  const failure = vi.spyOn(snapshots, 'writeSnapshot').mockImplementationOnce(async (ctx, args) => {
    value(await write(ctx, args))
    throw new Error('Injected failure after checkpoint insertion')
  })
  const before = await h.counts()
  try {
    expect(await h.backend.createBranch(request(h))).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    expect(await h.counts()).toEqual(before)
  } finally {
    failure.mockRestore()
  }
  expect((await h.backend.createBranch(request(h))).ok).toBe(true)
})
