import { OG_CARD } from './render/presets'
import type { GalleryEntry, Publication } from './types'

/**
 * Publication to gallery tile.
 *
 * A deliberately lossy projection, and the losses are the point: the tile
 * carries what was actually measured — parts, steps, the validation verdict,
 * the publication date, the fork it came from — and nothing else. There is no
 * view count, no like count, no "trending" score and no popularity rank in this
 * function, because there is no honest source for one. A zero rendered as
 * "0 views" is a claim, and it is not a claim this product has earned.
 *
 * Kept beside the share types rather than in `src/features/gallery` so the
 * Pages Function can build a feed without importing React.
 */
export function galleryEntryFrom(publication: Publication): GalleryEntry {
  const card =
    publication.cards.find((entry) => entry.preset === 'square') ??
    publication.cards.find((entry) => entry.preset === OG_CARD) ??
    publication.cards[0] ??
    null

  return {
    publicationId: publication.id,
    slug: publication.slug,
    title: publication.title,
    description: publication.description,
    tags: [...publication.tags],
    author: publication.author,
    publishedAt: publication.publishedAt,
    partCount: publication.summary.partCount,
    stepCount: publication.summary.stepCount,
    healthy: publication.summary.validation.healthy,
    cardPreset: card ? card.preset : null,
    forkedFromSlug: publication.fork?.slug ?? null,
  }
}
