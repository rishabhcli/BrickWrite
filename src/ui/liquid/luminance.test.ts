import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fieldLuminance,
  isOverLight,
  lightnessOf,
  luminanceGrid,
  meanLuminance,
  OVER_LIGHT_REFERENCE,
  OVER_LIGHT_THRESHOLD,
  parseColor,
  relativeLuminance,
} from './luminance'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

describe('parseColor', () => {
  it.each([
    ['#fff', { r: 255, g: 255, b: 255 }],
    ['#000000', { r: 0, g: 0, b: 0 }],
    ['#0d1315', { r: 13, g: 19, b: 21 }],
    ['rgb(20, 24, 28)', { r: 20, g: 24, b: 28 }],
    ['rgba(20, 24, 28, 0.62)', { r: 20, g: 24, b: 28 }],
  ])('reads %s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected)
  })

  it('returns null rather than guessing at a form it does not know', () => {
    expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('anchors at the ends of the range', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })

  it('weights green above red above blue, as luminance does', () => {
    const red = relativeLuminance({ r: 255, g: 0, b: 0 })
    const green = relativeLuminance({ r: 0, g: 255, b: 0 })
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 })
    expect(green).toBeGreaterThan(red)
    expect(red).toBeGreaterThan(blue)
  })
})

describe('the over-light threshold', () => {
  it('does not trip on any surface in the dark palette', () => {
    // If it did, chrome would sit permanently in its inverted treatment and the
    // adaptation would be a constant rather than a response.
    const styles = read('src/styles.css')
    for (const name of ['panel', 'panel-2', 'void']) {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(styles)
      expect(match, `--${name} should be a hex literal`).not.toBeNull()
      const color = parseColor(match![1])!
      expect(isOverLight(relativeLuminance(color))).toBe(false)
    }
  })

  it('trips on the bright content it exists for', () => {
    expect(isOverLight(relativeLuminance({ r: 255, g: 255, b: 255 }))).toBe(true)
    expect(isOverLight(relativeLuminance({ r: 220, g: 220, b: 220 }))).toBe(true)
  })

  it('sits below the light-grey brick faces models are actually built from', () => {
    // Measured off the running editor: a light-grey face under the studio
    // environment reads sRGB ~179, which is luminance 0.44. A threshold above
    // that — 0.5, as this started out — sits just past the most common bright
    // thing in the product, and the adaptation never fires.
    const lightGreyBrick = relativeLuminance({ r: 170, g: 179, b: 183 })
    expect(lightGreyBrick).toBeGreaterThan(OVER_LIGHT_THRESHOLD)
    expect(isOverLight(lightGreyBrick)).toBe(true)
  })

  it('still clears every surface in the dark palette by a wide margin', () => {
    expect(OVER_LIGHT_THRESHOLD).toBeGreaterThan(relativeLuminance({ r: 18, g: 26, b: 29 }) * 8)
  })
})

describe('luminanceGrid and fieldLuminance', () => {
  /** A 2x2 field: bright along the top row, black along the bottom. */
  const pixels = [
    255, 255, 255, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ]
  const field = { cells: luminanceGrid(pixels), columns: 2, rows: 2 }

  it('produces one cell per pixel', () => {
    expect(field.cells).toHaveLength(4)
  })

  it('reads only the cells a surface actually covers', () => {
    // The whole-field average is 0.5 and would answer the same for both halves,
    // which is exactly the failure this replaced: a bright wall behind one
    // corner of the viewport told every surface the scene was mid-grey.
    const top = fieldLuminance(field, { left: 0, top: 0, width: 1, height: 0.5 })
    const bottom = fieldLuminance(field, { left: 0, top: 0.5, width: 1, height: 0.5 })
    expect(top).toBeCloseTo(1, 5)
    expect(bottom).toBeCloseTo(0, 5)
  })

  it('clamps a box that runs past the sampled region', () => {
    expect(fieldLuminance(field, { left: -1, top: -1, width: 4, height: 4 })).toBeCloseTo(0.5, 5)
  })

  it('answers zero for an empty field rather than dividing by nothing', () => {
    expect(fieldLuminance({ cells: [], columns: 0, rows: 0 }, { left: 0, top: 0, width: 1, height: 1 })).toBe(0)
  })
})

describe('meanLuminance', () => {
  it('averages an RGBA buffer and ignores the alpha channel', () => {
    const black = [0, 0, 0, 255]
    const white = [255, 255, 255, 0]
    expect(meanLuminance([...black, ...white])).toBeCloseTo(0.5, 2)
  })

  it('answers zero for a buffer too short to hold a pixel', () => {
    expect(meanLuminance([1, 2, 3])).toBe(0)
  })
})

describe('lightnessOf', () => {
  it('grades rather than switching', () => {
    // Measured on the running editor: a popover half over a white plate and
    // half over the void reads 0.218. A boolean has to call that either fully
    // light or fully dark; both answers are visibly wrong, so the lensed tier
    // interpolates across this instead.
    const halfOver = lightnessOf(0.218)
    expect(halfOver).toBeGreaterThan(0.2)
    expect(halfOver).toBeLessThan(0.8)
  })

  it('anchors at both ends and clamps beyond them', () => {
    expect(lightnessOf(0)).toBe(0)
    expect(lightnessOf(OVER_LIGHT_REFERENCE)).toBe(1)
    expect(lightnessOf(5)).toBe(1)
    expect(lightnessOf(-1)).toBe(0)
  })

  it('leaves the dark palette effectively unlit', () => {
    expect(lightnessOf(relativeLuminance({ r: 18, g: 26, b: 29 }))).toBeLessThan(0.05)
  })
})
