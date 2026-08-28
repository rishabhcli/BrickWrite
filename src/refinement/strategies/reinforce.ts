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

/** Plates this build can lay flat, longest first, plus the bracket for a side tie. */
function bridgeDefinitions(): string[] {
  const ids: string[] = []
  for (const depth of [1, 2]) {
    const library = familyLibrary('plate', depth)
    if (!library) continue
    for (const length of library.lengths) {
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
  const neighbours = Object.keys(document.parts).sort()
  const batches: CadOperation[][] = []
  const combined: CadOperation[] = []
  const usedIds = new Set<string>()

  for (const target of sample(targets, 6, rng)) {
    const source = sourceOf(document, target.partId)
    const targetCentre = centreOf(document, target.partId)
    if (!source || !targetCentre) continue

    // The plane a bridging plate would rest on: the loose part's own stud plane
    // where it has one, otherwise a partner's, so a tile-topped part can still
    // be tied by spanning from the neighbour it should be holding onto.
    const targetPlane = exposedStudPlane(document.parts[target.partId])

    for (const partnerId of neighbours) {
      if (partnerId === target.partId) continue
      const partnerCentre = centreOf(document, partnerId)
      if (!partnerCentre) continue
      const dx = Math.abs(partnerCentre[0] - targetCentre[0]) / STUD_LDU
      const dz = Math.abs(partnerCentre[2] - targetCentre[2]) / STUD_LDU
      if (dx > BRIDGE_REACH_STUDS || dz > BRIDGE_REACH_STUDS) continue
      const partnerPlane = exposedStudPlane(document.parts[partnerId])
      const plane = targetPlane ?? partnerPlane
      if (plane === null || plane === undefined) continue
      if (partnerPlane !== null && Math.abs(partnerPlane - plane) > 1) continue

      const along: 'x' | 'z' = dx >= dz ? 'x' : 'z'
      const basis = along === 'x' ? IDENTITY_BASIS : QUARTER_TURN_BASES[1]
      const midX = (targetCentre[0] + partnerCentre[0]) / 2
      const midZ = (targetCentre[2] + partnerCentre[2]) / 2

      for (const definitionId of definitions) {
        const definition = catalog.get(definitionId)
        if (!definition) continue
        const cursor = {
          position: [midX, originForSurface(definition, plane), midZ] as Vec3,
          basis,
        }
        const snapped = snapOnto(document, definitionId, cursor, [target.partId, partnerId], 2, source.color)
        if (!snapped) continue
        const descriptor = `reinforce|${target.partId}|${partnerId}|${definitionId}`
        const part = makePart(descriptor, definitionId, snapped.transform, source)
        if (usedIds.has(part.id)) continue
        batches.push([{ type: 'part.add', part }])
        usedIds.add(part.id)
        combined.push({ type: 'part.add', part })
        break
      }
      if (usedIds.size >= 8) break
    }
  }

  if (combined.length > 1) batches.push(combined)
  return dedupeBatches(batches)
}
