import { catalog } from './catalog'
import { featureFrame } from './connections'
import {
  composeTransform,
  clamp,
  degreesToRadians,
  rotateWorld,
  type RigidTransform,
  type Vec3,
} from './math'
import type { CadOperation, ConnectionEdge, ConnectionFamily, JointFreedom, ModelDocument } from './types'

/**
 * Articulation: moving a mechanism as a mechanism.
 *
 * The connection graph already records a joint freedom on every edge, but that
 * freedom describes two different things and they must not be conflated:
 *
 *   *Placement* freedom is what the snap solver uses — a round stud admits any
 *   rotation about its axis, which is why a 1×1 plate can be turned on its stud.
 *
 *   *Articulation* freedom is what a built model retains. A stud connection is
 *   rigid once assembled: friction holds it, and nothing about a finished brick
 *   wall rotates. Only interfaces designed to move — hinges, pins in holes,
 *   axles, bars in clips, ball joints — articulate.
 *
 * Treating stud connections as rigid here is what makes "rotate this hinge" move
 * the whole flap rather than peeling one plate off the assembly.
 */

const ARTICULATED_FAMILIES: ReadonlySet<ConnectionFamily> = new Set<ConnectionFamily>([
  'hinge',
  'pin',
  'pin-hole',
  'axle',
  'axle-hole',
  'bar',
  'clip',
  'ball',
  'socket',
])

export const isArticulatedFamily = (family: ConnectionFamily) => ARTICULATED_FAMILIES.has(family)

export interface ArticulatedJoint {
  readonly edgeId: string
  readonly joint: JointFreedom
  readonly family: ConnectionFamily
  /** Pivot and axis in document space, taken from the anchored side's frame. */
  readonly pivotLdu: Vec3
  readonly axis: Vec3
  /** Parts that move together when this joint is driven. */
  readonly movingPartIds: readonly string[]
  /** Parts that stay put. */
  readonly anchoredPartIds: readonly string[]
  readonly label: string
}

/**
 * Adjacency over the edges that are rigid for articulation purposes.
 *
 * Memoized on document identity, which is sound because the kernel treats a
 * document as immutable per revision. Rebuilding it per call was quadratic in
 * disguise: `findArticulatedJoints` seeds a rigid walk from every selected
 * part, so selecting a stamped city block rebuilt a 1,464-node adjacency map
 * seven hundred times and put **7.2 seconds** into a single commit. Measured
 * with the browser's own profiler, not guessed at.
 */
const adjacencyCache = new WeakMap<ModelDocument, Map<string, Set<string>>>()

function rigidAdjacency(document: ModelDocument): Map<string, Set<string>> {
  const cached = adjacencyCache.get(document)
  if (cached) return cached
  const adjacency = new Map<string, Set<string>>(Object.keys(document.parts).map((id) => [id, new Set<string>()]))
  for (const edge of Object.values(document.connections)) {
    if (isArticulatedFamily(edge.family)) continue
    adjacency.get(edge.a.partId)?.add(edge.b.partId)
    adjacency.get(edge.b.partId)?.add(edge.a.partId)
  }
  adjacencyCache.set(document, adjacency)
  return adjacency
}

/** Parts rigidly connected to `seed`, i.e. reachable without crossing a joint. */
export function rigidGroup(document: ModelDocument, seed: string): string[] {
  return walkRigid(rigidAdjacency(document), seed)
}

function walkRigid(adjacency: Map<string, Set<string>>, seed: string): string[] {
  const seen = new Set<string>([seed])
  const queue = [seed]
  while (queue.length) {
    const current = queue.shift()!
    for (const neighbour of adjacency.get(current) ?? []) {
      if (seen.has(neighbour)) continue
      seen.add(neighbour)
      queue.push(neighbour)
    }
  }
  return [...seen]
}

/** World frame of one endpoint's connector. */
function endpointFrame(document: ModelDocument, endpoint: ConnectionEdge['a']): RigidTransform | null {
  const part = document.parts[endpoint.partId]
  const definition = part ? catalog.get(part.definitionId) : undefined
  const feature = definition?.connectors.find((candidate) => candidate.id === endpoint.featureId)
  if (!part || !feature) return null
  return composeTransform(part.transform, featureFrame(feature))
}

const describeJoint = (joint: JointFreedom): string => {
  switch (joint.kind) {
    case 'revolute':
      return joint.continuous ? 'free rotation' : `${joint.stepDegrees ?? 90}° steps`
    case 'cylindrical':
      return joint.continuousRotation ? 'rotate and slide' : 'keyed, slides'
    case 'prismatic':
      return 'slides'
    case 'spherical':
      return 'ball joint'
    default:
      return 'freedom not modelled'
  }
}

/**
 * Articulated joints that would move the selection.
 *
 * The selection's rigid group becomes the moving side and the rest of the model
 * the anchor, so driving a joint carries everything attached to the flap. A joint
 * whose two sides are in the *same* rigid group is skipped: a closed loop cannot
 * articulate without deforming, and pretending otherwise would silently tear the
 * assembly apart.
 */
export function findArticulatedJoints(document: ModelDocument, selectedPartIds: readonly string[]): ArticulatedJoint[] {
  if (!selectedPartIds.length) return []
  const adjacency = rigidAdjacency(document)
  // One walk per part that is not already covered. Seeding from a part already
  // inside the group re-walks the same component, which on a large selection is
  // the whole model over and over.
  const group = new Set<string>()
  for (const partId of selectedPartIds) {
    if (group.has(partId)) continue
    for (const member of walkRigid(adjacency, partId)) group.add(member)
  }

  const joints: ArticulatedJoint[] = []
  for (const edge of Object.values(document.connections)) {
    if (!isArticulatedFamily(edge.family)) continue
    if (edge.joint.kind === 'fixed') continue

    const aInside = group.has(edge.a.partId)
    const bInside = group.has(edge.b.partId)
    if (aInside === bInside) continue // both sides move, or neither does

    const movingEndpoint = aInside ? edge.a : edge.b
    const anchorEndpoint = aInside ? edge.b : edge.a
    const frame = endpointFrame(document, anchorEndpoint)
    if (!frame) continue

    const movingGroup = new Set(walkRigid(adjacency, movingEndpoint.partId))
    const anchored = Object.keys(document.parts).filter((id) => !movingGroup.has(id))
    if (!anchored.length) continue

    const definition = catalog.get(document.parts[movingEndpoint.partId]?.definitionId ?? '')
    joints.push({
      edgeId: edge.id,
      joint: edge.joint,
      family: edge.family,
      pivotLdu: frame.position,
      // The joint axis is the connector frame's local +Y in document space.
      axis: [frame.basis[1], frame.basis[4], frame.basis[7]],
      movingPartIds: [...movingGroup],
      anchoredPartIds: anchored,
      label: `${definition?.name ?? movingEndpoint.partId} · ${edge.family} · ${describeJoint(edge.joint)}`,
    })
  }
  return joints
}

export interface ArticulationRequest {
  /** Rotation about the joint axis, in degrees. */
  readonly rotateDegrees?: number
  /** Translation along the joint axis, in LDU. */
  readonly slideLdu?: number
}

/**
 * Operations that drive a joint, clamped to what the joint actually permits.
 *
 * A keyed axle only seats at quarter turns, a prismatic joint has an axial
 * range, and a joint whose freedom is unmodelled admits nothing. Clamping here
 * rather than in the UI means the same limits apply to an agent call.
 */
export function articulate(
  document: ModelDocument,
  joint: ArticulatedJoint,
  request: ArticulationRequest,
): CadOperation[] {
  const freedom = joint.joint
  let degrees = request.rotateDegrees ?? 0
  let slide = request.slideLdu ?? 0

  switch (freedom.kind) {
    case 'revolute':
      slide = 0
      if (!freedom.continuous) {
        const step = freedom.stepDegrees ?? 90
        degrees = Math.round(degrees / step) * step
      }
      // LDCad does not publish angular limits, so none are enforced. A hinge
      // that physically stops at 180° will happily pass that here; the collision
      // kernel is what catches the result.
      break
    case 'cylindrical':
      if (!freedom.continuousRotation) degrees = Math.round(degrees / 90) * 90
      slide = clamp(slide, freedom.minLdu, freedom.maxLdu)
      break
    case 'prismatic':
      degrees = 0
      slide = clamp(slide, freedom.minLdu, freedom.maxLdu)
      break
    case 'spherical':
      slide = 0
      break
    default:
      // Freedom is not modelled, so nothing is driven rather than guessed.
      return []
  }

  if (!degrees && !slide) return []

  const radians = degreesToRadians(degrees)
  const offset: Vec3 = [joint.axis[0] * slide, joint.axis[1] * slide, joint.axis[2] * slide]

  return joint.movingPartIds.flatMap((partId): CadOperation[] => {
    const part = document.parts[partId]
    if (!part) return []
    const rotated = radians ? rotateWorld(part.transform, joint.axis, radians, joint.pivotLdu) : part.transform
    const moved: RigidTransform = slide
      ? {
          position: [
            rotated.position[0] + offset[0],
            rotated.position[1] + offset[1],
            rotated.position[2] + offset[2],
          ],
          basis: rotated.basis,
        }
      : rotated
    return [{ type: 'part.transform', partId, transform: moved }]
  })
}
