import { getPartBounds } from '../../cad/geometry'
import { getWorldConnectors } from '../../cad/snapping'
import {
  basisFromEulerDegrees,
  applyMat3,
  canonicalTransform,
  cleanBasis,
  composeTransform,
  degreesToRadians,
  eulerDegreesFromBasis,
  IDENTITY_BASIS,
  orthonormalize,
  rotateLocal,
  rotateWorld,
  multiplyMat3,
  transposeMat3,
  type Mat3,
  type Vec3,
} from '../../cad/math'
import type { CadOperation, ModelDocument, PartInstance, Transform } from '../../cad/types'

/**
 * One canonical pose representation for every control that can produce one.
 *
 * The gizmo reads a matrix back out of three.js, the numeric fields build one
 * from typed LDU and degrees, and the align/distribute buttons compute one from
 * measured bounds. If those three arrived at different bit patterns for the same
 * physical pose, the document would carry three spellings of one placement:
 * exports would differ, dedup would miss, and "type what the gizmo just did"
 * would move the part. Everything below funnels through `canonicalisePose`, and
 * a test asserts the equivalence rather than trusting it.
 */

export type ReferenceFrame = 'world' | 'local' | 'connector'

export type PivotMode = 'origin' | 'centre' | 'world-origin'

export interface AxisLocks {
  readonly x: boolean
  readonly y: boolean
  readonly z: boolean
}

export const NO_LOCKS: AxisLocks = { x: false, y: false, z: false }

export interface ManipulationOptions {
  frame: ReferenceFrame
  pivot: PivotMode
  locks: AxisLocks
  connectorSnap: boolean
  rotationStep: number
}

export const DEFAULT_MANIPULATION: ManipulationOptions = {
  frame: 'world',
  pivot: 'centre',
  locks: NO_LOCKS,
  connectorSnap: true,
  rotationStep: 90,
}

/** One proxy frame for the entire selection; never rotate each member independently. */
export function manipulationPose(parts: readonly PartInstance[], options: ManipulationOptions): Transform {
  const first = parts[0]
  return {
    position: resolvePivot(parts, options.pivot),
    basis:
      !first || options.frame === 'world'
        ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
        : options.frame === 'connector'
          ? (connectorFrame(first) ?? first.transform.basis)
          : first.transform.basis,
  }
}

/** Full matrix delta (including X/Z and >90° turns), without lossy Euler extraction. */
export function planGizmoTransforms(
  parts: readonly PartInstance[],
  start: Transform,
  raw: Transform,
  options: { rotating: boolean; gridLdu: number; locks: AxisLocks },
): CadOperation[] {
  const rotation = lockRotation(
    IDENTITY_BASIS,
    multiplyMat3(raw.basis, transposeMat3(start.basis)),
    options.locks,
    start.basis as Mat3,
  )
  const localDelta = applyMat3(transposeMat3(start.basis), [
    raw.position[0] - start.position[0],
    raw.position[1] - start.position[1],
    raw.position[2] - start.position[2],
  ])
  const snapped = snapPosition(localDelta, options.gridLdu)
  const delta = applyMat3(start.basis, [
    options.locks.x ? 0 : snapped[0],
    options.locks.y ? 0 : snapped[1],
    options.locks.z ? 0 : snapped[2],
  ])
  return parts.flatMap((part): CadOperation[] => {
    const offset = applyMat3(rotation, [
      part.transform.position[0] - start.position[0],
      part.transform.position[1] - start.position[1],
      part.transform.position[2] - start.position[2],
    ])
    const transform = canonicalisePose(
      options.rotating
        ? {
            position: [start.position[0] + offset[0], start.position[1] + offset[1], start.position[2] + offset[2]],
            basis: multiplyMat3(rotation, part.transform.basis),
          }
        : {
            position: [
              part.transform.position[0] + delta[0],
              part.transform.position[1] + delta[1],
              part.transform.position[2] + delta[2],
            ],
            basis: part.transform.basis,
          },
    )
    return posesEqual(part.transform, transform) ? [] : [{ type: 'part.transform', partId: part.id, transform }]
  })
}

/** Put the lowest point on Y=0, keeping all relative poses intact. LDraw is Y-down. */
export function planGroundSelection(parts: readonly PartInstance[]): CadOperation[] {
  if (!parts.length) return []
  const bottom = Math.max(...parts.map((part) => getPartBounds(part).max[1]))
  return Math.abs(bottom) < POSITION_QUANTUM ? [] : planTranslateSelection(parts, [0, -bottom, 0])
}

/** Position quantum, in LDU. Kills gizmo float noise without touching real values. */
const POSITION_QUANTUM = 1e-4

const quantise = (value: number) => {
  const scaled = Math.round(value / POSITION_QUANTUM) * POSITION_QUANTUM
  // -0 and 0 must not produce different canonical strings.
  return scaled === 0 ? 0 : Number(scaled.toFixed(6))
}

/**
 * The single normalisation every produced pose passes through.
 *
 * Re-orthonormalising is not cosmetic: repeated composition shears a basis, and
 * a sheared basis is refused by the kernel's operation validator.
 */
export function canonicalisePose(pose: Transform): Transform {
  return {
    position: [quantise(pose.position[0]), quantise(pose.position[1]), quantise(pose.position[2])],
    basis: cleanBasis(orthonormalize(pose.basis as Mat3)),
  }
}

/** Stable string identity for a pose, for comparison and for tests. */
export const poseKey = (pose: Transform): string => canonicalTransform(canonicalisePose(pose))

export const posesEqual = (a: Transform, b: Transform): boolean => poseKey(a) === poseKey(b)

/**
 * Applies per-axis locks in the active reference frame.
 *
 * WORLD freezes document X/Y/Z. LOCAL and MATE freeze those same named axes
 * on the gizmo — a 90° yaw must not let a locked X slide along world X while
 * the handle the operator hid was the part's own X.
 */
export function applyLocks(base: Transform, next: Transform, locks: AxisLocks, frame?: Mat3 | null): Transform {
  if (!locks.x && !locks.y && !locks.z) return next
  const worldDelta: Vec3 = [
    next.position[0] - base.position[0],
    next.position[1] - base.position[1],
    next.position[2] - base.position[2],
  ]
  const local = frame ? applyMat3(transposeMat3(frame), worldDelta) : worldDelta
  const filtered: Vec3 = [locks.x ? 0 : local[0], locks.y ? 0 : local[1], locks.z ? 0 : local[2]]
  const world = frame ? applyMat3(frame, filtered) : filtered
  return {
    position: [base.position[0] + world[0], base.position[1] + world[1], base.position[2] + world[2]],
    basis: lockRotation(base.basis as Mat3, next.basis as Mat3, locks, frame),
  }
}

/**
 * Hide the gizmo handle that would defeat a named axis lock.
 *
 * Translate and rotate share one lock map: locking X must hide both the X
 * arrow and the X ring, otherwise the HUD says locked while the ring still
 * turns the part.
 */
export function gizmoAxisVisible(locks: AxisLocks): { showX: boolean; showY: boolean; showZ: boolean } {
  return { showX: !locks.x, showY: !locks.y, showZ: !locks.z }
}

/**
 * Freeze locked Euler components of a relative rotation, in the named frame.
 *
 * WORLD locks document XYZ rings. LOCAL/MATE lock the gizmo's own rings —
 * the same axes the operator hid.
 */
export function lockRotation(base: Mat3, next: Mat3, locks: AxisLocks, frame?: Mat3 | null): Mat3 {
  if (!locks.x && !locks.y && !locks.z) return next
  const relative = multiplyMat3(next, transposeMat3(base))
  const F = frame ?? IDENTITY_BASIS
  const localRel = multiplyMat3(transposeMat3(F), multiplyMat3(relative, F))
  const euler = eulerDegreesFromBasis(localRel)
  const filtered: Vec3 = [locks.x ? 0 : euler[0], locks.y ? 0 : euler[1], locks.z ? 0 : euler[2]]
  if (filtered[0] === euler[0] && filtered[1] === euler[1] && filtered[2] === euler[2]) return next
  const localOut = basisFromEulerDegrees(filtered)
  return multiplyMat3(multiplyMat3(F, multiplyMat3(localOut, transposeMat3(F))), base)
}

/** Snaps a position to a grid increment, leaving the basis untouched. */
export function snapPosition(position: Vec3, gridLdu: number): Vec3 {
  if (gridLdu <= 0) return position
  return [
    Math.round(position[0] / gridLdu) * gridLdu,
    Math.round(position[1] / gridLdu) * gridLdu,
    Math.round(position[2] / gridLdu) * gridLdu,
  ]
}

export interface NumericPose {
  /** Exact document position in LDU. */
  readonly position: Vec3
  /** Display Euler degrees, decomposed from the stored basis. */
  readonly rotationDegrees: Vec3
}

/** What the numeric fields show for a pose. */
export function readNumericPose(pose: Transform): NumericPose {
  return { position: [...pose.position] as unknown as Vec3, rotationDegrees: eulerDegreesFromBasis(pose.basis as Mat3) }
}

/**
 * The pose produced by typing into the numeric fields.
 *
 * Rotation is expressed as Euler degrees because that is what a person can type;
 * the stored representation stays an exact basis, and the decomposition is only
 * ever a display affordance.
 */
export function numericPose(base: Transform, entry: Partial<NumericPose>): Transform {
  return canonicalisePose({
    position: entry.position ?? base.position,
    basis: entry.rotationDegrees ? basisFromEulerDegrees(entry.rotationDegrees) : base.basis,
  })
}

/**
 * The pose produced by dragging the gizmo.
 *
 * `raw` is whatever three.js handed back, already mapped into document space by
 * the viewport. Grid snapping and axis locks are applied here so the same rules
 * govern the pointer path and the keyboard path.
 */
export function gizmoPose(
  base: Transform,
  raw: Transform,
  options: { gridLdu?: number; locks?: AxisLocks; rotating?: boolean; frame?: Mat3 | null } = {},
): Transform {
  const grid = options.rotating ? 0 : (options.gridLdu ?? 0)
  const positioned: Transform = { position: snapPosition(raw.position as Vec3, grid), basis: raw.basis }
  return canonicalisePose(applyLocks(base, positioned, options.locks ?? NO_LOCKS, options.frame))
}

/** Moves a pose by an offset expressed in the chosen reference frame. */
export function translatePose(base: Transform, delta: Vec3, frame: ReferenceFrame, referenceBasis?: Mat3): Transform {
  const basis =
    frame === 'world'
      ? null
      : frame === 'local'
        ? (referenceBasis ?? (base.basis as Mat3))
        : (referenceBasis ?? (base.basis as Mat3))
  const world: Vec3 = basis
    ? [
        basis[0] * delta[0] + basis[1] * delta[1] + basis[2] * delta[2],
        basis[3] * delta[0] + basis[4] * delta[1] + basis[5] * delta[2],
        basis[6] * delta[0] + basis[7] * delta[1] + basis[8] * delta[2],
      ]
    : delta
  return canonicalisePose({
    position: [base.position[0] + world[0], base.position[1] + world[1], base.position[2] + world[2]],
    basis: base.basis,
  })
}

/**
 * Turns a pose about an axis, in the chosen frame, around the chosen pivot.
 *
 * A local-frame turn about the part's own origin is the quarter-turn every
 * builder means by "rotate"; a world-frame turn about the selection's centre is
 * what a multi-part selection needs. Both are the same expression with different
 * arguments, so neither can drift from the other.
 */
export function rotatePose(
  base: Transform,
  axis: Vec3,
  degrees: number,
  frame: ReferenceFrame,
  pivot?: Vec3,
  referenceBasis?: Mat3,
): Transform {
  const radians = degreesToRadians(degrees)
  if (frame === 'local' && !pivot) return canonicalisePose(rotateLocal(base, axis, radians))
  const worldAxis: Vec3 =
    frame === 'world'
      ? axis
      : (() => {
          const basis =
            frame === 'local' ? (referenceBasis ?? (base.basis as Mat3)) : (referenceBasis ?? (base.basis as Mat3))
          return [
            basis[0] * axis[0] + basis[1] * axis[1] + basis[2] * axis[2],
            basis[3] * axis[0] + basis[4] * axis[1] + basis[5] * axis[2],
            basis[6] * axis[0] + basis[7] * axis[1] + basis[8] * axis[2],
          ]
        })()
  return canonicalisePose(rotateWorld(base, worldAxis, radians, pivot ?? base.position))
}

/** Document-space pivot for a selection, under the chosen pivot rule. */
export function resolvePivot(parts: readonly PartInstance[], mode: PivotMode): Vec3 {
  if (mode === 'world-origin' || !parts.length) return [0, 0, 0]
  if (mode === 'origin') return [...parts[0].transform.position] as unknown as Vec3
  const bounds = parts.map(getPartBounds)
  return [
    (Math.min(...bounds.map((b) => b.min[0])) + Math.max(...bounds.map((b) => b.max[0]))) / 2,
    (Math.min(...bounds.map((b) => b.min[1])) + Math.max(...bounds.map((b) => b.max[1]))) / 2,
    (Math.min(...bounds.map((b) => b.min[2])) + Math.max(...bounds.map((b) => b.max[2]))) / 2,
  ]
}

/**
 * The frame of the part's first connector, for the `connector` reference frame.
 *
 * Returns null when the part has no compiled connectors, which is the honest
 * answer for an identity whose snap metadata was never published — the control
 * says so rather than silently falling back to world and moving the part the
 * wrong way.
 */
export function connectorFrame(part: PartInstance, featureId?: string): Mat3 | null {
  const connectors = getWorldConnectors(part)
  if (!connectors.length) return null
  const chosen = featureId ? connectors.find((entry) => entry.id === featureId) : connectors[0]
  return (chosen ?? connectors[0]).frame.basis as Mat3
}

/** Basis axis locks are measured in. Null means world XYZ. */
export function referenceBasis(part: PartInstance | undefined, frame: ReferenceFrame): Mat3 | null {
  if (!part || frame === 'world') return null
  return frame === 'connector' ? connectorFrame(part) : (part.transform.basis as Mat3)
}

export type AlignEdge = 'min' | 'centre' | 'max'
export const AXIS_INDEX: Record<'x' | 'y' | 'z', 0 | 1 | 2> = { x: 0, y: 1, z: 2 }

/**
 * Aligns a selection along one axis.
 *
 * Alignment is computed from measured LDraw bounds, not from part origins: LDraw
 * origins sit wherever the part author put them, so aligning origins leaves a
 * plate and a brick visibly unaligned even though the numbers agree.
 */
export function planAlign(parts: readonly PartInstance[], axis: 'x' | 'y' | 'z', edge: AlignEdge): CadOperation[] {
  if (parts.length < 2) return []
  const index = AXIS_INDEX[axis]
  const measured = parts.map((part) => ({ part, bounds: getPartBounds(part) }))
  const target =
    edge === 'min'
      ? Math.min(...measured.map((entry) => entry.bounds.min[index]))
      : edge === 'max'
        ? Math.max(...measured.map((entry) => entry.bounds.max[index]))
        : (Math.min(...measured.map((entry) => entry.bounds.min[index])) +
            Math.max(...measured.map((entry) => entry.bounds.max[index]))) /
          2

  return measured.flatMap(({ part, bounds }) => {
    const current =
      edge === 'min'
        ? bounds.min[index]
        : edge === 'max'
          ? bounds.max[index]
          : (bounds.min[index] + bounds.max[index]) / 2
    const delta = target - current
    if (Math.abs(delta) < POSITION_QUANTUM) return []
    const position = [...part.transform.position] as [number, number, number]
    position[index] += delta
    return [{ type: 'part.transform', partId: part.id, transform: canonicalisePose({ ...part.transform, position }) }]
  })
}

/**
 * Spaces a selection evenly along one axis, keeping the two extremes fixed.
 *
 * Gaps are equalised rather than centres, which is what "distribute" means for
 * parts of different lengths.
 */
export function planDistribute(parts: readonly PartInstance[], axis: 'x' | 'y' | 'z'): CadOperation[] {
  if (parts.length < 3) return []
  const index = AXIS_INDEX[axis]
  const measured = parts
    .map((part) => ({ part, bounds: getPartBounds(part) }))
    .sort((a, b) => a.bounds.min[index] - b.bounds.min[index])

  const first = measured[0]
  const last = measured[measured.length - 1]
  const span = last.bounds.max[index] - first.bounds.min[index]
  const occupied = measured.reduce((sum, entry) => sum + (entry.bounds.max[index] - entry.bounds.min[index]), 0)
  const gap = (span - occupied) / (measured.length - 1)

  const operations: CadOperation[] = []
  let cursor = first.bounds.max[index] + gap
  for (const entry of measured.slice(1, -1)) {
    const length = entry.bounds.max[index] - entry.bounds.min[index]
    const delta = cursor - entry.bounds.min[index]
    if (Math.abs(delta) >= POSITION_QUANTUM) {
      const position = [...entry.part.transform.position] as [number, number, number]
      position[index] += delta
      operations.push({
        type: 'part.transform',
        partId: entry.part.id,
        transform: canonicalisePose({ ...entry.part.transform, position }),
      })
    }
    cursor += length + gap
  }
  return operations
}

/**
 * Quarter-turn (or any yaw) of a selection as one rigid motion.
 *
 * One brick turns about its own origin — that is the builder's "rotate this
 * piece". Two or more turn about the selection's measured centre, so a clutched
 * stack stays clutched instead of each brick spinning in place and walking off
 * its studs.
 */
export function planRotateSelection(parts: readonly PartInstance[], degrees: number): CadOperation[] {
  if (!parts.length) return []
  if (parts.length === 1) {
    const part = parts[0]!
    return [
      { type: 'part.transform', partId: part.id, transform: rotatePose(part.transform, [0, 1, 0], degrees, 'local') },
    ]
  }
  const pivot = resolvePivot(parts, 'centre')
  return parts.map((part) => ({
    type: 'part.transform' as const,
    partId: part.id,
    transform: rotatePose(part.transform, [0, 1, 0], degrees, 'world', pivot),
  }))
}

/** Moves several parts by one world delta so a clutched stack stays clutched. */
export function planTranslateSelection(parts: readonly PartInstance[], delta: Vec3): CadOperation[] {
  if (!parts.length) return []
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return []
  return parts.map((part) => ({
    type: 'part.transform' as const,
    partId: part.id,
    transform: translatePose(part.transform, delta, 'world'),
  }))
}

/** Preview poses for a rigid group drag (world delta and/or yaw about the selection centre). */
export function applyRigidMotion(
  parts: readonly PartInstance[],
  delta: Vec3,
  yawDegrees: number,
): Map<string, Transform> {
  const preview = new Map<string, Transform>()
  const translated = parts.map((part) => ({ ...part, transform: translatePose(part.transform, delta, 'world') }))
  if (!yawDegrees) {
    for (const part of translated) preview.set(part.id, part.transform)
    return preview
  }
  const pivot = resolvePivot(translated, 'centre')
  for (const part of translated) {
    preview.set(part.id, rotatePose(part.transform, [0, 1, 0], yawDegrees, 'world', pivot))
  }
  return preview
}

/** Measured extent of a selection, for the transform panel's readout. */
export function selectionExtent(document: ModelDocument, partIds: readonly string[]) {
  const parts = partIds.map((id) => document.parts[id]).filter(Boolean)
  if (!parts.length) return null
  const bounds = parts.map(getPartBounds)
  const min: Vec3 = [
    Math.min(...bounds.map((b) => b.min[0])),
    Math.min(...bounds.map((b) => b.min[1])),
    Math.min(...bounds.map((b) => b.min[2])),
  ]
  const max: Vec3 = [
    Math.max(...bounds.map((b) => b.max[0])),
    Math.max(...bounds.map((b) => b.max[1])),
    Math.max(...bounds.map((b) => b.max[2])),
  ]
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as Vec3, parts }
}

/** Composes a child pose under a parent, canonicalised. Used by array previews. */
export const composePose = (outer: Transform, inner: Transform): Transform =>
  canonicalisePose(composeTransform(outer, inner))
