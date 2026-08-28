import {
  AssemblyError,
  DEFAULT_GLASS_COLOR,
  DEFAULT_TRIM_COLOR,
  MAX_GENERATED_PARTS,
  planBrickField,
  planEnclosure,
  planWall,
  type AssemblyPlan,
  type BrickFamily,
} from '../cad/assembly'
import { catalog, getPartDefinition, originForSurface, searchCatalog, STUD_LDU } from '../cad/catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from '../cad/collision'
import { featureFrame } from '../cad/connections'
import { getDocumentBounds, getPartBounds } from '../cad/geometry'
import { composeTransform, invertTransform, rotationAboutAxis, IDENTITY_BASIS } from '../cad/math'
import { deriveConnections, findSnapCandidates, type WorldConnector } from '../cad/snapping'
import type {
  CadOperation,
  ModelDocument,
  PartDefinition,
  PartInstance,
  Subassembly,
  Vec3,
} from '../cad/types'
import { connectedComponent } from '../cad/validation'
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
      if (this.placed.has(node.id) || this.nodes.some((outcome) => outcome.nodeId === node.id)) continue
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
    const owned = new Set(placed.partIds)
    const world = deriveConnections(this.document)
    const pool = world.connectors.filter(
      (connector) =>
        owned.has(connector.partId) &&
        connector.family === reference.family &&
        (!reference.gender || connector.gender === reference.gender) &&
        !world.occupied.has(`${connector.partId}/${connector.id}`),
    )
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
      this.nodes.push({ nodeId: node.id, kind: 'part', status: 'rejected', partIds: [], reason: rejection })
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

    const best = solved[0]
    const placed: PartInstance = { ...candidate, transform: best.transform }
    const next = withParts(this.document, [placed])
    const rejection = this.rejectionFor(next, [placed.id])
    if (rejection) return { ok: false, reason: rejection }

    this.commit(next, [placed])
    this.placed.set(node.id, {
      node,
      partIds: [placed.id],
      originLdu: getPartBounds(placed).min,
      definitionId: definition.canonicalId,
    })
    return { ok: true, partId: placed.id, simultaneousMates: best.simultaneousMatches }
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
        this.nodes.push({ nodeId: node.id, kind: 'region', status: 'rejected', partIds: [], reason })
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

    const attempts = enumerateRegionAttempts({
      seed: this.seed,
      budget: this.repairBudget,
      region: node.region!,
      parentFeatureIds: hosts.map((entry) => entry.handle),
      alternateFamilies: SUBSTITUTE_FAMILIES,
    })

    const byHandle = new Map(hosts.map((entry) => [entry.handle, entry.connector]))
    const log: string[] = []
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]
      const connector = attempt.parentFeatureId ? byHandle.get(attempt.parentFeatureId) : null
      if (attempt.parentFeatureId && !connector) {
        log.push(`${attempt.kind}: host connector ${attempt.parentFeatureId} was no longer free`)
        continue
      }
      const outcome = this.tryRegion(node, attempt, connector ?? null, colour, subassemblyId)
      if (outcome.ok) {
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
    }

    const reason = `all ${attempts.length} attempt(s) failed; the requested region ${log[0] ?? 'could not be built'}`
    this.nodes.push({ nodeId: node.id, kind: 'region', status: 'rejected', partIds: [], reason, attemptLog: log })
    if (edge) this.edges.push({ edgeId: edge.id, status: 'rejected', attempts: attempts.length, reason, attemptLog: log })
  }

  private tryRegion(
    node: BuildNode,
    attempt: RegionAttempt,
    hostConnector: WorldConnector | null,
    colour: number,
    subassemblyId: string,
  ): { ok: true; partIds: string[]; warnings: string[] } | { ok: false; reason: string } {
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
      throw cause
    }

    const parts = plan.operations
      .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
      .map((operation) => operation.part)
    if (!parts.length) return { ok: false, reason: 'the planner produced no parts for that footprint' }

    const remaining = this.remainingBudget()
    if (parts.length > remaining) {
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
    if (rejection) return { ok: false, reason: rejection }

    if (hostConnector) {
      const attached = connectedComponent(next, [hostConnector.partId])
      const joined = partIds.filter((id) => attached.includes(id)).length
      if (joined === 0) {
        return {
          ok: false,
          reason: 'the region landed clear of its host: none of its parts mate with anything already built',
        }
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
  private rejectionFor(next: ModelDocument, newPartIds: readonly string[]): string | null {
    const collisions = findCollisions(next, { provide: this.provide, onlyPartIds: [...newPartIds] })
    if (collisions.length) {
      const introduced = new Set(newPartIds)
      const first = collisions[0]
      const other = introduced.has(first.partA) && !introduced.has(first.partB) ? first.partB : first.partA
      return `it collides with ${other} (${first.certainty} verdict, ${collisions.length} contact${collisions.length === 1 ? '' : 's'})`
    }
    const envelope = checkEnvelope(next, this.constraints.envelopeStuds)
    if (!envelope.ok) return envelope.detail!
    return null
  }

  private commit(next: ModelDocument, parts: readonly PartInstance[]) {
    this.document = next
    for (const part of parts) this.operations.push({ type: 'part.add', part })
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
