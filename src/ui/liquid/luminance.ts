/**
 * Deciding whether a surface is sitting over something bright.
 *
 * This is the cue that most makes glass read as glass. Real glass over a dark
 * table shows a bright edge and a light specular; over snow it shows a dark
 * edge and an inverted one. A surface whose edge never changes reads as a grey
 * rectangle no matter how much blur is behind it.
 *
 * The maths is pure and lives here so it can be tested without a renderer. The
 * *sampling* — reading what is actually behind editor chrome — is pushed in by
 * the editor through LiquidStage, because this module must not import from
 * src/editor.
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const RGB_FUNCTIONAL = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i

/** Parses the colour forms this codebase actually writes: #abc, #aabbcc, rgb(), rgba(). */
export function parseColor(value: string): Rgb | null {
  const input = value.trim()

  const short = HEX_SHORT.exec(input)
  if (short) {
    return {
      r: Number.parseInt(short[1] + short[1], 16),
      g: Number.parseInt(short[2] + short[2], 16),
      b: Number.parseInt(short[3] + short[3], 16),
    }
  }

  const long = HEX_LONG.exec(input)
  if (long) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
    }
  }

  const functional = RGB_FUNCTIONAL.exec(input)
  if (functional) {
    return { r: Number(functional[1]), g: Number(functional[2]), b: Number(functional[3]) }
  }

  return null
}

const channel = (value: number): number => {
  const normalized = Math.min(1, Math.max(0, value / 255))
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 for black through 1 for white. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * The point at which a surface flips to its over-light treatment.
 *
 * Measured rather than assumed. A light-grey brick face under the studio
 * environment reads about sRGB 179, which is relative luminance 0.44 — so a
 * threshold of 0.5 would sit just above the most common bright thing in this
 * product and the adaptation would essentially never fire. 0.32 is sRGB ~155:
 * comfortably above every surface in the dark palette (the lightest chrome
 * token, --panel-2 #121a1d, measures 0.008) and below the light greys and
 * whites that models are actually built from.
 */
export const OVER_LIGHT_THRESHOLD = 0.2

export function isOverLight(luminance: number): boolean {
  return luminance > OVER_LIGHT_THRESHOLD
}

/**
 * The luminance at which a surface is considered fully over light content.
 *
 * A light-grey brick face under the studio environment measures about 0.44, so
 * that is what "as bright as this product gets" means in practice.
 */
export const OVER_LIGHT_REFERENCE = 0.45

/**
 * Backdrop brightness as a continuous 0..1, not a switch.
 *
 * Real glass does not snap between two appearances at a threshold; it grades.
 * Measured on the running editor, a popover half over a white plate and half
 * over the void reads 0.218 — genuinely between the two states, and a binary
 * flip has to answer it wrongly in one direction or the other. The rim, the
 * specular and the tint interpolate across this instead, so a surface drifting
 * over a bright model shades into its over-light treatment the way a real one
 * would. The boolean above survives only for the blur tier, which is CSS-only
 * and has a class rather than a number to work with.
 */
export function lightnessOf(luminance: number): number {
  return Math.min(1, Math.max(0, luminance / OVER_LIGHT_REFERENCE))
}

/** Mean luminance of an RGBA byte buffer, as produced by a small framebuffer readback. */
export function meanLuminance(pixels: ArrayLike<number>): number {
  if (pixels.length < 4) return 0
  let total = 0
  let count = 0
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    total += relativeLuminance({ r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] })
    count += 1
  }
  return count === 0 ? 0 : total / count
}

/**
 * Per-cell luminance for a downscaled readback.
 *
 * One number per pixel of the small image, which makes each pixel a cell of a
 * coarse grid over the viewport. A single average over the whole canvas is the
 * wrong signal: with a bright wall filling half the frame the mean still
 * measured 0.19 here, because the rest of the scene is near-black. Real glass
 * responds to what is behind *it*, not to the average of everything on screen,
 * so each surface reads only the cells its own box covers.
 */
export function luminanceGrid(pixels: ArrayLike<number>): number[] {
  const cells: number[] = []
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    cells.push(relativeLuminance({ r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] }))
  }
  return cells
}

export interface LuminanceField {
  readonly cells: readonly number[]
  readonly columns: number
  readonly rows: number
}

/**
 * Mean luminance of the cells covered by `fraction`, a box in 0..1 coordinates
 * of the sampled region. Falls back to the whole field when the box lands
 * outside it, which is the honest answer for a surface that does not overlap.
 */
export function fieldLuminance(
  field: LuminanceField,
  fraction: { left: number; top: number; width: number; height: number },
): number {
  const { cells, columns, rows } = field
  if (cells.length === 0 || columns <= 0 || rows <= 0) return 0

  const first = (value: number, limit: number) => Math.min(limit - 1, Math.max(0, Math.floor(value * limit)))
  const last = (value: number, limit: number) => Math.min(limit - 1, Math.max(0, Math.ceil(value * limit) - 1))

  const columnStart = first(fraction.left, columns)
  const columnEnd = Math.max(columnStart, last(fraction.left + fraction.width, columns))
  const rowStart = first(fraction.top, rows)
  const rowEnd = Math.max(rowStart, last(fraction.top + fraction.height, rows))

  let total = 0
  let count = 0
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let column = columnStart; column <= columnEnd; column += 1) {
      const cell = cells[row * columns + column]
      if (cell === undefined) continue
      total += cell
      count += 1
    }
  }
  return count === 0 ? 0 : total / count
}

/**
 * Budget for one backdrop sample, in milliseconds.
 *
 * A sample downscales the WebGL canvas into a 16x16 2D canvas and reads it
 * back, which stalls the GPU pipeline: the driver must finish the frame before
 * it can hand over pixels. At 2 Hz that is affordable on a machine with
 * headroom and indefensible on one without, so the sampler times itself and
 * stops permanently past this figure. Losing it costs the adaptive tint and
 * nothing else, which is a fair trade against dropping frames while modelling.
 *
 * Three milliseconds rather than a fraction of one: the stall is dominated by
 * pipeline depth, not by the a thousand pixels actually copied, so a stricter
 * budget would disable the sampler on every machine including fast ones.
 */
export const SAMPLE_BUDGET_MS = 3

/** How often editor chrome re-reads what is behind it. */
export const SAMPLE_INTERVAL_MS = 500
