import type { ModelDocument, ValidationReport } from '../../cad/types'
import { base32, canonicalBytes, contentHash, randomBytes } from './canonical'
import { sanitizeDescription, sanitizeTags, sanitizeText, sanitizeTitle, sanitizeUrl, slugStem, LIMITS } from './sanitize'
import { serializePublishedDocument, summarisePublication } from './serialize'
import {
  DEFAULT_CAPABILITIES,
  PUBLICATION_SCHEMA_VERSION,
  ShareError,
  type ForkProvenance,
  type Publication,
  type PublicationAuthor,
  type PublicationCard,
  type ShareCapabilities,
  type Visibility,
} from './types'

/**
 * Publishing: capturing a release at an exact revision.
 *
 * The headline guarantee is that a publication never moves. It is produced by
 * copying the document into a fresh structure (`serializePublishedDocument`),
 * hashing the canonical bytes of that copy, and freezing the result. Nothing in
 * the record points back into the live document, so an edit an hour later — or
 * a mutation of the very object that was passed in — cannot reach it.
 *
 * Republishing is deliberately *not* an update. It mints a new publication with
 * its own slug and its own revision, so an existing link keeps showing the
 * thing it was shared for. The store enforces that with an
 * `IMMUTABLE` rejection; this module makes it structurally true.
 */

export const DEFAULT_LICENSE = 'CC BY-SA 4.0'

/** 12 base32 characters — 60 bits — appended to every slug. */
const SLUG_ENTROPY_BYTES = 8

export interface PublishRequest {
  document: ModelDocument
  /**
   * Validation for this exact revision, when the caller has one. Passing
   * `null` publishes with an explicitly unvalidated badge rather than a
   * fabricated pass.
   */
  validation?: ValidationReport | null
  visibility: Visibility
  capabilities?: Partial<ShareCapabilities>
  title?: string
  description?: string
  tags?: readonly string[]
  /** Attribution. `null` publishes anonymously and the page says so. */
  author?: PublicationAuthor | null
  license?: string
  fork?: ForkProvenance | null
  /** Cards rendered from this same snapshot by the caller. */
  cards?: readonly PublicationCard[]
  now?: Date
}

export function normaliseAuthor(author: PublicationAuthor | null | undefined): PublicationAuthor | null {
  if (!author) return null
  const displayName = sanitizeText(author.displayName, LIMITS.authorName)
  // An author with no name is not an author. Rather than inventing "Anonymous
  // Builder" and implying an account, the publication carries null.
  if (!displayName) return null
  const handle = sanitizeText(author.handle ?? '', LIMITS.handle).replace(/[^A-Za-z0-9_.-]/g, '')
  return { displayName, handle: handle || null, url: sanitizeUrl(author.url) }
}

function resolveCapabilities(visibility: Visibility, requested: Partial<ShareCapabilities> | undefined): ShareCapabilities {
  const base = { ...DEFAULT_CAPABILITIES, ...requested }
  // A private publication grants nothing to anybody but its owner, whatever the
  // capability flags say. Storing the flags anyway means flipping visibility to
  // unlisted later restores the publisher's intent instead of resetting it.
  return {
    view: Boolean(base.view),
    comment: Boolean(base.comment),
    fork: Boolean(base.fork),
    download: Boolean(base.download),
    embed: Boolean(base.embed),
  }
}

export function mintSlug(title: string): string {
  const stem = slugStem(title)
  const suffix = base32(randomBytes(SLUG_ENTROPY_BYTES)).slice(0, 12)
  return stem ? `${stem}-${suffix}` : `model-${suffix}`
}

/**
 * Builds an immutable publication from a live document.
 *
 * Async because the content hash goes through WebCrypto — the same digest used
 * for token secrets, rather than a second hand-rolled hash in the codebase.
 */
export async function createPublication(request: PublishRequest): Promise<Publication> {
  const { document } = request
  if (!document || typeof document !== 'object') {
    throw new ShareError('INVALID_INPUT', 'A publication needs a document to capture.')
  }
  if (!Number.isInteger(document.revision) || document.revision < 0) {
    throw new ShareError('INVALID_INPUT', `Revision ${String(document.revision)} is not a document revision.`)
  }

  const published = serializePublishedDocument(document)
  const summary = summarisePublication(published, document, request.validation ?? null)
  const publishedAt = (request.now ?? new Date()).toISOString()

  // The title falls back to the document's own name, and then to a neutral
  // placeholder. It never falls back to the author's name or the part count,
  // both of which would read as a claim the publisher did not make.
  const title = sanitizeTitle(request.title || document.name) || 'Untitled build'
  const cards = normaliseCards(request.cards ?? [])

  const publication: Publication = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    id: `pub_${base32(randomBytes(16))}`,
    slug: mintSlug(title),
    visibility: request.visibility,
    capabilities: resolveCapabilities(request.visibility, request.capabilities),
    title,
    description: sanitizeDescription(request.description ?? ''),
    tags: sanitizeTags(request.tags ?? []),
    author: normaliseAuthor(request.author),
    license: sanitizeText(request.license || DEFAULT_LICENSE, 64),
    publishedAt,
    revision: published.revision,
    contentHash: await contentHash(published),
    document: published,
    summary,
    cards,
    fork: request.fork ? normaliseForkProvenance(request.fork) : null,
    revokedAt: null,
    moderation: null,
  }

  return deepFreeze(publication)
}

function normaliseCards(cards: readonly PublicationCard[]): PublicationCard[] {
  const seen = new Set<string>()
  const out: PublicationCard[] = []
  for (const card of cards) {
    if (seen.has(card.preset)) continue
    if (!/^[0-9a-f]{64}$/.test(card.sha256)) {
      throw new ShareError('INVALID_INPUT', `Card "${card.preset}" does not carry a SHA-256 of its own bytes.`)
    }
    seen.add(card.preset)
    out.push({
      preset: card.preset,
      width: card.width,
      height: card.height,
      contentType: 'image/png',
      sha256: card.sha256,
      byteLength: card.byteLength,
      frames: card.frames,
      alt: sanitizeText(card.alt, 200),
    })
  }
  return out.sort((a, b) => (a.preset < b.preset ? -1 : a.preset > b.preset ? 1 : 0))
}

function normaliseForkProvenance(fork: ForkProvenance): ForkProvenance {
  return {
    publicationId: sanitizeText(fork.publicationId, 96),
    slug: sanitizeText(fork.slug, LIMITS.slug),
    sourceRevision: Number.isInteger(fork.sourceRevision) ? fork.sourceRevision : 0,
    sourceContentHash: /^[0-9a-f]{64}$/.test(fork.sourceContentHash) ? fork.sourceContentHash : '',
    sourceTitle: sanitizeTitle(fork.sourceTitle),
    sourceAuthor: normaliseAuthor(fork.sourceAuthor),
    forkedAt: fork.forkedAt,
  }
}

/**
 * Freezes the whole record, transitively.
 *
 * Belt to the serialiser's braces: the snapshot already shares no memory with
 * the document, and now nothing downstream can edit it in place either. A test
 * that tries to mutate a publication gets a `TypeError` in strict mode rather
 * than a quietly changed artifact.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  return value
}

/** Canonical bytes of the whole publication record. */
export const publicationBytes = (publication: Publication) => canonicalBytes(publication)

/**
 * Recomputes the content hash and compares it to the stored one.
 *
 * Run on read as well as on write, so a record that was tampered with in
 * storage is caught at the point of use rather than served.
 */
export async function verifyPublicationIntegrity(publication: Publication): Promise<boolean> {
  return (await contentHash(publication.document)) === publication.contentHash
}

/** Marks a publication revoked. The record survives; access does not. */
export function revokePublication(publication: Publication, now = new Date()): Publication {
  if (publication.revokedAt) return publication
  return deepFreeze({ ...publication, revokedAt: now.toISOString() })
}

/**
 * Applies a visibility or capability change.
 *
 * The snapshot, revision and content hash are carried through untouched — a
 * publisher can close a publication down or open it up without republishing,
 * and doing so must not alter the artifact anybody already has a link to.
 */
export function updatePublicationAccess(
  publication: Publication,
  changes: { visibility?: Visibility; capabilities?: Partial<ShareCapabilities> },
): Publication {
  const visibility = changes.visibility ?? publication.visibility
  return deepFreeze({
    ...publication,
    visibility,
    capabilities: resolveCapabilities(visibility, { ...publication.capabilities, ...changes.capabilities }),
  })
}
