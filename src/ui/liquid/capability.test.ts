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
  const lensed: MaterialRole[] = ['bar', 'dock', 'sheet', 'island']
  const flat: MaterialRole[] = ['panel', 'control']

  it.each(lensed)('lenses the %s role', (role) => {
    expect(selectTier(inputs({ role }))).toBe('lensed')
  })

  it.each(flat)('leaves the %s role on blur however capable the machine is', (role) => {
    // Refraction on a 34px control is invisible and still costs a compositor
    // layer, and a lensed panel inside a lensed dock refracts an already
    // refracted backdrop, which reads as smeared rather than deep.
    expect(selectTier(inputs({ role, qualityTierIndex: 0 }))).toBe('blur')
  })
})

describe('pressure', () => {
  it('drops to blur while a gesture is in flight', () => {
    expect(selectTier(inputs({ interacting: true }))).toBe('blur')
  })

  it('drops to blur once the renderer has dropped below balanced', () => {
    expect(selectTier(inputs({ qualityTierIndex: MAX_LENSED_QUALITY_INDEX + 1 }))).toBe('blur')
  })

  it('still lenses at the balanced tier itself', () => {
    expect(selectTier(inputs({ qualityTierIndex: MAX_LENSED_QUALITY_INDEX }))).toBe('lensed')
  })

  it('lenses on a surface with no renderer at all', () => {
    // The marketing surfaces report no quality index because they are not
    // competing with a renderer for frame time.
    expect(selectTier(inputs({ qualityTierIndex: undefined }))).toBe('lensed')
  })
})
