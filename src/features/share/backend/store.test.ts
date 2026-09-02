import { describe, expect, it } from 'vitest'
import { privateDocument } from '../__fixtures__/model'
import { createPublication, revokePublication, updatePublicationAccess } from '../publish'
import { mintShareToken, revokeToken } from '../tokens'
import { ShareError } from '../types'
import { KvPublicationStore } from './kv-store'
import { MemoryKv } from './memory-kv'
import {
  CONVEX_SHARE_FUNCTIONS,
  CONVEX_SHARE_TABLES,
  publicationFromRow,
  publicationToRow,
  tokenFromRow,
  tokenToRow,
} from './schema'

/**
 * The store's job is to make immutability enforceable rather than merely
 * intended. These tests are the enforcement: a rewrite of a published snapshot
 * is a 409, an access change is allowed and leaves the snapshot alone, and a
 * card is addressed by its own hash.
 */

const FULL = { view: true, comment: true, fork: true, download: true, embed: true }

const build = () => {
  const kv = new MemoryKv()
  return { kv, store: new KvPublicationStore(kv) }
}

const publish = (revision: number, overrides: Record<string, unknown> = {}) =>
  createPublication({
    document: privateDocument(revision),
    visibility: 'public',
    capabilities: FULL,
    title: 'Rover',
    ...overrides,
  })

describe('publication store', () => {
  it('round-trips a publication by slug and by id', async () => {
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)

    expect(await store.getBySlug(publication.slug)).toEqual(publication)
    expect(await store.getById(publication.id)).toEqual(publication)
    expect(await store.getBySlug('nothing-here')).toBeNull()
    expect(await store.getById('pub_missing')).toBeNull()
  })

  it('refuses a second write to the same slug', async () => {
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)
    await expect(store.put(publication)).rejects.toThrow(ShareError)
    await expect(store.put({ ...publication, id: 'pub_other' })).rejects.toThrow(/already exists/)
  })

  it('refuses to replace a snapshot through the metadata path', async () => {
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)

    const tampered = { ...publication, contentHash: 'f'.repeat(64) }
    await expect(store.updateMetadata(tampered)).rejects.toThrow(/cannot be replaced/)

    const laterRevision = { ...publication, revision: 99 }
    await expect(store.updateMetadata(laterRevision)).rejects.toThrow(/cannot be replaced/)

    // The stored record is untouched by either attempt.
    expect(await store.getBySlug(publication.slug)).toEqual(publication)
  })

  it('allows visibility, capability, revocation and moderation changes', async () => {
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)

    const closed = updatePublicationAccess(publication, { visibility: 'private' })
    await store.updateMetadata(closed)
    expect((await store.getBySlug(publication.slug))?.visibility).toBe('private')

    const revoked = revokePublication(closed, new Date('2026-10-01T00:00:00.000Z'))
    await store.updateMetadata(revoked)
    const stored = await store.getBySlug(publication.slug)
    expect(stored?.revokedAt).toBe('2026-10-01T00:00:00.000Z')
    // Through both changes, the artifact is byte-identical.
    expect(stored?.contentHash).toBe(publication.contentHash)
    expect(stored?.document).toEqual(publication.document)
  })

  it('rejects a slug that is not URL-safe', async () => {
    const { store } = build()
    const publication = await publish(4)
    await expect(store.put({ ...publication, slug: '../escape' })).rejects.toThrow(/usable slug/)
  })

  it('reports corrupt storage rather than reporting a miss', async () => {
    const { kv, store } = build()
    const publication = await publish(4)
    await store.put(publication)
    await kv.put(`pub:slug:${publication.slug}`, 'not json')
    await expect(store.getBySlug(publication.slug)).rejects.toThrow(/not valid JSON/)
  })
})

describe('public feed', () => {
  it('lists newest first and excludes everything that is not public', async () => {
    const { store } = build()
    const visible: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const publication = await publish(index + 1, {
        now: new Date(Date.UTC(2026, 0, index + 1)),
        title: `Rover ${index}`,
      })
      await store.put(publication)
      visible.push(publication.slug)
    }
    const unlisted = await publish(9, { visibility: 'unlisted', now: new Date(Date.UTC(2026, 5, 1)) })
    await store.put(unlisted)
    const hidden = await publish(10, { now: new Date(Date.UTC(2026, 5, 2)) })
    await store.put(revokePublication(hidden))
    await store.updateMetadata(revokePublication(hidden))

    const page = await store.listPublic({ limit: 10 })
    expect(page.entries.map((entry) => entry.slug)).toEqual([...visible].reverse())
    expect(page.entries.some((entry) => entry.slug === unlisted.slug)).toBe(false)
    expect(page.entries.some((entry) => entry.slug === hidden.slug)).toBe(false)
  })

  it('fills a page rather than returning a short one', async () => {
    const { store } = build()
    for (let index = 0; index < 6; index += 1) {
      // Alternating unlisted entries mean a naive implementation that took one
      // KV page and filtered it would return half a page.
      await store.put(
        await publish(index + 1, {
          visibility: index % 2 === 0 ? 'public' : 'unlisted',
          now: new Date(Date.UTC(2026, 0, index + 1)),
        }),
      )
    }
    const page = await store.listPublic({ limit: 3 })
    expect(page.entries).toHaveLength(3)
    expect(page.entries.every((entry) => entry.visibility === 'public')).toBe(true)
  })

  it('pages with a cursor', async () => {
    const { store } = build()
    for (let index = 0; index < 7; index += 1) {
      await store.put(await publish(index + 1, { now: new Date(Date.UTC(2026, 0, index + 1)) }))
    }
    const first = await store.listPublic({ limit: 4 })
    expect(first.entries).toHaveLength(4)
    expect(first.cursor).toBeTruthy()
    const second = await store.listPublic({ limit: 4, cursor: first.cursor })
    expect(second.entries).toHaveLength(3)
    const slugs = new Set([...first.entries, ...second.entries].map((entry) => entry.slug))
    expect(slugs.size).toBe(7)
  })
})

describe('cards', () => {
  it('stores and returns bytes unchanged, keyed by hash', async () => {
    const { store } = build()
    const bytes = Uint8Array.from({ length: 512 }, (_, index) => index & 0xff)
    const sha256 = 'a'.repeat(64)
    await store.putCard({ sha256, contentType: 'image/png', bytes })
    const loaded = await store.getCard(sha256)
    expect(loaded?.bytes).toEqual(bytes)
    expect(await store.getCard('not a hash')).toBeNull()
    expect(await store.getCard('b'.repeat(64))).toBeNull()
  })

  it('refuses a card that is not addressed by a hash', async () => {
    const { store } = build()
    await expect(
      store.putCard({ sha256: 'short', contentType: 'image/png', bytes: new Uint8Array(4) }),
    ).rejects.toThrow(/SHA-256/)
  })
})

describe('tokens in storage', () => {
  it('stores a token by id and lists a publication’s tokens in order', async () => {
    const { store } = build()
    const publication = await publish(3)
    await store.put(publication)

    const first = await mintShareToken({
      publicationId: publication.id,
      slug: publication.slug,
      scope: FULL,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    const second = await mintShareToken({
      publicationId: publication.id,
      slug: publication.slug,
      scope: FULL,
      now: new Date('2026-02-01T00:00:00.000Z'),
    })
    await store.putToken(first.record)
    await store.putToken(second.record)

    const listed = await store.listTokens(publication.id)
    expect(listed.map((token) => token.id)).toEqual([first.record.id, second.record.id])
    expect(await store.getToken('../../etc/passwd')).toBeNull()

    await store.putToken(revokeToken(first.record, new Date('2026-03-01T00:00:00.000Z')))
    expect((await store.getToken(first.record.id))?.revokedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('refuses to store anything but a digest', async () => {
    const { store } = build()
    const minted = await mintShareToken({ publicationId: 'p', slug: 's', scope: FULL })
    await expect(
      store.putToken({ ...minted.record, secretHash: minted.token.split('.')[1] }),
    ).rejects.toThrow(/hash, not a secret/)
  })
})

describe('cloud schema fragments', () => {
  it('round-trips a publication through the row mapping without loss', async () => {
    const publication = await publish(6, { tags: ['rover'] })
    const row = publicationToRow(publication, { ownerId: 'user_1', projectId: 'prj_1' })
    expect(row.ownerId).toBe('user_1')
    expect(publicationFromRow(row)).toEqual(publication)
  })

  it('round-trips a token record', async () => {
    const minted = await mintShareToken({ publicationId: 'p', slug: 's', scope: FULL })
    expect(tokenFromRow(tokenToRow(minted.record))).toEqual(minted.record)
  })

  it('declares the tables and indexes the adapter actually needs', () => {
    for (const table of ['publications', 'shareTokens', 'publicationReports', 'publicationCollections']) {
      expect(CONVEX_SHARE_TABLES).toContain(`${table}: defineTable(`)
    }
    // A token lookup must be a point read on an index; a scan would make
    // verification time depend on how many tokens exist.
    expect(CONVEX_SHARE_TABLES).toContain("index('by_token_id', ['tokenId'])")
    expect(CONVEX_SHARE_TABLES).toContain("index('by_slug', ['slug'])")
    expect(CONVEX_SHARE_TABLES).toContain("index('by_visibility_published', ['visibility', 'publishedAt'])")
    // The stored token field is the hash. If this string ever becomes
    // `secret:`, the merge instructions are wrong and the test should say so.
    expect(CONVEX_SHARE_TABLES).toContain('secretHash: v.string()')
    expect(CONVEX_SHARE_TABLES).not.toMatch(/\bsecret:\s*v\./)
    expect(CONVEX_SHARE_FUNCTIONS).toContain('SHARE_PUBLISH_TOKEN')
  })
})

/**
 * The gallery listing reads one record per entry it returns, not one per
 * publication that exists.
 *
 * The feed index used to hold every publication and `listPublic` filtered it,
 * so a namespace whose publications are mostly unlisted — the ordinary case —
 * spent a KV read on each of them before it could return a visible one. A
 * Worker has a finite subrequest budget, so that is not a slow gallery, it is
 * one that starts failing at a size nobody chose.
 */
describe('the gallery index', () => {
  /** Counts record reads so the listing's cost can be asserted, not assumed. */
  class CountingKv extends MemoryKv {
    reads = 0
    override get(key: string, type: 'text'): Promise<string | null>
    override get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
    override get(key: string, type: 'text' | 'arrayBuffer') {
      if (key.startsWith('pub:slug:')) this.reads += 1
      return super.get(key, type as 'text')
    }
  }

  const counting = () => {
    const kv = new CountingKv()
    return { kv, store: new KvPublicationStore(kv) }
  }

  it('reads only the records it returns, whatever else is stored', async () => {
    const { kv, store } = counting()
    for (let index = 0; index < 30; index += 1) {
      await store.put(await publish(index, { visibility: 'unlisted', title: `Hidden ${index}` }))
    }
    await store.put(await publish(99, { title: 'The one public build' }))

    kv.reads = 0
    const page = await store.listPublic({ limit: 24 })
    expect(page.entries.map((entry) => entry.title)).toEqual(['The one public build'])
    // One read for the one entry. Thirty unlisted publications cost nothing.
    expect(kv.reads).toBe(1)
  })

  it('drops a publication from the gallery when it is revoked', async () => {
    const { store } = counting()
    const publication = await publish(4)
    await store.put(publication)
    expect((await store.listPublic()).entries).toHaveLength(1)

    await store.updateMetadata(revokePublication(publication))
    expect((await store.listPublic()).entries).toEqual([])
  })

  it('adds a publication to the gallery when it becomes public', async () => {
    const { store } = counting()
    const publication = await publish(4, { visibility: 'unlisted' })
    await store.put(publication)
    expect((await store.listPublic()).entries).toEqual([])

    await store.updateMetadata(updatePublicationAccess(publication, { visibility: 'public' }))
    expect((await store.listPublic()).entries.map((entry) => entry.slug)).toEqual([publication.slug])
  })

  it('repairs an index entry that no longer matches its record', async () => {
    // An entry can outlive the state that justified it — a record written by an
    // older build, or a write that landed and its index update that did not.
    // The listing must not serve it, and must not pay to rediscover it.
    const { kv, store } = counting()
    const publication = await publish(4)
    await store.put(publication)
    await kv.put(`pub:slug:${publication.slug}`, JSON.stringify({ ...publication, visibility: 'unlisted' }))

    expect((await store.listPublic()).entries).toEqual([])
    kv.reads = 0
    expect((await store.listPublic()).entries).toEqual([])
    expect(kv.reads).toBe(0)
  })
})
