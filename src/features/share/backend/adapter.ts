import type { Collection, Publication, Report, ShareTokenRecord } from '../types'

/**
 * The storage seam.
 *
 * Workstream 8 owns `convex/**` and the master schema, so this workstream does
 * not write tables — it writes an interface and a driver that satisfies it, and
 * ships the schema fragments the cloud agent merges (see `schema.ts` and
 * `docs/integration/share-studio.md`).
 *
 * Everything above this line — the share page, the embed, the card endpoint,
 * the gallery, the studio — talks to `PublicationStore` and nothing else. That
 * is what lets the same code run against Cloudflare KV at the edge, against a
 * file-backed store in local development, and against Convex once the cloud
 * schema lands, without a branch anywhere in the feature code.
 *
 * Two rules the interface enforces on every implementation:
 *
 *   - **`put` is create-only.** A publication is immutable. Rewriting one is a
 *     programming error and the store must reject it rather than silently make
 *     an old link show new content. Access and moderation changes go through
 *     their own narrow methods, which never touch the snapshot.
 *   - **Cards are content-addressed.** They are keyed by the SHA-256 of their
 *     own bytes, so a repeated write is a no-op and a served card can carry an
 *     immutable cache header honestly.
 */

export interface StoredCard {
  sha256: string
  contentType: 'image/png'
  bytes: Uint8Array
}

export interface PublicationStore {
  /** Creates a publication. Rejects an existing id or slug. */
  put(publication: Publication): Promise<void>
  getBySlug(slug: string): Promise<Publication | null>
  getById(id: string): Promise<Publication | null>
  /**
   * Replaces a record without touching its snapshot, revision or content hash.
   * Implementations assert those three are unchanged.
   */
  updateMetadata(publication: Publication): Promise<void>
  /** Public, viewable publications, newest first. */
  listPublic(options?: { limit?: number; cursor?: string | null }): Promise<{
    entries: Publication[]
    cursor: string | null
  }>

  putCard(card: StoredCard): Promise<void>
  getCard(sha256: string): Promise<StoredCard | null>

  putToken(token: ShareTokenRecord): Promise<void>
  getToken(id: string): Promise<ShareTokenRecord | null>
  listTokens(publicationId: string): Promise<ShareTokenRecord[]>

  putReport(report: Report): Promise<void>
  listReports(options?: { status?: Report['status'] }): Promise<Report[]>

  putCollection(collection: Collection): Promise<void>
  listCollections(): Promise<Collection[]>
}

/**
 * The minimal key/value surface a store needs.
 *
 * Deliberately shaped like Cloudflare's `KVNamespace` so the production driver
 * is the platform binding with no adapter in between, while the local and test
 * drivers implement the same five methods.
 */
export interface KvNamespace {
  get(key: string, type: 'text'): Promise<string | null>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>
  delete(key: string): Promise<void>
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }>
}
