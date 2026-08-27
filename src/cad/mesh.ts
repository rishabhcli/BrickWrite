import * as THREE from 'three'
import { verifyAsset } from './integrity'
import type { PartDefinition, Vec3 } from './types'

/**
 * Runtime decoder for the `.bwmesh` container produced by
 * `tools/ldraw-mesh.mjs`. The browser never walks LDraw `.dat` dependency
 * trees: it fetches one immutable, content-addressed buffer per part.
 *
 * Layout (little-endian):
 *   u32   magic "BWM1"
 *   u32   version
 *   f32×6 bounds (min xyz, max xyz) in LDraw units
 *   u32   vertexCount
 *   u32   indexCount
 *   u32   edgeVertexCount
 *   u32   sliceCount
 *   u32   reserved
 *   slice[sliceCount] { u32 ldrawColour, u32 indexStart, u32 indexCount }
 *   f32[vertexCount*3]     positions
 *   f32[vertexCount*3]     normals
 *   u32[indexCount]        indices
 *   f32[edgeVertexCount*3] edge line segment endpoints
 *
 * A slice whose colour is 16 is painted with the part instance's colour; any
 * other value is a colour baked into the part itself, such as a black rubber
 * tyre or a printed detail.
 */

const MAGIC = 0x314d5742
const HEADER_BYTES = 52

/** LDraw's "current colour" code: paint with whatever the instance specifies. */
export const MAIN_COLOUR = 16

export interface MeshSlice {
  colour: number
  start: number
  count: number
}

export interface DecodedMesh {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  edges: Float32Array
  slices: MeshSlice[]
  bounds: { min: Vec3; max: Vec3 }
  triangles: number
}

export function decodeMesh(buffer: ArrayBuffer): DecodedMesh {
  if (buffer.byteLength < 8) throw new Error(`Truncated Brickwright mesh header (${buffer.byteLength} bytes).`)
  const view = new DataView(buffer)
  const magic = view.getUint32(0, true)
  if (magic !== MAGIC) throw new Error(`Not a Brickwright mesh: magic 0x${magic.toString(16)}`)
  const version = view.getUint32(4, true)
  if (version !== 1) throw new Error(`Unsupported Brickwright mesh version ${version}`)
  if (buffer.byteLength < HEADER_BYTES) throw new Error(`Truncated Brickwright mesh header (${buffer.byteLength} bytes).`)

  const bounds = {
    min: [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)] as Vec3,
    max: [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)] as Vec3,
  }
  const vertexCount = view.getUint32(32, true)
  const indexCount = view.getUint32(36, true)
  const edgeVertexCount = view.getUint32(40, true)
  const sliceCount = view.getUint32(44, true)

  if (indexCount % 3 !== 0) throw new Error(`Brickwright mesh index count ${indexCount} is not triangular.`)
  if (edgeVertexCount % 2 !== 0) throw new Error(`Brickwright mesh edge vertex count ${edgeVertexCount} is not paired.`)
  const expectedBytes =
    HEADER_BYTES +
    sliceCount * 12 +
    vertexCount * 12 +
    vertexCount * 12 +
    indexCount * 4 +
    edgeVertexCount * 12
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== buffer.byteLength) {
    throw new Error(`Brickwright mesh layout mismatch: header requires ${expectedBytes} bytes, received ${buffer.byteLength}.`)
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) || bounds.min[axis] > bounds.max[axis]) {
      throw new Error(`Brickwright mesh has invalid bounds on axis ${axis}.`)
    }
  }

  const slices: MeshSlice[] = []
  for (let index = 0; index < sliceCount; index += 1) {
    const offset = HEADER_BYTES + index * 12
    const slice = {
      colour: view.getUint32(offset, true),
      start: view.getUint32(offset + 4, true),
      count: view.getUint32(offset + 8, true),
    }
    if (slice.start % 3 !== 0 || slice.count % 3 !== 0 || slice.start + slice.count > indexCount) {
      throw new Error(`Brickwright mesh slice ${index} is outside the index buffer.`)
    }
    slices.push(slice)
  }

  let cursor = HEADER_BYTES + sliceCount * 12
  const positions = new Float32Array(buffer, cursor, vertexCount * 3)
  cursor += vertexCount * 12
  const normals = new Float32Array(buffer, cursor, vertexCount * 3)
  cursor += vertexCount * 12
  const indices = new Uint32Array(buffer, cursor, indexCount)
  cursor += indexCount * 4
  const edges = new Float32Array(buffer, cursor, edgeVertexCount * 3)

  for (const value of positions) if (!Number.isFinite(value)) throw new Error('Brickwright mesh contains a non-finite position.')
  for (const value of normals) if (!Number.isFinite(value)) throw new Error('Brickwright mesh contains a non-finite normal.')
  for (const value of edges) if (!Number.isFinite(value)) throw new Error('Brickwright mesh contains a non-finite edge position.')
  for (const index of indices) {
    if (index >= vertexCount) throw new Error(`Brickwright mesh index ${index} exceeds its ${vertexCount} vertices.`)
  }

  return { positions, normals, indices, edges, slices, bounds, triangles: indexCount / 3 }
}

/**
 * Builds the shared `BufferGeometry` for a part definition. Geometry is shared
 * across every instance of a definition; only the instance transform and colour
 * differ, so ten thousand 2×4 bricks cost one geometry upload.
 */
export function buildGeometry(mesh: DecodedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  for (const slice of mesh.slices) geometry.addGroup(slice.start, slice.count, mesh.slices.indexOf(slice))
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(...mesh.bounds.min),
    new THREE.Vector3(...mesh.bounds.max),
  )
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere())
  return geometry
}

/** Builds the hard-edge line geometry LDraw type-2 lines describe. */
export function buildEdgeGeometry(mesh: DecodedMesh): THREE.BufferGeometry | null {
  if (!mesh.edges.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.edges, 3))
  return geometry
}

export interface PartGeometry {
  surface: THREE.BufferGeometry
  edges: THREE.BufferGeometry | null
  slices: MeshSlice[]
  triangles: number
}

type GeometryState =
  | { status: 'loading'; promise: Promise<PartGeometry | null> }
  | { status: 'ready'; geometry: PartGeometry }
  | { status: 'failed'; reason: string }

/**
 * Immutable, content-addressed geometry cache.
 *
 * Assets are named by the SHA-256 of their own bytes, so a cached entry can
 * never be stale and two catalog revisions that share a part share its asset.
 */
export class GeometryCache {
  private states = new Map<string, GeometryState>()
  private listeners = new Set<() => void>()

  constructor(private readonly baseUrl = '') {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  /** Returns geometry if resident, otherwise starts a fetch and returns null. */
  get(definition: PartDefinition): PartGeometry | null {
    const asset = definition.geometryAsset
    if (!asset) return null
    const state = this.states.get(asset.file)
    if (state?.status === 'ready') return state.geometry
    if (state) return null
    void this.load(definition)
    return null
  }

  getStatus(definition: PartDefinition): GeometryState['status'] | 'unavailable' {
    if (!definition.geometryAsset) return 'unavailable'
    return this.states.get(definition.geometryAsset.file)?.status ?? 'unavailable'
  }

  /** Resolves once the part's geometry is resident, or null when unavailable. */
  async load(definition: PartDefinition): Promise<PartGeometry | null> {
    const asset = definition.geometryAsset
    if (!asset) return null
    const existing = this.states.get(asset.file)
    if (existing?.status === 'ready') return existing.geometry
    if (existing?.status === 'loading') return existing.promise
    if (existing?.status === 'failed') return null

    const promise = (async () => {
      const response = await fetch(`${this.baseUrl}/${asset.file}`)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const buffer = await response.arrayBuffer()
      await verifyAsset(buffer, asset, `Geometry ${definition.canonicalId}`)
      const mesh = decodeMesh(buffer)
      if (
        mesh.positions.length / 3 !== asset.vertices ||
        mesh.triangles !== asset.triangles ||
        mesh.edges.length / 6 !== asset.edgeSegments
      ) {
        throw new Error(`Geometry ${definition.canonicalId} does not match its catalog metadata.`)
      }
      return {
        surface: buildGeometry(mesh),
        edges: buildEdgeGeometry(mesh),
        slices: mesh.slices,
        triangles: mesh.triangles,
      }
    })()
      .then((geometry) => {
        this.states.set(asset.file, { status: 'ready', geometry })
        this.emit()
        return geometry
      })
      .catch((cause: unknown) => {
        this.states.set(asset.file, { status: 'failed', reason: cause instanceof Error ? cause.message : String(cause) })
        this.emit()
        return null
      })

    this.states.set(asset.file, { status: 'loading', promise })
    return promise
  }

  /** Preloads a set of definitions, ignoring individual failures. */
  async preload(definitions: PartDefinition[]): Promise<void> {
    await Promise.all(definitions.map((definition) => this.load(definition)))
  }

  get residentCount(): number {
    let count = 0
    for (const state of this.states.values()) if (state.status === 'ready') count += 1
    return count
  }
}

export const geometryCache = new GeometryCache()
