import { catalog, originForSurface, STUD_LDU } from '../../cad/catalog'
import { partPoseCollides } from '../../cad/collisionGate'
import { IDENTITY_BASIS, type Mat3, type RigidTransform } from '../../cad/math'
import { QUARTER_TURN_BASES } from '../../cad/placement'
import { findSnapCandidates } from '../../cad/snapping'
import type { CadOperation, ModelDocument, PartDefinition, PartInstance, Vec3 } from '../../cad/types'
import { hash32 } from '../../platform/contracts'
import type { RefinementScope } from '../types'

/**
 * Shared machinery for the alternative generators.
 *
 * Two things here are load-bearing for the rest of the system.
 *
 * **Ids are content-derived, not random.** `createId` is a UUID, which is right
 * for a transaction and wrong for a proposal: the same document, request and
 * seed have to produce the same proposal twice, and a random id makes two
 * identical plans compare unequal. So a generated part's id is a hash of what it
 * is and where it goes. A collision would be caught immediately — the kernel
 * refuses a duplicate part id — rather than silently overwriting anything.
 *
 * **Placement goes through the snap solver.** A strategy that computes a pose
 * arithmetically is guessing at a part's connector layout. Handing a cursor pose
 * to `findSnapCandidates` instead means the pose that comes back is one the
 * kernel already agrees is a real mate, and the number of parts it mates with is
 * a measured fact the strategy can filter on — which is precisely what
 * "bridge these two parts" needs.
 */

export type Rng = () => number

export type StrategyId =
  | 'restack'
  | 'substitute'
  | 'reinforce'
  | 'smooth'
  | 'symmetrize'
  | 'simplify'
  | 'detail'

export type Strategy = (document: ModelDocument, scope: RefinementScope, rng: Rng) => CadOperation[][]

/** Deterministic, collision-resistant id for a part a refinement invents. */
export function refinementPartId(descriptor: string): string {
  const forward = hash32(descriptor).toString(36)
  const reverse = hash32([...descriptor].reverse().join('')).toString(36)
  return `ref_${forward}_${reverse}`
}

export interface PlacementSource {
  readonly subassemblyId: string
  readonly stepId: string
  readonly color: number
}

/** Assembly membership a generated part inherits, so it lands in the right region. */
export function sourceOf(document: ModelDocument, partId: string): PlacementSource | null {
  const part = document.parts[partId]
  if (!part) return null
  return { subassemblyId: part.subassemblyId, stepId: part.stepId, color: part.color }
}

export function makePart(
  descriptor: string,
  definitionId: string,
  transform: RigidTransform,
  source: PlacementSource,
  color = source.color,
): PartInstance {
  return {
    id: refinementPartId(descriptor),
    definitionId,
    color,
    transform,
    subassemblyId: source.subassemblyId,
    stepId: source.stepId,
    // Overwritten by `mutationsForOperations` with the committing actor; carried
    // here so a previewed document already reads the way the committed one will.
    provenance: 'agent',
    protected: false,
  }
}

export const basisForAxis = (axis: 'x' | 'z'): Mat3 => (axis === 'x' ? IDENTITY_BASIS : QUARTER_TURN_BASES[1])

/** Origin that rests `definition` with its underside on `surfaceY`, at a footprint centre. */
export function restingTransform(
  definition: PartDefinition,
  centreX: number,
  surfaceY: number,
  centreZ: number,
  basis: Mat3,
): RigidTransform {
  return { position: [centreX, originForSurface(definition, surfaceY), centreZ], basis }
}

/**
 * A pose for `definitionId` that genuinely mates with at least `minParts` of the
 * given targets.
 *
 * The cursor is only a hint about where the operator — here, the strategy —
 * wants the part; the solver decides whether a legal mate exists there. Returning
 * null when it does not is the point: a bridging plate that cannot actually be
 * bridged is not offered.
 */
export function snapOnto(
  document: ModelDocument,
  definitionId: string,
  cursor: RigidTransform,
  targetPartIds: readonly string[],
  minParts: number,
  color: number,
): { transform: RigidTransform; matchedPartIds: string[] } | null {
  const definition = catalog.get(definitionId)
  if (!definition) return null
  const probe: PartInstance = {
    id: '__refinement_probe__',
    definitionId,
    color,
    transform: cursor,
    subassemblyId: '',
    stepId: '',
    provenance: 'agent',
    protected: false,
  }
  const candidates = findSnapCandidates(probe, document, cursor, { radiusLdu: 26, maxCandidates: 12 })
  for (const candidate of candidates) {
    const matched = [...new Set(candidate.matches.map((match) => match.targetPartId))]
    const wanted = matched.filter((id) => targetPartIds.includes(id))
    if (wanted.length < minParts) continue
    if (partPoseCollides(document, { ...probe, transform: candidate.transform })) continue
    return { transform: candidate.transform, matchedPartIds: matched }
  }
  return null
}

/** Removes a part and puts a different definition at exactly the same pose. */
export function substitution(
  document: ModelDocument,
  partId: string,
  definitionId: string,
  descriptor: string,
  transform?: RigidTransform,
): CadOperation[] {
  const part = document.parts[partId]
  if (!part) return []
  return [
    { type: 'part.remove', partId },
    {
      type: 'part.add',
      part: makePart(descriptor, definitionId, transform ?? part.transform, {
        subassemblyId: part.subassemblyId,
        stepId: part.stepId,
        color: part.color,
      }),
    },
  ]
}

/** Colour used by most of a set, so a rebuilt course keeps the region's colour. */
export function modalColor(document: ModelDocument, partIds: readonly string[]): number {
  const counts = new Map<number, number>()
  for (const id of partIds) {
    const part = document.parts[id]
    if (part) counts.set(part.color, (counts.get(part.color) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0
}

/** Stud-pitch distance between two document points on one horizontal axis. */
export const studsBetween = (a: number, b: number): number => Math.abs(a - b) / STUD_LDU

export const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]

/**
 * Trims an alternative list to a bounded, deterministic sample.
 *
 * The cap exists because a region with forty weak joints would otherwise emit
 * forty batches the search has no budget to score. The seeded draw is what keeps
 * *which* ones survive reproducible.
 */
export function sample<T>(items: readonly T[], limit: number, rng: Rng): T[] {
  if (items.length <= limit) return [...items]
  const pool = [...items]
  const picked: T[] = []
  while (picked.length < limit && pool.length) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
  }
  return picked
}

/** Drops empty and duplicate batches, so the search never scores the same plan twice. */
export function dedupeBatches(batches: CadOperation[][]): CadOperation[][] {
  const seen = new Set<string>()
  const out: CadOperation[][] = []
  for (const batch of batches) {
    if (!batch.length) continue
    const key = JSON.stringify(batch)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(batch)
  }
  return out
}
