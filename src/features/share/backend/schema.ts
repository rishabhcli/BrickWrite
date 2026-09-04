import type {
  CardPresetId,
  Collection,
  ModerationState,
  Publication,
  PublicationAuthor,
  Report,
  ShareCapabilities,
  ShareTokenRecord,
  Visibility,
} from '../types'

/**
 * Schema fragments for the cloud workstream.
 *
 * `convex/**` and its master schema belong to workstream 8, so this file is
 * deliberately an *isolated fragment*: the table definitions this workstream
 * needs, as text the cloud agent pastes into `convex/schema.ts`, plus the row
 * types the adapter maps to. Nothing here imports `convex/*` and nothing here
 * runs — importing this module has no side effect beyond two constant strings.
 *
 * The merge is documented step by step in `docs/integration/share-studio.md`.
 * The short version:
 *
 *   1. paste `CONVEX_SHARE_TABLES` into the object passed to `defineSchema`;
 *   2. add the functions in `CONVEX_SHARE_FUNCTIONS` to `convex/publications.ts`;
 *   3. implement `PublicationStore` over them — the interface is five point
 *      reads, four writes and one prefix listing, all of which map to indexed
 *      Convex queries;
 *   4. leave the card *bytes* in R2 or KV. They are up to a megabyte each and
 *      immutable, and a document database is the wrong home for them.
 *
 * The one invariant the cloud implementation must preserve, because the whole
 * workstream rests on it: **`publications` rows are insert-only for
 * `snapshot`, `revision` and `contentHash`.** Capabilities, `revokedAt` and
 * `moderation` may be patched; `visibility` is written once at insert and
 * never patched — every publication is public — and the snapshot may not
 * change at all.
 */

export const CONVEX_SHARE_TABLES = `
  // --- Publish & share (workstream 9) --------------------------------------
  // Insert-only for snapshot/revision/contentHash. See
  // docs/integration/share-studio.md before changing anything in this block.
  publications: defineTable({
    schemaVersion: v.number(),
    publicationId: v.string(),
    slug: v.string(),
    ownerId: v.optional(v.id('users')),
    projectId: v.optional(v.string()),
    visibility: v.literal('public'),
    capabilities: v.object({
      view: v.boolean(),
      comment: v.boolean(),
      fork: v.boolean(),
      download: v.boolean(),
      embed: v.boolean(),
    }),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    author: v.union(
      v.null(),
      v.object({ displayName: v.string(), handle: v.union(v.string(), v.null()), url: v.union(v.string(), v.null()) }),
    ),
    license: v.string(),
    publishedAt: v.string(),
    revision: v.number(),
    contentHash: v.string(),
    // The captured snapshot, exactly as serializePublishedDocument produced it.
    snapshot: v.any(),
    summary: v.any(),
    cards: v.array(
      v.object({
        preset: v.string(),
        width: v.number(),
        height: v.number(),
        contentType: v.literal('image/png'),
        sha256: v.string(),
        byteLength: v.number(),
        frames: v.number(),
        alt: v.string(),
      }),
    ),
    fork: v.union(v.null(), v.any()),
    revokedAt: v.union(v.string(), v.null()),
    moderation: v.union(v.null(), v.object({ status: v.string(), reason: v.string(), decidedAt: v.string() })),
  })
    .index('by_slug', ['slug'])
    .index('by_publication_id', ['publicationId'])
    .index('by_owner', ['ownerId'])
    // Feed ordering. Query descending on publishedAt with a visibility filter;
    // the KV driver fakes this with a subtracted sort key, Convex does not need to.
    .index('by_visibility_published', ['visibility', 'publishedAt']),

  // Hash-only. A dump of this table yields no working links.
  shareTokens: defineTable({
    tokenId: v.string(),
    publicationId: v.string(),
    slug: v.string(),
    secretHash: v.string(),
    scope: v.object({
      view: v.boolean(),
      comment: v.boolean(),
      fork: v.boolean(),
      download: v.boolean(),
      embed: v.boolean(),
    }),
    label: v.string(),
    createdAt: v.string(),
    expiresAt: v.union(v.string(), v.null()),
    revokedAt: v.union(v.string(), v.null()),
  })
    .index('by_token_id', ['tokenId'])
    .index('by_publication', ['publicationId']),

  publicationReports: defineTable({
    reportId: v.string(),
    publicationId: v.string(),
    slug: v.string(),
    reason: v.string(),
    detail: v.string(),
    createdAt: v.string(),
    status: v.union(v.literal('open'), v.literal('upheld'), v.literal('dismissed')),
    // A salted hash of the reporter, never the reporter.
    reporterRef: v.union(v.string(), v.null()),
    resolvedAt: v.union(v.string(), v.null()),
  })
    .index('by_status', ['status'])
    .index('by_publication', ['publicationId']),

  publicationCollections: defineTable({
    collectionId: v.string(),
    title: v.string(),
    description: v.string(),
    curatedBy: v.string(),
    updatedAt: v.string(),
    slugs: v.array(v.string()),
  }).index('by_collection_id', ['collectionId']),
`.trim()

export const CONVEX_SHARE_FUNCTIONS = `
  // convex/publications.ts
  //
  // publish            mutation  insert-only; throws on an existing slug or id
  // updateAccess       mutation  patches visibility/capabilities only
  // revoke             mutation  sets revokedAt; never deletes the snapshot
  // getBySlug          query     by_slug
  // getById            query     by_publication_id
  // listPublic         query     by_visibility_published, descending, paged
  // mintToken          mutation  stores secretHash; returns nothing secret
  // getToken           query     by_token_id — a point read, never a scan
  // listTokens         query     by_publication
  // revokeToken        mutation  sets revokedAt
  // submitReport       mutation  rate-limited per reporterRef
  // listReports        query     by_status, moderator only
  // setModeration      mutation  moderator only; patches moderation
  //
  // Authorisation the cloud workstream owns, because this workstream has no
  // session: publish/updateAccess/revoke/mintToken require the authenticated
  // owner of projectId; listReports/setModeration require a moderator role.
  // The Pages Functions in functions/** currently gate writes on a shared
  // bearer secret (SHARE_PUBLISH_TOKEN) and must switch to the session check
  // when this lands.
`.trim()

/** The row shape the cloud implementation stores, mapped from `Publication`. */
export interface PublicationRow {
  schemaVersion: number
  publicationId: string
  slug: string
  ownerId?: string
  projectId?: string
  visibility: Visibility
  capabilities: ShareCapabilities
  title: string
  description: string
  tags: string[]
  author: PublicationAuthor | null
  license: string
  publishedAt: string
  revision: number
  contentHash: string
  snapshot: Publication['document']
  summary: Publication['summary']
  cards: Array<{
    preset: CardPresetId | string
    width: number
    height: number
    contentType: 'image/png'
    sha256: string
    byteLength: number
    frames: number
    alt: string
  }>
  fork: Publication['fork']
  revokedAt: string | null
  moderation: ModerationState | null
}

export interface ShareTokenRow extends Omit<ShareTokenRecord, 'id'> {
  tokenId: string
}

export interface ReportRow extends Omit<Report, 'id'> {
  reportId: string
}

export interface CollectionRow extends Omit<Collection, 'id'> {
  collectionId: string
}

/** `Publication` → row. The inverse of `publicationFromRow`. */
export function publicationToRow(
  publication: Publication,
  owner?: { ownerId?: string; projectId?: string },
): PublicationRow {
  return {
    schemaVersion: publication.schemaVersion,
    publicationId: publication.id,
    slug: publication.slug,
    ownerId: owner?.ownerId,
    projectId: owner?.projectId,
    visibility: publication.visibility,
    capabilities: publication.capabilities,
    title: publication.title,
    description: publication.description,
    tags: [...publication.tags],
    author: publication.author,
    license: publication.license,
    publishedAt: publication.publishedAt,
    revision: publication.revision,
    contentHash: publication.contentHash,
    snapshot: publication.document,
    summary: publication.summary,
    cards: publication.cards.map((card) => ({ ...card })),
    fork: publication.fork,
    revokedAt: publication.revokedAt,
    moderation: publication.moderation,
  }
}

/**
 * Row → `Publication`.
 *
 * The round trip is asserted in `backend/schema.test.ts`, which is what stops
 * the cloud mapping from quietly dropping a field the page renderer needs.
 */
export function publicationFromRow(row: PublicationRow): Publication {
  return {
    schemaVersion: 1,
    id: row.publicationId,
    slug: row.slug,
    visibility: row.visibility,
    capabilities: row.capabilities,
    title: row.title,
    description: row.description,
    tags: [...row.tags],
    author: row.author,
    license: row.license,
    publishedAt: row.publishedAt,
    revision: row.revision,
    contentHash: row.contentHash,
    document: row.snapshot,
    summary: row.summary,
    cards: row.cards.map((card) => ({ ...card })) as Publication['cards'],
    fork: row.fork,
    revokedAt: row.revokedAt,
    moderation: row.moderation,
  }
}

export function tokenToRow(token: ShareTokenRecord): ShareTokenRow {
  const { id, ...rest } = token
  return { tokenId: id, ...rest }
}

export function tokenFromRow(row: ShareTokenRow): ShareTokenRecord {
  const { tokenId, ...rest } = row
  return { id: tokenId, ...rest }
}
