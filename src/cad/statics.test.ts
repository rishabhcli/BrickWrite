import { describe, expect, it } from 'vitest'
import { planEnclosure } from './assembly'
import { catalog, STUD_LDU } from './catalog'
import { CadEngine } from './engine'
import { IDENTITY_BASIS, transformPoint } from './math'
import { createBlankDocument } from './sample'
import {
  ABS_GRAMS_PER_LDU3,
  analyseStatics,
  centroidOf,
  computeMass,
  computeOverloads,
  computeSupport,
  convexHull,
  distanceInsidePolygon,
  horizontalDistance,
  maxPairwiseDistance,
  overhangPenaltyGrams,
  hangingArmIssues,
  MIN_RESISTING_ARM_LDU,
  clutchCapacityWeight,
  partMassGrams,
} from './statics'
import { findSnapCandidates } from './snapping'
import type { CadOperation, ModelDocument, PartInstance } from './types'

/**
 * Statics is the analysis collision cannot do: a model can be geometrically
 * perfect and still topple, or hang off two studs. These tests check the
 * physics against arrangements whose answer is known by construction.
 */

const part = (id: string, definitionId: string, position: [number, number, number]): PartInstance => ({
  id,
  definitionId,
  color: 71,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'main',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const doc = (...parts: PartInstance[]): ModelDocument => {
  const base = createBlankDocument('Statics')
  return { ...base, parts: Object.fromEntries(parts.map((item) => [item.id, item])) }
}

describe('mass is measured, not estimated', () => {
  it('reads each part’s exact compiled volume', () => {
    const brick = catalog.get('3001')!
    expect(brick.dimensions?.volumeLdu3).toBeGreaterThan(0)
    // A 2 x 4 brick is mostly hollow: well under half its bounding box.
    const box = brick.dimensions!.ldu[0] * brick.dimensions!.ldu[1] * brick.dimensions!.ldu[2]
    expect(brick.dimensions!.volumeLdu3!).toBeLessThan(box * 0.6)
    expect(partMassGrams(part('a', '3001', [0, 0, 0]))).toBeCloseTo(brick.dimensions!.volumeLdu3! * ABS_GRAMS_PER_LDU3, 6)
  })

  it('lands in the right neighbourhood of a real brick', () => {
    // A moulded 2 x 4 is about 2.3 g. LDraw models an idealized solid, so this
    // runs heavy — the point of the check is that it is grams, not kilograms
    // or milligrams, and that the documented bias has not silently grown.
    const grams = partMassGrams(part('a', '3001', [0, 0, 0]))!
    expect(grams).toBeGreaterThan(2.2)
    expect(grams).toBeLessThan(2.8)
  })

  it('reports a part it cannot measure rather than assuming one', () => {
    const unmeasurable = part('x', '__not_a_part__', [0, 0, 0])
    expect(partMassGrams(unmeasurable)).toBeNull()
    const report = computeMass(doc(part('a', '3001', [0, 0, 0]), unmeasurable))
    expect(report.measuredParts).toBe(1)
    expect(report.unmeasuredParts).toBe(1)
    expect(analyseStatics(doc(part('a', '3001', [0, 0, 0]), unmeasurable)).coverage).toBe(0.5)
  })

  it('puts the centre of mass between two equal parts', () => {
    const report = computeMass(doc(part('a', '3001', [0, 0, 0]), part('b', '3001', [200, 0, 0])))
    expect(report.centreLdu[0]).toBeCloseTo(100, 6)
    expect(report.grams).toBeCloseTo(partMassGrams(part('a', '3001', [0, 0, 0]))! * 2, 6)
  })

  it('pulls the centre of mass toward the heavier side', () => {
    // A brick against a plate: the centre of mass sits nearer the brick.
    const report = computeMass(doc(part('a', '3001', [0, 0, 0]), part('b', '3024', [200, 0, 0])))
    expect(report.centreLdu[0]).toBeGreaterThan(0)
    expect(report.centreLdu[0]).toBeLessThan(100)
  })
})

describe('support polygon', () => {
  it('hulls a scatter of points and ignores the interior ones', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])
    expect(hull).toHaveLength(4)
    expect(hull).not.toContainEqual([5, 5])
  })

  it('measures distance inside and outside a polygon with the right sign', () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(distanceInsidePolygon(square, [5, 5])).toBeCloseTo(5, 6)
    expect(distanceInsidePolygon(square, [1, 5])).toBeCloseTo(1, 6)
    expect(distanceInsidePolygon(square, [-3, 5])).toBeCloseTo(-3, 6)
  })

  it('calls a plain wall stable, with the centre of mass over its base', () => {
    const plan = planEnclosure({
      origin: [0, 0, 0], color: 71, subassemblyId: 'main', stepId: 'step_1', actor: 'human',
      widthStuds: 12, footprintDepthStuds: 10, courses: 4,
    })
    const engine = new CadEngine(createBlankDocument('Box'))
    engine.execute('box', plan.operations as CadOperation[], 'human', engine.getSnapshot().document.revision)
    const report = analyseStatics(engine.getSnapshot().document)
    expect(report.support?.stable).toBe(true)
    // The centre of a symmetric box is its middle, well inside the footprint.
    expect(report.support!.marginLdu).toBeGreaterThan(4 * STUD_LDU)
    expect(report.mass.centreLdu[0]).toBeCloseTo(6 * STUD_LDU, 0)
  })

  it('calls a leaning stack unstable when its mass moves past the base', () => {
    // A one-stud base with a long arm cantilevered off the top of it: the
    // centre of mass leaves the footprint and the model tips.
    const parts = [part('base', '3005', [0, -24, 0])]
    for (let index = 1; index <= 8; index += 1) {
      parts.push(part(`arm${index}`, '3005', [index * STUD_LDU, -48, 0]))
    }
    const report = analyseStatics(doc(...parts))
    expect(report.support).not.toBeNull()
    expect(report.support!.stable).toBe(false)
    expect(report.support!.marginLdu).toBeLessThan(0)
  })

  it('has nothing to say about an empty document', () => {
    expect(computeSupport(createBlankDocument('Empty'), computeMass(createBlankDocument('Empty')))).toBeNull()
  })
})

describe('what the studs are carrying', () => {
  it('finds no overload in a stack that is only carrying itself', () => {
    const report = analyseStatics(doc(
      part('a', '3001', [0, 0, 0]),
      part('b', '3001', [0, -24, 0]),
      part('c', '3001', [0, -48, 0]),
    ))
    expect(report.overloaded).toEqual([])
    expect(report.unsupportedPartIds).toEqual([])
  })

  it('leaves parts alone that are resting on the ground, however unattached', () => {
    // Two bricks side by side on the ground touch nothing but the table. That
    // is not a defect, and reporting it as one would bury the real cases.
    const report = analyseStatics(doc(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0])))
    expect(report.unsupportedPartIds).toEqual([])
  })

  it('reports a cluster the load path from the ground never reaches', () => {
    // Two bricks mated to each other in mid-air, with nothing under them. They
    // are a perfectly valid connected structure and they are not standing on
    // anything, which is exactly what an agent gets wrong when it places a
    // balcony by coordinates.
    const grounded = [part('g0', '3001', [0, 0, 0]), part('g1', '3001', [0, -24, 0])]
    const floating = [part('f0', '3001', [400, -240, 0]), part('f1', '3001', [400, -264, 0])]
    const report = analyseStatics(doc(...grounded, ...floating))
    expect(report.unsupportedPartIds.sort()).toEqual(['f0', 'f1'])
  })

  it('does not mistake an ordinary stack for a hanging load', () => {
    // The whole point: a brick resting on a brick loads it in compression, and
    // no clutch assumption however strict should call that an overload.
    const parts: PartInstance[] = []
    for (let index = 0; index < 12; index += 1) parts.push(part(`s${index}`, '3001', [0, -index * 24, 0]))
    expect(analyseStatics(doc(...parts), 1).overloaded).toEqual([])
  })

  it('carries the assumption it judged against, rather than hiding it', () => {
    const report = analyseStatics(doc(part('a', '3001', [0, 0, 0])), 250)
    expect(report.assumptions.clutchGramsPerStud).toBe(250)
    expect(report.assumptions.minResistingArmLdu).toBe(MIN_RESISTING_ARM_LDU)
    expect(report.assumptions.massBasis).toMatch(/idealized/)
    expect(report.assumptions.clutchFamilyWeights.stud).toBe(1)
    expect(report.assumptions.clutchFamilyWeights.clip).toBeLessThan(report.assumptions.clutchFamilyWeights.pin)
  })

  it('gets stricter, never looser, as the clutch assumption tightens', () => {
    const parts: PartInstance[] = []
    for (let index = 0; index < 6; index += 1) parts.push(part(`s${index}`, '3001', [0, -index * 24, 0]))
    const model = doc(...parts)
    expect(analyseStatics(model, 1).overloaded.length).toBeGreaterThanOrEqual(analyseStatics(model, 5000).overloaded.length)
  })
})

const snap = (moving: PartInstance, ...supports: PartInstance[]): PartInstance => {
  const solved = findSnapCandidates(moving, doc(...supports, moving), moving.transform, { radiusLdu: 14 })[0]
  if (!solved) throw new Error(`No snap for ${moving.id}`)
  return { ...moving, transform: solved.transform }
}

/**
 * A side-stud 1×1 on a short column, with a 1×4 mated only to that stud.
 *
 * The column keeps the hanging brick off the ground plane (otherwise the walk
 * treats it as compression). The hang is snapped against the bracket alone so
 * the 2×4's top studs cannot steal the snap.
 */
function cantilever() {
  const ground = part('g', '3001', [0, 0, 0])
  const column: PartInstance[] = [ground]
  for (let index = 1; index <= 4; index += 1) {
    column.push(snap(part(`c${index}`, '3001', [0, -index * 24 - 1, 0]), ...column))
  }
  const top = column[column.length - 1]!
  const bracket = snap(part('br', '87087', [0, top.transform.position[1] - 25, 0]), ...column)
  const hang = snap(part('h', '3005', transformPoint(bracket.transform, [0, 10, -32])), bracket)
  return doc(...column, bracket, hang)
}

/** Clutch just above a sub-gram hang so force stays inside capacity while rotation does not. */
const LIGHT_CLUTCH = 1

describe('cantilever moment', () => {
  it('a load directly beneath its anchor has no leverage', () => {
    expect(horizontalDistance([10, 40, 3], [10, 0, 3])).toBe(0)
    const stack = analyseStatics(doc(part('a', '3001', [0, 0, 0]), part('b', '3001', [0, -24, 0])))
    expect(stack.overloaded.every((issue) => !issue.leverage)).toBe(true)
  })

  it('the same mass further out reports a larger moment', () => {
    const near = horizontalDistance([0, 0, 0], [40, 0, 0])
    const far = horizontalDistance([0, 0, 0], [400, 0, 0])
    expect(far).toBeGreaterThan(near)
    expect(far / near).toBeCloseTo(10, 6)
  })

  it('widening the anchor span raises the moment capacity', () => {
    const tight = maxPairwiseDistance([[0, 0, 0], [4, 0, 0]])
    const wide = maxPairwiseDistance([[0, 0, 0], [40, 0, 0]])
    const clutch = 100
    const studs = 2
    const tightCap = studs * clutch * Math.max(tight, MIN_RESISTING_ARM_LDU) / 2
    const wideCap = studs * clutch * Math.max(wide, MIN_RESISTING_ARM_LDU) / 2
    expect(wideCap).toBeGreaterThan(tightCap)
  })

  it('a cluster within force capacity but over moment capacity is reported as leverage', () => {
    const model = cantilever()
    expect(model.parts.h).toBeDefined()
    expect(model.parts.br).toBeDefined()
    const { overloaded } = computeOverloads(model, LIGHT_CLUTCH)
    const issue = overloaded.find((entry) => entry.partIds.includes('h') && entry.leverage)
    expect(issue?.leverage).toBeDefined()
    expect(issue!.grams).toBeLessThanOrEqual(issue!.capacityGrams)
    expect(issue!.leverage!.momentGramLdu).toBeGreaterThan(issue!.leverage!.capacityGramLdu)
    expect(issue!.message).toMatch(/leverage/)
  })

  it('a single anchor uses the minimum resisting arm', () => {
    const model = cantilever()
    const issue = computeOverloads(model, LIGHT_CLUTCH).overloaded.find((entry) => entry.leverage)
    expect(issue?.leverage).toBeDefined()
    expect(issue!.leverage!.spanLdu).toBeLessThan(MIN_RESISTING_ARM_LDU)
    expect(issue!.leverage!.capacityGramLdu).toBe(
      Math.round((issue!.studs * LIGHT_CLUTCH * MIN_RESISTING_ARM_LDU) / 2),
    )
  })

  it('leverage is absent on pure compression', () => {
    const parts: PartInstance[] = []
    for (let index = 0; index < 8; index += 1) parts.push(part(`s${index}`, '3001', [0, -index * 24, 0]))
    const { overloaded } = computeOverloads(doc(...parts), 1)
    expect(overloaded).toEqual([])
  })

  it('overhangPenaltyGrams adds equivalent mass from moment excess', () => {
    const forceOnly = overhangPenaltyGrams({
      partIds: ['a'],
      hangingPartIds: ['a'],
      grams: 120,
      studs: 1,
      capacityGrams: 100,
      severity: 'over-capacity',
      message: 'force',
    })
    expect(forceOnly).toBe(20)
    const withLeverage = overhangPenaltyGrams({
      partIds: ['a'],
      hangingPartIds: ['a'],
      grams: 50,
      studs: 1,
      capacityGrams: 100,
      severity: 'marginal',
      message: 'moment',
      leverage: {
        armLdu: 40,
        spanLdu: 12,
        momentGramLdu: 2000,
        capacityGramLdu: 600,
        severity: 'over-capacity',
      },
    })
    expect(withLeverage).toBeCloseTo(1400 / 40)
  })

  it('hangingArmIssues counts only moment-over clusters, not every leverage object', () => {
    const forceOnly = {
      partIds: ['a'],
      hangingPartIds: ['a'],
      grams: 120,
      studs: 1,
      capacityGrams: 100,
      severity: 'over-capacity' as const,
      message: 'force',
      leverage: {
        armLdu: 8,
        spanLdu: 12,
        momentGramLdu: 400,
        capacityGramLdu: 600,
        severity: 'marginal' as const,
      },
    }
    const momentOver = {
      ...forceOnly,
      partIds: ['b'],
      hangingPartIds: ['b'],
      leverage: {
        armLdu: 40,
        spanLdu: 12,
        momentGramLdu: 2000,
        capacityGramLdu: 600,
        severity: 'over-capacity' as const,
      },
    }
    expect(hangingArmIssues([forceOnly, momentOver]).map((item) => item.partIds[0])).toEqual(['b'])
  })

  it('weights a pin clutch above a clip, and a stud at 1', () => {
    expect(clutchCapacityWeight('stud', 'anti-stud')).toBe(1)
    expect(clutchCapacityWeight('pin', 'pin-hole')).toBeGreaterThan(clutchCapacityWeight('clip', 'bar'))
  })


  it('centroidOf sits between equal parts', () => {
    const model = doc(part('a', '3001', [0, 0, 0]), part('b', '3001', [200, 0, 0]))
    const centre = centroidOf(['a', 'b'], model)
    expect(centre[0]).toBeCloseTo(100, 0)
  })
})
