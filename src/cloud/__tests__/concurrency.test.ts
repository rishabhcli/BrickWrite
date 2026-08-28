import { describe, expect, it } from 'vitest'
import { transactionChecksum } from '../serialize'
import type { AppendTransactionArgs, StaleDocumentDetails } from '../protocol'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, BOB, addMember, blankProject, makeHarness, placements } from './harness'

/**
 * Gate 3 — two writers at one base revision produce exactly one success.
 * Gate 4 — replaying a client transaction id produces exactly one revision.
 *
 * These are the two properties that make the replica trustworthy. Without the
 * first, concurrent editing silently drops an edit; without the second, a
 * dropped response turns one edit into two.
 */

async function twoEditorsOnOneProject() {
  const deployment = new FakeConvexDeployment()
  const alice = makeHarness(ALICE, deployment)
  const document = blankProject('doc_shared', 'Shared build')
  await alice.local.saveCheckpoint(document)
  const claimed = await alice.store.claim('doc_shared')
  if (!claimed.ok) throw new Error(claimed.error.message)
  await addMember(deployment, alice.backend, claimed.value.projectId, BOB, 'editor')
  return {
    deployment,
    alice,
    bob: deployment.as(BOB),
    document,
    projectId: claimed.value.projectId,
    branchId: claimed.value.branchId,
  }
}

const appendArgs = (
  projectId: string,
  document: ReturnType<typeof blankProject>,
  transaction: ReturnType<typeof placements>['transactions'][number],
): AppendTransactionArgs => ({
  projectId,
  clientTransactionId: transaction.id,
  baseRevision: transaction.baseRevision,
  resultRevision: transaction.resultRevision,
  transaction,
  checksum: transactionChecksum(transaction),
  schemaVersion: document.schemaVersion,
  catalogVersion: document.catalogVersion,
})

describe('optimistic concurrency control', () => {
  it('accepts exactly one of two writers at the same base revision', async () => {
    const shared = await twoEditorsOnOneProject()
    // Two genuinely independent edits, both authored against revision 0.
    const alicesEdit = placements(shared.document, ['alice_part']).transactions[0]
    const bobsEdit = placements(shared.document, ['bob_part']).transactions[0]
    expect(alicesEdit.baseRevision).toBe(0)
    expect(bobsEdit.baseRevision).toBe(0)

    const [first, second] = await Promise.all([
      shared.alice.backend.appendTransaction(
        appendArgs(shared.projectId, shared.document, alicesEdit),
      ),
      shared.bob.appendTransaction(appendArgs(shared.projectId, shared.document, bobsEdit)),
    ])

    const outcomes = [first, second]
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1)
    const loser = outcomes.find((result) => !result.ok)
    expect(loser).toBeTruthy()
    if (loser && !loser.ok) {
      expect(loser.error.code).toBe('STALE_DOCUMENT')
      const details = loser.error.details as StaleDocumentDetails
      // The refusal has to carry the head, or the loser has nothing to rebase onto.
      expect(details.headRevision).toBe(1)
      expect(details.branchId).toBe(shared.branchId)
    }

    // The winner's transaction is the only one stored, and the head advanced once.
    expect(shared.deployment.transactions).toHaveLength(1)
    const branch = shared.deployment.branches.find((row) => row._id === shared.branchId)
    expect(branch?.headRevision).toBe(1)
  })

  it('never last-write-wins: the loser’s work is not stored and not overwritten', async () => {
    const shared = await twoEditorsOnOneProject()
    const alicesEdit = placements(shared.document, ['alice_part']).transactions[0]
    const bobsEdit = placements(shared.document, ['bob_part']).transactions[0]

    const won = await shared.alice.backend.appendTransaction(
      appendArgs(shared.projectId, shared.document, alicesEdit),
    )
    expect(won.ok).toBe(true)
    const lost = await shared.bob.appendTransaction(
      appendArgs(shared.projectId, shared.document, bobsEdit),
    )
    expect(lost.ok).toBe(false)

    const stored = shared.deployment.transactions.map((row) => row.clientTransactionId)
    expect(stored).toEqual([alicesEdit.id])
    // Nothing about the winner changed, and the loser's payload is simply absent.
    const log = await shared.alice.backend.listTransactions({
      projectId: shared.projectId,
      sinceRevision: 0,
    })
    expect(log.ok).toBe(true)
    if (log.ok) {
      expect(log.value).toHaveLength(1)
      expect(log.value[0].transaction.id).toBe(alicesEdit.id)
    }
  })

  it('refuses a transaction that skips a revision', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    const skipped = await shared.alice.backend.appendTransaction({
      ...appendArgs(shared.projectId, shared.document, edit),
      resultRevision: 5,
    })
    expect(skipped.ok).toBe(false)
    if (!skipped.ok) expect(skipped.error.code).toBe('INVALID_ARGUMENT')
  })

  it('refuses a transaction written against a different document schema', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    const mismatched = await shared.alice.backend.appendTransaction({
      ...appendArgs(shared.projectId, shared.document, edit),
      schemaVersion: 99,
    })
    expect(mismatched.ok).toBe(false)
    if (!mismatched.ok) expect(mismatched.error.code).toBe('SCHEMA_MISMATCH')
  })

  it('refuses a transaction whose checksum does not match its payload', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    const tampered = await shared.alice.backend.appendTransaction({
      ...appendArgs(shared.projectId, shared.document, edit),
      checksum: '0'.repeat(32),
    })
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.error.code).toBe('CHECKSUM_MISMATCH')
  })
})

describe('idempotency', () => {
  it('creates exactly one revision when a transaction id is replayed', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    const args = appendArgs(shared.projectId, shared.document, edit)

    const outcomes = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcomes.push(await shared.alice.backend.appendTransaction(args))
    }

    expect(outcomes.every((result) => result.ok)).toBe(true)
    // The first call applies; the four retries are answered from the stored row.
    const applied = outcomes.filter((result) => result.ok && result.value.applied)
    expect(applied).toHaveLength(1)
    for (const result of outcomes) {
      expect(result.ok && result.value.headRevision).toBe(1)
    }
    expect(shared.deployment.transactions).toHaveLength(1)
    const branch = shared.deployment.branches.find((row) => row._id === shared.branchId)
    expect(branch?.headRevision).toBe(1)
  })

  it('answers concurrent retries of one id with a single stored transaction', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    const args = appendArgs(shared.projectId, shared.document, edit)

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => shared.alice.backend.appendTransaction(args)),
    )
    expect(outcomes.filter((result) => result.ok && result.value.applied)).toHaveLength(1)
    expect(shared.deployment.transactions).toHaveLength(1)
  })

  it('refuses to reuse a transaction id for different content', async () => {
    const shared = await twoEditorsOnOneProject()
    const first = placements(shared.document, ['p1']).transactions[0]
    const second = placements(shared.document, ['p2']).transactions[0]

    expect((await shared.alice.backend.appendTransaction(
      appendArgs(shared.projectId, shared.document, first),
    )).ok).toBe(true)

    // Same id, different payload: two edits claiming one identity, which is not
    // a retry and must not be treated as one.
    const impostor = await shared.alice.backend.appendTransaction({
      ...appendArgs(shared.projectId, shared.document, second),
      clientTransactionId: first.id,
    })
    expect(impostor.ok).toBe(false)
    if (!impostor.ok) expect(impostor.error.code).toBe('INVALID_ARGUMENT')
    expect(shared.deployment.transactions).toHaveLength(1)
  })

  it('idempotency is scoped to the branch, so a fork keeps its own copy', async () => {
    const shared = await twoEditorsOnOneProject()
    const edit = placements(shared.document, ['p1']).transactions[0]
    expect((await shared.alice.backend.appendTransaction(
      appendArgs(shared.projectId, shared.document, edit),
    )).ok).toBe(true)

    const fork = await shared.alice.backend.createBranch({
      projectId: shared.projectId,
      name: 'alternative',
      kind: 'named',
      atRevision: 0,
    })
    expect(fork.ok).toBe(true)
    if (!fork.ok) return

    const onFork = await shared.alice.backend.appendTransaction({
      ...appendArgs(shared.projectId, shared.document, edit),
      branchId: fork.value.branchId,
    })
    expect(onFork.ok).toBe(true)
    if (onFork.ok) expect(onFork.value.applied).toBe(true)
    expect(shared.deployment.transactions).toHaveLength(2)
  })
})
