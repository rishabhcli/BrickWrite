import { catalog, originForSurface } from '../../cad/catalog'
import type { CadOperation, ModelDocument, PartDefinition, Vec3 } from '../../cad/types'
import { mutablePartIds } from '../analyse'
import { freeStudsOf } from '../cache'
import { IDENTITY_BASIS } from '../../cad/math'
import { QUARTER_TURN_BASES } from '../../cad/placement'
import type { RefinementScope } from '../types'
import { dedupeBatches, makePart, sample, snapOnto, sourceOf, type Rng } from './support'

/**
 * Finish a surface without redrawing it.
 *
 * A bare stud field is what an unfinished model looks like: real sets tile a
 * deck, grille an intake and cap a wall, and the difference is entirely surface.
 * The constraint that makes this hard is that detail must not become shape — a
 * greebled hull that grew two plates is a different model, not a finished one.
 *
 * So this strategy only ever *adds onto existing free studs*, chosen from the
 * connector graph so a stud already carrying something is never offered, and the
 * silhouette guard above it rejects any batch whose outline drifts past the
 * request's tolerance. The elements are ordinary tiles and grilles, ranked by how
 * often they actually appear in sets, so finishing a surface does not quietly
 * introduce a part nobody owns.
 */

/** Flat elements that finish a surface: no stud plane of their own. */
function surfaceElements(): PartDefinition[] {
  return catalog
    .placeable()
    .filter((definition) => {
      if (definition.helper) return false
      if (!/^Tile/.test(definition.category)) return false
      const families = new Set(definition.connectors.map((feature) => feature.family))
      return families.has('anti-stud') && !families.has('stud')
    })
    .sort((a, b) => b.frequency - a.frequency || a.canonicalId.localeCompare(b.canonicalId))
}

export const detail = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const studs = freeStudsOf(document).filter((stud) => scope.partIdSet.has(stud.partId))
  if (studs.length < 2) return []

  const elements = surfaceElements()
  if (!elements.length) return []

  // Grouped by the plane they sit on, so one batch finishes one surface rather
  // than scattering tiles across three different levels of the model.
  const byPlane = new Map<number, typeof studs>()
  for (const stud of studs) {
    const key = Math.round(stud.surfaceY)
    const bucket = byPlane.get(key)
    if (bucket) bucket.push(stud)
    else byPlane.set(key, [stud])
  }

  const batches: CadOperation[][] = []

  for (const [plane, planeStuds] of [...byPlane.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...planeStuds].sort(
      (a, b) => a.atLdu[0] - b.atLdu[0] || a.atLdu[2] - b.atLdu[2] || a.partId.localeCompare(b.partId),
    )
    for (const element of elements.slice(0, 3)) {
      const operations: CadOperation[] = []
      const claimed = new Set<string>()
      let working = document
      for (const stud of ordered) {
        if (claimed.has(`${Math.round(stud.atLdu[0])}:${Math.round(stud.atLdu[2])}`)) continue
        if (!mutable.has(stud.partId) && !scope.partIdSet.has(stud.partId)) continue
        const source = sourceOf(document, stud.partId)
        if (!source) continue
        for (const basis of [IDENTITY_BASIS, QUARTER_TURN_BASES[1]]) {
          const cursor = {
            position: [stud.atLdu[0], originForSurface(element, plane), stud.atLdu[2]] as Vec3,
            basis,
          }
          const snapped = snapOnto(working, element.canonicalId, cursor, [stud.partId], 1, source.color)
          if (!snapped) continue
          const part = makePart(
            `detail|${element.canonicalId}|${stud.partId}|${stud.featureId}`,
            element.canonicalId,
            snapped.transform,
            source,
          )
          operations.push({ type: 'part.add', part })
          // The working document grows as tiles are placed, so the solver sees
          // the studs already claimed and never stacks two tiles on one stud.
          working = { ...working, parts: { ...working.parts, [part.id]: part } }
          for (const covered of snapped.matchedPartIds) void covered
          claimed.add(`${Math.round(stud.atLdu[0])}:${Math.round(stud.atLdu[2])}`)
          break
        }
        if (operations.length >= 24) break
      }
      if (operations.length) batches.push(operations)
    }
  }

  return dedupeBatches(sample(batches, 6, rng))
}
