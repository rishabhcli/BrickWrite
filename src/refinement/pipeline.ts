import type { GeometryProvider } from '../cad/collision'
import { cadEngine, commandBus } from '../cad/engine'
import { getPartBounds } from '../cad/geometry'
import { STUD_LDU } from '../cad/catalog'
import type { Actor, CadOperation, CommandResult, ModelDocument, Transaction } from '../cad/types'
import { hash32, stableStringify, type ModelProvider, type Provenance } from '../platform/contracts'
import { analyseRegion, createScope, type RegionAnalysis } from './analyse'
import { heldPartIds } from './guards'
import { deterministicGoal, proposeGoal, rankProposals, type RefinementGoal } from './llm'
import { deltaOf, measureAll, regressionsOf } from './objectives'
import { referenceFor, searchRefinements, type SearchCandidate, type SearchReport, type SearchResult } from './search'
import {
  OBJECTIVE_IDS,
  refinementOperationSchema,
  refinementProposalSchema,
  refinementRequestSchema,
  type ChangeKind,
  type MetricVector,
  type OverlayInstruction,
  type RefinementOperation,
  type RefinementProposalV1,
  type RefinementRequestInput,
  type RefinementRequestV1,
} from './types'

/**
 * The public flow: analyse, generate, score, rank, propose, apply.
 *
 * `proposeRefinements` mutates nothing. It reads a document, returns ranked
 * proposals with ghost operations attached, and leaves the engine at exactly the
 * revision it found it at — which is what makes a refinement reviewable rather
 * than something that has already happened by the time it is described.
 *
 * `applyRefinement` is the only door out, and it goes through `commandBus` with
 * the proposal's own base revision. A proposal built against an older document
 * fails with the kernel's stale-document result instead of overwriting whatever
 * arrived in between; a proposal the guards rejected never reaches the bus at all.
 */

export interface PipelineOptions {
  readonly provider?: ModelProvider | null
  readonly signal?: AbortSignal
  readonly budget?: { maxIterations: number; wallClockMs: number }
  readonly provideGeometry?: GeometryProvider
  /** Wall clock for the budget; injected so a test can drive it. */
  readonly now?: () => number
  /** Timestamp stamped into provenance; injected so a run can be reproduced. */
  readonly createdAt?: string
}

export interface RefinementRun {
  readonly request: RefinementRequestV1
  readonly analysis: RegionAnalysis
  readonly goal: RefinementGoal
  readonly proposals: RefinementProposalV1[]
  readonly report: SearchReport
  readonly rankingRationale: string
}

export class RefinementRequestError extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
  ) {
    super(message)
    this.name = 'RefinementRequestError'
  }
}

/** Parses and defaults a request. Everything downstream sees a complete value. */
export function compileRequest(input: RefinementRequestInput): RefinementRequestV1 {
  const parsed = refinementRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new RefinementRequestError('The refinement request is not valid.', parsed.error.issues)
  }
  return parsed.data
}

const zeroVector = (): MetricVector => {
  const vector = {} as MetricVector
  for (const id of OBJECTIVE_IDS) vector[id] = 0
  return vector
}

const centreOf = (document: ModelDocument, partId: string): [number, number, number] => {
  const part = document.parts[partId]
  if (!part) return [0, 0, 0]
  const bounds = getPartBounds(part)
  if (!bounds.measured) {
    return [part.transform.position[0], part.transform.position[1], part.transform.position[2]]
  }
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
}

/**
 * The heatmap the viewport paints.
 *
 * One entry per part the proposal touches, with the kind of change and how large
 * it is. `magnitude` is absolute rather than normalized within the proposal:
 * a part that was added, removed or swapped is a whole change and reads 1, a move
 * scales with how far it went, and a colour change reads low because nothing
 * structural happened. Normalizing instead would make a proposal that recolours
 * two bricks look as dramatic as one that rebuilds a wall.
 */
export function buildOverlay(
  before: ModelDocument,
  after: ModelDocument,
  candidate: Pick<SearchCandidate, 'addedPartIds' | 'removedPartIds' | 'modifiedPartIds'>,
): OverlayInstruction[] {
  const overlay: OverlayInstruction[] = []

  for (const partId of candidate.addedPartIds) {
    overlay.push({
      partId,
      changeKind: 'added',
      magnitude: 1,
      atLdu: centreOf(after, partId),
      detail: `Adds ${after.parts[partId].definitionId}.`,
    })
  }
  for (const partId of candidate.removedPartIds) {
    overlay.push({
      partId,
      changeKind: 'removed',
      magnitude: 1,
      atLdu: centreOf(before, partId),
      detail: `Removes ${before.parts[partId].definitionId}.`,
    })
  }
  for (const partId of candidate.modifiedPartIds) {
    const was = before.parts[partId]
    const now = after.parts[partId]
    let changeKind: ChangeKind = 'moved'
    let magnitude = 0.4
    let detail = 'Changed.'
    if (was.definitionId !== now.definitionId) {
      changeKind = 'substituted'
      magnitude = 1
      detail = `Swapped ${was.definitionId} for ${now.definitionId}.`
    } else if (stableStringify(was.transform) !== stableStringify(now.transform)) {
      const moved = Math.hypot(
        now.transform.position[0] - was.transform.position[0],
        now.transform.position[1] - was.transform.position[1],
        now.transform.position[2] - was.transform.position[2],
      )
      changeKind = 'moved'
      magnitude = Math.max(0.15, Math.min(1, moved / (4 * STUD_LDU)))
      detail = `Moved ${moved.toFixed(1)} LDU.`
    } else if (was.color !== now.color) {
      changeKind = 'recolored'
      magnitude = 0.4
      detail = `Recoloured ${was.color} → ${now.color}.`
    } else if (was.subassemblyId !== now.subassemblyId) {
      changeKind = 'reassigned'
      magnitude = 0.2
      detail = `Moved to assembly ${now.subassemblyId}.`
    }
    overlay.push({ partId, changeKind, magnitude, atLdu: centreOf(after, partId), detail })
  }

  return overlay.sort((a, b) => b.magnitude - a.magnitude || a.partId.localeCompare(b.partId))
}

/**
 * Narrows kernel operations to the refinement vocabulary.
 *
 * A generator that produced something outside it — a constraint change, a
 * subassembly unlock — fails here rather than being offered, which is the whole
 * reason the vocabulary is a separate, smaller union.
 */
function narrowOperations(operations: readonly CadOperation[]): RefinementOperation[] | null {
  const narrowed: RefinementOperation[] = []
  for (const operation of operations) {
    const parsed = refinementOperationSchema.safeParse(operation)
    if (!parsed.success) return null
    narrowed.push(parsed.data)
  }
  return narrowed
}

function toProposal(
  request: RefinementRequestV1,
  document: ModelDocument,
  candidate: SearchCandidate,
  baseMetrics: MetricVector,
  provenance: Provenance,
): RefinementProposalV1 | null {
  const operations = narrowOperations(candidate.operations)
  if (!operations) return null
  const proposal: RefinementProposalV1 = {
    version: 1,
    id: candidate.id,
    requestId: request.id,
    baseRevision: document.revision,
    strategy: candidate.strategy,
    label: candidate.label,
    operations,
    changedPartIds: [
      ...new Set([...candidate.addedPartIds, ...candidate.removedPartIds, ...candidate.modifiedPartIds]),
    ].sort(),
    metrics: {
      before: baseMetrics,
      after: candidate.metrics,
      delta: deltaOf(baseMetrics, candidate.metrics),
    },
    score: Number(candidate.score.toFixed(6)),
    regressions: regressionsOf(baseMetrics, candidate.metrics),
    warnings: candidate.warnings,
    overlay: buildOverlay(document, candidate.document, candidate),
    provenance,
    status: 'ranked',
    rejection: null,
  }
  const validated = refinementProposalSchema.safeParse(proposal)
  return validated.success ? validated.data : null
}

function rejectedProposal(
  request: RefinementRequestV1,
  document: ModelDocument,
  baseMetrics: MetricVector,
  provenance: Provenance,
  rejection: { code: RefinementProposalV1['rejection'] extends null ? never : NonNullable<RefinementProposalV1['rejection']>['code']; reason: string; partIds: readonly string[] },
  strategy: string,
  label: string,
  operations: readonly CadOperation[],
): RefinementProposalV1 {
  const narrowed = narrowOperations(operations) ?? []
  return {
    version: 1,
    id: `rj_${hash32(stableStringify({ request: request.id, strategy, rejection })).toString(36)}`,
    requestId: request.id,
    baseRevision: document.revision,
    strategy,
    label,
    operations: narrowed,
    changedPartIds: [...rejection.partIds].sort(),
    metrics: { before: baseMetrics, after: baseMetrics, delta: zeroVector() },
    score: 0,
    regressions: [],
    warnings: [],
    overlay: [],
    provenance,
    status: 'rejected',
    rejection: { code: rejection.code, reason: rejection.reason, partIds: [...rejection.partIds] },
  }
}

/**
 * A refusal for the parts the request was not allowed to touch.
 *
 * Emitted rather than silently dropped, because "I did not change the cockpit"
 * and "I could not change the cockpit" are different answers and the operator
 * asked for one of them. The rest of the scope is still refined; the refusal
 * names exactly what was held and why.
 */
function protectionRefusal(
  request: RefinementRequestV1,
  document: ModelDocument,
  baseMetrics: MetricVector,
  provenance: Provenance,
): RefinementProposalV1 | null {
  const scope = createScope({
    partIds: request.scopePartIds,
    protectedPartIds: request.protectedPartIds,
    boundaryPartIds: request.boundaryPartIds,
  })
  const held = heldPartIds(document, scope).filter((partId) => scope.partIdSet.has(partId))
  if (!held.length) return null

  const reasons = held.map((partId) => {
    const part = document.parts[partId]
    if (request.protectedPartIds.includes(partId)) return `${partId} was listed as protected by the request`
    if (request.boundaryPartIds.includes(partId)) return `${partId} is a boundary interface for this region`
    if (part?.protected) return `${partId} is marked protected in the document`
    return `${partId} belongs to locked assembly “${document.subassemblies[part?.subassemblyId ?? '']?.name ?? part?.subassemblyId}”`
  })

  return rejectedProposal(
    request,
    document,
    baseMetrics,
    provenance,
    {
      code: 'PROTECTED_PART',
      reason:
        `${held.length} part(s) in the selection cannot be changed: ${reasons.slice(0, 6).join('; ')}. `
        + 'They were held fixed and the rest of the region was refined around them.',
      partIds: held,
    },
    'guard',
    'Held: protected geometry',
    [],
  )
}

/** How many rejected alternatives are surfaced alongside the ranked ones. */
const REJECTION_SAMPLE = 4

function assemble(
  request: RefinementRequestV1,
  document: ModelDocument,
  search: SearchResult,
  provenance: Provenance,
): RefinementProposalV1[] {
  const proposals: RefinementProposalV1[] = []
  const refusal = protectionRefusal(request, document, search.report.baseMetrics, provenance)

  for (const candidate of search.candidates.slice(0, request.maxProposals)) {
    const proposal = toProposal(request, document, candidate, search.report.baseMetrics, provenance)
    if (proposal) proposals.push(proposal)
  }

  if (refusal) proposals.push(refusal)

  // A sample of what was tried and refused, so "why did nothing come back" and
  // "why not the obvious one" both have an answer in the returned value.
  const seen = new Set<string>()
  for (const rejection of search.rejected) {
    if (proposals.length >= request.maxProposals + REJECTION_SAMPLE + (refusal ? 1 : 0)) break
    const key = `${rejection.strategy}|${rejection.code}`
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push(
      rejectedProposal(
        request,
        document,
        search.report.baseMetrics,
        provenance,
        { code: rejection.code, reason: rejection.reason, partIds: rejection.partIds },
        rejection.strategy,
        `Rejected: ${rejection.code}`,
        rejection.operations,
      ),
    )
  }

  return proposals
}

/**
 * The whole flow, synchronously and without a model.
 *
 * This is the path everything else is built on: `proposeRefinements` is this
 * function's proposals, and the model-assisted flow is this function with the
 * goal and the ordering supplied from outside.
 */
export function runRefinement(
  input: RefinementRequestInput,
  document: ModelDocument,
  options: PipelineOptions = {},
): RefinementRun {
  const request = compileRequest(input)
  const reference = referenceFor(document, request)
  const scope = createScope({
    partIds: request.scopePartIds,
    protectedPartIds: request.protectedPartIds,
    boundaryPartIds: request.boundaryPartIds,
    symmetryExceptionPartIds: request.symmetryExceptionPartIds,
    reference,
    instruction: request.instruction,
  })
  const analysis = analyseRegion(document, scope)
  const goal = deterministicGoal({
    instruction: request.instruction,
    analysis,
    seed: request.seed,
    createdAt: options.createdAt,
  })

  const effective: RefinementRequestV1 = {
    ...request,
    referenceSilhouette: reference,
    objectiveWeights: { ...goal.weights, ...request.objectiveWeights },
  }

  const search = searchRefinements(effective, document, {
    budget: options.budget ?? request.budget,
    signal: options.signal,
    strategyIds: goal.strategyIds,
    provideGeometry: options.provideGeometry,
    now: options.now,
  })

  return {
    request: effective,
    analysis,
    goal,
    proposals: assemble(effective, document, search, goal.provenance),
    report: search.report,
    rankingRationale: 'Ranked by measured weighted improvement.',
  }
}

/**
 * Ranked proposals for a request. Mutates nothing.
 *
 * The signature the rest of the application uses. Ghost operations travel with
 * the proposal; the document the caller passed in is untouched, and so is the
 * engine.
 */
export function proposeRefinements(
  request: RefinementRequestInput,
  document: ModelDocument,
  options: PipelineOptions = {},
): RefinementProposalV1[] {
  return runRefinement(request, document, options).proposals
}

/** The same flow with a model consulted for the goal and the ordering. */
export async function proposeRefinementsWithModel(
  input: RefinementRequestInput,
  document: ModelDocument,
  options: PipelineOptions = {},
): Promise<RefinementRun> {
  const request = compileRequest(input)
  const reference = referenceFor(document, request)
  const scope = createScope({
    partIds: request.scopePartIds,
    protectedPartIds: request.protectedPartIds,
    boundaryPartIds: request.boundaryPartIds,
    symmetryExceptionPartIds: request.symmetryExceptionPartIds,
    reference,
    instruction: request.instruction,
  })
  const analysis = analyseRegion(document, scope)
  const goal = await proposeGoal(
    { instruction: request.instruction, analysis, seed: request.seed, createdAt: options.createdAt },
    { provider: options.provider, signal: options.signal, createdAt: options.createdAt },
  )

  const effective: RefinementRequestV1 = {
    ...request,
    referenceSilhouette: reference,
    objectiveWeights: { ...goal.weights, ...request.objectiveWeights },
  }
  const search = searchRefinements(effective, document, {
    budget: options.budget ?? request.budget,
    signal: options.signal,
    strategyIds: goal.strategyIds,
    provideGeometry: options.provideGeometry,
    now: options.now,
  })
  const assembled = assemble(effective, document, search, goal.provenance)
  const ranked = await rankProposals(request.instruction, assembled, {
    provider: options.provider,
    signal: options.signal,
  })

  return {
    request: effective,
    analysis,
    goal,
    proposals: ranked.proposals,
    report: search.report,
    rankingRationale: ranked.rationale,
  }
}

/**
 * Commits a proposal atomically through the command bus.
 *
 * Two refusals happen before the bus is touched. A rejected proposal is not
 * applicable — the guards already said why, and re-deciding that here would give
 * two answers to one question. An empty proposal is not a change. Everything else
 * is the kernel's call, including the stale-revision check, which is deliberately
 * *not* re-implemented here: there is one revision authority and this is not it.
 */
export function applyRefinement(
  proposal: RefinementProposalV1,
  actor: Actor = 'human',
  engine = cadEngine,
  bus = commandBus,
): CommandResult<Transaction> {
  if (proposal.status === 'rejected') {
    return {
      ok: false,
      error: {
        code: 'INVALID_OPERATION',
        message:
          `Proposal ${proposal.id} was rejected: ${proposal.rejection?.reason ?? 'it did not pass the refinement guards.'}`,
        repair: 'Adjust the scope, protection list or objective weights and ask for proposals again.',
        details: proposal.rejection,
      },
    }
  }
  if (!proposal.operations.length) {
    return {
      ok: false,
      error: {
        code: 'INVALID_OPERATION',
        message: `Proposal ${proposal.id} contains no operations.`,
        repair: 'Choose a proposal that changes something.',
      },
    }
  }
  void engine
  return bus.dispatch(proposal.label, proposal.operations, actor, proposal.baseRevision, 'refinement_apply')
}

/** Convenience: the metric vector a document scores under a request's scope. */
export function metricsFor(document: ModelDocument, request: RefinementRequestV1): MetricVector {
  return measureAll(
    document,
    createScope({
      partIds: request.scopePartIds,
      protectedPartIds: request.protectedPartIds,
      boundaryPartIds: request.boundaryPartIds,
      symmetryExceptionPartIds: request.symmetryExceptionPartIds,
      reference: request.referenceSilhouette,
      instruction: request.instruction,
    }),
  )
}
