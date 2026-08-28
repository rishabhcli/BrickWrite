import { transformsEqual } from '../../cad/math'
import type { CadOperation, ModelDocument } from '../../cad/types'
import { analyseSymmetry, mutablePartIds } from '../analyse'
import { canMirror, mirrorTransform } from '../mirror'
import { boundsOfParts } from '../silhouette'
import type { RefinementScope } from '../types'
import { dedupeBatches, makePart, sample, sourceOf, type Rng } from './support'

/**
 * Make a region symmetric, except where it was asked not to be.
 *
 * "Symmetric except for the antenna" is the normal form of this request, and the
 * exception list is why it has to be a first-class input rather than something
 * inferred: an aerial, a pilot's hatch or a single asymmetric intake are usually
 * the *point* of the model, and a symmetry pass that quietly duplicates them has
 * destroyed the design while improving its score.
 *
 * Two readings are offered rather than one, because both are legitimate and the
 * request rarely says which is meant: add the missing counterparts, or remove the
 * parts that have none. The metric vector shows what each costs — the first
 * spends part count, the second spends the region itself — and the operator picks.
 *
 * Nothing is reflected that cannot be built. A part whose compiled connectors are
 * not symmetric about the mirror plane is reported as unmirrorable and left
 * alone, so a refinement never produces a left-handed copy of a part that is only
 * moulded right-handed.
 */

export const symmetrize = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const present = scope.partIds.filter((id) => document.parts[id])
  if (present.length < 2) return []

  const report = analyseSymmetry(document, scope, present, boundsOfParts(document, present))
  if (!report.unmatchedPartIds.length) return []

  const additions: CadOperation[] = []
  const removals: CadOperation[] = []
  const everyPart = Object.values(document.parts)

  for (const partId of report.unmatchedPartIds) {
    const part = document.parts[partId]
    const source = sourceOf(document, partId)
    if (!part || !source) continue
    if (mutable.has(partId)) removals.push({ type: 'part.remove', partId })

    if (!canMirror(document, partId, report.axis)) continue
    const wanted = mirrorTransform(part.transform, report.axis, report.planeLdu)
    // A pose the mirror lands on top of is not a missing counterpart; it is a
    // different element in the right place, and adding a second one there would
    // be a collision rather than a repair.
    if (everyPart.some((other) => transformsEqual(other.transform, wanted, 0.4))) continue
    additions.push({
      type: 'part.add',
      part: makePart(`symmetrize|${partId}|${report.axis}`, part.definitionId, wanted, source, part.color),
    })
  }

  const batches: CadOperation[][] = []
  if (additions.length) {
    batches.push(additions)
    // Single mirrors as well: a region that is asymmetric in four places may only
    // want three of them fixed, and one-part batches let the search find that.
    for (const single of sample(additions, 4, rng)) batches.push([single])
  }
  if (removals.length) batches.push(removals)
  return dedupeBatches(batches)
}
