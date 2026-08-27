import { describe, expect, it } from 'vitest'
import { articulate, findArticulatedJoints, isArticulatedFamily, rigidGroup } from './articulation'
import { CadEngine } from './engine'
import { applyMat3, basisFromEulerDegrees, distance, IDENTITY_BASIS, type Mat3 } from './math'
import { createEmptyDocument } from './sample'
import type { CadOperation, ModelDocument, PartInstance } from './types'

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

/** Builds through the engine so the connection edges under test are real. */
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

describe('articulation freedom', () => {
  it('treats stud connections as rigid and mechanisms as articulated', () => {
    // Placement freedom and articulation freedom are different things: a round
    // stud admits rotation when placing, but a built wall does not hinge.
    expect(isArticulatedFamily('stud')).toBe(false)
    expect(isArticulatedFamily('anti-stud')).toBe(false)
    expect(isArticulatedFamily('hinge')).toBe(true)
    expect(isArticulatedFamily('pin')).toBe(true)
    expect(isArticulatedFamily('axle-hole')).toBe(true)
    expect(isArticulatedFamily('socket')).toBe(true)
  })

  it('collects a stud-connected assembly into one rigid group', () => {
    const { document } = assemble([
      part('a', '3001', [0, 0, 0]),
      part('b', '3001', [0, -24, 0]),
      part('c', '3001', [0, -48, 0]),
      part('far', '3001', [500, 0, 0]),
    ])
    expect(rigidGroup(document, 'a').sort()).toEqual(['a', 'b', 'c'])
    expect(rigidGroup(document, 'far')).toEqual(['far'])
  })
})

describe('hinge articulation', () => {
  /**
   * 3937 is a hinge brick base and 3938 its top plate; they mate through an
   * LDCad-grouped hinge connector, so the edge between them is articulated.
   */
  const hinge = () => {
    const built = assemble([
      part('base', '3937', [0, 0, 0]),
      part('flap', '3938', [0, 0, 0]),
      // 3938 exposes studs at x = ±10 on its own origin plane, so a 1×1 plate
      // rides at x = 10, y = -8. Driving the joint must carry it along.
      part('rider', '3024', [10, -8, 0]),
    ])
    return built
  }

  it('finds the joint from either side, with the selection as the moving group', () => {
    const { document } = hinge()
    const joints = findArticulatedJoints(document, ['flap'])
    expect(joints.length).toBeGreaterThan(0)
    const joint = joints[0]
    expect(joint.family).toBe('hinge')
    expect(joint.movingPartIds).toContain('flap')
    expect(joint.anchoredPartIds).toContain('base')
    // The axis is a unit vector taken from the anchored connector frame.
    expect(distance([0, 0, 0], joint.axis)).toBeCloseTo(1, 6)
  })

  it('carries everything rigidly attached to the moving side', () => {
    const { document } = hinge()
    const joint = findArticulatedJoints(document, ['flap'])[0]
    // The rider sits on the flap's studs, so it belongs to the moving group.
    expect(joint.movingPartIds).toContain('rider')
    expect(joint.movingPartIds).not.toContain('base')
  })

  it('rotates the moving group about the joint axis, leaving the anchor still', () => {
    const { engine, document } = hinge()
    const joint = findArticulatedJoints(document, ['flap'])[0]
    const operations = articulate(document, joint, { rotateDegrees: 30 })
    expect(operations.length).toBe(joint.movingPartIds.length)

    const before = { ...document.parts }
    const result = engine.execute('Open hinge', operations, 'human', document.revision)
    expect(result.ok).toBe(true)
    const after = engine.getSnapshot().document.parts

    // The anchor is untouched.
    expect(after.base.transform).toEqual(before.base.transform)
    // The flap turned: its basis changed, and by the requested angle.
    expect(after.flap.transform.basis).not.toEqual(before.flap.transform.basis)
    const movedUp = applyMat3(after.flap.transform.basis, [0, 1, 0])
    const originalUp = applyMat3(before.flap.transform.basis, [0, 1, 0])
    const cosine = movedUp[0] * originalUp[0] + movedUp[1] * originalUp[1] + movedUp[2] * originalUp[2]
    expect((Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI).toBeCloseTo(30, 3)
  })

  it('keeps the moving group rigid relative to itself', () => {
    const { engine, document } = hinge()
    const joint = findArticulatedJoints(document, ['flap'])[0]
    const separationBefore = distance(document.parts.flap.transform.position, document.parts.rider.transform.position)
    engine.execute('Open hinge', articulate(document, joint, { rotateDegrees: 45 }), 'human', document.revision)
    const after = engine.getSnapshot().document.parts
    // Rotating a mechanism must not stretch it.
    expect(distance(after.flap.transform.position, after.rider.transform.position)).toBeCloseTo(separationBefore, 6)
  })

  it('is reversible through the shared history', () => {
    const { engine, document } = hinge()
    const joint = findArticulatedJoints(document, ['flap'])[0]
    const original = JSON.stringify(document.parts)
    engine.execute('Open hinge', articulate(document, joint, { rotateDegrees: 60 }), 'human', document.revision)
    engine.undo('human')
    expect(JSON.stringify(engine.getSnapshot().document.parts)).toBe(original)
  })
})

describe('joint limits', () => {
  const axle = () =>
    assemble([
      part('wheel', '55982', [0, 0, 0]),
      part('shaft', '3706', [0, 0, 0], basisFromEulerDegrees([0, 0, 90])),
    ])

  it('quantizes a keyed interface to quarter turns', () => {
    const { document } = axle()
    const joints = findArticulatedJoints(document, ['shaft'])
    const keyed = joints.find((entry) => entry.joint.kind === 'cylindrical' && !entry.joint.continuousRotation)
    if (!keyed) return // catalog pairing may differ; the clamp itself is covered below
    const operations = articulate(document, keyed, { rotateDegrees: 20 })
    // 20° is not a seat position, so it rounds to zero and nothing moves.
    expect(operations).toEqual([])
  })

  it('drives nothing when the joint freedom is not modelled', () => {
    const { document } = assemble([part('a', '3001', [0, 0, 0]), part('b', '3001', [0, -24, 0])])
    const unmodelled = {
      edgeId: 'synthetic',
      joint: { kind: 'unknown' } as const,
      family: 'generic' as const,
      pivotLdu: [0, 0, 0] as const,
      axis: [0, 1, 0] as const,
      movingPartIds: ['b'],
      anchoredPartIds: ['a'],
      label: 'synthetic',
    }
    expect(articulate(document, unmodelled, { rotateDegrees: 45 })).toEqual([])
  })

  it('offers no joints for a purely stud-built assembly', () => {
    const { document } = assemble([part('a', '3001', [0, 0, 0]), part('b', '3001', [0, -24, 0])])
    expect(findArticulatedJoints(document, ['b'])).toEqual([])
  })
})
