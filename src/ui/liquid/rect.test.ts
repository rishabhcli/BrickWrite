import { describe, expect, it } from 'vitest'
import { overlapFraction, OVERLAP_THRESHOLD } from './rect'

/**
 * Which surfaces are actually sitting over the rendered scene.
 *
 * This is what decides whether a surface adapts to the model or to the page.
 * In the editor's grid the docks sit beside the canvas and the topbar above it,
 * so they overlap it not at all — and a naive "is there a scene?" test would
 * have them adapting to a backdrop that is nowhere near them.
 */

const viewport = { left: 272, top: 44, width: 1202, height: 1006 }

describe('overlapFraction', () => {
  it('is 1 for a surface wholly inside the region', () => {
    expect(overlapFraction({ left: 286, top: 84, width: 188, height: 37 }, viewport)).toBe(1)
  })

  it('is 0 for the left dock, which sits beside the canvas', () => {
    expect(overlapFraction({ left: 8, top: 44, width: 230, height: 900 }, viewport)).toBe(0)
  })

  it('is 0 for the topbar, which sits above it', () => {
    expect(overlapFraction({ left: 0, top: 0, width: 1512, height: 43 }, viewport)).toBe(0)
  })

  it('measures a surface straddling the boundary', () => {
    // Half in, half out: 100 wide starting 50px left of the canvas edge.
    expect(overlapFraction({ left: 222, top: 100, width: 100, height: 10 }, viewport)).toBeCloseTo(0.5, 5)
  })

  it('is 0 for a zero-area surface rather than dividing by nothing', () => {
    expect(overlapFraction({ left: 300, top: 300, width: 0, height: 0 }, viewport)).toBe(0)
  })

  it('adopts the scene once a surface is half covered', () => {
    expect(OVERLAP_THRESHOLD).toBe(0.5)
  })
})
