/**
 * The generation session, and the operations both agent surfaces perform on it.
 *
 * There is one generation session per workbench mount and three ways to reach
 * it: the Generate panel, the WebMCP gateway, and the in-editor Design Partner.
 * They share this module so they share the session — if a builder types a brief
 * into the panel the assistant can read it back through `generation_state`, and
 * a brief the assistant compiled shows up in the panel. Two sessions would mean
 * two briefs and a ghost neither surface could account for.
 *
 * This file used to be `mcpHost.ts`, which named the wrong thing: WebMCP was
 * only the first caller. `mcpHost.ts` now re-exports this, so the gateway's
 * lazy chunk boundary is unchanged.
 *
 * Nothing here writes the document. `applyGeneration` goes through the session,
 * which goes through `commandBus` at the revision the ghost was verified at.
 */
import { cadEngine } from '../cad/engine'
import type { CadOperation } from '../cad/types'
import { candidateOperations } from './engine'
// Side-effect import: registers `generate_from_brief` and `generate_region`
// with the shared capability vocabulary. Loading any generation entry point —
// the panel, WebMCP, or the Design Partner — is what makes those two planable.
import './capability'
import { ContractError } from '../webmcp/contract'
import {
  onReviewDiscard,
  registerSurfaceDisposer,
  surfaceSnapshot,
  type GenerationSurface,
} from '../webmcp/surfaceSnapshot'
import type { DesignBrief } from '../platform/contracts'
import { GenerationSession, unresolvedConflicts, type GenerateState, type GenerationSessionOptions } from './session'

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
      // Present only when the part ceiling stopped the build early. A caller
      // that ignores it gets a working model that is smaller than the brief;
      // one that reads it gets the call that finishes the job.
      ...(candidate.continuation ? { continuation: candidate.continuation } : {}),
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
    throw new ContractError(
      'INVALID_INPUT',
      'Nothing to compile.',
      'Send prompt, or call generation_set with a prompt first.',
    )
  }
  await session.compile()
  const state = session.getState()
  if (state.briefPhase === 'unavailable') {
    throw new ContractError(
      'MODEL_UNAVAILABLE',
      state.briefIssue?.detail ?? 'The brief route is not available.',
      'Call generation_compile with useModel false, or fix the /api/brief credential and retry.',
      { state: compactGeneration(state) },
    )
  }
  if (state.briefPhase === 'error') {
    throw new ContractError(
      'INTERNAL_ERROR',
      state.briefIssue?.detail ?? 'Brief compilation failed.',
      'Fix the prompt or call generation_compile with useModel false.',
      { state: compactGeneration(state) },
    )
  }
  return compactGeneration(state)
}

export function compileBriefLocal(prompt?: string) {
  const session = getGenerationSession()
  if (prompt !== undefined) session.setPrompt(prompt)
  if (!session.getState().prompt.trim()) {
    throw new ContractError(
      'INVALID_INPUT',
      'Nothing to compile.',
      'Send prompt, or call generation_set with a prompt first.',
    )
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
      throw new ContractError('INVALID_INPUT', 'No brief is ready to edit.', 'Call generation_compile first.')
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
    throw new ContractError('INVALID_INPUT', 'No brief is ready.', 'Call generation_compile first.')
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
    throw new ContractError(
      'INVALID_INPUT',
      'Nothing is under review.',
      'Call generation_preview with a candidateId first.',
    )
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
      outcome.code === 'STALE_DOCUMENT' ||
      outcome.code === 'COLLISION' ||
      outcome.code === 'DISCONNECTED' ||
      outcome.code === 'CONSTRAINT_VIOLATION'
        ? outcome.code
        : 'INVALID_OPERATION'
    throw new ContractError(
      code,
      outcome.detail,
      outcome.repair ?? 'Call generation_state and preview another candidate.',
    )
  }
  return {
    ...compactGeneration(session.getState()),
    outcome,
    documentRevision: cadEngine.getDocument().revision,
  }
}

/**
 * A refusal from this host, in the shape a caller can report without knowing
 * what a `ContractError` is.
 *
 * The WebMCP gateway understands `ContractError` because it defines it. The
 * Design Partner's tool host deliberately does not import the gateway, so it
 * asks here instead and gets back the same code, message and repair the MCP
 * client would have seen. One refusal vocabulary, two doors.
 */
export function refusalOf(cause: unknown): { code: string; message: string; repair: string; details?: unknown } | null {
  if (!(cause instanceof ContractError)) return null
  return {
    code: cause.code,
    message: cause.message,
    repair: cause.repair,
    ...(cause.details ? { details: cause.details } : {}),
  }
}

// ---------------------------------------------------------------------------
// Review through the agent's wave ledger
// ---------------------------------------------------------------------------

/** One candidate, resolved into the operations a reviewable wave carries. */
export interface CandidateWavePlan {
  readonly candidateId: string
  readonly strategy: string
  readonly label: string
  readonly summary: string
  readonly operations: readonly CadOperation[]
  readonly partCount: number
  readonly collisionCount: number
  readonly componentCount: number
  readonly notes: readonly string[]
}

/**
 * Resolves a candidate for a reviewer outside this panel.
 *
 * The Generate panel reviews a candidate as its own ghost; the Design Partner
 * reviews it as a wave, because that is the one review queue Propose mode and
 * the accept button already know about. Both end at `commandBus.preflight`, so
 * "generated" and "placed by hand" are the same kind of pending change — a
 * builder accepts a 900-part candidate through the control they already use.
 */
export function planCandidateWave(candidateId: string): CandidateWavePlan {
  const session = getGenerationSession()
  const state = session.getState()
  if (!state.run) {
    throw new ContractError(
      'INVALID_INPUT',
      'No generation run is loaded.',
      'Call generation_run first, then preview a candidate id from its result.',
    )
  }
  const candidate = session.adoptCandidate(candidateId)
  if (!candidate) {
    throw new ContractError(
      'INVALID_INPUT',
      `Candidate ${candidateId} is not in the current run.`,
      'Call generation_state and pick an id from candidates.',
      { available: state.run.candidates.map((entry) => entry.id) },
    )
  }
  const subject = state.brief?.subject?.trim()
  return {
    candidateId,
    strategy: candidate.strategy,
    label: subject ? `Generated: ${subject}` : `Generated: ${candidate.strategy}`,
    summary: `${candidate.metrics.partCount} parts from the ${candidate.strategy} strategy.`,
    operations: candidateOperations(candidate),
    partCount: candidate.metrics.partCount,
    collisionCount: candidate.metrics.collisionCount,
    componentCount: candidate.metrics.componentCount,
    notes: candidate.notes,
  }
}

// ---------------------------------------------------------------------------
// The shared host object
// ---------------------------------------------------------------------------

/** The compact session projection every agent surface reports. */
export type CompactGeneration = ReturnType<typeof compactGeneration>

export type GenerationSetInput = Parameters<typeof setGeneration>[0]

export interface GenerationHost {
  compileFromServer(prompt?: string): Promise<CompactGeneration>
  compileLocal(prompt?: string): CompactGeneration
  set(input: GenerationSetInput): CompactGeneration
  run(input?: { useModel?: boolean }): Promise<CompactGeneration>
  state(): CompactGeneration
  cancel(): CompactGeneration
  preview(candidateId: string): CompactGeneration
  planWave(candidateId: string): CandidateWavePlan
  apply(expectedRevision?: number): ReturnType<typeof applyGeneration>
}

/**
 * The pipeline as one object, for callers that would rather hold a handle than
 * import eight functions.
 *
 * Every method throws `ContractError` on a refusal, with the code, the
 * measured detail, and the repair — the caller decides how to render that. The
 * WebMCP gateway turns it into a contract error; `src/agent/tools.ts` turns it
 * into a tool failure with the same code, so the model reads one vocabulary
 * whichever door it came through.
 */
export function getGenerationHost(): GenerationHost {
  return {
    compileFromServer: (prompt) => compileBriefFromServer(prompt),
    compileLocal: (prompt) => compileBriefLocal(prompt),
    set: (input) => setGeneration(input),
    run: (input) => runGeneration(input?.useModel),
    state: () => generationState(),
    cancel: () => cancelGeneration(),
    preview: (candidateId) => previewCandidate(candidateId),
    planWave: (candidateId) => planCandidateWave(candidateId),
    apply: (expectedRevision) => applyGeneration(expectedRevision),
  }
}
