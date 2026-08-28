import type { DesignBrief } from '../platform/contracts'
import { getPartDefinition, STUD_LDU } from '../cad/catalog'
import { findCollisions, residentGeometryProvider, type GeometryProvider } from '../cad/collision'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { analyseStatics, type StaticsReport } from '../cad/statics'
import { connectedComponent, findWeakAttachments } from '../cad/validation'
import { getDocumentBounds } from '../cad/geometry'
import type { BuildStep, ModelDocument } from '../cad/types'
import { silhouetteScore, type SilhouetteReference } from './silhouette'

/**
 * What a candidate measures, reported as a vector.
 *
 * The single-number score is the thing this module exists to avoid. A generator
 * ranked on one aggregate will happily trade a collision for a nicer silhouette,
 * or three extra components for a smaller part count, and the aggregate goes up
 * either way. Reporting the vector means a regression is visible as a regression
 * in the axis it happened on, and it means the *hard* axes — collisions,
 * connectivity, build order — can be treated as gates rather than as terms.
 *
 * Every field is measured through the kernel that owns it. Nothing here
 * re-derives geometry, mass or connectivity on its own.
 */
export interface MetricVector {
  readonly partCount: number
  /** How many distinct catalog identities the build uses. */
  readonly distinctElements: number
  /**
   * Mean log10 of set-appearance frequency, higher is more common.
   *
   * Log because frequency spans four orders of magnitude — a 1 × 2 plate turns
   * up in 28,106 inventories and a latticed window pane in 226 — so a linear
   * mean would be a report on whichever part happens to be most common.
   */
  readonly commonness: number
  /** Parts whose identity appears in fewer than 1,000 official sets. */
  readonly rarePartCount: number
  /** Fraction of parts whose colour is in the brief's palette. 1 when free. */
  readonly paletteConformance: number
  /** Colours used that the catalogue has never observed on that part. */
  readonly virtualColourCount: number
  readonly collisionCount: number
  /** Collisions decided by bounding boxes because geometry was not resident. */
  readonly unverifiedCollisionCount: number
  readonly componentCount: number
  readonly largestComponentFraction: number
  /** Parts held by exactly one connector. */
  readonly weakAttachmentCount: number
  readonly massGrams: number
  /** Fraction of parts whose mass could be measured from compiled volume. */
  readonly massCoverage: number
  /**
   * Distance from the centre of mass to the edge of the support polygon, LDU.
   * Negative means the model tips. Null when nothing rests on a ground plane.
   */
  readonly supportMarginLdu: number | null
  readonly overloadedJointCount: number
  readonly unsupportedPartCount: number
  readonly buildOrderValid: boolean
  readonly buildOrderViolations: number
  readonly buildStepCount: number
  /** Islands the build order had to start fresh — legitimate, but reported. */
  readonly buildOrderIslands: number
  /** Mean IoU against the supplied references, or null when none was given. */
  readonly silhouetteIou: number | null
  readonly silhouettePerView: Record<string, number>
  /** Measured extent in studs, [x, y, z]. */
  readonly extentStuds: readonly [number, number, number]
  /** True when the build is inside the brief's envelope. Null when unconstrained. */
  readonly withinEnvelope: boolean | null
  /** True when the part count is inside the brief's budget. Null when unbounded. */
  readonly withinBudget: boolean | null
  /** Fraction of the budget consumed. Null when unbounded. */
  readonly budgetUsed: number | null
}

export interface ScoreOptions {
  readonly references?: readonly SilhouetteReference[]
  readonly provideGeometry?: GeometryProvider
  /** Steps to verify. Defaults to the document's own, or a derived order. */
  readonly steps?: readonly BuildStep[]
}

/** Frequency below which an identity is treated as hard to source. */
const RARE_FREQUENCY = 1000

/**
 * Connected components, derived through the kernel's own reachability.
 *
 * `connectedComponent` is memoized on the document, so seeding it repeatedly
 * costs one graph build rather than one per component.
 */
export function componentsOf(document: ModelDocument): string[][] {
  const remaining = new Set(Object.keys(document.parts))
  const components: string[][] = []
  while (remaining.size) {
    const seed = remaining.values().next().value as string
    const component = connectedComponent(document, [seed])
    const resolved = component.length ? component : [seed]
    for (const id of resolved) remaining.delete(id)
    components.push(resolved)
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

export function scoreDocument(
  document: ModelDocument,
  brief: DesignBrief,
  options: ScoreOptions = {},
): MetricVector {
  const parts = Object.values(document.parts)
  const provide = options.provideGeometry ?? residentGeometryProvider

  const identities = new Map<string, number>()
  let frequencyTotal = 0
  let frequencyCount = 0
  let rare = 0
  let virtualColours = 0
  let inPalette = 0
  const palette = brief.palette ?? []

  for (const part of parts) {
    identities.set(part.definitionId, (identities.get(part.definitionId) ?? 0) + 1)
    const definition = getPartDefinition(part.definitionId)
    if (definition) {
      frequencyTotal += Math.log10(definition.frequency + 1)
      frequencyCount += 1
      if (definition.frequency < RARE_FREQUENCY) rare += 1
      if (definition.availableColors.length && !definition.availableColors.includes(part.color)) virtualColours += 1
      if (!definition.availableColors.length) virtualColours += 1
    }
    if (!palette.length || palette.includes(part.color)) inPalette += 1
  }

  const collisions = findCollisions(document, { provide })
  const components = componentsOf(document)
  const statics: StaticsReport = analyseStatics(document)

  const steps = options.steps ?? (document.steps.length ? document.steps : computeBuildOrder(document).steps)
  const order = verifyBuildOrder(document, steps)
  const derived = computeBuildOrder(document)

  const silhouette = options.references?.length ? silhouetteScore(document, options.references) : null
  const perView: Record<string, number> = {}
  if (silhouette) {
    for (const [view, comparison] of Object.entries(silhouette.perView)) perView[view] = comparison.iou
  }

  const size = getDocumentBounds(document).size
  const extentStuds: [number, number, number] = [size[0] / STUD_LDU, size[1] / STUD_LDU, size[2] / STUD_LDU]
  const envelope = brief.envelopeStuds
  const budget = brief.partBudget

  return {
    partCount: parts.length,
    distinctElements: identities.size,
    commonness: frequencyCount ? frequencyTotal / frequencyCount : 0,
    rarePartCount: rare,
    paletteConformance: parts.length ? inPalette / parts.length : 1,
    virtualColourCount: virtualColours,
    collisionCount: collisions.length,
    unverifiedCollisionCount: collisions.filter((contact) => contact.certainty === 'unknown').length,
    componentCount: components.length,
    largestComponentFraction: parts.length ? (components[0]?.length ?? 0) / parts.length : 1,
    weakAttachmentCount: findWeakAttachments(document).length,
    massGrams: statics.mass.grams,
    massCoverage: statics.coverage,
    supportMarginLdu: statics.support ? statics.support.marginLdu : null,
    overloadedJointCount: statics.overloaded.length,
    unsupportedPartCount: statics.unsupportedPartIds.length,
    buildOrderValid: order.valid,
    buildOrderViolations: order.violations.length,
    buildStepCount: steps.length,
    buildOrderIslands: derived.unsupportedPartIds.length,
    silhouetteIou: silhouette ? silhouette.mean : null,
    silhouettePerView: perView,
    extentStuds,
    withinEnvelope: envelope
      ? extentStuds.every((value, axis) => value <= envelope[axis] + 1e-6)
      : null,
    withinBudget: budget === null || budget === undefined ? null : parts.length <= budget,
    budgetUsed: budget === null || budget === undefined ? null : parts.length / budget,
  }
}

/**
 * The axes a candidate must pass to be offered at all.
 *
 * Separated from the vector because these are not preferences being traded off:
 * a model that interpenetrates itself, or that cannot be built in an order, is
 * not a worse candidate — it is not a candidate.
 */
export interface HardGateResult {
  readonly passed: boolean
  readonly failures: string[]
}

export function evaluateHardGates(metrics: MetricVector, brief: DesignBrief): HardGateResult {
  const failures: string[] = []
  if (metrics.collisionCount > 0) {
    failures.push(`${metrics.collisionCount} collision(s) remain in the candidate`)
  }
  if (!metrics.buildOrderValid) {
    failures.push(`${metrics.buildOrderViolations} step(s) introduce a part that attaches to nothing placed earlier`)
  }
  if (metrics.withinBudget === false) {
    failures.push(`${metrics.partCount} parts exceeds the ${brief.partBudget}-part budget`)
  }
  if (metrics.withinEnvelope === false) {
    failures.push(
      `the build measures ${metrics.extentStuds.map((value) => value.toFixed(1)).join(' × ')} studs, past the requested envelope`,
    )
  }
  if (brief.palette.length && metrics.paletteConformance < 1) {
    failures.push(`${Math.round((1 - metrics.paletteConformance) * 100)}% of parts fall outside the requested palette`)
  }
  return { passed: failures.length === 0, failures }
}

/**
 * Axis-by-axis difference between two candidates.
 *
 * Deliberately returns every axis that moved rather than a verdict. Which
 * direction counts as better is a question about the brief — a sculpture wants
 * rarity, a playset wants commonness — and this module does not have an opinion.
 */
export function diffMetrics(a: MetricVector, b: MetricVector): Array<{ axis: string; from: number; to: number }> {
  const numericAxes: Array<keyof MetricVector> = [
    'partCount',
    'distinctElements',
    'commonness',
    'rarePartCount',
    'paletteConformance',
    'virtualColourCount',
    'collisionCount',
    'unverifiedCollisionCount',
    'componentCount',
    'largestComponentFraction',
    'weakAttachmentCount',
    'massGrams',
    'massCoverage',
    'overloadedJointCount',
    'unsupportedPartCount',
    'buildOrderViolations',
    'buildStepCount',
    'buildOrderIslands',
  ]
  const changed: Array<{ axis: string; from: number; to: number }> = []
  for (const axis of numericAxes) {
    const from = a[axis] as number
    const to = b[axis] as number
    if (Math.abs(from - to) > 1e-9) changed.push({ axis, from, to })
  }
  for (const axis of ['supportMarginLdu', 'silhouetteIou'] as const) {
    const from = a[axis]
    const to = b[axis]
    if (from === null || to === null) {
      if (from !== to) changed.push({ axis, from: from ?? Number.NaN, to: to ?? Number.NaN })
      continue
    }
    if (Math.abs(from - to) > 1e-9) changed.push({ axis, from, to })
  }
  return changed
}

/** How many axes separate two candidates. Used to assert diversity is material. */
export const metricDistance = (a: MetricVector, b: MetricVector): number => diffMetrics(a, b).length
