import { describe, expect, it } from 'vitest'
import { handleScale } from './Manipulators'
import { adaptiveGizmoSize, HANDLE_DEAD_BAND } from './SelectionManipulator'

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

/**
 * The move/rotate gizmo's own sizing, which is a feedback loop rather than a
 * function of distance: the correction changes the size, the new size changes
 * the measurement, and the next frame corrects again. Without a band to settle
 * in, the handle hunts around its target every frame a gizmo is on screen —
 * which is most of them, because a click hands over the Move tool.
 */
describe('transform gizmo sizing', () => {
  const TARGET = 112

  it('leaves a size alone once it is close enough to the target', () => {
    expect(adaptiveGizmoSize(1.05, TARGET)).toBe(1.05)
    expect(adaptiveGizmoSize(1.05, TARGET * (1 + HANDLE_DEAD_BAND * 0.9))).toBe(1.05)
    expect(adaptiveGizmoSize(1.05, TARGET * (1 - HANDLE_DEAD_BAND * 0.9))).toBe(1.05)
  })

  it('settles instead of hunting when the measurement follows the size', () => {
    // The loop the dead band exists for: a projected extent proportional to the
    // handle's own size, sampled and corrected once per frame.
    const projected = (size: number) => (TARGET * 0.62 * size) / 1.05
    let size = 1.05
    const history: number[] = []
    for (let frame = 0; frame < 30; frame += 1) {
      size = adaptiveGizmoSize(size, projected(size))
      history.push(size)
    }
    expect(history.at(-1)).toBe(history.at(-5))
    expect(projected(history.at(-1)!)).toBeGreaterThan(96)
  })

  it('still corrects a handle that is genuinely the wrong size', () => {
    expect(adaptiveGizmoSize(1.05, 20)).toBeGreaterThan(1.05)
    expect(adaptiveGizmoSize(1.05, 400)).toBeLessThan(1.05)
    expect(adaptiveGizmoSize(1.05, 0)).toBe(1.05)
    expect(adaptiveGizmoSize(1.05, Number.NaN)).toBe(1.05)
  })
})
