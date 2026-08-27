import { catalog, STUD_LDU } from './catalog'
import {
  axialSeparation,
  connectorsCompatible,
  enumerateMatings,
  featureFrame,
  isExclusiveFamily,
  jointFor,
  type MatingSolution,
} from './connections'
import {
  composeTransform,
  distance,
  dotVec,
  invertTransform,
  multiplyMat3,
  poseDistance,
  transposeMat3,
  type Mat3,
  type RigidTransform,
  type Vec3,
} from './math'
import type { ConnectionFamily, ConnectionFeature, ModelDocument, PartInstance } from './types'

export interface WorldConnector {
  readonly id: string
  readonly partId: string
  readonly definitionId: string
  readonly family: ConnectionFamily
  readonly gender: ConnectionFeature['gender']
  readonly group?: string
  /** Connector frame in document space. */
  readonly frame: RigidTransform
  /** Cached world-space connector axis (frame local +Y). */
  readonly axis: Vec3
  readonly feature: ConnectionFeature
}

export interface ConnectionMatch {
  readonly movingFeatureId: string
  readonly targetPartId: string
  readonly targetFeatureId: string
  readonly family: ConnectionFamily
}

export interface SnapCandidate {
  readonly movingPartId: string
  readonly movingFeatureId: string
  readonly targetPartId: string
  readonly targetFeatureId: string
  /** Full 6-DOF pose, including orientation. */
  readonly transform: RigidTransform
  readonly matches: readonly ConnectionMatch[]
  readonly simultaneousMatches: number
  readonly angleDegrees: number
  readonly offsetLdu: number
  readonly flipped: boolean
  readonly certainty: MatingSolution['certainty']
  readonly cursorTranslationLdu: number
  readonly cursorRotationDeg: number
  readonly score: number
}

/** Coincidence tolerance for two connector frames, in LDU. */
const CONTACT_TOLERANCE_LDU = 0.75

/** Axis alignment tolerance as a dot product; ~2.5° of slop. */
const AXIS_TOLERANCE = 0.999

const SCORE_WEIGHTS = {
  connection: 100,
  translation: 1.5,
  rotation: 20,
  certainty: { exact: 2, chosen: 0, unknown: -5 },
} as const

const worldAxis = (frame: RigidTransform): Vec3 => [frame.basis[1], frame.basis[4], frame.basis[7]]

/** Transforms one part's compiled connectors into document space. */
export function getWorldConnectors(
  part: PartInstance,
  transform: RigidTransform = part.transform,
): WorldConnector[] {
  const definition = catalog.get(part.definitionId)
  if (!definition) return []
  return definition.connectors.map((feature) => {
    const frame = composeTransform(transform, featureFrame(feature))
    return {
      id: feature.id,
      partId: part.id,
      definitionId: part.definitionId,
      family: feature.family,
      gender: feature.gender,
      group: feature.group,
      frame,
      axis: worldAxis(frame),
      feature,
    }
  })
}

/**
 * Whether two world connector frames are actually mated.
 *
 * Positions must coincide *and* the axes must be parallel. Requiring axis
 * alignment is what stops a stud pointing sideways from counting as mated with
 * an anti-stud it merely passes through. Rotation *about* the shared axis is
 * ignored, because that is precisely the freedom the joint retains.
 */
export function framesMate(a: WorldConnector, b: WorldConnector): boolean {
  if (distance(a.frame.position, b.frame.position) > CONTACT_TOLERANCE_LDU) return false
  const alignment = dotVec(a.axis, b.axis)
  const joint = jointFor(a.feature, b.feature)
  const antiparallelAllowed =
    joint.kind === 'cylindrical' || (joint.kind === 'revolute' && joint.continuous) || joint.kind === 'spherical'
  return alignment >= AXIS_TOLERANCE || (antiparallelAllowed && alignment <= -AXIS_TOLERANCE)
}

const cellKey = (position: Vec3, size: number) =>
  `${Math.floor(position[0] / size)}:${Math.floor(position[1] / size)}:${Math.floor(position[2] / size)}`

/**
 * Uniform spatial hash over document-space connectors.
 *
 * A one-stud cell matches LDraw's horizontal pitch, so a drag query touches a
 * handful of cells regardless of model size.
 */
export class ConnectorSpatialIndex {
  private cells = new Map<string, WorldConnector[]>()
  private partCells = new Map<string, Set<string>>()
  private total = 0

  constructor(private readonly cellSize = STUD_LDU) {}

  insert(connector: WorldConnector) {
    const key = cellKey(connector.frame.position, this.cellSize)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(connector)
    else this.cells.set(key, [connector])
    // Cells are tracked per part so a part can be withdrawn without rescanning
    // the whole index, which is what makes incremental maintenance possible.
    const owned = this.partCells.get(connector.partId)
    if (owned) owned.add(key)
    else this.partCells.set(connector.partId, new Set([key]))
    this.total += 1
  }

  /** Withdraws every connector belonging to one part. */
  removePart(partId: string) {
    const owned = this.partCells.get(partId)
    if (!owned) return
    for (const key of owned) {
      const bucket = this.cells.get(key)
      if (!bucket) continue
      const kept = bucket.filter((connector) => connector.partId !== partId)
      this.total -= bucket.length - kept.length
      if (kept.length) this.cells.set(key, kept)
      else this.cells.delete(key)
    }
    this.partCells.delete(partId)
  }

  has(partId: string): boolean {
    return this.partCells.has(partId)
  }

  insertDocument(document: ModelDocument, excludedPartIds: ReadonlySet<string> = new Set()) {
    for (const part of Object.values(document.parts)) {
      if (excludedPartIds.has(part.id)) continue
      for (const connector of getWorldConnectors(part)) this.insert(connector)
    }
  }

  query(position: Vec3, radius = STUD_LDU): WorldConnector[] {
    const reach = Math.ceil(radius / this.cellSize)
    const base = [
      Math.floor(position[0] / this.cellSize),
      Math.floor(position[1] / this.cellSize),
      Math.floor(position[2] / this.cellSize),
    ]
    const result: WorldConnector[] = []
    for (let x = base[0] - reach; x <= base[0] + reach; x += 1) {
      for (let y = base[1] - reach; y <= base[1] + reach; y += 1) {
        for (let z = base[2] - reach; z <= base[2] + reach; z += 1) {
          const bucket = this.cells.get(`${x}:${y}:${z}`)
          if (!bucket) continue
          for (const connector of bucket) {
            if (distance(connector.frame.position, position) <= radius) result.push(connector)
          }
        }
      }
    }
    return result
  }

  get size(): number {
    return this.total
  }
}

export interface MatedPair {
  readonly a: WorldConnector
  readonly b: WorldConnector
}

export interface DerivedConnections {
  readonly index: ConnectorSpatialIndex
  readonly connectors: readonly WorldConnector[]
  /** `partId/featureId` of every exclusive connector already carrying a mate. */
  readonly occupied: ReadonlySet<string>
  readonly pairs: readonly MatedPair[]
  /** Mated pairs keyed by the sorted part-id pair, for collision clearance. */
  readonly pairsByParts: ReadonlyMap<string, readonly MatedPair[]>
}

/**
 * Per-revision derived connection state, memoized on document identity.
 *
 * The engine treats documents as immutable per revision, so keying a WeakMap on
 * the document object gives correct reuse across the many consumers that ask
 * for the same derived state — solver, validation, viewport — without any of
 * them recomputing it, and without a manual invalidation path to get wrong.
 */
const derivedCache = new WeakMap<ModelDocument, DerivedConnections>()

export function deriveConnections(document: ModelDocument): DerivedConnections {
  const cached = derivedCache.get(document)
  if (cached) return cached

  const index = new ConnectorSpatialIndex()
  const connectors: WorldConnector[] = []
  for (const part of Object.values(document.parts)) {
    for (const connector of getWorldConnectors(part)) {
      index.insert(connector)
      connectors.push(connector)
    }
  }

  const occupied = new Set<string>()
  const pairs: MatedPair[] = []
  const pairsByParts = new Map<string, MatedPair[]>()
  const seen = new Set<string>()

  for (const connector of connectors) {
    for (const other of index.query(connector.frame.position, CONTACT_TOLERANCE_LDU)) {
      if (other.partId === connector.partId) continue
      if (!connectorsCompatible(connector, other)) continue
      if (!framesMate(connector, other)) continue

      const key = [`${connector.partId}/${connector.id}`, `${other.partId}/${other.id}`].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)

      if (isExclusiveFamily(connector.family)) occupied.add(`${connector.partId}/${connector.id}`)
      if (isExclusiveFamily(other.family)) occupied.add(`${other.partId}/${other.id}`)

      const pair: MatedPair = { a: connector, b: other }
      pairs.push(pair)
      const partKey = [connector.partId, other.partId].sort().join('|')
      const bucket = pairsByParts.get(partKey)
      if (bucket) bucket.push(pair)
      else pairsByParts.set(partKey, [pair])
    }
  }

  const derived: DerivedConnections = { index, connectors, occupied, pairs, pairsByParts }
  derivedCache.set(document, derived)
  return derived
}

export interface SnapSolverOptions {
  radiusLdu?: number
  targetPartIds?: readonly string[]
  /** Restrict the moving side to one connector (Connect tool). */
  movingFeatureId?: string
  /** Restrict the target side to one connector (Connect tool). */
  targetFeatureId?: string
  maxCandidates?: number
}

/**
 * Solves full poses that mate a connector on the moving part with a compatible
 * connector already in the model.
 *
 * For a moving connector frame `Fm`, a target part `Tt` with connector frame
 * `Ft`, and a mating transform `C` drawn from the pair's retained freedom:
 *
 *     Tm = Tt · Ft · C · Fm⁻¹
 *
 * Because `Ft` and `Fm` carry orientation, this yields translation *and*
 * rotation together. Studs-not-on-top, Technic pins at right angles and hinge
 * halves all fall out of the same expression as ordinary stacking.
 *
 * Each candidate pose is then rescanned for additional simultaneous mates,
 * which is what makes a 2×4 brick settle into the obvious eight-stud placement
 * rather than balancing on one.
 */
export function findSnapCandidates(
  movingPart: PartInstance,
  document: ModelDocument,
  cursorTransform: RigidTransform,
  options: SnapSolverOptions = {},
): SnapCandidate[] {
  const radius = options.radiusLdu ?? 14
  const maxCandidates = options.maxCandidates ?? 24
  const definition = catalog.get(movingPart.definitionId)
  if (!definition) return []

  const world = deriveConnections(document)
  const targetFilter = options.targetPartIds ? new Set(options.targetPartIds) : undefined

  const movingFeatures = definition.connectors.filter(
    (feature) => !options.movingFeatureId || feature.id === options.movingFeatureId,
  )

  // Targets are gathered once, around the part's cursor-space centre, with the
  // radius widened by the part's own reach. Querying per connector instead would
  // make discovery depend on the cursor's *orientation*: a brick dragged to the
  // right spot but not yet rotated has its anti-stud 24 LDU the wrong way, which
  // would hide every studs-not-on-top target that the solver is meant to find.
  const localBounds = definition.dimensions?.bounds
  const centreLocal: Vec3 = localBounds
    ? [
        (localBounds.min[0] + localBounds.max[0]) / 2,
        (localBounds.min[1] + localBounds.max[1]) / 2,
        (localBounds.min[2] + localBounds.max[2]) / 2,
      ]
    : [0, 0, 0]
  const reach = localBounds
    ? Math.hypot(
        (localBounds.max[0] - localBounds.min[0]) / 2,
        (localBounds.max[1] - localBounds.min[1]) / 2,
        (localBounds.max[2] - localBounds.min[2]) / 2,
      )
    : 0
  const searchCentre = composeTransform(cursorTransform, { position: centreLocal, basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position
  const targets = world.index.query(searchCentre, radius + reach)

  const candidates: SnapCandidate[] = []
  const seenPoses = new Set<string>()

  for (const movingFeature of movingFeatures) {
    const localFrame = featureFrame(movingFeature)
    const inverseLocalFrame = invertTransform(localFrame)
    const cursorFeatureFrame = composeTransform(cursorTransform, localFrame)

    for (const target of targets) {
      if (target.partId === movingPart.id) continue
      if (targetFilter && !targetFilter.has(target.partId)) continue
      if (options.targetFeatureId && target.id !== options.targetFeatureId) continue
      if (!connectorsCompatible(movingFeature, target)) continue
      if (isExclusiveFamily(target.family) && world.occupied.has(`${target.partId}/${target.id}`)) continue

      // Operator intent, expressed in the target connector's frame, so the free
      // parameter of a continuous joint can be resolved analytically.
      const desiredRelativeBasis = multiplyMat3(
        transposeMat3(target.frame.basis),
        cursorFeatureFrame.basis,
      ) as Mat3
      const desiredOffsetLdu = axialSeparation(target.frame, cursorFeatureFrame)

      for (const solution of enumerateMatings(movingFeature, target.feature, {
        desiredRelativeBasis,
        desiredOffsetLdu,
      })) {
        // target.frame is already Tt · Ft, so this is Tt · Ft · C · Fm⁻¹.
        const transform = composeTransform(
          composeTransform(target.frame, solution.mating),
          inverseLocalFrame,
        )

        const poseKey = [
          ...transform.position.map((value) => Math.round(value * 1e4)),
          ...transform.basis.map((value) => Math.round(value * 1e4)),
        ].join(',')
        if (seenPoses.has(poseKey)) continue
        seenPoses.add(poseKey)

        const matches = findSimultaneousMates(movingPart, transform, world)
        if (matches === null) continue // exclusive conflict

        const cursorError = poseDistance(transform, cursorTransform)
        const score =
          matches.length * SCORE_WEIGHTS.connection -
          cursorError.translationLdu * SCORE_WEIGHTS.translation -
          cursorError.rotationRad * SCORE_WEIGHTS.rotation +
          SCORE_WEIGHTS.certainty[solution.certainty]

        candidates.push({
          movingPartId: movingPart.id,
          movingFeatureId: movingFeature.id,
          targetPartId: target.partId,
          targetFeatureId: target.id,
          transform,
          matches,
          simultaneousMatches: matches.length,
          angleDegrees: solution.angleDegrees,
          offsetLdu: solution.offsetLdu,
          flipped: solution.flipped,
          certainty: solution.certainty,
          cursorTranslationLdu: Number(cursorError.translationLdu.toFixed(4)),
          cursorRotationDeg: Number(((cursorError.rotationRad * 180) / Math.PI).toFixed(3)),
          score,
        })
      }
    }
  }

  return candidates
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.cursorTranslationLdu - b.cursorTranslationLdu ||
        a.movingFeatureId.localeCompare(b.movingFeatureId),
    )
    .slice(0, maxCandidates)
}

/**
 * Every connector on the moving part that mates at the given pose.
 *
 * Returns null when two of the moving part's connectors would claim the same
 * exclusive target connector, which is not a physically realizable placement.
 */
export function findSimultaneousMates(
  movingPart: PartInstance,
  transform: RigidTransform,
  world: DerivedConnections,
): ConnectionMatch[] | null {
  const matches: ConnectionMatch[] = []
  const claimed = new Set<string>()

  for (const moving of getWorldConnectors(movingPart, transform)) {
    for (const target of world.index.query(moving.frame.position, CONTACT_TOLERANCE_LDU)) {
      if (target.partId === movingPart.id) continue
      if (!connectorsCompatible(moving, target)) continue
      if (!framesMate(moving, target)) continue
      const key = `${target.partId}/${target.id}`
      if (isExclusiveFamily(target.family)) {
        if (world.occupied.has(key)) continue
        if (claimed.has(key)) return null
        claimed.add(key)
      }
      matches.push({
        movingFeatureId: moving.id,
        targetPartId: target.partId,
        targetFeatureId: target.id,
        family: moving.family,
      })
      break
    }
  }
  return matches
}

export function bestSnapTransform(
  movingPart: PartInstance,
  document: ModelDocument,
  cursorTransform: RigidTransform,
  options?: SnapSolverOptions,
): RigidTransform | null {
  return findSnapCandidates(movingPart, document, cursorTransform, options)[0]?.transform ?? null
}

/** Connector occupancy for the current document, exposed for inspection tools. */
export const computeOccupancy = (document: ModelDocument): ReadonlySet<string> =>
  deriveConnections(document).occupied

export { connectorsCompatible } from './connections'

/**
 * Connector index maintained across revisions.
 *
 * `deriveConnections` rebuilds everything for a given document, which is right
 * for a one-off read but wrong on the commit path: rebuilding the whole index
 * for every edit makes commit cost scale with model size. This keeps one index
 * alive and withdraws-and-reinserts only the parts an edit touched, so a commit
 * costs what the edit costs.
 *
 * It is deliberately *not* the source of truth for the connection graph. The
 * document's persisted edges are, and a test asserts the two agree after a run
 * of edits, so an incremental bug cannot quietly diverge from reality.
 */
export class IncrementalConnectorWorld {
  private index = new ConnectorSpatialIndex()
  private tracked = new Set<string>()

  /** Brings the index in line with `document`, updating only what changed. */
  sync(document: ModelDocument, touchedPartIds?: readonly string[]) {
    if (!touchedPartIds) {
      this.index = new ConnectorSpatialIndex()
      this.tracked = new Set()
      for (const part of Object.values(document.parts)) this.add(part)
      return
    }
    for (const partId of touchedPartIds) {
      if (this.tracked.has(partId)) {
        this.index.removePart(partId)
        this.tracked.delete(partId)
      }
      const part = document.parts[partId]
      if (part) this.add(part)
    }
  }

  private add(part: PartInstance) {
    for (const connector of getWorldConnectors(part)) this.index.insert(connector)
    this.tracked.add(part.id)
  }

  /** Mated connector pairs involving `partId`, against everything else indexed. */
  matesFor(partId: string, document: ModelDocument): MatedPair[] {
    const part = document.parts[partId]
    if (!part) return []
    const pairs: MatedPair[] = []
    const seen = new Set<string>()
    for (const moving of getWorldConnectors(part)) {
      for (const other of this.index.query(moving.frame.position, CONTACT_TOLERANCE_LDU)) {
        if (other.partId === partId) continue
        if (!connectorsCompatible(moving, other)) continue
        if (!framesMate(moving, other)) continue
        const key = [`${moving.partId}/${moving.id}`, `${other.partId}/${other.id}`].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push({ a: moving, b: other })
      }
    }
    return pairs
  }

  get size(): number {
    return this.index.size
  }
}
