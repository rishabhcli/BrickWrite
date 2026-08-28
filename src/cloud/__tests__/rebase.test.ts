import { describe, expect, it } from 'vitest'
import type { CadOperation } from '../../cad/types'
import { executeConflictFork, isDisjoint, overlapOf, planRebase, scopeOf } from '../rebase'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, BOB, addMember, blankProject, commitAll, makeHarness, part } from './harness'
import { transactionChecksum } from '../serialize'

/**
 * Gate 6 — disjoint edits rebase automatically; overlapping edits fork.
 *
 * The rule is narrow on purpose. Two edits are merged only when they provably
 * touched nothing in common, and "provably" includes the whole-document
 * collections `patch.touched` does not cover. Everything else keeps both
 * histories and asks a person.
 */

/** A base with two independent parts already placed, at revision 2. */
function twoPartBase(projectId = 'doc_rebase') {
  const blank = blankProject(projectId, 'Rebase fixture')
  return commitAll(blank, [
    [{ type: 'part.add', part: part('p1', [0, 0, 0]) }],
    [{ type: 'part.add', part: part('p2', [100, 0, 0]) }],
  ])
}

const moveP1: CadOperation[] = [
  {
    type: 'part.transform',
    partId: 'p1',
    transform: { position: [0, -24, 0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  },
]
const recolourP2: CadOperation[] = [{ type: 'part.recolor', partId: 'p2', color: 4 }]
const recolourP1: CadOperation[] = [{ type: 'part.recolor', partId: 'p1', color: 14 }]

describe('entity scope', () => {
  it('reads parts and subassemblies from the patch’s touched set', () => {
    const base = twoPartBase()
    const local = commitAll(base.final, [moveP1])
    const scope = scopeOf(local.transactions)
    expect([...scope.partIds]).toEqual(['p1'])
    expect([...scope.globals]).toEqual([])
  })

  it('counts the whole-document collections that `touched` does not cover', () => {
    const base = twoPartBase()
    // `part.add` also rewrites step membership and the subassembly's part list,
    // which is exactly the sort of overlap a parts-only check would miss.
    const added = commitAll(base.final, [
      [{ type: 'part.add', part: part('p3', [200, 0, 0]) }],
    ])
    const scope = scopeOf(added.transactions)
    expect([...scope.globals]).toContain('steps')
    expect([...scope.subassemblyIds]).toContain('hull')
  })

  it('treats two part additions as overlapping, because both rewrite the step list', () => {
    const base = twoPartBase()
    const left = commitAll(base.final, [[{ type: 'part.add', part: part('a') }]])
    const right = commitAll(base.final, [[{ type: 'part.add', part: part('b') }]])
    const overlap = overlapOf(scopeOf(left.transactions), scopeOf(right.transactions))
    expect(isDisjoint(overlap)).toBe(false)
    expect(overlap.globals).toContain('steps')
  })
})

describe('planning a rebase', () => {
  it('rebases when the two sides touched provably disjoint entities', () => {
    const base = twoPartBase()
    const local = commitAll(base.final, [moveP1])
    const remote = commitAll(base.final, [recolourP2])

    const plan = planRebase({
      base: base.final,
      localTail: local.transactions,
      remoteTail: remote.transactions,
    })
    expect(plan.kind).toBe('rebase')
    if (plan.kind !== 'rebase') return

    // The local edit is renumbered onto the cloud head, keeping its identity so
    // an already-queued retry is still recognised as the same transaction.
    expect(plan.onto).toBe(3)
    expect(plan.headRevision).toBe(4)
    expect(plan.rebased).toHaveLength(1)
    expect(plan.rebased[0].id).toBe(local.transactions[0].id)
    expect(plan.rebased[0].baseRevision).toBe(3)
    expect(plan.rebased[0].resultRevision).toBe(4)
    expect(plan.rebased[0].patch.baseRevision).toBe(3)

    // Both edits are present in the reconciled document.
    expect(plan.document.parts.p1.transform.position).toEqual([0, -24, 0])
    expect(plan.document.parts.p2.color).toBe(4)
    expect(plan.document.revision).toBe(4)
  })

  it('recomputes the inverse against the document the edit now sits on', () => {
    const base = twoPartBase()
    const local = commitAll(base.final, [recolourP1])
    const remote = commitAll(base.final, [recolourP2])
    const plan = planRebase({
      base: base.final,
      localTail: local.transactions,
      remoteTail: remote.transactions,
    })
    if (plan.kind !== 'rebase') throw new Error('expected a rebase')
    const inverse = plan.rebased[0].patch.inverse
    // Undoing the rebased edit must restore p1 as it is on the new base, not as
    // it was on a history this branch never had.
    expect(inverse).toHaveLength(1)
    const mutation = inverse[0]
    expect(mutation.kind).toBe('part')
    if (mutation.kind === 'part') expect(mutation.value?.color).toBe(base.final.parts.p1.color)
  })

  it('forks when the two sides touched the same part', () => {
    const base = twoPartBase()
    const local = commitAll(base.final, [moveP1])
    const remote = commitAll(base.final, [recolourP1])

    const plan = planRebase({
      base: base.final,
      localTail: local.transactions,
      remoteTail: remote.transactions,
      now: () => new Date('2026-03-04T05:06:07.000Z'),
    })
    expect(plan.kind).toBe('conflict-fork')
    if (plan.kind !== 'conflict-fork') return

    expect(plan.overlap.partIds).toEqual(['p1'])
    expect(plan.forkRevision).toBe(2)
    // Both histories are carried out of the planner intact.
    expect(plan.localTail).toEqual(local.transactions)
    expect(plan.remoteTail).toEqual(remote.transactions)
    expect(plan.localDocument.parts.p1.transform.position).toEqual([0, -24, 0])
    expect(plan.remoteDocument.parts.p1.color).toBe(14)
    expect(plan.branchName).toBe('conflict/2026-03-04T05-06-07-000Z')
  })

  it('forks when both sides rewrote the same whole-document collection', () => {
    const base = twoPartBase()
    const local = commitAll(base.final, [
      [
        {
          type: 'steps.replace',
          steps: [{ id: 'step_1', index: 1, name: 'Renamed', partIds: ['p1', 'p2'] }],
        },
      ],
    ])
    const remote = commitAll(base.final, [[{ type: 'part.add', part: part('p9') }]])
    const plan = planRebase({
      base: base.final,
      localTail: local.transactions,
      remoteTail: remote.transactions,
    })
    expect(plan.kind).toBe('conflict-fork')
    if (plan.kind === 'conflict-fork') expect(plan.overlap.globals).toContain('steps')
  })

  it('fast-forwards when the browser has no unsent work', () => {
    const base = twoPartBase()
    const remote = commitAll(base.final, [recolourP2])
    const plan = planRebase({ base: base.final, localTail: [], remoteTail: remote.transactions })
    expect(plan.kind).toBe('fast-forward')
    if (plan.kind === 'fast-forward') {
      expect(plan.adopted).toEqual(remote.transactions)
      expect(plan.document.parts.p2.color).toBe(4)
    }
  })

  it('does not renumber a transaction the cloud already has', () => {
    const base = twoPartBase()
    const shared = commitAll(base.final, [recolourP2])
    const plan = planRebase({
      base: base.final,
      localTail: shared.transactions,
      remoteTail: shared.transactions,
    })
    // Renumbering it would present one id with two different payloads, which
    // the deployment rightly refuses.
    expect(plan.kind).toBe('fast-forward')
  })
})

describe('reconciling against a live deployment', () => {
  async function divergedProject(localOps: CadOperation[], remoteOps: CadOperation[]) {
    const deployment = new FakeConvexDeployment()
    const alice = makeHarness(ALICE, deployment)
    const base = twoPartBase()

    await alice.local.saveCheckpoint(base.final)
    const claimed = await alice.store.claim(base.final.id)
    if (!claimed.ok) throw new Error(claimed.error.message)
    await addMember(deployment, alice.backend, claimed.value.projectId, BOB, 'editor')

    // Bob lands his edit in the cloud first.
    const remote = commitAll(base.final, remoteOps.map((operation) => [operation]))
    for (const transaction of remote.transactions) {
      const landed = await deployment.as(BOB).appendTransaction({
        projectId: claimed.value.projectId,
        clientTransactionId: transaction.id,
        baseRevision: transaction.baseRevision,
        resultRevision: transaction.resultRevision,
        transaction,
        checksum: transactionChecksum(transaction),
        schemaVersion: base.final.schemaVersion,
        catalogVersion: base.final.catalogVersion,
      })
      expect(landed.ok).toBe(true)
    }

    // Alice, meanwhile, edited offline against the same base.
    const local = commitAll(base.final, localOps.map((operation) => [operation]))
    deployment.setOffline(true)
    for (const transaction of local.transactions) {
      expect((await alice.store.appendTransaction(base.final.id, transaction)).ok).toBe(true)
    }
    await alice.outbox.drain()
    deployment.setOffline(false)

    return { deployment, alice, base, local, remote, claimed: claimed.value }
  }

  it('auto-rebases a disjoint divergence and lands the local tail after it', async () => {
    const scene = await divergedProject(moveP1, recolourP2)

    const stale = await scene.alice.outbox.reconnected()
    expect(stale.status).toBe('conflict')
    expect(stale.conflict?.headRevision).toBe(3)

    const resolved = await scene.alice.store.resolveDivergence(scene.base.final.id)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.kind).toBe('rebase')
    expect(resolved.value.document?.revision).toBe(4)

    const drained = await scene.alice.outbox.reconnected()
    expect(drained.status).toBe('idle')

    // Nothing was lost: both transactions are in the cloud, in order.
    expect(scene.deployment.transactions.map((row) => row.resultRevision)).toEqual([3, 4])
    const cloud = await scene.alice.cloud.loadProject(scene.claimed.projectId)
    const local = await scene.alice.local.loadProject(scene.base.final.id)
    expect(cloud.ok && local.ok).toBe(true)
    if (cloud.ok && cloud.value && local.ok && local.value) {
      expect(cloud.value.document.revision).toBe(4)
      expect(cloud.value.document.parts.p1.transform.position).toEqual([0, -24, 0])
      expect(cloud.value.document.parts.p2.color).toBe(4)
      expect(local.value.document.parts).toEqual(cloud.value.document.parts)
    }
  })

  it('forks an overlapping divergence and keeps both histories intact', async () => {
    const scene = await divergedProject(moveP1, recolourP1)

    const resolved = await scene.alice.store.resolveDivergence(scene.base.final.id)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.kind).toBe('conflict-fork')
    const fork = resolved.value.fork
    expect(fork).toBeTruthy()
    if (!fork) return

    expect(fork.forkRevision).toBe(2)
    expect(fork.preserved.map((transaction) => transaction.id)).toEqual(
      scene.local.transactions.map((transaction) => transaction.id),
    )

    // Main is untouched: Bob's edit, and only Bob's edit.
    const branches = await scene.alice.backend.listBranches({
      projectId: scene.claimed.projectId,
    })
    expect(branches.ok).toBe(true)
    if (!branches.ok) return
    const main = branches.value.find((branch) => branch.kind === 'main')
    const conflict = branches.value.find((branch) => branch.kind === 'conflict')
    expect(main?.headRevision).toBe(3)
    expect(conflict?.headRevision).toBe(3)
    expect(conflict?.baseRevision).toBe(2)

    const mainDoc = await scene.alice.cloud.loadProject(scene.claimed.projectId, {
      branchId: main?.branchId,
    })
    const forkDoc = await scene.alice.cloud.loadProject(scene.claimed.projectId, {
      branchId: conflict?.branchId,
    })
    expect(mainDoc.ok && forkDoc.ok).toBe(true)
    if (mainDoc.ok && mainDoc.value && forkDoc.ok && forkDoc.value) {
      // Bob's colour change on one side, Alice's move on the other. Neither
      // side was rewritten to accommodate the other.
      expect(mainDoc.value.document.parts.p1.color).toBe(14)
      expect(mainDoc.value.document.parts.p1.transform.position).toEqual(
        scene.base.final.parts.p1.transform.position,
      )
      expect(forkDoc.value.document.parts.p1.transform.position).toEqual([0, -24, 0])
      expect(forkDoc.value.document.parts.p1.color).toBe(scene.base.final.parts.p1.color)
    }

    // Every transaction either side made is still stored somewhere.
    const stored = new Set(scene.deployment.transactions.map((row) => row.clientTransactionId))
    for (const transaction of [...scene.local.transactions, ...scene.remote.transactions]) {
      expect(stored.has(transaction.id), `${transaction.id} was discarded`).toBe(true)
    }
  })

  it('refuses to fork past the parent head', async () => {
    const scene = await divergedProject(moveP1, recolourP1)
    const bad = await executeConflictFork(scene.alice.backend, {
      projectId: scene.claimed.projectId,
      plan: {
        kind: 'conflict-fork',
        overlap: { partIds: [], subassemblyIds: [], connectionIds: [], globals: [] },
        forkRevision: 99,
        baseDocument: scene.base.final,
        localTail: [],
        remoteTail: [],
        localDocument: scene.base.final,
        remoteDocument: scene.base.final,
        branchName: 'impossible',
      },
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ARGUMENT')
  })
})
