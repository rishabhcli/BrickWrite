import { describe, expect, it } from 'vitest'
import { findArticulatedJoints, type ArticulatedJoint } from '../../cad/articulation'
import { CadEngine } from '../../cad/engine'
import { canonicalTransform, IDENTITY_BASIS, type Mat3 } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { CadOperation, ModelDocument, PartInstance, Vec3 } from '../../cad/types'
import {
  bearingAboutAxis,
  beginJointDrag,
  handlesFor,
  jointCommitLabel,
  jointOperations,
  perpendicularTo,
  previewTransforms,
  trackballPoint,
  updateJointDrag,
} from './jointDrag'
import type { Ray } from './sectionPlanes'

const part = (id: string, definitionId: string, position: [number, number, number], basis: Mat3 = IDENTITY_BASIS): PartInstance => ({
  id,
  definitionId,
  color: 71,
  transform: { position, basis },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

function assemble(parts: PartInstance[]): { engine: CadEngine; document: ModelDocument } {
  const engine = new CadEngine(createEmptyDocument())
  let revision = engine.getSnapshot().document.revision
  for (const item of parts) {
    const operations: CadOperation[] = [{ type: 'part.add', part: item }]
    const result = engine.execute(`Place ${item.id}`, operations, 'human', revision)
    if (result.ok) revision = result.value.resultRevision
  }
  return { engine, document: engine.getSnapshot().document }
}

/** 3937 is a hinge brick base, 3938 its top plate; a 1×1 plate rides the flap. */
const hinge = () =>
  assemble([
    part('base', '3937', [0, 0, 0]),
    part('flap', '3938', [0, 0, 0]),
    part('rider', '3024', [10, -8, 0]),
  ])

const jointOf = (document: ModelDocument): ArticulatedJoint => findArticulatedJoints(document, ['flap'])[0]

/** A ray aimed at a document point from a given direction. */
const rayTowards = (target: Vec3, from: Vec3): Ray => {
  const direction: Vec3 = [target[0] - from[0], target[1] - from[1], target[2] - from[2]]
  const length = Math.hypot(...direction)
  return { origin: from, direction: [direction[0] / length, direction[1] / length, direction[2] / length] }
}

describe('handles offered per freedom', () => {
  const stub = (kind: string, extra: Record<string, unknown> = {}): ArticulatedJoint => ({
    edgeId: 'e',
    joint: { kind, ...extra } as ArticulatedJoint['joint'],
    family: 'hinge',
    pivotLdu: [0, 0, 0],
    axis: [0, 1, 0],
    movingPartIds: [],
    anchoredPartIds: [],
    label: 'stub',
  })

  it('offers exactly the freedoms the joint has', () => {
    expect(handlesFor(stub('revolute', { axis: [0, 1, 0], continuous: true }))).toEqual(['rotate'])
    expect(handlesFor(stub('prismatic', { axis: [0, 1, 0], minLdu: -10, maxLdu: 10 }))).toEqual(['slide'])
    expect(handlesFor(stub('cylindrical', { axis: [0, 1, 0], minLdu: -10, maxLdu: 10, continuousRotation: true }))).toEqual([
      'rotate',
      'slide',
    ])
    expect(handlesFor(stub('spherical'))).toEqual(['ball'])
  })

  it('draws nothing for a freedom that is fixed or unmodelled', () => {
    // A handle that appears and then refuses to move is a promise the model
    // cannot keep, and the operator concludes the tool is broken.
    expect(handlesFor(stub('fixed'))).toEqual([])
    expect(handlesFor(stub('unknown'))).toEqual([])
  })
})

describe('drag geometry', () => {
  it('produces a stable in-plane reference for any axis', () => {
    for (const axis of [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0.577, 0.577, 0.577]] as Vec3[]) {
      const perpendicular = perpendicularTo(axis)
      const length = Math.hypot(...perpendicular)
      expect(length).toBeCloseTo(1, 6)
      const dot = axis[0] * perpendicular[0] + axis[1] * perpendicular[1] + axis[2] * perpendicular[2]
      expect(Math.abs(dot / Math.hypot(...axis))).toBeLessThan(1e-6)
    }
  })

  it('measures bearing about the axis, not about a world axis', () => {
    const joint = jointOf(hinge().document)
    const reference = perpendicularTo(joint.axis)
    const point: Vec3 = [
      joint.pivotLdu[0] + reference[0] * 20,
      joint.pivotLdu[1] + reference[1] * 20,
      joint.pivotLdu[2] + reference[2] * 20,
    ]
    expect(bearingAboutAxis(joint, point)).toBeCloseTo(0, 6)
  })

  it('projects a ray that misses the trackball onto its silhouette', () => {
    const joint = jointOf(hinge().document)
    // A cursor that leaves the handle must still control a ball joint.
    const far: Vec3 = [joint.pivotLdu[0] + 400, joint.pivotLdu[1], joint.pivotLdu[2] + 400]
    const point = trackballPoint(joint, { origin: far, direction: [0, 0, -1] }, 24)
    expect(point).not.toBeNull()
    expect(Math.hypot(...(point as Vec3))).toBeCloseTo(24, 4)
  })

  it('refuses a grab that carries no information rather than jumping later', () => {
    const joint: ArticulatedJoint = {
      ...jointOf(hinge().document),
      axis: [0, 1, 0],
      pivotLdu: [0, 0, 0],
    }
    // The two handles are conditioned oppositely, which is the useful part: the
    // view that kills one is the best possible view for the other.
    //
    // Looking straight down the axis, the slide arrow is a point on screen and
    // carries nothing, while the rotation ring is face-on and ideal.
    const downTheAxis = { origin: [0, 200, 0] as Vec3, direction: [0, -1, 0] as Vec3 }
    expect(beginJointDrag(joint, 'slide', downTheAxis)).toBeNull()
    expect(beginJointDrag(joint, 'rotate', downTheAxis)).not.toBeNull()

    // Looking across it, the ring is edge-on and carries nothing, while the
    // slide arrow spans the screen.
    const acrossTheAxis = { origin: [0, 0, 200] as Vec3, direction: [0, 0, -1] as Vec3 }
    expect(beginJointDrag(joint, 'rotate', acrossTheAxis)).toBeNull()
    expect(beginJointDrag(joint, 'slide', acrossTheAxis)).not.toBeNull()
  })
})

describe('a hinge drag', () => {
  it('turns the request into an angle about the joint axis', () => {
    const { document } = hinge()
    const joint = jointOf(document)
    const reference = perpendicularTo(joint.axis)
    const orthogonal = [
      joint.axis[1] * reference[2] - joint.axis[2] * reference[1],
      joint.axis[2] * reference[0] - joint.axis[0] * reference[2],
      joint.axis[0] * reference[1] - joint.axis[1] * reference[0],
    ] as Vec3

    const at = (angle: number): Vec3 => [
      joint.pivotLdu[0] + (Math.cos(angle) * reference[0] + Math.sin(angle) * orthogonal[0]) * 30,
      joint.pivotLdu[1] + (Math.cos(angle) * reference[1] + Math.sin(angle) * orthogonal[1]) * 30,
      joint.pivotLdu[2] + (Math.cos(angle) * reference[2] + Math.sin(angle) * orthogonal[2]) * 30,
    ]
    // Aim each ray along the axis so it meets the joint plane cleanly.
    const eye = (target: Vec3): Vec3 => [
      target[0] + joint.axis[0] * 200,
      target[1] + joint.axis[1] * 200,
      target[2] + joint.axis[2] * 200,
    ]

    const start = at(0)
    const grab = beginJointDrag(joint, 'rotate', rayTowards(start, eye(start)))!
    expect(grab).not.toBeNull()
    const end = at(Math.PI / 6)
    const request = updateJointDrag(joint, grab, rayTowards(end, eye(end)))
    expect(request.rotateDegrees).toBeCloseTo(30, 3)
    expect(request.slideLdu).toBe(0)
  })

  it('previews the whole rigid island, and only it', () => {
    const { document } = hinge()
    const joint = jointOf(document)
    const preview = previewTransforms(document, joint, { rotateDegrees: 30, slideLdu: 0 })
    // The flap and everything riding on it move; the anchor does not.
    expect(preview.has('flap')).toBe(true)
    expect(preview.has('rider')).toBe(true)
    expect(preview.has('base')).toBe(false)
  })

  it('writes nothing to the document while the drag is in progress', () => {
    // This is the invariant the whole design rests on: a preview is a map, and
    // there is no path from it to the kernel.
    const { engine, document } = hinge()
    const joint = jointOf(document)
    const before = JSON.stringify(document.parts)
    const revisionBefore = document.revision
    for (let step = 1; step <= 20; step += 1) {
      previewTransforms(document, joint, { rotateDegrees: step * 3, slideLdu: 0 })
    }
    expect(JSON.stringify(engine.getSnapshot().document.parts)).toBe(before)
    expect(engine.getSnapshot().document.revision).toBe(revisionBefore)
  })

  it('restores the exact starting transform when the drag is abandoned', () => {
    const { engine, document } = hinge()
    const joint = jointOf(document)
    const startPoses = new Map(
      joint.movingPartIds.map((id) => [id, canonicalTransform(document.parts[id].transform)] as const),
    )
    previewTransforms(document, joint, { rotateDegrees: 42.5, slideLdu: 0 })
    // Abandoning is dropping the map. Nothing to undo, because nothing was done.
    const after = engine.getSnapshot().document
    for (const [id, pose] of startPoses) {
      expect(canonicalTransform(after.parts[id].transform)).toBe(pose)
    }
  })

  it('commits one transaction carrying every moving part', () => {
    const { engine, document } = hinge()
    const joint = jointOf(document)
    const operations = jointOperations(document, joint, { rotateDegrees: 30, slideLdu: 0 })
    expect(operations.length).toBe(joint.movingPartIds.length)
    const transactionsBefore = engine.getSnapshot().transactions.length
    const result = engine.execute(jointCommitLabel(joint, { rotateDegrees: 30, slideLdu: 0 }), operations, 'human', document.revision)
    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().transactions.length).toBe(transactionsBefore + 1)
  })

  it('labels the commit by what the drag actually did', () => {
    const joint = jointOf(hinge().document)
    expect(jointCommitLabel(joint, { rotateDegrees: 30, slideLdu: 0 })).toMatch(/Rotate .* 30\.0°/)
    expect(jointCommitLabel(joint, { rotateDegrees: 0, slideLdu: 4 })).toMatch(/Slide .* 4\.0 LDU/)
  })
})

describe('ball joints', () => {
  it('rotates about the axis the drag chooses, which no fixed-axis path can express', () => {
    const { document } = hinge()
    const base = jointOf(document)
    const ball: ArticulatedJoint = { ...base, joint: { kind: 'spherical' } }
    const operations = jointOperations(document, ball, {
      rotateDegrees: 25,
      slideLdu: 0,
      axis: [0, 0, 1],
    })
    expect(operations.length).toBe(ball.movingPartIds.length)
    const moved = operations.find((operation) => operation.type === 'part.transform' && operation.partId === 'flap')
    expect(moved).toBeDefined()
  })

  it('drives nothing when the trackball produced no rotation', () => {
    const { document } = hinge()
    const ball: ArticulatedJoint = { ...jointOf(document), joint: { kind: 'spherical' } }
    expect(jointOperations(document, ball, { rotateDegrees: 0, slideLdu: 0, axis: [0, 0, 1] })).toEqual([])
  })
})
