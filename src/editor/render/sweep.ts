/**
 * Swept collision along a joint's motion.
 *
 * Checking only the pose the operator has dragged to is not enough, and the
 * failure is specific: a door that is clear at 10° and clear at 170° is not
 * clear, because it passed through the frame at 90°. A tool that reports the
 * endpoint as valid has told the operator something false about a mechanism,
 * which is worse than saying nothing.
 *
 * So the drag sweeps: it samples the path, finds the first sample that blocks,
 * then bisects between the last clean sample and it to report the travel that is
 * actually permitted. Both numbers are surfaced live, because "you can open this
 * 62° before the hinge hits the wall" is the answer the operator wants, and
 * "collision" is not.
 *
 * Correctness comes from the kernel: every sample is judged by `findCollisions`,
 * with the same mating-clearance allowances and the same triangle confirmation
 * that validation uses. A sweep that used its own looser test would let a drag
 * commit a pose validation then flags, which is exactly the kind of disagreement
 * that makes a CAD tool untrustworthy.
 *
 * Affordability comes from *scope*, not from a cheaper test. The sweep runs
 * against a sub-document holding the moving island plus only the parts whose
 * bounds fall inside the island's swept envelope — tens of parts on a real
 * model, rather than thousands — so the kernel's exact rules run on a problem
 * small enough to solve between two pointer moves.
 */

import type { ArticulatedJoint } from '../../cad/articulation'
import { findCollisions, residentGeometryProvider, type CollisionContact, type GeometryProvider } from '../../cad/collision'
import { getPartBounds } from '../../cad/geometry'
import type { ModelDocument, PartInstance, Transform, Vec3 } from '../../cad/types'
import { jointOperations, type JointDragRequest } from './jointDrag'

export interface SweepBlock {
  readonly partA: string
  readonly partB: string
  readonly certainty: CollisionContact['certainty']
  readonly pointLdu?: Vec3
}

export interface SweepResult {
  /** Fraction of the requested motion that is collision-free, 0…1. */
  readonly permissibleFraction: number
  /** The same, in the joint's own units. */
  readonly permissible: JointDragRequest
  /** The pair that stops the motion, or null when the whole path is clear. */
  readonly blocking: SweepBlock | null
  /** Samples actually evaluated, so a caller can report the resolution used. */
  readonly samples: number
  /** True when some sample was judged from bounding boxes alone. */
  readonly unverified: boolean
}

const CLEAR: SweepResult = {
  permissibleFraction: 1,
  permissible: { rotateDegrees: 0, slideLdu: 0 },
  blocking: null,
  samples: 0,
  unverified: false,
}

const scaleRequest = (request: JointDragRequest, fraction: number): JointDragRequest => ({
  rotateDegrees: request.rotateDegrees * fraction,
  slideLdu: request.slideLdu * fraction,
  axis: request.axis,
})

/**
 * The island's bounding box over the whole requested motion.
 *
 * Sampled rather than solved: an exact swept volume for a rotating rigid body
 * is a surface of revolution, and the box that contains it is what the culling
 * step needs. Sampling the same path the sweep will walk guarantees the envelope
 * contains every pose the sweep tests, which is the only property required.
 */
function sweptEnvelope(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: JointDragRequest,
  samples: number,
): { min: Vec3; max: Vec3 } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let measured = false
  const expand = (part: PartInstance, transform: Transform) => {
    const bounds = getPartBounds({ ...part, transform })
    if (!bounds.measured) return
    measured = true
    for (let axis = 0; axis < 3; axis += 1) {
      if (bounds.min[axis] < min[axis]) min[axis] = bounds.min[axis]
      if (bounds.max[axis] > max[axis]) max[axis] = bounds.max[axis]
    }
  }
  for (let step = 0; step <= samples; step += 1) {
    const fraction = step / samples
    const moved = new Map<string, Transform>()
    for (const operation of jointOperations(document, joint, scaleRequest(request, fraction))) {
      if (operation.type === 'part.transform') moved.set(operation.partId, operation.transform)
    }
    for (const partId of joint.movingPartIds) {
      const part = document.parts[partId]
      if (!part) continue
      expand(part, moved.get(partId) ?? part.transform)
    }
  }
  return measured ? { min: min as Vec3, max: max as Vec3 } : null
}

const boxesOverlap = (
  aMin: Vec3,
  aMax: Vec3,
  bMin: readonly number[],
  bMax: readonly number[],
  margin: number,
): boolean =>
  aMin[0] - margin <= bMax[0] &&
  aMax[0] + margin >= bMin[0] &&
  aMin[1] - margin <= bMax[1] &&
  aMax[1] + margin >= bMin[1] &&
  aMin[2] - margin <= bMax[2] &&
  aMax[2] + margin >= bMin[2]

/**
 * A cut-down document holding only what the sweep can possibly touch.
 *
 * Connections are carried across for the surviving parts because the mating
 * clearance depends on them: drop the edge between a hinge's two halves and the
 * kernel reports the hinge itself as a collision at every angle, which would
 * make the whole feature report a permanent false block.
 */
export function sweepNeighbourhood(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: JointDragRequest,
  options: { readonly envelopeSamples?: number; readonly marginLdu?: number } = {},
): { document: ModelDocument; island: string[] } | null {
  const envelope = sweptEnvelope(document, joint, request, options.envelopeSamples ?? 6)
  if (!envelope) return null
  const margin = options.marginLdu ?? 4
  const island = joint.movingPartIds.filter((partId) => Boolean(document.parts[partId]))
  const keep = new Set(island)
  for (const part of Object.values(document.parts)) {
    if (keep.has(part.id)) continue
    const bounds = getPartBounds(part)
    if (!bounds.measured) continue
    if (boxesOverlap(envelope.min, envelope.max, bounds.min, bounds.max, margin)) keep.add(part.id)
  }
  const parts: Record<string, PartInstance> = {}
  for (const partId of keep) parts[partId] = document.parts[partId]
  const connections: ModelDocument['connections'] = {}
  for (const [edgeId, edge] of Object.entries(document.connections)) {
    if (keep.has(edge.a.partId) && keep.has(edge.b.partId)) connections[edgeId] = edge
  }
  return { document: { ...document, parts, connections }, island }
}

export interface SweepOptions {
  /** Coarse samples along the path, excluding the start. */
  readonly samples?: number
  /** Bisection refinements between the last clean and first blocked sample. */
  readonly refinements?: number
  readonly provide?: GeometryProvider
}

/**
 * Walks the requested motion and reports where it is stopped.
 *
 * The start pose is deliberately *not* treated as a blocker: a model that is
 * already in contact — two plates resting against each other, a wheel touching
 * the ground — would otherwise report zero permissible travel in every
 * direction and make every joint appear seized. Contacts present at fraction 0
 * are subtracted from every later sample, so the sweep reports the pairs the
 * motion *introduces*.
 */
export function sweepJoint(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: JointDragRequest,
  options: SweepOptions = {},
): SweepResult {
  if (!request.rotateDegrees && !request.slideLdu) return CLEAR
  const scope = sweepNeighbourhood(document, joint, request)
  if (!scope) return CLEAR

  const provide = options.provide ?? residentGeometryProvider
  const samples = Math.max(2, options.samples ?? 12)
  const refinements = Math.max(0, options.refinements ?? 6)
  const island = scope.island
  let unverified = false

  const contactsAt = (fraction: number): CollisionContact[] => {
    const parts = { ...scope.document.parts }
    if (fraction !== 0) {
      for (const operation of jointOperations(document, joint, scaleRequest(request, fraction))) {
        if (operation.type !== 'part.transform') continue
        const part = parts[operation.partId]
        if (part) parts[operation.partId] = { ...part, transform: operation.transform }
      }
    }
    const contacts = findCollisions({ ...scope.document, parts }, { onlyPartIds: island, provide })
    if (contacts.some((contact) => contact.certainty === 'unknown')) unverified = true
    return contacts
  }

  const key = (contact: CollisionContact) =>
    contact.partA < contact.partB ? `${contact.partA}|${contact.partB}` : `${contact.partB}|${contact.partA}`
  const preexisting = new Set(contactsAt(0).map(key))
  const introduced = (contacts: CollisionContact[]) => contacts.filter((contact) => !preexisting.has(key(contact)))

  let lastClean = 0
  let firstBlocked = -1
  let blocking: CollisionContact | null = null
  let evaluated = 1

  for (let step = 1; step <= samples; step += 1) {
    const fraction = step / samples
    evaluated += 1
    const contacts = introduced(contactsAt(fraction))
    if (!contacts.length) {
      lastClean = fraction
      continue
    }
    firstBlocked = fraction
    blocking = contacts[0]
    break
  }

  if (firstBlocked < 0) {
    return {
      permissibleFraction: 1,
      permissible: request,
      blocking: null,
      samples: evaluated,
      unverified,
    }
  }

  // Refine the boundary. The coarse scan says the block appears somewhere in
  // (lastClean, firstBlocked]; bisection narrows that to the resolution the
  // readout actually claims, so "62°" means 62° rather than "somewhere in the
  // 15° bucket that contained it".
  let low = lastClean
  let high = firstBlocked
  for (let iteration = 0; iteration < refinements; iteration += 1) {
    const middle = (low + high) / 2
    evaluated += 1
    const contacts = introduced(contactsAt(middle))
    if (contacts.length) {
      high = middle
      blocking = contacts[0]
    } else {
      low = middle
    }
  }

  return {
    permissibleFraction: low,
    permissible: scaleRequest(request, low),
    blocking: blocking
      ? {
          partA: blocking.partA,
          partB: blocking.partB,
          certainty: blocking.certainty,
          pointLdu: blocking.pointLdu,
        }
      : null,
    samples: evaluated,
    unverified,
  }
}

/**
 * A short line an operator can read at a glance during the drag.
 *
 * Names the *pair*, not just "collision": which two parts stop the motion is the
 * information that tells them what to change.
 */
export function describeSweep(result: SweepResult, request: JointDragRequest): string {
  if (!result.blocking) return 'Clear through the full motion'
  const units = request.slideLdu && !request.rotateDegrees
    ? `${result.permissible.slideLdu.toFixed(1)} LDU`
    : `${result.permissible.rotateDegrees.toFixed(1)}°`
  const qualifier = result.blocking.certainty === 'unknown' ? ' (bounding boxes only)' : ''
  return `Blocked by ${result.blocking.partA} / ${result.blocking.partB} after ${units}${qualifier}`
}
