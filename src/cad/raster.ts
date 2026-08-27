import type { RigidTransform, Vec3 } from './math'

/**
 * Scene rasterizer for printable output.
 *
 * Instruction pages cannot come from the WebGL viewport. Three reasons decided
 * this:
 *
 *   - The viewport is tuned for a dark interface. Printing a black page is a
 *     poor use of somebody's toner, and re-lighting the live scene for a light
 *     background would make the editor worse to serve the exporter.
 *   - Capturing N steps means driving N frames and reading the drawing buffer
 *     between them, which is a timing race against React and the compositor.
 *   - A rasterizer that runs without WebGL can be tested on its pixels, in node,
 *     which is the only way an assertion about a rendered page means anything.
 *
 * The technique — flat two-sided shading behind a z-buffer, supersampled and box
 * filtered — is the same one `tools/thumbnail.mjs` uses for palette previews, so
 * a part looks the same in the booklet as in the catalog. The inputs are what
 * differ: many transformed parts, per-instance colour, a light background, and a
 * highlight pass for the parts a step introduces.
 */

const VIEW_DIRECTION = normalize([0.82, 0.62, 0.95])
/** LDraw is Y-down, so screen-up is -Y. */
const UP_HINT: Vec3 = [0, -1, 0]
const LIGHT = normalize([-0.35, -0.8, 0.5])
const AMBIENT = 0.46
/** How far a previously-placed part is mixed toward white. */
const PLACED_WASH = 0.58
const OUTLINE_SHADE = 0.22

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-9 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length]
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export type Rgb = readonly [number, number, number]

export interface RasterPart {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** Baked slice colours; a slice of colour 16 inherits the instance colour. */
  readonly slices: ReadonlyArray<{ colour: number; start: number; count: number }>
  readonly transform: RigidTransform
  /** Instance colour, linear 0–1. */
  readonly rgb: Rgb
  /** True for the parts a step introduces; they render at full saturation. */
  readonly isNew: boolean
}

export interface SceneFraming {
  readonly width: number
  readonly height: number
  readonly supersample: number
  readonly scale: number
  readonly offsetU: number
  readonly offsetV: number
}

export interface RasterImage {
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
  /** Fraction of pixels the model covers, for asserting something was drawn. */
  readonly coverage: number
}

const cameraBasis = () => {
  const forward = VIEW_DIRECTION
  const right = normalize(cross(UP_HINT, forward))
  const up = normalize(cross(forward, right))
  return { forward, right, up }
}

/**
 * Fits a document-space box into the page.
 *
 * Framing is computed once from the *finished* model and reused for every step,
 * because a booklet whose camera reframes per page makes the model appear to
 * jump and shrink as it grows — the reader loses track of where the new parts
 * went. The cost is that early steps sit small in a large frame, which is what
 * printed instructions do too.
 */
export function frameScene(
  bounds: { min: Vec3; max: Vec3 },
  width: number,
  height: number,
  options: { padding?: number; supersample?: number } = {},
): SceneFraming {
  const padding = options.padding ?? 0.08
  const supersample = options.supersample ?? 2
  const { forward, right, up } = cameraBasis()

  // Project the eight corners: an axis-aligned box is not axis-aligned once
  // rotated into camera space, so its screen extent is only known from corners.
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (let corner = 0; corner < 8; corner += 1) {
    const point: Vec3 = [
      corner & 1 ? bounds.max[0] : bounds.min[0],
      corner & 2 ? bounds.max[1] : bounds.min[1],
      corner & 4 ? bounds.max[2] : bounds.min[2],
    ]
    const u = dot(point, right)
    const v = dot(point, up)
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  void forward

  const pixelWidth = width * supersample
  const pixelHeight = height * supersample
  const spanU = Math.max(maxU - minU, 1e-6)
  const spanV = Math.max(maxV - minV, 1e-6)
  // One isotropic scale, so the model keeps its proportions on a page that is
  // not square.
  const scale = Math.min(
    (pixelWidth * (1 - padding * 2)) / spanU,
    (pixelHeight * (1 - padding * 2)) / spanV,
  )
  return {
    width,
    height,
    supersample,
    scale,
    offsetU: pixelWidth / 2 - ((minU + maxU) / 2) * scale,
    offsetV: pixelHeight / 2 + ((minV + maxV) / 2) * scale,
  }
}

export interface RenderSceneOptions {
  /** Resolves a baked LDraw slice colour; null means "inherit the instance". */
  readonly palette?: (code: number) => Rgb | null
  /** Draw a dark boundary around the parts this step introduces. */
  readonly outlineNew?: boolean
}

/**
 * Rasterizes a set of transformed parts into an RGBA buffer.
 *
 * Alpha is coverage, so a page can composite the render over any background
 * rather than carrying a baked one.
 */
export function renderScene(
  parts: readonly RasterPart[],
  framing: SceneFraming,
  options: RenderSceneOptions = {},
): RasterImage {
  const { forward, right, up } = cameraBasis()
  const supersample = framing.supersample
  const pixelWidth = framing.width * supersample
  const pixelHeight = framing.height * supersample
  const pixels = pixelWidth * pixelHeight

  const shade = new Float32Array(pixels * 3)
  const depth = new Float32Array(pixels).fill(Infinity)
  const covered = new Uint8Array(pixels)
  // Which part owns each pixel, so the highlight pass can find the silhouette of
  // the parts a step adds rather than the silhouette of the whole model.
  const owner = new Int32Array(pixels).fill(-1)
  const isNewPixel = new Uint8Array(pixels)

  const world: [number, number, number] = [0, 0, 0]
  const transformed = { a: [0, 0, 0] as Vec3, b: [0, 0, 0] as Vec3, c: [0, 0, 0] as Vec3 }

  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex]
    const { positions, indices, transform } = part
    const vertexCount = positions.length / 3
    if (!vertexCount || !indices.length) continue

    // Transform to document space, then straight to camera space; the
    // intermediate is never needed again.
    const view = new Float32Array(vertexCount * 3)
    const model = new Float32Array(vertexCount * 3)
    const { position, basis } = transform
    for (let index = 0; index < vertexCount; index += 1) {
      const x = positions[index * 3]
      const y = positions[index * 3 + 1]
      const z = positions[index * 3 + 2]
      world[0] = basis[0] * x + basis[1] * y + basis[2] * z + position[0]
      world[1] = basis[3] * x + basis[4] * y + basis[5] * z + position[1]
      world[2] = basis[6] * x + basis[7] * y + basis[8] * z + position[2]
      model[index * 3] = world[0]
      model[index * 3 + 1] = world[1]
      model[index * 3 + 2] = world[2]
      view[index * 3] = dot(world, right) * framing.scale + framing.offsetU
      view[index * 3 + 1] = framing.offsetV - dot(world, up) * framing.scale
      view[index * 3 + 2] = dot(world, forward)
    }

    const baseTint = part.isNew ? part.rgb : washed(part.rgb)
    const sliceColourAt = buildSliceLookup(part, options.palette)

    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const a = indices[triangle]
      const b = indices[triangle + 1]
      const c = indices[triangle + 2]

      const ax = view[a * 3]
      const ay = view[a * 3 + 1]
      const bx = view[b * 3]
      const by = view[b * 3 + 1]
      const cx = view[c * 3]
      const cy = view[c * 3 + 1]

      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      if (Math.abs(area) < 1e-9) continue

      transformed.a = [model[a * 3], model[a * 3 + 1], model[a * 3 + 2]]
      transformed.b = [model[b * 3], model[b * 3 + 1], model[b * 3 + 2]]
      transformed.c = [model[c * 3], model[c * 3 + 1], model[c * 3 + 2]]
      const normal = normalize(
        cross(
          [transformed.b[0] - transformed.a[0], transformed.b[1] - transformed.a[1], transformed.b[2] - transformed.a[2]],
          [transformed.c[0] - transformed.a[0], transformed.c[1] - transformed.a[1], transformed.c[2] - transformed.a[2]],
        ),
      )
      // Two-sided: plenty of LDraw parts are not BFC-certified, and an inverted
      // winding must not turn a face black.
      const lambert = Math.abs(dot(normal, LIGHT))
      const intensity = Math.min(1, AMBIENT + (1 - AMBIENT) * lambert)

      const baked = sliceColourAt(triangle / 3)
      const tint = baked ?? baseTint

      const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
      const rightEdge = Math.min(pixelWidth - 1, Math.ceil(Math.max(ax, bx, cx)))
      const top = Math.max(0, Math.floor(Math.min(ay, by, cy)))
      const bottom = Math.min(pixelHeight - 1, Math.ceil(Math.max(ay, by, cy)))

      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= rightEdge; x += 1) {
          const px = x + 0.5
          const py = y + 0.5
          const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area
          const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / area
          const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / area
          if (w0 < 0 || w1 < 0 || w2 < 0) continue

          const z = view[a * 3 + 2] * w1 + view[b * 3 + 2] * w2 + view[c * 3 + 2] * w0
          const pixel = y * pixelWidth + x
          if (z >= depth[pixel]) continue
          depth[pixel] = z
          shade[pixel * 3] = intensity * tint[0]
          shade[pixel * 3 + 1] = intensity * tint[1]
          shade[pixel * 3 + 2] = intensity * tint[2]
          covered[pixel] = 1
          owner[pixel] = partIndex
          isNewPixel[pixel] = part.isNew ? 1 : 0
        }
      }
    }
  }

  if (options.outlineNew !== false) outlineNewParts(shade, covered, isNewPixel, owner, pixelWidth, pixelHeight)

  return downsample(shade, covered, pixelWidth, pixelHeight, framing.width, framing.height, supersample)
}

const washed = (rgb: Rgb): Rgb => [
  rgb[0] + (1 - rgb[0]) * PLACED_WASH,
  rgb[1] + (1 - rgb[1]) * PLACED_WASH,
  rgb[2] + (1 - rgb[2]) * PLACED_WASH,
]

/**
 * Darkens the boundary of the parts this step introduces.
 *
 * A wash alone is not enough on a monochrome print or for a new part that
 * happens to be white, so the new geometry also gets a drawn edge. The boundary
 * is where a new pixel meets background or already-placed geometry — not where
 * two new parts meet, which would draw a seam through the middle of a
 * sub-assembly placed in one step.
 */
function outlineNewParts(
  shade: Float32Array,
  covered: Uint8Array,
  isNewPixel: Uint8Array,
  owner: Int32Array,
  width: number,
  height: number,
) {
  const edges: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x
      if (!isNewPixel[pixel]) continue
      const neighbours = [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y < height - 1 ? pixel + width : -1,
      ]
      for (const neighbour of neighbours) {
        if (neighbour < 0) {
          edges.push(pixel)
          break
        }
        if (!covered[neighbour] || (!isNewPixel[neighbour] && owner[neighbour] !== owner[pixel])) {
          edges.push(pixel)
          break
        }
      }
    }
  }
  for (const pixel of edges) {
    shade[pixel * 3] *= OUTLINE_SHADE
    shade[pixel * 3 + 1] *= OUTLINE_SHADE
    shade[pixel * 3 + 2] *= OUTLINE_SHADE
  }
}

function buildSliceLookup(part: RasterPart, palette?: (code: number) => Rgb | null) {
  if (!palette || !part.slices.length) return () => null
  const ranges = part.slices
    .filter((slice) => slice.colour !== 16 && slice.colour !== 24)
    .map((slice) => ({
      firstTriangle: slice.start / 3,
      lastTriangle: (slice.start + slice.count) / 3,
      rgb: palette(slice.colour),
    }))
    .filter((range): range is { firstTriangle: number; lastTriangle: number; rgb: Rgb } => range.rgb !== null)
  if (!ranges.length) return () => null
  return (triangle: number): Rgb | null => {
    for (const range of ranges) {
      if (triangle >= range.firstTriangle && triangle < range.lastTriangle) return range.rgb
    }
    return null
  }
}

/** Box filter down from the supersampled buffers, carrying coverage into alpha. */
function downsample(
  shade: Float32Array,
  covered: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  factor: number,
): RasterImage {
  const rgba = new Uint8ClampedArray(width * height * 4)
  const samples = factor * factor
  let coveredPixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy
        if (sy >= sourceHeight) continue
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx
          if (sx >= sourceWidth) continue
          const source = sy * sourceWidth + sx
          if (!covered[source]) continue
          r += shade[source * 3]
          g += shade[source * 3 + 1]
          b += shade[source * 3 + 2]
          hits += 1
        }
      }
      const target = (y * width + x) * 4
      if (!hits) continue
      // Average over the hits so a partially-covered edge pixel keeps its
      // colour, and put the coverage ratio in alpha where it belongs.
      rgba[target] = Math.round((r / hits) * 255)
      rgba[target + 1] = Math.round((g / hits) * 255)
      rgba[target + 2] = Math.round((b / hits) * 255)
      rgba[target + 3] = Math.round((hits / samples) * 255)
      coveredPixels += 1
    }
  }
  return { rgba, width, height, coverage: coveredPixels / (width * height) }
}

/** Parses `#rrggbb` into linear-ish 0–1 components for the rasterizer. */
export function rgbFromHex(hex: string): Rgb {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const number = Number.parseInt(full, 16)
  if (!Number.isFinite(number)) return [0.72, 0.75, 0.76]
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255]
}
