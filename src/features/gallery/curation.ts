import { sanitizeTag, sanitizeText } from '../share/sanitize'
import type { Collection, GalleryEntry } from '../share/types'

/**
 * Gallery search, faceting and curation.
 *
 * The hard rule, stated once and enforced by the absence of any other code
 * path: **nothing here manufactures a signal.** There is no popularity score,
 * no engagement weighting, no "trending" and no filler. Ranking uses only what
 * the publication actually measured — its title, its tags, its author, its part
 * count and when it was published — and a query that matches nothing returns
 * nothing, which the UI says out loud.
 *
 * Collections are curated by a named person and stored. There is no algorithmic
 * collection, because an algorithm with no engagement data would be a random
 * number with a title on it.
 */

export type GallerySort = 'newest' | 'oldest' | 'largest' | 'smallest' | 'title'

export const GALLERY_SORTS: ReadonlyArray<{ id: GallerySort; label: string }> = Object.freeze([
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'largest', label: 'Most parts' },
  { id: 'smallest', label: 'Fewest parts' },
  { id: 'title', label: 'A–Z' },
])

export interface GalleryQuery {
  /** Free text over title, description, tags and author. */
  text?: string
  /** Every tag must be present. */
  tags?: readonly string[]
  collectionId?: string | null
  /** Only publications whose validation passed at publish time. */
  healthyOnly?: boolean
  sort?: GallerySort
  limit?: number
  offset?: number
}

export interface GalleryFacet {
  tag: string
  count: number
}

export interface GalleryResult {
  entries: GalleryEntry[]
  /** Matches before paging. */
  total: number
  offset: number
  /** Tag counts across the matched set, for the facet rail. */
  facets: GalleryFacet[]
  /** Terms that matched nothing, so an impossible query says why. */
  unmatchedTerms: string[]
  /** True when the source set is empty rather than the query being too narrow. */
  sourceEmpty: boolean
}

const tokenise = (text: string) =>
  sanitizeText(text, 160)
    .toLowerCase()
    .split(/[^a-z0-9+#._-]+/)
    .filter((term) => term.length > 0)

/** Everything a free-text query is allowed to see. */
function haystack(entry: GalleryEntry): string {
  return [entry.title, entry.description, entry.tags.join(' '), entry.author?.displayName ?? '']
    .join(' ')
    .toLowerCase()
}

/**
 * Relevance, from the fields alone.
 *
 * An exact tag beats a title match beats a body match, and a tie breaks on
 * recency. That is the whole model: no click-through, no dwell time, no
 * boosting. It is a weaker ranker than a real search engine and it is honest
 * about what it knows.
 */
function score(entry: GalleryEntry, terms: readonly string[]): number {
  if (!terms.length) return 0
  const title = entry.title.toLowerCase()
  const tags = new Set(entry.tags)
  let total = 0
  for (const term of terms) {
    if (tags.has(term)) total += 6
    if (title === term) total += 8
    else if (title.includes(term)) total += 4
    if ((entry.author?.displayName ?? '').toLowerCase().includes(term)) total += 3
    if (entry.description.toLowerCase().includes(term)) total += 1
  }
  return total
}

function comparator(sort: GallerySort): (a: GalleryEntry, b: GalleryEntry) => number {
  switch (sort) {
    case 'oldest':
      return (a, b) => a.publishedAt.localeCompare(b.publishedAt)
    case 'largest':
      return (a, b) => b.partCount - a.partCount || a.title.localeCompare(b.title)
    case 'smallest':
      return (a, b) => a.partCount - b.partCount || a.title.localeCompare(b.title)
    case 'title':
      return (a, b) => a.title.localeCompare(b.title)
    case 'newest':
    default:
      return (a, b) => b.publishedAt.localeCompare(a.publishedAt)
  }
}

export function searchGallery(
  source: readonly GalleryEntry[],
  query: GalleryQuery = {},
  collections: readonly Collection[] = [],
): GalleryResult {
  const terms = tokenise(query.text ?? '')
  const requiredTags = (query.tags ?? []).map(sanitizeTag).filter(Boolean)
  const collection = query.collectionId
    ? (collections.find((entry) => entry.id === query.collectionId) ?? null)
    : null
  const allowedSlugs = collection ? new Set(collection.slugs) : null

  let matched = source.filter((entry) => {
    if (allowedSlugs && !allowedSlugs.has(entry.slug)) return false
    if (query.healthyOnly && !entry.healthy) return false
    for (const tag of requiredTags) if (!entry.tags.includes(tag)) return false
    if (!terms.length) return true
    const text = haystack(entry)
    return terms.every((term) => text.includes(term))
  })

  // Which query terms matched nothing at all, so the UI can name them rather
  // than showing an unexplained empty result.
  const unmatchedTerms = terms.filter((term) => !source.some((entry) => haystack(entry).includes(term)))

  if (terms.length) {
    matched = [...matched].sort(
      (a, b) => score(b, terms) - score(a, terms) || b.publishedAt.localeCompare(a.publishedAt),
    )
  } else {
    matched = [...matched].sort(comparator(query.sort ?? 'newest'))
  }

  const counts = new Map<string, number>()
  for (const entry of matched) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const facets = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.max(1, Math.min(120, query.limit ?? 24))

  return {
    entries: matched.slice(offset, offset + limit),
    total: matched.length,
    offset,
    facets,
    unmatchedTerms,
    sourceEmpty: source.length === 0,
  }
}

/**
 * Resolves a collection's slugs against the entries actually available.
 *
 * A curator's list can name a publication that has since been revoked or
 * hidden. Those are dropped and *counted*, so the collection can say "2 of 6
 * entries are no longer available" instead of quietly shrinking.
 */
export function resolveCollection(
  collection: Collection,
  source: readonly GalleryEntry[],
): { entries: GalleryEntry[]; missing: number } {
  const bySlug = new Map(source.map((entry) => [entry.slug, entry]))
  const entries = collection.slugs.map((slug) => bySlug.get(slug)).filter((entry): entry is GalleryEntry => Boolean(entry))
  return { entries, missing: collection.slugs.length - entries.length }
}

/** Fork lineage: which published entries descend from a given slug. */
export function forkChildren(source: readonly GalleryEntry[], slug: string): GalleryEntry[] {
  return source
    .filter((entry) => entry.forkedFromSlug === slug)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
}

/**
 * The chain from an entry back to its earliest published ancestor.
 *
 * Stops at the first slug that is not in the source set — a fork of something
 * unlisted or revoked has an ancestor the gallery cannot show, and the chain
 * says so by ending rather than by inventing a link.
 */
export function forkAncestry(source: readonly GalleryEntry[], slug: string): GalleryEntry[] {
  const bySlug = new Map(source.map((entry) => [entry.slug, entry]))
  const chain: GalleryEntry[] = []
  const seen = new Set<string>()
  let current = bySlug.get(slug)
  while (current?.forkedFromSlug && !seen.has(current.forkedFromSlug)) {
    seen.add(current.forkedFromSlug)
    const parent = bySlug.get(current.forkedFromSlug)
    if (!parent) break
    chain.push(parent)
    current = parent
  }
  return chain
}
