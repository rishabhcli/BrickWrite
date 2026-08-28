import { commandBus } from '../cad/engine'
import type { ModelDocument } from '../cad/types'
import { MAX_WEIGHT, OBJECTIVES } from './objectives'
import { applyRefinement, type RefinementBus } from './pipeline'
import type { SearchReport } from './search'
import { refinementWorkerAvailable, runRefinementJob, type RefinementJobResult } from './worker'
import {
  isApplicable,
  OBJECTIVE_IDS,
  type ObjectiveId,
  type OverlayInstruction,
  type RefinementProposalV1,
  type RefinementRequestInput,
} from './types'

/**
 * The state behind the Refine panel.
 *
 * Everything the panel shows lives here rather than in component state, for two
 * reasons that are not stylistic. The changed-part heatmap is a *different*
 * workbench slot — `overlay`, drawn over the viewport — so panel and overlay have
 * to read one selection or the highlight belongs to a proposal the operator is no
 * longer looking at. And a search runs for seconds across a worker boundary, so
 * its lifecycle outlives any dock section that can be collapsed mid-run.
 *
 * The search runner and the command bus are both injected. That is what makes
 * cancel, budget exhaustion, a stale revision and a transport failure testable
 * as the designed states they are, instead of as things that only happen on a
 * slow machine.
 */

export type RefineStatus = 'idle' | 'running' | 'ready' | 'cancelled' | 'error'

/** Search effort, as a wall clock the operator can see spent. */
export const REFINE_EFFORTS = [
  { id: 'quick', label: 'Quick', maxIterations: 120, wallClockMs: 1_200 },
  { id: 'standard', label: 'Standard', maxIterations: 400, wallClockMs: 2_500 },
  { id: 'thorough', label: 'Thorough', maxIterations: 1_200, wallClockMs: 8_000 },
] as const

export type RefineEffortId = (typeof REFINE_EFFORTS)[number]['id']

export const effortById = (id: RefineEffortId) =>
  REFINE_EFFORTS.find((entry) => entry.id === id) ?? REFINE_EFFORTS[1]

/**
 * What happened when the operator acted on a proposal.
 *
 * `stale` is deliberately its own kind rather than a flavour of `refused`: the
 * kernel's `STALE_DOCUMENT` is the one failure with an obvious recovery — search
 * again against the revision that arrived — and flattening it into a generic
 * error would hide the only button worth offering.
 */
export interface RefineOutcome {
  readonly kind: 'applied' | 'stale' | 'refused' | 'dismissed'
  readonly title: string
  readonly detail: string
  readonly repair: string | null
  readonly code: string | null
  readonly currentRevision: number | null
}

export interface RefineState {
  readonly status: RefineStatus
  readonly instruction: string
  readonly effort: RefineEffortId
  /** Only objectives the operator actually moved. Unset ones follow the goal. */
  readonly weightOverrides: Readonly<Partial<Record<ObjectiveId, number>>>
  readonly scopePartIds: readonly string[]
  readonly baseRevision: number | null
  readonly proposals: readonly RefinementProposalV1[]
  readonly dismissedIds: ReadonlySet<string>
  readonly selectedId: string | null
  readonly report: SearchReport | null
  readonly ranOn: 'worker' | 'inline' | null
  readonly rankingRationale: string | null
  readonly elapsedMs: number
  readonly budgetMs: number
  readonly error: string | null
  readonly outcome: RefineOutcome | null
}

export type RefinementRunner = (
  request: RefinementRequestInput,
  document: ModelDocument,
  options: { signal: AbortSignal },
) => Promise<RefinementJobResult>

export interface RefinementSessionOptions {
  readonly runner?: RefinementRunner
  readonly bus?: RefinementBus
  /**
   * How often the elapsed readout advances while a search is in flight.
   * Zero disables the ticker, which is what a component test wants: an interval
   * firing outside React's act() is a flake, not a feature.
   */
  readonly tickMs?: number
  readonly now?: () => number
}

const INITIAL: RefineState = {
  status: 'idle',
  instruction: '',
  effort: 'standard',
  weightOverrides: {},
  scopePartIds: [],
  baseRevision: null,
  proposals: [],
  dismissedIds: new Set(),
  selectedId: null,
  report: null,
  ranOn: null,
  rankingRationale: null,
  elapsedMs: 0,
  budgetMs: effortById('standard').wallClockMs,
  error: null,
  outcome: null,
}

/**
 * The default runner.
 *
 * `catalogBaseUrl` is the page origin rather than the empty string the loader
 * itself defaults to, because a spawned worker starts with no catalog and the
 * job protocol reads an empty URL as "the catalog is already here" — which in a
 * fresh worker it never is.
 */
const defaultRunner: RefinementRunner = (request, document, options) =>
  runRefinementJob(request, document, {
    signal: options.signal,
    catalogBaseUrl: typeof window === 'undefined' ? null : window.location.origin,
  })

const isAbort = (cause: unknown): boolean =>
  cause instanceof DOMException ? cause.name === 'AbortError' : cause instanceof Error && cause.name === 'AbortError'

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Unknown failure.'

export class RefinementSession {
  private state: RefineState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly runner: RefinementRunner
  private readonly bus: RefinementBus
  private readonly tickMs: number
  private readonly now: () => number
  private controller: AbortController | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private runSeq = 0
  private requestSeq = 0

  constructor(options: RefinementSessionOptions = {}) {
    this.runner = options.runner ?? defaultRunner
    this.bus = options.bus ?? commandBus
    this.tickMs = options.tickMs ?? 200
    this.now = options.now ?? (() => Date.now())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): RefineState => this.state

  private set(patch: Partial<RefineState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  // -- request shape -------------------------------------------------------

  setInstruction(instruction: string) {
    this.set({ instruction })
  }

  setEffort(effort: RefineEffortId) {
    this.set({ effort, budgetMs: effortById(effort).wallClockMs })
  }

  /** Records an explicit weight. Clamped to the range the engine itself clamps to. */
  setWeight(id: ObjectiveId, weight: number) {
    const clamped = Math.max(0, Math.min(MAX_WEIGHT, Number.isFinite(weight) ? weight : OBJECTIVES[id].defaultWeight))
    this.set({ weightOverrides: { ...this.state.weightOverrides, [id]: clamped } })
  }

  /** Drops every override, so the goal derived from the instruction decides again. */
  resetWeights() {
    this.set({ weightOverrides: {} })
  }

  weightOf(id: ObjectiveId): number {
    const override = this.state.weightOverrides[id]
    return typeof override === 'number' ? override : OBJECTIVES[id].defaultWeight
  }

  // -- the search ----------------------------------------------------------

  /** True when this environment will genuinely run the search off the main thread. */
  get offMainThread(): boolean {
    return refinementWorkerAvailable()
  }

  async run(document: ModelDocument, scopePartIds: readonly string[]): Promise<void> {
    const scope = [...new Set(scopePartIds)].filter((id) => Boolean(document.parts[id]))
    if (!scope.length) {
      this.set({
        status: 'error',
        error: 'Nothing is selected, so there is no region to refine.',
        proposals: [],
        selectedId: null,
      })
      return
    }

    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const seq = ++this.runSeq
    const effort = effortById(this.state.effort)
    this.requestSeq += 1

    const request: RefinementRequestInput = {
      version: 1,
      id: `refine_${this.requestSeq}_r${document.revision}`,
      scopePartIds: scope,
      baseRevision: document.revision,
      instruction: this.state.instruction.trim(),
      objectiveWeights: { ...this.state.weightOverrides },
      budget: { maxIterations: effort.maxIterations, wallClockMs: effort.wallClockMs },
      maxProposals: 6,
    }

    this.startedAt = this.now()
    this.set({
      status: 'running',
      scopePartIds: scope,
      baseRevision: document.revision,
      proposals: [],
      dismissedIds: new Set(),
      selectedId: null,
      report: null,
      ranOn: null,
      rankingRationale: null,
      elapsedMs: 0,
      budgetMs: effort.wallClockMs,
      error: null,
      outcome: null,
    })
    this.startTicker()

    try {
      const result = await this.runner(request, document, { signal: controller.signal })
      if (seq !== this.runSeq) return
      this.stopTicker()
      if (controller.signal.aborted) {
        // The inline fallback resolves even after an abort because the search is
        // synchronous. Whatever came back belongs to a run the operator stopped,
        // so it is reported as partial rather than presented as an answer.
        this.set({
          status: 'cancelled',
          proposals: result.proposals,
          report: result.report,
          ranOn: result.ranOn,
          selectedId: null,
          elapsedMs: this.now() - this.startedAt,
        })
        return
      }
      const ranked = result.proposals.filter((proposal) => proposal.status === 'ranked')
      this.set({
        status: 'ready',
        proposals: result.proposals,
        report: result.report,
        ranOn: result.ranOn,
        rankingRationale: result.rankingRationale,
        selectedId: ranked[0]?.id ?? null,
        elapsedMs: result.report.elapsedMs,
      })
    } catch (cause) {
      if (seq !== this.runSeq) return
      this.stopTicker()
      if (isAbort(cause) || controller.signal.aborted) {
        this.set({ status: 'cancelled', elapsedMs: this.now() - this.startedAt })
        return
      }
      this.set({ status: 'error', error: describe(cause), elapsedMs: this.now() - this.startedAt })
    }
  }

  /**
   * Stops the search.
   *
   * The state moves to `cancelled` immediately rather than waiting for the
   * runner to acknowledge, because on the worker path the acknowledgement is the
   * worker being terminated and on the inline path there is no acknowledgement
   * at all. Late results are discarded by the abort check in `run`.
   */
  cancel() {
    if (this.state.status !== 'running') return
    this.stopTicker()
    this.controller?.abort()
    this.set({ status: 'cancelled', elapsedMs: this.now() - this.startedAt })
  }

  private startTicker() {
    this.stopTicker()
    if (!this.tickMs) return
    this.ticker = setInterval(() => {
      if (this.state.status !== 'running') return
      this.set({ elapsedMs: this.now() - this.startedAt })
    }, this.tickMs)
  }

  private stopTicker() {
    if (this.ticker === null) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  // -- review --------------------------------------------------------------

  select(proposalId: string | null) {
    this.set({ selectedId: proposalId })
  }

  /**
   * Rejects a proposal.
   *
   * Nothing is dispatched, nothing is preflighted and no transaction exists:
   * rejecting is the operator declining a suggestion, and a decline that wrote
   * to the document would make "no" cost a revision.
   */
  reject(proposalId: string) {
    const proposal = this.state.proposals.find((entry) => entry.id === proposalId)
    if (!proposal) return
    const dismissed = new Set(this.state.dismissedIds)
    dismissed.add(proposalId)
    const remaining = this.state.proposals.filter(
      (entry) => entry.status === 'ranked' && !dismissed.has(entry.id),
    )
    this.set({
      dismissedIds: dismissed,
      selectedId: this.state.selectedId === proposalId ? (remaining[0]?.id ?? null) : this.state.selectedId,
      outcome: {
        kind: 'dismissed',
        title: 'Proposal rejected',
        detail: `“${proposal.label}” was discarded. No transaction was created and the document is unchanged at revision ${proposal.baseRevision}.`,
        repair: null,
        code: null,
        currentRevision: null,
      },
    })
  }

  /**
   * Commits a proposal through the command bus at its own base revision.
   *
   * The revision check is the kernel's, not this module's. A proposal found
   * against revision 7 and accepted after somebody else committed revision 8 is
   * refused with `STALE_DOCUMENT`, which is surfaced with the one recovery that
   * makes sense rather than as a generic failure.
   */
  accept(proposalId: string): RefineOutcome {
    const proposal = this.state.proposals.find((entry) => entry.id === proposalId)
    if (!proposal) {
      const outcome: RefineOutcome = {
        kind: 'refused',
        title: 'Proposal not found',
        detail: `Proposal ${proposalId} is no longer in this result set.`,
        repair: 'Search again for proposals against the current revision.',
        code: 'NOT_FOUND',
        currentRevision: null,
      }
      this.set({ outcome })
      return outcome
    }

    const result = applyRefinement(proposal, 'human', this.bus)
    if (result.ok) {
      const outcome: RefineOutcome = {
        kind: 'applied',
        title: 'Refinement applied',
        detail: `“${proposal.label}” committed as one transaction. Revision ${proposal.baseRevision} → ${result.value.resultRevision}.`,
        repair: null,
        code: null,
        currentRevision: result.value.resultRevision,
      }
      this.set({
        outcome,
        status: 'idle',
        proposals: [],
        selectedId: null,
        report: null,
        ranOn: null,
      })
      return outcome
    }

    const details = result.error.details as { currentRevision?: number } | undefined
    const outcome: RefineOutcome =
      result.error.code === 'STALE_DOCUMENT'
        ? {
            kind: 'stale',
            title: 'The document moved on',
            detail: result.error.message,
            repair: result.error.repair,
            code: result.error.code,
            currentRevision: typeof details?.currentRevision === 'number' ? details.currentRevision : null,
          }
        : {
            kind: 'refused',
            title: 'The kernel refused this proposal',
            detail: result.error.message,
            repair: result.error.repair,
            code: result.error.code,
            currentRevision: null,
          }
    this.set({ outcome })
    return outcome
  }

  clearOutcome() {
    this.set({ outcome: null })
  }

  /** Drops every result without touching the document. */
  reset() {
    this.controller?.abort()
    this.stopTicker()
    this.runSeq += 1
    this.set({
      status: 'idle',
      proposals: [],
      dismissedIds: new Set(),
      selectedId: null,
      report: null,
      ranOn: null,
      rankingRationale: null,
      elapsedMs: 0,
      error: null,
      outcome: null,
    })
  }

  dispose() {
    this.controller?.abort()
    this.stopTicker()
    this.listeners.clear()
  }
}

// -- selectors ---------------------------------------------------------------

export const rankedProposals = (state: RefineState): readonly RefinementProposalV1[] =>
  state.proposals.filter((proposal) => proposal.status === 'ranked' && !state.dismissedIds.has(proposal.id))

export const refusedProposals = (state: RefineState): readonly RefinementProposalV1[] =>
  state.proposals.filter((proposal) => proposal.status === 'rejected')

export const selectedProposal = (state: RefineState): RefinementProposalV1 | null =>
  state.proposals.find((proposal) => proposal.id === state.selectedId) ?? null

export const overlayInstructions = (state: RefineState): readonly OverlayInstruction[] =>
  selectedProposal(state)?.overlay ?? []

/** True when a settled run genuinely found nothing to offer. */
export const foundNothing = (state: RefineState): boolean =>
  state.status === 'ready' && rankedProposals(state).length === 0

export const canApply = (proposal: RefinementProposalV1): boolean => isApplicable(proposal)

/** Every objective, split by what the proposal did to it. Complete by construction. */
export interface MetricRow {
  readonly id: ObjectiveId
  readonly label: string
  readonly unit: string
  readonly before: number
  readonly after: number
  readonly delta: number
  readonly direction: 'improved' | 'regressed' | 'unchanged'
}

export function metricRows(proposal: RefinementProposalV1): MetricRow[] {
  return OBJECTIVE_IDS.map((id) => {
    const definition = OBJECTIVES[id]
    const before = proposal.metrics.before[id]
    const after = proposal.metrics.after[id]
    const delta = proposal.metrics.delta[id]
    const better = definition.direction === 'higher-is-better' ? delta > 1e-9 : delta < -1e-9
    const worse = definition.direction === 'higher-is-better' ? delta < -1e-9 : delta > 1e-9
    return {
      id,
      label: definition.label,
      unit: definition.unit,
      before,
      after,
      delta,
      direction: better ? 'improved' : worse ? 'regressed' : 'unchanged',
    }
  })
}
