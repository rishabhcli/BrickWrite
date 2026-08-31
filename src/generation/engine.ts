import {
  hash32,
  stableStringify,
  type DesignBrief,
  type ModelProvider,
  type Provenance,
} from '../platform/contracts'
import { computeBuildOrder } from '../cad/instructions'
import type { CadOperation, CommandResult, ModelDocument, Transaction } from '../cad/types'
import type { GeometryProvider } from '../cad/collision'
import { evaluateHardGates, compareBuildQuality, metricDistance, type MetricVector } from './score'
import {
  runPipeline,
  strategyOrderFor,
  STRATEGIES,
  type Candidate,
  type InferenceUsage,
  type PhaseEvent,
  type PipelineOptions,
} from './phases'
import type { SilhouetteReference } from './silhouette'
import type { RealizeConstraints } from './realize'

/**
 * The generation engine: several materially different candidates, or an honest
 * account of why there are fewer.
 *
 * Two things decide whether this is useful. The first is that the candidates
 * genuinely differ — three runs of the same idea with the seams in different
 * places is not a choice, it is the illusion of one — so candidates come from
 * different *structural strategies* as well as different seeds, and the
 * difference is verified by structural hash rather than asserted.
 *
 * The second is reproducibility. Everything a run depends on is captured in
 * `{ promptHash, model, version, settings, seed }`: the brief is hashed, the
 * settings are hashed, the strategy is named and the seed drives every random
 * choice through `mulberry32`. Handed those five values, `generate` produces the
 * same operations byte for byte.
 */

export const GENERATION_VERSION = 'generation/1'

export interface GenerationSettings {
  readonly candidates: number
  readonly repairBudget: number
  readonly strategies: readonly string[]
  /** Overrides applied on top of the brief's own constraints. */
  readonly constraints: RealizeConstraints | null
}

export interface GenerateOptions {
  readonly base: ModelDocument
  /** Root seed. Each candidate derives its own from this and its strategy. */
  readonly seed?: number
  readonly count?: number
  readonly signal?: AbortSignal
  readonly onPhase?: (event: PhaseEvent, candidateIndex: number) => void
  readonly onCandidate?: (candidate: Candidate, index: number) => void
  readonly references?: readonly SilhouetteReference[]
  readonly provideGeometry?: GeometryProvider
  readonly repairBudget?: number
  readonly strategies?: readonly string[]
  readonly constraints?: RealizeConstraints
}

export interface RejectedCandidate {
  readonly candidate: Candidate
  readonly failures: string[]
}

/** A candidate attempt that failed before the kernel could score a document. */
export interface CandidateFailure {
  readonly candidateIndex: number
  readonly strategy: string
  readonly seed: number
  readonly reason: string
}

export interface GenerationRun {
  readonly promptHash: string
  readonly provenance: Provenance
  readonly settings: GenerationSettings
  /** Candidates that passed every hard gate, best-supported first. */
  readonly candidates: Candidate[]
  /** Candidates the gates refused, with the reasons. Never silently dropped. */
  readonly rejected: RejectedCandidate[]
  /** Provider or pipeline failures isolated to one candidate attempt. */
  readonly failed: CandidateFailure[]
  /** Successful model requests and token totals across all completed candidates. */
  readonly inference: InferenceUsage
  /** Distinct structural hashes across every candidate produced. */
  readonly distinctHashes: number
  readonly elapsedMs: number
  readonly notes: string[]
}

/** The five values a run is reproducible from. */
export interface RunDescriptor {
  readonly promptHash: string
  readonly provider: string
  readonly model: string | null
  readonly version: string
  readonly settings: GenerationSettings
  readonly seed: number
}

export class GenerationEngine {
  private readonly provider: ModelProvider | null
  readonly version: string

  constructor(options: { provider?: ModelProvider; version?: string } = {}) {
    this.provider = options.provider ?? null
    this.version = options.version ?? GENERATION_VERSION
  }

  /** Whether a model will be consulted, or the deterministic path will run. */
  get usesModel(): boolean {
    return this.provider !== null
  }

  private settingsFor(brief: DesignBrief, options: GenerateOptions): GenerationSettings {
    const count = Math.max(1, Math.min(options.count ?? 3, STRATEGIES.length * 4))
    // Ordered by what the subject is, not by declaration order. Candidate 0 is
    // the massing the archetype asked for; the rest are alternatives worth
    // looking at rather than three restatements of a building.
    const order = strategyOrderFor(brief)
    const strategies = options.strategies?.length
      ? [...options.strategies]
      : Array.from({ length: count }, (_, index) => order[index % order.length]!)
    return {
      candidates: count,
      repairBudget: options.repairBudget ?? 24,
      strategies,
      constraints: options.constraints ?? null,
    }
  }

  /**
   * Everything needed to reproduce a run, without running it.
   *
   * Exposed so a cache key, a share link or an audit record can be formed from
   * the same values the run itself is derived from, rather than from a
   * separately-maintained guess at what mattered.
   */
  describeRun(brief: DesignBrief, options: GenerateOptions): RunDescriptor {
    const settings = this.settingsFor(brief, options)
    return {
      promptHash: promptHashFor(brief, settings, this.version),
      provider: this.provider?.id ?? 'deterministic',
      model: this.provider?.model ?? null,
      version: this.version,
      settings,
      seed: options.seed ?? 0,
    }
  }

  /**
   * Produces candidates.
   *
   * A candidate that fails a hard gate is kept and reported rather than
   * discarded, because "we generated three and are showing you none" and "we
   * generated nothing" are different situations and the operator needs to be
   * able to tell them apart.
   */
  async generate(brief: DesignBrief, options: GenerateOptions): Promise<GenerationRun> {
    const startedAt = Date.now()
    const settings = this.settingsFor(brief, options)
    const rootSeed = options.seed ?? 0
    const promptHash = promptHashFor(brief, settings, this.version)

    const accepted: Candidate[] = []
    const rejected: RejectedCandidate[] = []
    const failed: CandidateFailure[] = []
    const hashes = new Set<string>()
    const notes: string[] = []

    const jobs = Array.from({ length: settings.candidates }, (_, index) => {
      const strategy = settings.strategies[index % settings.strategies.length]
      const seed = hash32(`${promptHash}|${strategy}|${rootSeed}|${index}`) >>> 0
      const pipelineOptions: PipelineOptions = {
        seed,
        strategy,
        base: options.base,
        repairBudget: settings.repairBudget,
        idPrefix: `g${promptHash}${index}`,
        ...(this.provider ? { provider: this.provider } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.references?.length ? { references: options.references } : {}),
        ...(options.provideGeometry ? { provideGeometry: options.provideGeometry } : {}),
        ...(settings.constraints ? { constraints: settings.constraints } : {}),
        ...(options.onPhase ? { onPhase: (event: PhaseEvent) => options.onPhase!(event, index) } : {}),
      }
      return { index, run: () => runPipeline(brief, pipelineOptions) }
    })

    const produced: Array<{ index: number; candidate: Candidate }> = []
    const concurrency = Math.min(3, jobs.length)
    let cursor = 0
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const current = cursor
          cursor += 1
          if (current >= jobs.length) return
          const job = jobs[current]!
          try {
            const candidate = await job.run()
            produced.push({ index: job.index, candidate })
          } catch (cause) {
            if (shouldAbortRun(cause, options.signal)) throw cause
            failed.push({
              candidateIndex: job.index,
              strategy: settings.strategies[job.index % settings.strategies.length]!,
              seed: hash32(
                `${promptHash}|${settings.strategies[job.index % settings.strategies.length]}|${rootSeed}|${job.index}`,
              ) >>> 0,
              reason: describeFailure(cause),
            })
          }
        }
      }),
    )
    produced.sort((a, b) => a.index - b.index)
    failed.sort((a, b) => a.candidateIndex - b.candidateIndex)

    for (const item of produced) {
      hashes.add(item.candidate.structuralHash)
      options.onCandidate?.(item.candidate, item.index)

      const gates = evaluateHardGates(item.candidate.metrics, brief)
      if (gates.passed) accepted.push(item.candidate)
      else rejected.push({ candidate: item.candidate, failures: gates.failures })
    }

    if (hashes.size < produced.length) {
      notes.push(
        `${produced.length} completed candidate(s) produced ${hashes.size} distinct structure(s); two strategies converged on the same graph for this brief.`,
      )
    }
    if (failed.length) {
      notes.push(
        `${failed.length} of ${settings.candidates} candidate attempt(s) failed before scoring; successful candidates remain reviewable and each failure is reported separately.`,
      )
    }
    if (!accepted.length && rejected.length) {
      notes.push('No candidate passed the hard gates; the rejected list carries the reasons for each.')
    }

    return {
      promptHash,
      provenance: {
        provider: this.provider?.id ?? 'deterministic',
        model: this.provider?.model ?? null,
        promptHash,
        seed: rootSeed,
        createdAt: new Date().toISOString(),
      },
      settings,
      // Most support margin first, then fewest parts. Both are reported in the
      // vector; this ordering is a default presentation, not a verdict, and a
      // caller that cares about something else re-sorts on the axis it cares
      // about.
      candidates: accepted.sort(
        (a, b) => compareBuildQuality(a.metrics, b.metrics) || a.structuralHash.localeCompare(b.structuralHash),
      ),
      rejected,
      failed,
      inference: sumInference(produced.map((item) => item.candidate.inference)),
      distinctHashes: hashes.size,
      elapsedMs: Date.now() - startedAt,
      notes,
    }
  }
}

const shouldAbortRun = (cause: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true
  const name = cause instanceof Error ? cause.name : ''
  return (
    name === 'AbortError' ||
    name === 'GenerationCancelled' ||
    name === 'GenerationAbortedError' ||
    // Missing/rejected credentials are a run-level configuration state. The
    // session must surface its explicit deterministic alternative instead of
    // reporting the same failure once per candidate.
    name === 'ModelProviderUnavailableError'
  )
}

const describeFailure = (cause: unknown): string => {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Unknown candidate failure.'
  return detail.replace(/\s+/g, ' ').trim().slice(0, 320) || 'Unknown candidate failure.'
}

const sumInference = (usage: readonly InferenceUsage[]): InferenceUsage =>
  usage.reduce<InferenceUsage>(
    (total, entry) => ({
      requests: total.requests + entry.requests,
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  )

const promptHashFor = (brief: DesignBrief, settings: GenerationSettings, version: string): string =>
  hash32(stableStringify({ brief, settings, version })).toString(16).padStart(8, '0')

/**
 * The operations that commit a candidate, build sequence included.
 *
 * Steps are appended to the same batch rather than dispatched separately so the
 * model and the instructions it is built from land in one transaction: undoing a
 * generation should not be able to leave a document whose steps describe parts
 * that are no longer there.
 */
export function candidateOperations(candidate: Candidate): CadOperation[] {
  const order = computeBuildOrder(candidate.document)
  if (!order.steps.length) return [...candidate.realize.operations]
  return [...candidate.realize.operations, { type: 'steps.replace', steps: order.steps }]
}

/** The shape `src/cad/engine.ts` publishes as `commandBus`. */
export interface CommandBusLike {
  dispatch(
    label: string,
    operations: CadOperation[],
    actor: 'human' | 'agent',
    expectedRevision?: number,
    sourceTool?: string,
  ): CommandResult<Transaction>
}

/** The shape a `CadEngine` instance publishes. */
export interface CadEngineLike {
  execute(
    label: string,
    operations: CadOperation[],
    actor: 'human' | 'agent',
    expectedRevision?: number,
    sourceTool?: string,
  ): CommandResult<Transaction>
}

/**
 * Commits a candidate through the command bus.
 *
 * Nothing in this workstream writes a document directly. The kernel still checks
 * the revision, the protected regions, the hard constraints and — because the
 * actor is the agent — refuses anything that would introduce a collision, which
 * is a second, independent verification of the claim the realiser already made.
 */
export function applyCandidate(
  candidate: Candidate,
  target: CommandBusLike | CadEngineLike,
  expectedRevision: number,
  label = `Generated: ${candidate.strategy}`,
): CommandResult<Transaction> {
  const operations = candidateOperations(candidate)
  // The shared bus and a directly-held engine are the same operation with two
  // names; accepting both keeps a caller that owns its own `CadEngine` — a
  // worker, a preview surface, a test — from having to wrap it.
  return 'dispatch' in target
    ? target.dispatch(label, operations, 'agent', expectedRevision, 'generation_apply')
    : target.execute(label, operations, 'agent', expectedRevision, 'generation_apply')
}

/** Axes on which two candidates differ, for presenting a choice. */
export const compareCandidates = (a: Candidate, b: Candidate): number =>
  metricDistance(a.metrics, b.metrics)

/** The metric vector, republished so a caller need not reach into `score.ts`. */
export type { MetricVector }
