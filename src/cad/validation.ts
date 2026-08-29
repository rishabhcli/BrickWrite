import { catalog, STUD_LDU } from './catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from './collision'
import { introducedCollisions } from './collisionGate'
import { getDocumentBounds, getPartBounds } from './geometry'
import { computeOccupancy, deriveConnections, approachOccupancy } from './snapping'
import type { Bounds, CollisionIssue, ModelDocument, PartInstance, Transform, ValidationReport, Vec3 } from './types'

/** One plate of slop: a part sitting a hair off the table is still on it. */
const GROUND_TOLERANCE_LDU = 8

/**
 * Adjacency and per-pair mating data for the current document.
 *
 * Both come from `deriveConnections`, which is memoized per revision, so the
 * solver, validation and the viewport share one derivation pass instead of each
 * rebuilding the graph.
 */
function buildConnectionGraph(document: ModelDocument) {
  const world = deriveConnections(document)
  const edges = new Map<string, Set<string>>(Object.keys(document.parts).map((id) => [id, new Set<string>()]))
  for (const pair of world.pairs) {
    edges.get(pair.a.partId)?.add(pair.b.partId)
    edges.get(pair.b.partId)?.add(pair.a.partId)
  }
  return { edges, world, connectionCount: world.pairs.length }
}

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

function components(edges: Map<string, Set<string>>): string[][] {
  const unseen = new Set(edges.keys())
  const result: string[][] = []
  while (unseen.size) {
    const seed = unseen.values().next().value as string
    unseen.delete(seed)
    const queue = [seed]
    const component: string[] = []
    while (queue.length) {
      const current = queue.shift()!
      component.push(current)
      for (const neighbor of edges.get(current) ?? []) {
        if (unseen.delete(neighbor)) queue.push(neighbor)
      }
    }
    result.push(component)
  }
  return result.sort((a, b) => b.length - a.length)
}

/** Complete connected component around one or more seed parts. */
export function connectedComponent(document: ModelDocument, seedPartIds: readonly string[]): string[] {
  const { edges } = buildConnectionGraph(document)
  const seen = new Set<string>()
  const queue = seedPartIds.filter((id) => edges.has(id))
  for (const id of queue) seen.add(id)
  while (queue.length) {
    const current = queue.shift()!
    for (const neighbor of edges.get(current) ?? []) {
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
  // LDraw is Y-down: the ground is the greatest Y anything reaches.
  const groundY = Math.max(...boxes.map((entry) => entry.box.max[1]))
  return parts.filter((part) => {
    if ((edges.get(part.id)?.size ?? 0) > 0) return false
    const box = getPartBounds(part)
    if (!box.measured) return false
    return Math.abs(box.max[1] - groundY) > GROUND_TOLERANCE_LDU
  }).map((part) => part.id)
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
  const groundY = Math.max(...boxes.map((entry) => entry.box.max[1]))
  const grounded = new Set(
    boxes.filter((entry) => Math.abs(entry.box.max[1] - groundY) <= GROUND_TOLERANCE_LDU).map((entry) => entry.part.id),
  )
  const hovering: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    if (seen.has(part.id)) continue
    const component = connectedComponent(document, [part.id])
    for (const id of component) seen.add(id)
    if (component.some((id) => grounded.has(id))) continue
    hovering.push(...component)
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

export function unclutchedRestCode(
  document: ModelDocument,
  partId: string,
): 'CONNECTOR_OCCUPIED' | 'NO_COMPATIBLE_CONNECTOR' {
  const support = unclutchedRestSupport(document, partId)
  if (support && approachOccupancy(document, support, 'on-top') === 'occupied') return 'CONNECTOR_OCCUPIED'
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
  const preview: ModelDocument = {
    ...document,
    parts: { ...document.parts, [partId]: { ...part, transform } },
  }
  const wasFloating = new Set(floatingPartIds(document))
  if (!wasFloating.has(partId) && floatingPartIds(preview).includes(partId)) return 'DISCONNECTED'
  const wasRest = new Set(unclutchedRestPartIds(document))
  if (!wasRest.has(partId) && unclutchedRestPartIds(preview).includes(partId)) {
    return unclutchedRestCode(preview, partId)
  }
  if (introducedCollisions(document, preview, [partId], { placing: false }).length) return 'COLLISION'
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
