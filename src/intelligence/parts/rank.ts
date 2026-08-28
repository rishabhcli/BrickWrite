import type { ConnectionFamily } from '../../cad/types'
import type { PartIntentMatch } from '../../platform/contracts'
import type { CorpusDocument } from './corpus'
import type { IdentityKind } from './lexical'
import type { PartQuery, RelationIntent } from './query'

/**
 * Signal fusion, and the confidence number the caller is allowed to act on.
 *
 * Two rules shape everything here. The first is that a weight has to be
 * defensible in words, not tuned until a demo looks good; each constant below
 * says what evidence it is paying for and why that evidence is worth more or
 * less than its neighbours. The second is that confidence is a claim about
 * being right, so it is a calibrated probability fitted against the evaluation
 * set rather than a normalised score wearing a percentage sign. A resolver that
 * returns 1.0 for its best guess is not confident, it is unaccountable.
 */

export interface DimensionalSignal {
  score: number
  /** Measured envelope, a size read off the part name, or nothing to compare. */
  basis: 'measured' | 'name' | null
  /** False when the request stated a size this part demonstrably does not have. */
  satisfied: boolean
}

export interface ConnectorSignal {
  score: number
  matched: ConnectionFamily[]
  missing: ConnectionFamily[]
  /** False when the part is outside the compiled pack, so its connectors are unknown. */
  testable: boolean
}

export interface ColorSignal {
  score: number
  satisfied: boolean
  /** False when this build holds no colour evidence for the part at all. */
  testable: boolean
}

export interface RelationSignal {
  kind: RelationIntent['kind']
  /** 0..1 strength of the derived relationship. */
  strength: number
  detail: string
}

export interface SignalDetail {
  exactIdKind: IdentityKind | null
  lexical: number
  semantic: number
  dimensional: DimensionalSignal
  connector: ConnectorSignal
  color: ColorSignal
  frequency: number
  relation: RelationSignal | null
}

export interface RankedCandidate {
  document: CorpusDocument
  /** Fused evidence, in the units the calibration was fitted against. */
  score: number
  confidence: number
  signals: PartIntentMatch['signals']
  detail: SignalDetail
}

/**
 * Weights, in evidence units.
 *
 * exactId      An identifier is not evidence, it is an answer. Nothing else in
 *              the fusion can outvote it, which is why it sits an order above
 *              the textual signals rather than merely on top of them.
 * relation     A derived relationship is nearly as strong: "the mirror of
 *              41747" names one part, and the only reason it is below an
 *              exact id is that the relation itself was inferred.
 * lexical      The catalog's own words, matched with BM25F. The strongest
 *              ordinary signal, because most requests are made of catalog
 *              vocabulary even when the phrasing is not.
 * semantic     Latent similarity. Deliberately below lexical: it generalises
 *              past vocabulary, which is exactly why it also generalises past
 *              precision, and it must not overturn an exact word match.
 * dimensional  A size constraint is checkable, so when it is satisfied it is
 *              worth more than a fuzzy word match; the unsatisfied case is
 *              handled by a penalty rather than by a small positive score.
 * connector    Functional fit. Lower than dimension only because connectors
 *              are known for 900 of 22,941 identities, so it usually cannot fire.
 * color        Colour evidence is per-part observation from official sets, and
 *              a part is rarely chosen *because* of its palette, so it breaks
 *              ties rather than deciding them.
 * frequency    What real sets actually use. Small on purpose: it is a prior,
 *              not evidence about this request, and letting it grow buries every
 *              specialised part behind the same six bricks.
 * placeable    A tiebreaker, not a filter. The build should prefer what it can
 *              actually place without hiding what it cannot.
 */
const WEIGHT = {
  exactId: 6,
  relation: 3.4,
  lexical: 2.2,
  semantic: 1.5,
  dimensional: 1.5,
  connector: 0.9,
  color: 0.5,
  frequency: 0.55,
  placeable: 0.25,
} as const

/**
 * Penalties for constraints the candidate contradicts.
 *
 * A part that is measurably the wrong size is worse than a part whose size is
 * simply unknown, and the ranking has to say so or "six studs wide" becomes
 * decoration. Unknown is never penalised: 96% of the catalog has no compiled
 * envelope, and punishing that would collapse the answer set onto the pack.
 */
const PENALTY = {
  wrongSize: 1.6,
  missingConnector: 0.7,
  wrongColor: 0.5,
  /** LDraw "~" parts are subassembly fragments, not things a person can ask for. */
  helper: 2.5,
} as const

/**
 * Logistic calibration, fitted by gradient descent on the 112-query evaluation
 * set in `__fixtures__/evaluation.json`: every ranked candidate for every query
 * is a sample, labelled by whether it is one of that query's acceptable ids.
 *
 * The fit is reproduced by `rank.test.ts`, which recomputes the empirical hit
 * rate per confidence band and fails if the reported number drifts from the
 * observed one by more than the band width. Numbers recorded in
 * docs/integration/part-intelligence.md.
 */
const CALIBRATION = { slope: 0.5091, intercept: -3.1907 } as const

/** Maps fused evidence onto the probability that the match is acceptable. */
export function calibrateConfidence(score: number): number {
  const probability = 1 / (1 + Math.exp(-(CALIBRATION.slope * score + CALIBRATION.intercept)))
  // Clamped away from certainty: no amount of evidence in this system justifies
  // claiming a part is definitely what somebody meant.
  return Math.min(0.97, Math.max(0.01, probability))
}

const closeEnough = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

/**
 * How well a candidate's size answers the request.
 *
 * Footprints are compared order-insensitively because a 2 x 4 and a 4 x 2 are
 * the same brick held differently. A size read out of the part's name is
 * accepted at a discount rather than refused, because only 900 of 22,941
 * identities carry a measured envelope and refusing would make every
 * dimensional question unanswerable for the rest.
 */
export function dimensionalSignal(query: PartQuery, document: CorpusDocument): DimensionalSignal {
  const { envelope, footprintExtent, heightPlates, approximate } = query.dimensions
  if (envelope === null && footprintExtent === null && heightPlates === null) {
    return { score: 0, basis: null, satisfied: true }
  }

  const tolerance = approximate ? 1.05 : 0.06
  const measured = document.studs
  const named = document.nameStuds
  const scores: number[] = []
  let basis: DimensionalSignal['basis'] = null
  let contradicted = false

  const scoreAgainst = (values: readonly number[] | null, quality: number, kind: 'measured' | 'name') => {
    if (!values) return
    const footprint = kind === 'measured' ? [values[0], values[2]] : values.slice(0, 2)
    const height = kind === 'measured' ? values[1] : (values[2] ?? null)
    const local: number[] = []

    if (envelope) {
      const wanted = [...envelope].sort((a, b) => a - b)
      const actual = [...footprint].sort((a, b) => a - b)
      const footprintHit = closeEnough(actual[0], wanted[0], tolerance) && closeEnough(actual[1], wanted[1], tolerance)
      if (envelope.length >= 3 && height !== null) {
        const heightHit = closeEnough(height, envelope[2], Math.max(tolerance, 0.4))
        local.push(footprintHit && heightHit ? 1 : footprintHit ? 0.55 : 0)
      } else {
        local.push(footprintHit ? 1 : 0)
      }
    }
    if (footprintExtent !== null) {
      const best = Math.max(
        ...footprint.map((value) => (closeEnough(value, footprintExtent, tolerance) ? 1 : 0)),
      )
      // An approximate request should decay with distance instead of snapping
      // to zero: "about six studs wide" still likes a five-stud part.
      const nearest = Math.min(...footprint.map((value) => Math.abs(value - footprintExtent)))
      local.push(best === 1 ? 1 : approximate ? Math.max(0, 1 - nearest / 3) : 0)
    }
    if (heightPlates !== null && height !== null) {
      local.push(closeEnough(height, heightPlates, Math.max(tolerance, 0.4)) ? 1 : 0)
    }
    if (!local.length) return

    const average = local.reduce((a, b) => a + b, 0) / local.length
    if (average <= 0 && kind === 'measured') contradicted = true
    if (!scores.length || average * quality > scores[0]) {
      scores[0] = average * quality
      basis = kind
    }
  }

  scoreAgainst(measured, 1, 'measured')
  // A name that states its own size is real evidence, just weaker than a
  // measurement taken off compiled geometry.
  if (!measured || scores[0] === 0) scoreAgainst(named, 0.75, 'name')

  const score = scores.length ? scores[0] : 0
  const testable = measured !== null || named !== null
  return { score, basis, satisfied: score > 0 || (!testable && !contradicted) }
}

export function connectorSignal(query: PartQuery, document: CorpusDocument): ConnectorSignal {
  if (!query.connectors.length) {
    return { score: 0, matched: [], missing: [], testable: true }
  }
  const present = new Set(document.families)
  const matched = query.connectors.filter((family) => present.has(family))
  const missing = query.connectors.filter((family) => !present.has(family))
  // Connector families come from the search index, which covers every modelled
  // identity, so this is testable well beyond the compiled pack. It is not
  // testable for catalogued-only identities, which publish no connectors.
  const testable = document.tier !== 'catalogued'
  return { score: matched.length / query.connectors.length, matched, missing, testable }
}

export function colorSignal(query: PartQuery, document: CorpusDocument): ColorSignal {
  if (!query.color.codes.length) return { score: 0, satisfied: true, testable: true }
  const evidence = document.colors
  if (!evidence || !evidence.length) return { score: 0, satisfied: false, testable: false }
  const available = new Set(evidence)
  const hits = query.color.codes.filter((code) => available.has(code)).length
  return { score: hits > 0 ? 1 : 0, satisfied: hits > 0, testable: true }
}

/**
 * Real-world usage, folded to 0..1.
 *
 * Log-scaled because the distribution spans four orders of magnitude - a 2 x 4
 * brick appears in 9,318 inventories and a Samsonite gear in one - and a linear
 * prior would let the top six parts win every query outright.
 */
export function frequencySignal(query: PartQuery, document: CorpusDocument): number {
  const normalized = Math.min(1, Math.log10(document.frequency + 1) / 4)
  if (query.availability === 'rare') return 1 - normalized
  return normalized
}

export interface RankParameters {
  query: PartQuery
  document: CorpusDocument
  exactIdKind: IdentityKind | null
  /** BM25F score normalised against the best-scoring candidate for this query. */
  lexical: number
  /** Cosine similarity from the latent index; 0 when it is not resident. */
  semantic: number
  relation: RelationSignal | null
}

export function rankCandidate(parameters: RankParameters): RankedCandidate {
  const { query, document, exactIdKind, lexical, semantic, relation } = parameters
  const dimensional = dimensionalSignal(query, document)
  const connector = connectorSignal(query, document)
  const color = colorSignal(query, document)
  const frequency = frequencySignal(query, document)

  let score = 0
  if (exactIdKind) score += WEIGHT.exactId
  if (relation) score += WEIGHT.relation * relation.strength
  score += WEIGHT.lexical * lexical
  score += WEIGHT.semantic * semantic
  score += WEIGHT.dimensional * dimensional.score
  score += WEIGHT.connector * connector.score
  score += WEIGHT.color * color.score
  score += WEIGHT.frequency * frequency
  if (document.geometryAvailable) score += WEIGHT.placeable

  if (!dimensional.satisfied && dimensional.basis === 'measured') score -= PENALTY.wrongSize
  if (connector.missing.length && connector.testable) {
    score -= PENALTY.missingConnector * (connector.missing.length / Math.max(1, query.connectors.length))
  }
  if (query.color.codes.length && color.testable && !color.satisfied) score -= PENALTY.wrongColor
  if (document.helper) score -= PENALTY.helper

  return {
    document,
    score,
    confidence: calibrateConfidence(score),
    signals: {
      exactId: exactIdKind !== null,
      lexical,
      semantic,
      dimensional: dimensional.score,
      connector: connector.score,
      frequency,
    },
    detail: { exactIdKind, lexical, semantic, dimensional, connector, color, frequency, relation },
  }
}

/** Exposed so the calibration test can refit against the same objective. */
export const CALIBRATION_PARAMETERS = CALIBRATION
export const SIGNAL_WEIGHTS = WEIGHT
export const SIGNAL_PENALTIES = PENALTY
