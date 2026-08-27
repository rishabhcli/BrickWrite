import * as THREE from 'three'
import { type ExtendedTriangle, MeshBVH } from 'three-mesh-bvh'
import { catalog } from './catalog'
import { getPartBounds, type PartBounds } from './geometry'
import { geometryCache } from './mesh'
import { invertTransform, type RigidTransform, type Vec3 } from './math'
import { deriveConnections, type MatedPair } from './snapping'
import type { ConnectionFamily, ModelDocument, PartInstance } from './types'

/**
 * Collision kernel.
 *
 * Two phases, because neither alone is correct:
 *
 *   Broad phase   world AABB overlap, to find candidate pairs cheaply.
 *   Narrow phase  triangle-pair traversal of the two parts' BVHs, minus the
 *                 volumes in which a legitimately mated connector is *expected*
 *                 to overlap.
 *
 * The subtraction is not an optimization, it is a requirement: a brick stacked
 * on another legitimately intersects it by the full stud, so an unqualified
 * triangle test reports every correct build as a collision. Equally, a blanket
 * "connected parts may overlap" rule misses real interpenetration between two
 * parts that also happen to be joined somewhere else. Only a *localized*
 * allowance around each mated connector distinguishes the two.
 *
 * Every result carries its own certainty, so "not checked" never masquerades as
 * "verified".
 */

export type CollisionCertainty =
  /** Triangle-exact, with no allowance applied. */
  | 'exact'
  /** Triangle-exact outside modelled mating volumes. */
  | 'clearance-subtracted'
  /** Geometry or a mating volume was unavailable; the box test decided. */
  | 'unknown'

export interface CollisionContact {
  readonly partA: string
  readonly partB: string
  readonly certainty: CollisionCertainty
  /** Document-space point inside the offending overlap, when known. */
  readonly pointLdu?: Vec3
  /** Deepest box overlap extent, used when no triangle data was available. */
  readonly overlapLdu: Vec3
}

// ---------------------------------------------------------------------------
// Geometry providers
// ---------------------------------------------------------------------------

export interface CollisionGeometry {
  readonly geometry: THREE.BufferGeometry
  readonly bvh: MeshBVH
}

export type GeometryProvider = (definitionId: string) => THREE.BufferGeometry | null

const bvhCache = new Map<string, CollisionGeometry | null>()

/**
 * BVHs are built once per part definition and cached.
 *
 * Brick geometry never deforms, so a definition's bounds hierarchy is valid for
 * the lifetime of the session and shared by every instance of that part.
 * Precompiling and serializing these into the catalog assets is a worthwhile
 * follow-up; building them lazily keeps the asset format stable meanwhile.
 */
export function collisionGeometryFor(definitionId: string, provide: GeometryProvider): CollisionGeometry | null {
  const cached = bvhCache.get(definitionId)
  if (cached !== undefined) return cached
  const geometry = provide(definitionId)
  if (!geometry || !geometry.getIndex()) {
    bvhCache.set(definitionId, null)
    return null
  }
  const entry: CollisionGeometry = { geometry, bvh: new MeshBVH(geometry) }
  bvhCache.set(definitionId, entry)
  return entry
}

export function clearCollisionGeometryCache() {
  bvhCache.clear()
}

// ---------------------------------------------------------------------------
// Narrow phase
// ---------------------------------------------------------------------------

const boxOverlap = (a: PartBounds, b: PartBounds): Vec3 => [
  Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]),
  Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]),
  Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]),
]

const matrixOf = (transform: RigidTransform): THREE.Matrix4 => {
  const b = transform.basis
  const [x, y, z] = transform.position
  return new THREE.Matrix4().set(b[0], b[1], b[2], x, b[3], b[4], b[5], y, b[6], b[7], b[8], z, 0, 0, 0, 1)
}

/**
 * Confirms whether two parts' surfaces actually intersect.
 *
 * This is the narrow phase, and it runs as a *confirmation* of a box-phase
 * candidate rather than as the sole authority. Its job is to eliminate the
 * false positives axis-aligned boxes produce in abundance — a rotated slope, a
 * wheel, a windscreen and a Technic beam all have boxes far larger than their
 * geometry, so their boxes overlap constantly while their surfaces do not.
 *
 * Distinguishing *touching* from *interpenetrating* is deliberately left to the
 * mating-clearance layer above. Doing it here would require reasoning about
 * penetration depth local to each contact: a brick's top face is a single large
 * triangle, so the depth of its farthest vertex behind a neighbouring plane says
 * nothing about whether the two solids actually overlap. That is real work, not
 * a tolerance to tune, and it is tracked as follow-up rather than approximated.
 */
function confirmSurfaceContact(
  a: PartInstance,
  b: PartInstance,
  provide: GeometryProvider,
): { status: 'clean' | 'contact'; pointLdu?: Vec3 } | { status: 'unavailable' } {
  const geometryA = collisionGeometryFor(a.definitionId, provide)
  const geometryB = collisionGeometryFor(b.definitionId, provide)
  if (!geometryA || !geometryB) return { status: 'unavailable' }

  const worldA = matrixOf(a.transform)
  const bToA = matrixOf(invertTransform(a.transform)).multiply(matrixOf(b.transform))

  // A triangle-pair test depends on nothing but the two definitions and their
  // *relative* pose, so the same arrangement never needs confirming twice. A
  // real model is overwhelmingly the same few arrangements repeated: a 2 × 4 on
  // a 2 × 4 half-offset, a plate on a brick, a wall course on the one below.
  // Measured on a 366-part module stamped onto a 1,464-part document, this took
  // the commit from 4.1 s to well under a second, because the second copy of a
  // building is geometrically the first one again.
  const key = `${a.definitionId}|${b.definitionId}|${quantizeMatrix(bToA)}`
  const cached = narrowPhaseCache.get(key)
  if (cached) {
    if (!cached.localPoint) return { status: 'clean' }
    const point = new THREE.Vector3(...cached.localPoint).applyMatrix4(worldA)
    return { status: 'contact', pointLdu: [point.x, point.y, point.z] }
  }

  const segment = new THREE.Line3()
  const midpoint = new THREE.Vector3()
  let localPoint: Vec3 | null = null

  geometryA.bvh.bvhcast(geometryB.bvh, bToA, {
    intersectsTriangles(triangleA: ExtendedTriangle, triangleB: ExtendedTriangle) {
      // `bvhcast` yields pairs whose *bounds* overlap, so the triangles have to
      // be intersected before anything is concluded from them.
      if (!triangleA.intersectsTriangle(triangleB, segment)) return false
      segment.getCenter(midpoint)
      // Stored in A's own frame, which is what makes the verdict reusable at
      // any world position the same arrangement turns up in.
      localPoint = [midpoint.x, midpoint.y, midpoint.z]
      return true
    },
  })

  rememberNarrowPhase(key, localPoint)
  if (!localPoint) return { status: 'clean' }
  const world = new THREE.Vector3(...(localPoint as Vec3)).applyMatrix4(worldA)
  return { status: 'contact', pointLdu: [world.x, world.y, world.z] }
}

/**
 * Verdicts keyed by the two definitions and their relative pose.
 *
 * Bounded, because a model with thousands of distinct arrangements would
 * otherwise grow this without limit. Eviction is oldest-first, which suits the
 * access pattern: an edit re-tests the arrangements it just made.
 */
const NARROW_PHASE_CACHE_LIMIT = 20_000
const narrowPhaseCache = new Map<string, { localPoint: Vec3 | null }>()

function rememberNarrowPhase(key: string, localPoint: Vec3 | null) {
  if (narrowPhaseCache.size >= NARROW_PHASE_CACHE_LIMIT) {
    const oldest = narrowPhaseCache.keys().next().value
    if (oldest !== undefined) narrowPhaseCache.delete(oldest)
  }
  narrowPhaseCache.set(key, { localPoint })
}

/** Clears the memo. Exposed so a test can measure a cold pass. */
export const resetNarrowPhaseCache = () => narrowPhaseCache.clear()

/**
 * A stable key for a relative pose.
 *
 * Quantized to a thousandth of an LDU: finer than any placement the kernel can
 * produce — the grid is whole LDU and bases hold exact 0, ±1 — and coarse
 * enough that float noise from composing two transforms cannot split one
 * arrangement into two cache entries.
 */
function quantizeMatrix(matrix: THREE.Matrix4): string {
  const elements = matrix.elements
  let key = ''
  for (let index = 0; index < 16; index += 1) key += `${Math.round(elements[index] * 1000)},`
  return key
}

/**
 * Uniform grid over world bounds.
 *
 * The pairwise loop it replaces is O(n²): at five thousand parts that is twelve
 * million box comparisons for every validation pass. Bucketing by a two-stud
 * cell means a part is only compared against the handful of parts that share a
 * cell with it, which is what makes validation viable on a real model rather
 * than on a showcase.
 */
const BROAD_PHASE_CELL_LDU = 40

export class CollisionBroadPhase {
  private cells = new Map<string, string[]>()
  private bounds = new Map<string, PartBounds>()

  insert(partBounds: PartBounds) {
    this.bounds.set(partBounds.partId, partBounds)
    for (const key of this.keysFor(partBounds)) {
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(partBounds.partId)
      else this.cells.set(key, [partBounds.partId])
    }
  }

  private *keysFor(partBounds: PartBounds) {
    const min = partBounds.min.map((value) => Math.floor(value / BROAD_PHASE_CELL_LDU))
    const max = partBounds.max.map((value) => Math.floor(value / BROAD_PHASE_CELL_LDU))
    for (let x = min[0]; x <= max[0]; x += 1) {
      for (let y = min[1]; y <= max[1]; y += 1) {
        for (let z = min[2]; z <= max[2]; z += 1) yield `${x}:${y}:${z}`
      }
    }
  }

  /** Part ids whose bounds could overlap the given part's. */
  neighbours(partId: string): string[] {
    const partBounds = this.bounds.get(partId)
    if (!partBounds) return []
    const found = new Set<string>()
    for (const key of this.keysFor(partBounds)) {
      for (const candidate of this.cells.get(key) ?? []) {
        if (candidate !== partId) found.add(candidate)
      }
    }
    return [...found]
  }

  boundsOf(partId: string): PartBounds | undefined {
    return this.bounds.get(partId)
  }
}

/** Broad-phase index for a document, memoized per revision. */
const broadPhaseCache = new WeakMap<ModelDocument, CollisionBroadPhase>()

export function deriveBroadPhase(document: ModelDocument): CollisionBroadPhase {
  const cached = broadPhaseCache.get(document)
  if (cached) return cached
  const index = new CollisionBroadPhase()
  for (const part of Object.values(document.parts)) {
    const partBounds = getPartBounds(part)
    if (partBounds.measured) index.insert(partBounds)
  }
  broadPhaseCache.set(document, index)
  return index
}

export interface CollisionOptions {
  /** Supplies decoded geometry per definition; omitted means box-test only. */
  provide?: GeometryProvider
  /** Restrict testing to pairs involving these parts. */
  onlyPartIds?: readonly string[]
}

/**
 * Detects illegal intersections in the document.
 *
 * A pair whose geometry is not resident falls back to the box test with a
 * family-level clearance allowance and reports `unknown` certainty, so a build
 * is never silently declared clean on the strength of a check that did not run.
 */
export function findCollisions(document: ModelDocument, options: CollisionOptions = {}): CollisionContact[] {
  const broadPhase = deriveBroadPhase(document)
  const world = deriveConnections(document)
  const subjects = options.onlyPartIds ?? Object.keys(document.parts)
  const contacts: CollisionContact[] = []
  const tested = new Set<string>()

  for (const partId of subjects) {
    const a = document.parts[partId]
    const boundsA = broadPhase.boundsOf(partId)
    if (!a || !boundsA) continue

    for (const otherId of broadPhase.neighbours(partId)) {
      const pairKey = partId < otherId ? `${partId}|${otherId}` : `${otherId}|${partId}`
      if (tested.has(pairKey)) continue
      tested.add(pairKey)

      const b = document.parts[otherId]
      const boundsB = broadPhase.boundsOf(otherId)
      if (!b || !boundsB) continue

      const overlap = boxOverlap(boundsA, boundsB)
      if (!overlap.every((amount) => amount > 0.01)) continue

      const mated = world.pairsByParts.get(pairKey) ?? []

      // Mated connectors explain a bounded amount of overlap. Anything the
      // allowance covers is legal and needs no further checking.
      const allowance = matingAllowance(mated)
      if (allowance !== null && Math.min(...overlap) <= allowance) continue

      if (options.provide) {
        const confirmed = confirmSurfaceContact(a, b, options.provide)
        if (confirmed.status === 'clean') continue
        if (confirmed.status === 'contact') {
          contacts.push({
            partA: a.id,
            partB: b.id,
            certainty: mated.length ? 'clearance-subtracted' : 'exact',
            pointLdu: confirmed.pointLdu,
            overlapLdu: overlap,
          })
          continue
        }
        // 'unavailable' falls through to the box verdict below.
      }

      contacts.push({ partA: a.id, partB: b.id, certainty: 'unknown', overlapLdu: overlap })
    }
  }
  return contacts
}

/** Stud engagement depth: a stacked brick legitimately overlaps by one stud. */
const STUD_CLEARANCE_LDU = 4.05

/** Allowance for connectors that insert deeply, pending measured volumes. */
const INSERTED_CLEARANCE_LDU = 26

/**
 * Families whose parts genuinely interpenetrate when correctly assembled.
 *
 * A pin sits inside a hole, a bar inside a clip, a ball inside a socket — and
 * hinge halves interleave their fingers, so two correctly hinged parts share a
 * substantial bounding volume. Each gets the generous allowance below rather
 * than the stud-height one.
 */
const INSERTED_FAMILIES: ReadonlySet<ConnectionFamily> = new Set<ConnectionFamily>([
  'pin',
  'pin-hole',
  'axle',
  'axle-hole',
  'bar',
  'clip',
  'ball',
  'socket',
  'hinge',
  // LDCad's catch-all snap marks a part that *seats into* another — a pane in a
  // window frame, a screen in a bezel. Those sit wholly inside the host's
  // bounding volume, so the stud-height allowance is nowhere near enough and a
  // correctly glazed window would be reported as a collision.
  'generic',
])

/**
 * Overlap depth a pair's mated connectors legitimately explain, or null when the
 * pair has no connection and therefore no allowance at all.
 */
function matingAllowance(mated: readonly MatedPair[]): number | null {
  if (!mated.length) return null
  const inserted = mated.some(
    (pair) => INSERTED_FAMILIES.has(pair.a.family) || INSERTED_FAMILIES.has(pair.b.family),
  )
  return inserted ? INSERTED_CLEARANCE_LDU : STUD_CLEARANCE_LDU
}

/**
 * Reads geometry out of the runtime cache.
 *
 * Returns null for a part whose mesh has not streamed in yet, which the caller
 * reports as `unknown` certainty rather than as a clean pass.
 */
export const residentGeometryProvider: GeometryProvider = (definitionId) => {
  const definition = catalog.get(definitionId)
  if (!definition) return null
  return geometryCache.get(definition)?.surface ?? null
}

/**
 * Builds a THREE geometry from raw compiled arrays, for tests and workers.
 * Normals are required: the collision inset is applied along them.
 */
export function geometryFromArrays(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  return geometry
}

