import { catalog } from '../../cad/catalog'
import type { CadOperation, ModelDocument, PartDefinition } from '../../cad/types'
import { analysePalette, mutablePartIds, rarityOf } from '../analyse'
import { definitionFeatureKeys, matedLocalFeatures } from '../topology'
import type { RefinementScope } from '../types'
import { dedupeBatches, sample, substitution, type Rng } from './support'

/**
 * Swap an element for a more ordinary one that connects the same way.
 *
 * "Reduce rare pieces" and "use fewer different elements" are the same operation
 * seen from two sides, and both are only safe if the replacement carries every
 * connector the incumbent is *currently using*. Features the incumbent has and is
 * not using do not matter — which is exactly why a headlight brick can become a
 * plain 1 × 1 when nothing is mounted in its recess, and cannot when something is.
 *
 * Set-appearance frequency is the ranking signal because it is the only
 * availability evidence the catalog carries. It is not a price: the compiled
 * catalog has no price data at all, so a part that is cheap and obscure and a
 * part that is dear and obscure are indistinguishable here, and this module does
 * not pretend otherwise.
 *
 * Colour is handled here too, and for the same reason: "which element goes in
 * this position" is one question, and a brick in a colour the region does not use
 * — or in a colour that element was never produced in — is the same defect as a
 * brick of the wrong design. Recolouring is the cheapest repair available for it,
 * so it is offered alongside the design swaps rather than needing its own pass.
 */

/** How far a replacement may exceed the incumbent's envelope, in LDU. */
const ENVELOPE_SLACK_LDU = 4

interface Candidate {
  readonly definition: PartDefinition
  readonly rarityGain: number
}

function fitsEnvelope(incumbent: PartDefinition, candidate: PartDefinition): boolean {
  const a = incumbent.dimensions?.bounds
  const b = candidate.dimensions?.bounds
  if (!a || !b) return false
  return [0, 1, 2].every(
    (axis) => b.min[axis] >= a.min[axis] - ENVELOPE_SLACK_LDU && b.max[axis] <= a.max[axis] + ENVELOPE_SLACK_LDU,
  )
}

/**
 * Replacements for one definition, best first.
 *
 * `required` is the set of connectors the placed instance is actually mated
 * through, in its own frame. Requiring the candidate to offer all of them is
 * what makes the swap connection-preserving without running the solver.
 */
export function interchangeableWith(
  definitionId: string,
  required: readonly string[],
  color: number,
  prefer: ReadonlySet<string>,
): Candidate[] {
  const incumbent = catalog.get(definitionId)
  if (!incumbent) return []
  const incumbentRarity = rarityOf(incumbent.frequency)
  const out: Candidate[] = []

  for (const candidate of catalog.placeable()) {
    if (candidate.canonicalId === definitionId) continue
    if (candidate.helper) continue
    if (!fitsEnvelope(incumbent, candidate)) continue
    if (candidate.availableColors.length && !candidate.availableColors.includes(color)) continue
    const offered = definitionFeatureKeys(candidate.canonicalId)
    if (!required.every((key) => offered.has(key))) continue

    const rarityGain = incumbentRarity - rarityOf(candidate.frequency)
    // Either the element is genuinely more available, or the region already uses
    // it — in which case the swap costs a distinct element instead of adding one.
    if (rarityGain <= 0 && !prefer.has(candidate.canonicalId)) continue
    out.push({ definition: candidate, rarityGain })
  }

  return out.sort(
    (a, b) =>
      Number(prefer.has(b.definition.canonicalId)) - Number(prefer.has(a.definition.canonicalId)) ||
      b.rarityGain - a.rarityGain ||
      b.definition.frequency - a.definition.frequency ||
      a.definition.canonicalId.localeCompare(b.definition.canonicalId),
  )
}

export const substitute = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = mutablePartIds(document, scope)
  if (!mutable.length) return []

  const usage = new Map<string, string[]>()
  for (const partId of mutable) {
    const definitionId = document.parts[partId].definitionId
    const bucket = usage.get(definitionId)
    if (bucket) bucket.push(partId)
    else usage.set(definitionId, [partId])
  }
  // Definitions the region already leans on. Swapping *toward* one of these
  // lowers the distinct-element count; swapping away from one raises it.
  const staples = new Set(
    [...usage.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([definitionId]) => definitionId),
  )

  const batches: CadOperation[][] = []
  const wholeGroup: CadOperation[] = []

  for (const [definitionId, partIds] of [...usage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Every instance of a definition is swapped together or not at all: replacing
    // three of five identical bricks is how a region ends up with more distinct
    // elements than it started with.
    const color = document.parts[partIds[0]].color
    if (partIds.some((id) => document.parts[id].color !== color)) continue
    const required = [...new Set(partIds.flatMap((id) => matedLocalFeatures(document, id)))].sort()
    const candidates = interchangeableWith(definitionId, required, color, staples)
    if (!candidates.length) continue

    for (const candidate of candidates.slice(0, 2)) {
      const operations = partIds.flatMap((partId) =>
        substitution(document, partId, candidate.definition.canonicalId, `substitute|${partId}|${candidate.definition.canonicalId}`),
      )
      if (operations.length) batches.push(operations)
    }

    const best = candidates[0]
    wholeGroup.push(
      ...partIds.flatMap((partId) =>
        substitution(document, partId, best.definition.canonicalId, `substitute|${partId}|${best.definition.canonicalId}`),
      ),
    )
  }

  if (wholeGroup.length) batches.push(wholeGroup)
  batches.push(...recolourBatches(document, mutable))
  return dedupeBatches(sample(batches, 10, rng))
}

/**
 * Bring outliers back into the region's colour.
 *
 * The target colour has to be one the element was actually produced in, or the
 * repair trades a palette outlier for a virtual colour and validation reports the
 * same part again for a different reason.
 */
function recolourBatches(document: ModelDocument, mutable: readonly string[]): CadOperation[][] {
  const palette = analysePalette(document, mutable)
  const outliers = palette.outlierPartIds.filter((id) => mutable.includes(id))
  if (!outliers.length || !palette.used.length) return []

  const batches: CadOperation[][] = []
  const all: CadOperation[] = []
  for (const target of palette.reference.slice(0, 2)) {
    const operations: CadOperation[] = []
    for (const partId of outliers) {
      const part = document.parts[partId]
      if (!part || part.color === target) continue
      const definition = catalog.get(part.definitionId)
      if (definition?.availableColors.length && !definition.availableColors.includes(target)) continue
      operations.push({ type: 'part.recolor', partId, color: target })
    }
    if (!operations.length) continue
    batches.push(operations)
    if (!all.length) all.push(...operations)
  }
  return batches
}
