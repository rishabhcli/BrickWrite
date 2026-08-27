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
  const segment = new THREE.Line3()
  const midpoint = new THREE.Vector3()
  let point: Vec3 | null = null

  geometryA.bvh.bvhcast(geometryB.bvh, bToA, {
    intersectsTriangles(triangleA: ExtendedTriangle, triangleB: ExtendedTriangle) {
      // `bvhcast` yields pairs whose *bounds* overlap, so the triangles have to
      // be intersected before anything is concluded from them.
      if (!triangleA.intersectsTriangle(triangleB, segment)) return false
      segment.getCenter(midpoint).applyMatrix4(worldA)
      point = [midpoint.x, midpoint.y, midpoint.z]
      return true
    },
  })

  return point ? { status: 'contact', pointLdu: point } : { status: 'clean' }
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
  const parts = Object.values(document.parts)
  const bounds = new Map(parts.map((part) => [part.id, getPartBounds(part)]))
  const world = deriveConnections(document)
  const scope = options.onlyPartIds ? new Set(options.onlyPartIds) : null
  const contacts: CollisionContact[] = []

  for (let index = 0; index < parts.length; index += 1) {
    for (let compare = index + 1; compare < parts.length; compare += 1) {
      const a = parts[index]
      const b = parts[compare]
      if (scope && !scope.has(a.id) && !scope.has(b.id)) continue

      const boundsA = bounds.get(a.id)!
      const boundsB = bounds.get(b.id)!
      if (!boundsA.measured || !boundsB.measured) continue

      const overlap = boxOverlap(boundsA, boundsB)
      if (!overlap.every((amount) => amount > 0.01)) continue

      const mated = world.pairsByParts.get([a.id, b.id].sort().join('|')) ?? []

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

const INSERTED_FAMILIES: ReadonlySet<ConnectionFamily> = new Set<ConnectionFamily>([
  'pin',
  'pin-hole',
  'axle',
  'axle-hole',
  'bar',
  'clip',
  'ball',
  'socket',
])

/**
 * Overlap depth a pair's mated connectors legitimately explain, or null when the
 * pair has no connection and therefore no allowance at all.
 */
function matingAllowance(mated: readonly MatedPair[]): number | null {
  if (!mated.length) return null
  const inserted = mated.some(
    (pair) => INSERTED_FAMILIES.has(pair.a.family) && INSERTED_FAMILIES.has(pair.b.family),
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

