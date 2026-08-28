import { z } from 'zod'
import { hash32, stableStringify, type DesignBrief, type ModelProvider, type Provenance } from '../platform/contracts'

/**
 * Natural language to an editable design brief.
 *
 * The brief exists so that an ambiguity in a request becomes a field a person
 * can see and correct, instead of an assumption buried inside a prompt. That
 * only works if the compiler is honest in two directions: it must not invent a
 * value the request did not contain, and it must not quietly pick a side when
 * the request contains two.
 *
 * The compiler is deterministic. The same sentence produces the same brief in
 * every process, which is what makes the fixture set in `__fixtures__` a
 * regression test rather than a snapshot of one model's mood. A model provider
 * can refine the result afterwards, but only into fields the deterministic pass
 * left empty — anything it contradicts becomes a visible conflict.
 *
 * Convention: a `0` in `envelopeStuds` means "unconstrained on that axis". A
 * request that says "48 x 48" has stated a footprint and said nothing about
 * height, and writing a made-up height there would be exactly the silent
 * assumption this type exists to prevent.
 */

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

/** LDraw colour codes for the words people actually use. */
const COLOR_WORDS: ReadonlyArray<readonly [RegExp, number, string]> = [
  [/\bblack\b/, 0, 'Black'],
  [/\b(?:dark\s+)?blue\b/, 1, 'Blue'],
  [/\b(?:dark\s+)?green\b/, 2, 'Green'],
  [/\bteal\b|\bdark turquoise\b/, 3, 'Dark Turquoise'],
  [/\bred\b/, 4, 'Red'],
  [/\bmagenta\b|\bpink\b/, 5, 'Dark Pink'],
  [/\bbrown\b/, 6, 'Brown'],
  [/\blight (?:grey|gray)\b/, 7, 'Light Grey'],
  [/\bdark (?:grey|gray)\b/, 8, 'Dark Grey'],
  [/\byellow\b/, 14, 'Yellow'],
  [/\bwhite\b/, 15, 'White'],
  [/\bpurple\b|\bviolet\b/, 26, 'Purple'],
  [/\borange\b/, 25, 'Orange'],
  [/\blime\b/, 27, 'Lime'],
  [/\btan\b|\bsand\b/, 19, 'Tan'],
  [/\bclear\b|\btransparent\b|\bglass\b/, 47, 'Trans-Clear'],
  [/\breddish brown\b/, 70, 'Reddish Brown'],
  [/\b(?:light bluish|stone) (?:grey|gray)\b|\b(?:grey|gray)\b/, 71, 'Light Bluish Grey'],
  [/\bdark bluish (?:grey|gray)\b|\bcharcoal\b/, 72, 'Dark Bluish Grey'],
]

const SCALE_WORDS: ReadonlyArray<readonly [RegExp, DesignBrief['scale']]> = [
  [/\bmicro[- ]?scale\b|\bmicroscale\b|\bmicro\b/, 'micro'],
  [/\bminifig(?:ure)?[- ]?(?:scale|sized)?\b/, 'minifig'],
  [/\bmidi[- ]?scale\b|\bmidi\b/, 'midi'],
  [/\bucs\b|\blarge[- ]?scale\b|\bdisplay model\b|\bhuge\b|\bgiant\b/, 'large'],
]

const FUNCTION_VERBS =
  /\b(turn|turns|rotate|rotates|rotating|spin|spins|open|opens|opening|lift|lifts|slide|slides|sliding|hinge|hinged|fold|folds|detach|detaches|detachable|removable|steer|steers|steering|tilt|tilts|swing|swings|retract|retracts|extend|extends|roll|rolls)\b/

const STYLE_WORDS = [
  'modern',
  'classic',
  'retro',
  'futuristic',
  'sleek',
  'chunky',
  'minimal',
  'minimalist',
  'detailed',
  'ornate',
  'industrial',
  'medieval',
  'art deco',
  'brutalist',
  'cartoon',
  'realistic',
  'blocky',
  'smooth',
  'rugged',
  'elegant',
  'playful',
  'steampunk',
  'nautical',
  'rustic',
] as const

const VAGUE_PHRASES = [
  'something',
  'anything',
  'whatever',
  'some kind of',
  'some sort of',
  'a few',
  'a couple',
  'not sure',
  'maybe',
  'or so',
  "i don't mind",
  'surprise me',
] as const

const PRESERVE_VERBS = /(keep|preserve|protect|do not touch|don't touch|leave|don't change|do not change)/i

export interface BriefCompileOptions {
  /** Images the operator attached. Recorded as evidence; never read as fields. */
  images?: ReadonlyArray<{ label: string; mediaType: string }>
  /** Part ids the operator explicitly protected in the editor. */
  protectedPartIds?: readonly string[]
  /** A brief being edited, so a recompile refines rather than discards. */
  base?: DesignBrief
}

interface Finding<T> {
  value: T
  phrase: string
}

function findAll<T>(text: string, pattern: RegExp, map: (match: RegExpExecArray) => T | null): Array<Finding<T>> {
  const results: Array<Finding<T>> = []
  const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    const value = map(match)
    if (value !== null) results.push({ value, phrase: clean(match[0]) })
    if (match.index === scan.lastIndex) scan.lastIndex += 1
  }
  return results
}

const DIMENSION_PATTERN = /(\d{1,4})\s*(?:x|×|by)\s*(\d{1,4})(?:\s*(?:x|×|by)\s*(\d{1,4}))?\s*(?:stud|studs|plate|plates)?/gi
const AXIS_PATTERN = /(\d{1,4})\s*studs?\s*(wide|long|deep|tall|high)/gi
const BUDGET_PATTERN =
  /(?:under|below|less than|at most|no more than|max(?:imum)?(?:\s+of)?|budget of|fewer than)\s*(\d{1,6})\s*(?:pieces|parts|bricks|elements)?|(\d{1,6})[-\s](?:piece|part|brick)\s*(?:budget|limit|build|model)/gi

function extractEnvelope(text: string): { findings: Array<Finding<[number, number, number]>>; axes: Array<Finding<[string, number]>> } {
  const findings = findAll<[number, number, number]>(text, DIMENSION_PATTERN, (match) => {
    const a = Number(match[1])
    const b = Number(match[2])
    const c = match[3] === undefined ? null : Number(match[3])
    if (!a || !b) return null
    // Two numbers describe a footprint: width and depth. Height is unstated,
    // and 0 records that rather than guessing one.
    return c === null ? [a, 0, b] : [a, c, b]
  })
  const axes = findAll<[string, number]>(text, AXIS_PATTERN, (match) => [match[2].toLowerCase(), Number(match[1])])
  return { findings, axes }
}

function extractBudget(text: string): Array<Finding<number>> {
  return findAll<number>(text, BUDGET_PATTERN, (match) => {
    const value = Number(match[1] ?? match[2])
    return Number.isFinite(value) && value > 0 ? value : null
  })
}

function extractSubject(text: string): { subject: string; phrase: string } {
  const stripped = clean(text)
    .replace(
      /^(?:hey|hi|ok|okay|please|could you|can you|would you|i(?:'d| would) like|i want|i need|let'?s|help me)\b[\s,]*/i,
      '',
    )
    .replace(/^(?:please\s+)?(?:build|make|design|create|generate|model|draw|give me|add)\b\s*/i, '')
    .replace(/^(?:me\s+)?(?:a|an|the|some)\s+/i, '')

  // Cut at the first structural boundary: everything after it is a modifier,
  // and modifiers belong in their own fields rather than in the subject.
  const cut = stripped.search(
    /(?:,|\.|;|\bthat\b|\bwhich\b|\bwith\b|\bunder\b|\busing\b|\bin\s+(?:red|blue|green|yellow|white|black|orange|grey|gray|tan|brown)\b|\bfor\b|\bso\s+that\b)/i,
  )
  const head = clean(cut > 0 ? stripped.slice(0, cut) : stripped)
  const words = head.split(' ').filter(Boolean).slice(0, 10)
  const subject = words.join(' ') || clean(text).split(' ').slice(0, 8).join(' ')
  return { subject, phrase: clean(text).slice(0, 160) }
}

function extractFunctions(text: string): Array<Finding<string>> {
  const clauses = text.split(/[,;.]|\band\b|\bplus\b|\bwith\b/i)
  const results: Array<Finding<string>> = []
  for (const raw of clauses) {
    const clause = clean(raw)
    if (!clause || !FUNCTION_VERBS.test(clause)) continue
    const phrase = clause.replace(/^(?:that|which|it|so|it should|should|can|it can)\s+/i, '')
    if (phrase.length < 3 || phrase.length > 120) continue
    results.push({ value: phrase.toLowerCase(), phrase: clause })
  }
  return results.slice(0, 12)
}

function extractPalette(text: string): { include: Array<Finding<number>>; exclude: Array<Finding<number>> } {
  const include: Array<Finding<number>> = []
  const exclude: Array<Finding<number>> = []
  for (const [pattern, code, name] of COLOR_WORDS) {
    const match = new RegExp(pattern.source, 'i').exec(text)
    if (!match) continue
    const before = text.slice(Math.max(0, match.index - 24), match.index).toLowerCase()
    const negated = /\b(?:no|not|avoid|without|never|except)\b[\s\w]*$/.test(before)
    ;(negated ? exclude : include).push({ value: code, phrase: `${negated ? 'no ' : ''}${name.toLowerCase()}` })
  }
  return { include, exclude }
}

function extractSymmetry(text: string): { value: DesignBrief['symmetry']; phrase: string } | null {
  if (/\basymmetric(?:al)?\b|\bnot symmetric(?:al)?\b|\bno symmetry\b/i.test(text)) {
    return { value: 'none', phrase: 'asymmetric' }
  }
  if (/\bradial(?:ly)?\b|\brotationally symmetric\b|\bradial symmetry\b/i.test(text)) {
    return { value: 'radial', phrase: 'radial symmetry' }
  }
  if (/\bfront[- ]to[- ]back\b|\bmirror(?:ed)? (?:front|along z)\b/i.test(text)) {
    return { value: 'mirror-z', phrase: 'mirrored front to back' }
  }
  if (/\bsymmetric(?:al)?\b|\bmirror(?:ed|s)?\b|\bboth sides the same\b/i.test(text)) {
    return { value: 'mirror-x', phrase: 'symmetrical' }
  }
  return null
}

/**
 * Compiles a request into an editable brief.
 *
 * Pure and total: every input produces a brief, and an input the compiler
 * cannot read produces a brief whose `conflicts` say so.
 */
export function compileBrief(text: string, options: BriefCompileOptions = {}): DesignBrief {
  const source = clean(text)
  const lower = source.toLowerCase()
  const evidence: Record<string, string> = {}
  const conflicts: DesignBrief['conflicts'] = []

  // --- subject ---------------------------------------------------------
  const { subject, phrase: subjectPhrase } = extractSubject(source)
  evidence.subject = subjectPhrase

  const choice = /\b(?:a|an|the)?\s*([a-z][a-z\s-]{2,28}?)\s+or\s+(?:a|an|the)?\s*([a-z][a-z\s-]{2,28}?)\b/i.exec(source)
  if (choice) {
    conflicts.push({
      field: 'subject',
      detail: `The request offers a choice between "${clean(choice[1])}" and "${clean(choice[2])}". Pick one before generating.`,
    })
  }
  const vague = VAGUE_PHRASES.find((word) => lower.includes(word))
  if (vague) {
    conflicts.push({
      field: 'subject',
      detail: `"${vague}" leaves the subject undetermined. Say what to build, or accept whatever the generator chooses.`,
    })
  }

  // --- envelope --------------------------------------------------------
  const { findings: envelopes, axes } = extractEnvelope(source)
  let envelopeStuds: DesignBrief['envelopeStuds'] = null
  if (envelopes.length) {
    envelopeStuds = envelopes[0].value
    evidence.envelopeStuds = envelopes[0].phrase
    const distinct = [...new Set(envelopes.map((item) => item.value.join('x')))]
    if (distinct.length > 1) {
      conflicts.push({
        field: 'envelopeStuds',
        detail: `Two different sizes were given: ${distinct.join(' and ')} studs. Choose one envelope.`,
      })
    }
  } else if (axes.length) {
    const byAxis: Record<string, number> = {}
    for (const axis of axes) byAxis[axis.value[0]] = axis.value[1]
    const width = byAxis.wide ?? 0
    const depth = byAxis.deep ?? byAxis.long ?? 0
    const height = byAxis.tall ?? byAxis.high ?? 0
    if (width || depth || height) {
      envelopeStuds = [width, height, depth]
      evidence.envelopeStuds = axes.map((axis) => axis.phrase).join(', ')
    }
  }

  // --- scale -----------------------------------------------------------
  const scaleHits = SCALE_WORDS.filter(([pattern]) => pattern.test(lower))
  let scale: DesignBrief['scale'] = 'unspecified'
  if (scaleHits.length) {
    scale = scaleHits[0][1]
    evidence.scale = clean(new RegExp(scaleHits[0][0].source, 'i').exec(source)?.[0] ?? scale)
    const distinct = [...new Set(scaleHits.map(([, value]) => value))]
    if (distinct.length > 1) {
      conflicts.push({
        field: 'scale',
        detail: `The request names more than one scale (${distinct.join(', ')}). Choose one; they imply different part vocabularies.`,
      })
    }
  }

  // --- functions -------------------------------------------------------
  const functionFindings = extractFunctions(source)
  const functions = [...new Set(functionFindings.map((item) => item.value))]
  if (functions.length) evidence.functions = functionFindings.map((item) => item.phrase).join(' / ')

  // --- palette ---------------------------------------------------------
  const { include, exclude } = extractPalette(source)
  const palette = [...new Set(include.map((item) => item.value))]
  if (palette.length) evidence.palette = include.map((item) => item.phrase).join(', ')
  for (const excluded of exclude) {
    if (!palette.includes(excluded.value)) continue
    conflicts.push({
      field: 'palette',
      detail: `Colour ${excluded.value} is both required and excluded ("${excluded.phrase}"). Decide whether it is allowed.`,
    })
  }

  // --- symmetry --------------------------------------------------------
  const symmetryFinding = extractSymmetry(source)
  const symmetry: DesignBrief['symmetry'] = symmetryFinding?.value ?? 'none'
  if (symmetryFinding) evidence.symmetry = symmetryFinding.phrase
  if (
    /\basymmetric(?:al)?\b|\bnot symmetric(?:al)?\b/i.test(source) &&
    /\b(?:is |be |perfectly |fully )symmetric(?:al)?\b/i.test(source)
  ) {
    conflicts.push({
      field: 'symmetry',
      detail: 'The request asks for the build to be both symmetrical and asymmetrical. Choose one.',
    })
  }

  // --- part budget -----------------------------------------------------
  const budgets = extractBudget(source)
  let partBudget: DesignBrief['partBudget'] = null
  if (budgets.length) {
    partBudget = budgets[0].value
    evidence.partBudget = budgets[0].phrase
    const distinct = [...new Set(budgets.map((item) => item.value))]
    if (distinct.length > 1) {
      conflicts.push({
        field: 'partBudget',
        detail: `Two different piece budgets were given (${distinct.join(' and ')}). Choose one ceiling.`,
      })
    }
  }

  // A budget that cannot cover the stated footprint is a contradiction the
  // compiler can prove: the largest standard brick covers eight studs, so a
  // footprint needs at least area/8 parts before anything is built on it.
  if (partBudget !== null && envelopeStuds && envelopeStuds[0] > 0 && envelopeStuds[2] > 0) {
    const minimumParts = Math.ceil((envelopeStuds[0] * envelopeStuds[2]) / 8)
    if (minimumParts > partBudget) {
      conflicts.push({
        field: 'partBudget',
        detail: `A ${envelopeStuds[0]} × ${envelopeStuds[2]} stud footprint needs at least ${minimumParts} parts to cover, but the budget is ${partBudget}. Raise the budget or shrink the footprint.`,
      })
    }
  }

  if (scale === 'micro' && functions.some((entry) => /minifig/.test(entry))) {
    conflicts.push({
      field: 'scale',
      detail: 'Micro scale and a minifigure requirement cannot both hold. Choose the scale the figures determine.',
    })
  }

  // --- style -----------------------------------------------------------
  const style = STYLE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower))
  if (style.length) evidence.style = style.join(', ')

  // --- attachments -----------------------------------------------------
  if (options.images?.length) {
    evidence.images = options.images.map((image) => `${image.label} (${image.mediaType})`).join(', ')
    if (!source) {
      conflicts.push({
        field: 'subject',
        detail: 'An image was attached with no description. Say what to take from it — its shape, its colours, or its subject.',
      })
    }
  }

  // --- protection ------------------------------------------------------
  const protectedPartIds = new Set(options.protectedPartIds ?? [])
  for (const match of source.matchAll(/@part:([A-Za-z0-9_\-.]+)/g)) {
    const before = source.slice(Math.max(0, (match.index ?? 0) - 48), match.index)
    if (PRESERVE_VERBS.test(before)) protectedPartIds.add(match[1])
  }
  if (protectedPartIds.size) evidence.protectedPartIds = `${protectedPartIds.size} part(s) marked as untouchable`

  const base = options.base
  return {
    version: 1,
    subject: subject || base?.subject || 'Unspecified build',
    envelopeStuds: envelopeStuds ?? base?.envelopeStuds ?? null,
    scale: scale === 'unspecified' ? (base?.scale ?? 'unspecified') : scale,
    functions: functions.length ? functions : (base?.functions ?? []),
    palette: palette.length ? palette : (base?.palette ?? []),
    symmetry: symmetryFinding ? symmetry : (base?.symmetry ?? 'none'),
    partBudget: partBudget ?? base?.partBudget ?? null,
    protectedPartIds: [...protectedPartIds].sort(),
    style: style.length ? [...style] : (base?.style ?? []),
    evidence: { ...(base?.evidence ?? {}), ...evidence },
    conflicts,
  }
}

/** Deterministic provenance for a brief compiled without a model. */
export function briefProvenance(text: string): Provenance {
  const promptHash = `fnv1a:${hash32(stableStringify({ compiler: 'brickwright.brief/1', text })).toString(16)}`
  return {
    provider: 'deterministic',
    model: null,
    promptHash,
    seed: hash32(promptHash),
    // Fixed rather than "now": a deterministic compile has no wall-clock input,
    // and stamping one would make two identical compiles compare unequal.
    createdAt: '1970-01-01T00:00:00.000Z',
  }
}

/** The shape a model is allowed to return when refining a brief. */
export const BriefRefinementSchema = z.object({
  subject: z.string().min(1).max(160),
  functions: z.array(z.string().min(1).max(120)).max(12),
  style: z.array(z.string().min(1).max(40)).max(8),
  scale: z.enum(['micro', 'minifig', 'midi', 'large', 'unspecified']),
  ambiguities: z.array(z.object({ field: z.string().min(1).max(40), detail: z.string().min(1).max(300) })).max(8),
})

export type BriefRefinement = z.infer<typeof BriefRefinementSchema>

const REFINEMENT_SYSTEM = `You turn a LEGO build request into structured fields. You never invent a requirement the request does not contain.

Rules:
- subject: the thing being built, as a short noun phrase.
- functions: only mechanical or functional requirements the request actually states.
- style: only descriptive words the request actually uses or clearly implies.
- scale: only if the request indicates one; otherwise "unspecified".
- ambiguities: anything the request leaves genuinely undetermined, one entry per unresolved decision. Prefer reporting an ambiguity to guessing.`

export interface BriefRefinementResult {
  brief: DesignBrief
  provenance: Provenance
  usage: { inputTokens: number; outputTokens: number }
}

/**
 * Refines a compiled brief with a model.
 *
 * The deterministic pass wins every field it filled. The model may only add to
 * what was left empty, and anything it says that contradicts a deterministic
 * finding is recorded as a conflict rather than applied — the operator decides,
 * not the model.
 */
export async function refineBriefWithModel(
  text: string,
  brief: DesignBrief,
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<BriefRefinementResult> {
  const result = await provider.complete<BriefRefinement>({
    system: REFINEMENT_SYSTEM,
    prompt: `Request:\n${text}\n\nFields already extracted deterministically (do not contradict them silently; report disagreement as an ambiguity):\n${stableStringify(
      { subject: brief.subject, scale: brief.scale, functions: brief.functions, style: brief.style },
    )}`,
    schema: z.toJSONSchema(BriefRefinementSchema, { io: 'output' }) as Record<string, unknown>,
    parse: (raw) => BriefRefinementSchema.parse(raw),
    maxTokens: 1024,
  })

  const refined = result.value
  const conflicts = [...brief.conflicts]
  const evidence = { ...brief.evidence }

  if (brief.scale !== 'unspecified' && refined.scale !== 'unspecified' && refined.scale !== brief.scale) {
    conflicts.push({
      field: 'scale',
      detail: `The request reads as ${brief.scale} scale; the model read it as ${refined.scale}. Choose one.`,
    })
  }
  for (const ambiguity of refined.ambiguities) {
    if (conflicts.some((conflict) => conflict.field === ambiguity.field && conflict.detail === ambiguity.detail)) continue
    conflicts.push(ambiguity)
  }

  const functions = brief.functions.length ? brief.functions : refined.functions.map((entry) => entry.toLowerCase())
  const style = brief.style.length ? brief.style : refined.style.map((entry) => entry.toLowerCase())
  if (!brief.functions.length && functions.length) evidence.functions = 'inferred by the model from the request'
  if (!brief.style.length && style.length) evidence.style = 'inferred by the model from the request'

  return {
    brief: {
      ...brief,
      // A subject is replaced only when the deterministic pass produced its
      // fallback; a phrase the operator actually wrote is never overwritten.
      subject: brief.subject === 'Unspecified build' ? refined.subject : brief.subject,
      scale: brief.scale === 'unspecified' ? refined.scale : brief.scale,
      functions,
      style,
      evidence,
      conflicts,
    },
    provenance: result.provenance,
    usage: result.usage,
  }
}

export type BriefPatch = Partial<Omit<DesignBrief, 'version' | 'evidence'>>

/**
 * Applies an operator edit.
 *
 * Editing a field records that a person set it, so the brief carries who
 * decided what — a generated value and a corrected one are not the same claim.
 */
export function editBrief(brief: DesignBrief, patch: BriefPatch): DesignBrief {
  const evidence = { ...brief.evidence }
  for (const key of Object.keys(patch) as Array<keyof BriefPatch>) {
    if (patch[key] === undefined) continue
    evidence[key] = 'set by the operator'
  }
  return { ...brief, ...patch, evidence }
}

/** Removes one conflict, recording the decision the operator made. */
export function resolveConflict(brief: DesignBrief, index: number, decision: string): DesignBrief {
  const conflict = brief.conflicts[index]
  if (!conflict) return brief
  return {
    ...brief,
    conflicts: brief.conflicts.filter((_, position) => position !== index),
    evidence: { ...brief.evidence, [`${conflict.field}.decision`]: decision },
  }
}

/** The brief projection sent to the model as standing context. */
export function briefGrounding(brief: DesignBrief) {
  return {
    subject: brief.subject,
    scale: brief.scale,
    envelopeStuds: brief.envelopeStuds,
    functions: brief.functions,
    palette: brief.palette,
    symmetry: brief.symmetry,
    partBudget: brief.partBudget,
    style: brief.style,
    conflicts: brief.conflicts,
  }
}
