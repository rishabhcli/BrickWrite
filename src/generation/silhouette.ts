import { STUD_LDU } from '../cad/catalog'
import { getDocumentBounds, getPartBounds } from '../cad/geometry'
import type { Bounds, ModelDocument, Vec3 } from '../cad/types'

/**
 * Silhouette measurement for reference-conditioned generation.
 *
 * The question this answers is narrow and worth stating plainly: *how much of
 * the requested outline does the build actually occupy, and is that fraction
 * going up as the pipeline refines?* Everything here serves that and nothing
 * more.
 *
 * It deliberately does **not** reuse `src/cad/raster.ts`. That rasterizer is a
 * shaded renderer and needs each part's compiled triangle arrays, which are
 * streamed assets: in a headless run — CI, a worker, a server — they are simply
 * not resident, and a silhouette that silently measures an empty scene is worse
 * than no silhouette at all. What *is* always available is every part's measured
 * LDraw envelope, so the projection is built from those.
 *
 * The cost of that choice is stated rather than hidden: a part contributes its
 * axis-aligned world bounding box, so a slope, a wheel or a windscreen reads as
 * slightly larger than it is. For a brick-built model the error is small — most
 * of a LEGO model is boxes — and it is *uniform across phases*, which is what
 * matters for the only comparison this module is used to make.
 */

export type SilhouetteView = 'front' | 'side' | 'top'

/**
 * The projection two masks must share before they can be compared.
 *
 * Carried explicitly because an IoU between masks in different frames is a
 * meaningless number that still looks like a valid one.
 */
export interface SilhouetteFrame {
  readonly view: SilhouetteView
  /** Document-space LDU of the mask's (0, 0) cell corner, in projected axes. */
  readonly originLdu: readonly [number, number]
  readonly cellLdu: number
  readonly width: number
  readonly height: number
}

export interface SilhouetteMask {
  readonly frame: SilhouetteFrame
  /** One byte per cell, 1 where the projection is occupied. */
  readonly cells: Uint8Array
  readonly filled: number
}

/**
 * Which document axes each view projects onto.
 *
 * LDraw is Y-down, so for the two elevations the vertical axis increases
 * downward and the mask's first row is the *top* of the model. IoU does not
 * care, but anything that prints one of these does.
 */
const VIEW_AXES: Record<SilhouetteView, { readonly u: 0 | 1 | 2; readonly v: 0 | 1 | 2 }> = {
  front: { u: 0, v: 1 },
  side: { u: 2, v: 1 },
  top: { u: 0, v: 2 },
}

export interface FrameOptions {
  readonly cellLdu?: number
  /** Padding in cells around the measured extent. */
  readonly padCells?: number
}

/** A frame that covers `bounds` at the requested resolution. */
export function frameForBounds(view: SilhouetteView, bounds: Bounds, options: FrameOptions = {}): SilhouetteFrame {
  const cellLdu = options.cellLdu ?? STUD_LDU / 2
  const pad = options.padCells ?? 1
  const axes = VIEW_AXES[view]
  const originU = Math.floor(bounds.min[axes.u] / cellLdu) - pad
  const originV = Math.floor(bounds.min[axes.v] / cellLdu) - pad
  const maxU = Math.ceil(bounds.max[axes.u] / cellLdu) + pad
  const maxV = Math.ceil(bounds.max[axes.v] / cellLdu) + pad
  return {
    view,
    originLdu: [originU * cellLdu, originV * cellLdu],
    cellLdu,
    width: Math.max(1, maxU - originU),
    height: Math.max(1, maxV - originV),
  }
}

/**
 * A frame covering an envelope in studs, anchored on the ground plane.
 *
 * The envelope grows *upward*, which in LDraw means toward negative Y, so the
 * frame's vertical origin is `-height`. Getting that backwards puts the
 * reference mask underground and every IoU reads zero.
 */
export function frameForEnvelope(
  view: SilhouetteView,
  envelopeStuds: readonly [number, number, number],
  options: FrameOptions = {},
): SilhouetteFrame {
  const [width, height, depth] = envelopeStuds
  return frameForBounds(
    view,
    {
      min: [0, -height * STUD_LDU, 0],
      max: [width * STUD_LDU, 0, depth * STUD_LDU],
      size: [width * STUD_LDU, height * STUD_LDU, depth * STUD_LDU],
    },
    options,
  )
}

const emptyMask = (frame: SilhouetteFrame): SilhouetteMask => ({
  frame,
  cells: new Uint8Array(frame.width * frame.height),
  filled: 0,
})

function fillRect(
  cells: Uint8Array,
  frame: SilhouetteFrame,
  minU: number,
  minV: number,
  maxU: number,
  maxV: number,
): number {
  const u0 = Math.max(0, Math.floor((minU - frame.originLdu[0]) / frame.cellLdu))
  const v0 = Math.max(0, Math.floor((minV - frame.originLdu[1]) / frame.cellLdu))
  const u1 = Math.min(frame.width - 1, Math.ceil((maxU - frame.originLdu[0]) / frame.cellLdu) - 1)
  const v1 = Math.min(frame.height - 1, Math.ceil((maxV - frame.originLdu[1]) / frame.cellLdu) - 1)
  let added = 0
  for (let v = v0; v <= v1; v += 1) {
    const row = v * frame.width
    for (let u = u0; u <= u1; u += 1) {
      if (cells[row + u] === 0) {
        cells[row + u] = 1
        added += 1
      }
    }
  }
  return added
}

/** Orthographic occupancy of a document's measured envelopes in one view. */
export function rasteriseSilhouette(document: ModelDocument, frame: SilhouetteFrame): SilhouetteMask {
  const axes = VIEW_AXES[frame.view]
  const mask = emptyMask(frame)
  const cells = mask.cells
  let filled = 0
  for (const part of Object.values(document.parts)) {
    const bounds = getPartBounds(part)
    if (!bounds.measured) continue
    filled += fillRect(
      cells,
      frame,
      bounds.min[axes.u],
      bounds.min[axes.v],
      bounds.max[axes.u],
      bounds.max[axes.v],
    )
  }
  return { frame, cells, filled }
}

/** A solid rectangle covering `bounds` — the reference an envelope brief implies. */
export function maskFromBounds(frame: SilhouetteFrame, bounds: Bounds): SilhouetteMask {
  const axes = VIEW_AXES[frame.view]
  const mask = emptyMask(frame)
  const filled = fillRect(mask.cells, frame, bounds.min[axes.u], bounds.min[axes.v], bounds.max[axes.u], bounds.max[axes.v])
  return { frame, cells: mask.cells, filled }
}

/** Reference mask for a stud envelope resting on the ground plane. */
export function maskFromEnvelope(
  frame: SilhouetteFrame,
  envelopeStuds: readonly [number, number, number],
): SilhouetteMask {
  const [width, height, depth] = envelopeStuds
  return maskFromBounds(frame, {
    min: [0, -height * STUD_LDU, 0],
    max: [width * STUD_LDU, 0, depth * STUD_LDU],
    size: [width * STUD_LDU, height * STUD_LDU, depth * STUD_LDU],
  })
}

/**
 * Builds a mask from an externally supplied bitmap — a traced photograph, a
 * blueprint, a rendered reference.
 *
 * Accepting the frame from the caller rather than inferring one is the whole
 * point: the caller is the only party that knows what scale the picture is at.
 */
export function maskFromBitmap(
  frame: SilhouetteFrame,
  bitmap: ArrayLike<number>,
  threshold = 0.5,
): SilhouetteMask {
  if (bitmap.length !== frame.width * frame.height) {
    throw new Error(
      `Reference bitmap has ${bitmap.length} samples but the frame is ${frame.width} × ${frame.height}.`,
    )
  }
  const cells = new Uint8Array(frame.width * frame.height)
  let filled = 0
  const cutoff = threshold <= 1 ? threshold * 255 : threshold
  for (let index = 0; index < cells.length; index += 1) {
    if (bitmap[index] >= cutoff) {
      cells[index] = 1
      filled += 1
    }
  }
  return { frame, cells, filled }
}

const framesMatch = (a: SilhouetteFrame, b: SilhouetteFrame) =>
  a.view === b.view &&
  a.width === b.width &&
  a.height === b.height &&
  Math.abs(a.cellLdu - b.cellLdu) < 1e-9 &&
  Math.abs(a.originLdu[0] - b.originLdu[0]) < 1e-9 &&
  Math.abs(a.originLdu[1] - b.originLdu[1]) < 1e-9

export interface SilhouetteComparison {
  readonly iou: number
  /** Fraction of the reference the model covers. */
  readonly coverage: number
  /** Fraction of the model that falls outside the reference. */
  readonly spill: number
  readonly intersection: number
  readonly union: number
}

/** Intersection-over-union between two masks in the same frame. */
export function compareMasks(model: SilhouetteMask, reference: SilhouetteMask): SilhouetteComparison {
  if (!framesMatch(model.frame, reference.frame)) {
    throw new Error('Silhouette masks are in different frames; an IoU between them would be meaningless.')
  }
  let intersection = 0
  let union = 0
  let outside = 0
  for (let index = 0; index < model.cells.length; index += 1) {
    const a = model.cells[index]
    const b = reference.cells[index]
    if (a && b) intersection += 1
    if (a || b) union += 1
    if (a && !b) outside += 1
  }
  return {
    iou: union === 0 ? 0 : intersection / union,
    coverage: reference.filled === 0 ? 0 : intersection / reference.filled,
    spill: model.filled === 0 ? 0 : outside / model.filled,
    intersection,
    union,
  }
}

export interface SilhouetteReference {
  readonly view: SilhouetteView
  readonly mask: SilhouetteMask
}

/** The reference a brief with an envelope implies, in all three views. */
export function referencesFromEnvelope(
  envelopeStuds: readonly [number, number, number],
  options: FrameOptions = {},
): SilhouetteReference[] {
  return (['front', 'side', 'top'] as const).map((view) => {
    const frame = frameForEnvelope(view, envelopeStuds, options)
    return { view, mask: maskFromEnvelope(frame, envelopeStuds) }
  })
}

/** Mean IoU of a document against a set of references, or null when there are none. */
export function silhouetteScore(
  document: ModelDocument,
  references: readonly SilhouetteReference[],
): { readonly mean: number; readonly perView: Record<string, SilhouetteComparison> } | null {
  if (!references.length) return null
  const perView: Record<string, SilhouetteComparison> = {}
  let total = 0
  for (const reference of references) {
    const comparison = compareMasks(rasteriseSilhouette(document, reference.mask.frame), reference.mask)
    perView[reference.view] = comparison
    total += comparison.iou
  }
  return { mean: total / references.length, perView }
}

/** Convenience: the document's own extent, for framing a comparison. */
export const documentExtent = (document: ModelDocument): Bounds => getDocumentBounds(document)

/** Exposed so callers can describe a mask without re-deriving the axis mapping. */
export const viewAxes = (view: SilhouetteView): { u: 0 | 1 | 2; v: 0 | 1 | 2 } => VIEW_AXES[view]

/** Document-space centre of a mask cell, for debugging an unexpected overlap. */
export function cellCentreLdu(frame: SilhouetteFrame, u: number, v: number): readonly [number, number] {
  return [frame.originLdu[0] + (u + 0.5) * frame.cellLdu, frame.originLdu[1] + (v + 0.5) * frame.cellLdu]
}

/** Ascii rendering of a mask. Test failures on a bitmap are otherwise unreadable. */
export function maskToText(mask: SilhouetteMask): string {
  const rows: string[] = []
  for (let v = 0; v < mask.frame.height; v += 1) {
    let row = ''
    for (let u = 0; u < mask.frame.width; u += 1) row += mask.cells[v * mask.frame.width + u] ? '#' : '.'
    rows.push(row)
  }
  return rows.join('\n')
}

/** Vec3 helper kept local so this module has no dependency on the math kernel. */
export const boundsOfPoints = (points: readonly Vec3[]): Bounds => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis])
      max[axis] = Math.max(max[axis], point[axis])
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}
