import { useCallback, useRef, type ReactNode } from 'react'
import './material.css'
import { selectTier, type MaterialRole, type MaterialTier } from './capability'
import { useLiquidEnvironment } from './LiquidStage'
import { LiquidLens } from './lens'
import { fieldLuminance, isOverLight, lightnessOf } from './luminance'
import { overlapFraction, useHostRect, OVERLAP_THRESHOLD } from './rect'

export type LiquidRadius = 'control' | 'section' | 'panel' | 'island' | 'sheet'
export type LiquidBlur = 'nav' | 'control' | 'chip'

/**
 * Pixel mirrors of the --r-* and --glass-blur-* tokens.
 *
 * The lens takes numbers, not custom properties, so these values exist twice:
 * here and in tokens.css. material.test.ts parses the stylesheet and fails if
 * the two ever disagree, which is the only reason duplicating them is
 * acceptable.
 */
export const RADIUS_PX: Record<LiquidRadius, number> = {
  control: 14,
  section: 18,
  panel: 22,
  island: 28,
  sheet: 26,
}

export const BLUR_PX: Record<LiquidBlur, number> = {
  nav: 20,
  control: 10,
  chip: 6,
}

export const LENS_DEFAULTS = {
  displacementScale: 64,
  aberrationIntensity: 2,
  elasticity: 0.15,
  saturation: 130,
} as const

export function joinClassNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

export interface SurfaceOptions {
  readonly role: MaterialRole
  /** The legacy role class, kept so app selectors such as `.topbar.glass-bar` keep matching. */
  readonly roleClass: string
  readonly radius: LiquidRadius
  readonly blur: LiquidBlur
  readonly className?: string
  /**
   * Forces the over-light treatment. Leave unset to let the surface decide from
   * the measured backdrop, which is what a caller almost always wants.
   */
  readonly overLight?: boolean
}

export interface Surface {
  readonly tier: MaterialTier
  readonly className: string
  /** Merge into the host element so the lens can measure it. */
  readonly hostRef: (node: HTMLElement | null) => void
  /** The lining, or null on tiers that do not refract. Render as the host's first child. */
  readonly lens: ReactNode
  /** For styling hooks and for tests that assert which material actually rendered. */
  readonly dataTier: MaterialTier
}

/**
 * Resolves one surface's material for this render.
 *
 * Everything the decision needs — capability, preference, renderer pressure,
 * gesture state — arrives from LiquidStage, so a surface never probes anything
 * itself and every surface in the app answers the same question the same way.
 */
export function useLiquidSurface(options: SurfaceOptions): Surface {
  const { role, roleClass, radius, blur, className, overLight } = options
  const environment = useLiquidEnvironment()
  const hostElement = useRef<HTMLElement | null>(null)
  const rect = useHostRect(hostElement)

  const tier = selectTier({
    role,
    capabilities: environment.capabilities,
    preferences: environment.preferences,
    qualityTierIndex: environment.qualityTierIndex,
    interacting: environment.interacting,
  })

  const hostRef = useCallback((node: HTMLElement | null) => {
    hostElement.current = node
  }, [])

  /*
   * Adaptation, from a measurement rather than a guess.
   *
   * A surface only adopts the scene's luminance when it is genuinely sitting
   * over the scene. In this editor's grid the docks sit beside the canvas and
   * the topbar above it, so they overlap it not at all and keep reading the
   * page behind them — which is the correct answer for them, not a limitation.
   */
  const { backdrop } = environment
  const overScene =
    backdrop !== undefined && rect !== null && overlapFraction(rect, backdrop.region) >= OVERLAP_THRESHOLD
  const luminance = overScene
    ? fieldLuminance(backdrop, {
        left: (rect.left - backdrop.region.left) / backdrop.region.width,
        top: (rect.top - backdrop.region.top) / backdrop.region.height,
        width: rect.width / backdrop.region.width,
        height: rect.height / backdrop.region.height,
      })
    : 0

  // The class is a switch for the blur tier, which is CSS-only. The lensed tier
  // gets the continuous value, because glass grades rather than snapping.
  const resolvedOverLight = overLight ?? (overScene ? isOverLight(luminance) : false)
  const lightness = overLight === true ? 1 : overLight === false ? 0 : lightnessOf(luminance)

  const lens =
    tier === 'lensed' ? (
      <LiquidLens
        rect={rect}
        cornerRadius={RADIUS_PX[radius]}
        blurAmount={BLUR_PX[blur]}
        lightness={lightness}
        {...LENS_DEFAULTS}
      />
    ) : null

  return {
    tier,
    dataTier: tier,
    hostRef,
    lens,
    className: joinClassNames(
      'liquid-fill',
      roleClass,
      `liquid-radius-${radius}`,
      `liquid-blur-${blur}`,
      resolvedOverLight && 'liquid-over-light',
      className,
    ),
  }
}

/** Merges the hook's host ref with a ref forwarded by a consumer. */
export function mergeRefs<T extends HTMLElement>(
  ...refs: Array<((node: T | null) => void) | { current: T | null } | null | undefined>
): (node: T | null) => void {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }
  }
}
