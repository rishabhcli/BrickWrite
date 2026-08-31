/**
 * What material this browser can actually paint.
 *
 * Three tiers, chosen by capability rather than by user agent. A browser that
 * misreports is not a correctness problem here: every failure direction lands
 * on a *simpler* material that still meets contrast, so the worst outcome of a
 * wrong answer is a surface that looks flatter than it needed to.
 */

/** Ordered cheapest-last: `lensed` costs the most, `opaque` the least. */
export type MaterialTier = 'lensed' | 'blur' | 'opaque'

export interface CapabilityReport {
  /** `backdrop-filter: blur()` in either the standard or WebKit-prefixed form. */
  readonly backdropBlur: boolean
  /**
   * An SVG filter referenced from `backdrop-filter`, which is what carries the
   * displacement map that does the actual refracting. Firefox reports false.
   */
  readonly backdropUrlFilter: boolean
}

export interface PreferenceReport {
  readonly reducedTransparency: boolean
  readonly reducedMotion: boolean
  readonly increasedContrast: boolean
}

const supports = (property: string, value: string): boolean => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  try {
    return CSS.supports(property, value)
  } catch {
    return false
  }
}

export function probeCapabilities(): CapabilityReport {
  const backdropBlur = supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)')
  return {
    backdropBlur,
    // The id is deliberately one that does not exist. `CSS.supports` parses the
    // value; it does not resolve the reference, and a filter that resolves to
    // nothing is exactly what we want a probe to cost.
    backdropUrlFilter: backdropBlur && supports('backdrop-filter', 'url(#liquid-capability-probe)'),
  }
}

const matches = (query: string): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

export const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
export const INCREASED_CONTRAST_QUERY = '(prefers-contrast: more)'

export function readPreferences(): PreferenceReport {
  return {
    reducedTransparency: matches(REDUCED_TRANSPARENCY_QUERY),
    reducedMotion: matches(REDUCED_MOTION_QUERY),
    increasedContrast: matches(INCREASED_CONTRAST_QUERY),
  }
}

/**
 * Roles that are worth lensing.
 *
 * Refraction earns its cost on a large, mostly-empty surface with a long edge
 * against moving content behind it. On a 6px-radius chip it is invisible and
 * still costs a compositor layer, so the small roles stay on blur no matter how
 * capable the machine is.
 */
export type MaterialRole = 'bar' | 'dock' | 'sheet' | 'island' | 'panel' | 'control'

const LENSED_ROLES: ReadonlySet<MaterialRole> = new Set<MaterialRole>(['bar', 'dock', 'sheet', 'island'])

export interface TierInputs {
  readonly role: MaterialRole
  readonly capabilities: CapabilityReport
  readonly preferences: PreferenceReport
  /**
   * Index into src/editor/render/quality.ts QUALITY_TIERS, pushed in by the
   * editor. Higher is cheaper. Undefined on surfaces with no renderer, which
   * are by definition not competing with one for frame time.
   */
  readonly qualityTierIndex?: number
  /** True while a continuous gesture is in flight: orbit, drag, scrub. */
  readonly interacting: boolean
}

/**
 * Below `balanced` the machine has already told us it is struggling. Lensing a
 * surface at that point spends frame time the renderer has just finished
 * proving it does not have.
 */
export const MAX_LENSED_QUALITY_INDEX = 2

export function selectTier(inputs: TierInputs): MaterialTier {
  const { role, capabilities, preferences, qualityTierIndex, interacting } = inputs

  if (preferences.reducedTransparency || preferences.increasedContrast) return 'opaque'
  if (!capabilities.backdropBlur) return 'opaque'

  if (!capabilities.backdropUrlFilter) return 'blur'
  if (!LENSED_ROLES.has(role)) return 'blur'
  if (interacting) return 'blur'
  if (qualityTierIndex !== undefined && qualityTierIndex > MAX_LENSED_QUALITY_INDEX) return 'blur'

  return 'lensed'
}
