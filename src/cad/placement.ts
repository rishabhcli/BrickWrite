import { catalog, originForSurface, surfaceAbove } from './catalog'
import { getPartBounds, snapLdu } from './geometry'
import { bestSnapTransform } from './snapping'
import type { ModelDocument, PartInstance, Transform, Vec3 } from './types'

/**
 * Where a part the operator is holding would land.
 *
 * This is kernel work, not viewport work: the viewport only supplies a ray hit,
 * and everything after that — which surface was struck, what the part's own
 * underside plane is, whether a real connector mate exists nearby — is decided
 * from the catalog and the document. Keeping it here means the answer the ghost
 * shows is produced by the same code that would produce the committed pose, and
 * that it can be tested without a GL context.
 */

/** Bases for the four quarter turns about the vertical axis, in LDraw's frame. */
export const QUARTER_TURN_BASES: readonly Transform['basis'][] = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
  [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
]

export const rotatedBasis = (quarterTurns: number): Transform['basis'] =>
  QUARTER_TURN_BASES[((Math.trunc(quarterTurns) % 4) + 4) % 4]

export interface PlacementRequest {
  readonly definitionId: string
  readonly color: number
  /** Quarter turns applied by the operator while the ghost follows the cursor. */
  readonly quarterTurns: number
}

export interface PlacementHit {
  /** Ray intersection in document coordinates. */
  readonly point: Vec3
  /** The part struck, or null when the ray reached the ground plane. */
  readonly partId: string | null
}

export interface ResolvedPlacement {
  readonly transform: Transform
  /** True when a connector mate was solved rather than falling back to the grid. */
  readonly mated: boolean
  /** Document-space height the part was rested on. */
  readonly surfaceY: number
}

/**
 * Resolves the pose for a placement, preferring a real connector mate.
 *
 * The cursor pose rests the part's own underside plane on whatever surface the
 * ray struck — the target's exposed stud plane where it has one, its measured
 * top face where it does not, the ground otherwise. That pose is then offered to
 * the 6-DOF solver, so a slope, a bracket or a sideways stud lands the way the
 * physical part would rather than on a nominal grid.
 */
export function resolvePlacement(
  request: PlacementRequest,
  model: ModelDocument,
  hit: PlacementHit,
  gridLdu: number,
): ResolvedPlacement | null {
  const definition = catalog.get(request.definitionId)
  if (!definition) return null

  let surfaceY = 0
  const target = hit.partId ? model.parts[hit.partId] : undefined
  if (target) {
    const targetDefinition = catalog.get(target.definitionId)
    const studs = surfaceAbove(targetDefinition, target.transform.position[1])
    // LDraw is Y-down, so the top of a part is its minimum Y.
    surfaceY = studs ?? getPartBounds(target).min[1]
  }

  const cursor: Transform = {
    position: [snapLdu(hit.point[0], gridLdu), originForSurface(definition, surfaceY), snapLdu(hit.point[2], gridLdu)],
    basis: rotatedBasis(request.quarterTurns),
  }
  const candidate: PartInstance = {
    id: '__placement__',
    definitionId: definition.canonicalId,
    color: request.color,
    transform: cursor,
    subassemblyId: '',
    stepId: '',
    provenance: 'human',
    protected: false,
  }
  const snapped = bestSnapTransform(candidate, model, cursor, { radiusLdu: Math.max(8, gridLdu) })
  return { transform: snapped ?? cursor, mated: snapped !== null, surfaceY }
}
