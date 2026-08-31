import { catalog } from '../../cad/catalog'
import { identityTokens, type CorpusDocument, type PartCorpus } from './corpus'

/**
 * BM25F over the catalog's own words, plus an exact-identifier short circuit.
 *
 * Plain term-frequency ranking is wrong here for a specific reason: LDraw names
 * repeat their own vocabulary relentlessly ("Brick Round 1 x 1 D. Tube with 45
 * Degree Elbow and Axle Holes (Crossholes) at Each End"), so a longer name
 * accumulates matches without becoming a better answer. BM25's length
 * normalisation and saturating term frequency are what stop a 20-word printed
 * variant from outranking the part it decorates.
 *
 * Fields are weighted rather than concatenated, because the same word means
 * different things in different places: "hinge" in a name is what the part is,
 * "Hinges, Arms and Turntables" in a category is only where it is filed.
 */

/** Saturation point. 1.2 is the standard value and the catalog gives no reason to move it. */
const K1 = 1.2
/** Length normalisation strength, per field. 0.75 is again the standard value. */
const B = 0.75

/**
 * What a prefix expansion is worth relative to a real hit.
 *
 * "connects" landing on "connector" is a plausible reading of the request, not
 * a confirmed one, so it contributes but cannot outrank a document that used
 * the word the person actually typed. The discount alone did not deliver that -
 * a rare continuation carried a far larger IDF and won anyway - so it is paired
 * with the ceiling in `readings`.
 */
const PREFIX_DISCOUNT = 0.65

/**
 * How many longer forms one query term may reach.
 *
 * LDraw spells the same idea three ways across its history - "Slope Brick 45",
 * "Brick Sloped 45", "Sloping" - so a term has to reach more than one
 * continuation or half the library stays invisible to the word people type.
 */
const PREFIX_EXPANSIONS = 3

/**
 * Endings that make a longer word the same word.
 *
 * `foldTerm` handles the plural at index time because that is the inflection the
 * catalog is full of. The rest have to be handled here, at query time, because
 * they are not a spelling difference between two documents but between the
 * catalog and the person: LDraw files "Slope Brick 45 3 x 1" and "Brick Sloped
 * 45° 2 x 2" side by side, and somebody typing "slope" is asking for both.
 *
 * So an inflection is not discounted. Only its rarity is capped, because
 * "Wheeler" also ends in one of these and is a different object entirely.
 */
const INFLECTION_SUFFIXES = new Set(['s', 'es', 'd', 'ed', 'ing'])

const isInflection = (stem: string, longer: string) => INFLECTION_SUFFIXES.has(longer.slice(stem.length))

/**
 * What a colloquial reading is worth.
 *
 * Just under a literal hit: mapping "roof" onto "sloped" is a confident reading
 * of the request, but if the catalog happens to use the word the person typed
 * for the thing they meant, that word still wins.
 */
const COLLOQUIAL_WEIGHT = 0.9

/**
 * What a spelling correction is worth.
 *
 * Below a prefix expansion, and deliberately: "windo" is a word somebody
 * stopped typing, where "brik" is a word they got wrong, and the second is the
 * larger leap. It is still enormously better than nothing - it is the
 * difference between "brik" answering with Brick 2 x 4 and answering with
 * whatever the character trigrams happened to like.
 */
const TYPO_WEIGHT = 0.55

/**
 * Shortest word worth trying to correct.
 *
 * Below four characters an edit-distance-one neighbourhood is most of the
 * dictionary - "bit" reaches bid, big, bin, bat, but, fit, kit, lit, pit and
 * sit - so a correction there would be a guess dressed as a reading.
 */
const TYPO_MIN_LENGTH = 4

/**
 * How much of the catalog a correction target has to be used by.
 *
 * A misspelling should land on a word the library actually leans on, not on the
 * nearest freak. Eight parts is low enough to keep the words people reach for -
 * "antenna" is used by 18 - and high enough to refuse "wheelchair", which one
 * part uses and which is one edit from several plausible mistypings.
 *
 * It is also most of what makes the correction cheap: of 38,166 vocabulary
 * entries only about 1,500 clear the floor, so the neighbourhood scanned for an
 * unrecognised word is a twenty-fifth of the index.
 */
const TYPO_MIN_DOCUMENTS = 8

/**
 * A word that means something, and the catalog words it means.
 *
 * This table is the whole reason a seven-year-old can use the search box. LDraw
 * names parts the way a parts librarian would - "Brick Sloped 45° 2 x 2",
 * "Tile 1 x 2", "Hose, Flexible 8.5L" - and a child types "roof bit", "flat
 * piece", "bendy". Neither vocabulary is wrong; they simply do not overlap, and
 * without a bridge the beginner's word either finds nothing or finds the one
 * obscure corner of the library that happens to use it literally.
 *
 * `literal` is how much of the catalog's *own* use of the typed word survives,
 * and every value below is set from a measured count rather than a feeling:
 *
 * - "roof" appears in 73 names, all of them Fabuland roof supports, a train
 *   battery cover and a vehicle-roof hinge. None is the sloped brick anybody
 *   under ten means, so the literal reading keeps a quarter of its weight and
 *   the 390 sloped bricks answer the question.
 * - "block" appears in 57, and a block really is a brick in ordinary English,
 *   so the literal reading keeps all of it and "brick" is simply added.
 * - "bendy", "curvy", "cog", "aerial", "pointy" and "dude" appear in *no*
 *   catalog name at all. Before this table they were dead words.
 *
 * Vague size words are deliberately absent. "big" is not a synonym for LDraw's
 * "Large", which it uses for Bionicle limbs and wheel diameters; it is a size
 * claim with nothing in this build to check it against, so `query.ts` reports it
 * as a condition unmet rather than pretending to answer it.
 *
 * Nothing here is a filter and nothing here is dropped: a colloquial reading is
 * one more reading of the same term, `parseQuery` records it, and the
 * explanation says which word the answer was actually found by.
 */
interface ColloquialReading {
  /** Catalog words this term is read as. */
  reads: readonly string[]
  /** 0..1 weight retained by the catalog's own use of the typed word. */
  literal: number
}

const COLLOQUIAL: Readonly<Record<string, ColloquialReading>> = {
  // Shape words a beginner reaches for, where LDraw uses the word as a
  // modifier ("Flat Front", "Roof Support") and never as the thing itself.
  roof: { reads: ['sloped', 'slope'], literal: 0.25 },
  ramp: { reads: ['sloped', 'slope'], literal: 0.3 },
  flat: { reads: ['plate', 'tile'], literal: 0.3 },
  smooth: { reads: ['tile'], literal: 0.5 },
  circle: { reads: ['round'], literal: 0.5 },
  triangle: { reads: ['wedge'], literal: 0.4 },
  triangular: { reads: ['wedge'], literal: 0.6 },

  // Words the catalog has never used, so the literal weight is moot.
  bendy: { reads: ['flexible', 'hose'], literal: 1 },
  curvy: { reads: ['curved'], literal: 1 },
  cog: { reads: ['gear'], literal: 1 },
  aerial: { reads: ['antenna'], literal: 1 },
  pointy: { reads: ['cone'], literal: 1 },
  dude: { reads: ['minifig'], literal: 1 },

  // Alternative spellings and everyday synonyms. Both readings are real, so
  // the literal one keeps its full weight unless the catalog's use is a
  // different object entirely.
  tire: { reads: ['tyre'], literal: 0.5 },
  windshield: { reads: ['windscreen'], literal: 1 },
  block: { reads: ['brick'], literal: 1 },
  disk: { reads: ['disc'], literal: 1 },
  rope: { reads: ['string'], literal: 0.7 },
  pipe: { reads: ['tube', 'hose'], literal: 0.6 },
  wall: { reads: ['panel'], literal: 0.8 },
  guy: { reads: ['minifig'], literal: 1 },
  person: { reads: ['minifig'], literal: 1 },
  people: { reads: ['minifig'], literal: 1 },
  man: { reads: ['minifig'], literal: 0.5 },

  // A stick, a rod and a pole are all a Bar in this library. LDraw's own use of
  // each is a specific unrelated object - a control stick, a pneumatic rod, a
  // train pole reverser - which is why the literal reading is more than halved
  // rather than kept.
  stick: { reads: ['bar'], literal: 0.6 },
  rod: { reads: ['bar'], literal: 0.6 },
  pole: { reads: ['bar'], literal: 0.5 },
}

/**
 * Field weights.
 *
 * `ids` sits close to `name` because a number typed into a part search is
 * almost never a coincidence, and `kind` is nearly free — it only distinguishes
 * "Part" from "Shortcut" — so it is present for completeness rather than reach.
 */
const FIELD_WEIGHTS = { name: 3, ids: 2.5, category: 1.2, kind: 0.4 } as const
type FieldName = keyof typeof FIELD_WEIGHTS
const FIELDS = Object.keys(FIELD_WEIGHTS) as FieldName[]

export type IdentityKind =
  | 'canonical'
  | 'ldraw'
  | 'retired'
  | 'rebrickable'
  | 'design'
  | 'element'
  | 'bricklink'

export interface IdentityHit {
  id: string
  kind: IdentityKind
}

export interface LexicalHit {
  /** Index into `corpus.documents`. */
  doc: number
  score: number
}

export interface LexicalResult {
  hits: LexicalHit[]
  /**
   * Every document any query term touched, ranked or not.
   *
   * Other retrieval stages use it as a relevance floor: a size on its own is a
   * filter on the answer, not a source of answers, so a part that matches the
   * requested footprint but none of the requested words has no business being
   * scored as a candidate.
   */
  touched: Set<number>
}

/**
 * Light plural folding.
 *
 * A stemmer proper would need a dictionary; the only inflection that actually
 * appears in this vocabulary is the plural, and "clips" failing to reach "Clip"
 * is the single most common way a natural-language part search goes wrong.
 * "Glass", "bus" and "axis" are excluded because stripping their final s
 * produces a different word.
 */
export function foldTerm(term: string): string {
  if (term.length <= 3 || !term.endsWith('s')) return term
  if (/(ss|us|is|as)$/.test(term)) return term
  return term.slice(0, -1)
}

export function lexicalTokens(text: string): string[] {
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw) tokens.push(raw)
  }
  return tokens
}

interface Posting {
  docs: Int32Array
  /** Field-weighted, length-normalised term frequency, precomputed at build. */
  weights: Float32Array
  idf: number
}

/** Priority order for identifier collisions: a canonical number always wins. */
const IDENTITY_PRIORITY: Record<IdentityKind, number> = {
  canonical: 0,
  ldraw: 1,
  retired: 2,
  rebrickable: 3,
  design: 4,
  element: 5,
  bricklink: 6,
}

interface IdentityEntry {
  id: string
  kind: IdentityKind
  frequency: number
}

/** One way of reading a query term, and what that reading is worth. */
interface Reading {
  posting: Posting
  /** Discount for how much of a guess this reading is. */
  weight: number
  /** The reading's inverse document frequency, after any ceiling is applied. */
  idf: number
}

/** A vocabulary entry a misspelling could have meant, with how used it is. */
interface CorrectionCandidate {
  term: string
  documents: number
}

export class LexicalIndex {
  /** Vocabulary in lexicographic order, so a prefix range is a binary search. */
  private readonly sortedTerms: string[]

  /** Vocabulary bucketed by length, for the correction neighbourhood. Built on demand. */
  private byLength: Map<number, CorrectionCandidate[]> | null = null

  /**
   * Corrections already worked out, misses included.
   *
   * A part picker asks the same question on every keystroke and a person types
   * the same wrong word every time they reach for that part, so the cache hit
   * rate here is close to one and the miss is the only cost anybody pays.
   */
  private readonly corrections = new Map<string, string | null>()

  private constructor(
    readonly corpus: PartCorpus,
    private readonly postings: Map<string, Posting>,
    private readonly identities: Map<string, IdentityEntry>,
  ) {
    this.sortedTerms = [...postings.keys()].sort()
  }

  static build(corpus: PartCorpus): LexicalIndex {
    const documents = corpus.documents
    const count = documents.length
    const fieldLengths: Record<FieldName, Float64Array> = {
      name: new Float64Array(count),
      ids: new Float64Array(count),
      category: new Float64Array(count),
      kind: new Float64Array(count),
    }
    const fieldTokens: Array<Record<FieldName, string[]>> = new Array(count)

    for (let index = 0; index < count; index += 1) {
      const document = documents[index]
      const tokens: Record<FieldName, string[]> = {
        name: lexicalTokens(document.name).map(foldTerm),
        // Identifiers are never folded: "3023b" and "3023" are different parts.
        ids: [document.id, ...identityTokens(document.identity)].flatMap((id) => lexicalTokens(id)),
        category: lexicalTokens(document.category).map(foldTerm),
        kind: document.kind ? lexicalTokens(document.kind).map(foldTerm) : [],
      }
      fieldTokens[index] = tokens
      for (const field of FIELDS) fieldLengths[field][index] = tokens[field].length
    }

    const averageLength: Record<FieldName, number> = { name: 0, ids: 0, category: 0, kind: 0 }
    for (const field of FIELDS) {
      let total = 0
      for (let index = 0; index < count; index += 1) total += fieldLengths[field][index]
      // A field that is empty across the whole corpus must not divide by zero;
      // its normalisation factor collapses to 1, which is the correct no-op.
      averageLength[field] = count > 0 && total > 0 ? total / count : 1
    }

    const accumulator = new Map<string, Array<{ doc: number; weight: number }>>()
    for (let index = 0; index < count; index += 1) {
      const perTerm = new Map<string, number>()
      for (const field of FIELDS) {
        const tokens = fieldTokens[index][field]
        if (!tokens.length) continue
        const normalisation = 1 - B + (B * tokens.length) / averageLength[field]
        const contribution = FIELD_WEIGHTS[field] / normalisation
        for (const token of tokens) perTerm.set(token, (perTerm.get(token) ?? 0) + contribution)
      }
      for (const [term, weight] of perTerm) {
        const bucket = accumulator.get(term)
        if (bucket) bucket.push({ doc: index, weight })
        else accumulator.set(term, [{ doc: index, weight }])
      }
    }

    const postings = new Map<string, Posting>()
    for (const [term, entries] of accumulator) {
      const docs = new Int32Array(entries.length)
      const weights = new Float32Array(entries.length)
      for (let i = 0; i < entries.length; i += 1) {
        docs[i] = entries[i].doc
        weights[i] = entries[i].weight
      }
      postings.set(term, {
        docs,
        weights,
        // BM25's IDF, in the form that stays positive for a term in every
        // document rather than going negative and inverting the ranking.
        idf: Math.log(1 + (count - entries.length + 0.5) / (entries.length + 0.5)),
      })
    }

    return new LexicalIndex(corpus, postings, buildIdentityIndex(documents))
  }

  get termCount(): number {
    return this.postings.size
  }

  /**
   * True when the catalog uses this word, or a longer word beginning with it.
   *
   * The prefix arm is what separates a genuine gap in the vocabulary from an
   * inflection the catalog spells differently: "steers" is not a catalog word
   * but "steering" is, and reporting the first as unknown while the second sits
   * in the index would be a lie about what this build understands.
   */
  hasTerm(term: string): boolean {
    const lower = term.toLowerCase()
    if (this.postings.has(lower) || this.postings.has(foldTerm(lower))) return true
    return this.prefixTerms(foldTerm(lower), 1).length > 0
  }

  /**
   * The catalog words a term was actually read as, or null when the typed word
   * is itself the reading.
   *
   * This exists so the reinterpretation cannot happen silently. A resolver that
   * quietly turns "brik" into "brick" is helpful right up to the first time it
   * turns a word into the wrong one, and then the person has no way to see what
   * happened. `parseQuery` records what comes back here and the explanation
   * prints it, which is also what keeps a corrected word out of
   * `unmatchedTerms`: a term this build understood has no business being
   * reported as a condition it could not meet.
   */
  interpret(term: string): string[] | null {
    const folded = foldTerm(term.toLowerCase())
    const colloquial = COLLOQUIAL[folded] ?? COLLOQUIAL[term.toLowerCase()]
    if (colloquial) {
      const reads = colloquial.reads.filter((read) => this.postings.has(read))
      if (reads.length) return reads
    }
    if (this.hasTerm(term)) return null
    const corrected = this.correctTerm(folded)
    return corrected ? [corrected] : null
  }

  /**
   * The catalog word a misspelling most likely meant, or null.
   *
   * Damerau-Levenshtein distance one - one substitution, insertion, deletion or
   * swap of neighbours - which is the shape of nearly every typo a person makes
   * in a four-letter word: "brik", "plaet", "wheal", "antena". Candidates are
   * taken from the vocabulary itself rather than a word list, so a correction
   * can only ever land on a word this catalog actually uses, and the most-used
   * candidate wins because that is the one the person was most likely reaching
   * for.
   */
  correctTerm(term: string): string | null {
    const lower = term.toLowerCase()
    const memoised = this.corrections.get(lower)
    if (memoised !== undefined) return memoised
    const corrected = this.findCorrection(lower)
    this.corrections.set(lower, corrected)
    return corrected
  }

  private findCorrection(lower: string): string | null {
    if (lower.length < TYPO_MIN_LENGTH || this.postings.has(lower)) return null
    const buckets = this.lengthBuckets()
    let best: string | null = null
    let bestDocuments = 0
    for (let length = lower.length - 1; length <= lower.length + 1; length += 1) {
      for (const candidate of buckets.get(length) ?? []) {
        // Buckets run most-used first, so the first candidate at this length
        // that is one edit away is already the best this length can offer, and
        // anything from here down is rarer than a match already found.
        if (candidate.documents <= bestDocuments) break
        if (withinOneEdit(lower, candidate.term)) {
          best = candidate.term
          bestDocuments = candidate.documents
          break
        }
      }
    }
    return best
  }

  /**
   * Correction candidates by length, most-used first.
   *
   * Only terms above the usage floor are kept, which is most of the saving: of
   * 38,166 vocabulary entries the great majority are used by a handful of parts
   * and are never a plausible thing somebody meant to type. Built on the first
   * misspelling rather than at index build, because most sessions never contain
   * one.
   */
  private lengthBuckets(): Map<number, CorrectionCandidate[]> {
    if (this.byLength) return this.byLength
    const buckets = new Map<number, CorrectionCandidate[]>()
    for (const [term, posting] of this.postings) {
      const documents = posting.docs.length
      if (documents < TYPO_MIN_DOCUMENTS) continue
      const bucket = buckets.get(term.length)
      if (bucket) bucket.push({ term, documents })
      else buckets.set(term.length, [{ term, documents }])
    }
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => b.documents - a.documents || (a.term < b.term ? -1 : 1))
    }
    this.byLength = buckets
    return buckets
  }

  /**
   * Every reading of one query term, with what each is worth.
   *
   * Four readings are possible and they are tried in order of how much they
   * assume: the word as typed, the catalog words a beginner's word means, the
   * longer words it could be the start of, and - only when nothing else fired -
   * the word it was probably a misspelling of.
   */
  private readings(rawTerm: string): Reading[] {
    const term = rawTerm.toLowerCase()
    const folded = foldTerm(term)
    const readings: Reading[] = []

    const colloquial = COLLOQUIAL[folded] ?? COLLOQUIAL[term]
    const literal = this.postings.get(folded) ?? this.postings.get(term)
    if (literal) readings.push({ posting: literal, weight: colloquial?.literal ?? 1, idf: literal.idf })
    if (colloquial) {
      for (const read of colloquial.reads) {
        const posting = this.postings.get(read)
        if (posting) readings.push({ posting, weight: COLLOQUIAL_WEIGHT, idf: posting.idf })
      }
    }

    const expansions: Array<{ posting: Posting; inflected: boolean }> = []
    for (const expanded of this.prefixTerms(folded, PREFIX_EXPANSIONS)) {
      const posting = this.postings.get(expanded)
      if (posting) expansions.push({ posting, inflected: isInflection(folded, expanded) })
    }
    if (expansions.length) {
      // An expansion's rarity is not evidence, because the person did not type
      // it. Plain IDF says the opposite: "windo" reaching "windowscreen", a
      // word one part in the library uses, would score nearly three times what
      // it scores for reaching "window", which 654 parts use - so the single
      // windowscreen outranks every window. The ceiling is the IDF of the
      // reading the request most plausibly meant: the word itself when the
      // catalog has it, and otherwise the commonest continuation.
      let ceiling = literal ? literal.idf : Infinity
      if (!literal) for (const { posting } of expansions) ceiling = Math.min(ceiling, posting.idf)
      for (const { posting, inflected } of expansions) {
        readings.push({
          posting,
          weight: inflected ? 1 : PREFIX_DISCOUNT,
          idf: Math.min(posting.idf, ceiling),
        })
      }
    }

    if (!readings.length) {
      const corrected = this.correctTerm(folded)
      const posting = corrected === null ? undefined : this.postings.get(corrected)
      if (posting) readings.push({ posting, weight: TYPO_WEIGHT, idf: posting.idf })
    }
    return readings
  }

  /** Vocabulary entries beginning with `prefix`, shortest first. */
  private prefixTerms(prefix: string, limit: number): string[] {
    if (prefix.length < 4) return []
    let low = 0
    let high = this.sortedTerms.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.sortedTerms[middle] < prefix) low = middle + 1
      else high = middle
    }
    const found: string[] = []
    for (let i = low; i < this.sortedTerms.length && found.length < 32; i += 1) {
      const term = this.sortedTerms[i]
      if (!term.startsWith(prefix)) break
      if (term !== prefix) found.push(term)
    }
    return found.sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, limit)
  }

  /**
   * Resolves a token that looks like a part number to the identity it names.
   *
   * Retired numbers go through the registry's own rename table rather than a
   * private copy, so an alias added by a future catalog build is followed
   * without rebuilding this index.
   */
  resolveIdentity(token: string): IdentityHit | null {
    const normalized = token.toLowerCase()
    const direct = this.identities.get(normalized)
    if (direct) return { id: direct.id, kind: direct.kind }

    const withoutExtension = normalized.replace(/\.dat$/, '')
    const stripped = this.identities.get(withoutExtension)
    if (stripped) return { id: stripped.id, kind: stripped.kind }

    const renamed = catalog.resolveId(token)
    if (renamed !== token && this.corpus.byId.has(renamed)) return { id: renamed, kind: 'retired' }
    const renamedLower = catalog.resolveId(withoutExtension)
    if (renamedLower !== withoutExtension && this.corpus.byId.has(renamedLower)) {
      return { id: renamedLower, kind: 'retired' }
    }
    return null
  }

  /**
   * Top `limit` documents for `terms`, scored with BM25F.
   *
   * Accumulating into a dense array rather than a Map is deliberate: at 23,000
   * documents the array is 92 KB and every write is a single indexed store,
   * where a Map would allocate an entry per touched document on every query.
   */
  search(terms: readonly string[], limit: number): LexicalResult {
    if (!terms.length) return { hits: [], touched: new Set() }
    const scores = new Float64Array(this.corpus.documents.length)
    // Per-term scratch, so the readings of one term can compete instead of
    // accumulating. Reset only where it was written, which is why the touched
    // list is kept rather than the array being refilled.
    const best = new Float64Array(this.corpus.documents.length)
    const touched: number[] = []
    let matched = 0

    for (const rawTerm of terms) {
      const readings = this.readings(rawTerm)
      if (!readings.length) continue
      matched += 1

      // One term is one piece of evidence, so its readings are alternatives and
      // the strongest one counts. Summing them instead is how "Equipment Medical
      // Wheelchair with Clips for Wheels" used to answer "wheel": it collects
      // the exact hit *and* the expansion, and beats every part actually named
      // Wheel by carrying two readings of a single word.
      const reached: number[] = []
      for (const { posting, weight, idf } of readings) {
        const { docs, weights } = posting
        for (let i = 0; i < docs.length; i += 1) {
          const doc = docs[i]
          const contribution = (weight * idf * weights[i]) / (K1 + weights[i])
          if (best[doc] === 0) reached.push(doc)
          if (contribution > best[doc]) best[doc] = contribution
        }
      }
      for (const doc of reached) {
        if (scores[doc] === 0) touched.push(doc)
        scores[doc] += best[doc]
        best[doc] = 0
      }
    }
    if (!matched) return { hits: [], touched: new Set() }

    const hits: LexicalHit[] = []
    for (const doc of touched) hits.push({ doc, score: scores[doc] })
    hits.sort((a, b) => b.score - a.score || a.doc - b.doc)
    return { hits: hits.slice(0, limit), touched: new Set(touched) }
  }
}

/**
 * Damerau-Levenshtein distance of at most one, without building a matrix.
 *
 * The full dynamic program is the wrong tool at distance one: the answer is
 * decided by the first position where the two words disagree, so a single scan
 * settles it. That matters because this runs against every vocabulary entry of
 * a neighbouring length - some thousands of terms - for each unrecognised word.
 */
export function withinOneEdit(a: string, b: string): boolean {
  const difference = a.length - b.length
  if (difference < -1 || difference > 1) return false

  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1
  if (index === a.length && index === b.length) return true

  if (difference === 0) {
    // Either one substitution, or one swap of neighbours ("plaet" / "plate").
    if (a.slice(index + 1) === b.slice(index + 1)) return true
    return a[index] === b[index + 1] && a[index + 1] === b[index] && a.slice(index + 2) === b.slice(index + 2)
  }
  // One insertion or deletion: skip the extra character in the longer word.
  return difference === 1 ? a.slice(index + 1) === b.slice(index) : a.slice(index) === b.slice(index + 1)
}

function buildIdentityIndex(documents: readonly CorpusDocument[]): Map<string, IdentityEntry> {
  const identities = new Map<string, IdentityEntry>()
  const offer = (token: string, id: string, requestedKind: IdentityKind, frequency: number) => {
    const key = token.toLowerCase()
    if (!key) return
    // A number LDraw retired is described as retired even when it survives as
    // the part's Rebrickable id: "3023 became 3023b" is the fact the person who
    // typed the old number needs, and both readings point at the same part.
    const kind: IdentityKind =
      requestedKind !== 'canonical' && catalog.isAlias(key) && catalog.resolveId(key) === id ? 'retired' : requestedKind
    const existing = identities.get(key)
    if (
      existing &&
      (IDENTITY_PRIORITY[existing.kind] < IDENTITY_PRIORITY[kind] ||
        (IDENTITY_PRIORITY[existing.kind] === IDENTITY_PRIORITY[kind] && existing.frequency >= frequency))
    ) {
      // Element numbers in particular are shared across mould revisions, so a
      // collision is resolved towards the part people actually mean: the one
      // that turns up in more official sets.
      return
    }
    identities.set(key, { id, kind, frequency })
  }

  for (const document of documents) {
    const { id, frequency, identity } = document
    offer(id, id, 'canonical', frequency)
    if (identity.ldraw) {
      offer(identity.ldraw, id, 'ldraw', frequency)
      offer(identity.ldraw.replace(/\.dat$/i, ''), id, 'ldraw', frequency)
    }
    if (identity.rebrickable) offer(identity.rebrickable, id, 'rebrickable', frequency)
    for (const design of identity.design) offer(design, id, 'design', frequency)
    for (const element of identity.element) offer(element, id, 'element', frequency)
    for (const bricklink of identity.bricklink) offer(bricklink, id, 'bricklink', frequency)
  }
  return identities
}
