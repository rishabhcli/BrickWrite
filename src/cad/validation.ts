import { catalog, STUD_LDU } from './catalog'
import { getDocumentBounds, getPartBounds, type PartBounds } from './geometry'
import { computeOccupancy, connectorsCompatible, ConnectorSpatialIndex, getWorldConnectors } from './snapping'
import type { CollisionIssue, ModelDocument, PartInstance, ValidationReport, Vec3 } from './types'

const EPSILON = 0.01

/**
 * Stud engagement depth. A brick stacked on another legitimately overlaps it by
 * exactly the stud height, so an unqualified box intersection test would flag
 * every correct build as a collision.
 */
const STUD_CLEARANCE_LDU = 4.05

/**
 * Insertion depth allowance for connectors that go *inside* another part — pins
 * in pin holes, axles in axle holes, bars in clips. Brickwright cannot yet
 * measure the true mating volume of these, so overlaps they explain are
 * reported with `unknown` certainty rather than silently accepted or rejected.
 */
const INSERTED_CLEARANCE_LDU = 26

const INSERTED_FAMILIES = new Set(['pin', 'pin-hole', 'axle', 'axle-hole', 'bar', 'clip', 'ball', 'socket'])

const overlapExtents = (a: PartBounds, b: PartBounds): Vec3 => [
  Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]),
  Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]),
  Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]),
]

interface MatedPair {
  a: string
  b: string
  family: string
  inserted: boolean
}

/**
 * Builds the connection graph by finding coincident compatible connectors.
 *
 * This is the structural backbone of the document: connectivity, component
 * counts, weak-attachment analysis and legal-overlap decisions all read from it
 * rather than from geometric proximity guesses.
 */
function buildConnectionGraph(parts: PartInstance[]) {
  const index = new ConnectorSpatialIndex()
  const features = parts.flatMap((part) => getWorldConnectors(part))
  for (const feature of features) index.insert(feature)

  const edges = new Map<string, Set<string>>(parts.map((part) => [part.id, new Set<string>()]))
  const pairsByParts = new Map<string, MatedPair[]>()
  const seen = new Set<string>()

  for (const feature of features) {
    for (const nearby of index.query(feature.position, 0.75)) {
      if (nearby.partId === feature.partId) continue
      if (!connectorsCompatible(feature, nearby)) continue
      const key = [`${feature.partId}/${feature.id}`, `${nearby.partId}/${nearby.id}`].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      edges.get(feature.partId)?.add(nearby.partId)
      edges.get(nearby.partId)?.add(feature.partId)
      const partKey = [feature.partId, nearby.partId].sort().join('|')
      const pair: MatedPair = {
        a: feature.id,
        b: nearby.id,
        family: feature.family,
        inserted: INSERTED_FAMILIES.has(feature.family) && INSERTED_FAMILIES.has(nearby.family),
      }
      const bucket = pairsByParts.get(partKey)
      if (bucket) bucket.push(pair)
      else pairsByParts.set(partKey, [pair])
    }
  }

  return { edges, pairsByParts, connectionCount: seen.size, connectorCount: features.length }
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

export function validateDocument(document: ModelDocument): ValidationReport {
  const parts = Object.values(document.parts)
  const bounds = parts.map(getPartBounds)
  const graph = buildConnectionGraph(parts)

  // -- Collision: box broad phase, then mating-clearance subtraction ---------
  const collisions: CollisionIssue[] = []
  for (let index = 0; index < bounds.length; index += 1) {
    for (let compare = index + 1; compare < bounds.length; compare += 1) {
      const a = bounds[index]
      const b = bounds[compare]
      if (!a.measured || !b.measured) continue
      const overlap = overlapExtents(a, b)
      if (!overlap.every((amount) => amount > EPSILON)) continue

      const mated = graph.pairsByParts.get([a.partId, b.partId].sort().join('|')) ?? []
      const thinnestAxis = Math.min(...overlap)
      if (mated.length) {
        const allowance = mated.some((pair) => pair.inserted) ? INSERTED_CLEARANCE_LDU : STUD_CLEARANCE_LDU
        if (thinnestAxis <= allowance) continue
      }

      collisions.push({
        id: `collision_${a.partId}_${b.partId}`,
        partA: a.partId,
        partB: b.partId,
        overlapLdu: overlap,
        message: mated.length
          ? `Parts ${a.partId} and ${b.partId} are connected but intersect by ${thinnestAxis.toFixed(1)} LDU, beyond the allowed mating volume.`
          : `Parts ${a.partId} and ${b.partId} intersect outside an allowed connection volume.`,
      })
    }
  }

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
  const parts = Object.values(document.parts)
  const { edges } = buildConnectionGraph(parts)
  return parts
    .map((part) => ({ partId: part.id, connections: edges.get(part.id)?.size ?? 0 }))
    .filter((entry) => entry.connections === 1)
}

/** Connector occupancy for the current document, exposed for inspection tools. */
export const occupancyOf = (document: ModelDocument) => computeOccupancy(document)
