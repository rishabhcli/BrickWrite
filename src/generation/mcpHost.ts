import { cadEngine } from '../cad/engine'
import { ContractError } from '../webmcp/contract'
import {
  onReviewDiscard,
  registerSurfaceDisposer,
  surfaceSnapshot,
  type GenerationSurface,
} from '../webmcp/surfaceSnapshot'
import type { DesignBrief } from '../platform/contracts'
import {
  GenerationSession,
  unresolvedConflicts,
  type GenerateState,
  type GenerationSessionOptions,
} from './session'

let current: GenerationSession | null = null
let unsubscribe: (() => void) | null = null
let dropReview: (() => void) | null = null
let dropHost: (() => void) | null = null

export function compactGeneration(state: GenerateState) {
  return {
    prompt: state.prompt,
    briefPhase: state.briefPhase,
    brief: state.brief && {
      subject: state.brief.subject,
      envelopeStuds: state.brief.envelopeStuds,
      scale: state.brief.scale,
      palette: state.brief.palette,
      partBudget: state.brief.partBudget,
      symmetry: state.brief.symmetry,
      functions: state.brief.functions,
      style: state.brief.style,
      conflicts: state.brief.conflicts,
    },
    briefMethod: state.briefMethod,
    unresolvedConflicts: unresolvedConflicts(state).map((conflict) => conflict.field),
    candidateCount: state.candidateCount,
    runPhase: state.runPhase,
    stage: state.stage,
    usedModel: state.usedModel,
    elapsedMs: state.elapsedMs,
    briefIssue: state.briefIssue,
    runIssue: state.runIssue,
    selectedCandidateId: state.selectedCandidateId,
    ghost: state.ghost,
    outcome: state.outcome,
    candidates: (state.run?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      strategy: candidate.strategy,
      structuralHash: candidate.structuralHash,
      partCount: candidate.metrics.partCount,
      collisionCount: candidate.metrics.collisionCount,
      componentCount: candidate.metrics.componentCount,
      supportMarginLdu: candidate.metrics.supportMarginLdu,
    })),
    rejected: (state.run?.rejected ?? []).map((entry) => ({
      id: entry.candidate.id,
      strategy: entry.candidate.strategy,
      failures: entry.failures,
    })),
    notes: state.run?.notes ?? [],
  }
}

const surfaceOf = (state: GenerateState): GenerationSurface => ({
  briefPhase: state.briefPhase,
  runPhase: state.runPhase,
  candidateCount: state.candidateCount,
  selectedCandidateId: state.selectedCandidateId,
  ghost: Boolean(state.ghost),
})

function attach(session: GenerationSession) {
  unsubscribe?.()
  dropReview?.()
  dropHost?.()
  const publish = () => {
    surfaceSnapshot.generation = surfaceOf(session.getState())
  }
  unsubscribe = session.subscribe(publish)
  dropReview = onReviewDiscard(() => current?.discardGhost())
  dropHost = registerSurfaceDisposer(() => {
    if (current !== session) return
    unsubscribe?.()
    unsubscribe = null
    dropReview?.()
    dropReview = null
    session.dispose()
    current = null
    surfaceSnapshot.generation = null
  })
  publish()
}

export function peekGenerationSession(): GenerationSession | null {
  return current
}

export function getGenerationSession(options?: GenerationSessionOptions): GenerationSession {
  if (options) {
    current?.dispose()
    current = new GenerationSession(options)
    attach(current)
    return current
  }
  if (!current) {
    current = new GenerationSession()
    attach(current)
  }
  return current
}

export function disposeGenerationHost() {
  const session = current
  current = null
  unsubscribe?.()
  unsubscribe = null
  dropReview?.()
  dropReview = null
  dropHost?.()
  dropHost = null
  session?.dispose()
  surfaceSnapshot.generation = null
}

export function generationState() {
  return compactGeneration(getGenerationSession().getState())
}

export async function compileBriefFromServer(prompt?: string) {
  const session = getGenerationSession()
  if (prompt !== undefined) session.setPrompt(prompt)
  if (!session.getState().prompt.trim()) {
    throw new ContractError('INVALID_INPUT', 'Nothing to compile.', 'Send prompt, or call generation_set with a prompt first.')
  }
  await session.compile()
  const state = session.getState()
  if (state.briefPhase === 'unavailable') {
    throw new ContractError(
      'MODEL_UNAVAILABLE',
      state.briefIssue?.detail ?? 'The brief route is not available.',
      'Call generation_compile_local, or fix the /api/brief credential and retry.',
      { state: compactGeneration(state) },
    )
  }
  if (state.briefPhase === 'error') {
    throw new ContractError(
      'INTERNAL_ERROR',
      state.briefIssue?.detail ?? 'Brief compilation failed.',
      'Fix the prompt or call generation_compile_local.',
      { state: compactGeneration(state) },
    )
  }
  return compactGeneration(state)
}

export function compileBriefLocal(prompt?: string) {
  const session = getGenerationSession()
  if (prompt !== undefined) session.setPrompt(prompt)
  if (!session.getState().prompt.trim()) {
    throw new ContractError('INVALID_INPUT', 'Nothing to compile.', 'Send prompt, or call generation_set with a prompt first.')
  }
  session.compileLocally()
  return compactGeneration(session.getState())
}

export function setGeneration(input: {
  prompt?: string
  candidateCount?: number
  reason?: string
  brief?: Partial<DesignBrief>
  conflict?: { field: string; choice: 'compiler' | 'operator' }
}) {
  const session = getGenerationSession()
  if (input.prompt !== undefined) session.setPrompt(input.prompt)
  if (input.candidateCount !== undefined) session.setCandidateCount(input.candidateCount)
  if (input.brief) {
    if (!session.getState().brief) {
      throw new ContractError('INVALID_INPUT', 'No brief is ready to edit.', 'Call generation_compile or generation_compile_local first.')
    }
    session.editBrief(input.brief, input.reason ?? 'agent edit')
  }
  if (input.conflict) session.resolveConflict(input.conflict.field, input.conflict.choice)
  return compactGeneration(session.getState())
}

export async function runGeneration(useModel?: boolean) {
  const session = getGenerationSession()
  const before = session.getState()
  if (!before.brief) {
    throw new ContractError('INVALID_INPUT', 'No brief is ready.', 'Call generation_compile or generation_compile_local first.')
  }
  const open = unresolvedConflicts(before)
  if (open.length) {
    throw new ContractError(
      'INVALID_INPUT',
      'The brief still has unresolved conflicts.',
      'Call generation_set with conflict={ field, choice } for each remaining field.',
      { fields: open.map((conflict) => conflict.field) },
    )
  }
  await session.generate(cadEngine.getDocument(), { useModel })
  const state = session.getState()
  if (state.runPhase === 'unavailable') {
    throw new ContractError(
      'MODEL_UNAVAILABLE',
      state.runIssue?.detail ?? 'The generation route is not available.',
      'Retry generation_run with useModel=false.',
      { state: compactGeneration(state) },
    )
  }
  if (state.runPhase === 'error') {
    throw new ContractError(
      'INTERNAL_ERROR',
      state.runIssue?.detail ?? 'Generation failed.',
      'Inspect generation_state and retry, or lower candidateCount.',
      { state: compactGeneration(state) },
    )
  }
  return compactGeneration(state)
}

export function cancelGeneration() {
  const session = getGenerationSession()
  session.cancel()
  return compactGeneration(session.getState())
}

export function previewCandidate(candidateId: string) {
  const session = getGenerationSession()
  const exists = session.getState().run?.candidates.some((candidate) => candidate.id === candidateId)
  if (!exists) {
    throw new ContractError(
      'INVALID_INPUT',
      `Candidate ${candidateId} is not in the current run.`,
      'Call generation_state and pick an id from candidates.',
    )
  }
  session.selectCandidate(candidateId)
  return compactGeneration(session.getState())
}

export function applyGeneration(expectedRevision?: number) {
  const session = getGenerationSession()
  const ghost = session.getState().ghost
  if (!ghost) {
    throw new ContractError('INVALID_INPUT', 'Nothing is under review.', 'Call generation_preview with a candidateId first.')
  }
  if (expectedRevision !== undefined && expectedRevision !== ghost.baseRevision) {
    throw new ContractError(
      'STALE_DOCUMENT',
      `Expected revision ${expectedRevision}; ghost was verified at ${ghost.baseRevision}.`,
      'Call generation_state, then generation_preview against the current document.',
      { currentRevision: cadEngine.getDocument().revision },
    )
  }
  const outcome = session.accept('agent')
  if (outcome.kind !== 'applied') {
    const code =
      outcome.code === 'STALE_DOCUMENT' || outcome.code === 'COLLISION' || outcome.code === 'DISCONNECTED'
        ? outcome.code
        : 'INVALID_OPERATION'
    throw new ContractError(code, outcome.detail, outcome.repair ?? 'Call generation_state and preview another candidate.')
  }
  return {
    ...compactGeneration(session.getState()),
    outcome,
    documentRevision: cadEngine.getDocument().revision,
  }
}
