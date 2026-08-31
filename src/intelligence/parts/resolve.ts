import { catalog } from '../../cad/catalog'
import type { CatalogTier } from '../../cad/types'
import type { PartIntentMatch, PartIntentResult } from '../../platform/contracts'
import {
  documentFromSearchRecord,
  footprintKey,
  loadPartCorpus,
  type CorpusDocument,
  type PartCorpus,
} from './corpus'
import { explainMatch } from './explain'
import { LexicalIndex, type IdentityKind } from './lexical'
import { parseQuery, type PartQuery } from './query'
import { rankCandidate, type RankedCandidate, type RelationSignal } from './rank'
import { RelationIndex } from './relations'
import { loadSemanticIndex, residentSemanticIndex, type SemanticIndex, type SemanticQuery } from './semantic'

/**
 * The public resolver: free-form language in, explained catalog identities out.
 *
 * The contract it implements is deliberately blunt about honesty. Every match
 * states its tier and whether this build can actually place it, so an agent is
 * never handed a part number it cannot use; every match carries the signals
 * that produced it, so a wrong answer can be diagnosed rather than merely
 * disbelieved; and the interpretation is returned alongside the results, so a
 * person can see that "six studs wide" was read as a footprint constraint and
 * correct it if that is not what they meant.
 */

/** Retrieval depth per stage. Wide enough that fusion can reorder, narrow enough to stay cheap. */
const LEXICAL_CANDIDATES = 150
const SEMANTIC_CANDIDATES = 150
/**
 * How many identities a stated size may contribute.
 *
 * A footprint bucket is small - a few hundred parts share "1x2" at most - and
 * taking the most-used slice of it is what puts the part that genuinely
 * measures 1 x 2 x 5 in front of the scorer even when the only word in the
 * request was "brick".
 */
const DIMENSIONAL_CANDIDATES = 60
/**
 * How many identities a stated colour may contribute.
 *
 * Same reasoning as the footprint stage and the same shape: a colour is a
 * filter on the answer, not a source of answers, so it is held to the words the
 * request also used - unless there are none, which is the case that used to have
 * no answer at all. "clear" is a whole question to a seven-year-old.
 */
const COLOR_CANDIDATES = 60
const DEFAULT_LIMIT = 8

export interface PartIntelligence {
  corpus: PartCorpus
  lexical: LexicalIndex
  relations: RelationIndex
}

export interface ResolveOptions {
  limit?: number
  /** Root the compiled assets are served from; matches `loadCompiledCatalog`. */
  baseUrl?: string
  /** Fold in the wider catalogued tier. Costs a seven-megabyte lazy fetch. */
  includeCatalogued?: boolean
  /** Restrict results to one knowledge tier. Defaults to every loaded tier. */
  tier?: CatalogTier | 'all'
  /** LDraw "~" fragments are excluded unless a caller explicitly wants them. */
  includeHelpers?: boolean
  /** Set false to answer without the latent index, e.g. on a cold first keystroke. */
  semantic?: boolean
  signal?: AbortSignal
}

let resident: { key: string; value: PartIntelligence } | null = null
let pending: { key: string; promise: Promise<PartIntelligence> } | null = null

const intelligenceKey = (options: ResolveOptions) =>
  `${options.baseUrl ?? ''}|${catalog.version}|${options.includeCatalogued ? 'all' : 'modelled'}`

/** The indexes if they are already built, without triggering any fetch. */
export function residentPartIntelligence(): PartIntelligence | null {
  return resident?.value ?? null
}

/** Drops the built indexes. Tests use it; the application has no reason to. */
export function resetPartIntelligence(): void {
  resident = null
  pending = null
}

/**
 * Builds the corpus and the symbolic indexes, once.
 *
 * The latent index is deliberately *not* loaded here: it is four megabytes and
 * only a semantic question needs it, so it stays behind `resolvePartIntent`.
 */
export function warmPartIntelligence(options: ResolveOptions = {}): Promise<PartIntelligence> {
  const key = intelligenceKey(options)
  if (resident?.key === key) return Promise.resolve(resident.value)
  if (pending?.key === key) return pending.promise

  const promise = (async () => {
    const corpus = await loadPartCorpus({
      baseUrl: options.baseUrl,
      includeCatalogued: options.includeCatalogued,
      signal: options.signal,
    })
    const value: PartIntelligence = {
      corpus,
      lexical: LexicalIndex.build(corpus),
      relations: RelationIndex.build(corpus),
    }
    resident = { key, value }
    return value
  })().catch((cause: unknown) => {
    if (pending?.key === key) pending = null
    throw cause
  })

  pending = { key, promise }
  return promise
}

export async function resolvePartIntent(query: string, options: ResolveOptions = {}): Promise<PartIntentResult> {
  const started = performance.now()
  const intelligence = await warmPartIntelligence(options)
  let semantic: SemanticIndex | null = null
  if (options.semantic !== false) {
    semantic = await loadSemanticIndex({ baseUrl: options.baseUrl, signal: options.signal })
  }
  return resolveAgainst(intelligence, semantic, query, options, started)
}

/**
 * The synchronous resolver.
 *
 * A part picker cannot await a four-megabyte index on every keystroke, so this
 * answers from whatever is already resident. When the corpus has not been built
 * it falls back to the registry's own ranked search for candidates and scores
 * them through exactly the same fusion, so the degraded answer is weaker but
 * never differently shaped - and the explanation says which mode produced it.
 */
export function resolvePartIntentSync(query: string, options: ResolveOptions = {}): PartIntentResult {
  const started = performance.now()
  const intelligence = resident?.key === intelligenceKey(options) ? resident.value : null
  if (intelligence) {
    return resolveAgainst(intelligence, residentSemanticIndex(), query, options, started)
  }
  return resolveFromRegistry(query, options, started)
}

// ---------------------------------------------------------------------------

interface Candidate {
  document: CorpusDocument
  exactIdKind: IdentityKind | null
  lexical: number
  semantic: number
  relation: RelationSignal | null
}

function resolveAgainst(
  intelligence: PartIntelligence,
  semanticIndex: SemanticIndex | null,
  raw: string,
  options: ResolveOptions,
  started: number,
): PartIntentResult {
  const { corpus, lexical, relations } = intelligence
  const query = parseQuery(raw, {
    colors: catalog.colors(),
    categories: catalog.categories,
    resolveIdentity: (token) => lexical.resolveIdentity(token)?.id ?? null,
    knowsTerm: (term) => lexical.hasTerm(term),
    readTerm: (term) => lexical.interpret(term),
  })

  const candidates = new Map<string, Candidate>()
  const admit = (document: CorpusDocument): Candidate => {
    const existing = candidates.get(document.id)
    if (existing) return existing
    const candidate: Candidate = { document, exactIdKind: null, lexical: 0, semantic: 0, relation: null }
    candidates.set(document.id, candidate)
    return candidate
  }

  // 1. Identifiers the request named outright.
  for (const token of query.idTokens) {
    const hit = lexical.resolveIdentity(token)
    if (!hit) continue
    const document = corpus.byId.get(hit.id)
    if (document) admit(document).exactIdKind = hit.kind
  }

  // 2. Derived relationships.
  const relationTargets = applyRelations(query, corpus, relations, admit)

  // 3. BM25F over the catalog's own words.
  const { hits: lexicalHits, touched } = lexical.search(query.contentTerms, LEXICAL_CANDIDATES)
  const bestLexical = lexicalHits[0]?.score ?? 0
  for (const hit of lexicalHits) {
    const document = corpus.documents[hit.doc]
    admit(document).lexical = bestLexical > 0 ? hit.score / bestLexical : 0
  }

  // 4. Identities whose measured or stated footprint is the one asked for, held
  //    to the words the request also used. Without that floor, "a 25 stud tall
  //    cheese slope" would answer with whatever 25-stud part exists and the
  //    impossible half of the request would vanish.
  const requireWordMatch = query.contentTerms.length > 0 && touched.size > 0
  for (const index of footprintCandidates(query, corpus)) {
    if (requireWordMatch && !touched.has(index)) continue
    admit(corpus.documents[index])
  }

  // 5. Identities this build has actually observed in the colour asked for.
  for (const index of colorCandidates(query, corpus)) {
    if (requireWordMatch && !touched.has(index)) continue
    admit(corpus.documents[index])
  }

  // 6. Latent similarity, over the same query and every candidate found so far.
  //
  // Terms the lexical vocabulary rejected are deliberately included: character
  // trigrams are exactly the mechanism that reaches "Steering" from "steers",
  // and a word this build has never indexed is the case the latent space is
  // there to cover. It is still reported as unmatched.
  //
  // A colour word joins that text only when the request also said something
  // about the part. On its own it is a filter with no shape in it, and the
  // latent space answers it with whatever parts are *named* like the colour:
  // "clear" returned a bandana, a starched cape and a set of air tanks, every
  // one of them a confident answer to a question nobody asked.
  const semanticText = query.contentTerms.length
    ? [query.contentTerms.join(' '), query.color.evidence.join(' ')].join(' ').trim()
    : ''
  let semanticQuery: SemanticQuery | null = null
  if (semanticIndex && semanticText) {
    semanticQuery = semanticIndex.query(semanticText)
    if (semanticQuery) {
      for (const hit of semanticQuery.top(SEMANTIC_CANDIDATES)) {
        const document = corpus.byId.get(hit.id)
        if (document) admit(document).semantic = hit.similarity
      }
      for (const candidate of candidates.values()) {
        if (candidate.semantic === 0) candidate.semantic = semanticQuery.similarity(candidate.document.id)
      }
    }
  }

  const tier = options.tier ?? 'all'
  const ranked: RankedCandidate[] = []
  for (const candidate of candidates.values()) {
    const document = candidate.document
    if (!options.includeHelpers && document.helper) continue
    if (tier !== 'all' && document.tier !== tier) continue
    if (relationTargets.has(document.id)) continue
    ranked.push(
      rankCandidate({
        query,
        document,
        exactIdKind: candidate.exactIdKind,
        lexical: candidate.lexical,
        semantic: candidate.semantic,
        relation: candidate.relation,
        decorated: relations.baseOf(document.id) !== null,
      }),
    )
  }
  ranked.sort(
    (a, b) => b.score - a.score || b.document.frequency - a.document.frequency || (a.document.id < b.document.id ? -1 : 1),
  )

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 50))
  const top = ranked.slice(0, limit)
  return assemble(query, top, semanticIndex !== null, started)
}

/**
 * The cold path: candidates from the registry's ranked search, scored by the
 * same fusion.
 *
 * The lexical signal here is derived from the registry's own ordering rather
 * than from BM25, which is weaker and is reported as such - `signals.lexical`
 * is a rank proxy, not a term-frequency score - but it keeps the shape of the
 * answer, the tier honesty and the explanation identical.
 */
/**
 * Document indices whose footprint matches the size the request stated.
 *
 * A two-number envelope is one bucket. A single extent - "six studs wide" - is
 * every bucket with that number on either axis, which is why the buckets are
 * walked rather than looked up.
 */
function footprintCandidates(query: PartQuery, corpus: PartCorpus): number[] {
  const { envelope, footprintExtent } = query.dimensions
  const picked: number[] = []
  if (envelope && envelope.length >= 2) {
    const bucket = corpus.byFootprint.get(footprintKey(envelope[0], envelope[1]))
    if (bucket) {
      if (envelope.length >= 3) {
        // A stated height is part of the request, not decoration. Taking the
        // bucket by popularity alone buries "Brick 1 x 2 x 5" under the two
        // hundred more common things that are also 1 x 2.
        const wantedPlates = envelope[2] * 3
        for (const index of bucket) {
          if (picked.length >= DIMENSIONAL_CANDIDATES) break
          const plates = heightInPlates(corpus.documents[index])
          if (plates !== null && Math.abs(plates - wantedPlates) <= 1.6) picked.push(index)
        }
      }
      picked.push(...bucket.slice(0, DIMENSIONAL_CANDIDATES))
    }
  }
  if (footprintExtent !== null) {
    for (const [key, bucket] of corpus.byFootprint) {
      const [low, high] = key.split('x')
      if (Number(low) !== footprintExtent && Number(high) !== footprintExtent) continue
      picked.push(...bucket.slice(0, Math.ceil(DIMENSIONAL_CANDIDATES / 4)))
    }
  }
  return picked
}

/**
 * Document indices this build has observed in one of the requested colours,
 * most-used first.
 *
 * The union across codes is walked code by code and capped, rather than
 * gathered and sorted, because a finish word such as "clear" resolves to 57
 * colour codes and taking the head of each bucket is what keeps the stage
 * proportional to the answer rather than to the palette.
 */
function colorCandidates(query: PartQuery, corpus: PartCorpus): number[] {
  if (!query.color.codes.length) return []
  const picked: number[] = []
  const seen = new Set<number>()
  const perCode = Math.max(4, Math.ceil(COLOR_CANDIDATES / query.color.codes.length))
  for (const code of query.color.codes) {
    const bucket = corpus.byColor.get(code)
    if (!bucket) continue
    for (let i = 0; i < bucket.length && i < perCode; i += 1) {
      if (seen.has(bucket[i])) continue
      seen.add(bucket[i])
      picked.push(bucket[i])
    }
  }
  return picked
}

/**
 * Height in plates, from the measurement if there is one and from the name
 * otherwise. LDraw writes the third number of a name in brick heights, so the
 * name reading is multiplied out before the two can be compared.
 */
function heightInPlates(document: CorpusDocument): number | null {
  if (document.studs) return document.studs[1]
  const named = document.nameStuds?.[2]
  return named === undefined ? null : named * 3
}

function resolveFromRegistry(raw: string, options: ResolveOptions, started: number): PartIntentResult {
  const query = parseQuery(raw, {
    colors: catalog.colors(),
    categories: catalog.categories,
    resolveIdentity: (token) => {
      const record = catalog.describe(token)
      return record ? record.id : null
    },
    knowsTerm: (term) => catalog.searchPage({ text: term, limit: 1, tier: 'all', includeHelpers: true }).total > 0,
  })

  const text = [...query.contentTerms, ...query.ids].join(' ').trim()
  const records = text
    ? catalog.searchPage({
        text,
        limit: LEXICAL_CANDIDATES,
        tier: options.tier ?? 'all',
        includeHelpers: options.includeHelpers ?? false,
      }).records
    : []

  const ranked = records.map((record, index) => {
    const document = documentFromSearchRecord(record)
    return rankCandidate({
      query,
      document,
      exactIdKind: query.ids.includes(record.id) ? 'canonical' : null,
      lexical: (records.length - index) / records.length,
      semantic: 0,
      relation: null,
      // The relation tables are not built on the cold path, so no identity can
      // be shown as a decoration without the evidence to say so.
      decorated: false,
    })
  })
  ranked.sort(
    (a, b) => b.score - a.score || b.document.frequency - a.document.frequency || (a.document.id < b.document.id ? -1 : 1),
  )

  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 50))
  return assemble(query, ranked.slice(0, limit), false, started)
}

/**
 * Seeds candidates from the derived relation tables.
 *
 * Returns the identities the request used as *arguments* rather than answers -
 * asking for the mirror of 41747 must not come back with 41747 - so the ranking
 * stage can exclude them.
 */
function applyRelations(
  query: PartQuery,
  corpus: PartCorpus,
  relations: RelationIndex,
  admit: (document: CorpusDocument) => Candidate,
): Set<string> {
  const excluded = new Set<string>()
  const relation = query.relation
  if (!relation) return excluded

  const attach = (id: string, signal: RelationSignal) => {
    const document = corpus.byId.get(id)
    if (!document) return
    const candidate = admit(document)
    if (!candidate.relation || candidate.relation.strength < signal.strength) candidate.relation = signal
  }

  switch (relation.kind) {
    case 'mirrored': {
      excluded.add(relation.target)
      const mirror = relations.mirrorOf(relation.target)
      if (!mirror) break
      // Geometry that actually reflects is proof; a name that merely says the
      // other hand is a strong hint and is scored as one.
      const strength = mirror.evidence === 'geometry' ? 1 : mirror.evidence === 'envelope' ? 0.8 : 0.6
      attach(mirror.id, {
        kind: 'mirrored',
        strength,
        detail:
          mirror.evidence === 'geometry'
            ? `mirror counterpart of ${relation.target}, confirmed by reflected geometry`
            : mirror.evidence === 'envelope'
              ? `mirror counterpart of ${relation.target}, matching envelope and name`
              : `mirror counterpart of ${relation.target} by name`,
      })
      break
    }
    case 'interface': {
      excluded.add(relation.target)
      for (const match of relations.interfaceCompatible(relation.target)) {
        attach(match.id, {
          kind: 'interface',
          strength: match.similarity,
          detail: `${(match.similarity * 100).toFixed(0)}% of ${relation.target}'s connectors, family for family`,
        })
      }
      break
    }
    case 'printed-variant': {
      if (relation.target) {
        excluded.add(relation.target)
        for (const id of relations.variantsOf(relation.target)) {
          attach(id, { kind: 'printed-variant', strength: 1, detail: `decorated variant of ${relation.target}` })
        }
      }
      break
    }
    case 'base-variant': {
      if (relation.target) {
        const base = relations.baseOf(relation.target)
        if (base) {
          excluded.add(relation.target)
          attach(base, { kind: 'base-variant', strength: 1, detail: `the plain design ${relation.target} decorates` })
        }
      }
      break
    }
    case 'bridge': {
      const candidates = relations.gapBridging(relation.gapStuds)
      const tightest = candidates[0]?.spanStuds ?? 0
      for (const candidate of candidates) {
        // A part exactly long enough is the answer; longer ones still work and
        // are ranked behind it rather than dropped.
        const excess = candidate.spanStuds - tightest
        attach(candidate.id, {
          kind: 'bridge',
          strength: Math.max(0.35, 1 - excess / 8),
          detail:
            candidate.antiStudSeparation !== null
              ? `spans ${candidate.spanStuds} studs with anti-studs ${candidate.antiStudSeparation} studs apart, enough to cross ${relation.gapStuds}`
              : `spans ${candidate.spanStuds} studs, enough to cross ${relation.gapStuds} with a stud of landing each side`,
        })
      }
      break
    }
  }
  return excluded
}

function assemble(
  query: PartQuery,
  ranked: RankedCandidate[],
  semanticResident: boolean,
  started: number,
): PartIntentResult {
  const matches: PartIntentMatch[] = ranked.map((candidate) => {
    const { document } = candidate
    // Placeability is read off the compiled geometry, not asserted: `tier` and
    // `geometryStatus` have to agree before this build promises it can place it.
    const placeable =
      document.tier === 'placeable' &&
      (document.geometryStatus === 'certified' || document.geometryStatus === 'partial')
    return {
      canonicalId: document.id,
      confidence: candidate.confidence,
      explanation: explainMatch(candidate, query, { semanticResident }),
      tier: document.tier,
      placeable,
      signals: candidate.signals,
    }
  })

  return {
    query: query.raw,
    matches,
    interpretation: {
      dimensions: interpretedDimensions(query),
      category: query.categories[0] ?? null,
      colorName: query.color.names[0] ?? query.color.finishes[0] ?? null,
      connectorFamilies: query.connectors.slice(),
      unmatchedTerms: unmatchedTerms(query, ranked),
    },
    elapsedMs: performance.now() - started,
  }
}

/**
 * The size the resolver committed to, as [width, height, depth] in studs and
 * plates to match `CatalogSearchRecord.dimensions`.
 *
 * LDraw writes an envelope as width x depth x height, so the axes are
 * reordered here. A zero means "the request did not say", which is why an
 * unstated axis is published as 0 rather than guessed at.
 */
function interpretedDimensions(query: PartQuery): [number, number, number] | null {
  const { envelope, footprintExtent, heightPlates } = query.dimensions
  if (envelope) {
    const [width, depth, height] = envelope
    return [width, height ?? heightPlates ?? 0, depth]
  }
  if (footprintExtent !== null || heightPlates !== null) {
    return [footprintExtent ?? 0, heightPlates ?? 0, 0]
  }
  return null
}

/**
 * Terms nothing in the answer satisfies.
 *
 * Two kinds land here: words the parser could not interpret at all, and
 * constraints it *did* interpret but which no returned match meets. The second
 * kind is the one that matters. "A 40-stud transparent gear" parses perfectly
 * and is still impossible, and the only honest way to say so is to return the
 * nearest gears while naming the two conditions none of them meet.
 */
function unmatchedTerms(query: PartQuery, ranked: RankedCandidate[]): string[] {
  // A size word with no scale behind it is the third kind, and it belongs here
  // rather than in the parser's own list: "big" was understood, it is simply
  // not a thing this build can measure, and the caller has to be told that
  // instead of being handed the answer to "flat" as if it answered "big flat".
  const unmatched = [...query.unmatchedTerms, ...query.uncheckableTerms]
  const add = (term: string) => {
    if (term && !unmatched.includes(term)) unmatched.push(term)
  }

  // Each size constraint is checked on its own. "A 64 stud long 1 x 1 round
  // brick" satisfies its footprint and fails its length, and blending the two
  // into one verdict would let the impossible half disappear.
  const { phrases } = query.dimensions
  for (const key of ['envelope', 'footprintExtent', 'heightPlates'] as const) {
    const phrase = phrases[key]
    if (!phrase) continue
    if (!ranked.some((candidate) => candidate.detail.dimensional.met[key] === true)) add(phrase)
  }

  if (query.axisOrientation && !ranked.some((candidate) => candidate.detail.connector.axis.matched)) {
    add(`connector axis pointing ${query.axisOrientation === 'horizontal' ? 'sideways' : 'upright'}`)
  }

  if (query.color.codes.length && !ranked.some((candidate) => candidate.detail.color.satisfied)) {
    for (const evidence of query.color.evidence) add(evidence)
  }

  for (const family of query.connectors) {
    if (!ranked.some((candidate) => candidate.detail.connector.matched.includes(family))) add(family)
  }

  if (query.relation && !ranked.some((candidate) => candidate.detail.relation !== null)) {
    add(describeRelation(query.relation))
  }

  return unmatched
}

function describeRelation(relation: NonNullable<PartQuery['relation']>): string {
  switch (relation.kind) {
    case 'mirrored':
      return `mirrored counterpart of ${relation.target}`
    case 'interface':
      return `same connections as ${relation.target}`
    case 'printed-variant':
      return relation.target ? `printed variant of ${relation.target}` : 'printed variant'
    case 'base-variant':
      return relation.target ? `plain version of ${relation.target}` : 'plain version'
    case 'bridge':
      return `bridges a ${relation.gapStuds}-stud gap`
  }
}
