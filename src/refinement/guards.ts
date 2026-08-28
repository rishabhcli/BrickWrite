import { evaluateConstraints, connectedComponent } from '../cad/validation'
import { findCollisions, residentGeometryProvider, type CollisionContact } from '../cad/collision'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { deriveConnections } from '../cad/snapping'
import type { ModelDocument } from '../cad/types'
import { stableStringify } from '../platform/contracts'
import { silhouetteOf } from './cache'
import { silhouetteArea, silhouetteDrift } from './silhouette'
import type { RefinementScope, RejectionCode, SilhouetteV1 } from './types'

/**
 * The invariants a refinement is not allowed to spend.
 *
 * A search that optimizes a weighted score will find whatever the score does not
 * forbid, so everything a refinement must never do is enforced here rather than
 * priced into an objective. The division is deliberate:
 *
 *   **Throws** are for things that cannot happen without a bug in a generator —
 *   touching a part outside the scope, deleting something the request never
 *   offered. Turning those into a low score would let a broken strategy compete.
 *
 *   **Verdicts** are for things a legitimate attempt can run into — a bridge that
 *   collides, a mirror that orphans a part, a smoothing pass that moves the
 *   outline further than the request allowed. Those become a rejected proposal
 *   with a reason, because the operator asked and deserves to be told why not.
 *
 * Nothing here is advisory. `proposeRefinements` offers no proposal that has not
 * passed every check in this file, and `applyRefinement` refuses a rejected one
 * without ever reaching the command bus.
 */

export class ScopeViolationError extends Error {
  constructor(
    message: string,
    readonly partIds: readonly string[],
  ) {
    super(message)
    this.name = 'ScopeViolationError'
  }
}

export interface GuardVerdict {
  readonly ok: boolean
  readonly code: RejectionCode | null
  readonly reason: string
  readonly partIds: readonly string[]
  readonly warnings: readonly string[]
}

const pass = (warnings: readonly string[] = []): GuardVerdict => ({
  ok: true,
  code: null,
  reason: '',
  partIds: [],
  warnings,
})

const fail = (code: RejectionCode, reason: string, partIds: readonly string[] = []): GuardVerdict => ({
  ok: false,
  code,
  reason,
  partIds,
  warnings: [],
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Every part the request did not offer is byte-identical afterwards.
 *
 * This is the load-bearing promise of the whole workflow. A person selects a
 * roof and asks for it to be lowered; if the engine is free to nudge a wall
 * "while it is in there", nothing it produces can be reviewed, because the diff
 * is no longer bounded by the selection. The comparison is a canonical
 * serialization rather than a field-by-field check so that a field added to
 * `PartInstance` later is covered without anybody remembering to extend this.
 */
export function assertScopeIsolation(before: ModelDocument, after: ModelDocument, scope: RefinementScope): void {
  const violations: string[] = []
  for (const [partId, part] of Object.entries(before.parts)) {
    if (scope.partIdSet.has(partId)) continue
    const successor = after.parts[partId]
    if (!successor) {
      violations.push(partId)
      continue
    }
    if (stableStringify(part) !== stableStringify(successor)) violations.push(partId)
  }
  if (violations.length) {
    throw new ScopeViolationError(
      `A refinement changed ${violations.length} part(s) outside its scope: ${violations.slice(0, 8).join(', ')}.`,
      violations,
    )
  }

  // A part the request never offered must not be *removed* either, which the
  // loop above already covers, and a part inside the scope that the request
  // marked immutable must not have been rewritten.
  const immutable = [...scope.protectedPartIds, ...scope.boundaryPartIds]
  const moved = immutable.filter((partId) => {
    const original = before.parts[partId]
    if (!original) return false
    const successor = after.parts[partId]
    return !successor || stableStringify(original) !== stableStringify(successor)
  })
  if (moved.length) {
    throw new ScopeViolationError(
      `A refinement changed ${moved.length} protected or boundary part(s): ${moved.slice(0, 8).join(', ')}.`,
      moved,
    )
  }
}

/** Parts the candidate created, in stable order. */
export const addedPartIds = (before: ModelDocument, after: ModelDocument): string[] =>
  Object.keys(after.parts).filter((id) => !before.parts[id]).sort()

/** Parts the candidate deleted, in stable order. */
export const removedPartIds = (before: ModelDocument, after: ModelDocument): string[] =>
  Object.keys(before.parts).filter((id) => !after.parts[id]).sort()

/** Pre-existing parts the candidate rewrote, in stable order. */
export const modifiedPartIds = (before: ModelDocument, after: ModelDocument): string[] =>
  Object.keys(before.parts)
    .filter((id) => after.parts[id] && stableStringify(before.parts[id]) !== stableStringify(after.parts[id]))
    .sort()

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

/** Everything the kernel or the request says is untouchable. */
export function heldPartIds(document: ModelDocument, scope: RefinementScope): string[] {
  const held = new Set<string>([...scope.protectedPartIds, ...scope.boundaryPartIds])
  for (const part of Object.values(document.parts)) {
    if (part.protected) held.add(part.id)
    if (document.subassemblies[part.subassemblyId]?.locked) held.add(part.id)
  }
  return [...held].sort()
}

const matesOf = (document: ModelDocument, partId: string): Set<string> => {
  const mates = new Set<string>()
  for (const pair of deriveConnections(document).pairs) {
    if (pair.a.partId === partId) mates.add(`${pair.a.id}->${pair.b.partId}/${pair.b.id}`)
    if (pair.b.partId === partId) mates.add(`${pair.b.id}->${pair.a.partId}/${pair.a.id}`)
  }
  return mates
}

/**
 * Protected parts did not move and boundary interfaces did not come apart.
 *
 * Byte-identity covers the pose. The second half is the one that is easy to miss:
 * a boundary part can sit perfectly still while the thing it was mated to is
 * deleted from under it, which severs the seam between the refined region and the
 * rest of the model just as surely as moving it would. So every connector mate a
 * boundary part held before has to still be held afterwards.
 */
export function checkProtection(before: ModelDocument, after: ModelDocument, scope: RefinementScope): GuardVerdict {
  const held = heldPartIds(before, scope)
  const disturbed = held.filter((partId) => {
    const original = before.parts[partId]
    if (!original) return false
    const successor = after.parts[partId]
    return !successor || stableStringify(original) !== stableStringify(successor)
  })
  if (disturbed.length) {
    return fail(
      'PROTECTED_PART',
      `${disturbed.length} protected part(s) would move or be removed: ${disturbed.slice(0, 6).join(', ')}. `
      + 'Protected geometry is held by the kernel, so this refinement cannot be offered.',
      disturbed,
    )
  }

  const severed: string[] = []
  for (const partId of scope.boundaryPartIds) {
    if (!before.parts[partId] || !after.parts[partId]) continue
    const wasMated = matesOf(before, partId)
    const isMated = matesOf(after, partId)
    for (const mate of wasMated) {
      if (!isMated.has(mate)) {
        severed.push(partId)
        break
      }
    }
  }
  if (severed.length) {
    return fail(
      'BOUNDARY_MOVED',
      `${severed.length} boundary part(s) would lose a connection they carry into the rest of the model: `
      + `${severed.slice(0, 6).join(', ')}.`,
      severed,
    )
  }
  return pass()
}

// ---------------------------------------------------------------------------
// Kernel validity
// ---------------------------------------------------------------------------

const CONFIRMED: ReadonlySet<CollisionContact['certainty']> = new Set(['exact', 'clearance-subtracted'])

const collisionKey = (contact: CollisionContact) =>
  contact.partA < contact.partB ? `${contact.partA}|${contact.partB}` : `${contact.partB}|${contact.partA}`

/** Connected components, built from the kernel's own reachability walk. */
export function componentsOf(document: ModelDocument): string[][] {
  const remaining = new Set(Object.keys(document.parts))
  const components: string[][] = []
  while (remaining.size) {
    const seed = remaining.values().next().value as string
    const component = connectedComponent(document, [seed])
    for (const id of component) remaining.delete(id)
    if (!component.length) remaining.delete(seed)
    components.push(component.length ? component : [seed])
  }
  return components.sort((a, b) => b.length - a.length)
}

export interface KernelCheckOptions {
  /** Supplies triangle geometry; omitted uses whatever has streamed in. */
  readonly provideGeometry?: typeof residentGeometryProvider
}

/**
 * Collision, connectivity, constraints and build order — the four the kernel
 * would apply itself, applied before the proposal is ever offered.
 *
 * All four are differential against the base document rather than absolute. A
 * region that already had a collision must still be refinable; what a refinement
 * may not do is *introduce* one. The same reasoning is why the kernel refuses an
 * agent transaction that adds a collision rather than one that happens to contain
 * one.
 */
export function checkKernelValidity(
  before: ModelDocument,
  after: ModelDocument,
  options: KernelCheckOptions = {},
): GuardVerdict {
  const provide = options.provideGeometry ?? residentGeometryProvider
  const warnings: string[] = []

  const beforeCollisions = new Set(findCollisions(before, { provide }).map(collisionKey))
  const afterCollisions = findCollisions(after, { provide })
  const introduced = afterCollisions.filter((contact) => !beforeCollisions.has(collisionKey(contact)))
  if (introduced.length) {
    const confirmed = introduced.filter((contact) => CONFIRMED.has(contact.certainty))
    return fail(
      'COLLISION',
      `${introduced.length} new intersection(s) — ${confirmed.length} triangle-confirmed, `
      + `${introduced.length - confirmed.length} from bounding boxes with geometry not resident.`,
      [...new Set(introduced.flatMap((contact) => [contact.partA, contact.partB]))],
    )
  }

  const beforeComponents = componentsOf(before)
  const afterComponents = componentsOf(after)
  if (afterComponents.length > beforeComponents.length) {
    const beforeLoose = new Set(beforeComponents.slice(1).flat())
    const orphans = afterComponents
      .slice(1)
      .flat()
      .filter((partId) => !beforeLoose.has(partId))
    return fail(
      'DISCONNECTED',
      `The change would leave ${afterComponents.length - beforeComponents.length} more disconnected group(s) `
      + `than the model already has.`,
      orphans,
    )
  }

  const beforeStatus = new Map(evaluateConstraints(before).map((constraint) => [constraint.id, constraint.status]))
  const regressed = evaluateConstraints(after).filter(
    (constraint) => constraint.status === 'fail' && beforeStatus.get(constraint.id) !== 'fail',
  )
  if (regressed.length) {
    return fail(
      'CONSTRAINT_VIOLATION',
      `The change would newly break ${regressed.length} design constraint(s): `
      + regressed.map((constraint) => constraint.label).join(', ') + '.',
    )
  }

  const order = computeBuildOrder(after)
  const verification = verifyBuildOrder(after, order.steps)
  if (!verification.valid) {
    return fail(
      'BUILD_ORDER',
      `${verification.violations.length} part(s) could not be reached in any generated build step.`,
      verification.violations.map((violation) => violation.partId),
    )
  }
  if (order.unsupportedPartIds.length > computeBuildOrder(before).unsupportedPartIds.length) {
    warnings.push(
      `${order.unsupportedPartIds.length} part(s) begin a new independent island in the build sequence, `
      + 'up from the base model.',
    )
  }

  return pass(warnings)
}

// ---------------------------------------------------------------------------
// Silhouette
// ---------------------------------------------------------------------------

/**
 * The outline stayed inside the tolerance the request stated.
 *
 * Expressed as a fraction of the reference outline's own area, so the same
 * tolerance means the same thing on a microscale car and on a modular building.
 * A request that genuinely means to change the shape — "make the roof lower" —
 * raises the number; the default is tight because most refinements are not
 * supposed to move the outline at all.
 */
export function checkSilhouette(
  after: ModelDocument,
  reference: SilhouetteV1 | null,
  toleranceFraction: number,
): GuardVerdict {
  if (!reference) return pass()
  const frame = { min: reference.frameMin, max: reference.frameMax }
  const candidate = silhouetteOf(after, frame)
  const area = Math.max(1, silhouetteArea(reference))
  const drift = silhouetteDrift(reference, candidate) / area
  if (drift > toleranceFraction) {
    return fail(
      'SILHOUETTE_DRIFT',
      `The outline would move by ${(drift * 100).toFixed(1)}% of its area, past the `
      + `${(toleranceFraction * 100).toFixed(0)}% this request allows.`,
    )
  }
  return pass(
    drift > toleranceFraction / 2
      ? [`The outline moves by ${(drift * 100).toFixed(1)}% of its area.`]
      : [],
  )
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface CandidateGuardOptions extends KernelCheckOptions {
  readonly reference: SilhouetteV1 | null
  readonly silhouetteToleranceFraction: number
}

/**
 * Every check, in the order that makes a failure cheapest to explain.
 *
 * Scope isolation throws first because it means a generator is broken. Protection
 * comes next because it is the answer the operator most needs; the physical
 * checks follow, and the outline last, since it is the only one that rasterizes.
 */
export function guardCandidate(
  before: ModelDocument,
  after: ModelDocument,
  scope: RefinementScope,
  options: CandidateGuardOptions,
): GuardVerdict {
  assertScopeIsolation(before, after, scope)

  const added = addedPartIds(before, after)
  if (added.length) {
    // Anything a refinement creates has to end up attached to the region it was
    // invited into. Without this a "reinforcement" could be a plate floating a
    // stud away from the part it was supposed to be holding.
    const anchors = scope.partIds.filter((id) => after.parts[id])
    const reachable = anchors.length ? new Set(connectedComponent(after, anchors)) : new Set<string>()
    const stray = added.filter((id) => !reachable.has(id))
    if (stray.length) {
      return fail(
        'DISCONNECTED',
        `${stray.length} newly placed part(s) do not connect back to the selected region.`,
        stray,
      )
    }
  }

  const protection = checkProtection(before, after, scope)
  if (!protection.ok) return protection

  const kernel = checkKernelValidity(before, after, options)
  if (!kernel.ok) return kernel

  const outline = checkSilhouette(after, options.reference, options.silhouetteToleranceFraction)
  if (!outline.ok) return outline

  return pass([...kernel.warnings, ...outline.warnings])
}
