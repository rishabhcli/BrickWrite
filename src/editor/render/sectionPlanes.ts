/**
 * Clipping and section planes, with the manipulator maths kept out of React.
 *
 * A section plane is the only way to look inside a finished model without
 * taking it apart, and the only way to check that an interior is actually built
 * rather than hollow. It has to be *manipulated on the canvas* — a numeric
 * offset field means guessing where the cut is and re-typing until it lands, an
 * interaction nobody performs twice.
 *
 * Planes live in **document space** (LDU, +Y down) because that is what the
 * operator's numbers mean and what an agent would be told. Conversion into the
 * scene frame happens once, at the boundary, exactly like every other transform
 * in the renderer.
 */

import type { Vec3 } from '../../cad/types'

export interface SectionPlane {
  readonly id: string
  /** Unit normal in document space. The kept half-space is where d(x) ≥ 0. */
  readonly normal: Vec3
  /** A point on the plane, in document LDU. */
  readonly origin: Vec3
  readonly enabled: boolean
  /** Draw the cut face, so the section reads as a solid rather than a hole. */
  readonly capped: boolean
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]

export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2])
  return length < 1e-9 ? [0, 1, 0] : [a[0] / length, a[1] / length, a[2] / length]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Signed distance from a point to the plane; positive is the kept side. */
export const signedDistance = (plane: SectionPlane, point: Vec3): number =>
  dot(plane.normal, sub(point, plane.origin))

/**
 * Whether an axis-aligned box survives the cut at all.
 *
 * Used to skip whole batches: the extent of a box along the plane normal is the
 * sum of the half-extents times the absolute normal components, which is the
 * standard separating-axis projection and exact for an AABB.
 */
export function boxClipState(
  plane: SectionPlane,
  min: Vec3,
  max: Vec3,
): 'kept' | 'cut' | 'removed' {
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const half: Vec3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]
  const reach =
    Math.abs(plane.normal[0]) * half[0] + Math.abs(plane.normal[1]) * half[1] + Math.abs(plane.normal[2]) * half[2]
  const centreDistance = signedDistance(plane, centre)
  if (centreDistance - reach >= 0) return 'kept'
  if (centreDistance + reach <= 0) return 'removed'
  return 'cut'
}

export interface Ray {
  readonly origin: Vec3
  readonly direction: Vec3
}

/** Where a ray meets the plane, or null when it runs parallel to it. */
export function intersectPlane(plane: SectionPlane, ray: Ray): Vec3 | null {
  const denominator = dot(plane.normal, ray.direction)
  if (Math.abs(denominator) < 1e-9) return null
  const t = dot(plane.normal, sub(plane.origin, ray.origin)) / denominator
  if (!Number.isFinite(t)) return null
  return add(ray.origin, scale(ray.direction, t))
}

/**
 * Closest point to `axisOrigin + t·axis` along a pointer ray.
 *
 * This is the standard closest-approach of two lines, and it is what makes an
 * offset handle track the cursor instead of jumping: the handle can only move
 * along its own axis, so the drag has to project the cursor onto that axis
 * rather than intersect anything. Returns null when the ray is parallel to the
 * axis, which is the degenerate view where the handle is a point on screen and
 * a drag genuinely carries no information.
 */
export function projectRayOntoAxis(axisOrigin: Vec3, axis: Vec3, ray: Ray): number | null {
  const u = normalize(axis)
  const v = normalize(ray.direction)
  const w0 = sub(axisOrigin, ray.origin)
  const b = dot(u, v)
  const denominator = 1 - b * b
  // Below this the two lines are within ~0.6° of parallel and the solution is
  // numerically meaningless, not merely imprecise.
  if (denominator < 1e-4) return null
  // Ericson's closest-approach solution for two lines, specialised to unit
  // directions: s = (b·f − c) / (1 − b²), where c projects the offset onto the
  // axis and f projects it onto the ray. The sign matters — inverted, the
  // handle would run away from the cursor at exactly twice the right speed.
  const c = dot(u, w0)
  const f = dot(v, w0)
  return (b * f - c) / denominator
}

/**
 * Moves a plane along its own normal to follow a drag.
 *
 * `grabOffset` is the axis parameter recorded when the handle was grabbed, so
 * the plane keeps the same relationship to the cursor for the whole drag rather
 * than snapping its origin under the pointer on the first move.
 */
export function offsetPlaneFromDrag(
  plane: SectionPlane,
  ray: Ray,
  grabOffset: number,
  options: { readonly stepLdu?: number } = {},
): SectionPlane {
  const t = projectRayOntoAxis(plane.origin, plane.normal, ray)
  if (t === null) return plane
  let travel = t - grabOffset
  const step = options.stepLdu ?? 0
  if (step > 0) travel = Math.round(travel / step) * step
  return { ...plane, origin: add(plane.origin, scale(plane.normal, travel)) }
}

/**
 * Turns a plane about an in-plane axis to follow a drag on its rotation ring.
 *
 * The rotation is measured in the plane the ring lies in, which is the section
 * plane itself, so the angle is the change in the cursor's bearing around the
 * plane origin. Pivoting about the origin rather than about the model's centre
 * is what makes the cut stay where the operator put it while its angle changes.
 */
export function rotatePlaneFromDrag(plane: SectionPlane, ringAxis: Vec3, radians: number): SectionPlane {
  const axis = normalize(ringAxis)
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const n = plane.normal
  // Rodrigues, in full rather than via a matrix: one rotation, no allocation.
  const rotated: Vec3 = [
    n[0] * cosine + (axis[1] * n[2] - axis[2] * n[1]) * sine + axis[0] * dot(axis, n) * (1 - cosine),
    n[1] * cosine + (axis[2] * n[0] - axis[0] * n[2]) * sine + axis[1] * dot(axis, n) * (1 - cosine),
    n[2] * cosine + (axis[0] * n[1] - axis[1] * n[0]) * sine + axis[2] * dot(axis, n) * (1 - cosine),
  ]
  return { ...plane, normal: normalize(rotated) }
}

/**
 * The bearing of a point around the plane origin, inside the plane.
 *
 * Ring drags accumulate the *difference* between two bearings rather than an
 * absolute angle, because an absolute angle would snap the plane to wherever
 * the cursor first landed.
 */
export function bearingInPlane(plane: SectionPlane, reference: Vec3, point: Vec3): number {
  const u = normalize(sub(reference, scale(plane.normal, dot(plane.normal, reference))))
  const v = cross(plane.normal, u)
  const local = sub(point, plane.origin)
  return Math.atan2(dot(local, v), dot(local, u))
}

/** Axis-aligned section presets, in document space. LDraw's +Y is *down*. */
export const SECTION_PRESETS: Record<'x' | 'y' | 'z', Vec3> = {
  x: [1, 0, 0],
  // Kept half-space below the cut in screen terms, because +Y is downward in
  // LDraw: a "top" section should reveal the storey under the roof, and the
  // roof is at *smaller* Y.
  y: [0, 1, 0],
  z: [0, 0, 1],
}

export function createSectionPlane(axis: 'x' | 'y' | 'z', origin: Vec3, id = `section_${axis}`): SectionPlane {
  return { id, normal: SECTION_PRESETS[axis], origin, enabled: true, capped: true }
}
