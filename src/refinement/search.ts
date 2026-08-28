import type { GeometryProvider } from '../cad/collision'
import { applyMutations, mutationsForOperations } from '../cad/patch'
import { deriveConnectionEdges } from '../cad/snapping'
import type { CadOperation, ModelDocument } from '../cad/types'
import { hash32, mulberry32, stableStringify } from '../platform/contracts'
import { createScope } from './analyse'
import { ScopeViolationError, addedPartIds, guardCandidate, modifiedPartIds, removedPartIds } from './guards'
import { measureAll, regressionsOf, resolveWeights, scoreOf } from './objectives'
import { silhouetteOf } from './cache'
import { silhouetteFrame } from './silhouette'
import { getDocumentBounds } from '../cad/geometry'
import { STRATEGIES, strategiesFor, strategyById, type StrategyEntry } from './strategies'
import type {
  MetricVector,
  ObjectiveId,
  RefinementRequestV1,
  RejectionCode,
  SilhouetteV1,
} from './types'

/**
 * Bounded, seeded, interruptible local search over the alternative generators.
 *
 * Three properties are non-negotiable and everything about the structure follows
 * from them.
 *
 * **It stops.** A refinement runs while somebody is looking at the model. The
 * budget is checked before every evaluation and between every generator, and
 * when it runs out the search returns the best it has found rather than the best
 * it might have found — the report says which of the two happened.
 *
 * **It repeats.** The same document, request and seed produce the same ranked
 * list, byte for byte. Generators are pure, their order is the registry's,
 * ties break on content hashes, and every part a generator invents has a
 * content-derived id. There is no `Math.random` and no `crypto.randomUUID`
 * anywhere below this line.
 *
 * **It composes.** Most real requests need two moves — re-lay the course *and*
 * tile it, close the step *and* tie it back in — so a second pass runs the other
 * generators against the leading candidates. Depth stops at two because a third
 * pass multiplies the branch factor for changes an operator can no longer read
 * as one edit.
 */

/** Attribution used while previewing; a real commit stamps its own id. */
const PREVIEW_TRANSACTION = 'refinement_preview'

/** How many leading candidates get a second generator run against them. */
const COMPOSE_WIDTH = 3

export interface SearchBudget {
  readonly maxIterations: number
  readonly wallClockMs: number
}

export interface SearchOptions {
  readonly budget?: SearchBudget
  readonly signal?: AbortSignal
  readonly strategyIds?: readonly string[]
  readonly weightOverrides?: Partial<Record<ObjectiveId, number>>
  readonly provideGeometry?: GeometryProvider
  /** Injected so a test can drive the wall clock instead of waiting on it. */
  readonly now?: () => number
}

export interface SearchCandidate {
  readonly id: string
  readonly strategy: string
  readonly label: string
  readonly operations: CadOperation[]
  readonly document: ModelDocument
  readonly metrics: MetricVector
  readonly score: number
  readonly regressions: ObjectiveId[]
  readonly warnings: string[]
  readonly addedPartIds: string[]
  readonly removedPartIds: string[]
  readonly modifiedPartIds: string[]
}

export interface SearchRejection {
  readonly strategy: string
  readonly code: RejectionCode
  readonly reason: string
  readonly partIds: readonly string[]
  readonly operations: CadOperation[]
}

export interface SearchReport {
  readonly evaluated: number
  readonly generated: number
  readonly elapsedMs: number
  readonly aborted: boolean
  readonly budgetExhausted: boolean
  readonly strategiesRun: readonly string[]
  readonly strategiesSkipped: readonly string[]
  readonly baseMetrics: MetricVector
  readonly weights: Record<ObjectiveId, number>
  readonly reference: SilhouetteV1
}

export interface SearchResult {
  readonly candidates: SearchCandidate[]
  readonly rejected: SearchRejection[]
  readonly report: SearchReport
}

/** Stable id for a plan: the same operations always name the same candidate. */
export function candidateId(requestId: string, strategy: string, operations: readonly CadOperation[]): string {
  const payload = stableStringify({ requestId, strategy, operations })
  return `rp_${hash32(payload).toString(36)}${hash32([...payload].reverse().join('')).toString(36)}`
}

/**
 * The document a batch of operations produces, with its connection graph rebuilt.
 *
 * Rebuilding the edges is not optional bookkeeping: `verifyBuildOrder` and the
 * boundary check both read the document's recorded graph, so a candidate whose
 * edges still describe the pre-edit model would be checked against a model that
 * no longer exists.
 */
export function buildCandidateDocument(base: ModelDocument, operations: readonly CadOperation[]): ModelDocument {
  const mutations = mutationsForOperations(base, operations, 'agent', PREVIEW_TRANSACTION)
  const next = applyMutations(base, mutations)
  next.revision = base.revision + 1
  next.connections = deriveConnectionEdges(next, next.revision, 'snap')
  return next
}

/** The reference outline a request is scored against: its own, unless one was supplied. */
export function referenceFor(document: ModelDocument, request: RefinementRequestV1): SilhouetteV1 {
  return request.referenceSilhouette ?? silhouetteOf(document, silhouetteFrame(getDocumentBounds(document)))
}

class Budget {
  private readonly started: number
  private used = 0
  exhausted = false

  constructor(
    private readonly limits: SearchBudget,
    private readonly clock: () => number,
    private readonly signal?: AbortSignal,
  ) {
    this.started = clock()
  }

  get elapsedMs(): number {
    return this.clock() - this.started
  }

  get aborted(): boolean {
    return Boolean(this.signal?.aborted)
  }

  /** True while there is room for one more evaluation. */
  take(): boolean {
    if (this.aborted) return false
    if (this.used >= this.limits.maxIterations || this.elapsedMs >= this.limits.wallClockMs) {
      this.exhausted = true
      return false
    }
    this.used += 1
    return true
  }

  /** Budget check that does not consume one, for the gaps between generators. */
  peek(): boolean {
    if (this.aborted) return false
    if (this.used >= this.limits.maxIterations || this.elapsedMs >= this.limits.wallClockMs) {
      this.exhausted = true
      return false
    }
    return true
  }

  get spent(): number {
    return this.used
  }
}

export function searchRefinements(
  request: RefinementRequestV1,
  document: ModelDocument,
  options: SearchOptions = {},
): SearchResult {
  const clock = options.now ?? Date.now
  const budget = new Budget(options.budget ?? request.budget, clock, options.signal)
  const weights = resolveWeights({ ...request.objectiveWeights, ...options.weightOverrides })
  const reference = referenceFor(document, request)

  const scope = createScope({
    partIds: request.scopePartIds,
    protectedPartIds: request.protectedPartIds,
    boundaryPartIds: request.boundaryPartIds,
    symmetryExceptionPartIds: request.symmetryExceptionPartIds,
    reference,
    instruction: request.instruction,
  })

  const baseMetrics = measureAll(document, scope)
  const guardOptions = {
    reference,
    silhouetteToleranceFraction: request.silhouetteToleranceFraction,
    provideGeometry: options.provideGeometry,
  }

  const selected: StrategyEntry[] = options.strategyIds?.length
    ? options.strategyIds
        .map((id) => strategyById(id))
        .filter((entry): entry is StrategyEntry => Boolean(entry))
    : strategiesFor(request.objectiveWeights)
  const requested = new Set(selected.map((entry) => entry.id))

  const candidates = new Map<string, SearchCandidate>()
  const rejected: SearchRejection[] = []
  const strategiesRun: string[] = []
  let generated = 0

  const evaluate = (entry: { id: string; label: string }, operations: CadOperation[]): SearchCandidate | null => {
    const id = candidateId(request.id, entry.id, operations)
    if (candidates.has(id)) return null
    if (!budget.take()) return null

    let after: ModelDocument
    try {
      after = buildCandidateDocument(document, operations)
    } catch (cause) {
      rejected.push({
        strategy: entry.id,
        code: 'EMPTY',
        reason: cause instanceof Error ? cause.message : String(cause),
        partIds: [],
        operations,
      })
      return null
    }

    let verdict
    try {
      verdict = guardCandidate(document, after, scope, guardOptions)
    } catch (cause) {
      // A scope violation is a generator bug, not a design trade-off. It is
      // recorded rather than thrown onward so one broken generator cannot take
      // the whole refinement down with it.
      if (cause instanceof ScopeViolationError) {
        rejected.push({ strategy: entry.id, code: 'EMPTY', reason: cause.message, partIds: cause.partIds, operations })
        return null
      }
      throw cause
    }

    if (!verdict.ok) {
      rejected.push({
        strategy: entry.id,
        code: verdict.code ?? 'EMPTY',
        reason: verdict.reason,
        partIds: verdict.partIds,
        operations,
      })
      return null
    }

    const created = addedPartIds(document, after)
    // The candidate is measured against the scope *plus what it created*, so a
    // strategy that adds a bridging plate is charged for the part it added and
    // credited with the connection it made. Measuring against the original id
    // list would price additions at zero.
    const metrics = measureAll(
      after,
      created.length
        ? createScope({
            partIds: [...scope.partIds, ...created],
            protectedPartIds: scope.protectedPartIds,
            boundaryPartIds: scope.boundaryPartIds,
            symmetryExceptionPartIds: scope.symmetryExceptionPartIds,
            reference,
            instruction: scope.instruction,
          })
        : scope,
    )
    const candidate: SearchCandidate = {
      id,
      strategy: entry.id,
      label: entry.label,
      operations,
      document: after,
      metrics,
      score: scoreOf(baseMetrics, metrics, weights),
      regressions: regressionsOf(baseMetrics, metrics),
      warnings: [...verdict.warnings],
      addedPartIds: created,
      removedPartIds: removedPartIds(document, after),
      modifiedPartIds: modifiedPartIds(document, after),
    }
    candidates.set(id, candidate)
    return candidate
  }

  // -- Pass one: each generator against the original document ---------------
  for (const entry of selected) {
    if (!budget.peek()) break
    strategiesRun.push(entry.id)
    const rng = mulberry32(hash32(`${request.seed}|${entry.id}|${document.id}|${document.revision}`))
    let batches: CadOperation[][] = []
    try {
      batches = entry.run(document, scope, rng)
    } catch (cause) {
      rejected.push({
        strategy: entry.id,
        code: 'EMPTY',
        reason: `Generator failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        partIds: [],
        operations: [],
      })
      continue
    }
    generated += batches.length
    for (const batch of batches) {
      if (!budget.peek()) break
      evaluate(entry, batch)
    }
  }

  // -- Pass two: the other generators against the leading candidates ---------
  const leaders = [...candidates.values()]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, COMPOSE_WIDTH)

  for (const leader of leaders) {
    if (!budget.peek()) break
    // The scope grows by exactly what the leader created, so a second pass can
    // finish the surface it just laid — and scope isolation against the original
    // document is untouched, because those parts did not exist in it.
    const composedScope = createScope({
      partIds: [...scope.partIds, ...leader.addedPartIds],
      protectedPartIds: scope.protectedPartIds,
      boundaryPartIds: scope.boundaryPartIds,
      symmetryExceptionPartIds: scope.symmetryExceptionPartIds,
      reference,
      instruction: scope.instruction,
    })

    for (const entry of STRATEGIES) {
      if (!budget.peek()) break
      if (entry.id === leader.strategy) continue
      if (!requested.has(entry.id)) continue
      const rng = mulberry32(hash32(`${request.seed}|${leader.id}|${entry.id}`))
      let batches: CadOperation[][] = []
      try {
        batches = entry.run(leader.document, composedScope, rng)
      } catch {
        continue
      }
      generated += batches.length
      for (const batch of batches.slice(0, 3)) {
        if (!budget.peek()) break
        evaluate(
          { id: `${leader.strategy}+${entry.id}`, label: `${leader.label} · ${entry.label}` },
          [...leader.operations, ...batch],
        )
      }
    }
  }

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  return {
    candidates: ranked,
    rejected,
    report: {
      evaluated: budget.spent,
      generated,
      elapsedMs: budget.elapsedMs,
      aborted: budget.aborted,
      budgetExhausted: budget.exhausted,
      strategiesRun,
      strategiesSkipped: STRATEGIES.map((entry) => entry.id).filter((id) => !strategiesRun.includes(id)),
      baseMetrics,
      weights,
      reference,
    },
  }
}
