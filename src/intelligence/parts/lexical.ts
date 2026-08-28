import { catalog } from '../../cad/catalog'
import type { CorpusDocument, PartCorpus } from './corpus'

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

export class LexicalIndex {
  private constructor(
    readonly corpus: PartCorpus,
    private readonly postings: Map<string, Posting>,
    private readonly identities: Map<string, IdentityEntry>,
  ) {}

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
        ids: document.identityIds.flatMap((id) => lexicalTokens(id)),
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

  /** True when the catalog uses this word anywhere, so the parser can tell a typo from a term. */
  hasTerm(term: string): boolean {
    const folded = foldTerm(term.toLowerCase())
    return this.postings.has(folded) || this.postings.has(term.toLowerCase())
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
  search(terms: readonly string[], limit: number): LexicalHit[] {
    if (!terms.length) return []
    const scores = new Float64Array(this.corpus.documents.length)
    const touched: number[] = []
    let matched = 0

    for (const rawTerm of terms) {
      const term = rawTerm.toLowerCase()
      const posting = this.postings.get(foldTerm(term)) ?? this.postings.get(term)
      if (!posting) continue
      matched += 1
      const { docs, weights, idf } = posting
      for (let i = 0; i < docs.length; i += 1) {
        const doc = docs[i]
        if (scores[doc] === 0) touched.push(doc)
        scores[doc] += (idf * weights[i]) / (K1 + weights[i])
      }
    }
    if (!matched) return []

    const hits: LexicalHit[] = []
    for (const doc of touched) hits.push({ doc, score: scores[doc] })
    hits.sort((a, b) => b.score - a.score || a.doc - b.doc)
    return hits.slice(0, limit)
  }
}

function buildIdentityIndex(documents: readonly CorpusDocument[]): Map<string, IdentityEntry> {
  const identities = new Map<string, IdentityEntry>()
  const offer = (token: string, entry: IdentityEntry) => {
    const key = token.toLowerCase()
    if (!key) return
    const existing = identities.get(key)
    if (
      existing &&
      (IDENTITY_PRIORITY[existing.kind] < IDENTITY_PRIORITY[entry.kind] ||
        (IDENTITY_PRIORITY[existing.kind] === IDENTITY_PRIORITY[entry.kind] && existing.frequency >= entry.frequency))
    ) {
      // Element numbers in particular are shared across mould revisions, so a
      // collision is resolved towards the part people actually mean: the one
      // that turns up in more official sets.
      return
    }
    identities.set(key, entry)
  }

  for (const document of documents) {
    const frequency = document.frequency
    offer(document.id, { id: document.id, kind: 'canonical', frequency })
    for (const raw of document.identityIds) {
      if (raw === document.id) continue
      let kind: IdentityKind = 'rebrickable'
      if (/\.dat$/i.test(raw)) kind = 'ldraw'
      else if (/^\d{6,7}$/.test(raw)) kind = 'element'
      else if (/^\d{4,5}[a-z]?$/i.test(raw)) kind = 'design'
      offer(raw, { id: document.id, kind, frequency })
      if (kind === 'ldraw') offer(raw.replace(/\.dat$/i, ''), { id: document.id, kind: 'ldraw', frequency })
    }
  }
  return identities
}
