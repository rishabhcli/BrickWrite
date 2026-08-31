import { describe, expect, it, vi } from 'vitest'
import { realizeGraph } from './realize'
import { compileBriefDeterministically } from './brief'
import { runPipelineSync } from './phases'
import { createBlankDocument } from '../cad/sample'
import { deriveConnections } from '../cad/snapping'
import { findCollisions } from '../cad/collision'
import { hoverVerdictFor } from '../cad/validation'
import type { BuildGraph } from './graph'
import type { ModelDocument } from '../cad/types'

/**
 * The cheap answer has to be the same answer.
 *
 * The realiser keeps its own connector index, synced only for the parts that
 * just landed, and feeds it to the collision check, the hovering verdict, the
 * host-connector search and the did-it-reach-its-host walk, so none of them
 * re-derives the whole document per placement. Measured, that took a
 * detail-heavy candidate from 9.2 s to 1.8 s — and it is worth nothing if the
 * maintained state can drift, because drift here would not crash. It would
 * quietly change which generated models are accepted.
 *
 * So these tests mostly do not inspect the incremental structures. They realise
 * real models and require the finished document to give identical answers
 * whether the adjacency and mates are supplied or derived from scratch.
 *
 * One of them does count. A cheap path that nothing pins is a cheap path that
 * gets quietly re-broken: the memo this all exists to stop missing is keyed on
 * document *object identity*, so any new gate that takes the document instead of
 * the maintained state reintroduces the whole cost without changing a single
 * answer, and no correctness test would notice. Hence
 * `deriveConnections` is wrapped and its calls counted.
 */

/** Part counts of every document a whole-document derivation was asked about. */
const derivations = vi.hoisted(() => [] as number[])

vi.mock('../cad/snapping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cad/snapping')>()
  return {
    ...actual,
    deriveConnections: (document: ModelDocument) => {
      derivations.push(Object.keys(document.parts).length)
      return actual.deriveConnections(document)
    },
  }
})

const adjacencyOf = (document: ModelDocument): Map<string, Set<string>> => {
  const edges = new Map<string, Set<string>>(Object.keys(document.parts).map((id) => [id, new Set<string>()]))
  for (const pair of deriveConnections(document).pairs) {
    edges.get(pair.a.partId)?.add(pair.b.partId)
    edges.get(pair.b.partId)?.add(pair.a.partId)
  }
  return edges
}

const BRIEFS = [
  'a two storey red brick farmhouse 14 x 12 studs with a grey roof, windows and a door, under 700 pieces',
  'a grey tower 10 x 10 studs, 24 studs tall, under 500 pieces',
  'a tan shop 20 x 14 studs with a door, six windows, shutters and a clock, under 1200 pieces',
]

describe('the realiser’s maintained connector state', () => {
  // Each case realises a real model, which is seconds of work, not the 5 s
  // vitest allows by default. The archetype eval already sets its own allowance
  // for the same reason; without it these pass alone and time out whenever the
  // worker pool is busy, which is the worst kind of test.
  it.each(BRIEFS)('gives the same verdict supplied as derived: %s', { timeout: 60_000 }, (text) => {
    const brief = compileBriefDeterministically(text)
    const candidate = runPipelineSync(brief, { seed: 5, base: createBlankDocument('inc') })
    const document = candidate.document
    const ids = Object.keys(document.parts)
    expect(ids.length).toBeGreaterThan(20)

    const derived = adjacencyOf(document)
    const supplied = hoverVerdictFor(document, ids, derived)
    const fromScratch = hoverVerdictFor(document, ids)
    expect(supplied.floating).toEqual(fromScratch.floating)
    expect(supplied.airborne).toEqual(fromScratch.airborne)
    expect(supplied.unclutchedRests).toEqual(fromScratch.unclutchedRests)
  })

  it.each(BRIEFS)('finds the same collisions from supplied mates: %s', { timeout: 60_000 }, (text) => {
    const brief = compileBriefDeterministically(text)
    const candidate = runPipelineSync(brief, { seed: 5, base: createBlankDocument('inc') })
    const document = candidate.document
    const world = deriveConnections(document)

    // A complete mates map for the whole document must reproduce the derived
    // verdict exactly. This is the property `CollisionOptions.mates` promises,
    // and the one that would silently turn every mated stud overlap into a
    // reported intersection if the map were built wrong.
    const supplied = findCollisions(document, { mates: world.pairsByParts })
    const derived = findCollisions(document)
    expect(supplied).toEqual(derived)
  })

  it('is deterministic across two independent realisers', { timeout: 60_000 }, () => {
    // Each run maintains its own index. If the maintained state depended on
    // history in a way the committed document does not capture, two runs of the
    // same brief and seed would diverge.
    const brief = compileBriefDeterministically(
      'a red brick shop 12 x 10 studs with a door and two windows, under 400 pieces',
    )
    const first = runPipelineSync(brief, { seed: 9, base: createBlankDocument('a') })
    const second = runPipelineSync(brief, { seed: 9, base: createBlankDocument('a') })
    expect(second.realize.operations.length).toBeGreaterThan(20)
    expect(second.realize.operations.length).toBe(first.realize.operations.length)
    expect(JSON.stringify(second.realize.operations)).toBe(JSON.stringify(first.realize.operations))
    expect(second.structuralHash).toBe(first.structuralHash)
  })

  it('keeps a bulk region’s own bond, which the committed index cannot see', { timeout: 60_000 }, () => {
    // A region's parts mate with each other, and those mates are not in the
    // committed index while the region is still a candidate. The realiser
    // supplies them from a second index holding only the parts that just landed.
    // If it did not — if it overlaid the committed index alone — a properly
    // bonded wall would have its own stud overlaps reported as collisions and be
    // thrown away, so a brief that is almost entirely bulk fill is the case that
    // would fail.
    const brief = compileBriefDeterministically('a tan wall 24 studs long and 8 courses tall, under 300 pieces')
    const candidate = runPipelineSync(brief, { seed: 4, base: createBlankDocument('wall') })
    expect(candidate.metrics.partCount).toBeGreaterThan(40)
    expect(candidate.metrics.collisionCount).toBe(0)
    const ids = Object.keys(candidate.document.parts)
    expect(hoverVerdictFor(candidate.document, ids).floating).toEqual([])
    expect(hoverVerdictFor(candidate.document, ids).airborne).toEqual([])
  })

  /**
   * What a placement is allowed to cost.
   *
   * Every other test here asks whether the cheap path gives the right answer.
   * This one asks whether the cheap path is still being taken, and it exists
   * because the answer to the first question is *yes either way*. The memo on
   * `deriveConnections` is keyed on document object identity; the realiser makes
   * a fresh candidate document per attempt, so it misses that memo every time.
   * A gate that takes the document instead of the maintained state therefore
   * reintroduces a whole-model derivation per attempt, returns exactly the same
   * verdict, and no correctness test in this file would move.
   *
   * That is not hypothetical. It has now happened three times over — the
   * collision check, the hovering verdict, the host-connector search and the
   * did-it-reach-its-host walk each derived the whole model per attempt, and
   * each was found by profiling rather than by a failing test. Measured on these
   * three briefs before the gates were fed from the maintained state: 239
   * derivations covering 29,080 part-visits for the shop alone, against 5 and
   * 1,440 after.
   *
   * So the bound is on work, not on time: a count and a part-visit total are
   * exact integers that do not care how loaded the machine is, which a
   * millisecond budget could not claim.
   */
  it.each(BRIEFS)('does not re-derive the whole model per placement: %s', { timeout: 60_000 }, (text) => {
    const brief = compileBriefDeterministically(text)
    derivations.length = 0
    const candidate = runPipelineSync(brief, { seed: 5, base: createBlankDocument('cost') })
    const parts = candidate.metrics.partCount
    expect(parts).toBeGreaterThan(20)

    // A constant, not a function of how many placements were attempted. The
    // survivors are the empty base in the constructor and the scorer's passes
    // over the finished document, which share one memoized derivation.
    expect(derivations.length).toBeLessThanOrEqual(12)

    // And the whole-model passes that do survive are over the finished model a
    // handful of times, not over a growing model hundreds of times. Stated
    // against the model's own size so it scales with the brief.
    const visited = derivations.reduce((total, count) => total + count, 0)
    expect(visited).toBeLessThanOrEqual(parts * 8)
  })

  /**
   * A stud that is already carrying something is not offered again.
   *
   * The host-connector search reads occupancy out of state the realiser
   * maintains on commit, because deriving it meant deriving the whole model's
   * connections to answer a question about one node's studs. The saving is only
   * legitimate while the maintained set says what the derivation would have
   * said, and a set that quietly stops being filled produces *valid* models —
   * different ones. Every other test in this file passed with occupancy
   * recording removed entirely; only the operations changed, which is the
   * failure mode nobody notices.
   *
   * So this asserts the claim `hostConnectors` actually makes: an occupied
   * connector is removed before the first attempt, not left for the solver to
   * trip over. Two parts asking for "stud index 0" of the same deck must both
   * land on their *primary* attempt, on different studs. With occupancy missing,
   * the second is aimed at the stud the first is already on, collides, and only
   * reaches a free stud through repair — so the tell is `attempts`, not validity.
   */
  it('never offers a host connector that already carries a part', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'occupancy',
      nodes: [
        {
          id: 'deck',
          kind: 'region',
          colour: 71,
          role: 'base',
          anchorLdu: [0, 0, 0],
          region: { shape: 'field', widthStuds: 8, depthStuds: 4, courses: 1, family: 'plate' },
        },
        // 1 x 1, so two of them on neighbouring studs are not a collision. The
        // test would otherwise pass for the wrong reason: any adjacent stud would
        // fail too, and repair would look indistinguishable from correctness.
        { id: 'first', kind: 'part', colour: 4, role: 'detail', part: { query: 'plate 1 x 1' } },
        { id: 'second', kind: 'part', colour: 4, role: 'detail', part: { query: 'plate 1 x 1' } },
      ],
      edges: (['first', 'second'] as const).map((to) => ({
        id: `e_${to}`,
        from: 'deck',
        to,
        // Both name the same stud. The first takes it; the second must be handed
        // a different one because the first's mate is on the record.
        fromConnector: { family: 'stud' as const, pick: { kind: 'index' as const, index: 0 } },
        toConnector: { family: 'anti-stud' as const, pick: { kind: 'index' as const, index: 0 } },
        family: 'stud' as const,
      })),
    }

    const result = realizeGraph(graph, createBlankDocument('occupancy'), { seed: 1 })
    expect(result.graphViolations).toEqual([])

    const attachments = result.edges.filter((edge) => edge.edgeId.startsWith('e_'))
    expect(attachments).toHaveLength(2)
    expect(attachments.map((edge) => edge.status)).toEqual(['realized', 'realized'])
    // One attempt each: the second was aimed at a free stud from the outset.
    expect(attachments.map((edge) => edge.attempts)).toEqual([1, 1])
    // And at genuinely different studs, not the same one twice.
    const hosts = attachments.map((edge) => edge.hostConnector)
    expect(hosts.every((handle) => typeof handle === 'string')).toBe(true)
    expect(new Set(hosts).size).toBe(2)
  })

  it('starts from a base document that already has parts', () => {
    const graph: BuildGraph = { version: 1, strategy: 'empty', nodes: [], edges: [] }
    const result = realizeGraph(graph, createBlankDocument('seeded'), { seed: 1 })
    expect(result.operations).toEqual([])
    expect(result.graphViolations).toEqual([])
  })
})
