import { renderScene, rgbFromHex, type RasterImage, type Rgb } from '../../../cad/raster'
import type { AnimationPresetId, CardPresetId, PublishedDocument } from '../types'
import { drawCaption, GLYPH_HEIGHT, measureCaption } from './font'
import { encodeApng, encodePng, type PngImage } from './png'
import {
  CARD_GEOMETRY,
  cloneSettings,
  normaliseSettings,
  type BackgroundSettings,
  type ShareStudioSettings,
  type ToneSettings,
} from './presets'
import { buildScene, frameForCard, type GeometryResolver } from './scene'

/**
 * Card rendering: model, background, tone, mark, PNG.
 *
 * Every stage is a pure function of its inputs, so the whole pipeline is. That
 * is the determinism gate: the same published revision and the same preset
 * produce the same bytes, on any machine, in any runtime. Nothing here reads a
 * clock, a locale, a random source or a canvas.
 *
 * The one deliberate impurity is *cost*: a 1200×1200 card at supersample 2 is
 * 5.8 million shaded samples, and that is genuinely a second or two of
 * JavaScript. Cards are therefore rendered once, at publish time, where the
 * geometry is already resident — never per request at the edge.
 */

export interface CardRenderInput {
  document: PublishedDocument
  geometry: GeometryResolver
  /** LDraw colour code to linear RGB. Supplied by the caller's catalog. */
  palette: (code: number) => Rgb
  settings: ShareStudioSettings
  /** Second caption line under the watermark; the publisher's attribution. */
  attribution?: string | null
}

export interface RenderedCard {
  preset: CardPresetId | AnimationPresetId
  width: number
  height: number
  frames: number
  bytes: Uint8Array
  /** Fraction of the frame the model covers, for asserting it drew something. */
  coverage: number
  missingDefinitionIds: string[]
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * Applies the studio's tone controls to the rendered model pixels.
 *
 * Deliberately *not* a relight — the rasteriser's key light is fixed in
 * document space and this pass runs after shading. Exposure scales, contrast
 * pivots about mid grey, and the shadow lift raises the darkest values so a
 * black-on-black card keeps its silhouette. Alpha is untouched: it is coverage,
 * and tone must not change what the model covers.
 */
function applyTone(rgba: Uint8ClampedArray, tone: ToneSettings) {
  if (tone.exposure === 1 && tone.contrast === 1 && tone.shadowLift === 0) return
  // A 256-entry lookup: the transfer function is per-channel and the input is
  // 8-bit, so the whole curve is 256 evaluations rather than millions.
  const curve = new Uint8ClampedArray(256)
  for (let value = 0; value < 256; value += 1) {
    let level = (value / 255) * tone.exposure
    level = (level - 0.5) * tone.contrast + 0.5
    level = level + tone.shadowLift * (1 - clamp01(level))
    curve[value] = Math.round(clamp01(level) * 255)
  }
  for (let pixel = 0; pixel < rgba.length; pixel += 4) {
    if (rgba[pixel + 3] === 0) continue
    rgba[pixel] = curve[rgba[pixel]]
    rgba[pixel + 1] = curve[rgba[pixel + 1]]
    rgba[pixel + 2] = curve[rgba[pixel + 2]]
  }
}

/** Paints the background into a fresh buffer, then composites the model over it. */
function compositeBackground(
  model: RasterImage,
  background: BackgroundSettings,
): Uint8ClampedArray {
  const { width, height } = model
  const out = new Uint8ClampedArray(width * height * 4)

  if (background.kind !== 'transparent') paintBackground(out, width, height, background)

  for (let pixel = 0; pixel < out.length; pixel += 4) {
    const alpha = model.rgba[pixel + 3] / 255
    if (alpha === 0) continue
    for (let channel = 0; channel < 3; channel += 1) {
      out[pixel + channel] = Math.round(
        model.rgba[pixel + channel] * alpha + out[pixel + channel] * (1 - alpha),
      )
    }
    // Over an opaque background the result is opaque; over transparency the
    // model's own coverage survives, which is what a cut-out export needs.
    out[pixel + 3] = Math.round(255 * alpha + out[pixel + 3] * (1 - alpha))
  }
  return out
}

function paintBackground(out: Uint8ClampedArray, width: number, height: number, background: BackgroundSettings) {
  if (background.kind === 'solid') {
    const [r, g, b] = rgbFromHex(background.color)
    for (let pixel = 0; pixel < out.length; pixel += 4) {
      out[pixel] = Math.round(r * 255)
      out[pixel + 1] = Math.round(g * 255)
      out[pixel + 2] = Math.round(b * 255)
      out[pixel + 3] = 255
    }
    return
  }

  if (background.kind === 'gradient') {
    const from = rgbFromHex(background.from)
    const to = rgbFromHex(background.to)
    const radians = (background.angle * Math.PI) / 180
    const dirX = Math.cos(radians)
    const dirY = Math.sin(radians)
    // Project each pixel onto the gradient axis and normalise by the axis's own
    // extent, so the ramp always spans the frame whatever the angle.
    const extent = Math.abs(dirX) * width + Math.abs(dirY) * height
    const originX = dirX < 0 ? width : 0
    const originY = dirY < 0 ? height : 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const t = extent < 1e-6 ? 0 : clamp01(((x - originX) * dirX + (y - originY) * dirY) / extent)
        const pixel = (y * width + x) * 4
        out[pixel] = Math.round((from[0] + (to[0] - from[0]) * t) * 255)
        out[pixel + 1] = Math.round((from[1] + (to[1] - from[1]) * t) * 255)
        out[pixel + 2] = Math.round((from[2] + (to[2] - from[2]) * t) * 255)
        out[pixel + 3] = 255
      }
    }
    return
  }

  if (background.kind !== 'grid') return
  const base = rgbFromHex(background.color)
  const line = rgbFromHex(background.line)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onLine = x % background.spacing === 0 || y % background.spacing === 0
      const colour = onLine ? line : base
      const pixel = (y * width + x) * 4
      out[pixel] = Math.round(colour[0] * 255)
      out[pixel + 1] = Math.round(colour[1] * 255)
      out[pixel + 2] = Math.round(colour[2] * 255)
      out[pixel + 3] = 255
    }
  }
}

/** Draws the wordmark and, when present, the attribution line beneath it. */
function drawMarks(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  settings: ShareStudioSettings,
  attribution: string | null,
) {
  const watermark = settings.watermark
  if (!watermark) return
  const margin = Math.max(10, Math.round(Math.min(width, height) * 0.032))
  const rgb = rgbFromHex(watermark.color)
  const target = { rgba, width, height }

  const primaryWidth = measureCaption(watermark.text, watermark.scale)
  const secondScale = Math.max(1, Math.round(watermark.scale * 0.7))
  const secondaryWidth = attribution ? measureCaption(attribution, secondScale) : 0
  const blockWidth = Math.max(primaryWidth, secondaryWidth)
  const gap = Math.max(2, Math.round(watermark.scale * 1.2))
  const blockHeight = GLYPH_HEIGHT * watermark.scale + (attribution ? gap + GLYPH_HEIGHT * secondScale : 0)

  const right = watermark.position === 'bottom-right' || watermark.position === 'top-right'
  const bottom = watermark.position === 'bottom-left' || watermark.position === 'bottom-right'
  const blockX = right ? width - margin - blockWidth : margin
  const blockY = bottom ? height - margin - blockHeight : margin

  drawCaption(target, watermark.text, {
    x: right ? blockX + blockWidth - primaryWidth : blockX,
    y: blockY,
    scale: watermark.scale,
    rgb,
    opacity: watermark.opacity,
  })
  if (attribution) {
    drawCaption(target, attribution, {
      x: right ? blockX + blockWidth - secondaryWidth : blockX,
      y: blockY + GLYPH_HEIGHT * watermark.scale + gap,
      scale: secondScale,
      rgb,
      // The attribution sits under the mark, so it is quieter by design.
      opacity: watermark.opacity * 0.8,
    })
  }
}

interface FrameOptions {
  include?: ReadonlySet<string> | null
  highlight?: ReadonlySet<string> | null
  explode?: number
  yawOffset?: number
  /** Frame from the whole model rather than from what this frame draws. */
  fixedFraming?: boolean
}

/** Renders one composited frame at an arbitrary size. */
export function renderFrame(
  input: CardRenderInput,
  width: number,
  height: number,
  options: FrameOptions = {},
): { image: PngImage; coverage: number; missingDefinitionIds: string[] } {
  const settings = normaliseSettings(input.settings)
  const camera = options.yawOffset
    ? { ...settings.camera, yaw: settings.camera.yaw + options.yawOffset }
    : settings.camera

  const scene = buildScene(input.document, input.geometry, {
    camera,
    palette: input.palette,
    include: options.include ?? null,
    highlight: options.highlight ?? null,
    explode: options.explode ?? 0,
  })

  const framing = frameForCard(
    options.fixedFraming ? scene.fullBounds : scene.bounds,
    width,
    height,
    settings.framing,
    settings.supersample,
  )
  const rendered = renderScene(scene.parts, framing, {
    palette: (code) => input.palette(code),
    outlineNew: settings.outline,
  })

  const toned = new Uint8ClampedArray(rendered.rgba)
  applyTone(toned, settings.tone)
  const composited = compositeBackground({ ...rendered, rgba: toned }, settings.background)
  drawMarks(composited, width, height, settings, input.attribution ?? null)

  return {
    image: { rgba: composited, width, height },
    coverage: rendered.coverage,
    missingDefinitionIds: scene.missingDefinitionIds,
  }
}

/**
 * Renders one social crop.
 *
 * The transparent preset overrides the studio's background rather than asking
 * the caller to remember to: a "transparent PNG" that came out with a black
 * rectangle behind it would be a silent, extremely annoying bug.
 */
export function renderCard(input: CardRenderInput, preset: CardPresetId): RenderedCard {
  const geometry = CARD_GEOMETRY[preset]
  if (!geometry) throw new Error(`Unknown card preset "${String(preset)}".`)
  const settings = cloneSettings(input.settings)
  if (geometry.forceTransparent) settings.background = { kind: 'transparent' }

  const frame = renderFrame({ ...input, settings }, geometry.width, geometry.height)
  return {
    preset,
    width: geometry.width,
    height: geometry.height,
    frames: 1,
    bytes: encodePng(frame.image),
    coverage: frame.coverage,
    missingDefinitionIds: frame.missingDefinitionIds,
  }
}

export interface AnimationOptions {
  width: number
  height: number
  /** Frame count for the turntable; ignored by the build sequence. */
  frames?: number
  delayMs?: number
}

/**
 * A full-rotation turntable.
 *
 * Framing comes from the model's bounds at every yaw combined — computed by
 * rendering the widest of them first would be a second pass, so instead the
 * frames share the assembled model's fixed framing and a padding allowance. The
 * result is a loop with no visible jump between the last frame and the first,
 * which is the only thing that makes a turntable worth having.
 */
export function renderTurntable(input: CardRenderInput, options: AnimationOptions): RenderedCard {
  const frameCount = Math.max(2, Math.min(72, Math.round(options.frames ?? 24)))
  const delay = Math.max(10, Math.min(1000, Math.round(options.delayMs ?? 70)))
  const images: PngImage[] = []
  let coverage = 0
  let missing: string[] = []

  for (let index = 0; index < frameCount; index += 1) {
    const frame = renderFrame(input, options.width, options.height, {
      yawOffset: (360 / frameCount) * index,
      fixedFraming: true,
    })
    images.push(frame.image)
    coverage = Math.max(coverage, frame.coverage)
    if (frame.missingDefinitionIds.length) missing = frame.missingDefinitionIds
  }

  return {
    preset: 'turntable',
    width: options.width,
    height: options.height,
    frames: images.length,
    bytes: encodeApng(images, delay),
    coverage,
    missingDefinitionIds: missing,
  }
}

/**
 * The build sequence: one frame per step, growing.
 *
 * Each frame draws everything placed so far, with the step's own parts at full
 * saturation and the rest washed back — the printed-instruction convention the
 * booklet already uses, so a model looks the same animated as it does on paper.
 */
export function renderBuildSequence(input: CardRenderInput, options: AnimationOptions): RenderedCard {
  const delay = Math.max(60, Math.min(4000, Math.round(options.delayMs ?? 520)))
  const steps = input.document.steps.length
    ? input.document.steps
    : // A snapshot with no sequenced steps still animates: the whole model is
      // one step, and the caller is told the frame count so it can say so.
      [{ id: 'all', index: 1, name: 'Complete', partIds: input.document.parts.map((part) => part.id) }]

  const images: PngImage[] = []
  const placed = new Set<string>()
  let coverage = 0
  let missing: string[] = []

  for (const step of steps) {
    const highlight = new Set(step.partIds)
    for (const partId of step.partIds) placed.add(partId)
    const frame = renderFrame(input, options.width, options.height, {
      include: new Set(placed),
      highlight,
      fixedFraming: true,
    })
    images.push(frame.image)
    coverage = Math.max(coverage, frame.coverage)
    if (frame.missingDefinitionIds.length) missing = frame.missingDefinitionIds
  }

  // Hold on the finished model, so a loop does not snap back the instant the
  // last brick lands.
  if (images.length > 1) images.push(images[images.length - 1])

  return {
    preset: 'build-sequence',
    width: options.width,
    height: options.height,
    frames: images.length,
    bytes: encodeApng(images, delay),
    coverage,
    missingDefinitionIds: missing,
  }
}

/** Convenience for the studio's live preview, which never needs a PNG. */
export function renderPreview(
  input: CardRenderInput,
  width: number,
  height: number,
  options: FrameOptions = {},
): { image: PngImage; coverage: number; missingDefinitionIds: string[] } {
  return renderFrame(input, width, height, options)
}
