/**
 * Region selection over covered pixels.
 *
 * The previous box select projected each part's bounds *centre* and tested that
 * one point against the rectangle. Two things are wrong with that, and both are
 * things an operator hits within a minute of using it:
 *
 *   - A long part — a 1×16 beam, a Technic liftarm, a plate under a facade —
 *     has its centre far from the region the operator drew a box around. Its
 *     pixels are inside; its centre is not; it is not selected. Dragging a box
 *     over the visible half of a wall silently misses the wall.
 *   - A part buried inside the model has its centre inside any box drawn over
 *     the model, and is selected even though the operator cannot see it. On a
 *     dense build a box select therefore grabs the interior it was not aiming
 *     at.
 *
 * Both disappear if selection asks the *rendered image* which parts the region
 * actually covers. That is what these functions do: they take the id buffer the
 * GPU pass produced and count, per identity, how many pixels inside the mask
 * belong to it. Occlusion falls out for free, because an occluded part never
 * wrote a pixel in the first place — the id pass runs with the same depth test
 * as the beauty pass.
 */

import { decodeId, NO_ID } from './ids'

/** A screen-space region, in *buffer* pixels with the origin at the top left. */
export type RegionShape =
  | { readonly kind: 'box'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
  /** Closed polyline. Fewer than three points selects nothing. */
  | { readonly kind: 'lasso'; readonly points: ReadonlyArray<readonly [number, number]> }

export interface RegionBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Integer pixel bounds of a shape, clamped into the buffer. */
export function regionBounds(shape: RegionShape, width: number, height: number): RegionBounds {
  let minX: number
  let minY: number
  let maxX: number
  let maxY: number
  if (shape.kind === 'box') {
    minX = Math.min(shape.x0, shape.x1)
    maxX = Math.max(shape.x0, shape.x1)
    minY = Math.min(shape.y0, shape.y1)
    maxY = Math.max(shape.y0, shape.y1)
  } else {
    if (shape.points.length < 3) return { left: 0, top: 0, width: 0, height: 0 }
    minX = Infinity
    minY = Infinity
    maxX = -Infinity
    maxY = -Infinity
    for (const [x, y] of shape.points) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const left = Math.max(0, Math.floor(minX))
  const top = Math.max(0, Math.floor(minY))
  const right = Math.min(width, Math.ceil(maxX) + 1)
  const bottom = Math.min(height, Math.ceil(maxY) + 1)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * Even-odd crossing test.
 *
 * Even-odd rather than winding because a lasso an operator draws by hand
 * crosses itself constantly, and a self-crossing loop should still mean "the
 * area I circled" rather than "the area I circled twice".
 */
export function pointInPolygon(points: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    // Half-open in y, so a vertex exactly on the scanline is counted once.
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Builds the per-pixel inclusion mask for a shape over its own bounds. */
export function rasterizeRegion(shape: RegionShape, bounds: RegionBounds): Uint8Array {
  const mask = new Uint8Array(bounds.width * bounds.height)
  if (!mask.length) return mask
  if (shape.kind === 'box') {
    mask.fill(1)
    return mask
  }
  if (shape.points.length < 3) return mask
  for (let row = 0; row < bounds.height; row += 1) {
    const y = bounds.top + row + 0.5
    for (let column = 0; column < bounds.width; column += 1) {
      const x = bounds.left + column + 0.5
      if (pointInPolygon(shape.points, x, y)) mask[row * bounds.width + column] = 1
    }
  }
  return mask
}

export interface RegionCoverage {
  readonly id: number
  /** Pixels of this identity inside the mask. */
  readonly pixels: number
}

export interface RegionOptions {
  /**
   * Pixels an identity needs before it counts as selected.
   *
   * The id pass is drawn without antialiasing precisely so that a single pixel
   * is a genuine cover rather than a blend of two neighbours, so the honest
   * default is 1. It is configurable because a coarse pick radius wants a
   * higher floor.
   */
  readonly minPixels?: number
}

/**
 * Counts covered pixels per identity inside a region.
 *
 * `pixels` is the RGBA readback of the id target for exactly `bounds`, in the
 * layout `readRenderTargetPixels` produces: rows bottom-up, four bytes per
 * pixel. `flipY` handles that, so callers pass the buffer straight through
 * without reshaping a multi-megabyte array first.
 */
export function coverageInRegion(
  pixels: Uint8Array | Uint8ClampedArray,
  bounds: RegionBounds,
  mask: Uint8Array,
  options: RegionOptions & { readonly flipY?: boolean } = {},
): RegionCoverage[] {
  const counts = new Map<number, number>()
  const flipY = options.flipY ?? true
  for (let row = 0; row < bounds.height; row += 1) {
    const sourceRow = flipY ? bounds.height - 1 - row : row
    for (let column = 0; column < bounds.width; column += 1) {
      if (!mask[row * bounds.width + column]) continue
      const offset = (sourceRow * bounds.width + column) * 4
      const id = decodeId(pixels[offset], pixels[offset + 1], pixels[offset + 2])
      if (id === NO_ID) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  const minPixels = Math.max(1, options.minPixels ?? 1)
  return [...counts.entries()]
    .filter(([, pixelCount]) => pixelCount >= minPixels)
    .map(([id, pixelCount]) => ({ id, pixels: pixelCount }))
    // Most-covered first, so a caller that truncates keeps what the operator
    // most plainly circled.
    .sort((a, b) => b.pixels - a.pixels || a.id - b.id)
}

/**
 * The identity nearest a point, searched outward in rings.
 *
 * A single pixel is the correct answer when the operator hits a part, but a
 * click one pixel off a thin bar should still pick the bar rather than
 * clearing the selection. Searching a small square outward from the exact pixel
 * gives that tolerance while keeping the exact hit exact: ring 0 is tested
 * first and returns immediately, so a direct hit is never overridden by a
 * larger neighbour.
 */
export function nearestIdInPatch(
  pixels: Uint8Array | Uint8ClampedArray,
  patchWidth: number,
  patchHeight: number,
  centreX: number,
  centreY: number,
  flipY = true,
): number {
  const idAt = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= patchWidth || y >= patchHeight) return NO_ID
    const row = flipY ? patchHeight - 1 - y : y
    const offset = (row * patchWidth + x) * 4
    return decodeId(pixels[offset], pixels[offset + 1], pixels[offset + 2])
  }
  const radius = Math.max(patchWidth, patchHeight)
  for (let ring = 0; ring <= radius; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        // Only the ring's own boundary; the interior was covered already.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const id = idAt(centreX + dx, centreY + dy)
        if (id !== NO_ID) return id
      }
    }
  }
  return NO_ID
}

/**
 * Projected-centre membership, kept only so the regression test can show what
 * the covered-pixel rule fixes.
 *
 * This is the rule the viewport used before, reproduced exactly. It is exported
 * rather than deleted because "the new algorithm agrees with the old one" would
 * be a much weaker assertion than "the new algorithm disagrees with the old one
 * on the two cases the old one got wrong", and the second needs the old one to
 * still be runnable.
 */
export function centresInRegion(
  centres: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number; readonly behindCamera?: boolean }>,
  shape: RegionShape,
): string[] {
  return centres
    .filter((centre) => {
      if (centre.behindCamera) return false
      if (shape.kind === 'box') {
        return (
          centre.x >= Math.min(shape.x0, shape.x1) &&
          centre.x <= Math.max(shape.x0, shape.x1) &&
          centre.y >= Math.min(shape.y0, shape.y1) &&
          centre.y <= Math.max(shape.y0, shape.y1)
        )
      }
      return pointInPolygon(shape.points, centre.x, centre.y)
    })
    .map((centre) => centre.id)
}
