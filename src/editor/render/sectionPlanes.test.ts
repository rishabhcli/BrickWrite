import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../cad/types'
import {
  bearingInPlane,
  boxClipState,
  createSectionPlane,
  intersectPlane,
  offsetPlaneFromDrag,
  projectRayOntoAxis,
  rotatePlaneFromDrag,
  signedDistance,
  type SectionPlane,
} from './sectionPlanes'

const plane = (normal: Vec3, origin: Vec3): SectionPlane => ({
  id: 'p',
  normal,
  origin,
  enabled: true,
  capped: true,
})

describe('plane algebra', () => {
  it('measures signed distance with the kept side positive', () => {
    const cut = plane([0, 1, 0], [0, 40, 0])
    expect(signedDistance(cut, [0, 60, 0])).toBeCloseTo(20, 6)
    expect(signedDistance(cut, [0, 10, 0])).toBeCloseTo(-30, 6)
  })

  it('classifies a box as kept, cut or removed exactly', () => {
    const cut = plane([0, 1, 0], [0, 0, 0])
    expect(boxClipState(cut, [0, 10, 0], [20, 30, 20])).toBe('kept')
    expect(boxClipState(cut, [0, -30, 0], [20, -10, 20])).toBe('removed')
    expect(boxClipState(cut, [0, -10, 0], [20, 10, 20])).toBe('cut')
  })

  it('classifies against a diagonal plane by projection, not by axis', () => {
    // A box-versus-plane test that only looked at axes would call this kept.
    const diagonal = plane([0.7071, 0.7071, 0], [0, 0, 0])
    expect(boxClipState(diagonal, [-5, -5, -5], [5, 5, 5])).toBe('cut')
    expect(boxClipState(diagonal, [20, 20, -5], [30, 30, 5])).toBe('kept')
  })

  it('returns nothing for a ray that runs along the plane', () => {
    expect(intersectPlane(plane([0, 1, 0], [0, 0, 0]), { origin: [0, 0, 0], direction: [1, 0, 0] })).toBeNull()
  })
})

describe('closest approach to an axis', () => {
  it('solves the parameter a handle drag needs', () => {
    // The handle can only move along its axis, so the drag has to project the
    // cursor onto that axis rather than intersect anything.
    const t = projectRayOntoAxis([0, 0, 0], [0, 1, 0], { origin: [10, 25, 0], direction: [-1, 0, 0] })
    expect(t).toBeCloseTo(25, 6)
  })

  it('refuses a ray within a degree of the axis instead of returning noise', () => {
    expect(projectRayOntoAxis([0, 0, 0], [0, 1, 0], { origin: [0, 100, 0], direction: [0, -1, 0] })).toBeNull()
  })
})

describe('dragging a section plane', () => {
  it('translates along the normal by the change in the grab parameter', () => {
    const cut = plane([0, 1, 0], [0, 0, 0])
    const grab = projectRayOntoAxis(cut.origin, cut.normal, { origin: [10, 0, 0], direction: [-1, 0, 0] })!
    const moved = offsetPlaneFromDrag(cut, { origin: [10, 32, 0], direction: [-1, 0, 0] }, grab)
    expect(moved.origin[1]).toBeCloseTo(32, 6)
    expect(moved.normal).toEqual(cut.normal)
  })

  it('quantizes travel when a step is asked for', () => {
    const cut = plane([0, 1, 0], [0, 0, 0])
    const moved = offsetPlaneFromDrag(cut, { origin: [10, 27, 0], direction: [-1, 0, 0] }, 0, { stepLdu: 8 })
    expect(moved.origin[1]).toBeCloseTo(24, 6)
  })

  it('leaves the plane alone when the drag ray is degenerate', () => {
    const cut = plane([0, 1, 0], [0, 0, 0])
    expect(offsetPlaneFromDrag(cut, { origin: [0, 100, 0], direction: [0, -1, 0] }, 0)).toEqual(cut)
  })

  it('pivots about its own origin, so the cut stays where it was put', () => {
    const cut = plane([0, 1, 0], [0, 40, 0])
    const turned = rotatePlaneFromDrag(cut, [1, 0, 0], Math.PI / 2)
    expect(turned.origin).toEqual([0, 40, 0])
    expect(turned.normal[0]).toBeCloseTo(0, 6)
    expect(turned.normal[1]).toBeCloseTo(0, 6)
    expect(Math.abs(turned.normal[2])).toBeCloseTo(1, 6)
  })

  it('keeps the normal a unit vector across many rotations', () => {
    // Accumulating a drag over hundreds of frames is exactly where a rotation
    // that does not renormalise slowly shears the plane.
    let cut = plane([0, 1, 0], [0, 0, 0])
    for (let step = 0; step < 500; step += 1) cut = rotatePlaneFromDrag(cut, [1, 0, 0], 0.03)
    expect(Math.hypot(...cut.normal)).toBeCloseTo(1, 9)
  })

  it('measures a bearing in the plane relative to the grab direction', () => {
    const cut = plane([0, 1, 0], [0, 0, 0])
    const reference: Vec3 = [1, 0, 0]
    expect(bearingInPlane(cut, reference, [10, 0, 0])).toBeCloseTo(0, 6)
    expect(Math.abs(bearingInPlane(cut, reference, [0, 0, 10]))).toBeCloseTo(Math.PI / 2, 6)
  })
})

describe('presets', () => {
  it('builds an axis-aligned cut through a given point', () => {
    const cut = createSectionPlane('y', [0, 24, 0])
    expect(cut.normal).toEqual([0, 1, 0])
    expect(cut.origin).toEqual([0, 24, 0])
    expect(cut.enabled).toBe(true)
  })
})
