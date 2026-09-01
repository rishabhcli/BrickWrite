// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import { codeOf, expectOk, harness, person, seedProject, transaction } from './harness'

/**
 * The transaction log: compare-and-advance, idempotency and atomicity.
 *
 * This is the one place in the deployment where two clients race for the same
 * resource, and the only place where a wrong answer silently destroys work
 * rather than refusing it. The properties below are the ones `model/append.ts`
 * claims in prose; each is asserted against the real mutation.
 */

const append = (t: ReturnType<typeof harness>, as: string, projectId: string, branchId: string, tx: ReturnType<typeof transaction>) =>
  t.withIdentity(person(as)).mutation(api.transactions.append, { projectId, branchId, ...tx })

describe('compare-and-advance', () => {
  test('an edit at the head advances the head by one', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const first = expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-1' })))
    expect(first.headRevision).toBe(1)
    expect(first.applied).toBe(true)

    const second = expectOk(
      await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-2', baseRevision: 1 })),
    )
    expect(second.headRevision).toBe(2)
  })

  test('an edit against a stale base is refused, and the head does not move', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-1' })))

    const stale = await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-stale' }))
    expect(codeOf(stale)).toBe('STALE_DOCUMENT')

    const head = await t.run(async (ctx) => (await ctx.db.get(seed.branchId))!.headRevision)
    expect(head).toBe(1)
  })

  test('two writers at the same base cannot both land', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { colleague: 'editor' } })
    const mine = await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-mine' }))
    const theirs = await append(t, 'colleague', seed.projectId, seed.branchId, transaction({ id: 'tx-theirs' }))
    expect(codeOf(mine)).toBe('ok')
    expect(codeOf(theirs)).toBe('STALE_DOCUMENT')
  })
})

describe('idempotency', () => {
  test('replaying the same transaction id returns the original receipt without a second row', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const tx = transaction({ id: 'tx-retry' })
    const first = expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, tx))
    const replay = expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, tx))

    expect(replay.transactionId).toBe(first.transactionId)
    expect(replay.applied).toBe(false)
    expect(replay.headRevision).toBe(1)
    const rows = await t.run(async (ctx) => ctx.db.query('transactions').collect())
    expect(rows).toHaveLength(1)
  })

  test('a reused id carrying different content is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-1' })))
    const impostor = await append(
      t,
      'owner-account',
      seed.projectId,
      seed.branchId,
      transaction({ id: 'tx-1', label: 'Different content' }),
    )
    expect(codeOf(impostor)).toBe('INVALID_ARGUMENT')
  })

  test('a transaction whose checksum does not match its payload is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const tampered = { ...transaction({ id: 'tx-1' }), checksum: '0'.repeat(32) }
    expect(codeOf(await append(t, 'owner-account', seed.projectId, seed.branchId, tampered))).toBe('CHECKSUM_MISMATCH')
    expect(await t.run(async (ctx) => ctx.db.query('transactions').collect())).toHaveLength(0)
  })

  test('a transaction that does not advance by exactly one is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const skipped = { ...transaction({ id: 'tx-1' }), resultRevision: 5 }
    expect(codeOf(await append(t, 'owner-account', seed.projectId, seed.branchId, skipped))).toBe('INVALID_ARGUMENT')
  })

  test('a transaction declaring the wrong schema version is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const wrong = { ...transaction({ id: 'tx-1' }), schemaVersion: 3 }
    expect(codeOf(await append(t, 'owner-account', seed.projectId, seed.branchId, wrong))).toBe('SCHEMA_MISMATCH')
  })
})

describe('batches are all-or-nothing', () => {
  test('a contiguous batch lands as one advance', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const result = expectOk(
      await t.withIdentity(person('owner-account')).mutation(api.transactions.appendBatch, {
        projectId: seed.projectId,
        branchId: seed.branchId,
        transactions: [
          transaction({ id: 'tx-1', baseRevision: 0 }),
          transaction({ id: 'tx-2', baseRevision: 1 }),
          transaction({ id: 'tx-3', baseRevision: 2 }),
        ],
      }),
    )
    expect(result.headRevision).toBe(3)
    expect(await t.run(async (ctx) => ctx.db.query('transactions').collect())).toHaveLength(3)
  })

  test('one bad entry stores none of the batch', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const result = await t.withIdentity(person('owner-account')).mutation(api.transactions.appendBatch, {
      projectId: seed.projectId,
      branchId: seed.branchId,
      transactions: [
        transaction({ id: 'tx-1', baseRevision: 0 }),
        // A gap: revision 2 is never produced, so the batch is not a history.
        transaction({ id: 'tx-3', baseRevision: 2 }),
      ],
    })
    expect(codeOf(result)).toBe('INVALID_ARGUMENT')
    expect(await t.run(async (ctx) => ctx.db.query('transactions').collect())).toHaveLength(0)
    expect(await t.run(async (ctx) => (await ctx.db.get(seed.branchId))!.headRevision)).toBe(0)
  })

  test('a batch reusing an id within itself is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const result = await t.withIdentity(person('owner-account')).mutation(api.transactions.appendBatch, {
      projectId: seed.projectId,
      branchId: seed.branchId,
      transactions: [transaction({ id: 'tx-1', baseRevision: 0 }), transaction({ id: 'tx-1', baseRevision: 1 })],
    })
    expect(codeOf(result)).toBe('INVALID_ARGUMENT')
    expect(await t.run(async (ctx) => ctx.db.query('transactions').collect())).toHaveLength(0)
  })

  test('an empty batch is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const result = await t
      .withIdentity(person('owner-account'))
      .mutation(api.transactions.appendBatch, { projectId: seed.projectId, branchId: seed.branchId, transactions: [] })
    expect(codeOf(result)).toBe('INVALID_ARGUMENT')
  })
})

describe('a branch id is not a capability', () => {
  test('a branch from another project is not followed', async () => {
    const t = harness()
    const mine = await seedProject(t, { owner: 'owner-account' })
    const theirs = await seedProject(t, { owner: 'other-owner' })
    const result = await append(t, 'owner-account', mine.projectId, theirs.branchId, transaction({ id: 'tx-1' }))
    expect(codeOf(result)).toBe('NOT_FOUND')
  })

  test('an editor on one project cannot write to another', async () => {
    const t = harness()
    const theirs = await seedProject(t, { owner: 'other-owner' })
    await seedProject(t, { owner: 'owner-account', members: { intruder: 'editor' } })
    const result = await append(t, 'intruder', theirs.projectId, theirs.branchId, transaction({ id: 'tx-1' }))
    expect(codeOf(result)).toBe('NOT_FOUND')
  })
})

describe('the log is readable only by members', () => {
  test('listSince pages a branch for a member and refuses a stranger', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { reader: 'viewer' } })
    expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-1' })))

    const page = expectOk(
      await t
        .withIdentity(person('reader'))
        .query(api.transactions.listSince, { projectId: seed.projectId, branchId: seed.branchId, sinceRevision: 0 }),
    )
    expect(page).toHaveLength(1)
    expect(page[0].clientTransactionId).toBe('tx-1')
    expect(
      codeOf(
        await t
          .withIdentity(person('stranger'))
          .query(api.transactions.listSince, { projectId: seed.projectId, branchId: seed.branchId, sinceRevision: 0 }),
      ),
    ).toBe('NOT_FOUND')
  })

  test('findByClientId answers only within the caller’s project', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expectOk(await append(t, 'owner-account', seed.projectId, seed.branchId, transaction({ id: 'tx-1' })))
    const found = expectOk(
      await t.withIdentity(person('owner-account')).query(api.transactions.findByClientId, {
        projectId: seed.projectId,
        branchId: seed.branchId,
        clientTransactionId: 'tx-1',
      }),
    )
    expect(found).not.toBeNull()
    expect(
      codeOf(
        await t.withIdentity(person('stranger')).query(api.transactions.findByClientId, {
          projectId: seed.projectId,
          branchId: seed.branchId,
          clientTransactionId: 'tx-1',
        }),
      ),
    ).toBe('NOT_FOUND')
  })
})
