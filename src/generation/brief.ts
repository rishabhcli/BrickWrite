import {
  hash32,
  stableStringify,
  type DesignBrief,
  type ModelProvider,
  type Provenance,
} from '../platform/contracts'
import { catalog } from '../cad/catalog'

/**
 * Prose in, an editable structure out.
 *
 * The point of compiling a request into a `DesignBrief` before generating
 * anything is that every assumption becomes a field somebody can see and
 * correct. "A small red spaceship" contains a scale decision, a palette
 * decision and a subject; buried in a prompt they are invisible, and the first
 * time the operator learns the generator read "small" as eight studs is when
 * eight studs of spaceship appear.
 *
 * Two behaviours are non-negotiable here:
 *
 *   - **Evidence.** Every populated field records the phrase that produced it.
 *     A field with no evidence entry was derived, not read, and the UI can say
 *     so.
 *   - **Conflicts are surfaced, never resolved.** "A micro-scale minifigure
 *     cockpit" is a contradiction; picking one silently is how a generator ends
 *     up confidently building the wrong thing.
 *
 * With no model provider configured the compiler still works — rules, not
 * guesses — and the returned provenance says `deterministic` with a null model
 * so a reader is never left to assume a model ran.
 */

export type SubjectArchetype =
  | 'vehicle'
  | 'building'
  | 'furniture'
  | 'creature'
  | 'mechanism'
  | 'sculpture'
  | 'unknown'

const ARCHETYPE_KEYWORDS: Record<Exclude<SubjectArchetype, 'unknown'>, readonly string[]> = {
  vehicle: [
    'car', 'truck', 'lorry', 'van', 'bus', 'train', 'locomotive', 'tram', 'plane', 'aeroplane',
    'airplane', 'jet', 'helicopter', 'boat', 'ship', 'submarine', 'rover', 'buggy', 'tractor',
    'spaceship', 'starship', 'shuttle', 'rocket', 'motorcycle', 'bike', 'racer', 'speeder', 'tank',
    'forklift', 'ambulance', 'firetruck', 'skiff',
  ],
  building: [
    'house', 'home', 'building', 'tower', 'castle', 'cottage', 'shop', 'store', 'cafe', 'station',
    'garage', 'barn', 'church', 'temple', 'lighthouse', 'hut', 'cabin', 'skyscraper', 'facade',
    'warehouse', 'workshop', 'library', 'museum', 'bunker', 'outpost', 'fort', 'windmill',
  ],
  furniture: [
    'chair', 'table', 'desk', 'bed', 'sofa', 'couch', 'bookshelf', 'shelf', 'cabinet', 'dresser',
    'stool', 'bench', 'wardrobe', 'lamp', 'piano', 'workbench', 'counter', 'sideboard',
  ],
  creature: [
    'dragon', 'dog', 'cat', 'bird', 'horse', 'fish', 'dinosaur', 'monster', 'creature', 'animal',
    'robot', 'droid', 'mech', 'golem', 'beast', 'owl', 'frog', 'turtle', 'spider', 'crab', 'whale',
  ],
  mechanism: [
    'crane', 'lift', 'elevator', 'gearbox', 'gear', 'winch', 'catapult', 'trebuchet', 'drawbridge',
    'conveyor', 'press', 'pump', 'clock', 'mechanism', 'linkage', 'turntable', 'hinge', 'ramp',
    'excavator', 'digger', 'piston',
  ],
  sculpture: [
    'sculpture', 'statue', 'mosaic', 'portrait', 'logo', 'sign', 'monument', 'ornament', 'trophy',
    'vase', 'abstract', 'artwork', 'bust', 'obelisk', 'pillar',
  ],
}

export interface SubjectClassification {
  readonly archetype: SubjectArchetype
  /** The word that decided it, for the evidence record. */
  readonly keyword: string | null
  /** Archetypes whose keywords also fired, in match order. */
  readonly alsoMatched: SubjectArchetype[]
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * Which family of thing is being asked for.
 *
 * Shared with the massing phase, which needs it to choose proportions: a
 * building is a shell around a void, a sculpture is a solid, and a vehicle is a
 * chassis with a body on it. Matching on the *first* keyword in reading order
 * rather than on a count is deliberate — "a house for my dog" is a house.
 */
export function classifySubject(text: string): SubjectClassification {
  const tokens = words(text)
  const hits: Array<{ archetype: SubjectArchetype; keyword: string; at: number }> = []
  for (const [archetype, keywords] of Object.entries(ARCHETYPE_KEYWORDS) as Array<
    [Exclude<SubjectArchetype, 'unknown'>, readonly string[]]
  >) {
    for (const keyword of keywords) {
      const at = tokens.indexOf(keyword)
      if (at >= 0) hits.push({ archetype, keyword, at })
    }
  }
  if (!hits.length) return { archetype: 'unknown', keyword: null, alsoMatched: [] }
  hits.sort((a, b) => a.at - b.at || a.archetype.localeCompare(b.archetype))
  const winner = hits[0]
  const others = [...new Set(hits.slice(1).map((hit) => hit.archetype))].filter(
    (archetype) => archetype !== winner.archetype,
  )
  return { archetype: winner.archetype, keyword: winner.keyword, alsoMatched: others }
}

/** Rough proportions per archetype, used only when the request omits a dimension. */
const ARCHETYPE_SHAPE: Record<SubjectArchetype, { readonly width: number; readonly height: number; readonly depth: number }> = {
  vehicle: { width: 14, height: 8, depth: 8 },
  building: { width: 16, height: 14, depth: 12 },
  furniture: { width: 8, height: 8, depth: 6 },
  creature: { width: 10, height: 12, depth: 8 },
  mechanism: { width: 12, height: 10, depth: 10 },
  sculpture: { width: 8, height: 14, depth: 8 },
  unknown: { width: 12, height: 10, depth: 10 },
}

const SCALE_WORDS: Array<{ readonly scale: DesignBrief['scale']; readonly pattern: RegExp; readonly factor: number }> = [
  { scale: 'micro', pattern: /\b(micro|microscale|micro-scale|tiny|miniature)\b/i, factor: 0.45 },
  { scale: 'minifig', pattern: /\b(minifig|minifigure|minifig-scale|playset)\b/i, factor: 1 },
  { scale: 'midi', pattern: /\b(midi|midi-scale|desk|display)\b/i, factor: 1.5 },
  { scale: 'large', pattern: /\b(large|big|huge|giant|oversized|life-?size)\b/i, factor: 2.2 },
]

const SYMMETRY_WORDS: Array<{ readonly symmetry: DesignBrief['symmetry']; readonly pattern: RegExp }> = [
  { symmetry: 'radial', pattern: /\b(radial|radially symmetric|rotationally symmetric)\b/i },
  { symmetry: 'mirror-z', pattern: /\b(front[- ]to[- ]back symmetr\w*|mirrored front to back)\b/i },
  { symmetry: 'mirror-x', pattern: /\b(symmetric\w*|symmetry|mirrored|left[- ]right)\b/i },
]

const STYLE_WORDS = [
  'sleek', 'chunky', 'blocky', 'retro', 'modern', 'medieval', 'futuristic', 'rustic', 'minimal',
  'minimalist', 'ornate', 'industrial', 'cartoon', 'cartoonish', 'realistic', 'brutalist',
  'art deco', 'victorian', 'steampunk', 'cyberpunk', 'nautical', 'military', 'weathered', 'clean',
  'streamlined', 'boxy', 'angular', 'rounded', 'greebled', 'detailed', 'smooth', 'utilitarian',
  'abstract', 'geometric', 'organic', 'ornamental', 'sculptural', 'classical', 'stylised', 'stylized',
] as const

const FUNCTION_PATTERNS: Array<{ readonly pattern: RegExp; readonly describe: (match: RegExpMatchArray) => string }> = [
  { pattern: /\b([a-z][a-z ]{0,20}?)\s+that\s+(turn|spin|rotate|open|close|lift|slide|fold|swing|move|steer)s?\b/i, describe: (m) => `${m[1].trim()} ${m[2].toLowerCase()}s` },
  { pattern: /\b(working|moving|opening|rotating|sliding|folding|articulated|hinged|steerable|posable)\s+([a-z][a-z ]{0,20}?)\b(?=[.,;]|\s+(?:and|with|that|for|in|on)\b|$)/i, describe: (m) => `${m[1].toLowerCase()} ${m[2].trim()}` },
  { pattern: /\b(roof|lid|canopy|hatch|top)\s+(?:that\s+)?(lifts?\s+off|comes?\s+off|removable)\b/i, describe: (m) => `${m[1].toLowerCase()} lifts off` },
  { pattern: /\b(doors?|shutters?|gates?|windows?)\s+(?:that\s+)?(open|swing)s?\b/i, describe: (m) => `${m[1].toLowerCase()} open` },
  { pattern: /\b(wheels?|axles?|turntables?|rotors?)\s+(?:that\s+)?(turn|spin|rotate)s?\b/i, describe: (m) => `${m[1].toLowerCase()} turn` },
]

const BUDGET_PATTERNS: RegExp[] = [
  /\b(?:under|below|fewer than|less than|no more than|at most|max(?:imum)?(?: of)?|budget of|within)\s+(\d{1,5})\s*(?:pieces|parts|bricks|elements)\b/i,
  /\b(\d{1,5})[\s-]*(?:piece|part|brick|element)s?\s*(?:budget|limit|max(?:imum)?)\b/i,
  /\b(?:pieces|parts|bricks)\s*(?:limit|budget)\s*(?:of|:)?\s*(\d{1,5})\b/i,
]

const DIMENSION_TRIPLE = /(\d{1,3})\s*(?:x|×|by)\s*(\d{1,3})\s*(?:x|×|by)\s*(\d{1,3})\s*studs?/i
const DIMENSION_PAIR = /(\d{1,3})\s*(?:x|×|by)\s*(\d{1,3})\s*studs?/i
const HEIGHT_PHRASE = /(\d{1,3})\s*(?:studs?|plates?|bricks?)\s*(?:tall|high|in height)/i
const LENGTH_PHRASE = /(\d{1,3})\s*studs?\s*(?:long|in length|wide|across)/i

/** Normalised colour-name index, longest name first so "dark red" beats "red". */
function colourIndex(): Array<{ readonly code: number; readonly key: string }> {
  const entries: Array<{ code: number; key: string }> = []
  for (const colour of catalog.colors()) {
    // 16 and 24 are LDraw's "inherit" meta-colours. Putting either in a palette
    // would tell the kernel to take the colour from a parent that does not exist.
    if (colour.code === 16 || colour.code === 24) continue
    entries.push({ code: colour.code, key: normaliseColourName(colour.name) })
  }
  return entries.sort((a, b) => b.key.length - a.key.length || a.code - b.code)
}

const normaliseColourName = (name: string) => name.toLowerCase().replace(/gray/g, 'grey').replace(/[^a-z]+/g, ' ').trim()

export interface ColourMatch {
  readonly code: number
  readonly name: string
  readonly phrase: string
}

/**
 * Colour words in a request, resolved against the compiled LDraw table.
 *
 * Matching against the real table rather than a hand-written list is what keeps
 * this from inventing colours: if the build's colour table has no "sand teal",
 * the phrase simply does not resolve and the brief says the palette is empty
 * rather than carrying a code nothing can render.
 */
export function matchColours(text: string): ColourMatch[] {
  const haystack = ` ${normaliseColourName(text)} `
  const found: ColourMatch[] = []
  const consumed: Array<[number, number]> = []
  for (const entry of colourIndex()) {
    if (!entry.key) continue
    const at = haystack.indexOf(` ${entry.key} `)
    if (at < 0) continue
    const span: [number, number] = [at, at + entry.key.length + 2]
    // A longer name already claimed these characters — "dark bluish grey" must
    // not also register as "grey".
    if (consumed.some(([from, to]) => span[0] < to && from < span[1])) continue
    consumed.push(span)
    found.push({ code: entry.code, name: catalog.color(entry.code).name, phrase: entry.key })
  }
  return found.sort((a, b) => a.code - b.code)
}

export interface DesignBriefResult {
  readonly brief: DesignBrief
  /** `deterministic` with a null model when no provider was configured. */
  readonly provenance: Provenance
  readonly method: 'model' | 'deterministic'
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
  /** Anything the compiler had to do to the model's answer to make it usable. */
  readonly notes: string[]
}

export interface CompileBriefOptions {
  /** Omit to compile deterministically. Supplied, it is used and reported. */
  readonly provider?: ModelProvider
  readonly seed?: number
  readonly signal?: AbortSignal
  /** Folded into the prompt hash so a compiler change invalidates a cached brief. */
  readonly version?: string
}

export const BRIEF_COMPILER_VERSION = 'brief/1'

/**
 * The wire schema for a brief.
 *
 * Constrained to the subset the structured-output endpoint accepts: no array
 * length bounds, no numeric ranges, and no open-ended `additionalProperties`
 * map. Two shapes here follow from that and are worth reading as intent rather
 * than as workaround — the envelope travels as three nullable scalars because a
 * three-element array cannot be pinned to three elements on the wire, and
 * evidence travels as a list of `{field, phrase}` pairs because a free-keyed
 * object cannot be typed at all. Both are folded back into the `DesignBrief`
 * contract on arrival.
 */
export const DESIGN_BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'subject',
    'envelopeWidthStuds',
    'envelopeHeightStuds',
    'envelopeDepthStuds',
    'scale',
    'functions',
    'paletteColourNames',
    'symmetry',
    'partBudget',
    'style',
    'evidence',
    'conflicts',
  ],
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 120 },
    envelopeWidthStuds: { type: ['integer', 'null'] },
    envelopeHeightStuds: { type: ['integer', 'null'] },
    envelopeDepthStuds: { type: ['integer', 'null'] },
    scale: { type: 'string', enum: ['micro', 'minifig', 'midi', 'large', 'unspecified'] },
    functions: { type: 'array', items: { type: 'string', maxLength: 120 } },
    paletteColourNames: { type: 'array', items: { type: 'string', maxLength: 40 } },
    symmetry: { type: 'string', enum: ['none', 'mirror-x', 'mirror-z', 'radial'] },
    partBudget: { type: ['integer', 'null'] },
    style: { type: 'array', items: { type: 'string', maxLength: 40 } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'phrase'],
        properties: { field: { type: 'string', maxLength: 60 }, phrase: { type: 'string', maxLength: 200 } },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'detail'],
        properties: { field: { type: 'string', maxLength: 40 }, detail: { type: 'string', maxLength: 240 } },
      },
    },
  },
} as const

const BRIEF_SYSTEM = [
  'You compile a natural-language LEGO build request into a structured design brief.',
  'Report only what the request supports. Leave a field null or empty when the request does not state it;',
  'do not fill a gap with a plausible default.',
  'For every field you populate, add an `evidence` entry naming the field and quoting the exact phrase',
  'from the request that produced it.',
  'If the request contradicts itself, record both readings in `conflicts` and do not choose between them.',
  'Colours are named in plain English; they are resolved against the LDraw colour table afterwards.',
  'The envelope is measured in studs, one stud being the horizontal brick pitch; leave all three axes null',
  'when the request states no size.',
].join(' ')

interface RawBrief {
  subject: string
  envelopeStuds: [number, number, number] | null
  scale: DesignBrief['scale']
  functions: string[]
  paletteColourNames: string[]
  symmetry: DesignBrief['symmetry']
  partBudget: number | null
  style: string[]
  evidence: Record<string, string>
  conflicts: Array<{ field: string; detail: string }>
}

/** Structural parse of the model's answer. A violation here is a hard failure. */
function parseRawBrief(raw: unknown): RawBrief {
  if (!raw || typeof raw !== 'object') throw new Error('The brief response was not a JSON object.')
  const value = raw as Record<string, unknown>
  const asStringArray = (input: unknown, field: string): string[] => {
    if (!Array.isArray(input)) throw new Error(`Field "${field}" was not an array of strings.`)
    return input.map((entry) => {
      if (typeof entry !== 'string') throw new Error(`Field "${field}" contained a non-string entry.`)
      return entry
    })
  }
  const subject = value.subject
  if (typeof subject !== 'string' || !subject.trim()) throw new Error('Field "subject" was missing or empty.')

  // Three nullable scalars on the wire; a triple or nothing on this side. A
  // partially-stated envelope is not an envelope — two axes out of three cannot
  // bound anything — so it is reported as absent rather than half-applied.
  const axis = (key: string): number | null => {
    const raw = value[key]
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw new Error(`Field "${key}" was neither null nor a positive number.`)
    }
    return raw
  }
  const width = axis('envelopeWidthStuds')
  const height = axis('envelopeHeightStuds')
  const depth = axis('envelopeDepthStuds')
  const envelopeStuds: [number, number, number] | null =
    width !== null && height !== null && depth !== null ? [width, height, depth] : null

  const scale = value.scale
  if (!['micro', 'minifig', 'midi', 'large', 'unspecified'].includes(String(scale))) {
    throw new Error(`Field "scale" held an unknown value ${JSON.stringify(scale)}.`)
  }
  const symmetry = value.symmetry
  if (!['none', 'mirror-x', 'mirror-z', 'radial'].includes(String(symmetry))) {
    throw new Error(`Field "symmetry" held an unknown value ${JSON.stringify(symmetry)}.`)
  }
  const partBudget = value.partBudget
  if (partBudget !== null && partBudget !== undefined && (typeof partBudget !== 'number' || !Number.isInteger(partBudget) || partBudget < 1)) {
    throw new Error('Field "partBudget" was neither null nor a positive integer.')
  }

  const evidence = value.evidence
  if (!Array.isArray(evidence)) throw new Error('Field "evidence" was not an array of {field, phrase} entries.')
  const evidenceRecord: Record<string, string> = {}
  for (const entry of evidence) {
    const item = entry as Record<string, unknown>
    if (!item || typeof item.field !== 'string' || typeof item.phrase !== 'string') {
      throw new Error('An evidence entry was missing "field" or "phrase".')
    }
    evidenceRecord[item.field] = item.phrase
  }

  const conflictsRaw = value.conflicts
  if (!Array.isArray(conflictsRaw)) throw new Error('Field "conflicts" was not an array.')
  const conflicts = conflictsRaw.map((entry) => {
    const item = entry as Record<string, unknown>
    if (!item || typeof item.field !== 'string' || typeof item.detail !== 'string') {
      throw new Error('A conflict entry was missing "field" or "detail".')
    }
    return { field: item.field, detail: item.detail }
  })

  return {
    subject: subject.trim(),
    envelopeStuds,
    scale: scale as DesignBrief['scale'],
    functions: asStringArray(value.functions ?? [], 'functions'),
    paletteColourNames: asStringArray(value.paletteColourNames ?? [], 'paletteColourNames'),
    symmetry: symmetry as DesignBrief['symmetry'],
    partBudget: (partBudget as number | null | undefined) ?? null,
    style: asStringArray(value.style ?? [], 'style'),
    evidence: evidenceRecord,
    conflicts,
  }
}

const promptHashFor = (text: string, version: string) =>
  hash32(stableStringify({ text, version, schema: DESIGN_BRIEF_SCHEMA })).toString(16).padStart(8, '0')

/**
 * Compiles a request.
 *
 * Returns the provenance alongside the brief rather than the brief alone,
 * because "did a model produce this?" is not answerable from a `DesignBrief` —
 * the contract has nowhere to carry it — and a caller that cannot tell the two
 * apart will present a rule-based reading as a model's judgement.
 */
export async function compileBrief(text: string, options: CompileBriefOptions = {}): Promise<DesignBriefResult> {
  const version = options.version ?? BRIEF_COMPILER_VERSION
  const seed = options.seed ?? 0
  const promptHash = promptHashFor(text, version)
  const createdAt = new Date(0).toISOString()

  if (!options.provider) {
    return {
      brief: compileBriefDeterministically(text),
      provenance: { provider: 'deterministic', model: null, promptHash, seed, createdAt },
      method: 'deterministic',
      usage: null,
      notes: ['No model provider was configured, so the brief was compiled from rules rather than by a model.'],
    }
  }

  const result = await options.provider.complete<RawBrief>({
    system: BRIEF_SYSTEM,
    prompt: `Request:\n${text}`,
    schema: DESIGN_BRIEF_SCHEMA,
    parse: parseRawBrief,
    ...(options.signal ? { signal: options.signal } : {}),
    maxTokens: 2000,
    temperature: 0,
  })

  const notes: string[] = []
  const palette: number[] = []
  const evidence = { ...result.value.evidence }
  for (const name of result.value.paletteColourNames) {
    const matches = matchColours(name)
    if (!matches.length) {
      notes.push(`The model named colour “${name}”, which is not in LDraw colour table ${catalog.version}; it was dropped.`)
      continue
    }
    palette.push(matches[0].code)
    evidence[`palette.${matches[0].code}`] = name
  }

  const brief: DesignBrief = {
    version: 1,
    subject: result.value.subject,
    envelopeStuds: result.value.envelopeStuds,
    scale: result.value.scale,
    functions: result.value.functions,
    palette: [...new Set(palette)].sort((a, b) => a - b),
    symmetry: result.value.symmetry,
    partBudget: result.value.partBudget,
    protectedPartIds: [],
    style: result.value.style,
    evidence,
    conflicts: result.value.conflicts,
  }

  return { brief, provenance: result.provenance, method: 'model', usage: result.usage, notes }
}

/** The brief alone, for a caller that has already recorded how it was produced. */
export const briefOnly = async (text: string, options: CompileBriefOptions = {}): Promise<DesignBrief> =>
  (await compileBrief(text, options)).brief

/**
 * The rule-based compiler.
 *
 * This is what runs when no key is configured, and it is a real compiler rather
 * than a stub: it reads dimensions, budgets, colours, functions, symmetry and
 * scale out of the text, records the phrase behind each, and reports the
 * contradictions it finds. What it cannot do is understand a request that says
 * none of those things in so many words, and the empty fields say exactly that.
 */
export function compileBriefDeterministically(text: string): DesignBrief {
  const evidence: Record<string, string> = {}
  const conflicts: DesignBrief['conflicts'] = []
  const source = text.trim()
  const classification = classifySubject(source)

  // -- subject -------------------------------------------------------------
  const subject = deriveSubject(source)
  evidence.subject = subject.phrase
  if (classification.keyword) evidence.archetype = classification.keyword
  if (classification.alsoMatched.length) {
    conflicts.push({
      field: 'subject',
      detail: `The request reads as a ${classification.archetype} but also names ${classification.alsoMatched.join(' and ')} subjects; the massing follows ${classification.archetype}.`,
    })
  }

  // -- scale ---------------------------------------------------------------
  const scaleHits = SCALE_WORDS.filter((entry) => entry.pattern.test(source))
  const scale: DesignBrief['scale'] = scaleHits.length ? scaleHits[0].scale : 'unspecified'
  if (scaleHits.length) evidence.scale = (source.match(scaleHits[0].pattern) ?? [''])[0]
  if (scaleHits.length > 1) {
    conflicts.push({
      field: 'scale',
      detail: `The request asks for both “${(source.match(scaleHits[0].pattern) ?? [''])[0]}” and “${(source.match(scaleHits[1].pattern) ?? [''])[0]}”; ${scaleHits[0].scale} was recorded and the other left unresolved.`,
    })
  }
  const factor = scaleHits.length ? scaleHits[0].factor : 1

  // -- envelope ------------------------------------------------------------
  const shape = ARCHETYPE_SHAPE[classification.archetype]
  let envelopeStuds: [number, number, number] | null = null
  const triple = source.match(DIMENSION_TRIPLE)
  const pair = source.match(DIMENSION_PAIR)
  const heightPhrase = source.match(HEIGHT_PHRASE)
  const lengthPhrase = source.match(LENGTH_PHRASE)

  if (triple) {
    // Written the way a builder writes it: width by depth by height.
    envelopeStuds = [Number(triple[1]), Number(triple[3]), Number(triple[2])]
    evidence.envelopeStuds = triple[0]
  } else if (pair) {
    const height = heightPhrase ? Number(heightPhrase[1]) : Math.round((Number(pair[1]) + Number(pair[2])) / 2)
    envelopeStuds = [Number(pair[1]), height, Number(pair[2])]
    evidence.envelopeStuds = heightPhrase ? `${pair[0]}, ${heightPhrase[0]}` : pair[0]
    if (!heightPhrase) {
      conflicts.push({
        field: 'envelopeStuds',
        detail: `The request gives a ${pair[1]} × ${pair[2]} stud footprint but no height; ${height} studs was derived from the footprint and should be confirmed.`,
      })
    }
  } else if (lengthPhrase || heightPhrase) {
    const length = lengthPhrase ? Number(lengthPhrase[1]) : Math.round(shape.width * factor)
    const height = heightPhrase ? Number(heightPhrase[1]) : Math.round(shape.height * factor)
    const depth = Math.max(2, Math.round((length * shape.depth) / shape.width))
    envelopeStuds = [length, height, depth]
    evidence.envelopeStuds = [lengthPhrase?.[0], heightPhrase?.[0]].filter(Boolean).join(', ')
    conflicts.push({
      field: 'envelopeStuds',
      detail: `Only one dimension was stated; the remaining axes were scaled from typical ${classification.archetype} proportions and should be confirmed.`,
    })
  } else if (scaleHits.length) {
    envelopeStuds = [
      Math.max(2, Math.round(shape.width * factor)),
      Math.max(2, Math.round(shape.height * factor)),
      Math.max(2, Math.round(shape.depth * factor)),
    ]
    evidence.envelopeStuds = `derived from “${(source.match(scaleHits[0].pattern) ?? [''])[0]}”`
  }

  // -- palette -------------------------------------------------------------
  const colours = matchColours(source)
  for (const colour of colours) evidence[`palette.${colour.code}`] = colour.phrase
  if (/\bany colour\b|\bany color\b|\bmulticoloured\b|\bmulticolored\b/i.test(source) && colours.length) {
    conflicts.push({
      field: 'palette',
      detail: `The request names ${colours.map((colour) => colour.name).join(', ')} and also asks for any colour; both readings are recorded.`,
    })
  }

  // -- symmetry ------------------------------------------------------------
  const symmetryHit = SYMMETRY_WORDS.find((entry) => entry.pattern.test(source))
  const symmetry: DesignBrief['symmetry'] = symmetryHit ? symmetryHit.symmetry : 'none'
  if (symmetryHit) evidence.symmetry = (source.match(symmetryHit.pattern) ?? [''])[0]

  // -- budget --------------------------------------------------------------
  let partBudget: number | null = null
  for (const pattern of BUDGET_PATTERNS) {
    const match = source.match(pattern)
    if (!match) continue
    partBudget = Number(match[1])
    evidence.partBudget = match[0]
    break
  }

  // -- functions -----------------------------------------------------------
  const functions: string[] = []
  for (const entry of FUNCTION_PATTERNS) {
    const match = source.match(entry.pattern)
    if (!match) continue
    const described = entry.describe(match).replace(/\s+/g, ' ').trim()
    if (described && !functions.includes(described)) {
      functions.push(described)
      evidence[`function.${described}`] = match[0].trim()
    }
  }

  // -- style ---------------------------------------------------------------
  const lower = source.toLowerCase()
  const style = STYLE_WORDS.filter((word) => lower.includes(word))
  for (const word of style) evidence[`style.${word}`] = word

  // -- cross-field conflicts -----------------------------------------------
  if (envelopeStuds && partBudget) {
    // A floor alone needs this many parts; the pack's largest plate is 8 × 4.
    const deckParts = Math.ceil((envelopeStuds[0] * envelopeStuds[2]) / 32)
    if (deckParts > partBudget) {
      conflicts.push({
        field: 'partBudget',
        detail: `A ${envelopeStuds[0]} × ${envelopeStuds[2]} stud footprint needs at least ${deckParts} parts for a single deck, which is already over the ${partBudget}-part budget.`,
      })
    }
  }

  return {
    version: 1,
    subject: subject.text,
    envelopeStuds,
    scale,
    functions,
    palette: colours.map((colour) => colour.code),
    symmetry,
    partBudget,
    protectedPartIds: [],
    style: [...style],
    evidence,
    conflicts,
  }
}

/** The noun phrase the request is about, and the words it was read from. */
function deriveSubject(text: string): { readonly text: string; readonly phrase: string } {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  // The first clause is almost always the subject; everything after a comma or
  // "with"/"that" is a qualifier, and folding those in makes the subject line
  // unreadable in the UI.
  const clause = cleaned.split(/[,.;]|\bwith\b|\bthat\b|\bunder\b|\bin no more than\b/i)[0].trim()
  const stripped = clause.replace(/^(?:build|make|design|create|generate|model)\s+(?:me\s+)?(?:an?\s+|the\s+)?/i, '').trim()
  const subject = (stripped || clause || cleaned).slice(0, 120)
  return { text: subject, phrase: clause.slice(0, 200) || cleaned.slice(0, 200) }
}

/** Merges operator edits into a compiled brief, keeping the evidence trail. */
export function amendBrief(brief: DesignBrief, patch: Partial<DesignBrief>, reason: string): DesignBrief {
  const evidence = { ...brief.evidence }
  for (const key of Object.keys(patch)) evidence[key] = `operator edit: ${reason}`
  return { ...brief, ...patch, evidence }
}
