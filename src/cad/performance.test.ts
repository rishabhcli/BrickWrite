import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { deriveBroadPhase, findCollisions } from './collision'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument } from './sample'
import { findSnapCandidates } from './snapping'
import { deriveConnections } from './snapping'
import {
  airbornePartIds,
  floatingPartIds,
  hoverVerdictFor,
  poseRefusal,
  unclutchedRestPartIds,
  validateDocument,
} from './validation'
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
  // Measured ~0.55 ms/commit before the clutch/collision gate; ~3–6 ms with it;
  // ~8 ms once hovering and unclutched-rest are also derived on commit.
  //
  // This cannot be a same-run ratio the way `incrementalFraction` below is. The
  // commit gates are themselves linear in model size — measured here at 0.47
  // ms/edit over 100 parts against 6.1 ms/edit over 1000 — so a whole-document
  // clone and the healthy path grow at the same shape and a growth factor
  // cannot tell them apart. The discriminator really is an absolute cost.
  //
  // So the number is set from both machines rather than one: ~10.3 ms on a busy
  // laptop and 16.2 ms on a GitHub runner are both the healthy path, and 12 ms
  // sat between them, which failed CI on hardware and blocked two deploys. 40 ms
  // clears the slower machine with room and still catches the regression this
  // exists for, which the original note puts "into tens of ms".
  buildPerEditMs: 40,
  fullValidationMs: 900,
  // Incremental revalidation is judged against a full pass measured on the same
  // machine in the same run, not against a millisecond ceiling: an absolute
  // budget measures the runner's hardware as much as the optimization, which is
  // why 60 ms passed locally and failed at 82 ms on a CI runner.
  //
  // The ceiling is loose because only the collision phase is incremental —
  // connectivity, components, bounds and colour evidence still run a full pass
  // — so the achievable saving is bounded, and how much of validation collision
  // accounts for turns out to be machine-dependent: the measured ratio is ~0.45
  // locally but ~0.75 on a CI runner. What the assertion has to separate is a
  // working optimization from a removed one, and removing it entirely measures
  // ~1.05, so 0.85 discriminates on both machines without pretending the ratio
  // is more stable than it is.
  incrementalFraction: 0.85,
  snapQueryMs: 40,
  undoMs: 60,
  // Asking the hovering question about *one* part must not cost what asking it
  // about the whole document costs.
  //
  // A ratio for the same reason `incrementalFraction` is one: an absolute
  // ceiling would measure the runner. Measured ~0.33 with the scoped path and
  // ~1.0 with the three whole-document calls it replaced, so 0.85 separates a
  // working scope from a reverted one on either machine.
  scopedHoverFraction: 0.85,
  // A commit must not derive the connector world for the document it just
  // produced, so it is judged against exactly that: one `deriveConnections`
  // over the same model, in the same run, on the same machine. Deriving is a
  // floor a commit cannot get under, so a commit that pays it lands above 1
  // whatever the hardware. Measured ~0.25 with the incremental path and ~2.2
  // with the derivation back in the collision and clutch gates.
  commitAgainstDerivationFraction: 0.7,
  // The same test for the pose gate, which `firstLegalSnap` and
  // `legalConnectCandidates` run once per snap candidate. Measured ~0.15 with
  // the scoped path and ~1.15 with a derivation per preview document.
  poseGateAgainstDerivationFraction: 0.7,
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

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * The least contaminated sample, for the ratios between two CPU-bound costs.
 *
 * A median resists one outlier. It does not resist a *window*: when the machine
 * is running five other builds, whole runs of samples are inflated together, and
 * these ratios were seen at 1.01 and 1.21 with both sides three- to elevenfold
 * over their real cost. The minimum of each side is bounded below by the real
 * cost of that side and can only be spoiled downwards by a measurement that is
 * impossibly fast, so it is the robust estimator here — while a genuine
 * regression raises the floor and still fails the assertion.
 *
 * The absolute budgets above stay on medians: there, an unusually fast sample
 * would be exactly the wrong thing to judge a ceiling by.
 */
const fastest = (values: number[]): number => Math.min(...values)

describe('kernel at scale', () => {
  const COUNT = 1000
  /** The small sample the full run's per-edit cost is judged against. */
  const SMALL = 100
  const parts = lattice(COUNT)

  it(`commits ${COUNT} parts without per-edit whole-document copies`, () => {
    const perEditOver = (count: number) => {
      const engine = new CadEngine(createEmptyDocument())
      const { ms } = timed(() => {
        for (const [index, item] of parts.slice(0, count).entries()) {
          const operations: CadOperation[] = [{ type: 'part.add', part: item }]
          engine.execute(`Place ${item.id}`, operations, 'human', index)
        }
      })
      return { engine, perEdit: ms / count }
    }

    // Warm the JIT so the measurement is of the kernel, not of compilation.
    perEditOver(SMALL)

    const full = perEditOver(COUNT)
    expect(Object.keys(full.engine.getSnapshot().document.parts)).toHaveLength(COUNT)
    expect(full.perEdit).toBeLessThan(BUDGETS.buildPerEditMs)
  }, 60_000)

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
          transform: { position: [existing.transform.position[0] + 2000, 0, existing.transform.position[2]], basis: IDENTITY_BASIS },
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

  it('keeps the connector index in step when a transaction is refused', () => {
    // A refused commit must leave nothing behind.
    //
    // The index has to be advanced to the *candidate* before the gates run —
    // that is what makes the connection diff incremental — and every gate after
    // that point can still refuse. It used to be advanced and never rolled back,
    // and the damage was silent rather than loud: the next edit's incremental
    // diff mated against connectors at a pose the document does not hold.
    //
    // Reproduced as the second case. Lifting a brick into empty air is refused
    // as DISCONNECTED, which left that brick's connectors 1000 LDU below where
    // it actually is; the brick then stacked onto it found no mates at all, and
    // the document recorded 0 connections where the geometry has 8.
    const engine = new CadEngine(createEmptyParts())
    let revision = engine.getSnapshot().document.revision
    const commit = (label: string, operations: CadOperation[]) => {
      const result = engine.execute(label, operations, 'human', revision)
      if (result.ok) revision = result.value.resultRevision
      return result
    }

    commit('anchor', [{ type: 'part.add', part: part('anchor', [0, 0, 0]) }])
    commit('neighbour', [{ type: 'part.add', part: part('neighbour', [200, 0, 0]) }])

    const refused = commit('lift the anchor into the air', [
      { type: 'part.transform', partId: 'anchor', transform: { position: [0, -1000, 0], basis: IDENTITY_BASIS } },
    ])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('DISCONNECTED')
    expect(engine.getSnapshot().document.parts.anchor.transform.position).toEqual([0, 0, 0])

    const stacked = commit('stack onto the anchor', [{ type: 'part.add', part: part('stack', [0, -8, 0]) }])
    expect(stacked.ok).toBe(true)

    const document = engine.getSnapshot().document
    expect(Object.keys(document.connections).length).toBe(deriveConnections(document).pairs.length)
    expect(Object.keys(document.connections).length).toBeGreaterThan(0)
  })

  it('validates a full model within budget', () => {
    const document = withParts(parts)
    const { value, ms } = timed(() => validateDocument(document, { provideGeometry: () => null }))
    expect(value.partCount).toBe(COUNT)
    expect(value.connectionCount).toBeGreaterThan(COUNT / 2)
    expect(ms).toBeLessThan(BUDGETS.fullValidationMs)
  })

  it('revalidates an edit far faster than the full pass', () => {
    const previous = validateDocument(withParts(parts), { provideGeometry: () => null })
    const moveP0 = (): ModelDocument => {
      const base = withParts(parts)
      return {
        ...base,
        parts: { ...base.parts, p0: { ...base.parts.p0, transform: { position: [0, -400, 0], basis: IDENTITY_BASIS } } },
        revision: base.revision + 1,
      }
    }

    // Documents are built before anything is timed, and each sample gets a fresh
    // one because derived state is memoized on document identity — reusing one
    // would time the memo rather than the work.
    const ROUNDS = 5
    const fullDocuments = Array.from({ length: ROUNDS }, () => withParts(parts))
    const movedDocuments = Array.from({ length: ROUNDS }, moveP0)

    // Median of five per side. A shared runner's scheduling noise can make
    // one sample abnormally fast or slow; the median resists those outliers.
    const fullMs = median(
      fullDocuments.map((document) => timed(() => validateDocument(document, { provideGeometry: () => null })).ms),
    )
    const samples = movedDocuments.map((document) =>
      timed(() =>
        validateDocument(document, {
          provideGeometry: () => null,
          incremental: { previous, touchedPartIds: ['p0'] },
        }),
      ),
    )
    const incrementalMs = median(samples.map((sample) => sample.ms))

    expect(samples[0].value.partCount).toBe(COUNT)
    expect(incrementalMs).toBeLessThan(fullMs * BUDGETS.incrementalFraction)
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

  it('answers the hovering question about one part far faster than about all of them', () => {
    // What the realiser actually asks. It places one part and needs to know
    // whether *that* part is supported; the three whole-document functions
    // computed the answer for every part in the model to tell it, and
    // `airbornePartIds` walked a connected component per part while doing so.
    const one = ['p400']
    const many = Array.from({ length: 20 }, (_, index) => `p${index * 40}`)
    // One set of part instances, many document objects built from it.
    //
    // That is the production shape: `applyMutations` shares every untouched part
    // by reference, so the document a commit or a realiser hands to these
    // functions holds the same `PartInstance` objects the last one did, and the
    // per-part memos hit. Rebuilding the lattice per sample instead made both
    // sides pay a cold 900-part bounds pass, which is shared cost — it pushed the
    // ratio to ~0.7 by inflating the numerator and the denominator equally, and
    // measured the bounds pass rather than the scoping.
    const hoverParts = lattice(900)

    // Warm both paths before either is timed: whichever ran first would
    // otherwise pay for the other's cold start and the ratio would be fiction.
    for (let round = 0; round < 3; round += 1) {
      const warm = withParts(hoverParts)
      floatingPartIds(warm)
      airbornePartIds(warm)
      unclutchedRestPartIds(warm)
      hoverVerdictFor(withParts(hoverParts), one)
    }

    const wholeTimes: number[] = []
    const scopedTimes: number[] = []
    const manyTimes: number[] = []
    for (let round = 0; round < 9; round += 1) {
      // A fresh document per sample, and its connector derivation paid *before*
      // the clock starts.
      //
      // The derivation used to be left cold deliberately, because the realiser
      // misses that memo on every placement. That was the right call while the
      // whole-document trio's dominant cost was `airbornePartIds` walking a
      // connected component per part. It is the wrong call now: the trio no
      // longer does that, the derivation is the only large thing left, and both
      // sides pay exactly one of it — so the ratio measured the shared floor and
      // drifted to 0.95 while the scoping it exists to guard got *better*.
      // Warming it measures the thing being compared.
      const whole = withParts(hoverParts)
      deriveConnections(whole)
      wholeTimes.push(
        timed(() => {
          floatingPartIds(whole)
          airbornePartIds(whole)
          unclutchedRestPartIds(whole)
        }).ms,
      )
      const scopedDocument = withParts(hoverParts)
      deriveConnections(scopedDocument)
      scopedTimes.push(timed(() => hoverVerdictFor(scopedDocument, one)).ms)
      const manyDocument = withParts(hoverParts)
      deriveConnections(manyDocument)
      manyTimes.push(timed(() => hoverVerdictFor(manyDocument, many)).ms)
    }
    const whole = fastest(wholeTimes)
    const scoped = fastest(scopedTimes)
    const many20 = fastest(manyTimes)

    console.log(`HOVER whole=${whole.toFixed(3)} scoped=${scoped.toFixed(3)} many20=${many20.toFixed(3)} ratio=${(scoped/whole).toFixed(3)} many/one=${(many20/scoped).toFixed(2)}`)
    expect(scoped / whole).toBeLessThan(BUDGETS.scopedHoverFraction)
    // Twenty parts must not cost twenty times one: the derivation, the bounds
    // pass and the ground plane are shared, and each island is walked once.
    expect(many20).toBeLessThan(scoped * 2.5)
  })

  it('commits an edit without deriving the connector world for the result', () => {
    // Both commit gates need to know what is mated to what. The collision gate
    // needs mating clearance for the pairs it looks at; the clutch gate needs
    // adjacency. Getting either by deriving the connector world for the document
    // the commit has just produced is the most expensive thing the kernel can
    // do, and that document is microseconds old — the connector index the engine
    // keeps across revisions and the edges the transaction itself recorded
    // answer the same question for the cost of the edit.
    //
    // On the 11,493-part campus demo this was 435 ms of a 520 ms commit before
    // the derivation was made cheaper, and 114 ms of 250 ms after; taking it off
    // the path entirely left 32 ms.
    //
    // Judged against one derivation over the same model, in the same run: it is
    // a floor a commit that derives cannot get under, so such a commit lands
    // above 1 on any hardware, while this one lands well below.
    const engine = new CadEngine(withParts(parts))
    let revision = engine.getSnapshot().document.revision
    const addAt = (index: number) => {
      const item = part(`probe_${index}`, [4000 + (index % 20) * 400, 0, 4000 + Math.floor(index / 20) * 400])
      const result = engine.execute(`probe ${index}`, [{ type: 'part.add', part: item }], 'human', revision)
      expect(result.ok).toBe(true)
      if (result.ok) revision = result.value.resultRevision
    }

    for (let index = 0; index < 3; index += 1) addAt(index)

    // The two sides are interleaved, not measured in two blocks.
    //
    // "Same run" is not enough on a shared runner: a garbage-collection pause or
    // a scheduling stall lands inside whichever block is unlucky, and with five
    // other processes on the machine this ratio was seen at 1.01 with both sides
    // inflated three- to elevenfold. Alternating puts both sides in the same
    // noise window, and `fastest` then reads the floor of each.
    //
    // Each derivation gets a fresh document object built from the part instances
    // the engine holds, so it misses its memo exactly as it would for a document
    // a commit had just produced.
    const commitTimes: number[] = []
    const deriveTimes: number[] = []
    for (let round = 0; round < 9; round += 1) {
      commitTimes.push(timed(() => addAt(3 + round)).ms)
      deriveTimes.push(timed(() => deriveConnections(withParts(parts))).ms)
    }

    expect(fastest(commitTimes)).toBeLessThan(fastest(deriveTimes) * BUDGETS.commitAgainstDerivationFraction)
  }, 60_000)

  it('gates a candidate pose without deriving the connector world for it', () => {
    // `firstLegalSnap` and `legalConnectCandidates` call `poseRefusal` once per
    // snap candidate — up to 24 — and every candidate is a different speculative
    // document. Deriving a connector world for each one made filtering one
    // drag's candidates cost seconds on a large model.
    //
    // Moving one part moves nothing else, so the live document's index is
    // already the right index for every other part, and the same-run derivation
    // below is the floor the per-candidate shape could not get under.
    const document = withParts(parts)
    deriveConnections(document)
    const pose = { position: [0, -400, 0] as [number, number, number], basis: IDENTITY_BASIS }
    poseRefusal(document, 'p500', pose)

    // Interleaved and taken as a median, for the reason the commit guard above
    // spells out: a shared runner's stalls have to land on both sides.
    const gateTimes: number[] = []
    const deriveTimes: number[] = []
    for (let round = 0; round < 9; round += 1) {
      gateTimes.push(timed(() => poseRefusal(document, `p${500 + round}`, pose)).ms)
      deriveTimes.push(timed(() => deriveConnections(withParts(parts))).ms)
    }

    expect(fastest(gateTimes)).toBeLessThan(fastest(deriveTimes) * BUDGETS.poseGateAgainstDerivationFraction)
  }, 30_000)

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
    engine.execute('Add one more', [{ type: 'part.add', part: part('extra', [2000, 0, 0]) }], 'human', engine.getSnapshot().document.revision)
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
