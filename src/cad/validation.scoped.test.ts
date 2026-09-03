import { describe, expect, it } from 'vitest'
import {
  adjacencyFromRecordedEdges,
  adjacencyWithPose,
  airbornePartIds,
  floatingPartIds,
  hoverVerdictFor,
  poseRefusal,
  unclutchedRestCode,
  unclutchedRestPartIds,
  unclutchedRestSupport,
} from './validation'
import { introducedCollisions } from './collisionGate'
import { deriveConnectionEdges } from './snapping'
import { IDENTITY_BASIS } from './math'
import {createEmptyDocument} from './sample'
import { createRoverDocument } from './__fixtures__/rover'
import type { ModelDocument, PartInstance, Transform } from './types'

/**
 * The scoped verdict must be the whole-document answer, restricted.
 *
 * `hoverVerdictFor` exists to make single-part placement cheap, and the only
 * way that is safe is if it cannot disagree with the functions the reports and
 * the UI use. So this does not assert what the scoped function *should* say —
 * it runs both over the same documents and requires them to agree, part by
 * part, on every shape that has ever mattered here: a grounded stack, a brick
 * hanging in the air, a self-clutched island floating beside a grounded one, a
 * brick resting on a tile with nothing to clutch, and a part with no compiled
 * geometry at all.
 */

const part = (
  id: string,
  position: [number, number, number],
  definitionId = '3001',
): PartInstance => ({
  id,
  definitionId,
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const withParts = (...parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((entry) => [entry.id, entry])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((entry) => entry.id) },
    },
  }
}

/** A vertical stack: each brick clutches the one below, the lowest on the ground. */
const stack = (count: number, xOffset = 0): PartInstance[] =>
  Array.from({ length: count }, (_, index) => part(`s${xOffset}_${index}`, [xOffset, -24 * index, 0]))

const CASES: Array<{ name: string; document: ModelDocument }> = [
  { name: 'empty', document: withParts() },
  { name: 'one brick on the ground', document: withParts(...stack(1)) },
  { name: 'a grounded stack', document: withParts(...stack(4)) },
  {
    name: 'a brick hanging in the air',
    document: withParts(...stack(2), part('hover', [200, -200, 200])),
  },
  {
    name: 'a self-clutched island beside a grounded stack',
    document: withParts(
      ...stack(3),
      part('air0', [200, -300, 0]),
      part('air1', [200, -324, 0]),
      part('air2', [200, -348, 0]),
    ),
  },
  {
    name: 'a brick resting on a tile, with nothing to clutch',
    // 3070b is a 1x1 tile: studless, so the brick above it rests unclutched.
    document: withParts(part('tile', [0, 0, 0], '3070b'), part('rests', [0, -8, 0])),
  },
  {
    name: 'a part with no compiled geometry',
    document: withParts(...stack(2), part('unknown', [60, -60, 60], 'not-a-real-part')),
  },
  { name: 'the showcase model', document: createRoverDocument() },
]

describe('the scoped hovering verdict', () => {
  it.each(CASES)('agrees with the whole-document functions on $name', ({ document }) => {
    const ids = Object.keys(document.parts)
    const floating = new Set(floatingPartIds(document))
    const airborne = new Set(airbornePartIds(document))
    const rests = new Set(unclutchedRestPartIds(document))

    // Every part at once, which is the strongest form of the claim.
    const all = hoverVerdictFor(document, ids)
    expect(new Set(all.floating)).toEqual(floating)
    expect(new Set(all.airborne)).toEqual(airborne)
    expect(new Set(all.unclutchedRests.map((entry) => entry.partId))).toEqual(rests)
    for (const entry of all.unclutchedRests) {
      expect(entry.supportId).toBe(unclutchedRestSupport(document, entry.partId))
    }

    // And one part at a time, because the realiser asks that way and a shared
    // component cache must not change the answer.
    for (const id of ids) {
      const one = hoverVerdictFor(document, [id])
      expect(one.floating).toEqual(floating.has(id) ? [id] : [])
      expect(one.airborne).toEqual(airborne.has(id) ? [id] : [])
      expect(one.unclutchedRests.map((entry) => entry.partId)).toEqual(rests.has(id) ? [id] : [])
    }
  })

  it('does not accuse a part whose geometry this build does not carry', () => {
    // The rule all three verdicts now share, pinned rather than left implied by
    // the equality checks above. An unmeasured part has a known position and an
    // unknown extent: it cannot be shown to reach the ground, and reading that
    // absence as "unsupported" would be an assertion about data nobody has.
    // `airbornePartIds` used to do exactly that while `floatingPartIds` excused
    // the same part, and the import report then described a model using elements
    // this pack lacks as a model full of hovering bricks.
    const document = withParts(...stack(2), part('unknown', [400, -400, 400], 'not-a-real-part'))
    expect(floatingPartIds(document)).toEqual([])
    expect(airbornePartIds(document)).toEqual([])
    expect(unclutchedRestPartIds(document)).toEqual([])
    expect(hoverVerdictFor(document, ['unknown'])).toEqual({
      floating: [],
      airborne: [],
      unclutchedRests: [],
    })
  })

  it('still names the measured members of an island that never reaches the ground', () => {
    // Excusing the unmeasurable must not excuse the island. A self-clutched
    // stack in mid-air is still reported, by the parts a viewport can actually
    // highlight.
    const document = withParts(
      ...stack(2),
      part('air0', [400, -400, 0]),
      part('air1', [400, -424, 0]),
      part('ghost', [400, -448, 0], 'not-a-real-part'),
    )
    const airborne = airbornePartIds(document)
    expect(airborne).toContain('air0')
    expect(airborne).toContain('air1')
    expect(airborne).not.toContain('ghost')
  })

  it('asks about nothing when given nothing, without deriving the graph', () => {
    const document = withParts(...stack(3))
    expect(hoverVerdictFor(document, [])).toEqual({ floating: [], airborne: [], unclutchedRests: [] })
  })

  it('ignores an id that is not in the document', () => {
    const document = withParts(...stack(2))
    expect(hoverVerdictFor(document, ['ghost'])).toEqual({ floating: [], airborne: [], unclutchedRests: [] })
  })
})

describe('the recorded connection graph as an adjacency source', () => {
  it.each(CASES)('gives the same hovering verdicts as the derived graph on $name', ({ document }) => {
    // The engine's clutch gate reads adjacency off the document's *recorded*
    // edges instead of re-deriving the connector world, because the transaction
    // that produced the document produced its edges in the same breath. That is
    // only sound if the two cannot disagree, so both are run over the same
    // documents and required to match, rather than the claim being asserted.
    const recorded: ModelDocument = {
      ...document,
      connections: deriveConnectionEdges(document, document.revision, 'snap'),
    }
    const ids = Object.keys(recorded.parts)
    expect(hoverVerdictFor(recorded, ids, adjacencyFromRecordedEdges(recorded))).toEqual(
      hoverVerdictFor(recorded, ids),
    )
  })
})

/**
 * The whole-document reading of the pose question, as `poseRefusal` was written.
 *
 * Kept here on purpose. The scoped version answers with a mate query against the
 * live document's index and an adjacency overlay, never deriving a connector
 * world for the speculative pose, and the only way that is safe is if it cannot
 * disagree with the shape it replaced. So the shape it replaced is the oracle.
 */
function wholeDocumentRefusal(
  document: ModelDocument,
  partId: string,
  transform: Transform,
): 'DISCONNECTED' | 'NO_COMPATIBLE_CONNECTOR' | 'CONNECTOR_OCCUPIED' | 'COLLISION' | null {
  const part = document.parts[partId]
  if (!part) return null
  const preview: ModelDocument = {
    ...document,
    parts: { ...document.parts, [partId]: { ...part, transform } },
  }
  const wasFloating = new Set(floatingPartIds(document))
  if (!wasFloating.has(partId) && floatingPartIds(preview).includes(partId)) return 'DISCONNECTED'
  const wasRest = new Set(unclutchedRestPartIds(document))
  if (!wasRest.has(partId) && unclutchedRestPartIds(preview).includes(partId)) {
    return unclutchedRestCode(preview, partId)
  }
  if (introducedCollisions(document, preview, [partId], { placing: false }).length) return 'COLLISION'
  return null
}

describe('the scoped pose gate', () => {
  const grounded = withParts(...stack(3))
  const tiled = withParts(part('tile', [0, 0, 0], '3070b'), part('loose', [400, 0, 0]))
  const showcase = createRoverDocument()
  const showcaseId = Object.keys(showcase.parts)[0]

  const POSES: Array<{ name: string; document: ModelDocument; partId: string; transform: Transform }> = [
    { name: 'a brick left where it is', document: grounded, partId: 's0_1', transform: grounded.parts.s0_1.transform },
    { name: 'a brick lifted into empty air', document: grounded, partId: 's0_2', transform: { position: [0, -400, 0], basis: IDENTITY_BASIS } },
    { name: 'a brick driven into its neighbour', document: grounded, partId: 's0_2', transform: { position: [0, -6, 0], basis: IDENTITY_BASIS } },
    { name: 'a brick set down on a studless tile', document: tiled, partId: 'loose', transform: { position: [0, -8, 0], basis: IDENTITY_BASIS } },
    { name: 'a brick slid one stud sideways', document: grounded, partId: 's0_2', transform: { position: [20, -48, 0], basis: IDENTITY_BASIS } },
    { name: 'a showcase part lifted away', document: showcase, partId: showcaseId, transform: { position: [900, -900, 900], basis: IDENTITY_BASIS } },
  ]

  it.each(POSES)('agrees with the whole-document gate on $name', ({ document, partId, transform }) => {
    expect(poseRefusal(document, partId, transform)).toBe(wholeDocumentRefusal(document, partId, transform))
  })
})

describe('the pose adjacency overlay', () => {
  /**
   * Both ends, explicitly.
   *
   * The overlay is what lets a speculative pose be judged without copying the
   * adjacency map per snap candidate, and it has to relink in both directions:
   * the moved part gains the partners its new pose implies, and the partners it
   * left behind lose it. Asked about the *partner* here, because the moved
   * part's own entry is replaced wholesale and would look right either way —
   * which is exactly how an overlay that only rewrote one direction passed the
   * gate's own differential tests.
   */
  const base = new Map<string, Set<string>>([
    ['lower', new Set(['middle'])],
    ['middle', new Set(['lower', 'upper'])],
    ['upper', new Set(['middle'])],
    ['island', new Set<string>()],
  ])

  it('drops the moved part from the partners it left', () => {
    const lifted = adjacencyWithPose(base, 'middle', new Set())
    expect(lifted.get('middle')).toEqual(new Set())
    expect(lifted.get('lower')?.has('middle')).toBe(false)
    expect(lifted.get('upper')?.has('middle')).toBe(false)
    // And leaves the rest of the graph alone, by reference where it can.
    expect(lifted.get('island')).toBe(base.get('island'))
  })

  it('adds the moved part to the partners it arrives at', () => {
    const moved = adjacencyWithPose(base, 'middle', new Set(['island']))
    expect(moved.get('middle')).toEqual(new Set(['island']))
    expect(moved.get('island')?.has('middle')).toBe(true)
    expect(moved.get('lower')?.has('middle')).toBe(false)
    expect(moved.has('island')).toBe(true)
  })

  it('leaves a partner untouched when the link survives the move', () => {
    const slid = adjacencyWithPose(base, 'middle', new Set(['lower']))
    expect(slid.get('lower')).toBe(base.get('lower'))
    expect(slid.get('upper')?.has('middle')).toBe(false)
  })
})
