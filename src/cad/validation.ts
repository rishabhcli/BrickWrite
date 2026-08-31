import { catalog, STUD_LDU } from './catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from './collision'
import { introducedCollisions } from './collisionGate'
import { getDocumentBounds, getPartBounds, type PartBounds } from './geometry'
import { computeOccupancy, deriveConnections, approachOccupancy, matesByPartPair, matesForPose } from './snapping'
import type { Bounds, CollisionIssue, ModelDocument, PartInstance, Transform, ValidationReport, Vec3 } from './types'

/** The greatest Y any measured part reaches: the ground plane, LDraw being Y-down. */
function highestY(boxes: ReadonlyArray<{ box: PartBounds }>): number {
  let highest = -Infinity
  for (const entry of boxes) if (entry.box.max[1] > highest) highest = entry.box.max[1]
  return highest
}

interface GroundPlane {
  /** Greatest Y any measured part reaches. LDraw is Y-down, so this is the table. */
  readonly y: number
  /** Every part, measured or not: "is there anything to rest on" counts all of them. */
  readonly partCount: number
}

/**
 * The document's ground plane, memoized on document identity.
 *
 * Every hovering verdict needs it, and it is the only whole-model quantity the
 * *scoped* verdict needs: without it, asking whether one part is supported meant
 * walking every part in the model to find the table first. With it — and with
 * `getPartBounds` memoized per part — a scoped verdict about a clutched part
 * costs a component walk and nothing else, which is what the engine's clutch
 * gate asks twice per commit.
 *
 * `null` means nothing in the document has measurable extent, in which case no
 * verdict can be reached about anything, which is what all four callers did with
 * an empty box list.
 */
const groundPlaneCache = new WeakMap<ModelDocument, GroundPlane | null>()

function groundPlaneOf(document: ModelDocument): GroundPlane | null {
  const cached = groundPlaneCache.get(document)
  if (cached !== undefined) return cached
  let y = -Infinity
  let partCount = 0
  let measured = 0
  for (const part of Object.values(document.parts)) {
    partCount += 1
    const box = getPartBounds(part)
    if (!box.measured) continue
    measured += 1
    if (box.max[1] > y) y = box.max[1]
  }
  const plane = measured ? { y, partCount } : null
  groundPlaneCache.set(document, plane)
  return plane
}

/** One plate of slop: a part sitting a hair off the table is still on it. */
const GROUND_TOLERANCE_LDU = 8

/**
 * Adjacency and per-pair mating data for the current document.
 *
 * Both come from `deriveConnections`, which is memoized per revision, so the
 * solver, validation and the viewport share one derivation pass instead of each
 * rebuilding the graph.
 *
 * The adjacency built on top of it is memoized the same way, on document object
 * identity, because the derivation being shared is not the whole cost: the map
 * itself is one `Set` allocation per part, and this is called once by
 * `validateDocument`, once by each hovering verdict, and — until the memo —
 * *once per part* by `airbornePartIds`, which walks a connected component for
 * every part in the model and rebuilt the graph for each walk. Over the
 * 11,493-part campus demo that alone is 11,493 rebuilds of an 11,493-entry map.
 */
const connectionGraphCache = new WeakMap<ModelDocument, ConnectionGraph>()

interface ConnectionGraph {
  readonly edges: Map<string, Set<string>>
  readonly world: ReturnType<typeof deriveConnections>
  readonly connectionCount: number
}

function buildConnectionGraph(document: ModelDocument): ConnectionGraph {
  const cached = connectionGraphCache.get(document)
  if (cached) return cached
  const world = deriveConnections(document)
  const edges = new Map<string, Set<string>>(Object.keys(document.parts).map((id) => [id, new Set<string>()]))
  for (const pair of world.pairs) {
    edges.get(pair.a.partId)?.add(pair.b.partId)
    edges.get(pair.b.partId)?.add(pair.a.partId)
  }
  const graph: ConnectionGraph = { edges, world, connectionCount: world.pairs.length }
  connectionGraphCache.set(document, graph)
  return graph
}

/**
 * Part adjacency read off the document's *recorded* connection edges.
 *
 * The persisted edges are the source of truth for the structural graph — that is
 * why they are saved, exported and attributed to a transaction, and why
 * `IncrementalConnectorWorld` is documented as not being that source. So a
 * caller that knows the edges are current for the document in hand can read
 * adjacency straight off them instead of re-deriving the connector world, which
 * transforms every connector in the model and rebuilds a spatial index to
 * rediscover mates the document already lists.
 *
 * Measured on the campus demo: 5.0 ms against 114 ms for the derivation the
 * hovering verdicts otherwise force on a freshly committed document.
 *
 * Only safe where that "edges are current" precondition holds. The engine's
 * commit path qualifies, because the same transaction that produced the document
 * also produced its edge mutations. A speculative document assembled by
 * overwriting a transform — what `poseRefusal` builds — does not, and must go
 * through `buildConnectionGraph`.
 */
export function adjacencyFromRecordedEdges(document: ModelDocument): PartAdjacency {
  const cached = recordedAdjacencyCache.get(document)
  if (cached) return cached
  const edges = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    const bucket = edges.get(from)
    if (bucket) bucket.add(to)
    else edges.set(from, new Set([to]))
  }
  for (const id in document.connections) {
    const edge = document.connections[id]
    link(edge.a.partId, edge.b.partId)
    link(edge.b.partId, edge.a.partId)
  }
  recordedAdjacencyCache.set(document, edges)
  return edges
}

const recordedAdjacencyCache = new WeakMap<ModelDocument, PartAdjacency>()

function toIssue(contact: {
  partA: string
  partB: string
  overlapLdu: Vec3
  certainty: CollisionIssue['certainty']
  pointLdu?: Vec3
}): CollisionIssue {
  return {
    id: `collision_${contact.partA}_${contact.partB}`,
    partA: contact.partA,
    partB: contact.partB,
    overlapLdu: contact.overlapLdu,
    certainty: contact.certainty,
    pointLdu: contact.pointLdu,
    message:
      contact.certainty === 'unknown'
        ? `Parts ${contact.partA} and ${contact.partB} have overlapping bounds; their geometry is not loaded, so this is unverified.`
        : `Parts ${contact.partA} and ${contact.partB} intersect outside an allowed connection volume.`,
  }
}

/**
 * Connected components, largest first.
 *
 * The frontier is walked with a moving cursor rather than `queue.shift()`, which
 * is a memmove of the whole remaining frontier per step: a model that is one
 * connected component — which a building is — makes that quadratic in part
 * count. Same breadth-first order, same output.
 */
function components(edges: Map<string, Set<string>>): string[][] {
  const unseen = new Set(edges.keys())
  const result: string[][] = []
  while (unseen.size) {
    const seed = unseen.values().next().value as string
    unseen.delete(seed)
    const component: string[] = [seed]
    for (let head = 0; head < component.length; head += 1) {
      for (const neighbor of edges.get(component[head]) ?? []) {
        if (unseen.delete(neighbor)) component.push(neighbor)
      }
    }
    result.push(component)
  }
  return result.sort((a, b) => b.length - a.length)
}

/** Complete connected component around one or more seed parts. */
export function connectedComponent(document: ModelDocument, seedPartIds: readonly string[]): string[] {
  return componentFrom(buildConnectionGraph(document).edges, seedPartIds)
}

/**
 * Part adjacency: each part to the parts it has at least one mate with.
 *
 * Narrowed to the two lookups every consumer here actually performs, so a
 * `ReadonlyMap` satisfies it structurally *and* so a speculative pose can be
 * expressed as a thin overlay over a real one instead of a copied map.
 */
export interface PartAdjacency {
  has(partId: string): boolean
  get(partId: string): ReadonlySet<string> | undefined
}

/**
 * `base`, with one part's links replaced by the ones a candidate pose implies.
 *
 * Moving a part cannot create or destroy a mate between two *other* parts, so
 * the rest of the graph carries over unchanged and only the moved part and its
 * old and new partners differ. Computed per lookup rather than by copying the
 * map, because the pose gate builds one of these per snap candidate.
 */
export function adjacencyWithPose(
  base: PartAdjacency,
  partId: string,
  neighbours: ReadonlySet<string>,
): PartAdjacency {
  return {
    has: (id) => (id === partId ? neighbours.size > 0 || base.has(id) : base.has(id) || neighbours.has(id)),
    get: (id) => {
      if (id === partId) return neighbours
      const existing = base.get(id)
      const linkedBefore = existing?.has(partId) ?? false
      const linkedNow = neighbours.has(id)
      if (linkedBefore === linkedNow) return existing
      const next = new Set(existing ?? [])
      if (linkedNow) next.add(partId)
      else next.delete(partId)
      return next
    },
  }
}

function componentFrom(edges: PartAdjacency, seedPartIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const queue = [...seedPartIds.filter((id) => edges.has(id))]
  for (const id of queue) seen.add(id)
  // Cursor rather than `shift()`, for the reason `components` gives.
  for (let head = 0; head < queue.length; head += 1) {
    for (const neighbor of edges.get(queue[head]) ?? []) {
      if (seen.has(neighbor)) continue
      seen.add(neighbor)
      queue.push(neighbor)
    }
  }
  return [...seen].sort()
}

/**
 * Constraint status on its own, without the rest of the report.
 *
 * Constraints read only the part list and the document envelope — none of the
 * collision, connection-graph or colour-evidence work the full report does. The
 * kernel enforces hard constraints on every commit, so that gate calls this
 * instead of forcing two whole validation passes per edit.
 */
export function evaluateConstraints(document: ModelDocument): ValidationReport['constraints'] {
  return constraintStatus(document, Object.values(document.parts), getDocumentBounds(document))
}

function constraintStatus(
  document: ModelDocument,
  parts: PartInstance[],
  documentBounds: Bounds,
): ValidationReport['constraints'] {
  return document.constraints.map((constraint) => {
    if (constraint.kind === 'piece-count') {
      const max = Number(constraint.value)
      return {
        id: constraint.id,
        label: constraint.label,
        status: parts.length <= max ? ('pass' as const) : ('fail' as const),
        message: `${parts.length} / ${max} parts`,
      }
    }
    if (constraint.kind === 'dimensions') {
      const maximum = constraint.value as { width: number; depth: number; height?: number }
      const width = documentBounds.size[0] / STUD_LDU
      const depth = documentBounds.size[2] / STUD_LDU
      const height = documentBounds.size[1] / STUD_LDU
      const pass = width <= maximum.width && depth <= maximum.depth && (!maximum.height || height <= maximum.height)
      return {
        id: constraint.id,
        label: constraint.label,
        status: pass ? ('pass' as const) : ('fail' as const),
        message: `${width.toFixed(1)} × ${depth.toFixed(1)} studs`,
      }
    }
    if (constraint.kind === 'palette') {
      const allowed = constraint.value as number[]
      const violations = parts.filter((part) => !allowed.includes(part.color)).length
      return {
        id: constraint.id,
        label: constraint.label,
        status: violations ? ('fail' as const) : ('pass' as const),
        message: violations ? `${violations} out-of-palette parts` : 'Palette respected',
      }
    }
    return { id: constraint.id, label: constraint.label, status: 'pass' as const, message: 'Active' }
  })
}

export interface ValidationOptions {
  /** Override the geometry source; tests supply compiled meshes directly. */
  provideGeometry?: GeometryProvider
  /**
   * Reuse of the previous pass, when the caller knows exactly what changed.
   *
   * Only pairs involving a touched part can have gained or lost a collision, so
   * previous verdicts about untouched pairs carry forward unchanged. That turns
   * a whole-model recheck into work proportional to the edit.
   */
  incremental?: {
    previous: ValidationReport
    touchedPartIds: readonly string[]
  }
}

export function validateDocument(document: ModelDocument, options: ValidationOptions = {}): ValidationReport {
  const parts = Object.values(document.parts)
  const graph = buildConnectionGraph(document)

  // -- Collision -------------------------------------------------------------
  // Delegated to the collision kernel: grid broad phase, mating-clearance
  // allowance, then triangle confirmation for whatever survives.
  const provide = options.provideGeometry ?? residentGeometryProvider
  const incremental = options.incremental
  const touched = incremental ? new Set(incremental.touchedPartIds) : null

  const recomputed = findCollisions(document, {
    provide,
    onlyPartIds: touched ? [...touched] : undefined,
  }).map(toIssue)

  const collisions: CollisionIssue[] = touched
    ? [
        // Verdicts about pairs the edit did not involve are still valid, so long
        // as both parts still exist.
        ...incremental!.previous.collisions.filter(
          (issue) =>
            !touched.has(issue.partA) &&
            !touched.has(issue.partB) &&
            document.parts[issue.partA] &&
            document.parts[issue.partB],
        ),
        ...recomputed,
      ]
    : recomputed

  // -- Colour evidence -------------------------------------------------------
  const virtualColors: ValidationReport['virtualColors'] = parts.flatMap((part): ValidationReport['virtualColors'] => {
    const definition = catalog.get(part.definitionId)
    if (!definition) return []
    if (!definition.availableColors.length) {
      return [{ partId: part.id, definitionId: part.definitionId, color: part.color, reason: 'no-evidence' as const }]
    }
    if (definition.availableColors.includes(part.color)) return []
    return [{ partId: part.id, definitionId: part.definitionId, color: part.color, reason: 'unobserved' as const }]
  })

  const grouped = components(graph.edges)
  const disconnectedPartIds = grouped.slice(1).flat()
  const documentBounds = getDocumentBounds(document)

  const constraints = constraintStatus(document, parts, documentBounds)

  return {
    revision: document.revision,
    partCount: parts.length,
    connectionCount: graph.connectionCount,
    collisions,
    unverifiedCollisions: collisions.filter((issue) => issue.certainty === 'unknown').length,
    componentCount: grouped.length,
    disconnectedPartIds,
    virtualColors,
    bounds: documentBounds,
    constraints,
    // Virtual colours are legal to build and export, so they do not make a
    // document unhealthy. A hard palette constraint is the mechanism for
    // turning colour choice into a failure.
    healthy: collisions.length === 0 && constraints.every((item) => item.status !== 'fail'),
  }
}

/**
 * Parts hovering with no clutch and no ground under them.
 *
 * Two buildings on the table are legal LEGO — they share a ground plane and
 * need not clutch to each other. A brick in mid-air with nothing mated to it
 * is not. That is the placement an agent produces when it invents XYZ, and the
 * one a free transform produces when it pulls a part off the model into space.
 */
export function floatingPartIds(document: ModelDocument): string[] {
  const parts = Object.values(document.parts)
  if (!parts.length) return []
  const { edges } = buildConnectionGraph(document)
  const boxes = parts.map((part) => ({ part, box: getPartBounds(part) })).filter((entry) => entry.box.measured)
  if (!boxes.length) return []
  // LDraw is Y-down: the ground is the greatest Y anything reaches. A loop, not
  // a spread: this is one entry per part, and `Math.max(...a)` throws past about
  // 100,000 arguments — measured — as well as being an order of magnitude slower.
  const groundY = highestY(boxes)
  const floating: string[] = []
  for (const { part, box } of boxes) {
    if ((edges.get(part.id)?.size ?? 0) > 0) continue
    if (Math.abs(box.max[1] - groundY) > GROUND_TOLERANCE_LDU) floating.push(part.id)
  }
  return floating
}

/**
 * Parts whose connected island never reaches the ground plane.
 *
 * `floatingPartIds` only names unclutched hoverers. A wall that clutches to
 * itself in mid-air is still not a building — it is a flying assembly beside
 * something that actually sits on the table. Two buildings on the table each
 * include a grounded brick, so they are not airborne.
 */
export function airbornePartIds(document: ModelDocument): string[] {
  const parts = Object.values(document.parts)
  if (!parts.length) return []
  const boxes = parts.map((part) => ({ part, box: getPartBounds(part) })).filter((entry) => entry.box.measured)
  if (!boxes.length) return []
  const groundY = highestY(boxes)
  const grounded = new Set(
    boxes.filter((entry) => Math.abs(entry.box.max[1] - groundY) <= GROUND_TOLERANCE_LDU).map((entry) => entry.part.id),
  )
  // Only parts this build can measure are accused, matching `floatingPartIds`
  // and the way collisions are reported.
  //
  // A part whose geometry is not compiled has a known position and an unknown
  // extent, so it cannot be shown to reach the ground — and this used to read
  // that absence as a fault, because an unmeasured part cannot be in `grounded`
  // and, having no compiled connectors either, forms an island of one. The two
  // functions disagreed: `floatingPartIds` excused exactly the same part. The
  // report built on it then claimed "exact connection graph and measured
  // bounds" as its evidence, which for those parts was not true, and an import
  // of a model using elements this pack does not carry looked like a broken
  // model rather than a gap in the catalog.
  //
  // A genuinely airborne island is still reported: its measured members are
  // named, which is also the only useful answer for a viewport that has no mesh
  // to highlight for the others.
  const measured = new Set(boxes.map((entry) => entry.part.id))
  const hovering: string[] = []
  const seen = new Set<string>()
  for (const { part } of boxes) {
    if (seen.has(part.id)) continue
    const component = connectedComponent(document, [part.id])
    for (const id of component) seen.add(id)
    if (component.some((id) => grounded.has(id))) continue
    hovering.push(...component.filter((id) => measured.has(id)))
  }
  return hovering
}

function overlapsHorizontal(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  const overlapX = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0])
  const overlapZ = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2])
  return overlapX > 1 && overlapZ > 1
}

/**
 * Unclutched parts whose underside is sitting on another part.
 *
 * A second building on the table is legal LEGO. A brick sitting on a tile is
 * not — tiles have no studs, so nothing clutches, and the brick will slide.
 * Hovering in empty air is `floatingPartIds`; this is the case that looks
 * grounded because a plate is underneath it.
 */
export function unclutchedRestPartIds(document: ModelDocument): string[] {
  return unclutchedRests(document).map((entry) => entry.partId)
}

/** The part an unclutched rest is sitting on, if any. */
export function unclutchedRestSupport(document: ModelDocument, partId: string): string | null {
  return unclutchedRests(document).find((entry) => entry.partId === partId)?.supportId ?? null
}

function unclutchedRests(document: ModelDocument): Array<{ partId: string; supportId: string }> {
  const parts = Object.values(document.parts)
  if (parts.length < 2) return []
  const { edges } = buildConnectionGraph(document)
  const boxes = parts.map((part) => ({ part, box: getPartBounds(part) })).filter((entry) => entry.box.measured)
  const rests: Array<{ partId: string; supportId: string }> = []
  for (const { part, box } of boxes) {
    if ((edges.get(part.id)?.size ?? 0) > 0) continue
    const support = boxes.find((other) => {
      if (other.part.id === part.id) return false
      if (!overlapsHorizontal(box, other.box)) return false
      return Math.abs(box.max[1] - other.box.min[1]) <= GROUND_TOLERANCE_LDU
    })
    if (support) rests.push({ partId: part.id, supportId: support.part.id })
  }
  return rests
}

/**
 * The three hovering verdicts, answered for named parts only.
 *
 * `floatingPartIds`, `airbornePartIds` and `unclutchedRestPartIds` each answer
 * for the whole document, which is right for a report and wasteful for the one
 * question the realiser actually asks: *is the part I just placed supported?*
 *
 * Measured on a 924-part document with a fresh object per call, so the
 * derivation memo misses exactly as it does mid-realisation: the three
 * whole-document calls cost 24.6 ms together, and `airbornePartIds` alone was
 * 29.8 ms when called on its own because it walks a connected component *per
 * part*. Placing one brick paid for the answer about all 924.
 *
 * This computes the shared work once — one derivation, one bounds pass, one
 * ground plane — and then walks a component only for the parts asked about.
 * The verdicts are defined to be identical to the whole-document functions
 * restricted to `partIds`, which `validation.scoped.test.ts` checks by running
 * both over the same documents rather than by asserting it here.
 */
export interface HoverVerdict {
  /** Unclutched and not resting on the ground plane. */
  readonly floating: string[]
  /** In a connected island that never reaches the ground. */
  readonly airborne: string[]
  /** Unclutched, but sitting on another part rather than in mid-air. */
  readonly unclutchedRests: Array<{ partId: string; supportId: string }>
}

export function hoverVerdictFor(
  document: ModelDocument,
  partIds: readonly string[],
  adjacency?: PartAdjacency,
): HoverVerdict {
  const empty: HoverVerdict = { floating: [], airborne: [], unclutchedRests: [] }
  if (!partIds.length) return empty
  // The only whole-model quantity a scoped verdict needs, and it is memoized:
  // nothing else here walks the document unless a part turns out to be
  // unclutched, and then only to find what it is sitting on.
  const ground = groundPlaneOf(document)
  if (!ground) return empty

  // A caller that already knows the adjacency passes it, and must, if it also
  // passed `mates` to `findCollisions`: the two derivations are the same one,
  // memoized on document object identity, so feeding only the collision check
  // would move the cost here rather than remove it.
  const edges = adjacency ?? buildConnectionGraph(document).edges
  const onGround = (box: PartBounds) => Math.abs(box.max[1] - ground.y) <= GROUND_TOLERANCE_LDU
  const boxOf = (id: string): PartBounds | null => {
    const part = document.parts[id]
    if (!part) return null
    const box = getPartBounds(part)
    return box.measured ? box : null
  }
  const clutched = (id: string) => (edges.get(id)?.size ?? 0) > 0

  const floating: string[] = []
  const airborne: string[] = []
  const unclutchedRests: Array<{ partId: string; supportId: string }> = []

  /**
   * Whether the island containing `id` reaches the table.
   *
   * Its own walk rather than `componentFrom`, for two reasons. It stops at the
   * first grounded member instead of enumerating the island and then asking —
   * which for a building means it usually stops within a few courses of the
   * ground rather than visiting every brick — and it needs no sorted member
   * list, only a verdict.
   *
   * One walk per component, not per part: two parts of the same island asked
   * about together share the answer. A `true` verdict is recorded for the
   * members actually visited, which is sound because grounded is a property of
   * the island; a `false` verdict is recorded for all of them, because
   * establishing it required visiting all of them.
   */
  const groundedIsland = new Map<string, boolean>()
  const islandIsGrounded = (id: string): boolean => {
    const known = groundedIsland.get(id)
    if (known !== undefined) return known
    const visited = [id]
    const seen = new Set<string>(visited)
    let grounded = false
    for (let head = 0; head < visited.length; head += 1) {
      const box = boxOf(visited[head])
      if (box && onGround(box)) {
        grounded = true
        break
      }
      for (const neighbour of edges.get(visited[head]) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        visited.push(neighbour)
      }
    }
    for (const member of visited) groundedIsland.set(member, grounded)
    return grounded
  }

  /** First measured part this one's underside is sitting on, in document order. */
  const restingOn = (partId: string, box: PartBounds): string | undefined => {
    for (const other of Object.values(document.parts)) {
      if (other.id === partId) continue
      const otherBox = getPartBounds(other)
      if (!otherBox.measured) continue
      if (!overlapsHorizontal(box, otherBox)) continue
      if (Math.abs(box.max[1] - otherBox.min[1]) <= GROUND_TOLERANCE_LDU) return other.id
    }
    return undefined
  }

  for (const partId of partIds) {
    // No box, no accusation — the same rule all three verdicts now follow. A
    // part whose geometry this build does not carry has an unknown extent, and
    // reading that absence as "unsupported" is an assertion about data nobody
    // has.
    const box = boxOf(partId)
    if (!box) continue
    if (!clutched(partId)) {
      if (!onGround(box)) floating.push(partId)
      if (ground.partCount >= 2) {
        const support = restingOn(partId, box)
        if (support) unclutchedRests.push({ partId, supportId: support })
      }
    }
    if (!islandIsGrounded(partId)) airborne.push(partId)
  }

  return { floating, airborne, unclutchedRests }
}

export function unclutchedRestCode(
  document: ModelDocument,
  partId: string,
): 'CONNECTOR_OCCUPIED' | 'NO_COMPATIBLE_CONNECTOR' {
  return restCodeForSupport(document, unclutchedRestSupport(document, partId))
}

/**
 * The same code, for a caller that already knows what the part is sitting on.
 *
 * `hoverVerdictFor` reports the supporting part along with the verdict, so the
 * engine's clutch gate does not need to run a second whole-document search to
 * rediscover it before it can phrase the refusal.
 */
export function restCodeForSupport(
  document: ModelDocument,
  supportId: string | null,
): 'CONNECTOR_OCCUPIED' | 'NO_COMPATIBLE_CONNECTOR' {
  if (supportId && approachOccupancy(document, supportId, 'on-top') === 'occupied') return 'CONNECTOR_OCCUPIED'
  return 'NO_COMPATIBLE_CONNECTOR'
}

/**
 * Whether committing this pose for an existing part would be refused.
 *
 * Used by the viewport so a drag ghost is not drawn for a pose the kernel
 * would reject — the same contract click-to-place already has.
 */
export function poseRefusal(
  document: ModelDocument,
  partId: string,
  transform: Transform,
): 'DISCONNECTED' | 'NO_COMPATIBLE_CONNECTOR' | 'CONNECTOR_OCCUPIED' | 'COLLISION' | null {
  const part = document.parts[partId]
  if (!part) return null
  const moved: PartInstance = { ...part, transform }
  const preview: ModelDocument = {
    ...document,
    parts: { ...document.parts, [partId]: moved },
  }

  // Everything below is scoped to the one part being posed, and nothing derives
  // a connector world for `preview`.
  //
  // This is called once per snap candidate — `firstLegalSnap` and
  // `legalConnectCandidates` filter a list of up to 24 — and each candidate is a
  // different preview document, so the old shape paid a full derivation *per
  // candidate*: 130 ms each on the 11,493-part campus demo, three seconds to
  // filter one drag. The candidate's mates come from the live document's
  // memoized index instead, which is correct because the other 11,492 parts have
  // not moved.
  const posedMates = matesForPose(document, moved, transform)
  const liveAdjacency = buildConnectionGraph(document).edges
  const previewAdjacency = adjacencyWithPose(
    liveAdjacency,
    partId,
    new Set(posedMates.map((pair) => (pair.a.partId === partId ? pair.b.partId : pair.a.partId))),
  )

  const before = hoverVerdictFor(document, [partId], liveAdjacency)
  const after = hoverVerdictFor(preview, [partId], previewAdjacency)
  if (!before.floating.length && after.floating.length) return 'DISCONNECTED'
  if (!before.unclutchedRests.length && after.unclutchedRests.length) {
    return restCodeForSupport(preview, after.unclutchedRests[0]!.supportId)
  }

  const previewMates = matesByPartPair(posedMates)
  if (
    introducedCollisions(document, preview, [partId], {
      placing: false,
      beforeMates: deriveConnections(document).pairsByParts,
      afterMates: previewMates,
    }).length
  ) {
    return 'COLLISION'
  }
  return null
}

/** Parts held by exactly one connector: the classic "will fall off" warning. */
export function findWeakAttachments(document: ModelDocument): Array<{ partId: string; connections: number }> {
  const { edges } = buildConnectionGraph(document)
  return Object.values(document.parts)
    .map((part) => ({ partId: part.id, connections: edges.get(part.id)?.size ?? 0 }))
    .filter((entry) => entry.connections === 1)
}

/** Connector occupancy for the current document, exposed for inspection tools. */
export const occupancyOf = (document: ModelDocument) => computeOccupancy(document)
