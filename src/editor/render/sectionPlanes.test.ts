import { describe, expect, it } from 'vitest'
import { createSectionPlane, offsetPlaneAlongNormal } from './sectionPlanes'

describe('section plane offset', () => {
  it('moves the origin along the unit normal by the requested LDU', () => {
    const plane = createSectionPlane('x', [10, 0, 0])
    const next = offsetPlaneAlongNormal(plane, 8)
    expect(next.origin[0]).toBeCloseTo(18)
    expect(next.origin[1]).toBe(0)
    expect(next.origin[2]).toBe(0)
    expect(next.normal).toEqual(plane.normal)
  })
})
