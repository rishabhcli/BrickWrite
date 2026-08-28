import { catalog, STUD_LDU } from '../cad/catalog'
import { computeBuildOrder } from '../cad/instructions'
import type { ModelDocument } from '../cad/types'
import { analysePalette, analyseSymmetry, rarityOf } from './analyse'
import { freeStudsOf, silhouetteOf, stackedSeamsOf, staticsOf, stepEdgesOf, weakAttachmentsOf } from './cache'
import { boundsOfParts, silhouetteIou } from './silhouette'
import { countSeams, extractRows } from './topology'
import { OBJECTIVE_IDS, type MetricVector, type ObjectiveId, type RefinementScope } from './types'

/**
 * The objective vector.
 *
 * A refinement is a trade. Lowering a roof costs silhouette fidelity; adding a
 * bracket to hold an overhang costs part count; restacking a wall to break its
 * seams almost always costs both. The only honest way to present that is to
 * measure every axis on every candidate and show all of them, which is what this
 * module exists to make possible — a proposal that improved one number and quietly
 * spent three others is the exact failure mode a "design doctor" has to not have.
 *
 * Each objective is a pure `(document, scope) => number`. Two properties follow
 * and both are relied on elsewhere: the same document and scope always produce
 * the same vector, so the search is reproducible; and a number can be recomputed
 * by a reader from two values that are printed next to it.
 *
 * `scale` is the amount of change that counts as one unit of improvement, so the
 * weighted sum adds comparable quantities instead of adding grams to pixels.
 *
 * **There is no cost objective.** The compiled catalog publishes set-appearance
 * frequency and no price of any kind. A currency figure here would be invented,
 * so rarity — which is measured — carries that intent instead.
 */

export type ObjectiveDirection = 'lower-is-better' | 'higher-is-better'

export interface ObjectiveDefinition {
  readonly id: ObjectiveId
  readonly label: string
  readonly direction: ObjectiveDirection
  readonly unit: string
  /** Change of this size is one unit of improvement in the weighted score. */
  readonly scale: number
  readonly defaultWeight: number
  readonly measure: (document: ModelDocument, scope: RefinementScope) => number
  readonly description: string
}

const scopeParts = (document: ModelDocument, scope: RefinementScope) =>
  scope.partIds.map((id) => document.parts[id]).filter((part) => Boolean(part))

/**
 * Parts the region holds, in this document.
 *
 * Just the scope's ids that are still present — no inference. A refinement that
 * *adds* parts is measured by handing the caller's own extended scope in, which
 * `searchRefinements` does with exactly the ids the candidate created. Guessing
 * the region from subassembly membership instead was tried and is wrong: it
 * silently widens a one-plate selection to the whole assembly, so a metric would
 * report on parts the request never offered.
 */
function regionPartIds(document: ModelDocument, scope: RefinementScope): string[] {
  return scope.partIds.filter((id) => document.parts[id])
}

export const OBJECTIVES: Record<ObjectiveId, ObjectiveDefinition> = {
  silhouetteFidelity: {
    id: 'silhouetteFidelity',
    label: 'Silhouette fidelity',
    direction: 'higher-is-better',
    unit: 'IoU 0–1',
    scale: 0.05,
    defaultWeight: 2,
    description:
      'Intersection-over-union of the model outline against the reference, rasterized from compiled part '
      + 'bounds through the booklet camera. 1 means the outline did not move. Without a reference it is 1: '
      + 'nothing was asked of the shape.',
    measure: (document, scope) => {
      if (!scope.reference) return 1
      const frame = { min: scope.reference.frameMin, max: scope.reference.frameMax }
      return silhouetteIou(scope.reference, silhouetteOf(document, frame))
    },
  },

  supportMargin: {
    id: 'supportMargin',
    label: 'Tipping margin',
    direction: 'higher-is-better',
    unit: 'LDU',
    scale: STUD_LDU,
    defaultWeight: 1,
    description:
      'Shortest distance from the centre of mass to the edge of the support polygon, from `analyseStatics`. '
      + 'Negative means the model tips. Zero when nothing is measurable.',
    measure: (document) => staticsOf(document).support?.marginLdu ?? 0,
  },

  weakConnections: {
    id: 'weakConnections',
    label: 'Single-connection parts',
    direction: 'lower-is-better',
    unit: 'parts',
    scale: 1,
    defaultWeight: 1.5,
    description: 'Parts in the region held by exactly one connection — the classic "it falls off" warning.',
    measure: (document, scope) => {
      const region = new Set(regionPartIds(document, scope))
      return weakAttachmentsOf(document).filter((entry) => region.has(entry.partId)).length
    },
  },

  seamBonding: {
    id: 'seamBonding',
    label: 'Seam bonding',
    direction: 'higher-is-better',
    unit: 'fraction 0–1',
    scale: 0.1,
    defaultWeight: 1,
    description:
      'Share of interior joints that do not run through two courses. 1 is a fully staggered running bond; '
      + 'a region with no interior joints at all is 1 because there is nothing to stagger.',
    measure: (document, scope) => {
      const region = new Set(regionPartIds(document, scope))
      const rows = extractRows(document, region)
      const total = countSeams(rows)
      if (total === 0) return 1
      const stacked = stackedSeamsOf(document).filter((seam) => seam.partIds.some((id) => region.has(id))).length
      return Math.max(0, 1 - stacked / total)
    },
  },

  symmetryError: {
    id: 'symmetryError',
    label: 'Symmetry error',
    direction: 'lower-is-better',
    unit: 'fraction 0–1',
    scale: 0.1,
    defaultWeight: 1,
    description:
      'Share of the region with no counterpart across its best mirror plane, ignoring the request\'s stated '
      + 'exceptions. Parts whose compiled connectors are not symmetric about that plane count as unmatched, '
      + 'because reflecting them would produce a part nobody manufactures.',
    measure: (document, scope) => {
      const ids = regionPartIds(document, scope)
      return analyseSymmetry(document, scope, ids, boundsOfParts(document, ids)).error
    },
  },

  partCount: {
    id: 'partCount',
    label: 'Part count',
    direction: 'lower-is-better',
    unit: 'parts',
    scale: 4,
    defaultWeight: 0.5,
    description: 'Elements in the region. Fewer parts is cheaper to source and quicker to build.',
    measure: (document, scope) => regionPartIds(document, scope).length,
  },

  distinctElements: {
    id: 'distinctElements',
    label: 'Distinct elements',
    direction: 'lower-is-better',
    unit: 'element types',
    scale: 1,
    defaultWeight: 0.5,
    description:
      'Distinct part designs in the region. A model built from twelve designs is orderable; the same model '
      + 'built from forty is not.',
    measure: (document, scope) =>
      new Set(regionPartIds(document, scope).map((id) => document.parts[id].definitionId)).size,
  },

  rarityScore: {
    id: 'rarityScore',
    label: 'Rarity',
    direction: 'lower-is-better',
    unit: 'fraction 0–1',
    scale: 0.05,
    defaultWeight: 0.5,
    description:
      'Mean rarity of the region\'s elements, from the number of official set inventories each appears in. '
      + '0 is a staple element; approaching 1 is something almost never produced. This stands in for cost, '
      + 'which the catalog carries no data for.',
    measure: (document, scope) => {
      const ids = regionPartIds(document, scope)
      if (!ids.length) return 0
      let total = 0
      for (const id of ids) total += rarityOf(catalog.get(document.parts[id].definitionId)?.frequency ?? 0)
      return total / ids.length
    },
  },

  paletteConformance: {
    id: 'paletteConformance',
    label: 'Palette conformance',
    direction: 'higher-is-better',
    unit: 'fraction 0–1',
    scale: 0.1,
    defaultWeight: 0.5,
    description:
      'Share of the region whose colour is both inside the declared or inferred palette and observed on that '
      + 'element in an official set.',
    measure: (document, scope) => analysePalette(document, regionPartIds(document, scope)).conformance,
  },

  buildOrderComplexity: {
    id: 'buildOrderComplexity',
    label: 'Build-order complexity',
    direction: 'lower-is-better',
    unit: 'steps + islands',
    scale: 1,
    defaultWeight: 0.25,
    description:
      'Steps the generated sequence needs, plus five per part that begins a new island — a part attaching to '
      + 'nothing already built is what makes instructions unfollowable.',
    measure: (document) => {
      const order = computeBuildOrder(document)
      return order.steps.length + order.unsupportedPartIds.length * 5
    },
  },

  overhangLoad: {
    id: 'overhangLoad',
    label: 'Overhang load',
    direction: 'lower-is-better',
    unit: 'grams over capacity',
    scale: 50,
    defaultWeight: 1,
    description:
      'Mass hanging beyond the assumed clutch capacity holding it, summed over the region, from '
      + '`computeOverloads`. 0 means nothing is asking a stud to hold more than it is credited with.',
    measure: (document, scope) => {
      const region = new Set(regionPartIds(document, scope))
      let excess = 0
      for (const overhang of staticsOf(document).overloaded) {
        if (!overhang.partIds.some((id) => region.has(id))) continue
        excess += Math.max(0, overhang.grams - overhang.capacityGrams)
      }
      return excess
    },
  },

  steppedEdges: {
    id: 'steppedEdges',
    label: 'Stepped edges',
    direction: 'lower-is-better',
    unit: 'exposed treads',
    scale: 1,
    defaultWeight: 0.5,
    description:
      'Outside faces where a part\'s top is left uncovered by at least a stud — the staircase a slope or a '
      + 'curved element closes. Measured from compiled bounds, so a chamfer is not counted as a step.',
    measure: (document, scope) => {
      const region = new Set(regionPartIds(document, scope))
      return stepEdgesOf(document).filter((step) => region.has(step.lowerPartId) && step.treadStuds >= 0.9).length
    },
  },

  exposedStuds: {
    id: 'exposedStuds',
    label: 'Bare studs',
    direction: 'lower-is-better',
    unit: 'studs',
    scale: 4,
    defaultWeight: 0.25,
    description:
      'Upward-facing studs on top of the region that carry nothing. This is the surface-finish axis: tiling a '
      + 'deck, greebling a hull and capping a wall all reduce it, and none of them should move the outline.',
    measure: (document, scope) => {
      const region = new Set(regionPartIds(document, scope))
      return freeStudsOf(document).filter((stud) => region.has(stud.partId)).length
    },
  },
}

export const objectiveList: readonly ObjectiveDefinition[] = OBJECTIVE_IDS.map((id) => OBJECTIVES[id])

/** Every objective, measured. Complete by construction: a gap would hide a regression. */
export function measureAll(document: ModelDocument, scope: RefinementScope): MetricVector {
  const vector = {} as MetricVector
  for (const id of OBJECTIVE_IDS) vector[id] = OBJECTIVES[id].measure(document, scope)
  return vector
}

export const deltaOf = (before: MetricVector, after: MetricVector): MetricVector => {
  const delta = {} as MetricVector
  for (const id of OBJECTIVE_IDS) delta[id] = after[id] - before[id]
  return delta
}

/** Signed improvement on one objective, in scale units. Positive is better. */
export function improvementOf(id: ObjectiveId, before: number, after: number): number {
  const definition = OBJECTIVES[id]
  const signed = definition.direction === 'higher-is-better' ? after - before : before - after
  return signed / definition.scale
}

export type ObjectiveWeights = Partial<Record<ObjectiveId, number>>

export const defaultWeights = (): Record<ObjectiveId, number> =>
  Object.fromEntries(OBJECTIVE_IDS.map((id) => [id, OBJECTIVES[id].defaultWeight])) as Record<ObjectiveId, number>

/**
 * Caller weights over the defaults, clamped.
 *
 * The clamp is a safety property rather than tidiness: weights can come from a
 * language model, and an unbounded weight on one objective is indistinguishable
 * from switching the others off — which is how "prefer fewer parts" would turn
 * into "delete the region".
 */
export const MAX_WEIGHT = 8

export function resolveWeights(overrides: ObjectiveWeights = {}): Record<ObjectiveId, number> {
  const weights = defaultWeights()
  for (const id of OBJECTIVE_IDS) {
    const override = overrides[id]
    if (typeof override === 'number' && Number.isFinite(override)) {
      weights[id] = Math.max(0, Math.min(MAX_WEIGHT, override))
    }
  }
  return weights
}

/** Weighted improvement across the whole vector. Positive means net better. */
export function scoreOf(
  before: MetricVector,
  after: MetricVector,
  weights: Record<ObjectiveId, number>,
): number {
  let score = 0
  for (const id of OBJECTIVE_IDS) score += weights[id] * improvementOf(id, before[id], after[id])
  return score
}

/** Objectives the change made worse, so a regression is always named. */
export function regressionsOf(before: MetricVector, after: MetricVector): ObjectiveId[] {
  return OBJECTIVE_IDS.filter((id) => improvementOf(id, before[id], after[id]) < -1e-9)
}
