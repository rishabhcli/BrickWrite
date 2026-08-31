/**
 * The displacement map, which is the whole trick.
 *
 * Refraction through a real edge bends light most where the surface curves
 * hardest — at the rim — and not at all through the flat middle. So the map
 * encodes, per pixel, which way and how hard to push the backdrop: red carries
 * the horizontal push, green the vertical, with 128 meaning "leave it alone".
 * Feed that to feDisplacementMap and the backdrop gathers at the rim exactly
 * the way it does through the edge of a lens.
 *
 * A rounded-rectangle signed distance field gives both quantities at once. Its
 * value is the distance to the edge; its gradient is the direction of the edge.
 * That is why the shape maths is here rather than an approximation with four
 * linear gradients: the corners are where this reads as glass or as a bevel,
 * and gradients get the corners wrong.
 */

export interface LensGeometry {
  readonly width: number
  readonly height: number
  readonly radius: number
  /** How far in from the rim the bend reaches, in CSS pixels. */
  readonly band: number
}

/** Signed distance to the edge of a rounded rectangle. Negative inside. */
function distance(x: number, y: number, width: number, height: number, radius: number): number {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const limit = Math.min(radius, halfWidth, halfHeight)
  const dx = Math.abs(x - halfWidth) - (halfWidth - limit)
  const dy = Math.abs(y - halfHeight) - (halfHeight - limit)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - limit
}

/**
 * How steeply the glass falls away, at a given point across the edge band.
 *
 * `t` is 0 where the band meets the flat middle and 1 at the rim. The shape is
 * a quarter-round fillet of radius `band`, so the surface is
 * `y = sqrt(band² - (band - d)²)` and its slope works out to `t / sqrt(1 - t²)`.
 *
 * That profile is the point. Refraction follows the *slope* of the surface, and
 * a real fillet is flat through the middle and turns vertical at the very rim,
 * so almost all of the bend happens in the last few pixels. A smoothstep ramp
 * spreads the same displacement evenly across the band, which is why it reads
 * as a soft bevel or an embossed border rather than as something with a lensed
 * edge you could catch light on.
 *
 * The slope is unbounded at the rim, so it is clamped: MAX_SLOPE is where the
 * bend saturates, and the value is chosen to be steep enough to magnify
 * visibly without folding the backdrop over itself.
 */
export const MAX_SLOPE = 3

const lensProfile = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t))
  if (clamped >= 1) return 1
  const slope = clamped / Math.sqrt(1 - clamped * clamped)
  return Math.min(slope, MAX_SLOPE) / MAX_SLOPE
}

export const MAP_KEY = ({ width, height, radius, band }: LensGeometry): string =>
  `${Math.round(width)}x${Math.round(height)}r${Math.round(radius)}b${Math.round(band)}`

/**
 * Renders the map to a data URL.
 *
 * Cached by geometry because it is pure: two docks the same size share one
 * map, and a surface that re-renders sixty times a second regenerates nothing.
 * Returns null where there is no 2D canvas — jsdom, chiefly — so the caller can
 * fall back rather than crash in a test that never intended to rasterise.
 */
const cache = new Map<string, string>()

export function displacementMap(geometry: LensGeometry): string | null {
  const key = MAP_KEY(geometry)
  const cached = cache.get(key)
  if (cached) return cached

  const width = Math.max(1, Math.round(geometry.width))
  const height = Math.max(1, Math.round(geometry.height))
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null

  const image = context.createImageData(width, height)
  const pixels = image.data
  const { radius, band } = geometry

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = distance(x + 0.5, y + 0.5, width, height, radius)

      // The gradient of the distance field, by central difference. It points
      // out of the shape, so the backdrop is pulled inward — which is the
      // direction that magnifies at the rim rather than pinching.
      const gx = distance(x + 1.5, y + 0.5, width, height, radius) - distance(x - 0.5, y + 0.5, width, height, radius)
      const gy = distance(x + 0.5, y + 1.5, width, height, radius) - distance(x + 0.5, y - 0.5, width, height, radius)
      const length = Math.hypot(gx, gy) || 1

      // `here` is negative inside, zero at the rim. Full strength at the rim,
      // nothing by the time the band runs out.
      const depth = lensProfile(1 + here / band)
      const offset = (y * width + x) * 4

      pixels[offset] = Math.round(128 + (gx / length) * depth * 127)
      pixels[offset + 1] = Math.round(128 + (gy / length) * depth * 127)
      pixels[offset + 2] = 128
      pixels[offset + 3] = 255
    }
  }

  context.putImageData(image, 0, 0)
  const url = canvas.toDataURL()

  // Unbounded growth would be a leak on a resizable dock. The ceiling is well
  // above the handful of distinct chrome sizes a session actually produces.
  if (cache.size > 48) cache.clear()
  cache.set(key, url)
  return url
}

/** Exposed so a test can assert the cache rather than infer it from timing. */
export const clearDisplacementCache = (): void => cache.clear()
export const displacementCacheSize = (): number => cache.size
