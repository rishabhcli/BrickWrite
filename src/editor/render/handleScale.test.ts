import { describe, expect, it } from 'vitest'
import { handleScale } from './Manipulators'

/**
 * A handle scaled by eye distance is supposed to keep one apparent size. The
 * bounds are there for degenerate cameras, not for the range people work in,
 * and the previous pair sat inside it at both ends.
 */
describe('joint handle scaling', () => {
  const RING_RADIUS = 2.6
  /** Apparent size: how much of the view a handle spans at a given distance. */
  const apparent = (distance: number) => (handleScale(distance) * RING_RADIUS) / distance

  it('keeps one apparent size across the distances a session actually covers', () => {
    // Leaning into a single hinge, through to standing off a 100-stud model.
    const distances = [3, 6, 10, 20, 45, 90, 180, 400]
    const sizes = distances.map(apparent)
    for (const size of sizes) expect(size).toBeCloseTo(sizes[0]!, 6)
  })

  it('no longer swells when the operator leans in', () => {
    // The old floor of 0.45 engaged below ~10 units, so closing from 10 to 3
    // more than tripled the handle's share of the view.
    const legacy = (d: number) => (Math.max(0.45, Math.min(4, d * 0.045)) * RING_RADIUS) / d
    expect(legacy(3) / legacy(10)).toBeGreaterThan(3)
    expect(apparent(3) / apparent(10)).toBeCloseTo(1, 6)
  })

  it('no longer shrinks away on a large model', () => {
    // The old ceiling of 4 engaged past ~89 units, so a big build's handles
    // faded exactly when they were hardest to hit.
    const legacy = (d: number) => (Math.max(0.45, Math.min(4, d * 0.045)) * RING_RADIUS) / d
    expect(legacy(400) / legacy(90)).toBeLessThan(0.3)
    expect(apparent(400) / apparent(90)).toBeCloseTo(1, 6)
  })

  it('still clamps a degenerate camera', () => {
    expect(handleScale(0)).toBe(0.01)
    expect(handleScale(1e9)).toBe(60)
  })
})
