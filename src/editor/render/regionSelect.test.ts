import { describe, expect, it } from 'vitest'
import { encodeId } from './ids'
import {
  centresInRegion,
  coverageInRegion,
  nearestIdInPatch,
  pointInPolygon,
  rasterizeRegion,
  regionBounds,
  type RegionShape,
} from './regionSelect'

const WIDTH = 64
const HEIGHT = 64

/**
 * Paints an identity buffer the way the GPU pass would.
 *
 * Rows run top-down here and the reader is told so, which is what the `flipY`
 * flag exists for: `readRenderTargetPixels` hands back rows bottom-up, and a
 * test that silently agreed with the reader's default would not be testing the
 * orientation handling at all.
 */
function paint(rects: ReadonlyArray<{ id: number; x0: number; y0: number; x1: number; y1: number }>): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4)
  for (const rect of rects) {
    const [r, g, b] = encodeId(rect.id)
    for (let y = rect.y0; y <= rect.y1; y += 1) {
      for (let x = rect.x0; x <= rect.x1; x += 1) {
        const offset = (y * WIDTH + x) * 4
        pixels[offset] = r
        pixels[offset + 1] = g
        pixels[offset + 2] = b
        pixels[offset + 3] = 255
      }
    }
  }
  return pixels
}

describe('polygon membership', () => {
  it('counts a self-crossing loop as the area it encircles', () => {
    // A hand-drawn lasso crosses itself constantly. Even-odd is what makes that
    // still mean "the area I circled".
    const bowtie: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [10, 10],
      [0, 10],
      [10, 0],
    ]
    expect(pointInPolygon(bowtie, 5, 2)).toBe(true)
    expect(pointInPolygon(bowtie, 5, 8)).toBe(true)
    expect(pointInPolygon(bowtie, 1, 5)).toBe(false)
  })

  it('bounds a lasso to its own extent, clamped into the buffer', () => {
    const bounds = regionBounds({ kind: 'lasso', points: [[-5, -5], [20, 4], [8, 30]] }, WIDTH, HEIGHT)
    expect(bounds.left).toBe(0)
    expect(bounds.top).toBe(0)
    expect(bounds.width).toBe(21)
    expect(bounds.height).toBe(31)
  })

  it('treats a degenerate lasso as selecting nothing', () => {
    const bounds = regionBounds({ kind: 'lasso', points: [[1, 1], [2, 2]] }, WIDTH, HEIGHT)
    expect(bounds.width).toBe(0)
    expect(rasterizeRegion({ kind: 'lasso', points: [[1, 1], [2, 2]] }, bounds).length).toBe(0)
  })
})

/**
 * The gate: region selection reads covered pixels, not projected centres.
 *
 * The arrangement is the one that actually occurs in a model, reduced to its
 * essentials:
 *
 *   beam    a long part — think a 1×8 brick under a facade. Its centre is far
 *           from either end, so a region drawn over one end contains its pixels
 *           and not its centre.
 *   buried  a part completely behind another. It has a projected centre like
 *           anything else, and it writes no pixels at all, because the identity
 *           pass runs with the same depth test as the beauty pass.
 *   facade  the part doing the burying, plainly visible.
 *
 * The lasso is a single L-shaped loop that covers the beam's right end and the
 * facade, and passes over where the buried part's centre projects. The two
 * rules are then run over the same arrangement and required to *disagree* in
 * exactly the two places the centre rule is wrong.
 */
describe('covered pixels, not projected centres', () => {
  const beam = { id: 1, x0: 4, y0: 10, x1: 58, y1: 14 }
  const facade = { id: 3, x0: 26, y0: 26, x1: 44, y1: 44 }
  // The buried part is deliberately absent from the paint list: occluded
  // geometry does not reach the identity buffer.
  const pixels = paint([beam, facade])

  const lasso: RegionShape = {
    kind: 'lasso',
    points: [
      [46, 6],
      [60, 6],
      [60, 40],
      [26, 40],
      [26, 26],
      [46, 26],
    ],
  }

  const centres = [
    { id: 'beam', x: 31, y: 12 },
    { id: 'buried', x: 32, y: 32 },
    { id: 'facade', x: 35, y: 35 },
  ]

  const idToPart = new Map([[1, 'beam'], [2, 'buried'], [3, 'facade']])

  const selectedByPixels = () => {
    const bounds = regionBounds(lasso, WIDTH, HEIGHT)
    const mask = rasterizeRegion(lasso, bounds)
    // The reader is given the *whole* buffer's row stride via a matching bounds
    // read, so the test exercises the same indexing the renderer uses.
    const cropped = new Uint8Array(bounds.width * bounds.height * 4)
    for (let row = 0; row < bounds.height; row += 1) {
      for (let column = 0; column < bounds.width; column += 1) {
        const source = ((bounds.top + row) * WIDTH + bounds.left + column) * 4
        const target = (row * bounds.width + column) * 4
        cropped.set(pixels.subarray(source, source + 4), target)
      }
    }
    return coverageInRegion(cropped, bounds, mask, { flipY: false })
      .map((entry) => idToPart.get(entry.id))
      .filter(Boolean) as string[]
  }

  it('selects a part whose centre is outside the lasso but whose pixels are inside', () => {
    expect(selectedByPixels()).toContain('beam')
    // And the rule it replaces gets this wrong, which is the point.
    expect(centresInRegion(centres, lasso)).not.toContain('beam')
  })

  it('does not select a fully occluded part whose centre is inside the lasso', () => {
    expect(selectedByPixels()).not.toContain('buried')
    expect(centresInRegion(centres, lasso)).toContain('buried')
  })

  it('still selects what is plainly visible inside the lasso', () => {
    expect(selectedByPixels()).toContain('facade')
    expect(centresInRegion(centres, lasso)).toContain('facade')
  })

  it('orders results by coverage, so a truncating caller keeps the obvious ones', () => {
    const bounds = regionBounds(lasso, WIDTH, HEIGHT)
    const mask = rasterizeRegion(lasso, bounds)
    const cropped = new Uint8Array(bounds.width * bounds.height * 4)
    for (let row = 0; row < bounds.height; row += 1) {
      for (let column = 0; column < bounds.width; column += 1) {
        const source = ((bounds.top + row) * WIDTH + bounds.left + column) * 4
        cropped.set(pixels.subarray(source, source + 4), (row * bounds.width + column) * 4)
      }
    }
    const coverage = coverageInRegion(cropped, bounds, mask, { flipY: false })
    expect(coverage[0].id).toBe(3)
    expect(coverage[0].pixels).toBeGreaterThan(coverage[1].pixels)
  })

  it('honours a minimum-pixel floor', () => {
    const bounds = regionBounds(lasso, WIDTH, HEIGHT)
    const mask = rasterizeRegion(lasso, bounds)
    const cropped = new Uint8Array(bounds.width * bounds.height * 4)
    for (let row = 0; row < bounds.height; row += 1) {
      for (let column = 0; column < bounds.width; column += 1) {
        const source = ((bounds.top + row) * WIDTH + bounds.left + column) * 4
        cropped.set(pixels.subarray(source, source + 4), (row * bounds.width + column) * 4)
      }
    }
    const beamPixels = coverageInRegion(cropped, bounds, mask, { flipY: false }).find((entry) => entry.id === 1)!.pixels
    const strict = coverageInRegion(cropped, bounds, mask, { flipY: false, minPixels: beamPixels + 1 })
    expect(strict.map((entry) => entry.id)).not.toContain(1)
  })
})

describe('box regions', () => {
  it('covers its whole extent without a polygon test', () => {
    const shape: RegionShape = { kind: 'box', x0: 10, y0: 10, x1: 13, y1: 12 }
    const bounds = regionBounds(shape, WIDTH, HEIGHT)
    expect(bounds).toEqual({ left: 10, top: 10, width: 4, height: 3 })
    expect([...rasterizeRegion(shape, bounds)].every((value) => value === 1)).toBe(true)
  })

  it('normalises a box dragged right-to-left and upward', () => {
    expect(regionBounds({ kind: 'box', x0: 20, y0: 30, x1: 5, y1: 8 }, WIDTH, HEIGHT)).toEqual({
      left: 5,
      top: 8,
      width: 16,
      height: 23,
    })
  })
})

describe('single-pixel picking', () => {
  const patch = 9
  const buildPatch = (entries: ReadonlyArray<{ id: number; x: number; y: number }>) => {
    const pixels = new Uint8Array(patch * patch * 4)
    for (const entry of entries) {
      const [r, g, b] = encodeId(entry.id)
      const offset = (entry.y * patch + entry.x) * 4
      pixels[offset] = r
      pixels[offset + 1] = g
      pixels[offset + 2] = b
      pixels[offset + 3] = 255
    }
    return pixels
  }

  it('returns an exact hit before any neighbour, whatever else is nearby', () => {
    // Priority rule 2: a direct hit is never overridden by a larger part one
    // pixel away, which is what stops a thin bar being unpickable next to a
    // baseplate.
    const pixels = buildPatch([
      { id: 7, x: 4, y: 4 },
      { id: 9, x: 3, y: 4 },
      { id: 9, x: 5, y: 4 },
    ])
    expect(nearestIdInPatch(pixels, patch, patch, 4, 4, false)).toBe(7)
  })

  it('expands outward only when the exact pixel is background', () => {
    const pixels = buildPatch([{ id: 12, x: 6, y: 4 }])
    expect(nearestIdInPatch(pixels, patch, patch, 4, 4, false)).toBe(12)
  })

  it('returns background when the whole patch is empty', () => {
    expect(nearestIdInPatch(new Uint8Array(patch * patch * 4), patch, patch, 4, 4, false)).toBe(0)
  })

  it('reads bottom-up buffers the way the GPU hands them back', () => {
    const pixels = buildPatch([{ id: 5, x: 4, y: 0 }])
    // Row 0 of a bottom-up buffer is the *bottom* row, so with the flip on it
    // must resolve at y = patch - 1 rather than at y = 0.
    expect(nearestIdInPatch(pixels, patch, patch, 4, patch - 1, true)).toBe(5)
  })
})

describe('the centre rule, kept only for comparison', () => {
  it('drops anything behind the camera', () => {
    const shape: RegionShape = { kind: 'box', x0: 0, y0: 0, x1: 100, y1: 100 }
    expect(centresInRegion([{ id: 'a', x: 50, y: 50, behindCamera: true }], shape)).toEqual([])
  })
})
