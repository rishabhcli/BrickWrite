import { hash32, stableStringify } from '../platform/contracts'
import { STUD_LDU } from '../cad/catalog'
import type { BrickFamily, Opening } from '../cad/assembly'
import type { ConnectionFamily, Vec3 } from '../cad/types'

/**
 * The build graph: what a generator is allowed to propose.
 *
 * A candidate is never a list of guessed world coordinates. Coordinates are the
 * one thing a language model cannot produce reliably and the one thing the
 * kernel can produce exactly, so the two are separated: the proposer works in
 * *structure* — "a 1 × 4 brick, attached by its third anti-stud to the stud at
 * (2, 0) on that plate" — and `realize.ts` turns each of those statements into a
 * pose by running the real snap solver.
 *
 * Everything here is therefore intentionally coordinate-free apart from two
 * places where a number in LDU is the honest answer: a root node's anchor (a
 * build has to start somewhere on the ground plane) and a region's stud-space
 * footprint (a wall is a wall because it is nine studs long).
 */

export type NodeKind =
  /** One catalog identity, placed by solving its incoming attachment. */
  | 'part'
  /** A parametric fill realised by `src/cad/assembly.ts` — a wall, deck or storey. */
  | 'region'
  /** An existing document part the generator must treat as immovable. */
  | 'protected'

/**
 * What identity a node wants, in the terms a person would use.
 *
 * Resolved through `searchCatalog` against the compiled pack, never invented:
 * an intent that matches nothing placeable is reported as unresolvable rather
 * than substituted with something that happens to be nearby.
 */
export interface PartIntent {
  readonly query: string
  /** Exact identity, when the proposer already knows one. Still tier-checked. */
  readonly definitionId?: string
  readonly category?: string
  /** Wanted envelope in studs, [width, height, depth]; partial values allowed. */
  readonly sizeStuds?: readonly [number | null, number | null, number | null]
  /** Families the identity has to carry for the attachment to be possible. */
  readonly connectorFamilies?: readonly ConnectionFamily[]
}

/**
 * A parametric fill.
 *
 * Regions are axis-aligned in document space because the planners they delegate
 * to are: `planWall` runs along X or Z, and `planEnclosure` and `planBrickField`
 * lay rectangles. A rotated region is not expressible and is not pretended to be.
 */
export interface RegionIntent {
  readonly shape: 'field' | 'wall' | 'enclosure'
  readonly widthStuds: number
  /** Footprint depth. A wall's own run is `widthStuds`; this is ignored for one. */
  readonly depthStuds: number
  /** Courses for a wall or enclosure; layers for a field. */
  readonly courses: number
  readonly family: BrickFamily
  /** Wall thickness in studs, for walls and enclosures. Defaults to 1. */
  readonly thicknessStuds?: number
  /** Which way a wall runs. Ignored by fields and enclosures. */
  readonly axis?: 'x' | 'z'
  /** Lay a plate deck under an enclosure's walls. */
  readonly floor?: boolean
  readonly openings?: readonly Opening[]
  /**
   * Stud offset of the region's minimum corner from the attachment connector.
   *
   * The connector fixes one stud; a region has to say which of its own studs
   * that is. `[-3, -2]` centres a 6 × 4 footprint on it.
   */
  readonly offsetStuds?: readonly [number, number]
}

export interface BuildNode {
  readonly id: string
  readonly kind: NodeKind
  /** LDraw colour code. Checked against the brief palette before placement. */
  readonly colour: number
  /** Free-form label — 'chassis', 'skin', 'greeble' — carried into subassemblies. */
  readonly role: string
  readonly part?: PartIntent
  readonly region?: RegionIntent
  /** Root nodes only: where the build starts, in document LDU. */
  readonly anchorLdu?: Vec3
  /** Quarter turns about the attachment axis, applied before solving. */
  readonly quarterTurns?: number
  /** Protected nodes only: the existing part this node stands for. */
  readonly existingPartId?: string
}

/**
 * Which connector on a part an edge means.
 *
 * A proposer does not know LDCad feature ids, and hard-coding them would tie a
 * graph to one catalog build. Each selector is a rule the realiser evaluates
 * against the compiled connector list, and every rule is total: it produces a
 * fully ordered list, so "the next one" is always defined and repair has
 * somewhere to go.
 */
export type ConnectorPick =
  /**
   * Stud coordinates from the node's minimum corner, on the mating plane.
   *
   * `level` narrows the search to the highest or lowest plane of matching
   * connectors first. Without it, a stud at the bottom of a wall and one at the
   * top are the same distance away in plan and the choice between them falls to
   * a tie-break — which is how a second storey ends up inside the first.
   */
  | {
      readonly kind: 'grid'
      readonly uStuds: number
      readonly vStuds: number
      readonly level?: 'top' | 'bottom'
    }
  /** The connector furthest along a local axis. 0 = X, 1 = Y, 2 = Z. */
  | { readonly kind: 'extreme'; readonly axis: 0 | 1 | 2; readonly sense: 'min' | 'max' }
  /** Position in the family's id-sorted list, wrapped. */
  | { readonly kind: 'index'; readonly index: number }

export interface ConnectorRef {
  readonly family: ConnectionFamily
  readonly gender?: 'male' | 'female' | 'neutral'
  readonly pick: ConnectorPick
}

export interface BuildEdge {
  readonly id: string
  /** Node already placed when this edge is resolved. */
  readonly from: string
  /** Node this edge places. */
  readonly to: string
  readonly fromConnector: ConnectorRef
  readonly toConnector: ConnectorRef
  readonly family: ConnectionFamily
  readonly quarterTurns?: number
}

export interface BuildGraph {
  readonly version: 1
  /** Named structural approach, e.g. 'framed-shell'. Part of the hash. */
  readonly strategy: string
  readonly nodes: readonly BuildNode[]
  readonly edges: readonly BuildEdge[]
}

export interface GraphViolation {
  readonly code:
    | 'DUPLICATE_NODE'
    | 'UNKNOWN_ENDPOINT'
    | 'SELF_EDGE'
    | 'MULTIPLE_PARENTS'
    | 'CYCLE'
    | 'ROOT_WITHOUT_ANCHOR'
    | 'MISSING_INTENT'
    | 'PROTECTED_WRITE'
    | 'INCOMPATIBLE_FAMILIES'
  readonly detail: string
  readonly nodeId?: string
  readonly edgeId?: string
}

/**
 * Families that can legally mate, mirroring `connectorsCompatible`.
 *
 * Duplicated here deliberately: graph validation runs before any catalog lookup
 * and has no connector instances to hand, so it needs the family-level rule on
 * its own. The kernel remains the authority — a pair that passes here is still
 * rejected by the solver if the actual connectors do not mate.
 */
const COMPATIBLE_FAMILY_PAIRS = new Set([
  'anti-stud:stud',
  'pin:pin-hole',
  'axle:axle-hole',
  'bar:clip',
  'ball:socket',
  'hinge:hinge',
  'generic:generic',
])

export const familiesCanMate = (a: ConnectionFamily, b: ConnectionFamily): boolean =>
  COMPATIBLE_FAMILY_PAIRS.has([a, b].sort().join(':'))

/**
 * Structural invariants, checked before anything is placed.
 *
 * The one that carries the most weight is single-parent: a node's pose comes
 * from exactly one solved attachment. Two incoming edges would be two
 * independent claims on the same six degrees of freedom, and the realiser would
 * have to silently prefer one. Extra contact is not lost by this rule — the snap
 * solver *discovers* every simultaneous mate at the solved pose and the kernel
 * records all of them as connection edges, so a brick that lands on eight studs
 * is joined to all eight regardless of which one the graph named.
 */
export function validateGraph(graph: BuildGraph): GraphViolation[] {
  const violations: GraphViolation[] = []
  const byId = new Map<string, BuildNode>()

  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      violations.push({ code: 'DUPLICATE_NODE', detail: `Node id ${node.id} appears more than once.`, nodeId: node.id })
      continue
    }
    byId.set(node.id, node)
    if (node.kind === 'part' && !node.part) {
      violations.push({ code: 'MISSING_INTENT', detail: `Part node ${node.id} carries no part intent.`, nodeId: node.id })
    }
    if (node.kind === 'region' && !node.region) {
      violations.push({ code: 'MISSING_INTENT', detail: `Region node ${node.id} carries no region intent.`, nodeId: node.id })
    }
    if (node.kind === 'protected' && !node.existingPartId) {
      violations.push({ code: 'MISSING_INTENT', detail: `Protected node ${node.id} names no existing part.`, nodeId: node.id })
    }
  }

  const parents = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) {
      violations.push({
        code: 'UNKNOWN_ENDPOINT',
        detail: `Edge ${edge.id} references ${byId.has(edge.from) ? edge.to : edge.from}, which is not a node.`,
        edgeId: edge.id,
      })
      continue
    }
    if (edge.from === edge.to) {
      violations.push({ code: 'SELF_EDGE', detail: `Edge ${edge.id} attaches ${edge.from} to itself.`, edgeId: edge.id })
      continue
    }
    if (byId.get(edge.to)!.kind === 'protected') {
      violations.push({
        code: 'PROTECTED_WRITE',
        detail: `Edge ${edge.id} would place protected node ${edge.to}, which stands for a part the brief froze.`,
        edgeId: edge.id,
      })
    }
    if (!familiesCanMate(edge.fromConnector.family, edge.toConnector.family)) {
      violations.push({
        code: 'INCOMPATIBLE_FAMILIES',
        detail: `Edge ${edge.id} mates ${edge.fromConnector.family} with ${edge.toConnector.family}, which never connect.`,
        edgeId: edge.id,
      })
    }
    const existing = parents.get(edge.to)
    if (existing) existing.push(edge.id)
    else parents.set(edge.to, [edge.id])
  }

  for (const [nodeId, edgeIds] of parents) {
    if (edgeIds.length > 1) {
      violations.push({
        code: 'MULTIPLE_PARENTS',
        detail: `Node ${nodeId} is placed by ${edgeIds.length} edges (${edgeIds.join(', ')}); a pose comes from exactly one.`,
        nodeId,
      })
    }
  }

  for (const node of graph.nodes) {
    if (node.kind === 'protected') continue
    if (parents.has(node.id)) continue
    if (!node.anchorLdu) {
      violations.push({
        code: 'ROOT_WITHOUT_ANCHOR',
        detail: `Node ${node.id} has no incoming edge and no anchor, so nothing says where it goes.`,
        nodeId: node.id,
      })
    }
  }

  const order = topologicalOrder(graph)
  if (order.length < graph.nodes.length) {
    const placed = new Set(order.map((node) => node.id))
    const stuck = graph.nodes.filter((node) => !placed.has(node.id)).map((node) => node.id)
    violations.push({ code: 'CYCLE', detail: `Nodes ${stuck.join(', ')} form an attachment cycle.` })
  }

  return violations
}

/**
 * Placement order: parents before children, ties broken by node id.
 *
 * The id tie-break is what makes the whole pipeline reproducible. Kahn's
 * algorithm with an unordered frontier would place siblings in whatever order a
 * Set happened to iterate, and two sibling bricks competing for the same studs
 * produce different models depending on which went first.
 */
export function topologicalOrder(graph: BuildGraph): BuildNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const indegree = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]))
  const children = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
    const bucket = children.get(edge.from)
    if (bucket) bucket.push(edge.to)
    else children.set(edge.from, [edge.to])
  }

  const frontier = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort()
  const result: BuildNode[] = []
  while (frontier.length) {
    const id = frontier.shift()!
    const node = byId.get(id)
    if (!node) continue
    result.push(node)
    for (const child of (children.get(id) ?? []).slice().sort()) {
      const next = (indegree.get(child) ?? 0) - 1
      indegree.set(child, next)
      if (next === 0) {
        frontier.push(child)
        frontier.sort()
      }
    }
  }
  return result
}

/** Edge that places a node, or null for a root. */
export function incomingEdge(graph: BuildGraph, nodeId: string): BuildEdge | null {
  return graph.edges.find((edge) => edge.to === nodeId) ?? null
}

/** Everything reachable downward from `rootIds`, as a graph in its own right. */
export function subgraph(graph: BuildGraph, rootIds: readonly string[]): BuildGraph {
  const keep = new Set(rootIds.filter((id) => graph.nodes.some((node) => node.id === id)))
  let grew = true
  while (grew) {
    grew = false
    for (const edge of graph.edges) {
      if (keep.has(edge.from) && !keep.has(edge.to)) {
        keep.add(edge.to)
        grew = true
      }
    }
  }
  return {
    version: 1,
    strategy: graph.strategy,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  }
}

/**
 * A hash of the graph's *shape*, with node ids relabelled away.
 *
 * Diversity is a claim about structure, not about naming: two candidates that
 * differ only because a counter started at a different number are the same
 * model. Relabelling in placement order and hashing the result means the
 * comparison answers the question actually being asked — "did the generator
 * produce a different build?" — and it is stable across processes because
 * `stableStringify` sorts keys.
 */
export function structuralHash(graph: BuildGraph): string {
  const order = topologicalOrder(graph)
  const label = new Map(order.map((node, index) => [node.id, `n${index}`]))
  const canonicalNodes = order.map((node) => ({
    label: label.get(node.id),
    kind: node.kind,
    colour: node.colour,
    role: node.role,
    part: node.part
      ? { query: node.part.query, definitionId: node.part.definitionId ?? null, sizeStuds: node.part.sizeStuds ?? null }
      : null,
    region: node.region
      ? {
          shape: node.region.shape,
          widthStuds: node.region.widthStuds,
          depthStuds: node.region.depthStuds,
          courses: node.region.courses,
          family: node.region.family,
          thicknessStuds: node.region.thicknessStuds ?? 1,
          axis: node.region.axis ?? null,
          floor: node.region.floor ?? false,
          openings: (node.region.openings ?? []).map((opening) => ({
            atStud: opening.atStud,
            widthStuds: opening.widthStuds,
            fromCourse: opening.fromCourse,
            toCourse: opening.toCourse,
            element: opening.element ?? null,
          })),
          offsetStuds: node.region.offsetStuds ?? null,
        }
      : null,
    anchorLdu: node.anchorLdu ?? null,
    quarterTurns: node.quarterTurns ?? 0,
  }))
  const canonicalEdges = graph.edges
    .map((edge) => ({
      from: label.get(edge.from) ?? edge.from,
      to: label.get(edge.to) ?? edge.to,
      fromConnector: edge.fromConnector,
      toConnector: edge.toConnector,
      family: edge.family,
      quarterTurns: edge.quarterTurns ?? 0,
    }))
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))

  const payload = stableStringify({ strategy: graph.strategy, nodes: canonicalNodes, edges: canonicalEdges })
  // Two 32-bit passes over differently-salted inputs. One would collide across a
  // few tens of thousands of candidates by the birthday bound, which is well
  // inside what a diversity search explores.
  const low = hash32(payload).toString(16).padStart(8, '0')
  const high = hash32(`brickwright/graph\0${payload}`).toString(16).padStart(8, '0')
  return `${high}${low}`
}

export interface MergeProtectedResult {
  readonly graph: BuildGraph
  /** Ids that were named as protected but are not in the document. */
  readonly missing: string[]
}

/**
 * Folds already-approved parts into the graph as fixed inputs.
 *
 * A regenerate over an existing model must be able to *attach to* the region a
 * human has approved without being able to move it. Representing those parts as
 * nodes rather than as an out-of-band exclusion list is what makes that
 * expressible: an edge may name a protected node as its `from`, and
 * `validateGraph` refuses any edge that names one as its `to`.
 */
export function mergeProtected(
  graph: BuildGraph,
  protectedPartIds: readonly string[],
  existingPartIds: ReadonlySet<string>,
): MergeProtectedResult {
  const missing: string[] = []
  const additions: BuildNode[] = []
  const present = new Set(graph.nodes.map((node) => node.id))

  for (const partId of protectedPartIds) {
    if (!existingPartIds.has(partId)) {
      missing.push(partId)
      continue
    }
    const nodeId = protectedNodeId(partId)
    if (present.has(nodeId)) continue
    additions.push({ id: nodeId, kind: 'protected', colour: 0, role: 'protected', existingPartId: partId })
  }

  return {
    graph: additions.length ? { ...graph, nodes: [...graph.nodes, ...additions] } : graph,
    missing,
  }
}

export const protectedNodeId = (partId: string) => `protected__${partId}`

/** Local point a `grid` pick names, in the part's own frame. */
export function gridPointLdu(
  boundsMin: Vec3,
  uStuds: number,
  vStuds: number,
): { readonly u: number; readonly v: number } {
  return { u: boundsMin[0] + (uStuds + 0.5) * STUD_LDU, v: boundsMin[2] + (vStuds + 0.5) * STUD_LDU }
}
