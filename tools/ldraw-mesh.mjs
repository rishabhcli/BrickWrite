/**
 * LDraw geometry compiler.
 *
 * Flattens an LDraw part's full sub-file dependency tree into a single packed
 * triangle mesh plus its hard-edge line set. Everything here is deliberately
 * offline: the browser never walks `.dat` dependency trees at runtime.
 *
 * Semantics implemented from the LDraw File Format specification:
 *   - line types 1 (sub-file), 2 (edge), 3 (triangle), 4 (quad)
 *   - colour 16 (inherit surface colour) and 24 (inherit edge colour)
 *   - BFC CERTIFY CW/CCW, BFC CW/CCW, BFC INVERTNEXT
 *   - winding inversion when a placement matrix determinant is negative
 *
 * Type 5 (optional/conditional) lines are parsed and discarded: they exist to
 * drive silhouette rendering, and Brickwright derives its outlines from type 2.
 */
import { createHash } from 'node:crypto'

export const MESH_MAGIC = 0x314d5742 // "BWM1"
export const MAIN_COLOUR = 16
export const EDGE_COLOUR = 24

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Crease threshold. LDraw approximates cylinders with 16 segments (22.5° per
 *  facet), so smoothing below 35° rounds curved primitives while leaving box
 *  corners and slope faces sharp. */
const SMOOTH_COS = Math.cos((35 * Math.PI) / 180)

/** Position weld tolerance in LDU. LDraw authors to 3-4 decimal places. */
const WELD = 1e3

const normalizeRef = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '').trim().toLowerCase()

function multiply(a, b) {
  const out = new Array(9)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] =
        a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]
    }
  }
  return out
}

function apply(matrix, offset, x, y, z) {
  return [
    offset[0] + matrix[0] * x + matrix[1] * y + matrix[2] * z,
    offset[1] + matrix[3] * x + matrix[4] * y + matrix[5] * z,
    offset[2] + matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ]
}

function determinant(m) {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

/**
 * Parses one `.dat` source into a reusable instruction list. Parsing dominates
 * compile cost, so callers cache the result per file and replay it cheaply
 * under different transforms and inherited colours.
 */
export function parseLDrawSource(source) {
  const instructions = []
  let certified = null // null = unknown, true = BFC certified
  let windingCcw = true
  let invertNext = false

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const code = line.charCodeAt(0) - 48

    if (code === 0) {
      const bfc = line.match(/^0\s+BFC\s+(.*)$/i)
      if (!bfc) continue
      const tokens = bfc[1].trim().toUpperCase().split(/\s+/)
      for (const token of tokens) {
        if (token === 'NOCERTIFY') certified = false
        else if (token === 'CERTIFY') certified = certified === false ? false : true
        else if (token === 'CW') windingCcw = false
        else if (token === 'CCW') windingCcw = true
        else if (token === 'INVERTNEXT') invertNext = true
      }
      if (tokens.includes('CERTIFY') && !tokens.includes('CW')) windingCcw = true
      continue
    }

    const tokens = line.split(/\s+/)
    const colour = Number(tokens[1])

    if (code === 1) {
      if (tokens.length < 15) continue
      const values = tokens.slice(2, 14).map(Number)
      if (values.some(Number.isNaN)) continue
      instructions.push({
        kind: 1,
        colour,
        offset: values.slice(0, 3),
        matrix: values.slice(3, 12),
        ref: normalizeRef(tokens.slice(14).join(' ')),
        invert: invertNext,
        ccw: windingCcw,
      })
      invertNext = false
      continue
    }

    invertNext = false

    if (code === 2) {
      const values = tokens.slice(2, 8).map(Number)
      if (values.length === 6 && !values.some(Number.isNaN)) instructions.push({ kind: 2, colour, values })
      continue
    }

    if (code === 3 || code === 4) {
      const count = code === 3 ? 9 : 12
      const values = tokens.slice(2, 2 + count).map(Number)
      if (values.length !== count || values.some(Number.isNaN)) continue
      instructions.push({ kind: code, colour, values, ccw: windingCcw })
    }
  }

  return { instructions, certified: certified !== false }
}

class MeshAccumulator {
  constructor() {
    this.faces = [] // { colour, a, b, c }
    this.edges = []
    this.min = [Infinity, Infinity, Infinity]
    this.max = [-Infinity, -Infinity, -Infinity]
  }

  point(p) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (p[axis] < this.min[axis]) this.min[axis] = p[axis]
      if (p[axis] > this.max[axis]) this.max[axis] = p[axis]
    }
    return p
  }

  triangle(colour, a, b, c, flip) {
    this.faces.push(flip ? { colour, a: this.point(c), b: this.point(b), c: this.point(a) } : { colour, a: this.point(a), b: this.point(b), c: this.point(c) })
  }

  edge(a, b) {
    this.edges.push(this.point(a), this.point(b))
  }
}

/**
 * Resolves an LDraw reference tree into flattened world-space faces.
 *
 * `resolve(ref)` must return `{ text, key }` for a normalized reference, or
 * `null` when the reference is unknown. Unknown references are reported rather
 * than silently dropped so the compiler can publish honest coverage numbers.
 */
export function flattenPart(rootRef, resolve, options = {}) {
  const parseCache = options.parseCache ?? new Map()
  const missing = new Set()
  const mesh = new MeshAccumulator()
  const maxDepth = options.maxDepth ?? 64

  const read = (ref) => {
    if (parseCache.has(ref)) return parseCache.get(ref)
    const file = resolve(ref)
    const parsed = file ? parseLDrawSource(file.text) : null
    parseCache.set(ref, parsed)
    return parsed
  }

  const emit = (ref, matrix, offset, colour, edgeColour, invert, depth, stack) => {
    if (depth > maxDepth || stack.has(ref)) return
    const parsed = read(ref)
    if (!parsed) {
      missing.add(ref)
      return
    }
    stack.add(ref)
    const flipByMatrix = determinant(matrix) < 0
    for (const item of parsed.instructions) {
      if (item.kind === 1) {
        const childColour = item.colour === MAIN_COLOUR ? colour : item.colour
        const childEdge = item.colour === EDGE_COLOUR ? edgeColour : item.colour === MAIN_COLOUR ? edgeColour : item.colour
        emit(
          item.ref,
          multiply(matrix, item.matrix),
          apply(matrix, offset, item.offset[0], item.offset[1], item.offset[2]),
          childColour,
          childEdge,
          invert !== item.invert,
          depth + 1,
          stack,
        )
        continue
      }

      if (item.kind === 2) {
        mesh.edge(
          apply(matrix, offset, item.values[0], item.values[1], item.values[2]),
          apply(matrix, offset, item.values[3], item.values[4], item.values[5]),
        )
        continue
      }

      const faceColour = item.colour === MAIN_COLOUR ? colour : item.colour
      // A face is emitted counter-clockwise when its declared winding, the
      // inherited INVERTNEXT chain, and the matrix handedness agree.
      const flip = item.ccw === false !== (invert !== flipByMatrix)
      const v = item.values
      const p = (index) => apply(matrix, offset, v[index * 3], v[index * 3 + 1], v[index * 3 + 2])
      if (item.kind === 3) {
        mesh.triangle(faceColour, p(0), p(1), p(2), flip)
      } else {
        const a = p(0)
        const b = p(1)
        const c = p(2)
        const d = p(3)
        mesh.triangle(faceColour, a, b, c, flip)
        mesh.triangle(faceColour, a, c, d, flip)
      }
    }
    stack.delete(ref)
  }

  emit(normalizeRef(rootRef), IDENTITY, [0, 0, 0], MAIN_COLOUR, EDGE_COLOUR, false, 0, new Set())
  return { mesh, missing: Array.from(missing) }
}

const faceNormal = (face) => {
  const ux = face.b[0] - face.a[0]
  const uy = face.b[1] - face.a[1]
  const uz = face.b[2] - face.a[2]
  const vx = face.c[0] - face.a[0]
  const vy = face.c[1] - face.a[1]
  const vz = face.c[2] - face.a[2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const length = Math.hypot(nx, ny, nz)
  return length < 1e-9 ? null : [nx / length, ny / length, nz / length]
}

const positionKey = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`

/**
 * Builds indexed geometry with crease-angle vertex smoothing, then groups the
 * index buffer into contiguous colour slices. Slice colour `16` means "paint
 * with the part instance colour"; any other value is a hard-coded LDraw colour
 * baked into the part (rubber tyres, printed detail, metallic pins).
 */
export function buildIndexedGeometry(mesh) {
  const faces = []
  for (const face of mesh.faces) {
    const normal = faceNormal(face)
    if (normal) faces.push({ ...face, normal })
  }
  faces.sort((a, b) => a.colour - b.colour)

  // Group incident faces per welded position so smoothing can be decided
  // locally without a global adjacency structure.
  const incident = new Map()
  for (const face of faces) {
    for (const corner of ['a', 'b', 'c']) {
      const key = positionKey(face[corner])
      const bucket = incident.get(key)
      if (bucket) bucket.push(face.normal)
      else incident.set(key, [face.normal])
    }
  }

  const vertexIndex = new Map()
  const positions = []
  const normals = []
  const indices = []

  const pushVertex = (point, normal) => {
    const key = `${positionKey(point)}|${Math.round(normal[0] * 100)},${Math.round(normal[1] * 100)},${Math.round(normal[2] * 100)}`
    const existing = vertexIndex.get(key)
    if (existing !== undefined) return existing
    const index = positions.length / 3
    positions.push(point[0], point[1], point[2])
    normals.push(normal[0], normal[1], normal[2])
    vertexIndex.set(key, index)
    return index
  }

  const smoothedNormal = (point, faceNormalVector) => {
    const bucket = incident.get(positionKey(point))
    if (!bucket || bucket.length < 2) return faceNormalVector
    let x = 0
    let y = 0
    let z = 0
    for (const candidate of bucket) {
      const dot = candidate[0] * faceNormalVector[0] + candidate[1] * faceNormalVector[1] + candidate[2] * faceNormalVector[2]
      if (dot < SMOOTH_COS) continue
      x += candidate[0]
      y += candidate[1]
      z += candidate[2]
    }
    const length = Math.hypot(x, y, z)
    return length < 1e-9 ? faceNormalVector : [x / length, y / length, z / length]
  }

  const slices = []
  let currentColour = null
  for (const face of faces) {
    if (face.colour !== currentColour) {
      slices.push({ colour: face.colour, start: indices.length, count: 0 })
      currentColour = face.colour
    }
    indices.push(
      pushVertex(face.a, smoothedNormal(face.a, face.normal)),
      pushVertex(face.b, smoothedNormal(face.b, face.normal)),
      pushVertex(face.c, smoothedNormal(face.c, face.normal)),
    )
    slices.at(-1).count += 3
  }

  return { positions, normals, indices, slices }
}

/** Serializes compiled geometry into the little-endian `.bwmesh` container. */
export function packMesh({ positions, normals, indices, slices }, edges, bounds) {
  const vertexCount = positions.length / 3
  const headerBytes = 52 + slices.length * 12
  const buffer = Buffer.alloc(
    headerBytes + positions.length * 4 + normals.length * 4 + indices.length * 4 + edges.length * 4,
  )

  let cursor = 0
  buffer.writeUInt32LE(MESH_MAGIC, cursor); cursor += 4
  buffer.writeUInt32LE(1, cursor); cursor += 4
  for (const value of [...bounds.min, ...bounds.max]) { buffer.writeFloatLE(value, cursor); cursor += 4 }
  buffer.writeUInt32LE(vertexCount, cursor); cursor += 4
  buffer.writeUInt32LE(indices.length, cursor); cursor += 4
  buffer.writeUInt32LE(edges.length / 3, cursor); cursor += 4
  buffer.writeUInt32LE(slices.length, cursor); cursor += 4
  buffer.writeUInt32LE(0, cursor); cursor += 4

  for (const slice of slices) {
    buffer.writeUInt32LE(slice.colour >>> 0, cursor); cursor += 4
    buffer.writeUInt32LE(slice.start, cursor); cursor += 4
    buffer.writeUInt32LE(slice.count, cursor); cursor += 4
  }
  for (const value of positions) { buffer.writeFloatLE(value, cursor); cursor += 4 }
  for (const value of normals) { buffer.writeFloatLE(value, cursor); cursor += 4 }
  for (const value of indices) { buffer.writeUInt32LE(value, cursor); cursor += 4 }
  for (const value of edges) { buffer.writeFloatLE(value, cursor); cursor += 4 }

  return buffer
}

/**
 * Compiles one LDraw part reference into a packed mesh plus the measurements
 * the catalog needs. Returns `null` when the part contributes no geometry.
 */
export function compileMesh(ref, resolve, options = {}) {
  const { mesh, missing } = flattenPart(ref, resolve, options)
  if (!mesh.faces.length && !mesh.edges.length) return null
  const geometry = buildIndexedGeometry(mesh)
  const edges = []
  for (const point of mesh.edges) edges.push(point[0], point[1], point[2])
  const bounds = { min: mesh.min, max: mesh.max }
  const buffer = packMesh(geometry, edges, bounds)
  return {
    buffer,
    hash: createHash('sha256').update(buffer).digest('hex'),
    bounds,
    missing,
    stats: {
      vertices: geometry.positions.length / 3,
      triangles: geometry.indices.length / 3,
      edgeSegments: edges.length / 6,
      slices: geometry.slices.map((slice) => slice.colour),
    },
  }
}
