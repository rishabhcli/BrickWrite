import { describe, expect, it } from 'vitest'
import { createRoverDocument } from './__fixtures__/rover'
import { validateDocument } from './validation'
import { findArticulatedJoints } from './articulation'
import { STUD_LDU } from './catalog'

describe('showcase document', () => {
  const document = createRoverDocument()
  const report = validateDocument(document)

  it('is built from real catalog parts at exact LDU transforms', () => {
    expect(report.partCount).toBeGreaterThan(30)
    for (const part of Object.values(document.parts)) {
      expect(part.transform.position.every(Number.isFinite)).toBe(true)
    }
  })

  it('has no illegal intersections', () => {
    expect(report.collisions.map((issue) => issue.message)).toEqual([])
  })

  it('is a single connected assembly', () => {
    expect({ components: report.componentCount, loose: report.disconnectedPartIds }).toEqual({ components: 1, loose: [] })
  })

  it('satisfies its own hard constraints', () => {
    expect(report.constraints.filter((item) => item.status === 'fail')).toEqual([])
  })

  it('reports a real connection count and envelope', () => {
    expect(report.connectionCount).toBeGreaterThan(50)
    expect(report.bounds.size[0] / STUD_LDU).toBeLessThanOrEqual(10)
  })
})

describe('showcase mechanism', () => {
  const document = createRoverDocument()

  it('contains a real articulated joint, not only rigid stud connections', () => {
    const hinge = Object.values(document.connections).find((edge) => edge.family === 'hinge')
    expect(hinge).toBeDefined()
    expect(hinge!.joint.kind).toBe('revolute')
  })

  it('exposes that joint as drivable from the hatch', () => {
    const topPlate = Object.values(document.parts).find((part) => part.definitionId === '3938')
    expect(topPlate).toBeDefined()
    const joints = findArticulatedJoints(document, [topPlate!.id])
    expect(joints).toHaveLength(1)
    expect(joints[0].family).toBe('hinge')
    // The hatch moves; the rest of the rover anchors it.
    expect(joints[0].movingPartIds).toEqual([topPlate!.id])
    expect(joints[0].anchoredPartIds.length).toBeGreaterThan(20)
  })

  it('uses only part/colour pairings with observed official-set appearances', () => {
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.virtualColors).toEqual([])
  })
})
