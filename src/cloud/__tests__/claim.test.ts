import { describe, expect, it } from 'vitest'
import type { CadOperation, ModuleDefinition } from '../../cad/types'
import { claimIntegrityReport, provenanceOf, transactionIds } from '../claim'
import { canonicalJson } from '../serialize'
import { blankProject, commitAll, makeHarness, part } from './harness'

/**
 * Gate 7 — importing a local project into the cloud loses nothing.
 *
 * The document is checkpointed part-way through its history, so the claim has
 * to carry both halves: the checkpoint document and the transactions logged
 * after it. Anything the mapper forgot would show up as a difference on the way
 * back down.
 */

const TURRET_MODULE: ModuleDefinition = {
  id: 'module_turret',
  name: 'Turret bay',
  parts: [
    {
      definitionId: '3001',
      color: 72,
      transform: { position: [0, 0, 0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    },
  ],
  sizeLdu: [40, 24, 20],
  createdAtRevision: 3,
  author: 'human',
}

/** A document that exercises every collection a claim has to carry. */
function richHistory(projectId = 'doc_claim') {
  const blank = blankProject(projectId, 'Claim fixture')
  const batches: CadOperation[][] = [
    [
      { type: 'part.add', part: part('p1', [0, 0, 0]) },
      { type: 'part.add', part: part('p2', [0, -24, 0]) },
    ],
    [
      {
        type: 'subassembly.add',
        subassembly: { id: 'turret', name: 'Turret', partIds: [], locked: false, accent: '#c94f7c' },
      },
      { type: 'part.assign-subassembly', partId: 'p2', subassemblyId: 'turret' },
    ],
    [
      {
        type: 'constraint.set',
        constraint: {
          id: 'constraint_pieces',
          kind: 'piece-count',
          label: 'Under 40 pieces',
          value: 40,
          hard: false,
        },
      },
    ],
    [{ type: 'module.define', module: TURRET_MODULE }],
    [
      {
        type: 'note.add',
        note: {
          id: 'note_1',
          anchorPartIds: ['p2'],
          text: 'The turret needs a second plate under it.',
          status: 'open',
          author: 'human',
          revisionCreated: 0,
        },
      },
    ],
    [{ type: 'part.protect', partId: 'p1', protected: true }],
  ]
  return commitAll(blank, batches)
}

describe('claiming a local project', () => {
  it('round-trips document, log, modules, constraints, notes and provenance', async () => {
    const harness = makeHarness()
    const history = richHistory()

    // Checkpoint half-way, so the claim must carry a checkpoint plus a log.
    const checkpointAt = history.documents[2]
    expect(checkpointAt.revision).toBe(3)
    expect((await harness.local.saveCheckpoint(checkpointAt)).ok).toBe(true)
    for (const transaction of history.transactions.slice(3)) {
      expect((await harness.local.appendTransaction(checkpointAt.id, transaction)).ok).toBe(true)
    }

    const claimed = await harness.store.claim(checkpointAt.id)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.value.checkpointRevision).toBe(3)
    expect(claimed.value.transactionsUploaded).toBe(3)
    expect(claimed.value.headRevision).toBe(6)

    const localLoaded = await harness.local.loadProject(checkpointAt.id)
    const cloudLoaded = await harness.cloud.loadProject(claimed.value.projectId)
    expect(localLoaded.ok && cloudLoaded.ok).toBe(true)
    if (!localLoaded.ok || !localLoaded.value || !cloudLoaded.ok || !cloudLoaded.value) return

    const report = claimIntegrityReport(localLoaded.value, cloudLoaded.value)
    expect(report.differences).toEqual([])
    expect(report.lossless).toBe(true)
    expect(report.cloudRevision).toBe(report.localRevision)
    expect(report.cloudTransactionCount).toBe(report.localTransactionCount)

    const local = localLoaded.value.document
    const cloud = cloudLoaded.value.document

    // The whole document, byte for byte in canonical form.
    expect(canonicalJson(cloud)).toBe(canonicalJson(local))

    // And each carrier named in the acceptance gate, explicitly.
    expect(cloud.modules).toEqual(local.modules)
    expect(cloud.modules?.map((module) => module.id)).toEqual(['module_turret'])
    expect(cloud.constraints).toEqual(local.constraints)
    expect(cloud.constraints.map((constraint) => constraint.id)).toEqual(['constraint_pieces'])
    expect(cloud.notes).toEqual(local.notes)
    expect(cloud.notes[0].text).toBe('The turret needs a second plate under it.')
    expect(cloud.subassemblies).toEqual(local.subassemblies)
    expect(cloud.connections).toEqual(local.connections)
    expect(cloud.steps).toEqual(local.steps)
    expect(cloud.parts.p1.protected).toBe(true)

    // Provenance: who made each part, and in which transaction.
    expect(provenanceOf(cloud)).toEqual(provenanceOf(local))
    expect(cloud.parts.p1.createdByTransaction).toBe(history.transactions[0].id)

    // The log itself, in order and unaltered.
    expect(transactionIds(cloudLoaded.value.replayed)).toEqual(
      transactionIds(localLoaded.value.replayed),
    )
    expect(transactionIds(cloudLoaded.value.replayed)).toEqual(
      history.transactions.slice(3).map((transaction) => transaction.id),
    )
    for (const [index, replayed] of cloudLoaded.value.replayed.entries()) {
      expect(replayed).toEqual(localLoaded.value.replayed[index])
    }
  })

  it('records the link so later edits reach the same replica', async () => {
    const harness = makeHarness()
    const history = richHistory('doc_link')
    await harness.local.saveCheckpoint(history.final)
    const claimed = await harness.store.claim('doc_link')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return

    const link = await harness.store.links.get('doc_link')
    expect(link?.cloudProjectId).toBe(claimed.value.projectId)
    expect(link?.branchId).toBe(claimed.value.branchId)
    expect(link?.syncedRevision).toBe(history.final.revision)

    const follow = commitAll(history.final, [[{ type: 'part.add', part: part('p_after') }]])
    expect((await harness.store.appendTransaction('doc_link', follow.transactions[0])).ok).toBe(true)
    expect((await harness.outbox.drain()).status).toBe('idle')
    expect(harness.deployment.transactions).toHaveLength(1)
  })

  it('refuses to claim the same local project twice', async () => {
    const harness = makeHarness()
    const history = richHistory('doc_twice')
    await harness.local.saveCheckpoint(history.final)
    expect((await harness.store.claim('doc_twice')).ok).toBe(true)

    const again = await harness.store.claim('doc_twice')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('NAME_TAKEN')
  })

  it('refuses to claim a project this browser has no checkpoint for', async () => {
    const harness = makeHarness()
    const missing = await harness.store.claim('doc_nothing_here')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND')
  })

  it('reports a difference rather than passing a damaged round trip', async () => {
    const harness = makeHarness()
    const history = richHistory('doc_damage')
    await harness.local.saveCheckpoint(history.final)
    const claimed = await harness.store.claim('doc_damage')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return

    const localLoaded = await harness.local.loadProject('doc_damage')
    const cloudLoaded = await harness.cloud.loadProject(claimed.value.projectId)
    if (!localLoaded.ok || !localLoaded.value || !cloudLoaded.ok || !cloudLoaded.value) {
      throw new Error('fixture failed to load')
    }
    // The integrity report is only worth running if it can fail.
    const damaged = {
      ...cloudLoaded.value,
      document: { ...cloudLoaded.value.document, constraints: [] },
    }
    const report = claimIntegrityReport(localLoaded.value, damaged)
    expect(report.lossless).toBe(false)
    expect(report.differences).toContain('constraints differs.')
  })
})
