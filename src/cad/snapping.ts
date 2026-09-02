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
import { nearbyParts } from './geometry'
import type {
  ConnectionEdge,
  ConnectionFamily,
  ConnectionFeature,
  JointFreedom,
  ModelDocument,
  PartInstance,
} from './types'

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

/**
 * A placed part's connectors in document space, memoized on part identity.
 *
 * The kernel treats a `PartInstance` as immutable — every mutation goes through
 * `applyMutations`, which returns a new object and shares the untouched ones by
 * reference — so a part's world connectors are a pure function of the object and
 * a `WeakMap` on it is exactly as safe as the `deriveConnections` memo it feeds.
 *
 * It is what makes a *fresh document* cheap. Every commit produces a new
 * document object, which misses the `deriveConnections` memo and rebuilds the
 * whole connector world; but 11,492 of the 11,493 part objects in it are the
 * same objects as before, so all but the edited part's connectors are already
 * computed. Measured on the campus demo: the connector-and-index build inside
 * `deriveConnections` drops from 34.2 ms to 8.7 ms, and the returned arrays are
 * read-only for every consumer, so sharing them is not observable.
 *
 * Only the default pose is memoized. `findSimultaneousMates` asks for a
 * *candidate* transform, which is not the part's own and must not be cached
 * against it.
 */
const worldConnectorCache = new WeakMap<PartInstance, WorldConnector[]>()

export function getWorldConnectors(
  part: PartInstance,
  transform: RigidTransform = part.transform,
): WorldConnector[] {
  const memoizable = transform === part.transform
  if (memoizable) {
    const cached = worldConnectorCache.get(part)
    if (cached) return cached
  }
  const definition = catalog.get(part.definitionId)
  if (!definition) return []
  const connectors = definition.connectors.map((feature) => {
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
  if (memoizable) worldConnectorCache.set(part, connectors)
  return connectors
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
  // Aligned axes mate whatever the joint is, and only the antiparallel case
  // needs to know which joint it would be, so the freedom is derived on the
  // branch that actually reads it. Every ordinary stud stack takes the first
  // return, which is the overwhelming majority of the mates in a model.
  if (alignment >= AXIS_TOLERANCE) return true
  if (alignment > -AXIS_TOLERANCE) return false
  const joint = jointFor(a.feature, b.feature)
  return joint.kind === 'cylindrical' || (joint.kind === 'revolute' && joint.continuous) || joint.kind === 'spherical'
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

  /**
   * Connectors within `radius` of a point.
   *
   * The cell range comes from the query *box*, not from a symmetric
   * `±ceil(radius / cellSize)` reach. A connector within `radius` differs by at
   * most `radius` on every axis, so it can only sit in a cell whose index lies
   * between `floor((p − r) / size)` and `floor((p + r) / size)` — the same
   * answer, from far fewer buckets, in the same ascending order.
   *
   * The old reach rule rounded any radius up to a whole cell and then swept
   * symmetrically, so the 0.75-LDU contact query that `deriveConnections` runs
   * once per connector always visited 3³ = 27 cells to find candidates that in
   * all but a boundary case live in exactly one. Measured over the 11,493-part
   * campus demo: 2,117,826 cell visits against 94,722, a 22× reduction, and it
   * is 27 template-string keys per query that are not built.
   */
  query(position: Vec3, radius = STUD_LDU): WorldConnector[] {
    const size = this.cellSize
    const lowX = Math.floor((position[0] - radius) / size)
    const highX = Math.floor((position[0] + radius) / size)
    const lowY = Math.floor((position[1] - radius) / size)
    const highY = Math.floor((position[1] + radius) / size)
    const lowZ = Math.floor((position[2] - radius) / size)
    const highZ = Math.floor((position[2] + radius) / size)
    const result: WorldConnector[] = []
    for (let x = lowX; x <= highX; x += 1) {
      for (let y = lowY; y <= highY; y += 1) {
        for (let z = lowZ; z <= highZ; z += 1) {
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
 *
 * That immutability is a real requirement, not an incidental property: mutating
 * a document's parts in place after it has been derived from will read the stale
 * derivation. Every kernel mutation goes through `applyMutations`, which returns
 * a new object, so production code cannot violate it.
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

  // Endpoint keys are built once per connector rather than once per candidate,
  // and the canonical pair key is ordered by comparison instead of by
  // `[a, b].sort().join(…)`, which allocates a two-element array per candidate.
  // The scan sees 131,432 candidates on the campus demo, so both are per-pair
  // allocations in the innermost loop of the most expensive derived value the
  // kernel has.
  for (const connector of connectors) {
    const selfKey = `${connector.partId}/${connector.id}`
    for (const other of index.query(connector.frame.position, CONTACT_TOLERANCE_LDU)) {
      if (other.partId === connector.partId) continue
      if (!connectorsCompatible(connector, other)) continue
      if (!framesMate(connector, other)) continue

      const otherKey = `${other.partId}/${other.id}`
      const key = selfKey < otherKey ? `${selfKey}|${otherKey}` : `${otherKey}|${selfKey}`
      if (seen.has(key)) continue
      seen.add(key)

      if (isExclusiveFamily(connector.family)) occupied.add(selfKey)
      if (isExclusiveFamily(other.family)) occupied.add(otherKey)

      const pair: MatedPair = { a: connector, b: other }
      pairs.push(pair)
      const partKey =
        connector.partId < other.partId
          ? `${connector.partId}|${other.partId}`
          : `${other.partId}|${connector.partId}`
      const bucket = pairsByParts.get(partKey)
      if (bucket) bucket.push(pair)
      else pairsByParts.set(partKey, [pair])
    }
  }

  const derived: DerivedConnections = { index, connectors, occupied, pairs, pairsByParts }
  derivedCache.set(document, derived)
  return derived
}

/** Deterministic id for an edge, from its two endpoints. */
export const connectionEdgeId = (a: string, b: string) => `edge_${[a, b].sort().join('__')}`

/**
 * Connection edges implied by a document's geometry.
 *
 * Shared by the engine, which attributes new edges to a transaction, and by
 * document constructors such as the opening showcase, which have no transaction
 * to attribute them to. Both need the graph to be part of the document rather
 * than something only the engine knows.
 */
/**
 * The freedoms a document asserts, keyed the way edges are.
 *
 * Built once per derivation rather than searched per edge: a model with a
 * thousand connections and three overrides should pay for three, not three
 * thousand lookups. Keying by `connectionEdgeId` gives endpoint-order
 * independence for free, which is the same property the edges themselves rely
 * on.
 */
export function jointOverrideIndex(document: ModelDocument): ReadonlyMap<string, JointFreedom> {
  const index = new Map<string, JointFreedom>()
  for (const override of document.jointOverrides ?? []) {
    index.set(
      connectionEdgeId(`${override.a.partId}/${override.a.featureId}`, `${override.b.partId}/${override.b.featureId}`),
      override.joint,
    )
  }
  return index
}

export function deriveConnectionEdges(
  document: ModelDocument,
  revision: number,
  source: ConnectionEdge['source'],
): Record<string, ConnectionEdge> {
  const edges: Record<string, ConnectionEdge> = {}
  const overrides = jointOverrideIndex(document)
  for (const pair of deriveConnections(document).pairs) {
    const id = connectionEdgeId(`${pair.a.partId}/${pair.a.id}`, `${pair.b.partId}/${pair.b.id}`)
    edges[id] = {
      id,
      a: { partId: pair.a.partId, featureId: pair.a.id },
      b: { partId: pair.b.partId, featureId: pair.b.id },
      family: pair.a.family,
      // An asserted freedom wins over the derived one. Everything else about
      // the edge still comes from geometry — which parts, which connectors,
      // which family — so an override changes what the joint *does*, never
      // whether it exists.
      joint: overrides.get(id) ?? jointFor(pair.a.feature, pair.b.feature),
      createdAtRevision: revision,
      source,
    }
  }
  return edges
}

export interface SnapSolverOptions {
  radiusLdu?: number
  targetPartIds?: readonly string[]
  /** Restrict the moving side to one connector (Connect tool). */
  movingFeatureId?: string
  /** Restrict the target side to one connector (Connect tool). */
  targetFeatureId?: string
  maxCandidates?: number
  /**
   * Drag wants the best seat first. Connect review walks a stud grid in
   * document space, so a huge plate is not truncated to its highest scores.
   */
  order?: 'score' | 'spatial'
}

export function compareSnapSpatially(a: SnapCandidate, b: SnapCandidate): number {
  const pa = a.transform.position
  const pb = b.transform.position
  return (
    pa[0] - pb[0] ||
    pa[2] - pb[2] ||
    pa[1] - pb[1] ||
    a.targetFeatureId.localeCompare(b.targetFeatureId) ||
    a.movingFeatureId.localeCompare(b.movingFeatureId)
  )
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

  const ordered =
    options.order === 'spatial'
      ? candidates.sort(compareSnapSpatially)
      : candidates.sort(
          (a, b) =>
            b.score - a.score ||
            a.cursorTranslationLdu - b.cursorTranslationLdu ||
            a.movingFeatureId.localeCompare(b.movingFeatureId),
        )
  return ordered.slice(0, maxCandidates)
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

/**
 * Mates one part would have at a candidate pose, against everything else where
 * it already is.
 *
 * Moving one part moves nothing else, so the connector index derived for
 * `document` — memoized on its identity, and hot for the document a drag is
 * running against — is already the correct index for every other part. That
 * makes a speculative pose answerable in the moving part's own connector count
 * rather than by deriving a whole connector world for a document that differs
 * from this one by a single transform.
 *
 * This is what the pose gate needs. `poseRefusal` is called once per snap
 * candidate — up to 24 per drag — and each candidate built a fresh preview
 * document and paid a full derivation for it: 130 ms each on the 11,493-part
 * campus demo, so three seconds to filter one drag's candidates.
 */
export function matesForPose(
  document: ModelDocument,
  part: PartInstance,
  transform: RigidTransform = part.transform,
): MatedPair[] {
  const world = deriveConnections(document)
  const pairs: MatedPair[] = []
  const seen = new Set<string>()
  for (const moving of getWorldConnectors(part, transform)) {
    const selfKey = `${moving.partId}/${moving.id}`
    for (const other of world.index.query(moving.frame.position, CONTACT_TOLERANCE_LDU)) {
      if (other.partId === part.id) continue
      if (!connectorsCompatible(moving, other)) continue
      if (!framesMate(moving, other)) continue
      const otherKey = `${other.partId}/${other.id}`
      const key = selfKey < otherKey ? `${selfKey}|${otherKey}` : `${otherKey}|${selfKey}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ a: moving, b: other })
    }
  }
  return pairs
}

/** Mated pairs keyed as `DerivedConnections.pairsByParts` keys them. */
export function matesByPartPair(pairs: readonly MatedPair[]): Map<string, MatedPair[]> {
  const map = new Map<string, MatedPair[]>()
  for (const pair of pairs) {
    const key =
      pair.a.partId < pair.b.partId
        ? `${pair.a.partId}|${pair.b.partId}`
        : `${pair.b.partId}|${pair.a.partId}`
    const bucket = map.get(key)
    if (bucket) bucket.push(pair)
    else map.set(key, [pair])
  }
  return map
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

export interface ConnectorAvailability {
  readonly occupiedExclusive: number
  readonly freeByFamily: Readonly<Record<string, number>>
  readonly approaches: {
    readonly 'on-top': boolean
    readonly underneath: boolean
    readonly beside: boolean
  }
}

/**
 * Which connector families on `partIds` are still free, and which placement
 * faces that implies.
 *
 * An agent that can see "on-top: false" does not try to stack a brick on a
 * tile. Occupied exclusive connectors are counted but not offered as approaches.
 */
export function connectorAvailability(document: ModelDocument, partIds: readonly string[]): ConnectorAvailability {
  const world = deriveConnections(document)
  const subject = new Set(partIds)
  const freeByFamily: Record<string, number> = {}
  let occupiedExclusive = 0
  let freeStuds = 0
  let freeAntiStuds = 0
  let freeSide = 0
  for (const connector of world.connectors) {
    if (!subject.has(connector.partId)) continue
    const key = `${connector.partId}/${connector.id}`
    if (isExclusiveFamily(connector.family) && world.occupied.has(key)) {
      occupiedExclusive += 1
      continue
    }
    freeByFamily[connector.family] = (freeByFamily[connector.family] ?? 0) + 1
    if (connector.family === 'stud') freeStuds += 1
    else if (connector.family === 'anti-stud') freeAntiStuds += 1
    if (Math.abs(connector.axis[1]) < 0.99) freeSide += 1
  }
  return {
    occupiedExclusive,
    freeByFamily,
    approaches: {
      'on-top': freeStuds > 0,
      underneath: freeAntiStuds > 0,
      beside: freeSide > 0,
    },
  }
}

/**
 * Per-part availability from one connection derivation, so a scene listing does
 * not rebuild the world once per row.
 */
export function connectorAvailabilityByPart(
  document: ModelDocument,
  partIds: readonly string[],
): Record<string, ConnectorAvailability> {
  const world = deriveConnections(document)
  const wanted = new Set(partIds)
  const buckets = new Map<
    string,
    {
      occupiedExclusive: number
      freeByFamily: Record<string, number>
      freeStuds: number
      freeAntiStuds: number
      freeSide: number
    }
  >()
  for (const id of partIds) {
    buckets.set(id, { occupiedExclusive: 0, freeByFamily: {}, freeStuds: 0, freeAntiStuds: 0, freeSide: 0 })
  }
  for (const connector of world.connectors) {
    if (!wanted.has(connector.partId)) continue
    const bucket = buckets.get(connector.partId)
    if (!bucket) continue
    const key = `${connector.partId}/${connector.id}`
    if (isExclusiveFamily(connector.family) && world.occupied.has(key)) {
      bucket.occupiedExclusive += 1
      continue
    }
    bucket.freeByFamily[connector.family] = (bucket.freeByFamily[connector.family] ?? 0) + 1
    if (connector.family === 'stud') bucket.freeStuds += 1
    else if (connector.family === 'anti-stud') bucket.freeAntiStuds += 1
    if (Math.abs(connector.axis[1]) < 0.99) bucket.freeSide += 1
  }
  const result: Record<string, ConnectorAvailability> = {}
  for (const [id, bucket] of buckets) {
    result[id] = {
      occupiedExclusive: bucket.occupiedExclusive,
      freeByFamily: bucket.freeByFamily,
      approaches: {
        'on-top': bucket.freeStuds > 0,
        underneath: bucket.freeAntiStuds > 0,
        beside: bucket.freeSide > 0,
      },
    }
  }
  return result
}

export function openApproachNames(availability: ConnectorAvailability): string[] {
  const open: string[] = []
  if (availability.approaches['on-top']) open.push('on-top')
  if (availability.approaches.underneath) open.push('underneath')
  if (availability.approaches.beside) {
    open.push('beside-x', 'beside-minus-x', 'beside-z', 'beside-minus-z')
  }
  return open
}

export type ApproachOccupancy = 'open' | 'occupied' | 'absent'

/**
 * Why an approach cannot receive a part: the face still has free connectors,
 * every exclusive connector on that face is taken, or the identity never had
 * that family (a tile has no studs).
 */
export function approachOccupancy(
  document: ModelDocument,
  partId: string,
  approach: string,
): ApproachOccupancy {
  const part = document.parts[partId]
  if (!part) return 'absent'
  const availability = connectorAvailability(document, [partId])
  const definition = catalog.get(part.definitionId)
  const studs = definition?.connectors.filter((feature) => feature.family === 'stud').length ?? 0
  const anti = definition?.connectors.filter((feature) => feature.family === 'anti-stud').length ?? 0
  if (approach === 'on-top') {
    if (availability.approaches['on-top']) return 'open'
    return studs > 0 ? 'occupied' : 'absent'
  }
  if (approach === 'underneath') {
    if (availability.approaches.underneath) return 'open'
    return anti > 0 ? 'occupied' : 'absent'
  }
  if (approach.startsWith('beside')) {
    if (availability.approaches.beside) return 'open'
    return availability.occupiedExclusive > 0 ? 'occupied' : 'absent'
  }
  return 'absent'
}

export interface PlaceableAnchor {
  readonly id: string
  readonly freeStuds: number
  readonly approaches: ConnectorAvailability['approaches']
}

/**
 * Unlocked parts that can still receive a brick on top, richest free-stud
 * count first. Agents copy these ids instead of guessing which brick is full.
 */
export function placeableAnchors(document: ModelDocument, limit = 8): PlaceableAnchor[] {
  const ids = Object.keys(document.parts)
  const byPart = connectorAvailabilityByPart(document, ids)
  const rows: PlaceableAnchor[] = []
  for (const id of ids) {
    const part = document.parts[id]
    if (!part || part.protected) continue
    if (document.subassemblies[part.subassemblyId]?.locked) continue
    const availability = byPart[id]
    if (!availability?.approaches['on-top']) continue
    rows.push({
      id,
      freeStuds: availability.freeByFamily.stud ?? 0,
      approaches: availability.approaches,
    })
  }
  rows.sort((a, b) => b.freeStuds - a.freeStuds || a.id.localeCompare(b.id))
  return rows.slice(0, Math.max(0, limit))
}

/**
 * The nearest part that can still receive a brick on top, measured from
 * `partId`. A hovering brick has no graph neighbours; this is the id an agent
 * should copy into connect_parts rather than inventing one.
 */
export function nearestPlaceableNeighbour(document: ModelDocument, partId: string): PlaceableAnchor | undefined {
  const byId = new Map(placeableAnchors(document, 32).map((anchor) => [anchor.id, anchor]))
  for (const neighbour of nearbyParts(document, partId, 16)) {
    const anchor = byId.get(neighbour.id)
    if (anchor) return anchor
  }
  return undefined
}

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

  /**
   * Reads the index as it would look for `candidate`, then puts it back.
   *
   * The index tracks the *committed* document. A commit has to ask about a
   * candidate it may still refuse — by a hard constraint, a collision or the
   * clutch gate — and an index left pointing at a refused candidate is a silent
   * corruption rather than a slow path: the next edit's incremental diff would
   * mate against a part the document does not contain, or fail to find the mates
   * of one it does. Applying the candidate poses, reading, and rolling back keeps
   * the invariant a caller can actually rely on, and each sync costs what the
   * edit costs — 0.03 ms for one part against the 11,493-part campus demo.
   */
  speculate<T>(
    committed: ModelDocument,
    candidate: ModelDocument,
    touchedPartIds: readonly string[],
    read: (world: IncrementalConnectorWorld) => T,
  ): T {
    this.sync(candidate, touchedPartIds)
    try {
      return read(this)
    } finally {
      this.sync(committed, touchedPartIds)
    }
  }

  /**
   * Mated pairs for every pair with an endpoint in `partIds`, keyed as
   * `DerivedConnections.pairsByParts` keys them.
   *
   * This is the shape `findCollisions` wants for its `mates` option, and it is
   * complete for exactly the pairs a scoped collision check looks at: every such
   * pair has at least one endpoint in `partIds`, and this walks every mate of
   * every one of those. Supplying it is what keeps `deriveConnections` — 114 ms
   * on the campus demo, and the single most expensive derived value the kernel
   * has — off the commit path.
   */
  scopedMates(document: ModelDocument, partIds: readonly string[]): Map<string, MatedPair[]> {
    const found: MatedPair[] = []
    const seen = new Set<string>()
    for (const partId of partIds) {
      for (const pair of this.matesFor(partId, document)) {
        const a = `${pair.a.partId}/${pair.a.id}`
        const b = `${pair.b.partId}/${pair.b.id}`
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        // Two touched parts mated to each other are reached from both sides.
        if (seen.has(key)) continue
        seen.add(key)
        found.push(pair)
      }
    }
    return matesByPartPair(found)
  }

  /** Mated connector pairs involving `partId`, against everything else indexed. */
  matesFor(partId: string, document: ModelDocument): MatedPair[] {
    const part = document.parts[partId]
    if (!part) return []
    const pairs: MatedPair[] = []
    const seen = new Set<string>()
    for (const moving of getWorldConnectors(part)) {
      const selfKey = `${moving.partId}/${moving.id}`
      for (const other of this.index.query(moving.frame.position, CONTACT_TOLERANCE_LDU)) {
        if (other.partId === partId) continue
        if (!connectorsCompatible(moving, other)) continue
        if (!framesMate(moving, other)) continue
        const otherKey = `${other.partId}/${other.id}`
        const key = selfKey < otherKey ? `${selfKey}|${otherKey}` : `${otherKey}|${selfKey}`
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
