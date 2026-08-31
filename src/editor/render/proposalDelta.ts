import { canonicalTransform } from '../../cad/math'
import type { ModelDocument, PartInstance, Proposal } from '../../cad/types'

/**
 * What a proposal would add and what it would remove.
 *
 * Its own module because it is called from two places that must agree — the
 * ghost that draws the wave, and the counter that decides how long the wave is —
 * and because it is the kind of thing that quietly becomes per-frame work. It
 * was: `GhostProposal` re-renders on every frame of the reveal (the reveal index
 * is a prop), and it recomputed this inline, building two canonical-transform
 * *strings* for every part in the proposal each time. On a generated proposal of
 * a few thousand parts that is thousands of string allocations a frame for the
 * whole second the wave is running.
 *
 * A part counts as added when it is new, recoloured, or repositioned. Comparing
 * poses through `canonicalTransform` rather than by reference is deliberate: the
 * preview document is a separate object graph, so every transform in it is a
 * different object whether or not it describes a different pose.
 */
export interface ProposalDelta {
  readonly added: readonly PartInstance[]
  readonly removed: readonly PartInstance[]
}

export function proposalDelta(proposal: Proposal, current: ModelDocument): ProposalDelta {
  const preview = proposal.previewDocument.parts
  const added: PartInstance[] = []
  for (const part of Object.values(preview)) {
    const original = current.parts[part.id]
    if (
      !original ||
      original.color !== part.color ||
      canonicalTransform(original.transform) !== canonicalTransform(part.transform)
    ) {
      added.push(part)
    }
  }
  const removed = Object.values(current.parts).filter((part) => !preview[part.id])
  return { added, removed }
}
