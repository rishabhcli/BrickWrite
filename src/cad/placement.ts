import { catalog, originForSurface, STUD_LDU, surfaceAbove } from './catalog'
import { partPoseCollides } from './collisionGate'
import { getDocumentBounds, getPartBounds, snapLdu } from './geometry'
import { multiplyMat3 } from './math'
import { approachOccupancy, findSnapCandidates, type SnapCandidate, type SnapSolverOptions } from './snapping'
import type { Bounds, ModelDocument, PartInstance, Transform, Vec3 } from './types'
import { poseRefusal } from './validation'

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
  /** Reuse an existing part's full orientation, not only its yaw. */
  readonly basis?: Transform['basis']
  /** A reseat previews without deleting or cloning the original part. */
  readonly movingPartId?: string
}

export interface PlacementHit {
  /** Ray intersection in document coordinates. */
  readonly point: Vec3
  /** The part struck, or null when the ray reached the ground plane. */
  readonly partId: string | null
}

export type PlacementReason = 'mated' | 'ground' | 'occupied' | 'absent' | 'incompatible' | 'collision'

export type PlacementFace = 'on-top' | 'underneath' | 'beside-x' | 'beside-minus-x' | 'beside-z' | 'beside-minus-z'

const CONNECT_FACES: readonly PlacementFace[] = [
  'on-top',
  'underneath',
  'beside-x',
  'beside-minus-x',
  'beside-z',
  'beside-minus-z',
]

export interface ResolvedPlacement {
  readonly transform: Transform
  /** True when a connector mate was solved rather than falling back to the grid. */
  readonly mated: boolean
  /**
   * Whether this pose can be committed.
   *
   * Ground rests are legal without a mate. Resting on another part without a
   * clutch is not — that is a brick on a tile, and it will slide. A snap that
   * pulls the part onto the opposite face of the hit (under a tile you clicked
   * the top of) is also refused. A mate that would interpenetrate another
   * unconnected part is refused unless a later candidate on the same target
   * seats cleanly.
   */
  readonly legal: boolean
  /** Why the pose is legal or not, so the viewport can toast the right refusal. */
  readonly reason: PlacementReason
  /** Document-space height the part was rested on. */
  readonly surfaceY: number
}

export interface MateSearchResult {
  readonly transform: Transform | null
  /** True when at least one approach-matching candidate existed but every one collided. */
  readonly blockedByCollision: boolean
}

/**
 * Mate search restricted to one part, widened to its footprint so remaining
 * free studs on the far end of a plate are still found. Colliding poses are
 * skipped so a click on an occupied end can still land on free studs beside it.
 */
export function searchMateOnTarget(
  candidate: PartInstance,
  document: ModelDocument,
  target: PartInstance,
  cursor: Transform,
  approach: string | null,
  minRadius: number,
): MateSearchResult {
  let blockedByCollision = false
  const tryRadius = (radius: number): Transform | null => {
    const candidates = findSnapCandidates(candidate, document, cursor, {
      radiusLdu: radius,
      targetPartIds: [target.id],
    })
    for (const entry of candidates) {
      const seated: PartInstance = { ...candidate, transform: entry.transform }
      if (approach && !poseMatchesApproach(seated, target, approach)) continue
      if (partPoseCollides(document, seated)) {
        blockedByCollision = true
        continue
      }
      return entry.transform
    }
    return null
  }
  const close = tryRadius(minRadius)
  if (close) return { transform: close, blockedByCollision: false }
  const box = getPartBounds(target)
  const span = Math.hypot(box.size[0], box.size[1], box.size[2])
  if (span > minRadius) {
    const wide = tryRadius(span + minRadius)
    if (wide) return { transform: wide, blockedByCollision: false }
  }
  return { transform: null, blockedByCollision }
}

/**
 * Closest AABB face to a hit point. Ties prefer the top, because a click on a
 * brick's upper corner almost always means "stack on this".
 */
export function hitApproach(point: Vec3, box: Bounds): PlacementFace {
  const faces: Array<{ approach: PlacementFace; d: number }> = [
    { approach: 'on-top', d: Math.abs(point[1] - box.min[1]) },
    { approach: 'underneath', d: Math.abs(point[1] - box.max[1]) },
    { approach: 'beside-x', d: Math.abs(point[0] - box.max[0]) },
    { approach: 'beside-minus-x', d: Math.abs(point[0] - box.min[0]) },
    { approach: 'beside-z', d: Math.abs(point[2] - box.max[2]) },
    { approach: 'beside-minus-z', d: Math.abs(point[2] - box.min[2]) },
  ]
  faces.sort((a, b) => a.d - b.d || (a.approach === 'on-top' ? -1 : b.approach === 'on-top' ? 1 : 0))
  return faces[0]!.approach
}

/**
 * Mate an already-placed part onto a target, trying faces in a stable order and
 * skipping colliding poses. Used by connect_parts so the agent and the Connect
 * panel refuse with the same codes as click-to-place.
 */
export function searchMateBetween(
  moving: PartInstance,
  target: PartInstance,
  document: ModelDocument,
): MateSearchResult & { occupancy: ReturnType<typeof approachOccupancy> } {
  const box = getPartBounds(target)
  const span = Math.hypot(box.size[0], box.size[1], box.size[2])
  const radius = Math.max(STUD_LDU, span)
  const coarse: Transform = {
    position: [target.transform.position[0], box.min[1], target.transform.position[2]],
    basis: moving.transform.basis,
  }
  let blockedByCollision = false
  for (const approach of CONNECT_FACES) {
    const mate = searchMateOnTarget(moving, document, target, coarse, approach, radius)
    if (mate.transform) return { transform: mate.transform, blockedByCollision: false, occupancy: 'open' }
    if (mate.blockedByCollision) blockedByCollision = true
  }
  const any = searchMateOnTarget(moving, document, target, coarse, null, radius)
  if (any.transform) return { transform: any.transform, blockedByCollision: false, occupancy: 'open' }
  return {
    transform: null,
    blockedByCollision: blockedByCollision || any.blockedByCollision,
    occupancy: approachOccupancy(document, target.id, 'on-top'),
  }
}

/** Palette / keyboard add: mate onto the selection, or rest as a second building. */
export function resolveQuickAdd(
  request: PlacementRequest,
  document: ModelDocument,
  selectedId: string | null,
  gridLdu: number,
): ResolvedPlacement | null {
  if (selectedId && document.parts[selectedId]) {
    const target = document.parts[selectedId]
    const box = getPartBounds(target)
    const point: Vec3 = [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2]
    return resolvePlacement(request, document, { point, partId: selectedId }, gridLdu)
  }
  const definition = catalog.get(request.definitionId)
  if (!definition) return null
  const size = definition.dimensions?.ldu ?? [STUD_LDU, 0, STUD_LDU]
  const hasParts = Object.keys(document.parts).length > 0
  const bounds = getDocumentBounds(document)
  const point: Vec3 = hasParts ? [bounds.max[0] + size[0] / 2 + STUD_LDU, 0, 0] : [0, 0, 0]
  return resolvePlacement(request, document, { point, partId: null }, gridLdu)
}

/** First snap pose the kernel would actually commit. */
export function firstLegalSnap(
  part: PartInstance,
  document: ModelDocument,
  cursor: Transform,
  options: SnapSolverOptions = {},
): Transform | null {
  for (const entry of findSnapCandidates(part, document, cursor, options)) {
    if (!poseRefusal(document, part.id, entry.transform)) return entry.transform
  }
  return null
}

/** Connect-tool candidates that pass the same pose gate as a drag commit. */
export function legalConnectCandidates(
  source: PartInstance,
  target: PartInstance,
  document: ModelDocument,
  options: {
    sourceFeatureId?: string | null
    targetFeatureId?: string | null
    radiusLdu?: number
    maxCandidates?: number
  } = {},
): SnapCandidate[] {
  return findSnapCandidates(source, document, source.transform, {
    radiusLdu: options.radiusLdu ?? 400,
    targetPartIds: [target.id],
    maxCandidates: options.maxCandidates ?? 12,
    ...(options.sourceFeatureId ? { movingFeatureId: options.sourceFeatureId } : {}),
    ...(options.targetFeatureId ? { targetFeatureId: options.targetFeatureId } : {}),
  }).filter((entry) => !poseRefusal(document, source.id, entry.transform))
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

  let cursor: Transform = {
    position: [snapLdu(hit.point[0], gridLdu), originForSurface(definition, surfaceY), snapLdu(hit.point[2], gridLdu)],
    basis: request.basis
      ? multiplyMat3(rotatedBasis(request.quarterTurns), request.basis)
      : rotatedBasis(request.quarterTurns),
  }
  const initialCandidate: PartInstance = {
    id: request.movingPartId ?? '__placement__',
    definitionId: definition.canonicalId,
    color: request.color,
    transform: cursor,
    subassemblyId: '',
    stepId: '',
    provenance: 'human',
    protected: false,
  }
  // For a sideways/tilted part, its catalogue underside is no longer the
  // underside in world space. Ground its measured, rotated geometry instead.
  if (request.basis) {
    const box = getPartBounds({ ...initialCandidate, transform: { ...cursor, position: [0, 0, 0] } })
    cursor = { ...cursor, position: [cursor.position[0], surfaceY - box.max[1], cursor.position[2]] }
  }
  const candidate = { ...initialCandidate, transform: cursor }
  const minRadius = Math.max(8, gridLdu)
  let accepted: Transform | null = null
  let blockedByCollision = false
  let occupancyApproach: PlacementFace = 'on-top'
  if (target) {
    const targetBox = getPartBounds(target)
    const classified = hitApproach(hit.point, targetBox)
    occupancyApproach = classified
    let mate = searchMateOnTarget(candidate, model, target, cursor, classified, minRadius)
    if (!mate.transform && classified !== 'on-top') {
      const top = searchMateOnTarget(candidate, model, target, cursor, 'on-top', minRadius)
      if (top.transform || top.blockedByCollision) {
        mate = top
        occupancyApproach = 'on-top'
      }
    }
    accepted = mate.transform
    blockedByCollision = mate.blockedByCollision
  } else {
    // Ground placement must not snap to an underside beneath the ground, and
    // a blocked first candidate must not hide a later usable one.
    for (const entry of findSnapCandidates(candidate, model, cursor, { radiusLdu: minRadius })) {
      const seated = { ...candidate, transform: entry.transform }
      if (getPartBounds(seated).max[1] > 0.05 || partPoseCollides(model, seated)) continue
      accepted = entry.transform
      break
    }
  }
  const mated = accepted !== null
  const groundCollision = !target && !mated && partPoseCollides(model, candidate)
  const legal = mated || (!target && !groundCollision)
  let reason: PlacementReason
  if (mated) reason = 'mated'
  else if (groundCollision) reason = 'collision'
  else if (!target) reason = 'ground'
  else if (blockedByCollision) reason = 'collision'
  else {
    const occupancy = approachOccupancy(model, target.id, occupancyApproach)
    reason = occupancy === 'occupied' ? 'occupied' : occupancy === 'absent' ? 'absent' : 'incompatible'
  }
  return { transform: accepted ?? cursor, mated, legal, reason, surfaceY }
}

/**
 * Whether a solved pose actually uses the face the caller asked for.
 *
 * The snap solver searches a radius large enough to see the opposite face of a
 * brick, so an on-top request can otherwise land underneath on anti-studs. LDraw
 * is Y-down: a part's top is min[1], its underside is max[1].
 */
export function poseMatchesApproach(
  moving: PartInstance,
  anchor: PartInstance,
  approach: string,
  slopLdu = 8,
): boolean {
  const movingBox = getPartBounds(moving)
  const targetBox = getPartBounds(anchor)
  switch (approach) {
    case 'on-top':
      return Math.abs(movingBox.max[1] - targetBox.min[1]) <= slopLdu
    case 'underneath':
      return Math.abs(movingBox.min[1] - targetBox.max[1]) <= slopLdu
    case 'beside-x':
      return Math.abs(movingBox.min[0] - targetBox.max[0]) <= slopLdu
    case 'beside-minus-x':
      return Math.abs(movingBox.max[0] - targetBox.min[0]) <= slopLdu
    case 'beside-z':
      return Math.abs(movingBox.min[2] - targetBox.max[2]) <= slopLdu
    case 'beside-minus-z':
      return Math.abs(movingBox.max[2] - targetBox.min[2]) <= slopLdu
    default:
      return false
  }
}
