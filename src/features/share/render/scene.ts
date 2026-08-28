import { basisFromAxisAngle, degreesToRadians, multiplyMat3, type Mat3, type Vec3 } from '../../../cad/math'
import { frameScene, type RasterPart, type Rgb, type SceneFraming } from '../../../cad/raster'
import type { PublishedDocument, PublishedPart } from '../types'
import type { CameraSettings, FramingSettings } from './presets'

/**
 * Turning a published snapshot into something `src/cad/raster.ts` can draw.
 *
 * The rasteriser takes transformed meshes and a fixed camera. Everything the
 * studio calls a "camera move" is therefore expressed here as a rotation of the
 * model by the inverse — same image, one renderer. Framing, pan and zoom are
 * folded into the `SceneFraming` the rasteriser already accepts, so no pixel
 * work happens twice.
 */

export interface ShareMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly slices: ReadonlyArray<{ colour: number; start: number; count: number }>
}

/** Resolves compiled geometry; `null` for a part this build cannot draw. */
export type GeometryResolver = (definitionId: string) => ShareMesh | null

/**
 * The rasteriser's camera basis, restated.
 *
 * `raster.ts` keeps these private, and copying them is the price of not forking
 * it. Only the pitch and roll *axes* depend on the copy — the projection itself
 * is still the rasteriser's — so a drift would tilt a control slightly, not
 * produce a wrong render. `scene.test.ts` pins the relationship by asserting
 * that a 180° yaw mirrors the image the rasteriser actually produces.
 */
const VIEW_DIRECTION = normalise([0.82, 0.62, 0.95])
const UP_HINT: Vec3 = [0, -1, 0]
const CAMERA_RIGHT = normalise(cross(UP_HINT, VIEW_DIRECTION))
/** LDraw is Y-down, so the model's own vertical axis is Y. */
const MODEL_UP: Vec3 = [0, 1, 0]

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-9 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * The model rotation that realises a camera move.
 *
 * Yaw turns the model on its own vertical axis — a turntable. Pitch tips it
 * about the camera's right axis, which is what raising or lowering the
 * viewpoint looks like. Roll spins it in the image plane. Composed in that
 * order so yaw stays a turntable no matter what pitch is set to, which is the
 * behaviour anybody who has used an orbit control expects.
 */
export function cameraBasis(camera: CameraSettings): Mat3 {
  const yaw = basisFromAxisAngle(MODEL_UP, degreesToRadians(camera.yaw))
  const pitch = basisFromAxisAngle(CAMERA_RIGHT, degreesToRadians(camera.pitch))
  const roll = basisFromAxisAngle(VIEW_DIRECTION, degreesToRadians(camera.roll))
  return multiplyMat3(roll, multiplyMat3(pitch, yaw))
}

const applyMat = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]

interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

const EMPTY_BOX = (): Box => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
})

function growBox(box: Box, point: Vec3) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (point[axis] < box.min[axis]) box.min[axis] = point[axis]
    if (point[axis] > box.max[axis]) box.max[axis] = point[axis]
  }
}

/** Local bounds of a mesh, computed once per definition and reused. */
function localBounds(mesh: ShareMesh): Box {
  const box = EMPTY_BOX()
  for (let index = 0; index < mesh.positions.length; index += 3) {
    growBox(box, [mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]])
  }
  return box
}

export interface SceneOptions {
  camera: CameraSettings
  /** Colour lookup for an LDraw code, in the rasteriser's 0–1 space. */
  palette: (code: number) => Rgb
  /** Parts drawn at full saturation. Everything else is washed back. */
  highlight?: ReadonlySet<string> | null
  /** Restricts the scene to these part ids; `null` draws everything. */
  include?: ReadonlySet<string> | null
  /** 0 assembled; 1 pushes each part one envelope away from the centre. */
  explode?: number
}

export interface BuiltScene {
  parts: RasterPart[]
  /** Bounds of what was actually drawn, in the rotated frame. */
  bounds: { min: Vec3; max: Vec3 }
  /** Definition ids with no compiled geometry in this build. */
  missingDefinitionIds: string[]
  /** Bounds of the whole model, so framing can stay fixed while scrubbing. */
  fullBounds: { min: Vec3; max: Vec3 }
}

/**
 * Builds the rasteriser's input for one frame.
 *
 * `fullBounds` always covers every part, even when `include` narrows what is
 * drawn. A step scrubber that reframed on each step would make the model appear
 * to jump and shrink — the same reason `raster.ts` frames a booklet once from
 * the finished build.
 */
export function buildScene(
  document: PublishedDocument,
  geometry: GeometryResolver,
  options: SceneOptions,
): BuiltScene {
  const basis = cameraBasis(options.camera)
  const explode = Number.isFinite(options.explode) ? Math.max(0, Math.min(3, options.explode ?? 0)) : 0
  const meshCache = new Map<string, { mesh: ShareMesh; bounds: Box } | null>()
  const resolve = (definitionId: string) => {
    if (meshCache.has(definitionId)) return meshCache.get(definitionId)!
    const mesh = geometry(definitionId)
    const entry = mesh ? { mesh, bounds: localBounds(mesh) } : null
    meshCache.set(definitionId, entry)
    return entry
  }

  // Pass one: rotated world centres, needed before an exploded offset can be
  // measured from the model's own centre.
  const placed: Array<{ part: PublishedPart; mesh: ShareMesh; centre: Vec3; corners: Vec3[] }> = []
  const missing = new Set<string>()
  const fullBox = EMPTY_BOX()

  for (const part of document.parts) {
    const entry = resolve(part.definitionId)
    if (!entry) {
      missing.add(part.definitionId)
      continue
    }
    const combined = multiplyMat3(basis, part.transform.basis)
    const origin = applyMat(basis, part.transform.position)
    const corners: Vec3[] = []
    const box = EMPTY_BOX()
    for (let corner = 0; corner < 8; corner += 1) {
      const local: Vec3 = [
        corner & 1 ? entry.bounds.max[0] : entry.bounds.min[0],
        corner & 2 ? entry.bounds.max[1] : entry.bounds.min[1],
        corner & 4 ? entry.bounds.max[2] : entry.bounds.min[2],
      ]
      const rotated = applyMat(combined, local)
      const world: Vec3 = [rotated[0] + origin[0], rotated[1] + origin[1], rotated[2] + origin[2]]
      corners.push(world)
      growBox(box, world)
      growBox(fullBox, world)
    }
    placed.push({
      part,
      mesh: entry.mesh,
      centre: [
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
      ],
      corners,
    })
  }

  if (!Number.isFinite(fullBox.min[0])) {
    return {
      parts: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      fullBounds: { min: [0, 0, 0], max: [1, 1, 1] },
      missingDefinitionIds: [...missing].sort(),
    }
  }

  const modelCentre: Vec3 = [
    (fullBox.min[0] + fullBox.max[0]) / 2,
    (fullBox.min[1] + fullBox.max[1]) / 2,
    (fullBox.min[2] + fullBox.max[2]) / 2,
  ]
  const modelSpan = Math.max(
    fullBox.max[0] - fullBox.min[0],
    fullBox.max[1] - fullBox.min[1],
    fullBox.max[2] - fullBox.min[2],
    1,
  )

  const parts: RasterPart[] = []
  const drawnBox = EMPTY_BOX()
  const explodedBox = EMPTY_BOX()

  for (const entry of placed) {
    const offset = explodeOffset(entry.centre, modelCentre, modelSpan, explode)
    const combined = multiplyMat3(basis, entry.part.transform.basis)
    const origin = applyMat(basis, entry.part.transform.position)
    const position: Vec3 = [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]]
    for (const corner of entry.corners) {
      growBox(explodedBox, [corner[0] + offset[0], corner[1] + offset[1], corner[2] + offset[2]])
    }

    if (options.include && !options.include.has(entry.part.id)) continue
    for (const corner of entry.corners) {
      growBox(drawnBox, [corner[0] + offset[0], corner[1] + offset[1], corner[2] + offset[2]])
    }

    parts.push({
      positions: entry.mesh.positions,
      indices: entry.mesh.indices,
      slices: entry.mesh.slices,
      transform: { position, basis: combined },
      rgb: options.palette(entry.part.color),
      // With no highlight set every part is "new", which is how a finished
      // model renders at full saturation instead of washed out.
      isNew: options.highlight ? options.highlight.has(entry.part.id) : true,
    })
  }

  const bounds = Number.isFinite(drawnBox.min[0]) ? drawnBox : explodedBox
  return {
    parts,
    bounds: { min: bounds.min, max: bounds.max },
    fullBounds: { min: explodedBox.min, max: explodedBox.max },
    missingDefinitionIds: [...missing].sort(),
  }
}

/**
 * How far an exploded part moves.
 *
 * Radially outward from the model centre, scaled by how far out the part
 * already sits, so an exploded view opens like a diagram instead of scattering
 * everything by the same amount. A part sitting exactly at the centre does not
 * move at all, which is correct — there is no direction for it to go.
 */
function explodeOffset(centre: Vec3, modelCentre: Vec3, span: number, factor: number): Vec3 {
  if (factor <= 0) return [0, 0, 0]
  const delta: Vec3 = [centre[0] - modelCentre[0], centre[1] - modelCentre[1], centre[2] - modelCentre[2]]
  const distance = Math.hypot(delta[0], delta[1], delta[2])
  if (distance < 1e-6) return [0, 0, 0]
  const scale = (factor * span * 0.45) / Math.max(distance, span * 0.05)
  return [delta[0] * scale, delta[1] * scale, delta[2] * scale]
}

/**
 * Framing with the studio's pan and zoom folded in.
 *
 * `frameScene` fits the bounds; zoom multiplies that scale and the offsets
 * translate in supersampled pixels, so the composite is one affine adjustment
 * of the framing the rasteriser already computed rather than a second pass over
 * the image.
 */
export function frameForCard(
  bounds: { min: Vec3; max: Vec3 },
  width: number,
  height: number,
  framing: FramingSettings,
  supersample: number,
): SceneFraming {
  const base = frameScene(bounds, width, height, { padding: framing.padding, supersample })
  const scale = base.scale * framing.zoom
  const pixelWidth = width * supersample
  const pixelHeight = height * supersample
  // Re-centre after zooming: scaling about the frame's origin would drag the
  // model into a corner as zoom rose.
  const centreU = base.offsetU - pixelWidth / 2
  const centreV = base.offsetV - pixelHeight / 2
  return {
    width,
    height,
    supersample,
    scale,
    offsetU: pixelWidth / 2 + centreU * framing.zoom + framing.offsetX * pixelWidth,
    offsetV: pixelHeight / 2 + centreV * framing.zoom - framing.offsetY * pixelHeight,
  }
}
