import { catalog, STUD_LDU } from './catalog'
import { applyMatrix, distance, eulerToMatrix, IDENTITY_MATRIX, multiplyMatrix, type Matrix3 } from './math'
import type { ConnectionFamily, ConnectionFeature, ModelDocument, PartInstance, Transform, Vec3 } from './types'

export interface WorldConnectionFeature {
  id: string
  partId: string
  definitionId: string
  family: ConnectionFamily
  gender: ConnectionFeature['gender']
  group?: string
  position: Vec3
  /** Connector frame in model space, for orientation-aware matching. */
  orientation: Matrix3
  src: string
}

export interface SnapCandidate {
  movingPartId: string
  movingFeatureId: string
  targetPartId: string
  targetFeatureId: string
  transform: Transform
  distanceLdu: number
  simultaneousMatches: number
  score: number
}

/**
 * Which connector families can physically mate. Gender must oppose, and for
 * `generic` connectors LDCad's group name must also match, because a generic
 * connector's group is the only thing distinguishing, say, a turntable
 * interface from a door hinge of similar dimensions.
 */
const COMPATIBLE_PAIRS = new Set([
  'anti-stud:stud',
  'axle:axle-hole',
  'ball:socket',
  'bar:clip',
  'hinge:hinge',
  'pin:pin-hole',
  'generic:generic',
])

type AnyFeature = Pick<WorldConnectionFeature, 'family' | 'gender' | 'group'>

export function connectorsCompatible(a: AnyFeature, b: AnyFeature): boolean {
  if (a.gender === b.gender && a.gender !== 'neutral') return false
  const key = [a.family, b.family].sort().join(':')
  if (!COMPATIBLE_PAIRS.has(key)) return false
  if (a.family === 'generic' || b.family === 'generic') return Boolean(a.group) && a.group === b.group
  return true
}

/** Exclusive connectors accept exactly one mate; a stud cannot serve two parts. */
const EXCLUSIVE: ReadonlySet<ConnectionFamily> = new Set<ConnectionFamily>([
  'stud',
  'anti-stud',
  'pin',
  'pin-hole',
  'axle-hole',
  'clip',
  'ball',
  'socket',
])

const CONTACT_TOLERANCE_LDU = 0.75

/** Transforms a part's compiled connectors into model space. */
export function getWorldConnectors(
  part: PartInstance,
  transform: Transform = part.transform,
): WorldConnectionFeature[] {
  const definition = catalog.get(part.definitionId)
  if (!definition) return []
  const matrix = eulerToMatrix(transform.rotation)
  return definition.connectors.map((feature) => {
    const offset = applyMatrix(matrix, feature.pos)
    return {
      id: feature.id,
      partId: part.id,
      definitionId: part.definitionId,
      family: feature.family,
      gender: feature.gender,
      group: feature.group,
      position: [
        transform.position[0] + offset[0],
        transform.position[1] + offset[1],
        transform.position[2] + offset[2],
      ] as Vec3,
      orientation: feature.ori ? multiplyMatrix(matrix, feature.ori as Matrix3) : matrix,
      src: feature.src,
    }
  })
}

const cellKey = (position: Vec3, cellSize: number) =>
  `${Math.floor(position[0] / cellSize)}:${Math.floor(position[1] / cellSize)}:${Math.floor(position[2] / cellSize)}`

/**
 * Uniform spatial hash over model-space connectors.
 *
 * A one-stud cell (20 LDU) matches LDraw's horizontal pitch, so a drag query
 * touches a handful of cells regardless of how large the model is.
 */
export class ConnectorSpatialIndex {
  private cells = new Map<string, WorldConnectionFeature[]>()

  constructor(private cellSize = STUD_LDU) {}

  insert(feature: WorldConnectionFeature) {
    const key = cellKey(feature.position, this.cellSize)
    const entries = this.cells.get(key)
    if (entries) entries.push(feature)
    else this.cells.set(key, [feature])
  }

  insertDocument(document: ModelDocument, excludedPartIds: Set<string> = new Set()) {
    for (const part of Object.values(document.parts)) {
      if (excludedPartIds.has(part.id)) continue
      for (const feature of getWorldConnectors(part)) this.insert(feature)
    }
  }

  query(position: Vec3, radius = STUD_LDU): WorldConnectionFeature[] {
    const reach = Math.ceil(radius / this.cellSize)
    const base = [
      Math.floor(position[0] / this.cellSize),
      Math.floor(position[1] / this.cellSize),
      Math.floor(position[2] / this.cellSize),
    ]
    const result: WorldConnectionFeature[] = []
    for (let x = base[0] - reach; x <= base[0] + reach; x += 1) {
      for (let y = base[1] - reach; y <= base[1] + reach; y += 1) {
        for (let z = base[2] - reach; z <= base[2] + reach; z += 1) {
          const bucket = this.cells.get(`${x}:${y}:${z}`)
          if (bucket) {
            for (const feature of bucket) {
              if (distance(feature.position, position) <= radius) result.push(feature)
            }
          }
        }
      }
    }
    return result
  }

  get size(): number {
    let total = 0
    for (const bucket of this.cells.values()) total += bucket.length
    return total
  }
}

/**
 * Connectors already consumed by a committed mate.
 *
 * Two exclusive connectors sitting at the same point are, physically, a used
 * joint. Treating them as occupied is what stops the solver proposing a stud
 * that already has a brick on it.
 */
export function computeOccupancy(document: ModelDocument, excludedPartIds: Set<string> = new Set()): Set<string> {
  const index = new ConnectorSpatialIndex()
  const all: WorldConnectionFeature[] = []
  for (const part of Object.values(document.parts)) {
    if (excludedPartIds.has(part.id)) continue
    for (const feature of getWorldConnectors(part)) {
      index.insert(feature)
      all.push(feature)
    }
  }
  const occupied = new Set<string>()
  for (const feature of all) {
    if (!EXCLUSIVE.has(feature.family)) continue
    for (const nearby of index.query(feature.position, CONTACT_TOLERANCE_LDU)) {
      if (nearby.partId === feature.partId) continue
      if (connectorsCompatible(feature, nearby)) {
        occupied.add(`${feature.partId}/${feature.id}`)
        break
      }
    }
  }
  return occupied
}

export interface SnapSolverOptions {
  radiusLdu?: number
  targetPartIds?: string[]
  /** Restrict which connector on the moving part may be used (Connect tool). */
  movingFeatureId?: string
  /** Restrict which connector on the target may be used (Connect tool). */
  targetFeatureId?: string
  maxCandidates?: number
}

/**
 * Finds rigid placements that mate a connector on the moving part with a
 * compatible connector already in the model.
 *
 * Candidates are generated by translation only: the moving part keeps its
 * orientation, and the primary connector pair is brought into coincidence. Each
 * candidate is then rescanned for *additional* simultaneous matches, which is
 * what makes a 2×4 brick settle into the obvious four-stud position instead of
 * balancing on a single stud.
 */
export function findSnapCandidates(
  movingPart: PartInstance,
  document: ModelDocument,
  proposedTransform: Transform,
  options: SnapSolverOptions = {},
): SnapCandidate[] {
  const radius = options.radiusLdu ?? 14
  const maxCandidates = options.maxCandidates ?? 32
  const targetIds = options.targetPartIds ? new Set(options.targetPartIds) : undefined
  const excluded = new Set([movingPart.id])

  const index = new ConnectorSpatialIndex()
  for (const part of Object.values(document.parts)) {
    if (part.id === movingPart.id || (targetIds && !targetIds.has(part.id))) continue
    for (const feature of getWorldConnectors(part)) index.insert(feature)
  }
  const occupied = computeOccupancy(document, excluded)

  const movingFeatures = getWorldConnectors(movingPart, proposedTransform).filter(
    (feature) => !options.movingFeatureId || feature.id === options.movingFeatureId,
  )

  const candidates: SnapCandidate[] = []
  const seen = new Set<string>()

  for (const movingFeature of movingFeatures) {
    for (const target of index.query(movingFeature.position, radius)) {
      if (options.targetFeatureId && target.id !== options.targetFeatureId) continue
      if (!connectorsCompatible(movingFeature, target)) continue
      if (EXCLUSIVE.has(target.family) && occupied.has(`${target.partId}/${target.id}`)) continue

      const transform: Transform = {
        position: [
          proposedTransform.position[0] + (target.position[0] - movingFeature.position[0]),
          proposedTransform.position[1] + (target.position[1] - movingFeature.position[1]),
          proposedTransform.position[2] + (target.position[2] - movingFeature.position[2]),
        ],
        rotation: proposedTransform.rotation,
      }
      const key = transform.position.map((value) => Math.round(value * 100)).join(':')
      if (seen.has(key)) continue
      seen.add(key)

      let simultaneousMatches = 0
      for (const transformed of getWorldConnectors(movingPart, transform)) {
        const mate = index
          .query(transformed.position, CONTACT_TOLERANCE_LDU)
          .find((nearby) => connectorsCompatible(transformed, nearby) && !occupied.has(`${nearby.partId}/${nearby.id}`))
        if (mate) simultaneousMatches += 1
      }

      const distanceLdu = distance(movingFeature.position, target.position)
      candidates.push({
        movingPartId: movingPart.id,
        movingFeatureId: movingFeature.id,
        targetPartId: target.partId,
        targetFeatureId: target.id,
        transform,
        distanceLdu,
        simultaneousMatches,
        // A placement that engages more connectors is physically better held;
        // distance only breaks ties between equally-connected candidates.
        score: simultaneousMatches * 100 - distanceLdu * 2,
      })
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.distanceLdu - b.distanceLdu)
    .slice(0, maxCandidates)
}

export function bestSnapTransform(
  movingPart: PartInstance,
  document: ModelDocument,
  proposedTransform: Transform,
  options?: SnapSolverOptions,
): Transform | null {
  return findSnapCandidates(movingPart, document, proposedTransform, options)[0]?.transform ?? null
}

export const CONNECTOR_IDENTITY_ORIENTATION = IDENTITY_MATRIX
