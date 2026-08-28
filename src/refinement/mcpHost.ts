import { cadEngine } from '../cad/engine'
import { ContractError } from '../webmcp/contract'
import {
  onReviewDiscard,
  registerSurfaceDisposer,
  surfaceSnapshot,
  type RefinementSurface,
} from '../webmcp/surfaceSnapshot'
import { analyseRegion, createScope } from './analyse'
import {
  rankedProposals,
  RefinementSession,
  type RefineEffortId,
  type RefinementSessionOptions,
  type RefineState,
} from './session'

let current: RefinementSession | null = null
let unsubscribe: (() => void) | null = null
let dropReview: (() => void) | null = null
let dropHost: (() => void) | null = null

export function compactRefinement(state: RefineState) {
  return {
    status: state.status,
    instruction: state.instruction,
    effort: state.effort,
    scopePartIds: state.scopePartIds,
    baseRevision: state.baseRevision,
    selectedId: state.selectedId,
    ranOn: state.ranOn,
    rankingRationale: state.rankingRationale,
    elapsedMs: state.elapsedMs,
    budgetMs: state.budgetMs,
    error: state.error,
    outcome: state.outcome,
    proposals: rankedProposals(state).map((proposal) => ({
      id: proposal.id,
      strategy: proposal.strategy,
      label: proposal.label,
      status: proposal.status,
      score: proposal.score,
      baseRevision: proposal.baseRevision,
      operationCount: proposal.operations.length,
      changedPartCount: proposal.changedPartIds.length,
      regressions: proposal.regressions,
    })),
    refused: state.proposals
      .filter((proposal) => proposal.status === 'rejected')
      .slice(0, 8)
      .map((proposal) => ({
        id: proposal.id,
        strategy: proposal.strategy,
        reason: proposal.rejection?.reason ?? proposal.warnings[0] ?? 'rejected',
      })),
  }
}

const surfaceOf = (state: RefineState): RefinementSurface => ({
  status: state.status,
  proposalCount: rankedProposals(state).length,
  selectedId: state.selectedId,
})

function attach(session: RefinementSession) {
  unsubscribe?.()
  dropReview?.()
  dropHost?.()
  const publish = () => {
    surfaceSnapshot.refinement = surfaceOf(session.getState())
  }
  unsubscribe = session.subscribe(publish)
  dropReview = onReviewDiscard(() => current?.reset())
  dropHost = registerSurfaceDisposer(() => {
    if (current !== session) return
    unsubscribe?.()
    unsubscribe = null
    dropReview?.()
    dropReview = null
    session.dispose()
    current = null
    surfaceSnapshot.refinement = null
  })
  publish()
}

export function peekRefinementSession(): RefinementSession | null {
  return current
}

export function getRefinementSession(options?: RefinementSessionOptions): RefinementSession {
  if (options) {
    current?.dispose()
    current = new RefinementSession(options)
    attach(current)
    return current
  }
  if (!current) {
    current = new RefinementSession()
    attach(current)
  }
  return current
}

export function disposeRefinementHost() {
  const session = current
  current = null
  unsubscribe?.()
  unsubscribe = null
  dropReview?.()
  dropReview = null
  dropHost?.()
  dropHost = null
  session?.dispose()
  surfaceSnapshot.refinement = null
}

function resolveScope(partIds: readonly string[] | undefined): string[] {
  const ids = [...new Set(partIds?.length ? partIds : cadEngine.getSnapshot().selection)]
  if (!ids.length) {
    throw new ContractError(
      'INVALID_INPUT',
      'Nothing is selected, so there is no region to refine.',
      'Select parts in the viewport or pass partIds.',
    )
  }
  return ids
}

export function analyseSelection(partIds?: readonly string[]) {
  const document = cadEngine.getDocument()
  const scopePartIds = resolveScope(partIds)
  const analysis = analyseRegion(document, createScope({ partIds: scopePartIds }))
  return {
    documentRevision: document.revision,
    scopeCount: analysis.scopePartIds.length,
    scopePartIds: analysis.scopePartIds.slice(0, 80),
    issueCount: analysis.issues.length,
    issues: analysis.issues.slice(0, 20).map((issue) => ({
      id: issue.id,
      kind: issue.kind,
      severity: issue.severity,
      measure: issue.measure,
      unit: issue.unit,
      detail: issue.detail,
      partIds: issue.partIds.slice(0, 8),
    })),
    seamCount: analysis.seamCount,
    weakAttachmentCount: analysis.weakAttachments.length,
    costBasis: analysis.costBasis,
  }
}

export async function proposeRefinements(input: {
  instruction?: string
  effort?: RefineEffortId
  partIds?: readonly string[]
}) {
  const session = getRefinementSession()
  if (input.instruction !== undefined) session.setInstruction(input.instruction)
  if (input.effort) session.setEffort(input.effort)
  const scope = resolveScope(input.partIds)
  await session.run(cadEngine.getDocument(), scope)
  const state = session.getState()
  if (state.status === 'error') {
    throw new ContractError('INTERNAL_ERROR', state.error ?? 'Refinement search failed.', 'Inspect refinement_state and retry with a smaller selection.')
  }
  return compactRefinement(state)
}

export function refinementState() {
  return compactRefinement(getRefinementSession().getState())
}

export function cancelRefinement() {
  const session = getRefinementSession()
  session.cancel()
  return compactRefinement(session.getState())
}

export function selectRefinement(proposalId: string) {
  const session = getRefinementSession()
  const exists = session.getState().proposals.some((proposal) => proposal.id === proposalId)
  if (!exists) {
    throw new ContractError(
      'INVALID_INPUT',
      `Proposal ${proposalId} is not in the current result set.`,
      'Call refinement_state and pick an id from proposals.',
    )
  }
  session.select(proposalId)
  return compactRefinement(session.getState())
}

export function applyRefinementProposal(input: { proposalId?: string; expectedRevision?: number }) {
  const session = getRefinementSession()
  const state = session.getState()
  const proposalId = input.proposalId ?? state.selectedId
  if (!proposalId) {
    throw new ContractError('INVALID_INPUT', 'No refinement proposal is selected.', 'Call refinement_select or pass proposalId.')
  }
  const proposal = state.proposals.find((entry) => entry.id === proposalId)
  if (!proposal) {
    throw new ContractError('INVALID_INPUT', `Proposal ${proposalId} is not in the current result set.`, 'Call refinement_propose again.')
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== proposal.baseRevision) {
    throw new ContractError(
      'STALE_DOCUMENT',
      `Expected revision ${input.expectedRevision}; proposal was found at ${proposal.baseRevision}.`,
      'Call refinement_propose against the current document.',
      { currentRevision: cadEngine.getDocument().revision },
    )
  }
  const outcome = session.accept(proposalId, 'agent')
  if (outcome.kind !== 'applied') {
    const code = outcome.code === 'STALE_DOCUMENT' ? 'STALE_DOCUMENT' : 'INVALID_OPERATION'
    throw new ContractError(code, outcome.detail, outcome.repair ?? 'Search again against the current revision.')
  }
  return {
    ...compactRefinement(session.getState()),
    outcome,
    documentRevision: cadEngine.getDocument().revision,
  }
}
