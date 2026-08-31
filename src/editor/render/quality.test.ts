import { describe, expect, it } from 'vitest'
import {
  allocateEdgeVertexCounts,
  edgeBudgetForTier,
  movingEdgeShare,
  MOTION_EDGE_VERTEX_BUDGET,
  DEFAULT_EDGE_BUDGET,
  QUALITY_TIERS,
  QualityController,
  ndcHeightToPixels,
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

  it('reduces edge density before shadows, but retains edges in every tier', () => {
    expect(QUALITY_TIERS.every(tier => tier.edges)).toBe(true)
    const budgets = QUALITY_TIERS.map(tier => edgeBudgetForTier(tier).vertexBudget)
    expect(budgets).toEqual([2_400_000, 2_400_000, 1_200_000, 400_000, 120_000])
    const reduced = budgets.findIndex(value => value < budgets[0])
    const noShadow = QUALITY_TIERS.findIndex(tier => tier.shadowMapSize === 0)
    expect(reduced).toBeLessThan(noShadow)
    expect(budgets.every(value => value > 0)).toBe(true)
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
  it('converts an NDC delta to pixels, and halves it', () => {
    // NDC runs from −1 to 1, so a delta of 1 is *half* the viewport. Getting
    // this wrong is invisible to a test that only checks the value moves in the
    // right direction, and it was wrong: the previous closed-form helper
    // reported a sphere of true extent 107.2 px as 214.5.
    expect(ndcHeightToPixels(1, 1000)).toBe(500)
    expect(ndcHeightToPixels(2, 1000)).toBe(1000)
    expect(ndcHeightToPixels(0.02, 1000)).toBeCloseTo(10, 6)
  })

  it('does not care which way the projection put the sign', () => {
    // The caller subtracts two projected y values; which is larger depends on
    // the camera, and a negative extent would silently fail every threshold.
    expect(ndcHeightToPixels(-0.5, 800)).toBe(ndcHeightToPixels(0.5, 800))
  })
})

/**
 * The allocator the renderer actually calls.
 *
 * There were two: an all-or-nothing `allocateEdgeBudget`, and
 * `allocateEdgeVertexCounts`, which grants a partial vertex count so one giant
 * batch cannot take the whole budget or nothing. `EdgeLodProvider` uses the
 * second. The tests covered only the first — so four green tests asserted the
 * behaviour of a function no longer wired to anything, while the one deciding
 * whether a model shows outlines had none. The dead one is gone; its four
 * behaviours are asserted here against the live one, plus the two properties
 * only it has.
 */
describe('edge budget allocation', () => {
  const budget = { minScreenPixels: 18, vertexBudget: 1_000_000 }
  const granted = (allocation: Map<string, number>) =>
    [...allocation.entries()].filter(([, count]) => count > 0).map(([key]) => key)

  it('spends the budget on what is visible', () => {
    // A model past the budget should lose its distant background's edges, not
    // whichever batch the plan happened to emit first.
    const allocation = allocateEdgeVertexCounts(
      [
        { key: 'far', vertices: 900_000, screenPixels: 40 },
        { key: 'near', vertices: 900_000, screenPixels: 400 },
      ],
      budget,
    )
    expect(allocation.get('near')).toBe(900_000)
    expect(allocation.get('far')).toBe(100_000)
  })

  it('drops batches too small to read', () => {
    // Filtered out entirely rather than granted zero, because `EdgeLodProvider`
    // reads `allocations.get(key) ?? 0` and a missing key means the same thing.
    const allocation = allocateEdgeVertexCounts([{ key: 'speck', vertices: 10, screenPixels: 3 }])
    expect(allocation.has('speck')).toBe(false)
  })

  it('keeps everything when the budget is ample', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      key: `b${index}`,
      vertices: 1000,
      screenPixels: 100,
    }))
    const allocation = allocateEdgeVertexCounts(candidates, DEFAULT_EDGE_BUDGET)
    expect(granted(allocation)).toHaveLength(20)
    expect([...allocation.values()].every((count) => count === 1000)).toBe(true)
  })

  it('is deterministic when two batches tie', () => {
    // Ties break on key so a camera that has not moved cannot produce a
    // different frame from one render to the next.
    const candidates = [
      { key: 'b', vertices: 10, screenPixels: 100 },
      { key: 'a', vertices: 10, screenPixels: 100 },
    ]
    expect([...allocateEdgeVertexCounts(candidates).keys()]).toEqual(['a', 'b'])
  })

  it('grants a partial count rather than nothing, and never overspends', () => {
    // The whole reason this allocator replaced the all-or-nothing one: a single
    // batch larger than the budget used to be skipped entirely, so the biggest
    // thing on screen was the one thing with no outlines.
    const allocation = allocateEdgeVertexCounts([{ key: 'huge', vertices: 4_000_000, screenPixels: 900 }], budget)
    expect(allocation.get('huge')).toBe(1_000_000)

    const many = Array.from({ length: 5 }, (_, index) => ({
      key: `b${index}`,
      vertices: 400_000,
      screenPixels: 500 - index,
    }))
    const spread = allocateEdgeVertexCounts(many, budget)
    const total = [...spread.values()].reduce((sum, count) => sum + count, 0)
    expect(total).toBe(1_000_000)
    expect(total).toBeLessThanOrEqual(budget.vertexBudget)
    // Nearest first: the last two get nothing rather than everyone getting a
    // slice too thin to read.
    expect(spread.get('b0')).toBe(400_000)
    expect(spread.get('b4')).toBe(0)
  })

  it('thins every batch equally while the camera moves, and only then', () => {
    // The measured knee: at 5,000 parts the scene holds 2,160,512 merged edge
    // vertices and drawing a quarter of them costs 4.46 ms less a frame. A still
    // frame keeps all of them, because a still frame is what a model is read
    // from.
    expect(movingEdgeShare(2_160_512, false)).toBe(1)
    const share = movingEdgeShare(2_160_512, true)
    expect(share).toBeCloseTo(MOTION_EDGE_VERTEX_BUDGET / 2_160_512, 6)
    expect(2_160_512 * share).toBeCloseTo(MOTION_EDGE_VERTEX_BUDGET, 6)
  })

  it('leaves a model that fits inside the motion budget untouched', () => {
    // Below the budget, an orbit draws exactly what a still frame draws. Without
    // this a thousand-brick model would flicker its outlines for no gain at all.
    expect(movingEdgeShare(MOTION_EDGE_VERTEX_BUDGET, true)).toBe(1)
    expect(movingEdgeShare(MOTION_EDGE_VERTEX_BUDGET - 2, true)).toBe(1)
    expect(movingEdgeShare(0, true)).toBe(1)
    expect(movingEdgeShare(MOTION_EDGE_VERTEX_BUDGET + 500_000, true)).toBeLessThan(1)
  })

  it('only ever grants whole line segments', () => {
    // The count goes to `setDrawRange`, and an edge is two vertices. An odd
    // grant would draw half a segment — a line from a real corner to nowhere.
    const allocation = allocateEdgeVertexCounts(
      [{ key: 'odd', vertices: 999, screenPixels: 100 }],
      { minScreenPixels: 18, vertexBudget: 501 },
    )
    expect(allocation.get('odd')! % 2).toBe(0)
    expect(allocation.get('odd')).toBe(500)
  })
})
