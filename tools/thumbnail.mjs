import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/**
 * Offline part-thumbnail renderer.
 *
 * A software rasterizer rather than a headless browser: the catalog build has to
 * run under bare `node` in CI, it has to be deterministic so asset hashes are
 * stable, and a palette preview needs a clean orthographic three-quarter view,
 * not a photoreal render. Five hundred parts take a couple of seconds.
 *
 * The output is deliberately **colour-independent**. RGB carries shading and the
 * alpha channel carries coverage, so the runtime can tint one thumbnail with any
 * of the 322 LDraw colours by masking a coloured layer with the alpha and
 * multiplying the shading over it. Baking a colour in would mean 500 parts ×
 * hundreds of colours of assets to show a brick in the colour the operator
 * actually selected.
 */

/** LDraw colour code meaning "inherit the instance colour". */
const MAIN_COLOUR = 16

/**
 * Camera direction, pointing from the viewer toward the part.
 *
 * LDraw is Y-down, so a *positive* Y component means looking downward — which is
 * what shows a brick's studs rather than its hollow underside.
 */
const VIEW_DIRECTION = normalize([0.82, 0.62, 0.95])
const UP_HINT = [0, -1, 0]
// Light from above-left-front; -Y is up in LDraw.
const LIGHT = normalize([-0.35, -0.8, 0.5])
const AMBIENT = 0.42
const PADDING = 0.1

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2])
  return length < 1e-9 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length]
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Orthonormal camera basis for the fixed three-quarter view.
 *
 * LDraw is Y-down, so the up hint is -Y; every part is previewed from the same
 * angle, which is what makes a palette scannable.
 */
function cameraBasis() {
  const forward = VIEW_DIRECTION
  const right = normalize(cross(UP_HINT, forward))
  const up = normalize(cross(forward, right))
  return { forward, right, up }
}

/**
 * Renders one compiled mesh to an RGBA buffer.
 *
 * Flat per-triangle shading with a z-buffer. Smooth normals are deliberately not
 * used: at 128 px a faceted read makes stud and slope geometry easier to
 * recognize than a soft one.
 */
export function renderThumbnail(mesh, options = {}) {
  const size = options.size ?? 128
  const supersample = options.supersample ?? 3
  const resolution = size * supersample
  const { forward, right, up } = cameraBasis()

  const vertexCount = mesh.positions.length / 3
  if (!vertexCount || !mesh.indices.length) return null

  // Project every vertex into camera space once.
  const view = new Float32Array(vertexCount * 3)
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (let index = 0; index < vertexCount; index += 1) {
    const point = [mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]]
    const u = dot(point, right)
    const v = dot(point, up)
    const depth = dot(point, forward)
    view[index * 3] = u
    view[index * 3 + 1] = v
    view[index * 3 + 2] = depth
    if (u < minU) minU = u
    if (u > maxU) maxU = u
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }

  // Fit isotropically so a 1×8 plate and a 2×2 brick keep their real proportions.
  const extent = Math.max(maxU - minU, maxV - minV, 1e-6)
  const scale = (resolution * (1 - PADDING * 2)) / extent
  const offsetU = resolution / 2 - ((minU + maxU) / 2) * scale
  const offsetV = resolution / 2 + ((minV + maxV) / 2) * scale

  const shade = new Float32Array(resolution * resolution * 3)
  const coverage = new Float32Array(resolution * resolution)
  const depthBuffer = new Float32Array(resolution * resolution).fill(Infinity)

  const sliceColourAt = buildSliceLookup(mesh)

  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const a = mesh.indices[triangle]
    const b = mesh.indices[triangle + 1]
    const c = mesh.indices[triangle + 2]

    const ax = view[a * 3] * scale + offsetU
    const ay = offsetV - view[a * 3 + 1] * scale
    const bx = view[b * 3] * scale + offsetU
    const by = offsetV - view[b * 3 + 1] * scale
    const cx = view[c * 3] * scale + offsetU
    const cy = offsetV - view[c * 3 + 1] * scale

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-9) continue

    // Face normal in model space, for shading.
    const ux = mesh.positions[b * 3] - mesh.positions[a * 3]
    const uy = mesh.positions[b * 3 + 1] - mesh.positions[a * 3 + 1]
    const uz = mesh.positions[b * 3 + 2] - mesh.positions[a * 3 + 2]
    const vx = mesh.positions[c * 3] - mesh.positions[a * 3]
    const vy = mesh.positions[c * 3 + 1] - mesh.positions[a * 3 + 1]
    const vz = mesh.positions[c * 3 + 2] - mesh.positions[a * 3 + 2]
    const normal = normalize(cross([ux, uy, uz], [vx, vy, vz]))
    // Two-sided: many LDraw parts are not BFC-certified, so an inverted winding
    // must not produce a black facet.
    const lambert = Math.abs(dot(normal, LIGHT))
    const intensity = Math.min(1, AMBIENT + (1 - AMBIENT) * lambert)

    const baked = sliceColourAt(triangle / 3)
    const tint = baked ? baked : [1, 1, 1]

    const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const rightEdge = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)))
    const top = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const bottom = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)))

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= rightEdge; x += 1) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area
        const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / area
        const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / area
        if (w0 < 0 || w1 < 0 || w2 < 0) continue

        const depth = view[a * 3 + 2] * w1 + view[b * 3 + 2] * w2 + view[c * 3 + 2] * w0
        const pixel = y * resolution + x
        if (depth >= depthBuffer[pixel]) continue
        depthBuffer[pixel] = depth
        shade[pixel * 3] = intensity * tint[0]
        shade[pixel * 3 + 1] = intensity * tint[1]
        shade[pixel * 3 + 2] = intensity * tint[2]
        coverage[pixel] = 1
      }
    }
  }

  return { rgba: downsample(shade, coverage, resolution, size, supersample), size }
}

/**
 * Maps a triangle index to the colour baked into its slice, or null when the
 * slice inherits the instance colour.
 */
function buildSliceLookup(mesh) {
  const ranges = mesh.slices
    .filter((slice) => slice.colour !== MAIN_COLOUR)
    .map((slice) => ({
      from: slice.start / 3,
      to: (slice.start + slice.count) / 3,
      tint: approximateColour(slice.colour),
    }))
  if (!ranges.length) return () => null
  return (triangleIndex) => {
    for (const range of ranges) {
      if (triangleIndex >= range.from && triangleIndex < range.to) return range.tint
    }
    return null
  }
}

/**
 * Rough luminance for a baked LDraw colour.
 *
 * Only the dark/light distinction matters at thumbnail scale: a black rubber
 * tyre must read dark against a light hub. The exact hue is irrelevant because
 * the runtime multiplies the operator's colour over this.
 */
function approximateColour(code) {
  if (code === 0 || code === 256 || code === 83) return [0.16, 0.16, 0.16]
  if (code === 15 || code === 47) return [1, 1, 1]
  if (code === 71) return [0.72, 0.72, 0.72]
  if (code === 72 || code === 8) return [0.42, 0.42, 0.42]
  return [0.62, 0.62, 0.62]
}

/** Box-filters the supersampled buffers down to the output size. */
function downsample(shade, coverage, resolution, size, factor) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = factor * factor
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const pixel = (y * factor + sy) * resolution + (x * factor + sx)
          r += shade[pixel * 3]
          g += shade[pixel * 3 + 1]
          b += shade[pixel * 3 + 2]
          alpha += coverage[pixel]
        }
      }
      const offset = (y * size + x) * 4
      // Covered pixels only: averaging shading over empty samples would darken
      // the silhouette edge instead of anti-aliasing it.
      const covered = alpha || 1
      rgba[offset] = Math.round(Math.min(1, r / covered) * 255)
      rgba[offset + 1] = Math.round(Math.min(1, g / covered) * 255)
      rgba[offset + 2] = Math.round(Math.min(1, b / covered) * 255)
      rgba[offset + 3] = Math.round((alpha / samples) * 255)
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Encodes RGBA to PNG.
 *
 * PNG rather than WebP because Node ships zlib but no WebP encoder, and adding a
 * native dependency to the catalog build for a 3 KB palette preview is a poor
 * trade. Deflate is run at maximum level with a fixed strategy so output bytes —
 * and therefore asset hashes — are reproducible.
 */
export function encodePng(rgba, size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // One filter byte per scanline; filter 0 (none) keeps the encoder simple and
  // deflate still compresses the large flat regions well.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Renders and encodes one part thumbnail, returning the buffer and its hash. */
export function compileThumbnail(mesh, options = {}) {
  const rendered = renderThumbnail(mesh, options)
  if (!rendered) return null
  const buffer = encodePng(rendered.rgba, rendered.size)
  return { buffer, hash: createHash('sha256').update(buffer).digest('hex'), size: rendered.size }
}
