import { catalog, STUD_LDU } from './catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from './collision'
import { getDocumentBounds } from './geometry'
import { computeOccupancy, deriveConnections } from './snapping'
import type { CollisionIssue, ModelDocument, ValidationReport, Vec3 } from './types'

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

  const constraints = document.constraints.map((constraint) => {
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

/** Parts held by exactly one connector: the classic "will fall off" warning. */
export function findWeakAttachments(document: ModelDocument): Array<{ partId: string; connections: number }> {
  const { edges } = buildConnectionGraph(document)
  return Object.values(document.parts)
    .map((part) => ({ partId: part.id, connections: edges.get(part.id)?.size ?? 0 }))
    .filter((entry) => entry.connections === 1)
}

/** Connector occupancy for the current document, exposed for inspection tools. */
export const occupancyOf = (document: ModelDocument) => computeOccupancy(document)
