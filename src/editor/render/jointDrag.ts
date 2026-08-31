/**
 * Direct joint manipulation.
 *
 * The editor could already articulate a mechanism from a panel: pick a joint,
 * type an angle, commit. That is a correct interface and a poor one — a hinge
 * has a physical range an operator wants to *feel*, and finding the angle at
 * which a door clears its frame by typing numbers is a search, not a design
 * decision.
 *
 * Dragging the joint itself is the interaction, and it has three properties
 * that are not negotiable:
 *
 *   1. The drag moves the **rigid island** on one side of the joint — the whole
 *      flap, not the one plate the cursor happens to be over. `findArticulatedJoints`
 *      already decomposes that, so this module consumes its answer rather than
 *      inventing a second one.
 *   2. The canonical document is **never written during a drag**. A drag is a
 *      preview: the moved parts render from a transform map that lives in React
 *      state, and the document only changes on release. Anything else would put
 *      one revision per animation frame into the history and make undo useless.
 *   3. Release commits **one** transaction, and `Escape` commits none — leaving
 *      the parts at exactly the transforms they started with, which is free,
 *      because they were never touched.
 */

import { articulate, type ArticulatedJoint } from '../../cad/articulation'
import { rotateWorld } from '../../cad/math'
import type { CadOperation, ModelDocument, Transform, Vec3 } from '../../cad/types'
import { intersectPlane, normalize, projectRayOntoAxis, type Ray } from './sectionPlanes'

/** Which handle of the joint manipulator the pointer grabbed. */
export type JointHandle = 'rotate' | 'slide' | 'ball'

/** The freedoms a joint offers, so the manipulator draws only real handles. */
export function handlesFor(joint: ArticulatedJoint): JointHandle[] {
  switch (joint.joint.kind) {
    case 'revolute':
      return ['rotate']
    case 'prismatic':
      return ['slide']
    case 'cylindrical':
      return ['rotate', 'slide']
    case 'spherical':
      return ['ball']
    case 'winch':
      // One handle, because a winch has one input: the drum. The load's travel
      // is the consequence, not a second thing to grab.
      return ['rotate']
    default:
      // `unknown` and `fixed` articulate nothing. Drawing a handle that refuses
      // to move is worse than drawing none.
      return []
  }
}

export interface JointDragGrab {
  readonly handle: JointHandle
  /** Bearing about the axis at grab time, radians. Rotation handles only. */
  readonly bearing: number
  /** Axis parameter at grab time, LDU. Slide handles only. */
  readonly axial: number
  /** Ray direction at grab time, for the ball handle's trackball. */
  readonly ballPoint: Vec3
}

/**
 * A drag's accumulated request, in the joint's own parameters.
 *
 * `axis` is present only for a ball joint, whose freedom is a rotation about an
 * axis the drag itself chooses rather than about the connector axis.
 */
export interface JointDragRequest {
  readonly rotateDegrees: number
  readonly slideLdu: number
  readonly axis?: Vec3
}

const EMPTY_REQUEST: JointDragRequest = { rotateDegrees: 0, slideLdu: 0 }

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * An arbitrary unit vector perpendicular to `axis`.
 *
 * The reference direction for bearings has to be stable for the whole drag or
 * the measured angle jumps. Choosing the world axis the joint axis is *least*
 * aligned with avoids the degenerate cross product without needing a branch per
 * orientation.
 */
export function perpendicularTo(axis: Vec3): Vec3 {
  const unit = normalize(axis)
  const absolute = [Math.abs(unit[0]), Math.abs(unit[1]), Math.abs(unit[2])]
  const smallest = absolute[0] <= absolute[1] && absolute[0] <= absolute[2] ? 0 : absolute[1] <= absolute[2] ? 1 : 2
  const seed: Vec3 = smallest === 0 ? [1, 0, 0] : smallest === 1 ? [0, 1, 0] : [0, 0, 1]
  return normalize(cross(unit, seed))
}

/** Bearing of a document-space point about the joint axis, in radians. */
export function bearingAboutAxis(joint: ArticulatedJoint, point: Vec3): number {
  const axis = normalize(joint.axis)
  const u = perpendicularTo(axis)
  const v = cross(axis, u)
  const local = sub(point, joint.pivotLdu)
  const planar: Vec3 = [
    local[0] - axis[0] * dot(axis, local),
    local[1] - axis[1] * dot(axis, local),
    local[2] - axis[2] * dot(axis, local),
  ]
  return Math.atan2(dot(planar, v), dot(planar, u))
}

/**
 * Records where a drag started, in the parameter the grabbed handle drives.
 *
 * Returns null when the pointer ray carries no usable information for that
 * handle — a rotation ring seen exactly edge-on, or a slide axis pointing
 * straight at the camera. Refusing the grab is the honest response; the
 * alternative is a handle that leaps when the ray finally becomes well
 * conditioned.
 */
export function beginJointDrag(joint: ArticulatedJoint, handle: JointHandle, ray: Ray): JointDragGrab | null {
  const axis = normalize(joint.axis)
  if (handle === 'slide') {
    const axial = projectRayOntoAxis(joint.pivotLdu, axis, ray)
    if (axial === null) return null
    return { handle, bearing: 0, axial, ballPoint: [0, 0, 0] }
  }
  if (handle === 'rotate') {
    const hit = intersectPlane({ id: 'joint', normal: axis, origin: joint.pivotLdu, enabled: true, capped: false }, ray)
    if (!hit) return null
    return { handle, bearing: bearingAboutAxis(joint, hit), axial: 0, ballPoint: [0, 0, 0] }
  }
  const point = trackballPoint(joint, ray)
  if (!point) return null
  return { handle, bearing: 0, axial: 0, ballPoint: point }
}

/**
 * Projects a pointer ray onto a sphere centred on the pivot.
 *
 * Ball joints have no single axis, so their drag is a trackball: two points on
 * a sphere define the rotation that carries one to the other. A ray that misses
 * the sphere is projected onto its silhouette instead of refused, which is what
 * keeps a ball joint controllable when the cursor leaves the handle.
 */
export function trackballPoint(joint: ArticulatedJoint, ray: Ray, radiusLdu = 24): Vec3 | null {
  const direction = normalize(ray.direction)
  const toCentre = sub(joint.pivotLdu, ray.origin)
  const along = dot(toCentre, direction)
  const closest: Vec3 = [
    ray.origin[0] + direction[0] * along,
    ray.origin[1] + direction[1] * along,
    ray.origin[2] + direction[2] * along,
  ]
  const offset = sub(closest, joint.pivotLdu)
  const distance = Math.hypot(offset[0], offset[1], offset[2])
  if (distance >= radiusLdu) {
    if (distance < 1e-9) return null
    const k = radiusLdu / distance
    return [offset[0] * k, offset[1] * k, offset[2] * k]
  }
  // Inside the silhouette: lift onto the near hemisphere so the drag has depth.
  const depth = Math.sqrt(Math.max(0, radiusLdu * radiusLdu - distance * distance))
  const towardsEye: Vec3 = [-direction[0] * depth, -direction[1] * depth, -direction[2] * depth]
  return [offset[0] + towardsEye[0], offset[1] + towardsEye[1], offset[2] + towardsEye[2]]
}

/** Turns the current pointer ray into the joint parameters the drag requests. */
export function updateJointDrag(joint: ArticulatedJoint, grab: JointDragGrab, ray: Ray): JointDragRequest {
  const axis = normalize(joint.axis)
  if (grab.handle === 'slide') {
    const axial = projectRayOntoAxis(joint.pivotLdu, axis, ray)
    if (axial === null) return EMPTY_REQUEST
    return { rotateDegrees: 0, slideLdu: axial - grab.axial }
  }
  if (grab.handle === 'rotate') {
    const hit = intersectPlane({ id: 'joint', normal: axis, origin: joint.pivotLdu, enabled: true, capped: false }, ray)
    if (!hit) return EMPTY_REQUEST
    let delta = bearingAboutAxis(joint, hit) - grab.bearing
    // Unwrap to (−π, π]; a hinge dragged past the seam must not snap a full turn.
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta <= -Math.PI) delta += Math.PI * 2
    return { rotateDegrees: (delta * 180) / Math.PI, slideLdu: 0 }
  }
  const point = trackballPoint(joint, ray)
  if (!point) return EMPTY_REQUEST
  const from = normalize(grab.ballPoint)
  const to = normalize(point)
  const rotationAxis = cross(from, to)
  const sine = Math.hypot(rotationAxis[0], rotationAxis[1], rotationAxis[2])
  if (sine < 1e-6) return EMPTY_REQUEST
  const angle = Math.atan2(sine, Math.max(-1, Math.min(1, dot(from, to))))
  return { rotateDegrees: (angle * 180) / Math.PI, slideLdu: 0, axis: normalize(rotationAxis) }
}

/**
 * The operations a drag request would commit.
 *
 * Everything except a ball joint goes through `articulate`, so the kernel's
 * clamping — quarter-turn keying on an axle, the axial range on a prismatic
 * joint, "unknown freedoms drive nothing" — is applied in exactly one place and
 * applies identically to an agent call. A ball joint is the one freedom
 * `articulate` cannot express, because its axis is chosen by the drag rather
 * than fixed by the connector, so it is composed here and nowhere else.
 */
export function jointOperations(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: JointDragRequest,
): CadOperation[] {
  if (joint.joint.kind === 'spherical' && request.axis) {
    const radians = (request.rotateDegrees * Math.PI) / 180
    if (!radians) return []
    return joint.movingPartIds.flatMap((partId): CadOperation[] => {
      const part = document.parts[partId]
      if (!part) return []
      return [
        { type: 'part.transform', partId, transform: rotateWorld(part.transform, request.axis!, radians, joint.pivotLdu) },
      ]
    })
  }
  return articulate(document, joint, { rotateDegrees: request.rotateDegrees, slideLdu: request.slideLdu })
}

/**
 * The transforms a drag would produce, for rendering only.
 *
 * Deliberately returns a map rather than a document: the viewport draws parts
 * from `displayTransform` when one is supplied, so a preview costs a map lookup
 * per drawn part and touches nothing the kernel owns. There is no path from
 * here to `cadEngine`.
 */
export function previewTransforms(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: JointDragRequest,
): Map<string, Transform> {
  const preview = new Map<string, Transform>()
  for (const operation of jointOperations(document, joint, request)) {
    if (operation.type === 'part.transform') preview.set(operation.partId, operation.transform)
  }
  return preview
}

/** A stable, human-readable label for the single transaction a release commits. */
export function jointCommitLabel(joint: ArticulatedJoint, request: JointDragRequest): string {
  if (request.slideLdu && !request.rotateDegrees) return `Slide ${joint.family} joint ${request.slideLdu.toFixed(1)} LDU`
  if (request.rotateDegrees && !request.slideLdu) return `Rotate ${joint.family} joint ${request.rotateDegrees.toFixed(1)}°`
  return `Articulate ${joint.family} joint`
}
