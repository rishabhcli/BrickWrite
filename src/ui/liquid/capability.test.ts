import { describe, expect, it } from 'vitest'
import { MAX_LENSED_QUALITY_INDEX, selectTier, type MaterialRole, type TierInputs } from './capability'

/**
 * Which material a surface gets, and why.
 *
 * Every branch here is a decision that costs either frame time or legibility,
 * so each one is pinned rather than left to be re-derived from the code. The
 * ordering matters as much as the outcomes: a preference must beat a
 * capability, and a capability must beat an optimisation, or a machine with
 * headroom could talk the material past somebody's accessibility setting.
 */

const CAPABLE = { backdropBlur: true, backdropUrlFilter: true }
const BLUR_ONLY = { backdropBlur: true, backdropUrlFilter: false }
const INCAPABLE = { backdropBlur: false, backdropUrlFilter: false }
const NO_PREFERENCES = { reducedTransparency: false, reducedMotion: false, increasedContrast: false }

const inputs = (overrides: Partial<TierInputs> = {}): TierInputs => ({
  role: 'bar',
  capabilities: CAPABLE,
  preferences: NO_PREFERENCES,
  interacting: false,
  ...overrides,
})

describe('preferences win over everything', () => {
  it('collapses to opaque for reduced transparency even on a fully capable machine', () => {
    const preferences = { ...NO_PREFERENCES, reducedTransparency: true }
    expect(selectTier(inputs({ preferences, qualityTierIndex: 0 }))).toBe('opaque')
  })

  it('collapses to opaque for increased contrast', () => {
    // A translucent surface is a contrast hazard by construction: the text's
    // background is whatever happens to be behind the panel this frame.
    const preferences = { ...NO_PREFERENCES, increasedContrast: true }
    expect(selectTier(inputs({ preferences }))).toBe('opaque')
  })
})

describe('capability', () => {
  it('is opaque where backdrop-filter is unavailable', () => {
    expect(selectTier(inputs({ capabilities: INCAPABLE }))).toBe('opaque')
  })

  it('is blur where an SVG filter cannot be referenced from a backdrop', () => {
    // Firefox. The blur material is a complete answer there, not a broken one.
    expect(selectTier(inputs({ capabilities: BLUR_ONLY }))).toBe('blur')
  })
})

describe('role', () => {
  const every: MaterialRole[] = ['bar', 'dock', 'sheet', 'island', 'panel', 'control']

  it.each(every)('leaves the %s role on blur, refraction being off', (role) => {
    // `bar`, `dock`, `sheet` and `island` used to lens. Refraction is off now:
    // it warped the model behind the chrome, which is the thing the operator
    // is looking at. The blur material keeps tint, rim and specular.
    expect(selectTier(inputs({ role, qualityTierIndex: 0 }))).toBe('blur')
  })

  it('does not lens even on the most capable machine and the quietest scene', () => {
    expect(selectTier(inputs({ role: 'island', qualityTierIndex: undefined, interacting: false }))).toBe('blur')
  })
})

describe('pressure', () => {
  it('is blur while a gesture is in flight', () => {
    expect(selectTier(inputs({ interacting: true }))).toBe('blur')
  })

  it('is blur once the renderer has dropped below balanced', () => {
    expect(selectTier(inputs({ qualityTierIndex: MAX_LENSED_QUALITY_INDEX + 1 }))).toBe('blur')
  })

  it('is blur at the balanced tier itself', () => {
    expect(selectTier(inputs({ qualityTierIndex: MAX_LENSED_QUALITY_INDEX }))).toBe('blur')
  })

  it('is blur on a surface with no renderer at all', () => {
    // The marketing surfaces report no quality index because they are not
    // competing with a renderer for frame time. They still do not refract.
    expect(selectTier(inputs({ qualityTierIndex: undefined }))).toBe('blur')
  })
})
