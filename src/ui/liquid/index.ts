/**
 * The Liquid Glass material system.
 *
 * Component names match the retired src/ui/glass exports on purpose: across
 * every consumer, only the import path changed, so each diff is one line plus
 * the ad-hoc CSS it retires rather than a wall of JSX churn.
 */
export { LiquidStage, useLiquidEnvironment, useLiquidPointer, useLiquidPerformance } from './LiquidStage'
export type {
  BackdropReport,
  LiquidStageProps,
  LiquidEnvironment,
  PerformanceReport,
  PointerPosition,
} from './LiquidStage'

export { overlapFraction, useHostRect, OVERLAP_THRESHOLD } from './rect'
export type { Box } from './rect'

export { useLiquidSurface, RADIUS_PX, BLUR_PX, LENS_DEFAULTS, joinClassNames, mergeRefs } from './LiquidMaterial'
export type { LiquidRadius, LiquidBlur, Surface, SurfaceOptions } from './LiquidMaterial'

export { selectTier, probeCapabilities, readPreferences, MAX_LENSED_QUALITY_INDEX } from './capability'
export type { MaterialTier, MaterialRole, CapabilityReport, PreferenceReport, TierInputs } from './capability'

export { SPRINGS, SETTLED, transitionFor, prefersReducedMotion, pressScale, SETTLE_DELAY_MS } from './motion'
export type { MotionTier } from './motion'

export {
  fieldLuminance,
  isOverLight,
  luminanceGrid,
  meanLuminance,
  parseColor,
  relativeLuminance,
  OVER_LIGHT_THRESHOLD,
  SAMPLE_BUDGET_MS,
  SAMPLE_INTERVAL_MS,
} from './luminance'
export type { LuminanceField, Rgb } from './luminance'

export { GlassPanel } from './GlassPanel'
export type { GlassPanelProps } from './GlassPanel'
export { GlassBar } from './GlassBar'
export type { GlassBarProps } from './GlassBar'
export { GlassDock } from './GlassDock'
export type { GlassDockProps } from './GlassDock'
export { GlassIsland } from './GlassIsland'
export type { GlassIslandProps } from './GlassIsland'
export { GlassTabs } from './GlassTabs'
export type { GlassTab, GlassTabsProps } from './GlassTabs'
export { GlassButton } from './GlassButton'
export type { GlassButtonProps, GlassButtonVariant } from './GlassButton'
export { GlassField } from './GlassField'
export type { GlassFieldProps } from './GlassField'
export { GlassSheet } from './GlassSheet'
export type { GlassSheetProps } from './GlassSheet'
export { GlassNotice } from './GlassNotice'
export type { GlassNoticeProps, GlassNoticeTone } from './GlassNotice'
