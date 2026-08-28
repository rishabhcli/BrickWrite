import type { DemoPreview, DemoPreviewPart } from '../../demos'

/**
 * Orthographic projection for the envelope view.
 *
 * The explorer draws every part's *measured* LDraw envelope at its exact
 * document transform, rather than its compiled mesh. That is a deliberate
 * trade: the landing and explore routes are not allowed to download the catalog
 * or the Three.js renderer, and 140 boxes with correct occlusion, real colours
 * and real stud positions read as the model far better than a spinner would.
 * The interface says what it is showing; it does not pass this off as the render.
 *
 * The camera convention is the one `src/cad/raster.ts` uses, so the interactive
 * view and the offline still agree: LDraw is Y-down, screen-up is -Y, and the
 * view direction points *from* the viewer *toward* the model, which is why a
 * positive Y component means looking down at the studs.
 */

export type Vec = readonly [number, number, number]

export interface Camera {
  /** Degrees about the vertical axis. */
  yaw: number
  /** Degrees above the horizon. Positive looks down onto the model. */
  pitch: number
  zoom: number
}

export interface CameraBasis {
  forward: Vec
  right: Vec
  up: Vec
}

export interface Fit {
  scale: number
  offsetU: number
  offsetV: number
}

const UP_HINT: Vec = [0, -1, 0]
/** Same key light as the offline rasterizer, so shading matches the stills. */
const LIGHT: Vec = [-0.35, -0.8, 0.5]
const AMBIENT = 0.46

const radians = (degrees: number) => (degrees * Math.PI) / 180
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (v: Vec): Vec => {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-9 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length]
}

export function cameraBasis(camera: Camera): CameraBasis {
  const yaw = radians(camera.yaw)
  const pitch = radians(camera.pitch)
  const forward = normalize([
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ])
  const right = normalize(cross(UP_HINT, forward))
  const up = normalize(cross(forward, right))
  return { forward, right, up }
}

/**
 * Fits a document-space box into the viewport.
 *
 * Projects all eight corners, because a box that is axis-aligned in the model
 * is not axis-aligned once rotated into camera space, so its screen extent is
 * only knowable from the corners.
 */
export function fitScene(
  bounds: { min: number[]; max: number[] },
  basis: CameraBasis,
  viewport: { width: number; height: number },
  options: { padding?: number; zoom?: number } = {},
): Fit {
  const padding = options.padding ?? 0.1
  const zoom = options.zoom ?? 1
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (let corner = 0; corner < 8; corner += 1) {
    const point: Vec = [
      corner & 1 ? bounds.max[0] : bounds.min[0],
      corner & 2 ? bounds.max[1] : bounds.min[1],
      corner & 4 ? bounds.max[2] : bounds.min[2],
    ]
    const u = dot(point, basis.right)
    const v = dot(point, basis.up)
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const spanU = Math.max(maxU - minU, 1e-6)
  const spanV = Math.max(maxV - minV, 1e-6)
  const scale =
    Math.min(
      (viewport.width * (1 - padding * 2)) / spanU,
      (viewport.height * (1 - padding * 2)) / spanV,
    ) * zoom
  return {
    scale,
    offsetU: viewport.width / 2 - ((minU + maxU) / 2) * scale,
    offsetV: viewport.height / 2 + ((minV + maxV) / 2) * scale,
  }
}

export const project = (point: Vec, basis: CameraBasis, fit: Fit): [number, number] => [
  dot(point, basis.right) * fit.scale + fit.offsetU,
  fit.offsetV - dot(point, basis.up) * fit.scale,
]

export const depthOf = (point: Vec, basis: CameraBasis) => dot(point, basis.forward)

/** Axis, outward direction and the four corners of one face of a box. */
export interface BoxFace {
  axis: 0 | 1 | 2
  sign: -1 | 1
  corners: Vec[]
  /** 0–1 diffuse term, matching the offline rasterizer's key light. */
  shade: number
}

const FACE_SHADE: readonly number[] = (() => {
  const light = normalize(LIGHT)
  return [0, 1, 2].map((axis) => AMBIENT + (1 - AMBIENT) * Math.abs(light[axis]))
})()

/**
 * The three faces of an axis-aligned box that can be seen from `basis`.
 *
 * Exactly three, always: an orthographic camera looking at a box sees the face
 * on each axis whose outward normal points back toward it. Drawing all six and
 * relying on the painter's algorithm to hide the rest would double the fill
 * cost for nothing.
 */
export function visibleFaces(min: Vec, max: Vec, basis: CameraBasis): BoxFace[] {
  const faces: BoxFace[] = []
  for (const axis of [0, 1, 2] as const) {
    const sign: -1 | 1 = basis.forward[axis] > 0 ? -1 : 1
    const value = sign === 1 ? max[axis] : min[axis]
    // The two axes the face spans, in a fixed order so the ring is a rectangle
    // rather than a bow tie.
    const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
    const corners: Vec[] = [
      [min[0], min[1], min[2]],
      [min[0], min[1], min[2]],
      [min[0], min[1], min[2]],
      [min[0], min[1], min[2]],
    ].map((corner, index) => {
      const next: [number, number, number] = [...corner] as [number, number, number]
      next[axis] = value
      next[a] = index === 0 || index === 1 ? min[a] : max[a]
      next[b] = index === 1 || index === 2 ? max[b] : min[b]
      return next as Vec
    })
    faces.push({ axis, sign, corners, shade: FACE_SHADE[axis] })
  }
  return faces
}

/** Ray-free hit test: is a screen point inside this projected polygon? */
export function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersects = yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi
    if (intersects) inside = !inside
  }
  return inside
}

// ---------------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------------

export interface SceneBox {
  index: number
  min: Vec
  max: Vec
  centre: Vec
  definition: number
  color: number
  step: number
  subassembly: number
  studLayout: number
  depth: number
}

export const PART_FIELDS = {
  minX: 0, minY: 1, minZ: 2, maxX: 3, maxY: 4, maxZ: 5,
  definition: 6, color: 7, step: 8, subassembly: 9, studLayout: 10,
} as const

/**
 * How far each subassembly moves in the exploded view.
 *
 * Outward from the model's centre along the subassembly's own centroid, which
 * separates a roof from the walls it sits on without anyone having to say which
 * way is up for a given demo.
 */
export function explodeOffsets(preview: DemoPreview): Vec[] {
  const centre: [number, number, number] = [
    (preview.boundsLdu.min[0] + preview.boundsLdu.max[0]) / 2,
    (preview.boundsLdu.min[1] + preview.boundsLdu.max[1]) / 2,
    (preview.boundsLdu.min[2] + preview.boundsLdu.max[2]) / 2,
  ]
  const sums = preview.subassemblies.map(() => ({ x: 0, y: 0, z: 0, n: 0 }))
  for (const part of preview.parts) {
    const bucket = sums[part[PART_FIELDS.subassembly]]
    if (!bucket) continue
    bucket.x += (part[PART_FIELDS.minX] + part[PART_FIELDS.maxX]) / 2
    bucket.y += (part[PART_FIELDS.minY] + part[PART_FIELDS.maxY]) / 2
    bucket.z += (part[PART_FIELDS.minZ] + part[PART_FIELDS.maxZ]) / 2
    bucket.n += 1
  }
  return sums.map((bucket) => {
    if (!bucket.n) return [0, 0, 0] as Vec
    const direction: Vec = [bucket.x / bucket.n - centre[0], bucket.y / bucket.n - centre[1], bucket.z / bucket.n - centre[2]]
    const length = Math.hypot(...direction)
    // A subassembly sitting on the centre has no direction of its own; pushing
    // it straight up is the only choice that does not invent one.
    return length < 1 ? ([0, -1, 0] as Vec) : (normalize(direction) as Vec)
  })
}

export interface SceneOptions {
  /** Only include parts introduced by step index < this. Undefined means all. */
  stepLimit?: number
  explode?: number
  explodeOffsets?: Vec[]
  /** LDU the exploded view separates subassemblies by at `explode === 1`. */
  spreadLdu?: number
}

/** Depth-sorted boxes for one frame, farthest first. */
export function buildScene(preview: DemoPreview, basis: CameraBasis, options: SceneOptions = {}): SceneBox[] {
  const spread = options.spreadLdu ?? 120
  const explode = options.explode ?? 0
  const offsets = options.explodeOffsets
  const boxes: SceneBox[] = []
  preview.parts.forEach((part: DemoPreviewPart, index: number) => {
    if (options.stepLimit !== undefined && part[PART_FIELDS.step] >= options.stepLimit) return
    const offset = explode > 0 && offsets ? offsets[part[PART_FIELDS.subassembly]] ?? [0, 0, 0] : [0, 0, 0]
    const shift = explode * spread
    const min: Vec = [
      part[PART_FIELDS.minX] + offset[0] * shift,
      part[PART_FIELDS.minY] + offset[1] * shift,
      part[PART_FIELDS.minZ] + offset[2] * shift,
    ]
    const max: Vec = [
      part[PART_FIELDS.maxX] + offset[0] * shift,
      part[PART_FIELDS.maxY] + offset[1] * shift,
      part[PART_FIELDS.maxZ] + offset[2] * shift,
    ]
    const centre: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    boxes.push({
      index,
      min,
      max,
      centre,
      definition: part[PART_FIELDS.definition],
      color: part[PART_FIELDS.color],
      step: part[PART_FIELDS.step],
      subassembly: part[PART_FIELDS.subassembly],
      studLayout: part[PART_FIELDS.studLayout],
      depth: depthOf(centre, basis),
    })
  })
  return boxes.sort((a, b) => b.depth - a.depth)
}

/** Mixes a hex colour toward white or black by `amount`, for face shading. */
export function shadeHex(hex: string, factor: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value
  const number = Number.parseInt(full, 16)
  if (!Number.isFinite(number)) return hex
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor)))
  return `rgb(${clamp((number >> 16) & 255)}, ${clamp((number >> 8) & 255)}, ${clamp(number & 255)})`
}
