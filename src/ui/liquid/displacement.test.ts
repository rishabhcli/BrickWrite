import { describe, expect, it } from 'vitest'
import { clearDisplacementCache, displacementCacheSize, displacementMap, MAP_KEY, MAX_SLOPE } from './displacement'

/**
 * The map is what makes the edge bend, so its shape is the difference between
 * glass and an embossed border. jsdom has no 2D canvas, so the raster itself
 * cannot be asserted here — the contract that can be, and that matters, is that
 * the work is cached rather than repeated per frame.
 */

describe('the geometry key', () => {
  it('distinguishes every dimension that changes the raster', () => {
    const base = { width: 400, height: 48, radius: 18, band: 30 }
    const keys = new Set([
      MAP_KEY(base),
      MAP_KEY({ ...base, width: 401 }),
      MAP_KEY({ ...base, height: 49 }),
      MAP_KEY({ ...base, radius: 19 }),
      MAP_KEY({ ...base, band: 31 }),
    ])
    expect(keys.size).toBe(5)
  })

  it('collapses sub-pixel differences, so a resize by a fraction reuses the map', () => {
    expect(MAP_KEY({ width: 400.2, height: 48.1, radius: 18, band: 30 })).toBe(
      MAP_KEY({ width: 400.4, height: 47.9, radius: 18, band: 30 }),
    )
  })
})

describe('rasterising without a canvas', () => {
  it('answers null rather than throwing where there is no 2D context', () => {
    // jsdom. A caller falls back to plain blur, which is a complete material.
    expect(displacementMap({ width: 40, height: 20, radius: 8, band: 12 })).toBeNull()
  })

  it('caches nothing it could not produce', () => {
    clearDisplacementCache()
    displacementMap({ width: 40, height: 20, radius: 8, band: 12 })
    expect(displacementCacheSize()).toBe(0)
  })
})

describe('the lens profile', () => {
  it('saturates rather than running away at the rim', () => {
    // The slope of a quarter-round fillet is unbounded at the very edge; without
    // a clamp the displacement folds the backdrop over itself.
    expect(MAX_SLOPE).toBeGreaterThan(1)
    expect(Number.isFinite(MAX_SLOPE)).toBe(true)
  })
})
