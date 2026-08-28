import { getPartBounds } from '../cad/geometry'
import { catalog } from '../cad/catalog'
import { frameScene, renderScene, type RasterPart } from '../cad/raster'
import type { Bounds, ModelDocument, Vec3 } from '../cad/types'
import type { SilhouetteV1 } from './types'

/**
 * Outline capture, for the "keep it looking like that" half of a refinement.
 *
 * "Add surface detail without changing the shape" and "round the nose without
 * moving the wheelbase" are both silhouette statements, and neither can be
 * checked against a part list: swapping a brick for a slope changes nothing a
 * bill of materials would notice and changes the only thing the request was
 * about.
 *
 * The camera, the projection and the rasterizer are the booklet's — `frameScene`
 * and `renderScene` — so the outline compared here is the outline a printed page
 * would show, not a second projector invented for the occasion.
 *
 * What is deliberately *not* claimed: this rasterizes each part's **compiled
 * bounding box**, not its mesh. Compiled meshes are streamed per part and are
 * not resident during analysis, while measured bounds always are. A box hull is
 * therefore exact for a brick and generous for a wheel, a slope or a windscreen,
 * which biases the metric toward reporting "the outline held" — so a silhouette
 * *drift* it reports is real, and a small drift it fails to report may not be.
 * Both directions of that error are stated rather than tuned away.
 */

/** Mask resolution. Small on purpose: this is compared thousands of times. */
export const SILHOUETTE_WIDTH = 72
export const SILHOUETTE_HEIGHT = 54

/** Solid ABS grey; the mask only reads coverage, so the tint is irrelevant. */
const NEUTRAL_RGB = [0.7, 0.7, 0.7] as const

const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3,
  5, 4, 7, 5, 7, 6,
  4, 0, 3, 4, 3, 7,
  1, 5, 6, 1, 6, 2,
  4, 5, 1, 4, 1, 0,
  3, 2, 6, 3, 6, 7,
])

function boxPositions(min: Vec3, max: Vec3): Float32Array {
  return new Float32Array([
    min[0], min[1], min[2], max[0], min[1], min[2], max[0], max[1], min[2], min[0], max[1], min[2],
    min[0], min[1], max[2], max[0], min[1], max[2], max[0], max[1], max[2], min[0], max[1], max[2],
  ])
}

/**
 * The framing two silhouettes must share to be comparable.
 *
 * Padded by a stud so a refinement that grows the model slightly still lands
 * inside the frame rather than being clipped at the border, which would read as
 * a silhouette match where the outline actually left the page.
 */
export function silhouetteFrame(bounds: Bounds): { min: Vec3; max: Vec3 } {
  const pad = 20
  return {
    min: [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad],
    max: [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad],
  }
}

/** Rasterizes the box hull of `partIds` into a coverage mask. */
export function captureSilhouette(
  document: ModelDocument,
  frame: { min: Vec3; max: Vec3 },
  partIds?: Iterable<string>,
): SilhouetteV1 {
  const ids = partIds ? [...partIds] : Object.keys(document.parts)
  const parts: RasterPart[] = []
  for (const id of ids.sort()) {
    const part = document.parts[id]
    if (!part) continue
    const local = catalog.get(part.definitionId)?.dimensions?.bounds
    if (!local) continue
    parts.push({
      positions: boxPositions(local.min, local.max),
      indices: BOX_INDICES,
      slices: [],
      transform: part.transform,
      rgb: NEUTRAL_RGB,
      isNew: true,
    })
  }

  const framing = frameScene(frame, SILHOUETTE_WIDTH, SILHOUETTE_HEIGHT, { supersample: 1, padding: 0.04 })
  // Outlines are drawn *into* the shade buffer, never into coverage, so leaving
  // them on would cost time without changing a single mask bit.
  const image = renderScene(parts, framing, { outlineNew: false })

  const mask = new Array<number>(SILHOUETTE_WIDTH * SILHOUETTE_HEIGHT)
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = image.rgba[pixel * 4 + 3] > 0 ? 1 : 0
  }
  return {
    width: SILHOUETTE_WIDTH,
    height: SILHOUETTE_HEIGHT,
    mask,
    frameMin: frame.min,
    frameMax: frame.max,
  }
}

/**
 * Intersection over union of two masks.
 *
 * 1 is "the outline did not move"; 0 is "nothing about it survived". Two empty
 * masks agree perfectly, which is the right answer for a scope that was empty
 * before and after rather than a division by zero.
 */
export function silhouetteIou(a: SilhouetteV1, b: SilhouetteV1): number {
  if (a.width !== b.width || a.height !== b.height) return 0
  let intersection = 0
  let union = 0
  for (let pixel = 0; pixel < a.mask.length; pixel += 1) {
    const inA = a.mask[pixel] === 1
    const inB = b.mask[pixel] === 1
    if (inA && inB) intersection += 1
    if (inA || inB) union += 1
  }
  return union === 0 ? 1 : intersection / union
}

/** Covered pixels, so a drift can be expressed as a fraction of the outline. */
export const silhouetteArea = (mask: SilhouetteV1): number =>
  mask.mask.reduce((sum: number, bit: number) => sum + bit, 0)

/** Pixels covered by exactly one of the two masks. */
export function silhouetteDrift(a: SilhouetteV1, b: SilhouetteV1): number {
  if (a.width !== b.width || a.height !== b.height) return a.mask.length
  let differing = 0
  for (let pixel = 0; pixel < a.mask.length; pixel += 1) {
    if (a.mask[pixel] !== b.mask[pixel]) differing += 1
  }
  return differing
}

/** Bounds of a subset of parts, used to frame a scope rather than a model. */
export function boundsOfParts(document: ModelDocument, partIds: Iterable<string>): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let seen = false
  for (const id of partIds) {
    const part = document.parts[id]
    if (!part) continue
    const box = getPartBounds(part)
    if (!box.measured) continue
    seen = true
    for (let axis = 0; axis < 3; axis += 1) {
      if (box.min[axis] < min[axis]) min[axis] = box.min[axis]
      if (box.max[axis] > max[axis]) max[axis] = box.max[axis]
    }
  }
  if (!seen) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}
