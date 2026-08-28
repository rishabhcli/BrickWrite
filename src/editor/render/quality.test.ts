import { describe, expect, it } from 'vitest'
import {
  allocateEdgeBudget,
  DEFAULT_EDGE_BUDGET,
  QUALITY_TIERS,
  QualityController,
  screenExtentPixels,
} from './quality'

describe('the quality ladder', () => {
  it('never trades away real geometry', () => {
    // The tool may render a model cheaply; it must not render the wrong shape.
    // Every tier draws true compiled geometry, so no tier can turn that off.
    expect(QUALITY_TIERS.length).toBeGreaterThan(2)
    expect(QUALITY_TIERS.every((tier) => tier.maxDpr >= 1)).toBe(true)
  })

  it('is ordered cheapest sacrifice first', () => {
    for (let index = 1; index < QUALITY_TIERS.length; index += 1) {
      expect(QUALITY_TIERS[index].maxDpr).toBeLessThanOrEqual(QUALITY_TIERS[index - 1].maxDpr)
      expect(QUALITY_TIERS[index].shadowMapSize).toBeLessThanOrEqual(QUALITY_TIERS[index - 1].shadowMapSize)
    }
  })

  it('gives up edges before it gives up shadows', () => {
    // Losing contact shadows makes a model appear to float, which is a spatial
    // misreading; losing hard edges is cosmetic.
    const firstWithoutEdges = QUALITY_TIERS.findIndex((tier) => !tier.edges)
    const firstWithoutShadows = QUALITY_TIERS.findIndex((tier) => tier.shadowMapSize === 0)
    expect(firstWithoutEdges).toBeLessThan(firstWithoutShadows)
  })
})

describe('the frame-time governor', () => {
  const feed = (controller: QualityController, frameMs: number, frames: number, startAt = 0, spacing = 16) => {
    let decision = controller.current
    for (let index = 0; index < frames; index += 1) {
      decision = controller.sample(frameMs, startAt + index * spacing)
    }
    return decision
  }

  it('drops a tier when the measured rate falls under the interaction floor', () => {
    const controller = new QualityController(1, { dwellMs: 0 })
    const decision = feed(controller, 50, 12)
    expect(decision.index).toBeGreaterThan(1)
    expect(decision.fps).toBeLessThan(30)
  })

  it('does not promote on a single fast frame', () => {
    const controller = new QualityController(2, { dwellMs: 5000 })
    controller.sample(4, 0)
    expect(controller.current.index).toBe(2)
  })

  it('needs a clear margin to promote, so it cannot oscillate', () => {
    // A controller that drops, recovers and immediately drops again produces
    // visible pumping that is worse than simply being slow.
    const controller = new QualityController(2, { dwellMs: 0, demoteBelowFps: 30, promoteAboveFps: 52 })
    // 28 ms is ~36 FPS: above the demote floor, below the promote bar.
    const steady = feed(controller, 28, 40)
    expect(steady.index).toBe(2)
  })

  it('promotes when there is genuine headroom', () => {
    const controller = new QualityController(3, { dwellMs: 0 })
    const decision = feed(controller, 8, 12)
    expect(decision.index).toBeLessThan(3)
  })

  it('cannot fall off either end of the ladder', () => {
    const slow = new QualityController(QUALITY_TIERS.length - 1, { dwellMs: 0 })
    expect(feed(slow, 200, 40).index).toBe(QUALITY_TIERS.length - 1)
    const fast = new QualityController(0, { dwellMs: 0 })
    expect(feed(fast, 2, 40).index).toBe(0)
  })

  it('honours a dwell time between changes', () => {
    const controller = new QualityController(0, { dwellMs: 10_000 })
    const decision = feed(controller, 200, 40, 0, 16)
    expect(decision.index).toBe(1)
  })

  it('discards the old tier’s samples on a change, so the governor cannot ring', () => {
    const controller = new QualityController(0, { dwellMs: 0 })
    const first = controller.sample(200, 0)
    expect(first.changed).toBe(false)
    feed(controller, 200, 10, 16)
    // Immediately after a change the window is empty, so no second change can
    // be decided from measurements taken at the previous tier.
    const next = controller.sample(200, 200)
    expect(next.changed).toBe(false)
  })

  it('can be pinned, for capture and for controlled measurement', () => {
    const controller = new QualityController(0, { dwellMs: 0 })
    controller.pin(3)
    expect(feed(controller, 500, 60).index).toBe(3)
  })
})

describe('apparent size', () => {
  it('grows with world size and shrinks with distance', () => {
    const fov = (34 * Math.PI) / 180
    const near = screenExtentPixels(1, 10, fov, 1000)
    const far = screenExtentPixels(1, 100, fov, 1000)
    expect(near).toBeGreaterThan(far * 9)
  })

  it('saturates rather than dividing by zero at the camera', () => {
    expect(screenExtentPixels(1, 0, 0.6, 800)).toBe(800)
  })
})

describe('edge budget allocation', () => {
  it('spends the budget on what is visible', () => {
    // A model past the budget should lose its distant background's edges, not
    // whichever batch the plan happened to emit first.
    const chosen = allocateEdgeBudget(
      [
        { key: 'far', vertices: 900_000, screenPixels: 40 },
        { key: 'near', vertices: 900_000, screenPixels: 400 },
      ],
      { minScreenPixels: 18, vertexBudget: 1_000_000 },
    )
    expect([...chosen]).toEqual(['near'])
  })

  it('drops batches too small to read', () => {
    const chosen = allocateEdgeBudget([{ key: 'speck', vertices: 10, screenPixels: 3 }])
    expect(chosen.size).toBe(0)
  })

  it('keeps everything when the budget is ample', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      key: `b${index}`,
      vertices: 1000,
      screenPixels: 100,
    }))
    expect(allocateEdgeBudget(candidates, DEFAULT_EDGE_BUDGET).size).toBe(20)
  })

  it('is deterministic when two batches tie', () => {
    const candidates = [
      { key: 'b', vertices: 10, screenPixels: 100 },
      { key: 'a', vertices: 10, screenPixels: 100 },
    ]
    expect([...allocateEdgeBudget(candidates)]).toEqual(['a', 'b'])
  })
})
