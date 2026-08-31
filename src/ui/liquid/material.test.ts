import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLUR_PX, LENS_DEFAULTS, RADIUS_PX } from './LiquidMaterial'

/**
 * The duplicated numbers, held to the stylesheet.
 *
 * liquid-glass-react takes numbers, not custom properties, so radius, blur and
 * the lens tuning each exist twice: once in tokens.css where the rest of the
 * app reads them, and once in TypeScript where the lens does. Duplication is
 * only acceptable while something fails when the two disagree, which is what
 * this file is.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
const tokens = readFileSync(path.join(ROOT, 'src/ui/liquid/tokens.css'), 'utf8')

function numericToken(name: string): number {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)`).exec(tokens)
  if (!match) throw new Error(`--${name} is not declared as a number in tokens.css`)
  return Number(match[1])
}

describe('radius', () => {
  it.each(Object.entries(RADIUS_PX))('--r-%s matches the TypeScript mirror', (name, value) => {
    expect(numericToken(`r-${name}`)).toBe(value)
  })

  it('mirrors every radius the stylesheet declares, so none can be added unnoticed', () => {
    const declared = [...tokens.matchAll(/--r-([a-z]+):/g)].map((match) => match[1]).sort()
    expect(declared).toEqual(Object.keys(RADIUS_PX).sort())
  })
})

describe('blur', () => {
  it.each(Object.entries(BLUR_PX))('--glass-blur-%s matches the TypeScript mirror', (name, value) => {
    expect(numericToken(`glass-blur-${name}`)).toBe(value)
  })

  it('mirrors every blur role the stylesheet declares', () => {
    const declared = [...tokens.matchAll(/--glass-blur-([a-z]+):/g)].map((match) => match[1]).sort()
    expect(declared).toEqual(Object.keys(BLUR_PX).sort())
  })
})

describe('lens tuning', () => {
  it.each([
    ['lens-displacement', LENS_DEFAULTS.displacementScale],
    ['lens-aberration', LENS_DEFAULTS.aberrationIntensity],
    ['lens-elasticity', LENS_DEFAULTS.elasticity],
    ['lens-saturation', LENS_DEFAULTS.saturation],
  ])('--%s matches the TypeScript mirror', (name, value) => {
    expect(numericToken(name)).toBe(value)
  })

  it('keeps displacement below the point where the edge reads as a fisheye', () => {
    expect(LENS_DEFAULTS.displacementScale).toBeLessThanOrEqual(80)
  })
})

describe('the material stylesheet', () => {
  const material = readFileSync(path.join(ROOT, 'src/ui/liquid/material.css'), 'utf8')

  it('never filters the application root or a canvas', () => {
    // Filtering the surface a WebGL scene composites into costs frame time on
    // every frame, forever, to blur something nobody looks through.
    //
    // Comments are stripped before matching. Checking the raw source made this
    // assertion fail on the word "nobody" in the prose above the rules it
    // guards, which is a test that reads its own documentation as a defect.
    const selectors = material
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.slice(0, block.indexOf('{')).trim())
      .filter(Boolean)

    for (const selector of selectors) {
      expect(selector, `${selector} must not be a material surface`).not.toMatch(
        /(^|[\s,>+~])(#root|canvas|body|html)([\s,.:[]|$)/,
      )
    }
  })

  it('strips the host material at tier 1 so the lining has a backdrop to bend', () => {
    const start = material.lastIndexOf(".liquid-fill[data-tier='lensed']")
    const body = material.slice(start, material.indexOf('}', start))
    expect(body).toContain('background: none')
    expect(body).toContain('backdrop-filter: none')
  })

  it('keeps the stacking guarantee layered, so an authored z-index still wins', () => {
    // Unlayered, `z-index: 0` here overrode workbench.css's z-index on .topbar
    // (20), .dock (8) and .toolbar-island (18) and dropped the chrome behind
    // the WebGL canvas. The layer is what makes this rule yield.
    const layer = material.slice(material.indexOf('@layer liquid-stacking'))
    const body = layer.slice(0, layer.indexOf('}', layer.indexOf('{', layer.indexOf('{') + 1)))
    expect(body).toContain('z-index: 0')
    expect(body).toContain('position: relative')

    // Nothing outside the layer may declare z-index on a lensed host.
    const unlayered = material.slice(material.indexOf('}', material.indexOf('@layer liquid-stacking')))
    expect(unlayered).not.toMatch(/\.liquid-fill\[data-tier='lensed'\][^}]*z-index/)
  })

  it('never forms a backdrop root on a surface that has to refract', () => {
    // isolation: isolate is the obvious way to force a stacking context and is
    // exactly wrong here — it would leave the lining nothing to bend. Comments
    // are stripped so the rule explaining that does not read as a violation.
    expect(material.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('isolation')
  })

  it('removes blur entirely at tier 3 rather than merely softening it', () => {
    const block = material.slice(material.indexOf(".liquid-fill[data-tier='opaque']"))
    const body = block.slice(0, block.indexOf('}'))
    expect(body).toContain('backdrop-filter: none')
    expect(body).not.toMatch(/backdrop-filter:\s*blur/)
  })
})
