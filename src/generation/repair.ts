import { mulberry32 } from '../platform/contracts'
import type { BrickFamily } from '../cad/assembly'
import type { PartDefinition } from '../cad/types'
import type { RegionIntent } from './graph'

/**
 * Constrained repair.
 *
 * When an attachment the graph asked for cannot be realised, there are exactly
 * three honest things to do about it, and they are tried in this order because
 * that is the order of increasing damage to what was asked for:
 *
 *   1. **another connector pair** — the same two parts, joined somewhere else.
 *      The part list, the colours and the topology all survive.
 *   2. **another compatible part** — the same *place*, a different identity.
 *      The bill of materials changes; the structure does not.
 *   3. **a small lattice offset** — the same part, moved by whole studs.
 *      The structure changes, which is why it is last.
 *
 * A fourth option — keep it anyway — is not on the list. If the budget runs out
 * the edge is rejected with the reason, and the candidate reports a hole rather
 * than a model containing a joint that does not exist.
 *
 * Everything is a pure function of `(seed, budget, ordered pools)`. The seed
 * rotates the *alternatives* only, never the primary attempt, so a given graph
 * always tries what it asked for first and two seeds that both succeed on the
 * first attempt produce identical geometry.
 */

export type RepairKind = 'primary' | 'alternate-connector' | 'alternate-part' | 'lattice-offset'

export interface AttachmentAttempt {
  readonly kind: RepairKind
  /** Why this attempt exists, in the words the outcome will be reported in. */
  readonly description: string
  readonly definitionId: string
  readonly parentFeatureId: string
  readonly childFeatureId: string
  readonly quarterTurns: number
}

export interface AttachmentRepairInput {
  readonly seed: number
  readonly budget: number
  /** Identity the node asked for. Always attempted first. */
  readonly requestedDefinitionId: string
  /** Placeable identities satisfying the intent, search-ranked, best first. */
  readonly candidates: readonly PartDefinition[]
  /**
   * Parent connectors that survive family, gender and occupancy filtering,
   * ordered by the edge's own pick rule. Index 0 is what was asked for; the
   * rest are, by construction, the nearest alternatives on the same plane.
   */
  readonly parentFeatureIds: readonly string[]
  /** Child connectors per candidate identity, ordered by the edge's pick rule. */
  readonly childFeatureIds: ReadonlyMap<string, readonly string[]>
  readonly quarterTurns: number
  /**
   * Parent connectors reached by stepping whole studs away from the requested
   * one, nearest first. Distinct from `parentFeatureIds` because these
   * deliberately move the attachment rather than re-seating it.
   */
  readonly latticeFeatureIds?: readonly string[]
}

/** Deterministic rotation, so a seed varies which alternative is reached first. */
function rotate<T>(items: readonly T[], seed: number): T[] {
  if (items.length < 2) return [...items]
  const offset = Math.floor(mulberry32(seed >>> 0)() * items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

const DEFAULT_BUDGET = 24

/**
 * The full attempt sequence for one attachment, primary first.
 *
 * Returned as a list rather than driven as a loop so the caller can execute it,
 * stop at the first success, and report exactly which attempt succeeded — which
 * is the difference between "repaired" and "repaired somehow".
 */
export function enumerateAttachmentAttempts(input: AttachmentRepairInput): AttachmentAttempt[] {
  const budget = Math.max(1, input.budget || DEFAULT_BUDGET)
  const attempts: AttachmentAttempt[] = []
  const seen = new Set<string>()

  const push = (attempt: AttachmentAttempt) => {
    if (attempts.length >= budget) return
    const key = `${attempt.definitionId}|${attempt.parentFeatureId}|${attempt.childFeatureId}|${attempt.quarterTurns}`
    if (seen.has(key)) return
    seen.add(key)
    attempts.push(attempt)
  }

  const requestedChildren = input.childFeatureIds.get(input.requestedDefinitionId) ?? []
  const primaryParent = input.parentFeatureIds[0]
  const primaryChild = requestedChildren[0]

  if (primaryParent && primaryChild) {
    push({
      kind: 'primary',
      description: 'the attachment the graph asked for',
      definitionId: input.requestedDefinitionId,
      parentFeatureId: primaryParent,
      childFeatureId: primaryChild,
      quarterTurns: input.quarterTurns,
    })
  }

  // 1 — same two parts, joined somewhere else. Child connectors first, because
  // re-seating the moving part disturbs the model less than moving where on the
  // parent it lands.
  for (const childFeatureId of rotate(requestedChildren.slice(1), input.seed)) {
    if (!primaryParent) break
    push({
      kind: 'alternate-connector',
      description: `mated through the part's ${childFeatureId} connector instead`,
      definitionId: input.requestedDefinitionId,
      parentFeatureId: primaryParent,
      childFeatureId,
      quarterTurns: input.quarterTurns,
    })
  }
  for (const parentFeatureId of rotate(input.parentFeatureIds.slice(1), input.seed)) {
    if (!primaryChild) break
    push({
      kind: 'alternate-connector',
      description: `seated on the host's ${parentFeatureId} connector instead`,
      definitionId: input.requestedDefinitionId,
      parentFeatureId,
      childFeatureId: primaryChild,
      quarterTurns: input.quarterTurns,
    })
  }

  // 2 — same place, a different identity. Only identities that actually carry a
  // usable connector are offered; the caller has already filtered the list.
  const alternates = input.candidates.filter((candidate) => candidate.canonicalId !== input.requestedDefinitionId)
  for (const candidate of rotate(alternates, input.seed)) {
    const children = input.childFeatureIds.get(candidate.canonicalId) ?? []
    if (!children.length || !primaryParent) continue
    push({
      kind: 'alternate-part',
      description: `substituted ${candidate.name} (${candidate.canonicalId}), which satisfies the same intent`,
      definitionId: candidate.canonicalId,
      parentFeatureId: primaryParent,
      childFeatureId: children[0],
      quarterTurns: input.quarterTurns,
    })
  }

  // 3 — same part, moved. Last because it is the only step that changes where
  // the model says the thing is.
  for (const parentFeatureId of input.latticeFeatureIds ?? []) {
    if (!primaryChild) break
    push({
      kind: 'lattice-offset',
      description: `shifted along the lattice to the host's ${parentFeatureId} connector`,
      definitionId: input.requestedDefinitionId,
      parentFeatureId,
      childFeatureId: primaryChild,
      quarterTurns: input.quarterTurns,
    })
  }

  return attempts
}

export interface RegionAttempt {
  readonly kind: RepairKind
  readonly description: string
  /** Null when the region is a root and its origin comes from its anchor. */
  readonly parentFeatureId: string | null
  readonly region: RegionIntent
}

export interface RegionRepairInput {
  readonly seed: number
  readonly budget: number
  readonly region: RegionIntent
  /** Ordered, unoccupied parent connectors; empty for a root region. */
  readonly parentFeatureIds: readonly string[]
  /** Brick families the pack can lay, for the substitution step. */
  readonly alternateFamilies: readonly BrickFamily[]
  /** Whole-stud shifts of the region's own origin, nearest first. */
  readonly offsetSteps?: readonly (readonly [number, number])[]
  /** Extra whole-stud slides from remaining free host connectors. */
  readonly extraOffsetSteps?: readonly (readonly [number, number])[]
}

/** Whole-stud shifts tried when a region will not fit where it was asked for. */
const DEFAULT_OFFSET_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
]

/**
 * Attempt sequence for a region, in the same order and for the same reasons.
 *
 * The final step shrinks the footprint. That is a real change to what was asked
 * for, so it comes last and it is described in the outcome: a candidate whose
 * wall came back two studs shorter says so rather than reporting the requested
 * length and building something else.
 */
export function enumerateRegionAttempts(input: RegionRepairInput): RegionAttempt[] {
  const budget = Math.max(1, input.budget || DEFAULT_BUDGET)
  const attempts: RegionAttempt[] = []
  const push = (attempt: RegionAttempt) => {
    if (attempts.length < budget) attempts.push(attempt)
  }

  const rootRegion = input.parentFeatureIds.length === 0
  const primaryParent = rootRegion ? null : input.parentFeatureIds[0]
  push({
    kind: 'primary',
    description: 'the region the graph asked for',
    parentFeatureId: primaryParent,
    region: input.region,
  })

  for (const parentFeatureId of rotate(input.parentFeatureIds.slice(1), input.seed)) {
    push({
      kind: 'alternate-connector',
      description: `origin moved to the host's ${parentFeatureId} connector`,
      parentFeatureId,
      region: input.region,
    })
  }

  for (const family of input.alternateFamilies.filter((candidate) => candidate !== input.region.family)) {
    push({
      kind: 'alternate-part',
      description: `laid in ${family}s instead of ${input.region.family}s`,
      parentFeatureId: primaryParent,
      region: { ...input.region, family },
    })
  }

  const base = input.region.offsetStuds ?? [0, 0]
  const seen = new Set<string>()
  const mark = (step: readonly [number, number]) => {
    const key = `${step[0]},${step[1]}`
    if (seen.has(key) || (step[0] === 0 && step[1] === 0)) return false
    seen.add(key)
    return true
  }
  for (const step of [...(input.offsetSteps ?? DEFAULT_OFFSET_STEPS), ...(input.extraOffsetSteps ?? [])]) {
    if (!mark(step)) continue
    push({
      kind: 'lattice-offset',
      description: `shifted ${step[0]} × ${step[1]} studs on the lattice`,
      parentFeatureId: primaryParent,
      region: { ...input.region, offsetStuds: [base[0] + step[0], base[1] + step[1]] },
    })
  }

  // Shrinking is the last resort, and it halts: each step removes at least one
  // stud from the larger dimension, so the sequence terminates at 1 × 1.
  let width = input.region.widthStuds
  let depth = input.region.depthStuds
  while (attempts.length < budget && (width > 1 || depth > 1)) {
    if (width >= depth) width -= 1
    else depth -= 1
    push({
      kind: 'lattice-offset',
      description: `footprint reduced to ${width} × ${depth} studs to clear the obstruction`,
      parentFeatureId: primaryParent,
      region: { ...input.region, widthStuds: width, depthStuds: depth },
    })
  }

  return attempts
}
