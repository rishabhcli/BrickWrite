/**
 * Compact status the WebMCP read surface can report without loading the
 * generation, refinement or share chunks.
 *
 * Hosts write here when they exist. `workspace_get` reads it. Adapter stop
 * disposes every registered host so a remount cannot inherit another editor's
 * ghost or search.
 */

export interface GenerationSurface {
  briefPhase: string
  runPhase: string
  candidateCount: number
  selectedCandidateId: string | null
  ghost: boolean
}

export interface RefinementSurface {
  status: string
  proposalCount: number
  selectedId: string | null
}

export interface ShareSurface {
  slug: string | null
  contentHash: string | null
}

export const surfaceSnapshot: {
  generation: GenerationSurface | null
  refinement: RefinementSurface | null
  share: ShareSurface
} = {
  generation: null,
  refinement: null,
  share: { slug: null, contentHash: null },
}

const disposers = new Set<() => void>()
const reviewDiscards = new Set<() => void>()

export function registerSurfaceDisposer(dispose: () => void): () => void {
  disposers.add(dispose)
  return () => disposers.delete(dispose)
}

export function onReviewDiscard(discard: () => void): () => void {
  reviewDiscards.add(discard)
  return () => reviewDiscards.delete(discard)
}

/** Withdraw generation ghosts and drop in-flight refinement before a project switch. */
export function discardReview(): void {
  for (const discard of reviewDiscards) discard()
}

export function disposeSurfaces(): void {
  const pending = [...disposers]
  disposers.clear()
  reviewDiscards.clear()
  for (const dispose of pending) dispose()
  surfaceSnapshot.generation = null
  surfaceSnapshot.refinement = null
  surfaceSnapshot.share = { slug: null, contentHash: null }
}
