import { describe, expect, it } from 'vitest'
import { planEnclosure } from './assembly'
import { catalog, STUD_LDU } from './catalog'
import { CadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import { createBlankDocument } from './sample'
import {
  ABS_GRAMS_PER_LDU3,
  analyseStatics,
  computeMass,
  computeSupport,
  convexHull,
  distanceInsidePolygon,
  partMassGrams,
} from './statics'
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
    expect(report.assumptions.massBasis).toMatch(/idealized/)
  })

  it('gets stricter, never looser, as the clutch assumption tightens', () => {
    const parts: PartInstance[] = []
    for (let index = 0; index < 6; index += 1) parts.push(part(`s${index}`, '3001', [0, -index * 24, 0]))
    const model = doc(...parts)
    expect(analyseStatics(model, 1).overloaded.length).toBeGreaterThanOrEqual(analyseStatics(model, 5000).overloaded.length)
  })
})
