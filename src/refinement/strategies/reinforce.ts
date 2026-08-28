import { familyLibrary } from '../../cad/assembly'
import { catalog, originForSurface, STUD_LDU } from '../../cad/catalog'
import { getPartBounds } from '../../cad/geometry'
import { IDENTITY_BASIS } from '../../cad/math'
import { QUARTER_TURN_BASES } from '../../cad/placement'
import type { CadOperation, ModelDocument, Vec3 } from '../../cad/types'
import { mutablePartIds } from '../analyse'
import { staticsOf, weakAttachmentsOf } from '../cache'
import { exposedStudPlane } from '../topology'
import type { RefinementScope } from '../types'
import { dedupeBatches, makePart, sample, snapOnto, sourceOf, type Rng } from './support'

/**
 * Tie a loose part back into the model.
 *
 * Three defects share one repair. A part held by a single connection pivots off.
 * A cluster hanging from fewer studs than its mass needs comes away. A part the
 * load path never reaches is floating. In every case what is missing is a second
 * anchor, and the element that supplies it is an ordinary plate laid across the
 * part and its neighbour.
 *
 * The bridge is not computed arithmetically. A cursor pose is offered to the
 * kernel's snap solver, and a candidate is kept only when the solver reports that
 * the resulting pose mates with *at least two distinct parts*, one of them the
 * loose one. That is the definition of bridging, measured rather than assumed —
 * and a bridge the solver cannot find is simply not offered, instead of being
 * placed hopefully and left for validation to reject.
 */

/** How far apart two parts can be and still share one bridging element, in studs. */
const BRIDGE_REACH_STUDS = 7

/**
 * Search bounds.
 *
 * The solver call is the expensive part — a connector query plus a mating
 * enumeration per candidate pose — so the loop is bounded on all three axes
 * rather than left to explore a model. Four loose parts, their three nearest
 * neighbours and the five smallest bridging elements is 60 solver calls in the
 * worst case, which is milliseconds; the unbounded version was seconds.
 */
const MAX_TARGETS = 4
const MAX_PARTNERS = 3
const MAX_DEFINITIONS = 5

const centreOf = (document: ModelDocument, partId: string): Vec3 | null => {
  const part = document.parts[partId]
  if (!part) return null
  const bounds = getPartBounds(part)
  if (!bounds.measured) return null
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
}

/**
 * Plates this build can lay flat, **shortest first**, plus a bracket.
 *
 * The order is the whole point. A 1 × 8 plate laid over a loose 1 × 1 brick does
 * tie it in, and it also puts a new eight-stud roof on the model — a silhouette
 * change nobody asked for, which the outline guard then correctly refuses. The
 * smallest element that reaches both parts is the repair a builder would make,
 * so it is the one offered first.
 */
function bridgeDefinitions(): string[] {
  const ids: string[] = []
  for (const depth of [1, 2]) {
    const library = familyLibrary('plate', depth)
    if (!library) continue
    for (const length of [...library.lengths].sort((a, b) => a - b)) {
      const definition = library.definitionFor(length)
      if (definition) ids.push(definition.canonicalId)
    }
  }
  // A bracket ties across a *face* rather than along a plane, which is the only
  // repair available when the loose part has nothing above it to span to.
  if (catalog.get('99781')) ids.push('99781')
  return [...new Set(ids)]
}

interface Target {
  readonly partId: string
  readonly reason: string
}

function targetsOf(document: ModelDocument, mutable: ReadonlySet<string>, scope: RefinementScope): Target[] {
  const targets: Target[] = []
  const seen = new Set<string>()
  const add = (partId: string, reason: string) => {
    if (seen.has(partId) || !mutable.has(partId)) return
    seen.add(partId)
    targets.push({ partId, reason })
  }
  for (const weak of weakAttachmentsOf(document)) {
    if (scope.partIdSet.has(weak.partId)) add(weak.partId, 'single connection')
  }
  const statics = staticsOf(document)
  for (const overhang of statics.overloaded) {
    for (const partId of overhang.partIds) {
      if (scope.partIdSet.has(partId)) add(partId, 'overloaded overhang')
    }
  }
  for (const partId of statics.unsupportedPartIds) {
    if (scope.partIdSet.has(partId)) add(partId, 'no load path to the ground')
  }
  return targets.sort((a, b) => a.partId.localeCompare(b.partId))
}

export const reinforce = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const targets = targetsOf(document, mutable, scope)
  if (!targets.length) return []

  const definitions = bridgeDefinitions()
  const batches: CadOperation[][] = []
  const combined: CadOperation[] = []
  const placed = new Set<string>()

  for (const target of sample(targets, MAX_TARGETS, rng)) {
    const source = sourceOf(document, target.partId)
    const targetCentre = centreOf(document, target.partId)
    if (!source || !targetCentre) continue
    const targetPlane = exposedStudPlane(document.parts[target.partId])

    // Nearest first: the closest neighbour on the same plane is the one a plate
    // can actually reach, and searching the whole model for each loose part is
    // what made this generator cost seconds rather than milliseconds.
    const partners = Object.keys(document.parts)
      .filter((partnerId) => partnerId !== target.partId)
      .map((partnerId) => ({ partnerId, centre: centreOf(document, partnerId) }))
      .filter((entry): entry is { partnerId: string; centre: Vec3 } => Boolean(entry.centre))
      .map((entry) => ({
        ...entry,
        dx: Math.abs(entry.centre[0] - targetCentre[0]) / STUD_LDU,
        dz: Math.abs(entry.centre[2] - targetCentre[2]) / STUD_LDU,
      }))
      .filter((entry) => entry.dx <= BRIDGE_REACH_STUDS && entry.dz <= BRIDGE_REACH_STUDS)
      .sort((a, b) => a.dx + a.dz - (b.dx + b.dz) || a.partnerId.localeCompare(b.partnerId))
      .slice(0, MAX_PARTNERS)

    let bridged = false
    for (const partner of partners) {
      if (bridged) break
      const partnerPlane = exposedStudPlane(document.parts[partner.partnerId])
      const plane = targetPlane ?? partnerPlane
      if (plane === null) continue
      if (partnerPlane !== null && Math.abs(partnerPlane - plane) > 1) continue

      const along: 'x' | 'z' = partner.dx >= partner.dz ? 'x' : 'z'
      const basis = along === 'x' ? IDENTITY_BASIS : QUARTER_TURN_BASES[1]
      const midX = (targetCentre[0] + partner.centre[0]) / 2
      const midZ = (targetCentre[2] + partner.centre[2]) / 2

      for (const definitionId of definitions.slice(0, MAX_DEFINITIONS)) {
        const definition = catalog.get(definitionId)
        if (!definition) continue
        const cursor = {
          position: [midX, originForSurface(definition, plane), midZ] as Vec3,
          basis,
        }
        const snapped = snapOnto(document, definitionId, cursor, [target.partId, partner.partnerId], 2, source.color)
        if (!snapped) continue
        const part = makePart(
          `reinforce|${target.partId}|${partner.partnerId}|${definitionId}`,
          definitionId,
          snapped.transform,
          source,
        )
        if (placed.has(part.id)) continue
        placed.add(part.id)
        batches.push([{ type: 'part.add', part }])
        combined.push({ type: 'part.add', part })
        bridged = true
        break
      }
    }
  }

  // One transaction that ties everything loose at once. It frequently collides
  // with itself when several repairs want the same studs, and is rejected then —
  // which is why the single-bridge batches above are offered as well.
  if (combined.length > 1) batches.push(combined)
  return dedupeBatches(batches)
}
