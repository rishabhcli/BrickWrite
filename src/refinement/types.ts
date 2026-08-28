import { z } from 'zod'
import type { CadOperation, Vec3 } from '../cad/types'
import type { Provenance } from '../platform/contracts'

/**
 * The refinement request/proposal contract.
 *
 * Refinement is the second half of the build loop: something rough exists, a
 * region of it is selected, and a change is asked for in words. Everything in
 * this file exists so that request survives the trip to a search process and
 * back without any of it becoming prose again — the scope is a list of part ids,
 * not "the roof"; the objective is a weight vector, not "cleaner"; and what came
 * back is a `CadOperation[]` the kernel already knows how to check.
 *
 * The schemas are not decoration. A request crosses a worker boundary and may
 * be composed by a language model, so it is parsed on entry at both ends; a
 * proposal is parsed before it is offered, which is what stops a strategy bug
 * from emitting an operation the refinement vocabulary does not permit.
 */

// ---------------------------------------------------------------------------
// Operation vocabulary
// ---------------------------------------------------------------------------

const vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])

const basisSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(),
  z.number().finite(), z.number().finite(), z.number().finite(),
  z.number().finite(), z.number().finite(), z.number().finite(),
])

const transformSchema = z.object({ position: vec3Schema, basis: basisSchema })

const partInstanceSchema = z.object({
  id: z.string().min(1),
  definitionId: z.string().min(1),
  color: z.number().int(),
  transform: transformSchema,
  subassemblyId: z.string().min(1),
  stepId: z.string().min(1),
  provenance: z.enum(['human', 'agent']),
  protected: z.boolean(),
  createdByTransaction: z.string().optional(),
})

/**
 * The operations a refinement is allowed to emit.
 *
 * Deliberately a strict subset of `CadOperation`. Refinement changes bricks; it
 * does not rename the document, delete a constraint, unlock a subassembly or
 * rewrite the note thread. Encoding that as a narrower union means the
 * restriction is enforced by the parser rather than by reviewers noticing —
 * a strategy that tried to emit `constraint.remove` fails validation instead of
 * quietly stripping the design limit it was supposed to satisfy.
 */
export const refinementOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('part.add'), part: partInstanceSchema }),
  z.object({ type: z.literal('part.remove'), partId: z.string().min(1) }),
  z.object({ type: z.literal('part.transform'), partId: z.string().min(1), transform: transformSchema }),
  z.object({ type: z.literal('part.recolor'), partId: z.string().min(1), color: z.number().int() }),
  z.object({ type: z.literal('part.assign-subassembly'), partId: z.string().min(1), subassemblyId: z.string().min(1) }),
])

export type RefinementOperation = z.infer<typeof refinementOperationSchema>

/** Compile-time proof that the narrowed vocabulary really is a `CadOperation`. */
const _operationIsCadOperation: (operation: RefinementOperation) => CadOperation = (operation) => operation
void _operationIsCadOperation

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export const OBJECTIVE_IDS = [
  'silhouetteFidelity',
  'supportMargin',
  'weakConnections',
  'seamBonding',
  'symmetryError',
  'partCount',
  'distinctElements',
  'rarityScore',
  'paletteConformance',
  'buildOrderComplexity',
  'overhangLoad',
] as const

export type ObjectiveId = (typeof OBJECTIVE_IDS)[number]

export const objectiveIdSchema = z.enum(OBJECTIVE_IDS)

/** One measured value per objective. Always complete: a missing number hides a regression. */
export type MetricVector = Record<ObjectiveId, number>

export const metricVectorSchema = z.object(
  Object.fromEntries(OBJECTIVE_IDS.map((id) => [id, z.number()])) as {
    [K in ObjectiveId]: z.ZodNumber
  },
)

// ---------------------------------------------------------------------------
// Silhouette
// ---------------------------------------------------------------------------

/**
 * A coverage mask of the model as seen from the booklet camera.
 *
 * `mask` is one byte per pixel — 0 or 1 — because the only question asked of it
 * is "did the outline move", and a coverage bit answers that without carrying
 * shading, colour or the illusion of more precision than the source has.
 */
export const silhouetteSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Row-major coverage bits, `width * height` long. */
  mask: z.array(z.number().int().min(0).max(1)),
  /** Bounds the framing was computed from, so two masks are comparable. */
  frameMin: vec3Schema,
  frameMax: vec3Schema,
})

export type SilhouetteV1 = z.infer<typeof silhouetteSchema>

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const refinementRequestSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  /** Explicit part ids the refinement may change. Never a spatial query. */
  scopePartIds: z.array(z.string().min(1)),
  /** Part ids that must not move, even if they fall inside the scope. */
  protectedPartIds: z.array(z.string().min(1)).default([]),
  /**
   * Parts whose connector interfaces are the seam with the rest of the model.
   * Their world connector frames and incident edges must survive unchanged, or
   * the refined region no longer attaches to what surrounds it.
   */
  boundaryPartIds: z.array(z.string().min(1)).default([]),
  /** Parts a symmetry strategy is explicitly allowed to leave unmatched. */
  symmetryExceptionPartIds: z.array(z.string().min(1)).default([]),
  objectiveWeights: z.partialRecord(objectiveIdSchema, z.number().finite()).default({}),
  baseRevision: z.number().int().nonnegative(),
  instruction: z.string().default(''),
  referenceSilhouette: silhouetteSchema.nullable().default(null),
  seed: z.number().int().default(0),
  budget: z
    .object({
      maxIterations: z.number().int().positive().max(100_000).default(400),
      wallClockMs: z.number().int().positive().max(600_000).default(2_000),
    })
    .default({ maxIterations: 400, wallClockMs: 2_000 }),
  /** Cap on how far the silhouette may drift, as a fraction of its area. */
  silhouetteToleranceFraction: z.number().min(0).max(1).default(0.12),
  maxProposals: z.number().int().positive().max(64).default(6),
})

export type RefinementRequestV1 = z.infer<typeof refinementRequestSchema>
export type RefinementRequestInput = z.input<typeof refinementRequestSchema>

/**
 * The immutable view of a request that strategies and objectives receive.
 *
 * Objectives take `(document, scope)` and nothing else, so every number in the
 * metric vector is reproducible from two values a caller can print.
 */
export interface RefinementScope {
  readonly partIds: readonly string[]
  readonly partIdSet: ReadonlySet<string>
  readonly protectedPartIds: ReadonlySet<string>
  readonly boundaryPartIds: ReadonlySet<string>
  readonly symmetryExceptionPartIds: ReadonlySet<string>
  readonly reference: SilhouetteV1 | null
  readonly instruction: string
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export const REJECTION_CODES = [
  'PROTECTED_PART',
  'BOUNDARY_MOVED',
  'COLLISION',
  'DISCONNECTED',
  'CONSTRAINT_VIOLATION',
  'BUILD_ORDER',
  'SILHOUETTE_DRIFT',
  'NO_IMPROVEMENT',
  'STALE_REVISION',
  'EMPTY',
] as const

export type RejectionCode = (typeof REJECTION_CODES)[number]

export const CHANGE_KINDS = ['added', 'removed', 'moved', 'recolored', 'substituted', 'reassigned'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/**
 * What the UI paints on one part.
 *
 * `magnitude` is 0–1 and is comparable *within* one proposal: it is the change's
 * size against the largest change the same proposal makes, which is what a
 * heatmap needs. It is not comparable across proposals and is not a confidence.
 */
export const overlayInstructionSchema = z.object({
  partId: z.string().min(1),
  changeKind: z.enum(CHANGE_KINDS),
  magnitude: z.number().min(0).max(1),
  /** Document-space anchor for a label or a marker, in LDU. */
  atLdu: z.tuple([z.number(), z.number(), z.number()]),
  detail: z.string(),
})

export type OverlayInstruction = z.infer<typeof overlayInstructionSchema>

export const provenanceSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  promptHash: z.string(),
  seed: z.number(),
  createdAt: z.string(),
})

export const refinementProposalSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  requestId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  /** Which generator produced it, for the "why did I get this" question. */
  strategy: z.string().min(1),
  label: z.string().min(1),
  operations: z.array(refinementOperationSchema),
  changedPartIds: z.array(z.string()),
  metrics: z.object({
    before: metricVectorSchema,
    after: metricVectorSchema,
    /** `after - before`, per objective, sign preserved. */
    delta: metricVectorSchema,
  }),
  /** Weighted improvement; higher is better. Zero for a rejected proposal. */
  score: z.number(),
  /** Objectives this proposal made worse, named so a regression cannot hide. */
  regressions: z.array(objectiveIdSchema),
  warnings: z.array(z.string()),
  overlay: z.array(overlayInstructionSchema),
  provenance: provenanceSchema,
  status: z.enum(['ranked', 'rejected']),
  rejection: z.object({ code: z.enum(REJECTION_CODES), reason: z.string(), partIds: z.array(z.string()) }).nullable(),
})

export type RefinementProposalV1 = z.infer<typeof refinementProposalSchema>

/** Narrowing helper so callers cannot apply something the guards refused. */
export const isApplicable = (proposal: RefinementProposalV1): boolean =>
  proposal.status === 'ranked' && proposal.operations.length > 0

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export const ISSUE_KINDS = [
  'stacked-seam',
  'weak-attachment',
  'overhang-overload',
  'unsupported-part',
  'tipping-margin',
  'symmetry-deviation',
  'rare-part',
  'element-variety',
  'palette-outlier',
  'stepped-edge',
  'exposed-stud-field',
  'micro-run',
] as const

export type IssueKind = (typeof ISSUE_KINDS)[number]

/**
 * One thing that is wrong or improvable, located and measured.
 *
 * `measure` is in the units named by `unit`, so a caller sorting issues is
 * sorting comparable numbers rather than a severity word somebody chose.
 */
export interface RefinementIssue {
  readonly id: string
  readonly kind: IssueKind
  readonly partIds: readonly string[]
  readonly atLdu: Vec3
  readonly measure: number
  readonly unit: 'count' | 'ldu' | 'grams' | 'fraction'
  readonly severity: 'info' | 'warning' | 'error'
  readonly detail: string
  /** Objectives this issue would move if it were fixed. */
  readonly objectives: readonly ObjectiveId[]
}

export type { Provenance }
