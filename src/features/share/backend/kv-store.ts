import { deepFreeze } from '../publish'
import { isValidSlug } from '../sanitize'
import { ShareError, type Collection, type Publication, type Report, type ShareTokenRecord } from '../types'
import type { KvNamespace, PublicationStore, StoredCard } from './adapter'

/**
 * The publication store, over a key/value namespace.
 *
 * This is the real implementation — Cloudflare KV in production, a file-backed
 * namespace in local development, and the same code path in tests. There is no
 * in-memory shortcut hiding behind a "replace with persistent storage" comment:
 * whatever namespace is handed in is where the data lives, and the store has no
 * cache of its own.
 *
 * Key layout, with the reason each index exists:
 *
 *   `pub:slug:<slug>`      the record, keyed by what a URL carries
 *   `pub:id:<id>`          slug pointer, so a token can find its publication
 *   `pub:feed:<sortKey>`   listing index; the key sorts newest-first so the
 *                          gallery pages with KV's own prefix listing instead
 *                          of loading every publication to sort it
 *   `card:<sha256>`        card bytes, content-addressed and immutable
 *   `tok:<id>`             token record — the *hash* only, never a secret
 *   `tokidx:<pubId>:<id>`  a publication's tokens, for the revocation list
 *   `rep:<id>`             moderation reports
 *   `col:<id>`             curated collections
 *
 * Tokens are stored under their public id, so verification is one point lookup
 * with no scan. That matters for more than speed: a scan over token records
 * would take time proportional to how many exist, which is observable.
 */

const SLUG_KEY = (slug: string) => `pub:slug:${slug}`
const ID_KEY = (id: string) => `pub:id:${id}`
const CARD_KEY = (sha256: string) => `card:${sha256}`
const TOKEN_KEY = (id: string) => `tok:${id}`
const TOKEN_INDEX_KEY = (publicationId: string, tokenId: string) => `tokidx:${publicationId}:${tokenId}`
const REPORT_KEY = (id: string) => `rep:${id}`
const COLLECTION_KEY = (id: string) => `col:${id}`
const FEED_PREFIX = 'pub:feed:'

/**
 * Newest-first ordering inside a lexically-sorted key space.
 *
 * KV lists ascending, so the sort key is the timestamp subtracted from a fixed
 * far-future epoch and zero-padded. The slug is appended to break ties between
 * two publications minted in the same millisecond.
 */
const FAR_FUTURE = Date.UTC(4000, 0, 1)
function feedKey(publication: Publication): string {
  const published = Date.parse(publication.publishedAt)
  const stamp = Number.isNaN(published) ? FAR_FUTURE : Math.max(0, FAR_FUTURE - published)
  return `${FEED_PREFIX}${String(stamp).padStart(16, '0')}:${publication.slug}`
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class KvPublicationStore implements PublicationStore {
  constructor(private readonly kv: KvNamespace) {}

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, 'text')
    if (raw === null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      // A record that will not parse is corruption, not a miss. Reporting it as
      // "not found" would hide a storage fault behind a 404 forever.
      throw new ShareError('STORE_UNAVAILABLE', `Stored record at ${key} is not valid JSON.`, 500)
    }
  }

  private writeJson(key: string, value: unknown): Promise<void> {
    return this.kv.put(key, JSON.stringify(value))
  }

  async put(publication: Publication): Promise<void> {
    if (!isValidSlug(publication.slug)) {
      throw new ShareError('INVALID_INPUT', `"${publication.slug}" is not a usable slug.`)
    }
    // Create-only. Two callers racing on the same slug is vanishingly unlikely
    // given 60 bits of suffix, but "unlikely" is not "impossible", and the
    // failure it would cause — an existing link showing a different model — is
    // exactly the one this workstream exists to prevent.
    if (await this.kv.get(SLUG_KEY(publication.slug), 'text')) {
      throw new ShareError('IMMUTABLE', `A publication already exists at /share/${publication.slug}.`, 409)
    }
    if (await this.kv.get(ID_KEY(publication.id), 'text')) {
      throw new ShareError('IMMUTABLE', `Publication ${publication.id} already exists.`, 409)
    }
    await this.writeJson(SLUG_KEY(publication.slug), publication)
    await this.kv.put(ID_KEY(publication.id), publication.slug)
    await this.kv.put(feedKey(publication), publication.slug)
  }

  async getBySlug(slug: string): Promise<Publication | null> {
    if (!isValidSlug(slug)) return null
    const record = await this.readJson<Publication>(SLUG_KEY(slug))
    return record ? deepFreeze(record) : null
  }

  async getById(id: string): Promise<Publication | null> {
    const slug = await this.kv.get(ID_KEY(id), 'text')
    return slug ? this.getBySlug(slug) : null
  }

  /**
   * Rewrites the mutable half of a record.
   *
   * The snapshot, the revision and the content hash are compared against what
   * is already stored and the write is refused if any of them moved. Visibility,
   * capabilities, revocation and moderation are the only things that may change
   * after publication.
   */
  async updateMetadata(publication: Publication): Promise<void> {
    const existing = await this.readJson<Publication>(SLUG_KEY(publication.slug))
    if (!existing) throw new ShareError('NOT_FOUND', `No publication at /share/${publication.slug}.`, 404)
    if (
      existing.contentHash !== publication.contentHash ||
      existing.revision !== publication.revision ||
      existing.id !== publication.id
    ) {
      throw new ShareError(
        'IMMUTABLE',
        'A published snapshot cannot be replaced. Publish again to share a newer revision.',
        409,
      )
    }
    await this.writeJson(SLUG_KEY(publication.slug), publication)
  }

  async listPublic(options: { limit?: number; cursor?: string | null } = {}): Promise<{
    entries: Publication[]
    cursor: string | null
  }> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 24))
    const entries: Publication[] = []
    let cursor = options.cursor ?? undefined
    let complete = false

    // KV's listing does not filter, so a page of keys can yield fewer public
    // publications than asked for. The loop keeps pulling until the page is
    // full or the namespace is exhausted, rather than returning a short page
    // that looks like the end of the gallery.
    while (entries.length < limit && !complete) {
      const page = await this.kv.list({ prefix: FEED_PREFIX, limit: limit * 2, cursor })
      cursor = page.cursor
      complete = page.list_complete
      for (const key of page.keys) {
        const slug = key.name.slice(key.name.lastIndexOf(':') + 1)
        const publication = await this.getBySlug(slug)
        if (!publication) continue
        if (publication.visibility !== 'public') continue
        if (publication.revokedAt || publication.moderation?.status === 'hidden') continue
        if (!publication.capabilities.view) continue
        entries.push(publication)
        if (entries.length >= limit) break
      }
    }

    return { entries, cursor: complete ? null : (cursor ?? null) }
  }

  async putCard(card: StoredCard): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(card.sha256)) {
      throw new ShareError('INVALID_INPUT', 'A card must be keyed by the SHA-256 of its own bytes.')
    }
    // Content-addressed: an identical card written twice is the same bytes at
    // the same key, so the second write is harmless and the first is never
    // clobbered by different content.
    await this.kv.put(CARD_KEY(card.sha256), card.bytes)
  }

  async getCard(sha256: string): Promise<StoredCard | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null
    const buffer = await this.kv.get(CARD_KEY(sha256), 'arrayBuffer')
    return buffer ? { sha256, contentType: 'image/png', bytes: new Uint8Array(buffer) } : null
  }

  async putToken(token: ShareTokenRecord): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(token.secretHash)) {
      throw new ShareError('INVALID_INPUT', 'A token record must carry a SHA-256 hash, not a secret.')
    }
    await this.writeJson(TOKEN_KEY(token.id), token)
    await this.kv.put(TOKEN_INDEX_KEY(token.publicationId, token.id), token.id)
  }

  async getToken(id: string): Promise<ShareTokenRecord | null> {
    // The id comes straight off a URL; anything that is not the shape a mint
    // produces is refused before it reaches storage.
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null
    return this.readJson<ShareTokenRecord>(TOKEN_KEY(id))
  }

  async listTokens(publicationId: string): Promise<ShareTokenRecord[]> {
    const page = await this.kv.list({ prefix: `tokidx:${publicationId}:`, limit: 200 })
    const tokens: ShareTokenRecord[] = []
    for (const key of page.keys) {
      const token = await this.getToken(key.name.slice(key.name.lastIndexOf(':') + 1))
      if (token) tokens.push(token)
    }
    return tokens.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async putReport(report: Report): Promise<void> {
    await this.writeJson(REPORT_KEY(report.id), report)
  }

  async listReports(options: { status?: Report['status'] } = {}): Promise<Report[]> {
    const page = await this.kv.list({ prefix: 'rep:', limit: 500 })
    const reports: Report[] = []
    for (const key of page.keys) {
      const report = await this.readJson<Report>(key.name)
      if (report && (!options.status || report.status === options.status)) reports.push(report)
    }
    return reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async putCollection(collection: Collection): Promise<void> {
    await this.writeJson(COLLECTION_KEY(collection.id), collection)
  }

  async listCollections(): Promise<Collection[]> {
    const page = await this.kv.list({ prefix: 'col:', limit: 200 })
    const collections: Collection[] = []
    for (const key of page.keys) {
      const collection = await this.readJson<Collection>(key.name)
      if (collection) collections.push(collection)
    }
    return collections.sort((a, b) => a.title.localeCompare(b.title))
  }
}

/** Shared by the KV drivers: bytes in, text out, without a Buffer dependency. */
export const kvEncode = (value: string | ArrayBuffer | Uint8Array): Uint8Array => {
  if (typeof value === 'string') return encoder.encode(value)
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

export const kvDecode = (bytes: Uint8Array): string => decoder.decode(bytes)
