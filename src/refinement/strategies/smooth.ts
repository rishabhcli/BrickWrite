import { catalog, originForSurface } from '../../cad/catalog'
import { getPartBounds } from '../../cad/geometry'
import { applyMutations } from '../../cad/patch'
import { QUARTER_TURN_BASES } from '../../cad/placement'
import type { CadOperation, ModelDocument, PartDefinition, Vec3 } from '../../cad/types'
import { mutablePartIds } from '../analyse'
import { topPlaneOf } from '../topology'
import { stepEdgesOf } from '../cache'
import type { RefinementScope } from '../types'
import { dedupeBatches, makePart, sample, snapOnto, sourceOf, type Rng } from './support'

/**
 * Close a staircase with a slope or a curve.
 *
 * "Round this off" and "make the roof cleaner" both point at the same measurable
 * thing: a part whose top is left uncovered at an outside face, so the profile
 * reads as a flight of steps rather than a surface. Replacing that part with a
 * sloped or curved element of the same footprint closes the tread without moving
 * anything else.
 *
 * The replacement's *facing* is not guessed. LDraw slope origins and their
 * connector layouts differ part to part, so all four quarter turns are offered to
 * the snap solver against a document with the incumbent withdrawn, and only poses
 * the solver reports as genuinely mating with the structure below survive. The
 * remaining question — which facing actually improves the profile — is answered
 * by scoring, not by a rule about which way a wedge points.
 */

/** How far a smoothing element may exceed the part it replaces, in LDU. */
const ENVELOPE_SLACK_LDU = 2

const SMOOTH_CATEGORY = /Sloped|Curved/

function smoothCandidates(incumbentId: string): PartDefinition[] {
  const incumbent = catalog.get(incumbentId)
  const envelope = incumbent?.dimensions?.bounds
  if (!incumbent || !envelope) return []
  const span = (bounds: { min: Vec3; max: Vec3 }, axis: number) => bounds.max[axis] - bounds.min[axis]

  return catalog
    .placeable()
    .filter((candidate) => {
      if (candidate.canonicalId === incumbentId || candidate.helper) return false
      if (!SMOOTH_CATEGORY.test(candidate.category)) return false
      const bounds = candidate.dimensions?.bounds
      if (!bounds) return false
      // A smoothing element must fit the hole it is going into, in any quarter
      // turn — so the *sorted* horizontal spans are compared, not x against x.
      const wanted = [span(envelope, 0), span(envelope, 2)].sort((a, b) => a - b)
      const offered = [span(bounds, 0), span(bounds, 2)].sort((a, b) => a - b)
      if (offered[0] > wanted[0] + ENVELOPE_SLACK_LDU || offered[1] > wanted[1] + ENVELOPE_SLACK_LDU) return false
      if (span(bounds, 1) > span(envelope, 1) + ENVELOPE_SLACK_LDU) return false
      // It has to be able to sit on something, or it is not a replacement.
      return candidate.connectors.some((feature) => feature.family === 'anti-stud')
    })
    .sort((a, b) => b.frequency - a.frequency || a.canonicalId.localeCompare(b.canonicalId))
}

export const smooth = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const steps = stepEdgesOf(document).filter((step) => mutable.has(step.lowerPartId) && step.treadStuds >= 0.9)
  if (!steps.length) return []

  const batches: CadOperation[][] = []
  const byPart = new Map<string, typeof steps>()
  for (const step of steps) {
    const bucket = byPart.get(step.lowerPartId)
    if (bucket) bucket.push(step)
    else byPart.set(step.lowerPartId, [step])
  }

  for (const partId of sample([...byPart.keys()].sort(), 6, rng)) {
    const part = document.parts[partId]
    const source = sourceOf(document, partId)
    const bounds = getPartBounds(part)
    if (!source || !bounds.measured) continue

    // Snapping has to happen against the model *without* the incumbent: its own
    // anti-studs are occupying the studs the replacement needs to claim, so the
    // solver would rule every candidate out while the part is still there.
    const withoutPart = applyMutations(document, [{ kind: 'part', id: partId, value: null }])
    const supports = Object.keys(document.parts).filter((otherId) => {
      if (otherId === partId) return false
      const other = getPartBounds(document.parts[otherId])
      // LDraw is Y-down: a supporting part's stud plane is where the incumbent's
      // underside sits. Its bounding minimum is four LDU higher than that — the
      // top of its studs — so the box would never match.
      return other.measured && Math.abs(topPlaneOf(document.parts[otherId]) - bounds.max[1]) <= 1
    })
    if (!supports.length) continue

    const centreX = (bounds.min[0] + bounds.max[0]) / 2
    const centreZ = (bounds.min[2] + bounds.max[2]) / 2

    for (const candidate of smoothCandidates(part.definitionId).slice(0, 4)) {
      for (let turn = 0; turn < 4; turn += 1) {
        const cursor = {
          position: [centreX, originForSurface(candidate, bounds.max[1]), centreZ] as Vec3,
          basis: QUARTER_TURN_BASES[turn],
        }
        const snapped = snapOnto(withoutPart, candidate.canonicalId, cursor, supports, 1, part.color)
        if (!snapped) continue
        batches.push([
          { type: 'part.remove', partId },
          {
            type: 'part.add',
            part: makePart(
              `smooth|${partId}|${candidate.canonicalId}|${turn}`,
              candidate.canonicalId,
              snapped.transform,
              source,
              part.color,
            ),
          },
        ])
      }
    }
  }

  return dedupeBatches(sample(batches, 14, rng))
}
