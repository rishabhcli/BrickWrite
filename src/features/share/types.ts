import type { RigidTransform } from '../../cad/math'
import type { Bounds, ConnectionFamily } from '../../cad/types'

/**
 * The publication vocabulary.
 *
 * A publication is deliberately *not* a `ModelDocument`. It is a separate,
 * narrower record built by an allowlist serialiser, because the two answer
 * different questions: a document is the operator's working state, and a
 * publication is the subset of it a stranger is allowed to see. Modelling them
 * as one type is how private notes end up in an OpenGraph card.
 *
 * Everything here is plain data with no kernel dependency beyond geometry
 * types, so the same definitions compile in the browser, in Node and inside a
 * Cloudflare Pages Function.
 */

/** Publication record schema. Bumped when the wire shape changes. */
export const PUBLICATION_SCHEMA_VERSION = 1

export type Visibility = 'private' | 'unlisted' | 'public'

/**
 * What a viewer may do, independent of how they found the page.
 *
 * Visibility answers "who can reach it"; capabilities answer "what happens once
 * they are there". They are independent because the useful combinations cross:
 * a public page with forking off, an unlisted link with download on.
 */
export interface ShareCapabilities {
  view: boolean
  comment: boolean
  fork: boolean
  download: boolean
  embed: boolean
}

export const NO_CAPABILITIES: Readonly<ShareCapabilities> = Object.freeze({
  view: false,
  comment: false,
  fork: false,
  download: false,
  embed: false,
})

export const DEFAULT_CAPABILITIES: Readonly<ShareCapabilities> = Object.freeze({
  view: true,
  comment: false,
  fork: true,
  download: false,
  embed: false,
})

export const CAPABILITY_KEYS = ['view', 'comment', 'fork', 'download', 'embed'] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

// ---------------------------------------------------------------------------
// The published document
// ---------------------------------------------------------------------------

/**
 * One placed part, stripped to what a viewer needs to draw it.
 *
 * Absent by construction: `protected`, `provenance` and `createdByTransaction`.
 * Those describe how the owner works, not what they built.
 */
export interface PublishedPart {
  id: string
  definitionId: string
  color: number
  transform: RigidTransform
  subassemblyId: string
  stepId: string
}

export interface PublishedConnection {
  id: string
  a: { partId: string; featureId: string }
  b: { partId: string; featureId: string }
  family: ConnectionFamily
}

export interface PublishedSubassembly {
  id: string
  name: string
  partIds: string[]
  accent: string
}

export interface PublishedStep {
  id: string
  index: number
  name: string
  partIds: string[]
}

/**
 * The immutable model payload of a publication.
 *
 * Arrays rather than records, sorted by id, so two serialisations of the same
 * revision are byte-identical regardless of insertion order. That is what makes
 * `contentHash` a usable immutability proof rather than a hash of a JavaScript
 * object's iteration order.
 */
export interface PublishedDocument {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION
  name: string
  /** The exact source-document revision this snapshot was captured at. */
  revision: number
  catalogVersion: string
  parts: PublishedPart[]
  connections: PublishedConnection[]
  subassemblies: PublishedSubassembly[]
  steps: PublishedStep[]
}

// ---------------------------------------------------------------------------
// Summary, attribution, provenance
// ---------------------------------------------------------------------------

export interface PublicationBomLine {
  definitionId: string
  ldrawId: string
  name: string
  colorCode: number
  colorName: string
  colorHex: string
  quantity: number
}

/**
 * The validation badge, carried at publish time.
 *
 * Recomputing validation server-side would need the compiled catalog inside the
 * edge runtime; carrying the verdict means the badge states what was true of
 * this exact revision when it was published, which is the honest claim.
 */
export interface PublicationValidation {
  revision: number
  healthy: boolean
  partCount: number
  connectionCount: number
  collisionCount: number
  unverifiedCollisionCount: number
  componentCount: number
  /** Constraint outcomes, labels already sanitised. */
  constraints: Array<{ label: string; status: 'pass' | 'warning' | 'fail' }>
}

export interface PublicationSummary {
  partCount: number
  uniquePartCount: number
  stepCount: number
  /**
   * Measured envelope, rounded to 0.1: `[width in studs, height in plates,
   * depth in studs]`. Same convention as `PartDimensions.studs`, because a
   * brick's height is quoted in plates by every builder who has ever counted
   * one.
   */
  envelopeStuds: [number, number, number]
  boundsLdu: Bounds
  bom: PublicationBomLine[]
  validation: PublicationValidation
  /** Parts whose definition this build could not resolve, reported not hidden. */
  unresolvedDefinitionIds: string[]
}

/**
 * Attribution supplied by the publisher.
 *
 * There is no default and no derived display name: a publication either carries
 * an author the publisher provided or it carries `null`, and the page says
 * "Author not stated". Inventing a creator is the exact failure this type
 * exists to prevent.
 */
export interface PublicationAuthor {
  displayName: string
  /** Stable public handle, when the account layer supplied one. */
  handle: string | null
  /** Absolute https URL, when the publisher supplied one. */
  url: string | null
}

export interface ForkProvenance {
  /** Publication the fork was taken from. */
  publicationId: string
  slug: string
  sourceRevision: number
  sourceContentHash: string
  sourceTitle: string
  sourceAuthor: PublicationAuthor | null
  forkedAt: string
}

// ---------------------------------------------------------------------------
// Social cards
// ---------------------------------------------------------------------------

export type CardPresetId =
  | 'square'
  | 'portrait'
  | 'landscape'
  | 'opengraph'
  | 'twitter'
  | 'transparent'

export type AnimationPresetId = 'turntable' | 'build-sequence'

/**
 * A rendered card, stored by the SHA-256 of its own bytes.
 *
 * Content addressing is what lets the share page serve cards with an immutable
 * cache header and what makes "same revision + preset ⇒ same bytes" checkable
 * from the record alone.
 */
export interface PublicationCard {
  preset: CardPresetId | AnimationPresetId
  width: number
  height: number
  /** `image/png` — animations are APNG, which is still `image/png`. */
  contentType: 'image/png'
  sha256: string
  byteLength: number
  /** Frame count; 1 for a still. */
  frames: number
  /** Short alt text describing the render, already sanitised. */
  alt: string
}

// ---------------------------------------------------------------------------
// The publication
// ---------------------------------------------------------------------------

export interface Publication {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION
  id: string
  /** URL segment. Lowercase, hyphenated, entropy-suffixed, never guessable. */
  slug: string
  visibility: Visibility
  capabilities: ShareCapabilities
  title: string
  description: string
  tags: string[]
  author: PublicationAuthor | null
  license: string
  publishedAt: string
  /** Exact source revision. Later private edits never move this. */
  revision: number
  /** SHA-256 over `canonicalPublicationBytes(document)`. */
  contentHash: string
  document: PublishedDocument
  summary: PublicationSummary
  cards: PublicationCard[]
  fork: ForkProvenance | null
  /** Set once the publisher retires the publication; it then fails closed. */
  revokedAt: string | null
  /** Set by moderation. A hidden publication is unreachable, not deleted. */
  moderation: ModerationState | null
}

export interface ModerationState {
  status: 'hidden' | 'cleared'
  /** Free-text reason, sanitised, shown to the publisher only. */
  reason: string
  decidedAt: string
}

// ---------------------------------------------------------------------------
// Unlisted access tokens
// ---------------------------------------------------------------------------

/**
 * The stored half of an unlisted link.
 *
 * The secret itself is never stored, logged or returned after minting — only
 * `secretHash`. A leaked database therefore yields no working links.
 */
export interface ShareTokenRecord {
  /** Public identifier, transmitted in the clear as the token's first segment. */
  id: string
  publicationId: string
  slug: string
  /** Lowercase hex SHA-256 of the secret half. */
  secretHash: string
  /** Capabilities this token grants, intersected with the publication's. */
  scope: ShareCapabilities
  label: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
}

export type TokenFailureReason =
  | 'malformed'
  | 'unknown'
  | 'mismatch'
  | 'revoked'
  | 'expired'
  | 'wrong-publication'

export type TokenVerification =
  | { ok: true; record: ShareTokenRecord; scope: ShareCapabilities }
  | { ok: false; reason: TokenFailureReason }

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/**
 * The gallery projection of a publication.
 *
 * Deliberately carries no engagement numbers. There is no view count, like
 * count or trending score in this type, because there is no honest source for
 * one yet, and a zero rendered as "0 views" is a claim this product has not
 * earned.
 */
export interface GalleryEntry {
  publicationId: string
  slug: string
  title: string
  description: string
  tags: string[]
  author: PublicationAuthor | null
  publishedAt: string
  partCount: number
  stepCount: number
  healthy: boolean
  /** Preset id of the card to use as the tile image, when one was rendered. */
  cardPreset: CardPresetId | AnimationPresetId | null
  forkedFromSlug: string | null
}

export interface Collection {
  id: string
  title: string
  description: string
  /** Curated by a named human; there is no algorithmic collection. */
  curatedBy: string
  updatedAt: string
  /** Slugs, in the order the curator chose. */
  slugs: string[]
}

export const REPORT_REASONS = [
  'infringement',
  'inappropriate',
  'spam',
  'impersonation',
  'unsafe-build',
  'other',
] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

export interface Report {
  id: string
  publicationId: string
  slug: string
  reason: ReportReason
  detail: string
  createdAt: string
  status: 'open' | 'upheld' | 'dismissed'
  /** Opaque, salted hash of the reporter's identity; never the identity itself. */
  reporterRef: string | null
  resolvedAt: string | null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ShareErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'TOKEN_REQUIRED'
  | 'TOKEN_REJECTED'
  | 'REVOKED'
  | 'MODERATED'
  | 'CAPABILITY_DISABLED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_INPUT'
  | 'IMMUTABLE'
  | 'STORE_UNAVAILABLE'

export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ShareError'
  }
}
