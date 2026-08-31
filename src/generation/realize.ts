import {
  AssemblyError,
  DEFAULT_GLASS_COLOR,
  DEFAULT_TRIM_COLOR,
  MAX_GENERATED_PARTS,
  MechanismGeometryError,
  planBrickField,
  planClockFaces,
  planCrane,
  planEnclosure,
  planHingedFlap,
  planLattice,
  planSnotHull,
  planWall,
  type AssemblyPlan,
  type BrickFamily,
} from '../cad/assembly'
import { catalog, getPartDefinition, originForSurface, searchCatalog, STUD_LDU } from '../cad/catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from '../cad/collision'
import { featureFrame, isExclusiveFamily } from '../cad/connections'
import { getDocumentBounds, getPartBounds } from '../cad/geometry'
import { composeTransform, invertTransform, rotationAboutAxis, IDENTITY_BASIS } from '../cad/math'
import {
  deriveConnectionEdges,
  deriveConnections,
  findSnapCandidates,
  getWorldConnectors,
  IncrementalConnectorWorld,
  type MatedPair,
  type WorldConnector,
} from '../cad/snapping'
import type {
  CadOperation,
  ModelDocument,
  PartDefinition,
  PartInstance,
  Subassembly,
  Vec3,
} from '../cad/types'
import { connectedComponent, hoverVerdictFor, type PartAdjacency } from '../cad/validation'
import {
  incomingEdge,
  topologicalOrder,
  validateGraph,
  type BuildEdge,
  type BuildGraph,
  type BuildNode,
  type ConnectorRef,
  type PartIntent,
  type RegionIntent,
} from './graph'
import {
  enumerateAttachmentAttempts,
  enumerateRegionAttempts,
  type AttachmentAttempt,
  type RegionAttempt,
  type RepairKind,
} from './repair'

/**
 * The deterministic realiser: structure in, exact geometry out.
 *
 * This is the half of generation that decides where things go, and it decides
 * by running the same code a human drag runs. Each attachment names two
 * connectors; the realiser resolves those against compiled `ConnectionFeature`s,
 * builds the pose that puts them coincident, and hands *that* to
 * `findSnapCandidates`, which enumerates the matings the pair actually permits
 * and ranks them by how many further connectors land at the same time. The
 * winning candidate's transform is the part's pose. No coordinate in the output
 * was ever proposed by a model.
 *
 * Bulk fill is delegated to `src/cad/assembly.ts` rather than solved joint by
 * joint, for a reason worth stating: a wall's correctness is a property of the
 * *bond* — staggered seams, exact coverage, interlocked corners — which is a
 * global constraint over a course, not a local one over a joint. The planners
 * solve it exactly. What the realiser owns is where a region starts and whether
 * it actually attached, and both are verified here against the kernel's own
 * connection graph rather than assumed from the planner.
 *
 * Every placement is checked before it is kept: collisions through
 * `findCollisions`, region attachment through `connectedComponent`, envelope and
 * palette against the brief. A placement that fails goes to `repair.ts`, and one
 * that survives repair is rejected with the reason. Nothing is retained because
 * the graph asked for it.
 */

export type NodeStatus = 'realized' | 'repaired' | 'rejected' | 'skipped'

export interface NodeOutcome {
  readonly nodeId: string
  readonly kind: BuildNode['kind']
  readonly status: NodeStatus
  readonly definitionId?: string
  readonly partIds: readonly string[]
  /** Why a node was repaired, rejected or skipped. Absent when realised cleanly. */
  readonly reason?: string
  /**
   * Whether a later phase could plausibly fix this failure.
   *
   * The phases build coarse to fine, and a node can fail purely because the
   * thing that would hold it up has not been proposed yet: a storey deck is
   * emitted during massing, when the walls of the storey below exist only as a
   * plan. Those failures are transient and the node is tried again after each
   * later phase. A collision, a missing identity or an envelope breach is not
   * transient — adding more parts cannot un-collide two that already overlap —
   * so those stay refused and are reported once.
   */
  readonly retryable?: boolean
  /**
   * Every attempt that failed, in order.
   *
   * Reporting only the last one is actively misleading: repair walks outward, so
   * the final failure is usually "it left the envelope four studs away" while the
   * thing that actually went wrong was the first attempt's collision.
   */
  readonly attemptLog?: readonly string[]
  /** Populated when the brief's palette forced a different colour. */
  readonly colourSubstitutedFrom?: number
}

export interface EdgeOutcome {
  readonly edgeId: string
  readonly status: 'realized' | 'repaired' | 'rejected'
  readonly repairKind?: RepairKind
  readonly reason?: string
  /** Attempts consumed, including the primary. Bounded by the repair budget. */
  readonly attempts: number
  /** Every attempt that failed, in order. */
  readonly attemptLog?: readonly string[]
  /** `partId/featureId` of the host connector that carried the attachment. */
  readonly hostConnector?: string
  readonly childFeatureId?: string
  /** Further connectors that landed at the solved pose — the bond, not the joint. */
  readonly simultaneousMates?: number
}

export interface RealizeConstraints {
  /** Hard part ceiling. Null means only `MAX_GENERATED_PARTS` applies. */
  readonly partBudget?: number | null
  /** Hard envelope in studs, [x, y, z]. Checked against the document extent. */
  readonly envelopeStuds?: readonly [number, number, number] | null
  /** LDraw colours the build may use. Empty means unconstrained. */
  readonly palette?: readonly number[]
  /** Parts the realiser must leave byte-identical. */
  readonly protectedPartIds?: readonly string[]
}

export interface RealizeOptions {
  /** Seeds repair ordering. Same seed and graph produce identical operations. */
  readonly seed?: number
  /** Prefix for generated part ids; must be stable for reproducibility. */
  readonly idPrefix?: string
  readonly constraints?: RealizeConstraints
  /** Attempts allowed per attachment, primary included. */
  readonly repairBudget?: number
  /** Overridden by tests that hold compiled meshes; defaults to the resident cache. */
  readonly provideGeometry?: GeometryProvider
  readonly signal?: AbortSignal
}

export interface RealizeResult {
  /** Ready for `commandBus.dispatch`, in placement order. */
  readonly operations: CadOperation[]
  /** The document those operations would produce, for inspection and scoring. */
  readonly document: ModelDocument
  readonly nodes: NodeOutcome[]
  readonly edges: EdgeOutcome[]
  readonly partCount: number
  /** True when a budget or the kernel ceiling stopped placement early. */
  readonly truncated: boolean
  readonly notes: string[]
  /** Structural problems found before anything was placed. */
  readonly graphViolations: string[]
}

export class GenerationAbortedError extends Error {
  constructor(readonly stage: string) {
    super(`Generation was aborted during ${stage}.`)
    this.name = 'GenerationAbortedError'
  }
}

const throwIfAborted = (signal: AbortSignal | undefined, stage: string) => {
  if (signal?.aborted) throw new GenerationAbortedError(stage)
}

/** Brick families the compiled pack can lay, in substitution order. */
const SUBSTITUTE_FAMILIES: readonly BrickFamily[] = ['brick', 'plate', 'tile']

export interface IdentityResolution {
  readonly definition: PartDefinition | null
  /** Further placeable identities that satisfy the same intent, best first. */
  readonly alternatives: PartDefinition[]
  readonly explanation: string
}

/**
 * Turns a part intent into catalog identities.
 *
 * Only the `placeable` tier is ever returned. An identity this build merely
 * knows the name of cannot be given a pose, so offering one would produce a
 * document with a hole in it; the intent is reported unresolvable instead.
 */
export function resolvePartIdentity(intent: PartIntent, limit = 8): IdentityResolution {
  if (intent.definitionId) {
    const definition = getPartDefinition(intent.definitionId)
    const record = catalog.describe(intent.definitionId)
    if (definition && record?.tier === 'placeable') {
      return { definition, alternatives: [], explanation: `exact identity ${definition.canonicalId}` }
    }
    return {
      definition: null,
      alternatives: [],
      explanation: record
        ? `${intent.definitionId} is catalogued at tier “${record.tier}”, which this build cannot place`
        : `${intent.definitionId} is not an identity in catalog ${catalog.version}`,
    }
  }

  const size = intent.sizeStuds
  const bound = (index: 0 | 1 | 2, slack: number) => {
    const value = size?.[index]
    return value === null || value === undefined ? {} : { [(['width', 'height', 'depth'] as const)[index]]: value + slack }
  }
  const envelope = size
    ? {
        min: { ...bound(0, -0.01), ...bound(1, -0.01), ...bound(2, -0.01) },
        max: { ...bound(0, 0.01), ...bound(1, 0.01), ...bound(2, 0.01) },
      }
    : null

  const records = searchCatalog({
    text: intent.query,
    tier: 'placeable',
    requireGeometry: true,
    ...(intent.category ? { category: intent.category } : {}),
    ...(intent.connectorFamilies?.length ? { connectorTypes: [...intent.connectorFamilies] } : {}),
    ...(envelope ? { minStuds: envelope.min, maxStuds: envelope.max } : {}),
    limit,
  })

  const definitions = records
    .map((record) => getPartDefinition(record.id))
    .filter((definition): definition is PartDefinition => Boolean(definition?.dimensions))

  if (!definitions.length) {
    return {
      definition: null,
      alternatives: [],
      explanation: `no placeable identity in catalog ${catalog.version} matches “${intent.query}”${
        size ? ` at ${size.map((value) => value ?? '*').join(' × ')} studs` : ''
      }`,
    }
  }
  return {
    definition: definitions[0],
    alternatives: definitions.slice(1),
    explanation: `${definitions[0].name} (${definitions[0].canonicalId}) matched “${intent.query}”`,
  }
}

/**
 * Every connector on a part that a reference could mean, best match first.
 *
 * Used for the *moving* side of an attachment, where the choice is made in the
 * part's own frame before it has a pose. The host side is resolved in world
 * space by `hostConnectors`, because a host may be a whole region rather than a
 * single part.
 */
export function orderFeatures(definition: PartDefinition, reference: ConnectorRef): PartDefinition['connectors'] {
  const pool = definition.connectors.filter(
    (feature) => feature.family === reference.family && (!reference.gender || feature.gender === reference.gender),
  )
  if (pool.length < 2) return pool

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
  const pick = reference.pick

  if (pick.kind === 'index') {
    const sorted = [...pool].sort(byId)
    const offset = ((Math.trunc(pick.index) % sorted.length) + sorted.length) % sorted.length
    return [...sorted.slice(offset), ...sorted.slice(0, offset)]
  }

  if (pick.kind === 'extreme') {
    const sign = pick.sense === 'min' ? 1 : -1
    return [...pool].sort((a, b) => sign * (a.pos[pick.axis] - b.pos[pick.axis]) || byId(a, b))
  }

  // A grid pick names a stud on the mating plane, so it is measured in the plane
  // and the axis coordinate is only a tie-break. Comparing in 3D instead would
  // let a connector on the far face win because it happens to be closer in space.
  const bounds = definition.dimensions?.bounds
  const targetU = (bounds ? bounds.min[0] : 0) + (pick.uStuds + 0.5) * STUD_LDU
  const targetV = (bounds ? bounds.min[2] : 0) + (pick.vStuds + 0.5) * STUD_LDU
  const levelled = filterToLevel(pool, pick.level, (feature) => feature.pos[1])
  return [...levelled].sort(
    (a, b) =>
      Math.hypot(a.pos[0] - targetU, a.pos[2] - targetV) - Math.hypot(b.pos[0] - targetU, b.pos[2] - targetV) ||
      a.pos[1] - b.pos[1] ||
      byId(a, b),
  )
}

/**
 * Narrows a connector pool to its highest or lowest plane.
 *
 * LDraw is Y-down, so "top" is the *minimum* y. One LDU of slack absorbs the
 * float noise of composing a transform without merging two real courses, which
 * are 8 LDU apart at the very closest.
 */
function filterToLevel<T>(pool: readonly T[], level: 'top' | 'bottom' | undefined, y: (item: T) => number): readonly T[] {
  if (!level || pool.length < 2) return pool
  const values = pool.map(y)
  const plane = level === 'top' ? Math.min(...values) : Math.max(...values)
  const kept = pool.filter((item) => Math.abs(y(item) - plane) <= 1)
  return kept.length ? kept : pool
}

const withParts = (document: ModelDocument, parts: readonly PartInstance[]): ModelDocument => ({
  ...document,
  parts: { ...document.parts, ...Object.fromEntries(parts.map((part) => [part.id, part])) },
})

/** The palette entry a node's colour becomes, or the colour itself when free. */
function conformColour(colour: number, palette: readonly number[] | undefined): number {
  if (!palette?.length) return colour
  if (palette.includes(colour)) return colour
  return palette[0]
}

function checkEnvelope(
  document: ModelDocument,
  envelopeStuds: RealizeConstraints['envelopeStuds'],
): { ok: boolean; detail?: string } {
  if (!envelopeStuds) return { ok: true }
  const size = getDocumentBounds(document).size
  const axes = ['x', 'y', 'z'] as const
  for (let axis = 0; axis < 3; axis += 1) {
    const limit = envelopeStuds[axis] * STUD_LDU
    if (size[axis] > limit + 1e-6) {
      return {
        ok: false,
        detail: `would take the model to ${(size[axis] / STUD_LDU).toFixed(1)} studs in ${axes[axis]}, past the ${envelopeStuds[axis]}-stud envelope`,
      }
    }
  }
  return { ok: true }
}

/**
 * Realises a build graph against a base document.
 *
 * The base is never mutated: everything accumulates into a working copy, and the
 * returned operations are what would produce it through the command bus. That is
 * what makes cancellation safe — an aborted run has written nothing anywhere.
 */
export function realizeGraph(graph: BuildGraph, base: ModelDocument, options: RealizeOptions = {}): RealizeResult {
  return new GraphRealizer(base, options).extend(graph)
}

interface PlacedNode {
  readonly node: BuildNode
  readonly partIds: string[]
  /**
   * The node's own origin corner in document LDU: minimum X, minimum Z, and the
   * Y of the plane it was seated on. Grid picks on an outgoing edge are measured
   * from here, so "the stud six along the deck" means the same thing whether the
   * node is one plate or two hundred.
   */
  readonly originLdu: Vec3
  readonly definitionId: string | null
}

/** A host connector, carried with the composite handle repair reports it by. */
interface HostConnector {
  readonly handle: string
  readonly connector: WorldConnector
}

/**
 * A realiser that survives between phases.
 *
 * The pipeline grows one graph across four phases, and re-realising the whole
 * thing each time would be both wasteful and subtly wrong: repair is seeded, so
 * a node re-placed in a document that now contains later parts could land
 * somewhere else than it did when the phase that owns it ran. Keeping the
 * realiser alive means a node is placed exactly once, by the phase that proposed
 * it, and every later phase sees the geometry that actually exists.
 */
export class GraphRealizer {
  private document: ModelDocument
  private readonly operations: CadOperation[] = []
  private readonly nodes: NodeOutcome[] = []
  private readonly edges: EdgeOutcome[] = []
  private readonly notes: string[] = []
  private readonly placed = new Map<string, PlacedNode>()
  private readonly subassemblies = new Set<string>()
  private readonly seed: number
  private readonly idPrefix: string
  private readonly repairBudget: number
  private readonly provide: GeometryProvider
  private readonly constraints: RealizeConstraints
  private counter = 0
  private truncated = false
  private readonly stepId: string

  /**
   * The committed document's connector index, and the adjacency it implies.
   *
   * `deriveConnections` is memoized on document *object identity*, which is the
   * right key — a revision key would go stale mid-realisation, since the
   * revision does not move while parts are being added. But the realiser builds
   * a fresh candidate document for every placement, so it misses that memo every
   * time and derives the whole model to ask about one part. Measured on a
   * detail-heavy brief: **8.4 s of a 9.2 s candidate**, across 403 calls, all of
   * it inside `findCollisions`.
   *
   * So the committed state is kept instead, synced only for the parts that just
   * landed. A candidate borrows it and overlays whatever it is asking about —
   * one detail part or a whole region — and every consumer is fed from that same
   * overlay: the collision check, the hovering verdict, the host-connector
   * search and the did-it-reach-its-host walk. Feeding only some of them would
   * move the derivation rather than remove it, because it is the same
   * derivation, and that is exactly how it kept coming back.
   *
   * `realize.incremental.test.ts` requires this to give the same answers as a
   * full derivation on real models: a cheaper verdict is only worth having if it
   * is the same verdict.
   */
  private readonly world = new IncrementalConnectorWorld()
  private readonly adjacency = new Map<string, Set<string>>()
  /**
   * `partId/featureId` of every committed exclusive connector already mated.
   *
   * The third thing a derivation was being bought for, alongside the adjacency
   * and the mates: `hostConnectors` needs to know which studs are already taken
   * before it offers one. It falls out of the same pairs the adjacency is built
   * from, so it is maintained in the same two places and never separately
   * computed.
   */
  private readonly occupied = new Set<string>()


  private graph: BuildGraph = { version: 1, strategy: 'empty', nodes: [], edges: [] }

  constructor(base: ModelDocument, private readonly options: RealizeOptions = {}) {
    this.document = base
    this.seed = options.seed ?? 0
    this.idPrefix = options.idPrefix ?? `gen${(options.seed ?? 0).toString(36)}`
    this.repairBudget = options.repairBudget ?? 24
    this.provide = options.provideGeometry ?? residentGeometryProvider
    this.constraints = options.constraints ?? {}
    const step = base.steps[0]
    if (!step) {
      throw new Error('The base document declares no build step, so generated parts have nowhere to go.')
    }
    this.stepId = step.id
    for (const id of Object.keys(base.subassemblies)) this.subassemblies.add(id)
    // Seeded here, not on first commit: a graph realised onto an existing model
    // must see the parts already there, or its first placement looks unsupported.
    this.world.sync(base)
    for (const id of Object.keys(base.parts)) this.adjacency.set(id, new Set())
    for (const pair of deriveConnections(base).pairs) {
      this.adjacency.get(pair.a.partId)?.add(pair.b.partId)
      this.adjacency.get(pair.b.partId)?.add(pair.a.partId)
      this.markOccupied(pair)
    }
  }

  /**
   * Whether any of `partIds` ended up in the host part's connected component.
   *
   * Deliberately the same walk `connectedComponent` performs, over the same
   * graph, stopping as soon as the answer is known — the question is a boolean,
   * so enumerating the rest of a nine-hundred-part component is work nobody
   * reads. It runs against the overlay the collision gate just built, and falls
   * back to a derivation only when there was no overlay to build.
   */
  private joinsHost(next: ModelDocument, hostPartId: string, partIds: readonly string[]): boolean {
    const adjacency = this.lastCandidateAdjacency
    if (!adjacency) {
      const attached = connectedComponent(next, [hostPartId])
      return partIds.some((id) => attached.includes(id))
    }
    const wanted = new Set(partIds)
    if (wanted.has(hostPartId)) return true
    const seen = new Set([hostPartId])
    const queue = [hostPartId]
    for (let head = 0; head < queue.length; head += 1) {
      for (const neighbour of adjacency.get(queue[head]) ?? []) {
        if (seen.has(neighbour)) continue
        if (wanted.has(neighbour)) return true
        seen.add(neighbour)
        queue.push(neighbour)
      }
    }
    return false
  }

  /** Records both ends of a mated pair whose family accepts only one mate. */
  private markOccupied(pair: MatedPair) {
    if (isExclusiveFamily(pair.a.family)) this.occupied.add(`${pair.a.partId}/${pair.a.id}`)
    if (isExclusiveFamily(pair.b.family)) this.occupied.add(`${pair.b.partId}/${pair.b.id}`)
  }

  /** The document as realised so far, including the base. */
  get current(): ModelDocument {
    return this.document
  }

  /**
   * Realises whatever `graph` adds beyond what is already placed.
   *
   * `graph` is the *whole* accumulated graph, not a delta, so its invariants are
   * checked as a whole — a phase that attaches to a node an earlier phase failed
   * to place is caught here rather than producing a floating subassembly.
   */
  extend(graph: BuildGraph): RealizeResult {
    this.graph = graph
    const violations = validateGraph(this.graph)
    if (violations.length) {
      return {
        operations: [],
        document: this.document,
        nodes: [],
        edges: [],
        partCount: 0,
        truncated: false,
        notes: [],
        graphViolations: violations.map((violation) => `${violation.code}: ${violation.detail}`),
      }
    }

    for (const node of topologicalOrder(this.graph)) {
      throwIfAborted(this.options.signal, `realising node ${node.id}`)
      if (this.placed.has(node.id)) continue

      // A node that failed for a transient reason gets another go once a later
      // phase has added geometry.
      //
      // The phases build coarse to fine, and that ordering is the whole reason
      // a storey deck used to be impossible: `massingDelta` proposes the deck
      // of every level at once, so the deck for level 1 is attempted while the
      // walls of level 0 are still only a plan, and it is correctly refused for
      // hovering in mid-air. Without a retry that refusal was permanent — every
      // volume above the ground floor then failed with "its host node was not
      // placed", and a three-storey request came out one storey tall no matter
      // which strategy produced it.
      //
      // Retrying is safe because a retry is just another placement attempt
      // against the current document: it can only succeed where the kernel now
      // says yes. Terminal failures — a collision, an identity the catalog does
      // not have, an envelope breach — are not retried, so a doomed node is
      // still reported once rather than re-attempted every phase.
      const priorIndex = this.nodes.findIndex((outcome) => outcome.nodeId === node.id)
      if (priorIndex >= 0) {
        if (!this.nodes[priorIndex].retryable) continue
        this.nodes.splice(priorIndex, 1)
        const edgeIndex = this.edges.findIndex((outcome) => outcome.edgeId === incomingEdge(this.graph, node.id)?.id)
        if (edgeIndex >= 0) this.edges.splice(edgeIndex, 1)
      }
      if (node.kind === 'protected') {
        this.adoptProtected(node)
        continue
      }
      if (this.budgetExhausted()) {
        this.nodes.push({
          nodeId: node.id,
          kind: node.kind,
          status: 'skipped',
          partIds: [],
          reason: `the part budget was already spent (${this.placedPartCount()} placed)`,
        })
        this.truncated = true
        continue
      }
      const edge = incomingEdge(this.graph, node.id)
      if (node.kind === 'region') this.placeRegion(node, edge)
      else this.placePart(node, edge)
    }

    // The connection graph is part of the document, not something a consumer is
    // expected to re-infer. Build order, articulation and export all read
    // `document.connections`, so a preview that carries the base document's
    // (empty) edge set reports every part as an island — a model that is in fact
    // perfectly bonded would fail its own build-order check.
    this.document = {
      ...this.document,
      connections: deriveConnectionEdges(this.document, this.document.revision, 'snap'),
    }

    return {
      operations: this.operations,
      document: this.document,
      nodes: this.nodes,
      edges: this.edges,
      partCount: this.placedPartCount(),
      truncated: this.truncated,
      notes: this.notes,
      graphViolations: [],
    }
  }

  private placedPartCount(): number {
    let total = 0
    for (const outcome of this.nodes) {
      if (outcome.kind === 'protected') continue
      total += outcome.partIds.length
    }
    return total
  }

  private budgetExhausted(): boolean {
    return this.remainingBudget() <= 0
  }

  private remainingBudget(): number {
    const declared = this.constraints.partBudget ?? Number.POSITIVE_INFINITY
    return Math.max(0, Math.min(declared, MAX_GENERATED_PARTS) - this.placedPartCount())
  }

  private nextId(): string {
    this.counter += 1
    let candidate = `${this.idPrefix}_${String(this.counter).padStart(4, '0')}`
    while (this.document.parts[candidate]) {
      this.counter += 1
      candidate = `${this.idPrefix}_${String(this.counter).padStart(4, '0')}`
    }
    return candidate
  }

  /**
   * A subassembly per role, created before the parts that reference it.
   *
   * The kernel refuses a `part.add` naming a subassembly that does not exist, so
   * the operation list carries its own scaffolding rather than assuming the
   * document already has somewhere to put the result.
   */
  private ensureSubassembly(role: string): string {
    const id = `gen_${role.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'assembly'}`
    if (this.subassemblies.has(id)) return id
    const subassembly: Subassembly = {
      id,
      name: role.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 80) || 'Generated',
      partIds: [],
      locked: false,
      accent: accentFor(id),
    }
    this.operations.push({ type: 'subassembly.add', subassembly })
    this.document = { ...this.document, subassemblies: { ...this.document.subassemblies, [id]: subassembly } }
    this.subassemblies.add(id)
    return id
  }

  private adoptProtected(node: BuildNode) {
    const partId = node.existingPartId!
    const part = this.document.parts[partId]
    if (!part) {
      this.nodes.push({
        nodeId: node.id,
        kind: 'protected',
        status: 'rejected',
        partIds: [],
        reason: `protected part ${partId} is not in the base document`,
      })
      return
    }
    // Nothing is emitted for a protected node. It exists so an edge can attach
    // *to* it; the part itself is an input, and the outcome records that.
    this.placed.set(node.id, {
      node,
      partIds: [partId],
      originLdu: getPartBounds(part).min,
      definitionId: part.definitionId,
    })
    this.nodes.push({
      nodeId: node.id,
      kind: 'protected',
      status: 'realized',
      definitionId: part.definitionId,
      partIds: [partId],
    })
  }

  // -------------------------------------------------------------------------
  // Host connector resolution
  // -------------------------------------------------------------------------

  /**
   * Free connectors on a placed node that an edge's host reference could mean,
   * best first.
   *
   * Resolved across every part the node produced, in *world* space and against
   * the node's own origin corner. A region is a hundred bricks whose individual
   * positions were decided by the bond, so naming one of them would be naming a
   * planner implementation detail; naming a stud offset on the region is a
   * statement about the design that survives the planner changing its mind.
   *
   * Occupied exclusive connectors are removed here rather than left for the
   * solver to skip silently, so the first attempt is already one that can accept
   * something and a failure has a reason repair can name.
   */
  private hostConnectors(placed: PlacedNode, reference: ConnectorRef): HostConnector[] {
    // The node's own parts, not the document's. Asking `deriveConnections` for
    // every connector in the model and then discarding all but this node's cost
    // 22% of a candidate — a whole-model derivation, missing its identity memo
    // because the document object moves on every commit, to answer a question
    // about a hundred bricks. Occupancy is maintained on commit instead, so the
    // answer is the same one with none of the derivation.
    const pool: WorldConnector[] = []
    for (const partId of placed.partIds) {
      const part = this.document.parts[partId]
      if (!part) continue
      for (const connector of getWorldConnectors(part)) {
        if (connector.family !== reference.family) continue
        if (reference.gender && connector.gender !== reference.gender) continue
        if (this.occupied.has(`${connector.partId}/${connector.id}`)) continue
        pool.push(connector)
      }
    }
    if (pool.length < 2) return pool.map((connector) => ({ handle: `${connector.partId}/${connector.id}`, connector }))

    const byHandle = (a: WorldConnector, b: WorldConnector) =>
      `${a.partId}/${a.id}`.localeCompare(`${b.partId}/${b.id}`)
    const pick = reference.pick

    let ordered: WorldConnector[]
    if (pick.kind === 'index') {
      const sorted = [...pool].sort(byHandle)
      const offset = ((Math.trunc(pick.index) % sorted.length) + sorted.length) % sorted.length
      ordered = [...sorted.slice(offset), ...sorted.slice(0, offset)]
    } else if (pick.kind === 'extreme') {
      const sign = pick.sense === 'min' ? 1 : -1
      ordered = [...pool].sort(
        (a, b) => sign * (a.frame.position[pick.axis] - b.frame.position[pick.axis]) || byHandle(a, b),
      )
    } else {
      const targetU = placed.originLdu[0] + (pick.uStuds + 0.5) * STUD_LDU
      const targetV = placed.originLdu[2] + (pick.vStuds + 0.5) * STUD_LDU
      const levelled = filterToLevel(pool, pick.level, (connector) => connector.frame.position[1])
      ordered = [...levelled].sort(
        (a, b) =>
          Math.hypot(a.frame.position[0] - targetU, a.frame.position[2] - targetV) -
            Math.hypot(b.frame.position[0] - targetU, b.frame.position[2] - targetV) ||
          a.frame.position[1] - b.frame.position[1] ||
          byHandle(a, b),
      )
    }
    return ordered.map((connector) => ({ handle: `${connector.partId}/${connector.id}`, connector }))
  }

  // -------------------------------------------------------------------------
  // Single parts
  // -------------------------------------------------------------------------

  private placePart(node: BuildNode, edge: BuildEdge | null) {
    const resolution = resolvePartIdentity(node.part!)
    if (!resolution.definition) {
      this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason: resolution.explanation })
      if (edge) {
        this.edges.push({
          edgeId: edge.id,
          status: 'rejected',
          attempts: 0,
          reason: `the part it places could not be resolved: ${resolution.explanation}`,
        })
      }
      return
    }

    const colour = conformColour(node.colour, this.constraints.palette)
    if (!edge) {
      this.placeRootPart(node, resolution.definition, colour)
      return
    }

    const host = this.placed.get(edge.from)
    if (!host) {
      const reason = `its host node ${edge.from} was not placed`
      this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason })
      this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: 0, reason })
      return
    }

    const hosts = this.hostConnectors(host, edge.fromConnector)
    const attempts = this.attachmentAttempts(edge, hosts, resolution)
    if (!attempts.length) {
      const reason = this.describeMissingConnectors(edge, host, hosts.length, resolution.definition)
      this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason })
      this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: 0, reason })
      return
    }

    const byHandle = new Map(hosts.map((entry) => [entry.handle, entry.connector]))
    const log: string[] = []
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]
      const connector = byHandle.get(attempt.parentFeatureId)
      if (!connector) {
        log.push(`${attempt.kind}: host connector ${attempt.parentFeatureId} was no longer free`)
        continue
      }
      const outcome = this.trySingleAttachment(node, attempt, connector, colour)
      if (outcome.ok) {
        const status = attempt.kind === 'primary' ? 'realized' : 'repaired'
        const reason = status === 'repaired' ? `${log[0] ?? 'the requested attachment failed'}; ${attempt.description}` : undefined
        this.nodes.push({
          nodeId: node.id,
          kind: 'part',
          status,
          definitionId: attempt.definitionId,
          partIds: [outcome.partId],
          ...(reason ? { reason, attemptLog: log } : {}),
          ...(colour !== node.colour ? { colourSubstitutedFrom: node.colour } : {}),
        })
        this.edges.push({
          edgeId: edge.id,
          status,
          repairKind: attempt.kind,
          attempts: index + 1,
          hostConnector: attempt.parentFeatureId,
          childFeatureId: attempt.childFeatureId,
          simultaneousMates: outcome.simultaneousMates,
          ...(reason ? { reason, attemptLog: log } : {}),
        })
        return
      }
      log.push(`${attempt.kind}: ${outcome.reason}`)
    }

    const reason = `all ${attempts.length} attempt(s) failed; the requested attachment ${log[0] ?? 'could not be built'}`
    this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason, attemptLog: log })
    this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: attempts.length, reason, attemptLog: log })
  }

  private placeRootPart(node: BuildNode, definition: PartDefinition, colour: number) {
    const anchor = node.anchorLdu ?? [0, 0, 0]
    const subassemblyId = this.ensureSubassembly(node.role)
    const part: PartInstance = {
      id: this.nextId(),
      definitionId: definition.canonicalId,
      color: colour,
      transform: {
        position: [anchor[0], originForSurface(definition, anchor[1]), anchor[2]],
        basis: quarterTurnBasis(node.quarterTurns ?? 0),
      },
      subassemblyId,
      stepId: this.stepId,
      provenance: 'agent',
      protected: false,
    }
    const next = withParts(this.document, [part])
    const rejection = this.rejectionFor(next, [part.id])
    if (rejection) {
      this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason: rejection, retryable: this.lastRejectionRetryable })
      return
    }
    this.commit(next, [part])
    this.placed.set(node.id, {
      node,
      partIds: [part.id],
      originLdu: getPartBounds(part).min,
      definitionId: definition.canonicalId,
    })
    this.nodes.push({
      nodeId: node.id,
      kind: 'part',
      status: 'realized',
      definitionId: definition.canonicalId,
      partIds: [part.id],
      ...(colour !== node.colour ? { colourSubstitutedFrom: node.colour } : {}),
    })
  }

  private attachmentAttempts(
    edge: BuildEdge,
    hosts: readonly HostConnector[],
    resolution: IdentityResolution,
  ): AttachmentAttempt[] {
    if (!hosts.length) return []

    const candidates = [resolution.definition!, ...resolution.alternatives]
    const childFeatureIds = new Map<string, readonly string[]>()
    for (const candidate of candidates) {
      const features = orderFeatures(candidate, edge.toConnector).map((feature) => feature.id)
      if (features.length) childFeatureIds.set(candidate.canonicalId, features)
    }
    if (!childFeatureIds.has(resolution.definition!.canonicalId)) return []

    // Lattice alternatives are the remaining free connectors ranked by how far
    // they sit from the requested one, so "shift by a stud" comes before
    // "shift by four".
    const requested = hosts[0].connector.frame.position
    const lattice = hosts
      .slice(1)
      .slice()
      .sort(
        (a, b) =>
          Math.hypot(a.connector.frame.position[0] - requested[0], a.connector.frame.position[2] - requested[2]) -
            Math.hypot(b.connector.frame.position[0] - requested[0], b.connector.frame.position[2] - requested[2]) ||
          a.handle.localeCompare(b.handle),
      )
      .map((entry) => entry.handle)

    return enumerateAttachmentAttempts({
      seed: this.seed,
      budget: this.repairBudget,
      requestedDefinitionId: resolution.definition!.canonicalId,
      candidates,
      parentFeatureIds: hosts.map((entry) => entry.handle),
      childFeatureIds,
      quarterTurns: edge.quarterTurns ?? 0,
      latticeFeatureIds: lattice,
    })
  }

  private describeMissingConnectors(
    edge: BuildEdge,
    host: PlacedNode,
    freeHostConnectors: number,
    definition: PartDefinition,
  ): string {
    if (!freeHostConnectors) {
      return `every ${edge.fromConnector.family} connector on node ${host.node.id} is already mated or absent`
    }
    const childHas = definition.connectors.some((feature) => feature.family === edge.toConnector.family)
    if (!childHas) return `${definition.name} has no ${edge.toConnector.family} connector`
    return `no ${edge.toConnector.family} connector on ${definition.name} matched the requested gender`
  }

  private trySingleAttachment(
    node: BuildNode,
    attempt: AttachmentAttempt,
    hostConnector: WorldConnector,
    colour: number,
  ): { ok: true; partId: string; simultaneousMates: number } | { ok: false; reason: string } {
    const definition = getPartDefinition(attempt.definitionId)
    if (!definition) return { ok: false, reason: `${attempt.definitionId} vanished from the catalog` }

    const childFeature = definition.connectors.find((feature) => feature.id === attempt.childFeatureId)
    if (!childFeature) return { ok: false, reason: `${definition.name} has no ${attempt.childFeatureId} connector` }

    // The cursor is the identity mating: the child's own connector frame placed
    // exactly on the host's, spun by the requested quarter turns about the shared
    // axis. The solver treats it as intent, enumerates what the pair actually
    // permits, and ranks by simultaneous mates — which is what makes a 1 × 4
    // brick settle onto four studs rather than balance on the one named.
    const turns = ((attempt.quarterTurns % 4) + 4) % 4
    const spin = rotationAboutAxis([0, 1, 0], turns * (Math.PI / 2))
    const cursor = composeTransform(
      composeTransform(hostConnector.frame, spin),
      invertTransform(featureFrame(childFeature)),
    )

    const subassemblyId = this.ensureSubassembly(node.role)
    const candidate: PartInstance = {
      id: this.nextId(),
      definitionId: definition.canonicalId,
      color: colour,
      transform: cursor,
      subassemblyId,
      stepId: this.stepId,
      provenance: 'agent',
      protected: false,
    }

    const solved = findSnapCandidates(candidate, this.document, cursor, {
      targetPartIds: [hostConnector.partId],
      targetFeatureId: hostConnector.id,
      movingFeatureId: attempt.childFeatureId,
      radiusLdu: 32,
    })
    if (!solved.length) {
      return {
        ok: false,
        reason: `the solver found no mating between ${attempt.parentFeatureId} and ${definition.canonicalId}/${attempt.childFeatureId}`,
      }
    }

    let lastRejection: string | null = null
    for (const snap of solved) {
      const placed: PartInstance = { ...candidate, transform: snap.transform }
      const next = withParts(this.document, [placed])
      const rejection = this.rejectionFor(next, [placed.id])
      if (rejection) {
        lastRejection = rejection
        continue
      }
      this.commit(next, [placed])
      this.placed.set(node.id, {
        node,
        partIds: [placed.id],
        originLdu: getPartBounds(placed).min,
        definitionId: definition.canonicalId,
      })
      return { ok: true, partId: placed.id, simultaneousMates: snap.simultaneousMatches }
    }

    return { ok: false, reason: lastRejection ?? `the solver found no collision-free mating between ${attempt.parentFeatureId} and ${definition.canonicalId}/${attempt.childFeatureId}` }
  }

  // -------------------------------------------------------------------------
  // Regions
  // -------------------------------------------------------------------------

  private placeRegion(node: BuildNode, edge: BuildEdge | null) {
    const colour = conformColour(node.colour, this.constraints.palette)
    const subassemblyId = this.ensureSubassembly(node.role)

    let hosts: HostConnector[] = []
    if (edge) {
      const host = this.placed.get(edge.from)
      if (!host) {
        const reason = `its host node ${edge.from} was not placed`
        this.nodes.push({ nodeId: node.id, kind: 'region', status: 'rejected', partIds: [], reason, retryable: true })
        this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: 0, reason })
        return
      }
      hosts = this.hostConnectors(host, edge.fromConnector)
      if (!hosts.length) {
        const reason = `no free ${edge.fromConnector.family} connector remains on node ${edge.from}`
        this.nodes.push({ nodeId: node.id, kind: 'region', status: 'rejected', partIds: [], reason })
        this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: 0, reason })
        return
      }
    }

    const extraOffsetSteps: Array<readonly [number, number]> = []
    if (hosts.length > 1) {
      const primary = hosts[0]!.connector.frame.position
      // Defaults already cover ±1/±2; extra slides are remaining host studs
      // farther away. Cap so they cannot consume the shrink-footprint budget.
      const seen = new Set(['0,0', '1,0', '-1,0', '0,1', '0,-1', '2,0', '-2,0', '0,2', '0,-2'])
      for (const host of hosts.slice(1)) {
        if (extraOffsetSteps.length >= 8) break
        const du = Math.round((host.connector.frame.position[0] - primary[0]) / STUD_LDU)
        const dv = Math.round((host.connector.frame.position[2] - primary[2]) / STUD_LDU)
        const key = `${du},${dv}`
        if (seen.has(key)) continue
        seen.add(key)
        extraOffsetSteps.push([du, dv])
      }
    }
    const attempts = enumerateRegionAttempts({
      seed: this.seed,
      budget: this.repairBudget,
      region: node.region!,
      parentFeatureIds: hosts.map((entry) => entry.handle),
      alternateFamilies: SUBSTITUTE_FAMILIES,
      extraOffsetSteps,
    })

    const byHandle = new Map(hosts.map((entry) => [entry.handle, entry.connector]))
    const log: string[] = []
    let transient = false
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]
      const connector = attempt.parentFeatureId ? byHandle.get(attempt.parentFeatureId) : null
      if (attempt.parentFeatureId && !connector) {
        log.push(`${attempt.kind}: host connector ${attempt.parentFeatureId} was no longer free`)
        continue
      }
      const outcome = this.tryRegion(node, attempt, connector ?? null, colour, subassemblyId)
      if (outcome.ok) {
        transient = false
        const status = attempt.kind === 'primary' ? 'realized' : 'repaired'
        const reason = status === 'repaired' ? `${log[0] ?? 'the requested region failed'}; ${attempt.description}` : undefined
        this.nodes.push({
          nodeId: node.id,
          kind: 'region',
          status,
          partIds: outcome.partIds,
          ...(reason ? { reason, attemptLog: log } : {}),
          ...(colour !== node.colour ? { colourSubstitutedFrom: node.colour } : {}),
        })
        if (edge) {
          this.edges.push({
            edgeId: edge.id,
            status,
            repairKind: attempt.kind,
            attempts: index + 1,
            ...(attempt.parentFeatureId ? { hostConnector: attempt.parentFeatureId } : {}),
            ...(reason ? { reason, attemptLog: log } : {}),
          })
        }
        for (const warning of outcome.warnings) this.notes.push(`${node.id}: ${warning}`)
        return
      }
      log.push(`${attempt.kind}: ${outcome.reason}`)
      if (outcome.retryable) transient = true
    }

    const reason = `all ${attempts.length} attempt(s) failed; the requested region ${log[0] ?? 'could not be built'}`
    this.nodes.push({ nodeId: node.id, kind: 'region', status: 'rejected', partIds: [], reason, attemptLog: log, retryable: transient })
    if (edge) this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: attempts.length, reason, attemptLog: log })
  }

  private tryRegion(
    node: BuildNode,
    attempt: RegionAttempt,
    hostConnector: WorldConnector | null,
    colour: number,
    subassemblyId: string,
  ): { ok: true; partIds: string[]; warnings: string[] } | { ok: false; reason: string; retryable?: boolean } {
    const region = attempt.region
    const offset = region.offsetStuds ?? [0, 0]
    let origin: Vec3
    if (hostConnector) {
      // The planner's origin is a *corner*: minimum X, minimum Z, and the surface
      // Y the first course rests on. A stud connector sits at the centre of its
      // stud, so half a stud comes back off in each horizontal axis or the whole
      // region lands offset by half a pitch and mates with nothing.
      origin = [
        hostConnector.frame.position[0] - STUD_LDU / 2 + offset[0] * STUD_LDU,
        hostConnector.frame.position[1],
        hostConnector.frame.position[2] - STUD_LDU / 2 + offset[1] * STUD_LDU,
      ]
    } else {
      const anchor = node.anchorLdu ?? [0, 0, 0]
      origin = [anchor[0] + offset[0] * STUD_LDU, anchor[1], anchor[2] + offset[1] * STUD_LDU]
    }

    let plan: AssemblyPlan
    try {
      plan = this.planRegion(region, origin, colour, subassemblyId)
    } catch (cause) {
      if (cause instanceof AssemblyError) return { ok: false, reason: `${cause.message} ${cause.repair}` }
      // A mechanism the compiled catalog cannot build is a missing part, not a
      // broken candidate: the node is skipped with the reason recorded and the
      // rest of the model still gets built. A ramp nobody has geometry for
      // should not cost the builder the freighter.
      if (cause instanceof MechanismGeometryError) return { ok: false, reason: `${cause.message} ${cause.repair}` }
      throw cause
    }

    const parts = plan.operations
      .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
      .map((operation) => operation.part)
    if (!parts.length) return { ok: false, reason: 'the planner produced no parts for that footprint' }

    const remaining = this.remainingBudget()
    if (parts.length > remaining) {
      // The ceiling stopped this, not the geometry. Recorded as truncation so
      // the candidate can report what is left to build rather than presenting a
      // fragment as if it were the whole answer — a region too big to fit and a
      // region skipped after the budget ran out are the same situation.
      this.truncated = true
      return { ok: false, reason: `it needs ${parts.length} parts and only ${remaining} remain in the budget` }
    }

    // Planner ids come from `createId`, which is random by design. Reproducibility
    // is a hard requirement here, so they are replaced by the deterministic
    // sequence; the planner's own ordering is already deterministic, so
    // index-by-index replacement is stable.
    const renamed = parts.map((part) => ({ ...part, id: this.nextId(), provenance: 'agent' as const }))
    const next = withParts(this.document, renamed)
    const partIds = renamed.map((part) => part.id)

    const rejection = this.rejectionFor(next, partIds)
    if (rejection) return { ok: false, reason: rejection, retryable: this.lastRejectionRetryable }

    if (hostConnector && !this.joinsHost(next, hostConnector.partId, partIds)) {
      return {
        ok: false,
        reason: 'the region landed clear of its host: none of its parts mate with anything already built',
        retryable: true,
      }
    }

    this.commit(next, renamed)
    this.placed.set(node.id, { node, partIds, originLdu: origin, definitionId: renamed[0].definitionId })
    return { ok: true, partIds, warnings: plan.warnings }
  }

  private planRegion(region: RegionIntent, origin: Vec3, colour: number, subassemblyId: string): AssemblyPlan {
    const base = {
      origin,
      color: colour,
      subassemblyId,
      stepId: this.stepId,
      actor: 'agent' as const,
      family: region.family,
      // Window and door frames default to white trim and trans-clear glazing,
      // which is right for a real facade and wrong for a build under a hard
      // palette: two parts nobody chose would put the whole candidate outside
      // the colours the brief asked for.
      trimColor: conformColour(DEFAULT_TRIM_COLOR, this.constraints.palette),
      glassColor: conformColour(DEFAULT_GLASS_COLOR, this.constraints.palette),
    }
    if (region.shape === 'wall') {
      return planWall({
        ...base,
        depthStuds: Math.max(1, Math.trunc(region.thicknessStuds ?? 1)),
        axis: region.axis ?? 'x',
        lengthStuds: Math.max(1, Math.trunc(region.widthStuds)),
        courses: Math.max(1, Math.trunc(region.courses)),
        ...(region.openings?.length ? { openings: region.openings } : {}),
      })
    }
    if (region.shape === 'enclosure') {
      return planEnclosure({
        ...base,
        depthStuds: Math.max(1, Math.trunc(region.thicknessStuds ?? 1)),
        widthStuds: Math.max(1, Math.trunc(region.widthStuds)),
        footprintDepthStuds: Math.max(1, Math.trunc(region.depthStuds)),
        courses: Math.max(1, Math.trunc(region.courses)),
        floor: region.floor ?? false,
        ...(region.openings?.length ? { openings: region.openings } : {}),
      })
    }
    if (region.shape === 'hinged-flap') {
      return planHingedFlap({
        ...base,
        // The planner rounds up to whole 1 x 2 hinge bricks, so an odd width
        // here would silently become a wider flap than the graph asked for.
        widthStuds: Math.max(2, Math.trunc(region.widthStuds / 2) * 2),
        reachStuds: Math.max(1, Math.trunc(region.reachStuds ?? region.depthStuds)),
      })
    }

    // Sol-1's mechanism planners take their origin under a different name and
    // do not take a brick family; everything else about the seam is the same.
    const mechanismBase = {
      originLdu: origin,
      color: colour,
      subassemblyId,
      stepId: this.stepId,
      actor: 'agent' as const,
    }
    if (region.shape === 'lattice') {
      const bay = Math.max(2, Math.trunc(region.bayStuds ?? 4))
      const fit = (studs: number) => Math.max(bay + 1, Math.round((studs - 1) / bay) * bay + 1)
      return planLattice({
        ...mechanismBase,
        widthStuds: fit(Math.trunc(region.widthStuds)),
        depthStuds: fit(Math.trunc(region.depthStuds)),
        heightCourses: Math.max(1, Math.min(16, Math.trunc(region.courses))),
        bayStuds: bay,
      })
    }
    if (region.shape === 'snot-hull') {
      return planSnotHull({
        ...mechanismBase,
        widthStuds: Math.max(3, Math.min(32, Math.trunc(region.widthStuds))),
        depthStuds: Math.max(3, Math.min(32, Math.trunc(region.depthStuds))),
        layers: Math.max(1, Math.min(2, Math.trunc(region.layers ?? 1))),
      })
    }
    if (region.shape === 'crane') {
      return planCrane({ ...mechanismBase, boomStuds: Math.max(2, Math.min(64, Math.trunc(region.boomStuds ?? region.widthStuds))) })
    }
    if (region.shape === 'clock-faces') {
      return planClockFaces({
        ...mechanismBase,
        diameterStuds: Math.max(4, Math.min(16, Math.trunc(region.diameterStuds ?? region.widthStuds))),
      })
    }

    return planBrickField({
      ...base,
      // A field picks its own row depth from the pack; forcing one would reject
      // footprints the planner can cover perfectly well.
      depthStuds: undefined,
      widthStuds: Math.max(1, Math.trunc(region.widthStuds)),
      footprintDepthStuds: Math.max(1, Math.trunc(region.depthStuds)),
      layers: Math.max(1, Math.min(2, Math.trunc(region.courses))),
    })
  }

  // -------------------------------------------------------------------------
  // Shared gates
  // -------------------------------------------------------------------------

  /**
   * Everything that can veto a placement, in the order that names the cause best.
   *
   * Collisions come first because they are the only physical fact here; the rest
   * are declared design limits, and reporting "it collides" for something that
   * merely left the envelope would send repair after the wrong problem.
   */
  /**
   * Set by `rejectionFor` when the reason it returned is transient.
   *
   * Carried on the instance rather than in the return type because
   * `rejectionFor` has eight call sites that all treat its result as "a string
   * or null", and widening that shape everywhere to move one boolean would be a
   * worse trade than reading it immediately after the call, which is what every
   * caller does.
   */
  private lastRejectionRetryable = false

  /**
   * The committed connector state with an uncommitted placement overlaid.
   *
   * Copy-on-write, and only where it must be: the outer adjacency map is rebuilt
   * (a thousand references, microseconds) and only the sets of the new parts and
   * their direct mates are copied, so a candidate that is thrown away cannot
   * have mutated the committed state.
   *
   * A region is a hundred bricks landing at once, and the committed index knows
   * nothing about the mates *among* them — which is why this used to refuse
   * anything but a single part and let the whole document be re-derived instead.
   * Understating a region's own bond is not a rounding error: for the hovering
   * verdict it calls a properly bonded wall unclutched, and for the collision
   * check it reports the wall's own legitimate stud overlaps as intersections.
   *
   * So the missing half is supplied rather than paid for. A throwaway index
   * holding only the new parts answers new-to-new; the committed index answers
   * new-to-committed. Together they cover every pair with a new part on at least
   * one side, which is exactly the set `findCollisions` looks at under
   * `onlyPartIds` and the only set either consumer can ask about. Cost is
   * proportional to the parts that just landed instead of to the whole model:
   * measured across six briefs, 10.6 s of derivation became 0.6 s.
   */
  private candidateConnectors(
    next: ModelDocument,
    newPartIds: readonly string[],
  ): { adjacency: Map<string, Set<string>>; mates: Map<string, MatedPair[]> } | null {
    if (!newPartIds.length) return null
    for (const partId of newPartIds) {
      if (!next.parts[partId] || this.adjacency.has(partId)) return null
    }

    // Indexed as the loop advances rather than all at once, so a new part is
    // only ever queried against the new parts *before* it. Each new-to-new pair
    // is then found exactly once instead of once from each end, which halves the
    // query work and leaves nothing to deduplicate.
    const amongNew = newPartIds.length > 1 ? new IncrementalConnectorWorld() : null

    const mates = new Map<string, MatedPair[]>()
    const adjacency = new Map<string, Set<string>>(this.adjacency)
    const copied = new Set<string>()
    const linksOf = (partId: string): Set<string> => {
      if (!copied.has(partId)) {
        adjacency.set(partId, new Set(this.adjacency.get(partId) ?? []))
        copied.add(partId)
      }
      return adjacency.get(partId)!
    }
    // Present even with no mates: an unattached new part has to read as
    // unclutched rather than as absent from the graph.
    for (const partId of newPartIds) linksOf(partId)

    for (const partId of newPartIds) {
      const found = amongNew
        ? [...this.world.matesFor(partId, next), ...amongNew.matesFor(partId, next)]
        : this.world.matesFor(partId, next)
      for (const pair of found) {
        const other = pair.a.partId === partId ? pair.b.partId : pair.a.partId
        linksOf(partId).add(other)
        linksOf(other).add(partId)
        const key = partId < other ? `${partId}|${other}` : `${other}|${partId}`
        // Every mate between the pair is kept, not just the first: the clearance
        // the overlap has to fit inside is the most generous of them.
        const list = mates.get(key)
        if (list) list.push(pair)
        else mates.set(key, [pair])
      }
      amongNew?.sync(next, [partId])
    }

    return { adjacency, mates }
  }

  /**
   * The overlay `rejectionFor` built, for the one caller that needs it again.
   *
   * `tryRegion` asks a second question about the same candidate document —
   * whether the region actually reached its host — and answering it through
   * `connectedComponent` re-derived the whole connection graph for a walk over
   * the graph the gate had just finished assembling. Nine percent of a
   * candidate. Handed over the same way `lastRejectionRetryable` is, for the
   * same reason: one field beats widening a return type that eight call sites
   * read as "a string or null". Null when the overlay could not be built, which
   * is the case that still needs the derivation.
   */
  private lastCandidateAdjacency: PartAdjacency | null = null

  private rejectionFor(next: ModelDocument, newPartIds: readonly string[]): string | null {
    this.lastRejectionRetryable = false
    const connectors = this.candidateConnectors(next, newPartIds)
    this.lastCandidateAdjacency = connectors?.adjacency ?? null
    const collisions = findCollisions(next, {
      provide: this.provide,
      onlyPartIds: [...newPartIds],
      ...(connectors ? { mates: connectors.mates } : {}),
    })
    if (collisions.length) {
      const introduced = new Set(newPartIds)
      const first = collisions[0]
      const other = introduced.has(first.partA) && !introduced.has(first.partB) ? first.partB : first.partA
      return `it collides with ${other} (${first.certainty} verdict, ${collisions.length} contact${collisions.length === 1 ? '' : 's'})`
    }
    // One scoped pass rather than three whole-document ones. `hoverVerdictFor`
    // is defined to be the same answer restricted to these parts, and
    // `validation.scoped.test.ts` holds that by running both and comparing —
    // which matters here, because this is the check that decides whether a
    // generated model is buildable.
    const verdict = hoverVerdictFor(next, newPartIds, connectors?.adjacency)
    const hovering = [...new Set([...verdict.floating, ...verdict.airborne])]
    if (hovering.length) {
      // Retryable: what this needed underneath it may simply not have been
      // built yet. This is the exact failure that used to cost every model its
      // upper storeys.
      this.lastRejectionRetryable = true
      return `it would hover with no clutch and no ground under ${hovering[0]} (${hovering.length} floating part${hovering.length === 1 ? '' : 's'})`
    }
    if (verdict.unclutchedRests.length) {
      this.lastRejectionRetryable = true
      return `it would rest ${verdict.unclutchedRests[0].partId} on another part without clutching`
    }
    const envelope = checkEnvelope(next, this.constraints.envelopeStuds)
    if (!envelope.ok) return envelope.detail!
    return null
  }

  private commit(next: ModelDocument, parts: readonly PartInstance[]) {
    // Membership kept in step with the parts, not left for the command bus to
    // reconcile on apply. Everything downstream of a candidate — the scorer,
    // the Compare dialog, the subassembly the agent is told to lock — reads
    // this preview document, and one that lists empty assemblies while its
    // parts point at them describes a model nobody would get.
    const subassemblies = { ...next.subassemblies }
    for (const part of parts) {
      const owner = subassemblies[part.subassemblyId]
      if (owner) subassemblies[part.subassemblyId] = { ...owner, partIds: [...owner.partIds, part.id] }
    }
    this.document = { ...next, subassemblies }
    for (const part of parts) this.operations.push({ type: 'part.add', part })
    // Index every new part before asking any of them for mates, so parts that
    // landed together can see each other. One at a time would miss a region's
    // internal bond, which is what decides whether the region is clutched.
    for (const part of parts) {
      if (!this.adjacency.has(part.id)) this.adjacency.set(part.id, new Set())
    }
    this.world.sync(this.document, parts.map((part) => part.id))
    for (const part of parts) {
      for (const pair of this.world.matesFor(part.id, this.document)) {
        const other = pair.a.partId === part.id ? pair.b.partId : pair.a.partId
        this.adjacency.get(part.id)?.add(other)
        this.adjacency.get(other)?.add(part.id)
        this.markOccupied(pair)
      }
    }
  }
}

/** Deterministic accent so a generated subassembly is distinguishable in the UI. */
function accentFor(id: string): string {
  let hue = 0
  for (let index = 0; index < id.length; index += 1) hue = (hue * 31 + id.charCodeAt(index)) % 360
  const rgb = hslToRgb(hue / 360, 0.52, 0.6)
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const secondary = chroma * (1 - Math.abs(((h * 6) % 2) - 1))
  const match = l - chroma / 2
  const sector = Math.floor(h * 6) % 6
  const table: Array<[number, number, number]> = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ]
  const [r, g, b] = table[sector]
  return [Math.round((r + match) * 255), Math.round((g + match) * 255), Math.round((b + match) * 255)]
}

/** Basis for whole quarter turns about the vertical axis. */
function quarterTurnBasis(quarterTurns: number): PartInstance['transform']['basis'] {
  const turns = ((Math.trunc(quarterTurns) % 4) + 4) % 4
  if (turns === 0) return IDENTITY_BASIS
  return rotationAboutAxis([0, 1, 0], turns * (Math.PI / 2)).basis
}

/** The parts a realise result introduced, in placement order. */
export const realizedParts = (result: RealizeResult): PartInstance[] =>
  result.operations
    .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
    .map((operation) => operation.part)

/** Measured extent in studs, using the same measurement the envelope gate uses. */
export const measuredExtentStuds = (document: ModelDocument): [number, number, number] => {
  const size = getDocumentBounds(document).size
  return [size[0] / STUD_LDU, size[1] / STUD_LDU, size[2] / STUD_LDU]
}
