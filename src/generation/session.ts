import { cadEngine, commandBus } from '../cad/engine'
import type { Actor, CadOperation, CommandResult, ModelDocument, Proposal, Transaction } from '../cad/types'
import {
  ModelProviderUnavailableError,
  type DesignBrief,
  type Provenance,
} from '../platform/contracts'
import { amendBrief, compileBriefDeterministically } from './brief'
import { candidateOperations, GenerationEngine, type GenerationRun } from './engine'
import { PHASES, type Candidate, type PhaseEvent, type PhaseName } from './phases'
import { compileBriefViaServer, createGenerationProvider, type GenerationClientOptions } from './provider'
import type { MetricVector } from './score'

/**
 * The state behind the Generate panel.
 *
 * Generation is a three-act flow — compile a brief, run the pipeline, review a
 * candidate — and each act can fail in a way the operator has to be told about
 * precisely. So the state machine is explicit rather than derived from whether
 * some array happens to be empty: "the route is unreachable", "the key is not
 * set", "the model answered but no candidate passed the gates" and "you stopped
 * it" are four different situations and each one gets its own designed surface.
 *
 * Nothing here writes a document. The only mutation in this module is
 * `accept`, which goes through the command bus at the revision the ghost was
 * verified against.
 */

export type BriefPhase = 'idle' | 'compiling' | 'ready' | 'unavailable' | 'error'
export type RunPhase = 'idle' | 'running' | 'ready' | 'cancelled' | 'unavailable' | 'error'

/** How the operator resolved one contradiction the compiler could not decide. */
export type ConflictChoice = 'compiler' | 'operator'

/**
 * A precise account of why a model route did not answer.
 *
 * `unavailable` means the route reported no credential or could not be reached
 * at all — a condition with a specific fix. `error` is everything else. The two
 * are kept apart because telling somebody "generation failed" when the real
 * answer is "no API key is configured on the server" wastes their afternoon.
 */
export interface ProviderIssue {
  readonly kind: 'unavailable' | 'error'
  readonly title: string
  readonly detail: string
  readonly route: string
}

/** One phase completing, for the running readout. */
export interface PhaseTick {
  readonly candidateIndex: number
  readonly phase: PhaseName
  readonly strategy: string
  readonly nodesAdded: number
  readonly partsAdded: number
  readonly partCount: number
  readonly elapsedMs: number
}

/** A candidate previewed as a ghost, verified by the kernel, not yet committed. */
export interface GhostReview {
  readonly candidateId: string
  readonly proposalId: string
  readonly baseRevision: number
  readonly collisions: number
  readonly partCount: number
}

export interface GenerateOutcome {
  readonly kind: 'applied' | 'stale' | 'refused' | 'discarded'
  readonly title: string
  readonly detail: string
  readonly repair: string | null
  readonly code: string | null
}

export interface GenerateState {
  readonly prompt: string
  readonly briefPhase: BriefPhase
  readonly brief: DesignBrief | null
  readonly briefMethod: 'model' | 'deterministic' | null
  readonly briefProvenance: Provenance | null
  readonly briefNotes: readonly string[]
  readonly briefIssue: ProviderIssue | null
  readonly conflictChoices: Readonly<Record<string, ConflictChoice>>
  readonly candidateCount: number
  readonly runPhase: RunPhase
  /** The stage the server last reported, verbatim. */
  readonly stage: string | null
  readonly ticks: readonly PhaseTick[]
  readonly run: GenerationRun | null
  readonly runIssue: ProviderIssue | null
  readonly usedModel: boolean | null
  readonly selectedCandidateId: string | null
  readonly ghost: GhostReview | null
  readonly outcome: GenerateOutcome | null
  readonly elapsedMs: number
}

/**
 * The kernel seam.
 *
 * Three operations, because ghost review needs all three: `preflight` builds the
 * preview the viewport draws, `withdraw` takes it back when the operator moves
 * on, and `dispatch` is the one door that writes.
 */
export interface GenerationGhostBus {
  preflight(
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision?: number,
  ): CommandResult<Proposal>
  dispatch(
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision?: number,
    sourceTool?: string,
  ): CommandResult<Transaction>
  withdraw(proposalId: string): void
}

/** Wraps an engine instance in the seam the module singletons expose. */
export const generationBusFor = (engine: {
  preflight: GenerationGhostBus['preflight']
  execute: (
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision?: number,
    sourceTool?: string,
  ) => CommandResult<Transaction>
  rejectProposal: (proposalId: string) => unknown
}): GenerationGhostBus => ({
  preflight: (label, operations, actor, expectedRevision) =>
    engine.preflight(label, operations, actor, expectedRevision),
  dispatch: (label, operations, actor, expectedRevision, sourceTool) =>
    engine.execute(label, operations, actor, expectedRevision, sourceTool),
  withdraw: (proposalId) => {
    engine.rejectProposal(proposalId)
  },
})

const liveBus: GenerationGhostBus = {
  preflight: (label, operations, actor, expectedRevision) =>
    commandBus.preflight(label, operations, actor, expectedRevision),
  dispatch: (label, operations, actor, expectedRevision, sourceTool) =>
    commandBus.dispatch(label, operations, actor, expectedRevision, sourceTool),
  withdraw: (proposalId) => {
    cadEngine.rejectProposal(proposalId)
  },
}

export interface BriefCompile {
  readonly brief: DesignBrief
  readonly method: 'model' | 'deterministic'
  readonly provenance: Provenance | null
  readonly notes: readonly string[]
}

export type BriefRunner = (text: string, signal: AbortSignal) => Promise<BriefCompile>

export interface GenerationRunInput {
  readonly brief: DesignBrief
  readonly base: ModelDocument
  readonly count: number
  readonly useModel: boolean
  readonly signal: AbortSignal
  readonly onPhase: (event: PhaseEvent, candidateIndex: number) => void
  readonly onStage: (stage: string) => void
}

export type GenerationRunner = (input: GenerationRunInput) => Promise<GenerationRun>

export interface GenerationSessionOptions {
  /** Passed to the real `/api/brief` and `/api/generate` clients. */
  readonly client?: GenerationClientOptions
  readonly briefRunner?: BriefRunner
  readonly runner?: GenerationRunner
  readonly bus?: GenerationGhostBus
  /** Zero disables the elapsed ticker, which a component test wants. */
  readonly tickMs?: number
  readonly now?: () => number
}

const INITIAL: GenerateState = {
  prompt: '',
  briefPhase: 'idle',
  brief: null,
  briefMethod: null,
  briefProvenance: null,
  briefNotes: [],
  briefIssue: null,
  conflictChoices: {},
  candidateCount: 3,
  runPhase: 'idle',
  stage: null,
  ticks: [],
  run: null,
  runIssue: null,
  usedModel: null,
  selectedCandidateId: null,
  ghost: null,
  outcome: null,
  elapsedMs: 0,
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Unknown failure.'

const isAbort = (cause: unknown): boolean =>
  cause instanceof DOMException ? cause.name === 'AbortError' : cause instanceof Error && cause.name === 'AbortError'

/**
 * Turns a thrown provider failure into something the panel can print.
 *
 * `ModelProviderUnavailableError` is the provider's own signal that there is no
 * credential or no route, and it carries the server's detail verbatim. It is
 * never softened into "try again later": the fix is a configuration change, and
 * a message that hides that produces a retry loop instead.
 */
const issueFor = (cause: unknown, route: string): ProviderIssue =>
  cause instanceof ModelProviderUnavailableError
    ? {
        kind: 'unavailable',
        title: `${route} is not available`,
        detail: describe(cause),
        route,
      }
    : { kind: 'error', title: `${route} failed`, detail: describe(cause), route }

export class GenerationSession {
  private state: GenerateState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly client: GenerationClientOptions
  private readonly briefRunner: BriefRunner
  private readonly runner: GenerationRunner
  private readonly bus: GenerationGhostBus
  private readonly tickMs: number
  private readonly now: () => number
  private briefController: AbortController | null = null
  private runController: AbortController | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private runSeq = 0

  constructor(options: GenerationSessionOptions = {}) {
    this.client = options.client ?? {}
    this.briefRunner = options.briefRunner ?? this.defaultBriefRunner
    this.runner = options.runner ?? this.defaultRunner
    this.bus = options.bus ?? liveBus
    this.tickMs = options.tickMs ?? 200
    this.now = options.now ?? (() => Date.now())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): GenerateState => this.state

  private set(patch: Partial<GenerateState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  // -- defaults ------------------------------------------------------------

  private defaultBriefRunner: BriefRunner = async (text, signal) => {
    const result = await compileBriefViaServer(text, { ...this.client, signal })
    return {
      brief: result.brief,
      method: 'model',
      provenance: result.provenance,
      notes: [],
    }
  }

  private defaultRunner: GenerationRunner = async (input) => {
    // With `useModel` false the engine is constructed without a provider, which
    // is a real rule-based path and reports itself as `deterministic` in the
    // provenance. It is offered only when the operator asks for it after being
    // told the route is unavailable — never substituted silently.
    const engine = input.useModel
      ? new GenerationEngine({
          provider: createGenerationProvider({ ...this.client, onProgress: input.onStage }),
        })
      : new GenerationEngine()
    return await engine.generate(input.brief, {
      base: input.base,
      count: input.count,
      signal: input.signal,
      onPhase: input.onPhase,
    })
  }

  // -- brief ---------------------------------------------------------------

  setPrompt(prompt: string) {
    this.set({ prompt })
  }

  setCandidateCount(candidateCount: number) {
    this.set({ candidateCount: Math.max(1, Math.min(6, Math.round(candidateCount))) })
  }

  /** Compiles the prompt into a brief through `/api/brief`. */
  async compile(): Promise<void> {
    const text = this.state.prompt.trim()
    if (!text) {
      this.set({
        briefPhase: 'error',
        briefIssue: {
          kind: 'error',
          title: 'Nothing to compile',
          detail: 'Describe what you want built before compiling a brief.',
          route: '/api/brief',
        },
      })
      return
    }
    this.briefController?.abort()
    const controller = new AbortController()
    this.briefController = controller
    this.set({ briefPhase: 'compiling', briefIssue: null, brief: null, conflictChoices: {} })
    try {
      const result = await this.briefRunner(text, controller.signal)
      if (controller.signal.aborted) return
      this.applyCompiled(result)
    } catch (cause) {
      if (controller.signal.aborted || isAbort(cause)) return
      const issue = issueFor(cause, '/api/brief')
      this.set({ briefPhase: issue.kind === 'unavailable' ? 'unavailable' : 'error', briefIssue: issue })
    }
  }

  /**
   * Compiles the brief here, from rules, at the operator's explicit request.
   *
   * Offered only after the route has said it cannot answer. It is a real
   * compiler — it reads dimensions, budgets, colours, functions, symmetry and
   * scale out of the text and records the phrase behind each — and the panel
   * labels every field it produced as rule-derived rather than model-derived.
   */
  compileLocally(): void {
    const text = this.state.prompt.trim()
    if (!text) return
    this.applyCompiled({
      brief: compileBriefDeterministically(text),
      method: 'deterministic',
      provenance: null,
      notes: ['Compiled from rules in this browser because the brief route was unavailable. No model read this request.'],
    })
  }

  private applyCompiled(result: BriefCompile) {
    this.set({
      briefPhase: 'ready',
      brief: result.brief,
      briefMethod: result.method,
      briefProvenance: result.provenance,
      briefNotes: [...result.notes],
      briefIssue: null,
      conflictChoices: {},
      run: null,
      runPhase: 'idle',
      ticks: [],
      selectedCandidateId: null,
    })
  }

  /** Records an operator edit, keeping the evidence trail the compiler built. */
  editBrief(patch: Partial<DesignBrief>, reason: string) {
    const brief = this.state.brief
    if (!brief) return
    const next = amendBrief(brief, patch, reason)
    // Editing a field *is* a resolution of any conflict about that field, so the
    // choice is recorded rather than left outstanding and asked about again.
    const choices = { ...this.state.conflictChoices }
    for (const field of Object.keys(patch)) {
      if (brief.conflicts.some((conflict) => conflict.field === field)) choices[field] = 'operator'
    }
    this.set({ brief: next, conflictChoices: choices })
  }

  /** Records how the operator settled one contradiction. Never inferred. */
  resolveConflict(field: string, choice: ConflictChoice) {
    this.set({ conflictChoices: { ...this.state.conflictChoices, [field]: choice } })
  }

  // -- generation ----------------------------------------------------------

  async generate(base: ModelDocument, options: { useModel?: boolean } = {}): Promise<void> {
    const brief = this.state.brief
    if (!brief) return
    if (unresolvedConflicts(this.state).length) return

    this.discardGhost()
    this.runController?.abort()
    const controller = new AbortController()
    this.runController = controller
    const seq = ++this.runSeq
    const useModel = options.useModel ?? true

    this.startedAt = this.now()
    this.set({
      runPhase: 'running',
      runIssue: null,
      run: null,
      ticks: [],
      stage: null,
      usedModel: useModel,
      selectedCandidateId: null,
      outcome: null,
      elapsedMs: 0,
    })
    this.startTicker()

    try {
      const run = await this.runner({
        brief,
        base,
        count: this.state.candidateCount,
        useModel,
        signal: controller.signal,
        onStage: (stage) => {
          if (seq === this.runSeq && !controller.signal.aborted) this.set({ stage })
        },
        onPhase: (event, candidateIndex) => {
          if (seq !== this.runSeq || controller.signal.aborted) return
          this.set({
            ticks: [
              ...this.state.ticks,
              {
                candidateIndex,
                phase: event.phase,
                strategy: event.strategy,
                nodesAdded: event.nodesAdded,
                partsAdded: event.partsAdded,
                partCount: event.metrics.partCount,
                elapsedMs: event.elapsedMs,
              },
            ],
            elapsedMs: this.now() - this.startedAt,
          })
        },
      })
      if (seq !== this.runSeq) return
      this.stopTicker()
      if (controller.signal.aborted) return
      this.set({
        runPhase: 'ready',
        run,
        selectedCandidateId: run.candidates[0]?.id ?? null,
        elapsedMs: run.elapsedMs,
      })
    } catch (cause) {
      if (seq !== this.runSeq) return
      this.stopTicker()
      if (isAbort(cause) || controller.signal.aborted) {
        this.set({ runPhase: 'cancelled', elapsedMs: this.now() - this.startedAt })
        return
      }
      const issue = issueFor(cause, '/api/generate')
      this.set({
        runPhase: issue.kind === 'unavailable' ? 'unavailable' : 'error',
        runIssue: issue,
        elapsedMs: this.now() - this.startedAt,
      })
    }
  }

  /**
   * Stops a generation.
   *
   * Nothing was written, so there is nothing to roll back: the pipeline builds
   * candidate documents in memory and the only write in this module is `accept`.
   * The state says so explicitly rather than leaving the operator to wonder.
   */
  cancel() {
    if (this.state.runPhase !== 'running') return
    this.stopTicker()
    this.runController?.abort()
    this.set({ runPhase: 'cancelled', elapsedMs: this.now() - this.startedAt })
  }

  private startTicker() {
    this.stopTicker()
    if (!this.tickMs) return
    this.ticker = setInterval(() => {
      if (this.state.runPhase !== 'running') return
      this.set({ elapsedMs: this.now() - this.startedAt })
    }, this.tickMs)
  }

  private stopTicker() {
    if (this.ticker === null) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  // -- review --------------------------------------------------------------

  /**
   * Puts a candidate on screen as a ghost.
   *
   * `preflight` builds the preview document and validates it without moving the
   * revision, so the operator sees the real geometry — and the kernel's own
   * collision verdict on it — before anything is committed. Selecting a
   * different candidate withdraws the previous ghost, because two ghosts stacked
   * over one viewport is nobody's idea of a review.
   */
  selectCandidate(candidateId: string | null): void {
    this.discardGhost()
    if (!candidateId) {
      this.set({ selectedCandidateId: null })
      return
    }
    const candidate = this.candidate(candidateId)
    this.set({ selectedCandidateId: candidateId, outcome: null })
    if (!candidate) return

    const operations = candidateOperations(candidate)
    const result = this.bus.preflight(labelFor(candidate), operations, 'agent')
    if (!result.ok) {
      this.set({
        ghost: null,
        outcome: {
          kind: result.error.code === 'STALE_DOCUMENT' ? 'stale' : 'refused',
          title:
            result.error.code === 'STALE_DOCUMENT'
              ? 'The document moved on'
              : 'The kernel refused this candidate',
          detail: result.error.message,
          repair: result.error.repair,
          code: result.error.code,
        },
      })
      return
    }
    this.set({
      ghost: {
        candidateId,
        proposalId: result.value.id,
        baseRevision: result.value.baseRevision,
        collisions: result.value.validation.collisions.length,
        partCount: Object.keys(result.value.previewDocument.parts).length,
      },
    })
  }

  /** Takes the ghost back. No transaction ever existed. */
  discardGhost(): void {
    const ghost = this.state.ghost
    if (!ghost) return
    this.bus.withdraw(ghost.proposalId)
    this.set({ ghost: null })
  }

  /**
   * Commits the reviewed candidate as one transaction.
   *
   * The actor is `human`: the operator typed the request, edited the brief,
   * resolved its contradictions and looked at the ghost, so recording the agent
   * as author would misattribute the edit and — because the kernel gates agent
   * writes on Build autonomy — refuse an edit a person explicitly made. The
   * independent verification an agent write would have bought is kept: this
   * refuses unless the kernel's own preflight report on the ghost found zero
   * collisions.
   */
  accept(): GenerateOutcome {
    const ghost = this.state.ghost
    const candidate = ghost ? this.candidate(ghost.candidateId) : null
    if (!ghost || !candidate) {
      const outcome: GenerateOutcome = {
        kind: 'refused',
        title: 'Nothing is under review',
        detail: 'Select a candidate to preview it as a ghost before adding it to the model.',
        repair: null,
        code: null,
      }
      this.set({ outcome })
      return outcome
    }
    if (ghost.collisions > 0) {
      const outcome: GenerateOutcome = {
        kind: 'refused',
        title: 'The ghost collides with the model',
        detail: `The kernel found ${ghost.collisions} collision${ghost.collisions === 1 ? '' : 's'} in the preview. It was not committed.`,
        repair: 'Choose another candidate, or move the existing build out of the way and generate again.',
        code: 'COLLISION',
      }
      this.set({ outcome })
      return outcome
    }

    const operations = candidateOperations(candidate)
    // Withdrawn first so a successful commit does not leave a stale ghost
    // pointing at a revision that no longer exists.
    this.bus.withdraw(ghost.proposalId)
    const result = this.bus.dispatch(labelFor(candidate), operations, 'human', ghost.baseRevision, 'generation_apply')
    if (result.ok) {
      const outcome: GenerateOutcome = {
        kind: 'applied',
        title: 'Candidate added',
        detail: `${candidate.metrics.partCount} parts committed as one transaction. Revision ${ghost.baseRevision} → ${result.value.resultRevision}.`,
        repair: null,
        code: null,
      }
      this.set({ outcome, ghost: null, run: null, runPhase: 'idle', selectedCandidateId: null, ticks: [] })
      return outcome
    }
    const outcome: GenerateOutcome =
      result.error.code === 'STALE_DOCUMENT'
        ? {
            kind: 'stale',
            title: 'The document moved on',
            detail: result.error.message,
            repair: result.error.repair,
            code: result.error.code,
          }
        : {
            kind: 'refused',
            title: 'The kernel refused this candidate',
            detail: result.error.message,
            repair: result.error.repair,
            code: result.error.code,
          }
    this.set({ outcome, ghost: null })
    return outcome
  }

  clearOutcome() {
    this.set({ outcome: null })
  }

  private candidate(id: string): Candidate | null {
    return this.state.run?.candidates.find((entry) => entry.id === id) ?? null
  }

  reset() {
    this.discardGhost()
    this.runController?.abort()
    this.briefController?.abort()
    this.stopTicker()
    this.runSeq += 1
    this.state = { ...INITIAL, prompt: this.state.prompt }
    for (const listener of this.listeners) listener()
  }

  dispose() {
    this.discardGhost()
    this.runController?.abort()
    this.briefController?.abort()
    this.stopTicker()
    this.listeners.clear()
  }
}

const labelFor = (candidate: Candidate): string => `Generated: ${candidate.strategy}`

// -- selectors ---------------------------------------------------------------

/** Conflicts the operator has not decided yet. Generation waits on these. */
export const unresolvedConflicts = (state: GenerateState): DesignBrief['conflicts'] =>
  (state.brief?.conflicts ?? []).filter((conflict) => !(conflict.field in state.conflictChoices))

export const selectedCandidate = (state: GenerateState): Candidate | null =>
  state.run?.candidates.find((candidate) => candidate.id === state.selectedCandidateId) ?? null

/** Fraction of the phase grid completed, 0–1. Real work, not a timer. */
export const phaseProgress = (state: GenerateState): number => {
  const total = Math.max(1, state.candidateCount * PHASES.length)
  return Math.min(1, state.ticks.length / total)
}

export const currentTick = (state: GenerateState): PhaseTick | null => state.ticks.at(-1) ?? null

/** True when a settled run produced no candidate that passed the hard gates. */
export const producedNothing = (state: GenerateState): boolean =>
  state.runPhase === 'ready' && (state.run?.candidates.length ?? 0) === 0

// -- the metric vector, for presentation -------------------------------------

/**
 * Every axis `scoreDocument` measures, named and formatted.
 *
 * One list, used by the compact candidate card and by the side-by-side
 * comparison, so the two can never disagree about what a candidate scored.
 * `tone` encodes only the facts that are not a matter of taste — a collision is
 * bad, a valid build order is good — and leaves the rest neutral, because
 * whether rarity is a cost or the point is a question about the brief.
 */
export interface CandidateMetricRow {
  readonly key: string
  readonly label: string
  readonly group: 'size' | 'sourcing' | 'physics' | 'build' | 'brief'
  readonly value: (metrics: MetricVector) => string
  readonly tone?: (metrics: MetricVector) => 'good' | 'bad' | 'neutral'
}

const pct = (value: number) => `${Math.round(value * 100)}%`

export const CANDIDATE_METRICS: readonly CandidateMetricRow[] = [
  { key: 'partCount', label: 'Part count', group: 'size', value: (m) => String(m.partCount) },
  { key: 'distinctElements', label: 'Distinct elements', group: 'size', value: (m) => String(m.distinctElements) },
  {
    key: 'extentStuds',
    label: 'Measured extent',
    group: 'size',
    value: (m) => `${m.extentStuds.map((v) => v.toFixed(1)).join(' × ')} studs`,
  },
  {
    key: 'rarePartCount',
    label: 'Rare elements',
    group: 'sourcing',
    value: (m) => `${m.rarePartCount} under 1,000 sets`,
    tone: (m) => (m.rarePartCount === 0 ? 'good' : 'neutral'),
  },
  {
    key: 'commonness',
    label: 'Commonness',
    group: 'sourcing',
    value: (m) => `${m.commonness.toFixed(2)} mean log₁₀ sets`,
  },
  {
    key: 'paletteConformance',
    label: 'Palette conformance',
    group: 'sourcing',
    value: (m) => pct(m.paletteConformance),
    tone: (m) => (m.paletteConformance >= 1 ? 'good' : 'bad'),
  },
  {
    key: 'virtualColourCount',
    label: 'Never-produced colours',
    group: 'sourcing',
    value: (m) => String(m.virtualColourCount),
    tone: (m) => (m.virtualColourCount === 0 ? 'good' : 'bad'),
  },
  {
    key: 'collisionCount',
    label: 'Collisions',
    group: 'physics',
    value: (m) =>
      m.unverifiedCollisionCount
        ? `${m.collisionCount} (${m.unverifiedCollisionCount} by bounds only)`
        : String(m.collisionCount),
    tone: (m) => (m.collisionCount === 0 ? 'good' : 'bad'),
  },
  {
    key: 'componentCount',
    label: 'Connected components',
    group: 'physics',
    value: (m) => `${m.componentCount} · largest ${pct(m.largestComponentFraction)}`,
    tone: (m) => (m.componentCount === 1 ? 'good' : 'bad'),
  },
  {
    key: 'supportMarginLdu',
    label: 'Tipping margin',
    group: 'physics',
    value: (m) =>
      m.supportMarginLdu === null ? 'nothing rests on the ground' : `${m.supportMarginLdu.toFixed(1)} LDU`,
    tone: (m) => (m.supportMarginLdu === null ? 'neutral' : m.supportMarginLdu > 0 ? 'good' : 'bad'),
  },
  {
    key: 'weakAttachmentCount',
    label: 'Single-connection parts',
    group: 'physics',
    value: (m) => String(m.weakAttachmentCount),
    tone: (m) => (m.weakAttachmentCount === 0 ? 'good' : 'neutral'),
  },
  {
    key: 'unsupportedPartCount',
    label: 'Unsupported parts',
    group: 'physics',
    value: (m) => String(m.unsupportedPartCount),
    tone: (m) => (m.unsupportedPartCount === 0 ? 'good' : 'bad'),
  },
  {
    key: 'overloadedJointCount',
    label: 'Overloaded joints',
    group: 'physics',
    value: (m) => String(m.overloadedJointCount),
    tone: (m) => (m.overloadedJointCount === 0 ? 'good' : 'bad'),
  },
  {
    key: 'massGrams',
    label: 'Mass',
    group: 'physics',
    value: (m) => `${m.massGrams.toFixed(1)} g · ${pct(m.massCoverage)} measured`,
  },
  {
    key: 'buildOrderValid',
    label: 'Build order',
    group: 'build',
    value: (m) =>
      m.buildOrderValid
        ? `valid · ${m.buildStepCount} steps`
        : `${m.buildOrderViolations} step(s) attach to nothing`,
    tone: (m) => (m.buildOrderValid ? 'good' : 'bad'),
  },
  {
    key: 'buildOrderIslands',
    label: 'Build islands',
    group: 'build',
    value: (m) => String(m.buildOrderIslands),
  },
  {
    key: 'withinBudget',
    label: 'Part budget',
    group: 'brief',
    value: (m) =>
      m.withinBudget === null
        ? 'unbounded'
        : `${m.withinBudget ? 'within' : 'over'} · ${m.budgetUsed === null ? '—' : pct(m.budgetUsed)} used`,
    tone: (m) => (m.withinBudget === null ? 'neutral' : m.withinBudget ? 'good' : 'bad'),
  },
  {
    key: 'withinEnvelope',
    label: 'Envelope',
    group: 'brief',
    value: (m) => (m.withinEnvelope === null ? 'unconstrained' : m.withinEnvelope ? 'within' : 'over'),
    tone: (m) => (m.withinEnvelope === null ? 'neutral' : m.withinEnvelope ? 'good' : 'bad'),
  },
  {
    key: 'silhouetteIou',
    label: 'Silhouette match',
    group: 'brief',
    value: (m) => (m.silhouetteIou === null ? 'no reference given' : m.silhouetteIou.toFixed(3)),
  },
]

/** The eight axes the compact card shows, in the order it shows them. */
export const HEADLINE_METRIC_KEYS: readonly string[] = [
  'partCount',
  'distinctElements',
  'rarePartCount',
  'collisionCount',
  'componentCount',
  'supportMarginLdu',
  'buildOrderValid',
  'withinBudget',
]
