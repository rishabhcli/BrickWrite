import { z } from 'zod'

/**
 * What the model is allowed to say back.
 *
 * The API is told the shape through `output_config.format`, and the answer is
 * *also* checked here. Both, not either: a structured-output guarantee is a
 * property of one provider's endpoint, and a server that trusted it without
 * validating would turn a provider change — or a beta flag being dropped — into
 * a silent change of contract. Validation is the thing that makes "a violating
 * response is retried once then rejected" a fact rather than an intention.
 *
 * These schemas describe *structure*, never geometry. A box is a volume on the
 * stud lattice; a detail is an intent plus which stud to hang it from. Every
 * coordinate that ends up in a document is computed by the kernel from these.
 */

/**
 * One rectangular volume of the massing decomposition.
 *
 * The ranges live here rather than in the JSON Schema because the
 * structured-output endpoint does not accept `minimum`/`maximum` — it constrains
 * shape, and this constrains values. A box outside these bounds is a schema
 * violation like any other and takes the corrective retry.
 */
export const massingBoxSchema = z.object({
  id: z.string().min(1).max(40),
  role: z.string().min(1).max(40),
  atXStuds: z.number().int().min(0).max(256),
  atZStuds: z.number().int().min(0).max(256),
  widthStuds: z.number().int().min(1).max(256),
  depthStuds: z.number().int().min(1).max(256),
  courses: z.number().int().min(1).max(64),
  level: z.number().int().min(0).max(8),
  fill: z.enum(['shell', 'solid']),
})

export const massingSchema = z.object({
  boxes: z.array(massingBoxSchema).min(1).max(8),
})

/** One surface feature: a part intent and the stud it hangs from. */
export const detailFeatureSchema = z.object({
  id: z.string().min(1).max(40),
  role: z.string().min(1).max(40),
  query: z.string().min(1).max(80),
  atXStuds: z.number().int().min(0).max(256),
  atZStuds: z.number().int().min(0).max(256),
  quarterTurns: z.number().int().min(0).max(3),
})

export const detailSchema = z.object({
  features: z.array(detailFeatureSchema).max(24),
})

export const designBriefSchema = z.object({
  subject: z.string().min(1).max(120),
  envelopeWidthStuds: z.number().int().min(1).max(512).nullable(),
  envelopeHeightStuds: z.number().int().min(1).max(512).nullable(),
  envelopeDepthStuds: z.number().int().min(1).max(512).nullable(),
  scale: z.enum(['micro', 'minifig', 'midi', 'large', 'unspecified']),
  functions: z.array(z.string().max(120)).max(12),
  paletteColourNames: z.array(z.string().max(40)).max(12),
  symmetry: z.enum(['none', 'mirror-x', 'mirror-z', 'radial']),
  partBudget: z.number().int().min(1).max(20000).nullable(),
  style: z.array(z.string().max(40)).max(12),
  evidence: z.array(z.object({ field: z.string().max(60), phrase: z.string().max(200) })).max(24),
  conflicts: z.array(z.object({ field: z.string().max(40), detail: z.string().max(240) })).max(12),
})

export type PayloadKind = 'massing' | 'detail' | 'brief'

const VALIDATORS: Record<PayloadKind, z.ZodType> = {
  massing: massingSchema,
  detail: detailSchema,
  brief: designBriefSchema,
}

/**
 * Works out which payload a caller's JSON Schema is asking for.
 *
 * The `ModelRequest` contract carries a JSON Schema, not a kind, and it is not
 * this workstream's to change. Deriving the kind from the schema's own top-level
 * properties keeps the contract intact; a schema that matches none of them is
 * refused with a clear message rather than passed through unvalidated, which
 * would defeat the point of validating at all.
 */
export function kindForSchema(schema: unknown): PayloadKind | null {
  const properties = (schema as { properties?: Record<string, unknown> } | null)?.properties
  if (!properties || typeof properties !== 'object') return null
  if ('boxes' in properties) return 'massing'
  if ('features' in properties) return 'detail'
  if ('subject' in properties) return 'brief'
  return null
}

export interface ValidationOutcome {
  readonly ok: boolean
  readonly value?: unknown
  /** Field-by-field account of what was wrong, for the retry message. */
  readonly problems?: string[]
}

export function validatePayload(kind: PayloadKind, value: unknown): ValidationOutcome {
  const parsed = VALIDATORS[kind].safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    problems: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
  }
}
