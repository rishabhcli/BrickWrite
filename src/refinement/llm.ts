import { z } from 'zod'
import {
  ModelProviderUnavailableError,
  hash32,
  stableStringify,
  type ModelProvider,
  type Provenance,
} from '../platform/contracts'
import type { RegionAnalysis } from './analyse'
import { MAX_WEIGHT } from './objectives'
import { STRATEGIES, STRATEGY_IDS } from './strategies'
import { OBJECTIVE_IDS, type ObjectiveId, type RefinementProposalV1 } from './types'

/**
 * Optional model assistance, structurally unable to weaken anything.
 *
 * A language model is genuinely good at two things here: reading "make the roof
 * lower and cleaner" and deciding that this is a stepped-edge and part-count
 * request rather than a symmetry one, and looking at six scored alternatives and
 * saying which one a person actually meant. It is not good at deciding whether
 * two bricks intersect, and it must never be in a position to decide that.
 *
 * So the seam is drawn at the *shape of what a model may return*, not at a
 * convention about what it should return:
 *
 *   - A goal is a weight vector over a fixed enum plus a subset of a fixed
 *     strategy registry. There is no field for "skip the collision check",
 *     because the schema has no such field and unknown keys are dropped before
 *     anything reads them.
 *   - A ranking is a *permutation*. The proposals were guarded before ranking and
 *     are returned by identity; ids the model invents match nothing and are
 *     discarded, and proposals it omits are appended rather than deleted.
 *
 * A hostile response therefore changes the order of a list and the emphasis of a
 * search. It cannot cause an unsafe proposal to exist, because it never touches
 * the stage where proposals are made.
 *
 * With no provider configured every function here still works: the deterministic
 * reading of the instruction is the default path, not a degraded one.
 */

export interface RefinementGoal {
  readonly weights: Partial<Record<ObjectiveId, number>>
  readonly strategyIds: readonly string[]
  readonly rationale: string
  readonly provenance: Provenance
}

/**
 * Deliberately tolerant about *keys* and strict about *effect*.
 *
 * A model that returns one objective this build has never heard of should not
 * cost the caller the nine it got right, so unknown weight keys are accepted by
 * the parser and then dropped by `mergeWeights`, which only ever reads the names
 * in `OBJECTIVE_IDS`. The same reasoning applies to generator ids. What is *not*
 * tolerated is a response that is not a goal at all — that falls back whole.
 */
const goalSchema = z.object({
  weights: z.record(z.string(), z.number()),
  strategies: z.array(z.string()),
  rationale: z.string().max(400),
})

const rankingSchema = z.object({
  order: z.array(z.string()),
  rationale: z.string().max(400),
})

const GOAL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['weights', 'strategies', 'rationale'],
  properties: {
    weights: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        OBJECTIVE_IDS.map((id) => [id, { type: 'number', minimum: 0, maximum: MAX_WEIGHT }]),
      ),
    },
    strategies: { type: 'array', items: { type: 'string', enum: [...STRATEGY_IDS] } },
    rationale: { type: 'string', maxLength: 400 },
  },
} as const

const RANKING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'rationale'],
  properties: {
    order: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string', maxLength: 400 },
  },
} as const

// ---------------------------------------------------------------------------
// Deterministic reading
// ---------------------------------------------------------------------------

interface Cue {
  readonly pattern: RegExp
  readonly weights: Partial<Record<ObjectiveId, number>>
  readonly note: string
}

/**
 * What the words in a request actually ask for.
 *
 * Deliberately a small, inspectable table rather than a classifier. Each row is
 * a claim that can be argued with, and a request that matches nothing falls back
 * to the measured issues — which is the better signal anyway, because the model
 * knows what is wrong with itself even when the sentence is vague.
 */
const CUES: readonly Cue[] = [
  {
    pattern: /\b(lower|shorter|flatten|reduce (the )?height|slimmer)\b/i,
    weights: { steppedEdges: 3, partCount: 2, silhouetteFidelity: 0.5 },
    note: 'height reduction, so the outline is expected to move',
  },
  {
    pattern: /\b(clean|cleaner|tidy|smooth|smoother|round|rounded|curve[ds]?|streamlin\w*)\b/i,
    weights: { steppedEdges: 3, exposedStuds: 1, silhouetteFidelity: 1 },
    note: 'stepped edges closed with slopes and curves',
  },
  {
    pattern: /\b(strength\w*|strong\w*|reinforc\w*|sturd\w*|support\w*|overhang|brace|hold)\b/i,
    weights: { weakConnections: 3, overhangLoad: 3, supportMargin: 2 },
    note: 'structural: attachments and hanging load',
  },
  {
    pattern: /\b(rare|rarer|common\w*|availab\w*|source|sourcing|obscure|exotic)\b/i,
    weights: { rarityScore: 3, distinctElements: 2 },
    note: 'element availability, measured as official-set appearances',
  },
  {
    pattern: /\b(seam|seams|stack\w*|bond\w*|stagger\w*|course\w*)\b/i,
    weights: { seamBonding: 3, weakConnections: 1 },
    note: 'running bond: joints must not run through two courses',
  },
  {
    pattern: /\b(detail|greeb\w*|textur\w*|surface|finish\w*|tile[sd]?|smoothed top)\b/i,
    weights: { exposedStuds: 3, silhouetteFidelity: 3 },
    note: 'surface finish, with the outline held',
  },
  {
    pattern: /\b(symmetr\w*|mirror\w*|balanced)\b/i,
    weights: { symmetryError: 3 },
    note: 'symmetry across the region’s best mirror plane',
  },
  {
    pattern: /\b(simplif\w*|consolidat\w*|part count|piece count|fewer\b[^.]{0,24}\b(parts|pieces|elements|bricks|designs))/i,
    weights: { partCount: 3, distinctElements: 2, buildOrderComplexity: 1 },
    note: 'fewer, larger elements',
  },
  {
    pattern: /\b(different elements|element types|distinct|variety|standardi[sz]\w*)\b/i,
    weights: { distinctElements: 3, rarityScore: 1 },
    note: 'fewer distinct element designs',
  },
  {
    pattern: /\b(silhouette|profile|shape|outline|preserv\w*|without changing|keep the)\b/i,
    weights: { silhouetteFidelity: 4 },
    note: 'the outline is the constraint',
  },
  {
    pattern: /\b(colou?r|palette|paint\w*)\b/i,
    weights: { paletteConformance: 3 },
    note: 'palette conformance',
  },
]

/** Weights implied by what the region measurably has wrong with it. */
function measuredEmphasis(analysis: RegionAnalysis): Partial<Record<ObjectiveId, number>> {
  const weights: Partial<Record<ObjectiveId, number>> = {}
  const bump = (id: ObjectiveId, amount: number) => {
    weights[id] = (weights[id] ?? 0) + amount
  }
  if (analysis.stackedSeams.length) bump('seamBonding', 1.5)
  if (analysis.weakAttachments.length) bump('weakConnections', 1)
  if (analysis.statics.overloaded.length) bump('overhangLoad', 1.5)
  if (analysis.statics.support && !analysis.statics.support.stable) bump('supportMargin', 2)
  if (analysis.stepEdges.length) bump('steppedEdges', 1)
  if (analysis.symmetry.error > 0.05) bump('symmetryError', 1)
  if (analysis.rarity.worst.some((entry) => entry.rarity >= 0.4)) bump('rarityScore', 1)
  if (analysis.freeStuds.length >= 8) bump('exposedStuds', 0.5)
  if (analysis.palette.conformance < 1) bump('paletteConformance', 1)
  return weights
}

const mergeWeights = (
  ...sources: Array<Partial<Record<ObjectiveId, number>>>
): Partial<Record<ObjectiveId, number>> => {
  const merged: Partial<Record<ObjectiveId, number>> = {}
  for (const source of sources) {
    for (const id of OBJECTIVE_IDS) {
      const value = source[id]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      merged[id] = Math.max(0, Math.min(MAX_WEIGHT, (merged[id] ?? 0) + value))
    }
  }
  return merged
}

const deterministicProvenance = (payload: string, seed: number, createdAt: string): Provenance => ({
  provider: 'deterministic',
  model: null,
  promptHash: hash32(payload).toString(16),
  seed,
  createdAt,
})

export interface GoalInput {
  readonly instruction: string
  readonly analysis: RegionAnalysis
  readonly seed: number
  readonly createdAt?: string
}

/** The goal a request implies, with no model in the loop. Always available. */
export function deterministicGoal(input: GoalInput): RefinementGoal {
  const notes: string[] = []
  const matched: Array<Partial<Record<ObjectiveId, number>>> = []
  for (const cue of CUES) {
    if (!cue.pattern.test(input.instruction)) continue
    matched.push(cue.weights)
    notes.push(cue.note)
  }
  const measured = measuredEmphasis(input.analysis)
  const weights = mergeWeights(...matched, measured)
  const strategyIds = STRATEGIES.filter((entry) =>
    entry.targets.some((target) => (weights[target] ?? 0) > 0),
  ).map((entry) => entry.id)

  const payload = stableStringify({ instruction: input.instruction, weights, strategyIds })
  return {
    weights,
    strategyIds: strategyIds.length ? strategyIds : STRATEGY_IDS,
    rationale: notes.length
      ? `Read as: ${notes.join('; ')}.`
      : 'No explicit cue in the instruction; weighted by what the region measurably has wrong with it.',
    provenance: deterministicProvenance(payload, input.seed, input.createdAt ?? new Date().toISOString()),
  }
}

// ---------------------------------------------------------------------------
// Sanitation
// ---------------------------------------------------------------------------

/**
 * Reduces anything a model returned to the two things it is allowed to influence.
 *
 * Unknown objective ids, unknown strategy ids, non-finite weights and every extra
 * key are dropped here, before the value reaches the search. This is the reason a
 * provider cannot waive a check: there is no representable value that would.
 */
export function sanitizeGoal(
  raw: unknown,
  fallback: RefinementGoal,
): { weights: Partial<Record<ObjectiveId, number>>; strategyIds: string[]; rationale: string } {
  const parsed = goalSchema.safeParse(raw)
  if (!parsed.success) return { weights: fallback.weights, strategyIds: [...fallback.strategyIds], rationale: fallback.rationale }
  const weights = mergeWeights(parsed.data.weights as Partial<Record<ObjectiveId, number>>)
  const strategyIds = parsed.data.strategies.filter((id): id is (typeof STRATEGY_IDS)[number] =>
    (STRATEGY_IDS as readonly string[]).includes(id),
  )
  return {
    weights: Object.keys(weights).length ? weights : fallback.weights,
    strategyIds: strategyIds.length ? strategyIds : [...fallback.strategyIds],
    rationale: parsed.data.rationale || fallback.rationale,
  }
}

const GOAL_SYSTEM =
  'You are choosing what a LEGO model refinement should optimize. You return weights over a fixed set of '
  + 'measured objectives and a subset of a fixed set of generators. You never decide whether a placement is '
  + 'legal: collision, connectivity, protected regions and design constraints are enforced by the kernel '
  + 'after you have answered, and nothing you return can change that.'

function goalPrompt(input: GoalInput): string {
  const analysis = input.analysis
  const issues = analysis.issues.slice(0, 24).map((issue) => `${issue.kind} × ${issue.measure} ${issue.unit} — ${issue.detail}`)
  return [
    `Instruction: ${input.instruction || '(none given)'}`,
    `Region: ${analysis.scopePartIds.length} parts, ${analysis.variety.distinctCount} distinct elements.`,
    `Measured issues:`,
    ...issues.map((line) => `  - ${line}`),
    '',
    `Objectives you may weight (0–${MAX_WEIGHT}): ${OBJECTIVE_IDS.join(', ')}.`,
    `Generators you may select: ${STRATEGY_IDS.join(', ')}.`,
  ].join('\n')
}

export interface ModelOptions {
  readonly provider?: ModelProvider | null
  readonly signal?: AbortSignal
  readonly createdAt?: string
}

/**
 * A goal, from the provider when one is configured and from the table when not.
 *
 * A provider failure is not fatal: the deterministic reading is returned with the
 * failure attached as the rationale, because a refinement that refuses to run
 * because an API was down is worse than one that runs on the cues in the sentence.
 */
export async function proposeGoal(input: GoalInput, options: ModelOptions = {}): Promise<RefinementGoal> {
  const fallback = deterministicGoal(input)
  const provider = options.provider
  if (!provider) return fallback

  try {
    const result = await provider.complete({
      system: GOAL_SYSTEM,
      prompt: goalPrompt(input),
      schema: GOAL_JSON_SCHEMA,
      parse: (value) => sanitizeGoal(value, fallback),
      signal: options.signal,
      maxTokens: 600,
      temperature: 0,
    })
    return {
      weights: result.value.weights,
      strategyIds: result.value.strategyIds,
      rationale: result.value.rationale,
      provenance: result.provenance,
    }
  } catch (cause) {
    if (cause instanceof ModelProviderUnavailableError) return fallback
    return {
      ...fallback,
      rationale: `${fallback.rationale} (Model assistance unavailable: ${cause instanceof Error ? cause.message : String(cause)}.)`,
    }
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Re-orders already-guarded proposals. It cannot do anything else.
 *
 * Every returned element is one of the inputs, matched by id. An id the model
 * invented resolves to nothing and is skipped; a proposal it left out is appended
 * in its original position order, so a model cannot suppress an alternative by
 * omission any more than it can introduce one by invention. Rejected proposals
 * keep their place at the end regardless of what the model said about them.
 */
export function applyRanking(
  proposals: readonly RefinementProposalV1[],
  order: readonly string[],
): RefinementProposalV1[] {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]))
  const taken = new Set<string>()
  const ranked: RefinementProposalV1[] = []
  for (const id of order) {
    const proposal = byId.get(id)
    if (!proposal || taken.has(id) || proposal.status !== 'ranked') continue
    taken.add(id)
    ranked.push(proposal)
  }
  for (const proposal of proposals) {
    if (taken.has(proposal.id)) continue
    ranked.push(proposal)
  }
  return ranked
}

const RANK_SYSTEM =
  'You are ordering LEGO model refinements that have already been checked for collisions, connectivity, '
  + 'protected regions and design constraints. Every option is legal. Return the ids in the order a builder '
  + 'would prefer them. You cannot add, remove or alter an option.'

function rankPrompt(instruction: string, proposals: readonly RefinementProposalV1[]): string {
  return [
    `Instruction: ${instruction || '(none given)'}`,
    'Options:',
    ...proposals
      .filter((proposal) => proposal.status === 'ranked')
      .map((proposal) => {
        const moved = Object.entries(proposal.metrics.delta)
          .filter(([, value]) => Math.abs(value) > 1e-9)
          .map(([id, value]) => `${id} ${value > 0 ? '+' : ''}${value.toFixed(3)}`)
          .join(', ')
        return `  - ${proposal.id} [${proposal.strategy}] ${proposal.label}; changes: ${moved || 'none measured'}`
      }),
  ].join('\n')
}

export async function rankProposals(
  instruction: string,
  proposals: readonly RefinementProposalV1[],
  options: ModelOptions = {},
): Promise<{ proposals: RefinementProposalV1[]; rationale: string; provenance: Provenance | null }> {
  const provider = options.provider
  if (!provider || proposals.filter((proposal) => proposal.status === 'ranked').length < 2) {
    return { proposals: [...proposals], rationale: 'Ranked by measured weighted improvement.', provenance: null }
  }
  try {
    const result = await provider.complete({
      system: RANK_SYSTEM,
      prompt: rankPrompt(instruction, proposals),
      schema: RANKING_JSON_SCHEMA,
      parse: (value) => {
        const parsed = rankingSchema.safeParse(value)
        return parsed.success ? parsed.data : { order: [], rationale: '' }
      },
      signal: options.signal,
      maxTokens: 400,
      temperature: 0,
    })
    return {
      proposals: applyRanking(proposals, result.value.order),
      rationale: result.value.rationale || 'Re-ordered by the configured model.',
      provenance: result.provenance,
    }
  } catch (cause) {
    return {
      proposals: [...proposals],
      rationale: `Ranked by measured weighted improvement; model ranking unavailable (${cause instanceof Error ? cause.message : String(cause)}).`,
      provenance: null,
    }
  }
}
