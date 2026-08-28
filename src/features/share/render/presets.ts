import type { CardPresetId } from '../types'

/**
 * Share Studio settings and the deterministic presets built on them.
 *
 * Two constraints shaped this vocabulary.
 *
 * **The renderer's camera is fixed.** `src/cad/raster.ts` projects along one
 * hard-coded direction, which is exactly what makes a printed booklet stable
 * from page to page. Rather than fork it, the studio rotates *the model* by the
 * inverse of the camera move: the image is identical either way, and the one
 * tested rasteriser stays the only one. `camera.yaw/pitch/roll` therefore
 * describe where the viewer stands, and `scene.ts` turns that into a basis.
 *
 * **The key light is fixed in document space.** Rotating the model rotates it
 * relative to that light, which is what a real turntable under a studio lamp
 * does, so orbiting genuinely changes which faces catch the key. What the
 * studio cannot do is *move* the lamp, so the lighting controls here are
 * honest tone controls — exposure, contrast, shadow lift — applied to the
 * rendered buffer, not a relight. They are named accordingly.
 */

export interface CameraSettings {
  /** Degrees about the model's vertical axis. */
  yaw: number
  /** Degrees of elevation relative to the default three-quarter view. */
  pitch: number
  /** Degrees in the image plane. */
  roll: number
}

export interface FramingSettings {
  /** Fraction of the frame kept clear on every side. */
  padding: number
  /** Multiplier on the fitted scale. 1 fits the model exactly. */
  zoom: number
  /** Pan, as a fraction of frame width/height. */
  offsetX: number
  offsetY: number
}

export type BackgroundSettings =
  | { kind: 'transparent' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'grid'; color: string; line: string; spacing: number }

export interface ToneSettings {
  /** Multiplier on rendered luminance. 1 is the rasteriser's own output. */
  exposure: number
  /** 1 is neutral; above 1 pushes away from mid grey. */
  contrast: number
  /** Lifts the darkest values, so a dark background keeps shadow detail. */
  shadowLift: number
}

export type WatermarkPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

export interface WatermarkSettings {
  text: string
  position: WatermarkPosition
  opacity: number
  /** Pixels per stencil cell. */
  scale: number
  color: string
}

export interface ShareStudioSettings {
  camera: CameraSettings
  framing: FramingSettings
  background: BackgroundSettings
  tone: ToneSettings
  /** `null` means no mark is drawn at all. */
  watermark: WatermarkSettings | null
  /** Draws the model's own outline, the same pass the booklet uses. */
  outline: boolean
  /** Supersampling factor. Higher is slower and smoother; 2 is the default. */
  supersample: 1 | 2 | 3
}

export type StudioPresetId = 'studio' | 'paper' | 'blueprint' | 'cutout' | 'contact'

export const STUDIO_PRESET_IDS: readonly StudioPresetId[] = ['studio', 'paper', 'blueprint', 'cutout', 'contact']

const NEUTRAL_TONE: ToneSettings = { exposure: 1, contrast: 1, shadowLift: 0 }
const DEFAULT_CAMERA: CameraSettings = { yaw: 0, pitch: 0, roll: 0 }
const DEFAULT_FRAMING: FramingSettings = { padding: 0.1, zoom: 1, offsetX: 0, offsetY: 0 }

const WATERMARK: WatermarkSettings = {
  text: 'BRICKWRIGHT',
  position: 'bottom-right',
  opacity: 0.55,
  scale: 3,
  color: '#738085',
}

/**
 * The presets.
 *
 * Every field is stated rather than inherited, so reading one entry tells you
 * the whole render. A preset is part of the cache key for a card, so changing
 * one of these numbers changes the output hash — which is the intended
 * behaviour, and why they are frozen.
 */
export const STUDIO_PRESETS: Readonly<Record<StudioPresetId, ShareStudioSettings>> = Object.freeze({
  studio: {
    camera: DEFAULT_CAMERA,
    framing: DEFAULT_FRAMING,
    // The application's own void colour, so a card dropped into a thread reads
    // as the same object as the editor it came from.
    background: { kind: 'gradient', from: '#12191c', to: '#090d0e', angle: 145 },
    tone: { exposure: 1.04, contrast: 1.06, shadowLift: 0.04 },
    watermark: WATERMARK,
    outline: true,
    supersample: 2,
  },
  paper: {
    camera: DEFAULT_CAMERA,
    framing: { ...DEFAULT_FRAMING, padding: 0.12 },
    background: { kind: 'solid', color: '#f4f2ee' },
    tone: { exposure: 1, contrast: 1, shadowLift: 0 },
    watermark: { ...WATERMARK, color: '#8a8f88', opacity: 0.5 },
    outline: true,
    supersample: 2,
  },
  blueprint: {
    camera: { yaw: -18, pitch: 6, roll: 0 },
    framing: { ...DEFAULT_FRAMING, padding: 0.13 },
    background: { kind: 'grid', color: '#0b1a22', line: '#12313c', spacing: 48 },
    tone: { exposure: 0.98, contrast: 1.12, shadowLift: 0.06 },
    watermark: { ...WATERMARK, color: '#83e7ee', opacity: 0.45 },
    outline: true,
    supersample: 2,
  },
  cutout: {
    camera: DEFAULT_CAMERA,
    framing: { ...DEFAULT_FRAMING, padding: 0.06 },
    background: { kind: 'transparent' },
    tone: NEUTRAL_TONE,
    watermark: null,
    outline: true,
    supersample: 2,
  },
  contact: {
    camera: { yaw: 0, pitch: 0, roll: 0 },
    framing: { ...DEFAULT_FRAMING, padding: 0.08 },
    background: { kind: 'solid', color: '#151c1f' },
    tone: { exposure: 1, contrast: 1, shadowLift: 0.02 },
    watermark: null,
    outline: false,
    supersample: 1,
  },
})

export const DEFAULT_STUDIO_PRESET: StudioPresetId = 'studio'

/** Deep copy, so a caller editing settings cannot mutate a frozen preset. */
export function cloneSettings(settings: ShareStudioSettings): ShareStudioSettings {
  return {
    camera: { ...settings.camera },
    framing: { ...settings.framing },
    background: { ...settings.background },
    tone: { ...settings.tone },
    watermark: settings.watermark ? { ...settings.watermark } : null,
    outline: settings.outline,
    supersample: settings.supersample,
  }
}

/**
 * Clamps, with an explicit fallback for a value that is not a number at all.
 *
 * The fallback is stated by every caller rather than defaulting to the low
 * bound, because "not a number" and "too small" are different faults: a NaN pan
 * offset should re-centre, not slam the model to the left edge.
 */
const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback

/**
 * Brings arbitrary settings into range.
 *
 * Applied on every path that accepts settings from outside this module —
 * including the query string of a card request — so a hostile caller cannot ask
 * for a 400× zoom or a supersample of 64 and turn card rendering into a denial
 * of service.
 */
export function normaliseSettings(settings: ShareStudioSettings): ShareStudioSettings {
  const supersample = ([1, 2, 3] as const).includes(settings.supersample as 1 | 2 | 3)
    ? settings.supersample
    : 2
  return {
    camera: {
      yaw: wrapDegrees(settings.camera.yaw),
      pitch: clamp(settings.camera.pitch, -85, 85, 0),
      roll: wrapDegrees(settings.camera.roll),
    },
    framing: {
      padding: clamp(settings.framing.padding, 0, 0.4, 0.1),
      zoom: clamp(settings.framing.zoom, 0.25, 4, 1),
      offsetX: clamp(settings.framing.offsetX, -0.5, 0.5, 0),
      offsetY: clamp(settings.framing.offsetY, -0.5, 0.5, 0),
    },
    background: normaliseBackground(settings.background),
    tone: {
      exposure: clamp(settings.tone.exposure, 0.2, 3, 1),
      contrast: clamp(settings.tone.contrast, 0.2, 3, 1),
      shadowLift: clamp(settings.tone.shadowLift, 0, 0.6, 0),
    },
    watermark: settings.watermark
      ? {
          text: settings.watermark.text.slice(0, 48),
          position: settings.watermark.position,
          opacity: clamp(settings.watermark.opacity, 0, 1, WATERMARK.opacity),
          scale: Math.round(clamp(settings.watermark.scale, 1, 12, WATERMARK.scale)),
          color: normaliseHex(settings.watermark.color, '#738085'),
        }
      : null,
    outline: Boolean(settings.outline),
    supersample,
  }
}

function normaliseBackground(background: BackgroundSettings): BackgroundSettings {
  switch (background.kind) {
    case 'solid':
      return { kind: 'solid', color: normaliseHex(background.color, '#090d0e') }
    case 'gradient':
      return {
        kind: 'gradient',
        from: normaliseHex(background.from, '#12191c'),
        to: normaliseHex(background.to, '#090d0e'),
        angle: wrapDegrees(background.angle),
      }
    case 'grid':
      return {
        kind: 'grid',
        color: normaliseHex(background.color, '#0b1a22'),
        line: normaliseHex(background.line, '#12313c'),
        spacing: Math.round(clamp(background.spacing, 8, 256, 48)),
      }
    default:
      return { kind: 'transparent' }
  }
}

/** Keeps an angle in [0, 360) so two equivalent rotations hash identically. */
export function wrapDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0
  const wrapped = value % 360
  // Rounded to a tenth of a degree: below that the render is identical anyway,
  // and an unrounded float would fragment the card cache. `+ 0` collapses the
  // negative zero that `-720 % 360` produces — the render is the same either
  // way, but two spellings of the same angle would be two cache entries.
  return Math.round((wrapped < 0 ? wrapped + 360 : wrapped) * 10) / 10 + 0
}

export function normaliseHex(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const match = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(value.trim())
  if (!match) return fallback
  const digits = match[1].toLowerCase()
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits}`
}

// ---------------------------------------------------------------------------
// Card geometry
// ---------------------------------------------------------------------------

export interface CardGeometry {
  id: CardPresetId
  width: number
  height: number
  label: string
  /** What the crop is for, shown in the studio. */
  purpose: string
  /** Forces a transparent background regardless of the studio preset. */
  forceTransparent?: boolean
}

/**
 * The crops that actually exist on the platforms people share to.
 *
 * These are the documented ratios, not approximations: 1:1, 4:5, 1.91:1, the
 * OpenGraph reference size and the Twitter/X `summary_large_image` size. A card
 * that is a few pixels off gets re-encoded by the platform, which is exactly
 * how a deterministic artifact stops being one.
 */
export const CARD_GEOMETRY: Readonly<Record<CardPresetId, CardGeometry>> = Object.freeze({
  square: { id: 'square', width: 1200, height: 1200, label: 'Square 1:1', purpose: 'Feed posts and profile grids' },
  portrait: { id: 'portrait', width: 1080, height: 1350, label: 'Portrait 4:5', purpose: 'Tall feed placements' },
  landscape: {
    id: 'landscape',
    width: 1200,
    height: 628,
    label: 'Landscape 1.91:1',
    purpose: 'Link previews and banners',
  },
  opengraph: { id: 'opengraph', width: 1200, height: 630, label: 'OpenGraph', purpose: 'og:image' },
  twitter: { id: 'twitter', width: 1200, height: 600, label: 'Twitter card', purpose: 'summary_large_image' },
  transparent: {
    id: 'transparent',
    width: 1200,
    height: 1200,
    label: 'Transparent PNG',
    purpose: 'Slides, docs and compositing',
    forceTransparent: true,
  },
})

export const CARD_PRESET_IDS = Object.keys(CARD_GEOMETRY) as CardPresetId[]

/** The crop a share page advertises as `og:image`. */
export const OG_CARD: CardPresetId = 'opengraph'
