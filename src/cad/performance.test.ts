import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { deriveBroadPhase, findCollisions } from './collision'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument } from './sample'
import { findSnapCandidates } from './snapping'
import { deriveConnections } from './snapping'
import { validateDocument } from './validation'
import type { CadOperation, ModelDocument, PartInstance } from './types'

/**
 * Scale and equivalence guards.
 *
 * These budgets are deliberately loose relative to a warm local run so CI noise
 * cannot make them flaky, but they are tight enough to catch the regressions
 * that actually matter: reintroducing whole-document clones per edit, or losing
 * the broad-phase grid and returning to O(n²) pair comparison.
 */

const BUDGETS = {
  // Measured ~0.55 ms/commit with structural sharing, lazy validation and the
  // incremental connector index; ~10 ms without them. The gap is wide enough
  // that a generous ceiling still catches a regression on any of the three.
  buildPerEditMs: 3,
  fullValidationMs: 900,
  incrementalValidationMs: 60,
  snapQueryMs: 40,
  undoMs: 60,
} as const

const part = (id: string, position: [number, number, number], definitionId = '3024'): PartInstance => ({
  id,
  definitionId,
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/**
 * A wall of 1x1 plates on a 20-LDU lattice, stacked 8 LDU apart.
 *
 * Every plate connects to its vertical neighbours, so the connection graph and
 * the collision broad phase both see realistic density rather than a sparse
 * cloud that would flatter the timings.
 */
function lattice(count: number): PartInstance[] {
  const parts: PartInstance[] = []
  const side = Math.ceil(Math.sqrt(count / 4))
  let index = 0
  for (let layer = 0; index < count; layer += 1) {
    for (let x = 0; x < side && index < count; x += 1) {
      for (let z = 0; z < side && index < count; z += 1) {
        parts.push(part(`p${index}`, [x * 20, -layer * 8, z * 20]))
        index += 1
      }
    }
  }
  return parts
}

const createEmptyParts = () => createEmptyDocument()

/** Fresh document object per call: derived state is memoized on identity. */
const withParts = (parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

const timed = <T,>(work: () => T): { value: T; ms: number } => {
  const started = performance.now()
  const value = work()
  return { value, ms: performance.now() - started }
}

describe('kernel at scale', () => {
  const COUNT = 1000
  const parts = lattice(COUNT)

  it(`commits ${COUNT} parts without per-edit whole-document copies`, () => {
    const engine = new CadEngine(createEmptyDocument())
    const { ms } = timed(() => {
      for (const [index, item] of parts.entries()) {
        const operations: CadOperation[] = [{ type: 'part.add', part: item }]
        engine.execute(`Place ${item.id}`, operations, 'human', index)
      }
    })
    const perEdit = ms / COUNT
    expect(Object.keys(engine.getSnapshot().document.parts)).toHaveLength(COUNT)
    // Structural sharing keeps this roughly flat; deep-cloning the document per
    // edit makes the average grow with model size.
    expect(perEdit).toBeLessThan(BUDGETS.buildPerEditMs)
  }, 30_000)

  it('keeps the incremental connector index in step with a full derivation', () => {
    // The index is an optimization, not a source of truth. If it drifts, the
    // persisted graph silently stops matching the geometry, so the two are
    // compared after a run of adds, moves and removals.
    const engine = new CadEngine(createEmptyParts())
    let revision = engine.getSnapshot().document.revision
    const commit = (label: string, operations: CadOperation[]) => {
      const result = engine.execute(label, operations, 'human', revision)
      if (result.ok) revision = result.value.resultRevision
      return result
    }

    for (const [index, item] of lattice(120).entries()) {
      commit(`add ${index}`, [{ type: 'part.add', part: item }])
    }
    for (const id of ['p5', 'p17', 'p60']) {
      const existing = engine.getSnapshot().document.parts[id]
      commit(`move ${id}`, [
        {
          type: 'part.transform',
          partId: id,
          transform: { position: [existing.transform.position[0], existing.transform.position[1] - 200, existing.transform.position[2]], basis: IDENTITY_BASIS },
        },
      ])
    }
    for (const id of ['p11', 'p12']) commit(`remove ${id}`, [{ type: 'part.remove', partId: id }])
    engine.undo('human')
    engine.redo('human')

    const document = engine.getSnapshot().document
    const persisted = Object.values(document.connections)
      .map((edge) => [`${edge.a.partId}/${edge.a.featureId}`, `${edge.b.partId}/${edge.b.featureId}`].sort().join('|'))
      .sort()
    const derived = deriveConnections(document)
      .pairs.map((pair) => [`${pair.a.partId}/${pair.a.id}`, `${pair.b.partId}/${pair.b.id}`].sort().join('|'))
      .sort()
    expect(persisted).toEqual(derived)
  }, 30_000)

  it('validates a full model within budget', () => {
    const document = withParts(parts)
    const { value, ms } = timed(() => validateDocument(document, { provideGeometry: () => null }))
    expect(value.partCount).toBe(COUNT)
    expect(value.connectionCount).toBeGreaterThan(COUNT / 2)
    expect(ms).toBeLessThan(BUDGETS.fullValidationMs)
  })

  it('revalidates an edit far faster than the full pass', () => {
    const document = withParts(parts)
    const full = validateDocument(document, { provideGeometry: () => null })

    const moved: ModelDocument = {
      ...document,
      parts: { ...document.parts, p0: { ...document.parts.p0, transform: { position: [0, -400, 0], basis: IDENTITY_BASIS } } },
      revision: document.revision + 1,
    }
    const { value, ms } = timed(() =>
      validateDocument(moved, {
        provideGeometry: () => null,
        incremental: { previous: full, touchedPartIds: ['p0'] },
      }),
    )
    expect(ms).toBeLessThan(BUDGETS.incrementalValidationMs)
    expect(value.partCount).toBe(COUNT)
  })

  it('gives the same collisions incrementally as it does from scratch', () => {
    // An optimization that changes answers is a defect, so the two paths are
    // compared directly on a model seeded with deliberate overlaps.
    // Drive four parts into their neighbours before constructing the document.
    const nudge = new Set(['p3', 'p20', 'p150', 'p399'])
    const seeded = lattice(400).map((item) =>
      nudge.has(item.id)
        ? { ...item, transform: { position: [item.transform.position[0] + 6, item.transform.position[1], item.transform.position[2]] as [number, number, number], basis: IDENTITY_BASIS } }
        : item,
    )
    const document = withParts(seeded)
    const baseline = validateDocument(document, { provideGeometry: () => null })
    expect(baseline.collisions.length).toBeGreaterThan(0)

    const touched = ['p7', 'p8']
    const nudged: ModelDocument = {
      ...document,
      parts: {
        ...document.parts,
        p7: { ...document.parts.p7, transform: { position: [document.parts.p7.transform.position[0] + 5, document.parts.p7.transform.position[1], document.parts.p7.transform.position[2]], basis: IDENTITY_BASIS } },
      },
      revision: document.revision + 1,
    }

    const fromScratch = validateDocument(nudged, { provideGeometry: () => null })
    const incrementally = validateDocument(nudged, {
      provideGeometry: () => null,
      incremental: { previous: baseline, touchedPartIds: touched },
    })

    const key = (report: typeof fromScratch) =>
      report.collisions.map((issue) => [issue.partA, issue.partB].sort().join('|')).sort()
    expect(key(incrementally)).toEqual(key(fromScratch))
  })

  it('queries snap candidates against a dense model within budget', () => {
    const moving = part('moving', [20, -12, 20])
    const document = withParts([...parts, moving])
    // Warm the per-revision derivation, as a drag would after the first frame.
    findSnapCandidates(moving, document, moving.transform, { radiusLdu: 14 })
    const { value, ms } = timed(() => findSnapCandidates(moving, document, moving.transform, { radiusLdu: 14 }))
    expect(value.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(BUDGETS.snapQueryMs)
  })

  it('undoes a transaction in time proportional to the edit', () => {
    const engine = new CadEngine(withParts(parts))
    engine.execute('Add one more', [{ type: 'part.add', part: part('extra', [0, -400, 0]) }], 'human', engine.getSnapshot().document.revision)
    const { ms } = timed(() => engine.undo('human'))
    expect(engine.getSnapshot().document.parts.extra).toBeUndefined()
    expect(ms).toBeLessThan(BUDGETS.undoMs)
  })

  it('buckets the broad phase instead of comparing every pair', () => {
    const document = withParts(parts)
    const index = deriveBroadPhase(document)
    // A part in a dense lattice sees a handful of neighbours, not a thousand.
    expect(index.neighbours("p0").length).toBeLessThan(50)
    expect(findCollisions(document).length).toBe(0)
  })
})
