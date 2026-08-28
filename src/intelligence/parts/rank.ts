import type { ConnectionFamily } from '../../cad/types'
import type { PartIntentMatch } from '../../platform/contracts'
import type { CorpusDocument } from './corpus'
import type { IdentityKind } from './lexical'
import type { AxisIntent, PartQuery, RelationIntent } from './query'

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

/** Whether a stated constraint was met, or `null` when the request did not state it. */
export interface DimensionSatisfaction {
  envelope: boolean | null
  footprintExtent: boolean | null
  heightPlates: boolean | null
}

export interface DimensionalSignal {
  score: number
  /** Measured envelope, a size read off the part name, or nothing to compare. */
  basis: 'measured' | 'name' | null
  /** False when the request stated a size this part demonstrably does not have. */
  satisfied: boolean
  met: DimensionSatisfaction
}

export interface ConnectorSignal {
  score: number
  matched: ConnectionFamily[]
  missing: ConnectionFamily[]
  /** Families the request ruled out that this part nonetheless carries. */
  forbidden: ConnectionFamily[]
  /** False when the part is outside the compiled pack, so its connectors are unknown. */
  testable: boolean
  /** Whether a requested connector axis direction was confirmed, refuted, or untestable. */
  axis: { requested: AxisIntent | null; matched: boolean; testable: boolean }
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
  /** True when this identity is a printed or stickered decoration of another. */
  decorated: boolean
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
 * connector    Functional fit, from the connector families the compiler
 *              recorded for every modelled identity.
 * axis         Connector orientation. Small in reach - it needs compiled
 *              connectors - but decisive when it fires, because it is the only
 *              thing that separates a hinge that swings from one that spins.
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
  dimensional: 2.2,
  connector: 0.9,
  axis: 1.2,
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
 *
 * `forbiddenConnector` is the mirror of the connector reward: a request that
 * says "no studs on top" has stated a fact about the answer, and a part that
 * carries the ruled-out family is wrong rather than merely unmatched.
 *
 * `decoration` is the one penalty that is about the question rather than the
 * part. LDraw carries roughly ten printed and stickered variants for every
 * popular design, all sharing its name; without this, "45 degree slope 2 x 2"
 * answers with six patterned versions of the slope and never the slope.
 */
const PENALTY = {
  wrongSize: 1.6,
  missingConnector: 0.7,
  wrongAxis: 1.2,
  forbiddenConnector: 1.1,
  wrongColor: 0.5,
  /**
   * Charged per share of the request made of words this build has never
   * indexed. A match for "a zorbulon plate" is at best an answer to "a plate",
   * and it must not be offered with the confidence of an answer to the whole
   * request.
   */
  unknownTerm: 1.6,
  decoration: 1.4,
  /** LDraw "~" parts are subassembly fragments, not things a person can ask for. */
  helper: 2.5,
} as const

/**
 * Logistic calibration, fitted by gradient descent on the answerable half of
 * `__fixtures__/evaluation.json`: every ranked candidate for every query is a
 * sample, labelled by whether it is one of that query's acceptable ids.
 *
 * `rank.test.ts` refits against the same objective and fails if these constants
 * have drifted from the fit, and separately checks that the reported confidence
 * tracks the observed hit rate per band. Numbers are recorded in
 * docs/integration/part-intelligence.md.
 */
const CALIBRATION = { slope: 0.6125, intercept: -3.1016 } as const

/** Maps fused evidence onto the probability that the match is acceptable. */
export function calibrateConfidence(score: number): number {
  const probability = 1 / (1 + Math.exp(-(CALIBRATION.slope * score + CALIBRATION.intercept)))
  // Clamped away from certainty: no amount of evidence in this system justifies
  // claiming a part is definitely what somebody meant.
  return Math.min(0.97, Math.max(0.01, probability))
}

const closeEnough = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

/** Fraction of the size constraints the request stated that this part fails. */
export function unmetConstraintShare(signal: DimensionalSignal): number {
  const stated = Object.values(signal.met).filter((value) => value !== null)
  if (!stated.length) return 0
  return stated.filter((value) => value === false).length / stated.length
}

/** One candidate size reading: a measurement in plates, or a name in bricks. */
interface SizeBasis {
  kind: 'measured' | 'name'
  quality: number
  footprint: number[]
  /** Height in plates for a measurement, in bricks for a name. */
  height: number | null
  heightUnit: 'plates' | 'bricks'
}

function sizeBases(document: CorpusDocument): SizeBasis[] {
  const bases: SizeBasis[] = []
  if (document.studs) {
    bases.push({
      kind: 'measured',
      quality: 1,
      footprint: [document.studs[0], document.studs[2]],
      height: document.studs[1],
      heightUnit: 'plates',
    })
  }
  if (document.nameStuds) {
    // A size stated in a part name is real evidence, just weaker than a
    // measurement taken off compiled geometry - and LDraw writes the third
    // number in brick heights, not plates.
    bases.push({
      kind: 'name',
      quality: 0.75,
      footprint: document.nameStuds.slice(0, 2),
      height: document.nameStuds[2] ?? null,
      heightUnit: 'bricks',
    })
  }
  return bases
}

/**
 * Height comparison across the two unit systems LDraw mixes.
 *
 * A measured envelope is published in plates and includes the stud overhang; a
 * name says "1 x 2 x 5" meaning five bricks. Both readings are accepted so that
 * "a 1 x 2 x 5 brick" matches whether or not the part was compiled.
 */
function heightMatches(basis: SizeBasis, wanted: number, wantedUnit: 'plates' | 'bricks'): boolean {
  if (basis.height === null) return false
  const wantedPlates = wantedUnit === 'bricks' ? wanted * 3 : wanted
  const actualPlates = basis.heightUnit === 'bricks' ? basis.height * 3 : basis.height
  // 1.6 plates of slack absorbs the 0.5-plate stud overhang a measured box
  // carries plus the rounding in fractional brick heights such as "1 1/3".
  if (closeEnough(actualPlates, wantedPlates, 1.6)) return true
  // Some names quote a plate count directly, so the literal reading is kept too.
  return closeEnough(basis.height, wanted, 0.4)
}

/**
 * How well a candidate's size answers the request.
 *
 * Footprints are compared order-insensitively because a 2 x 4 and a 4 x 2 are
 * the same brick held differently. Each constraint is judged on its own, so a
 * request that names two sizes and meets one of them can say precisely which
 * one it failed instead of reporting a single blended number.
 */
export function dimensionalSignal(query: PartQuery, document: CorpusDocument): DimensionalSignal {
  const { envelope, footprintExtent, heightPlates, approximate } = query.dimensions
  const met: DimensionSatisfaction = {
    envelope: envelope === null ? null : false,
    footprintExtent: footprintExtent === null ? null : false,
    heightPlates: heightPlates === null ? null : false,
  }
  if (envelope === null && footprintExtent === null && heightPlates === null) {
    return { score: 0, basis: null, satisfied: true, met }
  }

  const tolerance = approximate ? 1.05 : 0.06
  const bases = sizeBases(document)
  let score = 0
  let basis: DimensionalSignal['basis'] = null
  let contradictedByMeasurement = false

  for (const candidate of bases) {
    const local: number[] = []

    if (envelope !== null) {
      const wanted = [...envelope].slice(0, 2).sort((a, b) => a - b)
      const actual = [...candidate.footprint].sort((a, b) => a - b)
      const footprintHit =
        actual.length >= 2 && closeEnough(actual[0], wanted[0], tolerance) && closeEnough(actual[1], wanted[1], tolerance)
      if (envelope.length >= 3) {
        const heightHit = footprintHit && heightMatches(candidate, envelope[2], 'bricks')
        if (heightHit) met.envelope = true
        // A footprint match with the wrong height is a partial answer, not a
        // wrong one - a person who says "1 x 2 x 5" and means the 1 x 2 is
        // still pointing somewhere useful - but it must not outrank the part
        // that matches all three numbers.
        local.push(heightHit ? 1 : footprintHit ? 0.4 : 0)
      } else {
        if (footprintHit) met.envelope = true
        local.push(footprintHit ? 1 : 0)
      }
    }

    if (footprintExtent !== null) {
      const exact = candidate.footprint.some((value) => closeEnough(value, footprintExtent, tolerance))
      if (exact) met.footprintExtent = true
      const nearest = candidate.footprint.length
        ? Math.min(...candidate.footprint.map((value) => Math.abs(value - footprintExtent)))
        : Infinity
      // An approximate request should decay with distance instead of snapping
      // to zero: "about six studs wide" still likes a five-stud part.
      local.push(exact ? 1 : approximate && Number.isFinite(nearest) ? Math.max(0, 1 - nearest / 3) : 0)
    }

    if (heightPlates !== null) {
      const hit = heightMatches(candidate, heightPlates, 'plates')
      if (hit) met.heightPlates = true
      local.push(hit ? 1 : 0)
    }

    if (!local.length) continue
    const average = (local.reduce((a, b) => a + b, 0) / local.length) * candidate.quality
    if (average === 0 && candidate.kind === 'measured') contradictedByMeasurement = true
    if (average > score) {
      score = average
      basis = candidate.kind
    }
  }

  if (score > 0) basis ??= bases[0]?.kind ?? null
  const testable = bases.length > 0
  return {
    score,
    basis: score > 0 ? basis : testable ? bases[0].kind : null,
    satisfied: score > 0 || (!testable && !contradictedByMeasurement),
    met,
  }
}

const AXIS_TOLERANCE = 0.5

export function connectorSignal(query: PartQuery, document: CorpusDocument): ConnectorSignal {
  const axis = axisSignal(query, document)
  const present = new Set(document.families)
  const forbidden = query.excludedConnectors.filter((family) => present.has(family))
  if (!query.connectors.length) {
    return { score: 0, matched: [], missing: [], forbidden, testable: true, axis }
  }
  const matched = query.connectors.filter((family) => present.has(family))
  const missing = query.connectors.filter((family) => !present.has(family))
  // Connector families come from the search index, which covers every modelled
  // identity, so this is testable well beyond the compiled pack. It is not
  // testable for catalogued-only identities, which publish no connectors.
  const testable = document.tier !== 'catalogued'
  return { score: matched.length / query.connectors.length, matched, missing, forbidden, testable, axis }
}

/**
 * Whether the part's connectors actually point the way the request asked.
 *
 * Only the compiled pack carries connector orientations, so this is silent for
 * most of the catalog - and silence is reported as untestable rather than as a
 * failure, because "we did not compile that part's connectors" and "that part's
 * hinge spins the wrong way" are different answers.
 */
function axisSignal(query: PartQuery, document: CorpusDocument): ConnectorSignal['axis'] {
  const requested = query.axisOrientation
  if (!requested) return { requested: null, matched: false, testable: true }
  const axes = document.connectorAxes
  if (!axes?.length) return { requested, matched: false, testable: false }

  const families = query.connectors.length ? new Set<string>(query.connectors) : null
  const relevant = families ? axes.filter((entry) => families.has(entry.family)) : axes
  if (!relevant.length) return { requested, matched: false, testable: false }

  const matched = relevant.some((entry) => {
    const vertical = Math.abs(entry.axis[1])
    return requested === 'horizontal' ? vertical < AXIS_TOLERANCE : vertical >= AXIS_TOLERANCE
  })
  return { requested, matched, testable: true }
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
  /** True when the relation index found a base design this identity decorates. */
  decorated: boolean
}

export function rankCandidate(parameters: RankParameters): RankedCandidate {
  const { query, document, exactIdKind, lexical, semantic, relation, decorated } = parameters
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
  if (connector.axis.testable && connector.axis.requested) {
    score += connector.axis.matched ? WEIGHT.axis : -PENALTY.wrongAxis
  }
  if (document.geometryAvailable) score += WEIGHT.placeable

  // Charged per unmet constraint rather than once for the whole request: a
  // 1 x 1 round brick answers the footprint of "a 64 stud long 1 x 1 round
  // brick" and fails its length, and a single blended verdict would let the
  // half it fails go unpriced.
  const unmetShare = unmetConstraintShare(dimensional)
  if (unmetShare > 0 && dimensional.basis !== null) score -= PENALTY.wrongSize * unmetShare
  if (connector.missing.length && connector.testable) {
    score -= PENALTY.missingConnector * (connector.missing.length / Math.max(1, query.connectors.length))
  }
  if (connector.forbidden.length && connector.testable) score -= PENALTY.forbiddenConnector
  if (query.color.codes.length && color.testable && !color.satisfied) score -= PENALTY.wrongColor
  if (decorated && query.variantPreference !== 'printed' && !exactIdKind && relation?.kind !== 'printed-variant') {
    score -= PENALTY.decoration
  }
  if (query.contentTerms.length && query.unmatchedTerms.length) {
    score -= PENALTY.unknownTerm * (query.unmatchedTerms.length / query.contentTerms.length)
  }
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
    detail: { exactIdKind, lexical, semantic, dimensional, connector, color, frequency, relation, decorated },
  }
}

/** Exposed so the calibration test can refit against the same objective. */
export const CALIBRATION_PARAMETERS = CALIBRATION
export const SIGNAL_WEIGHTS = WEIGHT
export const SIGNAL_PENALTIES = PENALTY
