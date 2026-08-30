// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from '../../../convex/schema'
import { refs } from '../functionRefs'
import { ConvexCloudBackend } from '../convexClient'
import { CloudProjectStore } from '../projectStore'
import { snapshotUploadFor, transactionChecksum } from '../serialize'
import type { CloudResult } from '../protocol'
import { canonicalJson, utf8Bytes } from '../serialize'
import { MAX_HISTORY_PAGE_BYTES } from '../../../convex/model/history'
import type { Transaction } from '../../cad/types'
import { blankProject, commitAll, placements } from './harness'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

async function setup() {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const store = new CloudProjectStore(backend)
  const base = blankProject('history-test')
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const append = async (history: ReturnType<typeof placements>, branchId = project.defaultBranchId) => {
    for (const transaction of history.transactions) {
      value(
        await backend.appendTransaction({
          projectId: project.projectId,
          branchId,
          clientTransactionId: transaction.id,
          baseRevision: transaction.baseRevision,
          resultRevision: transaction.resultRevision,
          checksum: transactionChecksum(transaction),
          transaction,
          schemaVersion: base.schemaVersion,
          catalogVersion: base.catalogVersion,
        }),
      )
    }
  }
  return { deployment, t, backend, store, base, project, append }
}

describe('deployed cloud history functions (Convex test runtime)', () => {
  it('opens a named branch with every edit since its parent checkpoint', async () => {
    const h = await setup()
    const history = placements(h.base, ['first', 'second'])
    await h.append(history)
    const branch = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Variant' }))
    const loaded = value(await h.store.loadProject(h.project.projectId, { branchId: branch.branchId }))
    expect(loaded?.document).toEqual({ ...history.final, updatedAt: history.transactions.at(-1)!.timestamp })
    expect(loaded?.replayed).toHaveLength(2)
  })

  it('opens main rather than a newer checkpoint from a different branch', async () => {
    const h = await setup()
    const branch = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Variant' }))
    const variant = placements(h.base, ['variant-only'])
    await h.append(variant, branch.branchId)
    value(
      await h.backend.saveCheckpoint({
        projectId: h.project.projectId,
        branchId: branch.branchId,
        snapshot: snapshotUploadFor(variant.final),
      }),
    )
    expect(value(await h.store.loadProject(h.project.projectId))?.document).toEqual(h.base)
  })

  it('loads a history longer than the old 500-record page without truncating it', async () => {
    const h = await setup()
    const history = commitAll(
      h.base,
      Array.from({ length: 503 }, (_, i) => [{ type: 'document.rename', name: `Build ${i}` }]),
    )
    await h.append(history)
    const loaded = value(await h.store.loadProject(h.project.projectId))
    expect(loaded?.document).toEqual({ ...history.final, updatedAt: history.transactions.at(-1)!.timestamp })
    expect(loaded?.replayed).toHaveLength(503)
  })

  it('refuses an incomplete log instead of returning a successful partial model', async () => {
    const h = await setup()
    await h.append(placements(h.base, ['first', 'second', 'third']))
    await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query('transactions')
        .filter((q) => q.eq(q.field('resultRevision'), 2))
        .first()
      await ctx.db.delete(row!._id)
    })
    expect(await h.store.loadProject(h.project.projectId)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
  })

  it('replays nested forks only through each ancestor fork point', async () => {
    const h = await setup()
    const main = placements(h.base, ['first', 'main-only'])
    await h.append(main)
    const child = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Child', atRevision: 1 }))
    const childHistory = commitAll(main.documents[0], [[{ type: 'document.rename', name: 'Child revision 2' }]])
    await h.append(childHistory, child.branchId)
    const grandchild = value(
      await h.backend.createBranch({
        projectId: h.project.projectId,
        fromBranchId: child.branchId,
        name: 'Grandchild',
      }),
    )
    await h.append(
      commitAll(childHistory.final, [[{ type: 'document.rename', name: 'Later child edit' }]]),
      child.branchId,
    )
    const loaded = value(await h.store.loadProject(h.project.projectId, { branchId: grandchild.branchId }))
    expect(loaded?.document).toEqual({ ...childHistory.final, updatedAt: childHistory.transactions.at(-1)!.timestamp })
    const page = value(
      await h.backend.readHistory({ projectId: h.project.projectId, branchId: grandchild.branchId, sinceRevision: 0 }),
    )
    expect(page.transactions.map((row) => row.branchId)).toEqual([h.project.defaultBranchId, child.branchId])
    expect(page).toMatchObject({ done: true, headRevision: 2, nextRevision: 2 })
  })

  it('pins subsequent pages while another writer advances the head', async () => {
    const h = await setup()
    const initial = placements(h.base, ['first', 'second', 'third'])
    await h.append(initial)
    const first = value(await h.backend.readHistory({ projectId: h.project.projectId, sinceRevision: 0, limit: 1 }))
    await h.append(commitAll(initial.final, [[{ type: 'document.rename', name: 'Arrived during read' }]]))
    const rest = value(
      await h.backend.readHistory({
        projectId: h.project.projectId,
        branchId: first.branchId,
        sinceRevision: first.nextRevision,
        throughRevision: first.headRevision,
      }),
    )
    expect(rest).toMatchObject({ done: true, headRevision: 3, nextRevision: 3 })
    expect(rest.transactions.map((row) => row.resultRevision)).toEqual([2, 3])
    expect(value(await h.backend.readHistory({ projectId: h.project.projectId, sinceRevision: 3 })).headRevision).toBe(
      4,
    )
  })

  it('bounds pages by bytes as well as count without dropping the overflow record', async () => {
    const h = await setup()
    const history = commitAll(
      h.base,
      Array.from({ length: 7 }, (_, i) => [{ type: 'document.rename', name: `Build ${i}` }]),
    )
    history.transactions.forEach((txn) => {
      txn.label = 'x'.repeat(350_000)
    })
    await h.append(history)
    const first = value(await h.backend.readHistory({ projectId: h.project.projectId, sinceRevision: 0, limit: 500 }))
    expect(first.transactions.length).toBeGreaterThan(0)
    expect(first.transactions.length).toBeLessThan(7)
    expect(
      first.transactions.reduce((bytes, record) => bytes + utf8Bytes(canonicalJson(record)), 0),
    ).toBeLessThanOrEqual(MAX_HISTORY_PAGE_BYTES)
    expect(first.done).toBe(false)
    const rest = value(
      await h.backend.readHistory({
        projectId: h.project.projectId,
        sinceRevision: first.nextRevision,
        throughRevision: first.headRevision,
      }),
    )
    expect([...first.transactions, ...rest.transactions].map((row) => row.clientTransactionId)).toEqual(
      history.transactions.map((txn) => txn.id),
    )
    expect(rest).toMatchObject({ done: true, nextRevision: 7, headRevision: 7 })
  })

  it('finds a quiet branch checkpoint despite more than 256 newer sibling snapshots', async () => {
    const h = await setup()
    const sibling = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Busy sibling' }))
    const history = placements(h.base, ['sibling-only'])
    await h.append(history, sibling.branchId)
    for (let i = 0; i < 260; i++)
      value(
        await h.backend.saveCheckpoint({
          projectId: h.project.projectId,
          branchId: sibling.branchId,
          snapshot: snapshotUploadFor(history.final),
        }),
      )
    expect(
      value(await h.backend.latestCheckpoint({ projectId: h.project.projectId, branchId: h.project.defaultBranchId }))
        ?.document,
    ).toEqual(h.base)
    const quiet = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Quiet' }))
    expect(value(await h.store.loadProject(h.project.projectId, { branchId: quiet.branchId }))?.document).toEqual(
      h.base,
    )
  })

  it('rejects a corrupted log checksum without replaying the valid prefix', async () => {
    const h = await setup()
    await h.append(placements(h.base, ['first', 'second']))
    await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query('transactions')
        .filter((q) => q.eq(q.field('resultRevision'), 2))
        .first()
      await ctx.db.patch(row!._id, { checksum: 'tampered' })
    })
    expect(await h.store.loadProject(h.project.projectId)).toMatchObject({
      ok: false,
      error: { code: 'CHECKSUM_MISMATCH' },
    })
  })

  it('rejects inconsistent transaction envelopes even with a valid content checksum', async () => {
    const h = await setup()
    await h.append(placements(h.base, ['first']))
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query('transactions').first())!
      const payload = { ...row.payload, resultRevision: 99 }
      await ctx.db.patch(row._id, { payload, checksum: transactionChecksum(payload) })
    })
    expect(await h.store.loadProject(h.project.projectId)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
  })

  it('refuses an absent final transaction rather than trusting an empty last page', async () => {
    const h = await setup()
    await h.append(placements(h.base, ['first']))
    await h.t.run(async (ctx) => {
      await ctx.db.delete((await ctx.db.query('transactions').first())!._id)
    })
    expect(await h.store.loadProject(h.project.projectId)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_HISTORY' },
    })
  })

  it('keeps checkpoints, project membership and history reads branch-authorized', async () => {
    const h = await setup()
    const args = { projectId: h.project.projectId, sinceRevision: 0 }
    expect(await h.deployment.query(refs.transactions.history, args)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    })
    expect(await h.deployment.withIdentity({ subject: 'bob' }).query(refs.transactions.history, args)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    const other = value(
      await h.backend.createProject({
        localProjectId: 'other',
        name: 'Other',
        schemaVersion: 2,
        catalogVersion: h.base.catalogVersion,
      }),
    )
    expect(await h.backend.readHistory({ ...args, branchId: other.defaultBranchId })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    expect(
      await h.backend.latestCheckpoint({ projectId: h.project.projectId, branchId: other.defaultBranchId }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it.each([
    { sinceRevision: -1 },
    { sinceRevision: 0.5 },
    { sinceRevision: 0, limit: 0 },
    { sinceRevision: 0, limit: 1.5 },
    { sinceRevision: 0, throughRevision: -1 },
  ])('rejects invalid page arguments %j', async (args) => {
    const h = await setup()
    expect(await h.backend.readHistory({ projectId: h.project.projectId, ...args })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('refuses a read target beyond the stored head', async () => {
    const h = await setup()
    expect(
      await h.backend.readHistory({ projectId: h.project.projectId, sinceRevision: 0, throughRevision: 9 }),
    ).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
  })

  it('leaves no branch or success audit event when its source checkpoint is corrupt', async () => {
    const h = await setup()
    const before = value(await h.backend.auditTrail({ projectId: h.project.projectId }))
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query('snapshots').first())!
      await ctx.db.patch(row._id, { data: row.data.replace('Test build', 'Lost build') })
    })
    expect(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Must not exist' })).toMatchObject({
      ok: false,
      error: { code: 'CHECKSUM_MISMATCH' },
    })
    expect(value(await h.backend.listBranches({ projectId: h.project.projectId }))).toHaveLength(1)
    expect(value(await h.backend.auditTrail({ projectId: h.project.projectId }))).toEqual(before)
  })

  it('detects a corrupt ancestor cycle instead of hanging or serving unrelated data', async () => {
    const h = await setup()
    await h.append(placements(h.base, ['first']))
    const branch = value(await h.backend.createBranch({ projectId: h.project.projectId, name: 'Cycle' }))
    await h.t.run(async (ctx) => {
      const row = (await ctx.db
        .query('branches')
        .filter((q) => q.eq(q.field('name'), 'Cycle'))
        .first())!
      await ctx.db.patch(row._id, { forkedFromBranchId: row._id })
    })
    expect(
      await h.backend.readHistory({ projectId: h.project.projectId, branchId: branch.branchId, sinceRevision: 0 }),
    ).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
  })

  it.each(['id', 'revision', 'patch', 'missing'])(
    'rejects a malformed %s at append without advancing the head',
    async (field) => {
      const h = await setup()
      const original = placements(h.base, ['first']).transactions[0]
      const transaction =
        field === 'id'
          ? { ...original, id: 'wrong-id' }
          : field === 'revision'
            ? { ...original, resultRevision: 99 }
            : field === 'patch'
              ? { ...original, patch: { ...original.patch, baseRevision: 99 } }
              : (null as unknown as Transaction)
      const args = {
        projectId: h.project.projectId,
        clientTransactionId: original.id,
        baseRevision: 0,
        resultRevision: 1,
        transaction,
        checksum: transactionChecksum(transaction),
        schemaVersion: 2,
        catalogVersion: h.base.catalogVersion,
      }
      expect(await h.backend.appendTransaction(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
      expect(value(await h.backend.getProject({ projectId: h.project.projectId })).headRevision).toBe(0)
      expect(await h.t.run((ctx) => ctx.db.query('transactions').collect())).toHaveLength(0)
    },
  )
})
