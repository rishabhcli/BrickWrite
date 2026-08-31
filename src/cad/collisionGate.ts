import { findCollisions, type CollisionContact } from './collision'
import { deriveConnections, type MatedPair } from './snapping'
import type { ModelDocument, PartInstance } from './types'

const collisionPairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * Contacts an edit would newly introduce.
 *
 * Unverified (`unknown`) box overlaps are not all equal. A newly placed brick
 * inside another brick is refused even without triangle confirmation — that is
 * the agent inventing XYZ. Two hinge halves that already mate are allowed to
 * keep an unverified overlap, because their fingers interleave and blocking on
 * the box would freeze the joint. An unconnected brick slid into another brick
 * is the first case, not the second.
 *
 * Lives beside `collision.ts` rather than inside it: the detector must not
 * import policy, and the engine/placement/validation importers of this module
 * must not create a cycle through `findCollisions`.
 */
export function introducedCollisions(
  before: ModelDocument,
  after: ModelDocument,
  touchedPartIds: readonly string[],
  options: {
    placing?: boolean
    /**
     * Mated pairs for the pairs each scoped check will look at, on the terms
     * `CollisionOptions.mates` sets out — complete for those pairs, or omitted.
     *
     * A caller that maintains a connector index across revisions has these for
     * the cost of the edit; without them each side re-derives the whole
     * connector world, which on the 11,493-part campus demo is 114 ms of the
     * ~250 ms an edit used to take.
     */
    beforeMates?: ReadonlyMap<string, readonly MatedPair[]>
    afterMates?: ReadonlyMap<string, readonly MatedPair[]>
  } = {},
): CollisionContact[] {
  const placing = Boolean(options.placing)
  const existingTouched = touchedPartIds.filter((id) => before.parts[id])
  const afterHits = findCollisions(after, { onlyPartIds: touchedPartIds, mates: options.afterMates })
  const beforeHits = existingTouched.length
    ? findCollisions(before, { onlyPartIds: existingTouched, mates: options.beforeMates })
    : []
  const beforeKeys = new Set(beforeHits.map((contact) => collisionPairKey(contact.partA, contact.partB)))
  const bulk = touchedPartIds.length > 1
  let afterWorld: ReturnType<typeof deriveConnections> | undefined
  return afterHits.filter((contact) => {
    if (beforeKeys.has(collisionPairKey(contact.partA, contact.partB))) return false
    if (contact.certainty === 'unknown' && !placing) {
      // A hinge flap, a wall, or any multi-part motion is allowed to keep an
      // unverified box overlap — blocking those freezes legal mechanisms.
      // A single brick slid into another building is not that case.
      if (bulk) return false
      if (shareConnectionComponent(before, contact.partA, contact.partB)) return false
      afterWorld ??= deriveConnections(after)
      if (afterWorld.pairsByParts.has([contact.partA, contact.partB].sort().join('|'))) return false
    }
    return true
  })
}

function shareConnectionComponent(document: ModelDocument, a: string, b: string): boolean {
  if (a === b) return true
  const adjacency = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    const bucket = adjacency.get(from)
    if (bucket) bucket.add(to)
    else adjacency.set(from, new Set([to]))
  }
  for (const pair of deriveConnections(document).pairs) {
    link(pair.a.partId, pair.b.partId)
    link(pair.b.partId, pair.a.partId)
  }
  for (const edge of Object.values(document.connections)) {
    link(edge.a.partId, edge.b.partId)
    link(edge.b.partId, edge.a.partId)
  }
  const seen = new Set([a])
  const queue = [a]
  while (queue.length) {
    const current = queue.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      if (next === b) return true
      seen.add(next)
      queue.push(next)
    }
  }
  return false
}

/** Whether seating `part` at its current transform would newly collide. */
export function partPoseCollides(document: ModelDocument, part: PartInstance): boolean {
  const placing = !document.parts[part.id]
  const after: ModelDocument = {
    ...document,
    parts: { ...document.parts, [part.id]: part },
  }
  return introducedCollisions(document, after, [part.id], { placing }).length > 0
}
