import { describe, expect, it } from 'vitest'
import { privateDocument } from '../__fixtures__/model'
import { createPublication, revokePublication, updatePublicationAccess } from '../publish'
import { mintShareToken, revokeToken } from '../tokens'
import { reporterPseudonym, reportIdFor, resolveReport } from '../../gallery/moderation'
import { ShareError, type Report } from '../types'
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

  it('refuses a *different* publication at a taken slug, and accepts the same one again', async () => {
    /*
     * What create-only is for: an existing link must never start showing a
     * different model. An identical record cannot do that, and refusing it was
     * how a retried publish — the client mints the slug, so a retry resends it
     * — got told its address was taken by its own publication.
     */
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)

    await expect(store.put({ ...publication, id: 'pub_other' })).rejects.toThrow(/already exists/)
    await expect(store.put({ ...publication, contentHash: 'f'.repeat(64) })).rejects.toThrow(ShareError)
    await expect(store.put({ ...publication, revision: publication.revision + 1 })).rejects.toThrow(ShareError)

    await expect(store.put(publication)).resolves.toBeUndefined()
    expect((await store.getBySlug(publication.slug))?.id).toBe(publication.id)
  })

  it('repairs a half-written publication when the same write is repeated', async () => {
    // The pointers and the feed entry are re-asserted, so a create that landed
    // in pieces completes rather than needing a second slug.
    const { kv, store } = build()
    const publication = await publish(4)
    await store.put(publication)
    await kv.delete(`pub:id:${publication.id}`)

    await store.put(publication)
    expect((await store.getById(publication.id))?.slug).toBe(publication.slug)
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

  it('allows capability, revocation and moderation changes', async () => {
    const { store } = build()
    const publication = await publish(4)
    await store.put(publication)

    const closed = updatePublicationAccess(publication, { capabilities: { ...FULL, view: false } })
    await store.updateMetadata(closed)
    expect((await store.getBySlug(publication.slug))?.capabilities.view).toBe(false)

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
    const notViewable = await publish(9, {
      capabilities: { ...FULL, view: false },
      now: new Date(Date.UTC(2026, 5, 1)),
    })
    await store.put(notViewable)
    const hidden = await publish(10, { now: new Date(Date.UTC(2026, 5, 2)) })
    await store.put(revokePublication(hidden))
    await store.updateMetadata(revokePublication(hidden))

    const page = await store.listPublic({ limit: 10 })
    expect(page.entries.map((entry) => entry.slug)).toEqual([...visible].reverse())
    expect(page.entries.some((entry) => entry.slug === notViewable.slug)).toBe(false)
    expect(page.entries.some((entry) => entry.slug === hidden.slug)).toBe(false)
  })

  it('fills a page rather than returning a short one', async () => {
    const { store } = build()
    const listable: string[] = []
    for (let index = 0; index < 6; index += 1) {
      // Alternating not-viewable entries mean a naive implementation that took
      // one KV page and filtered it would return half a page.
      const publication = await publish(index + 1, {
        capabilities: index % 2 === 0 ? FULL : { ...FULL, view: false },
        now: new Date(Date.UTC(2026, 0, index + 1)),
      })
      await store.put(publication)
      if (index % 2 === 0) listable.push(publication.slug)
    }
    const page = await store.listPublic({ limit: 3 })
    expect(page.entries).toHaveLength(3)
    expect(page.entries.every((entry) => entry.capabilities.view)).toBe(true)
    // Newest first, same as the plain-public case above.
    expect(page.entries.map((entry) => entry.slug)).toEqual([...listable].reverse())
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
      await store.put(await publish(index, { capabilities: { ...FULL, view: false }, title: `Hidden ${index}` }))
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

  it('adds a publication to the gallery when it becomes viewable', async () => {
    const { store } = counting()
    const publication = await publish(4, { capabilities: { ...FULL, view: false } })
    await store.put(publication)
    expect((await store.listPublic()).entries).toEqual([])

    await store.updateMetadata(updatePublicationAccess(publication, { capabilities: { view: true } }))
    expect((await store.listPublic()).entries.map((entry) => entry.slug)).toEqual([publication.slug])
  })

  it('repairs an index entry that no longer matches its record', async () => {
    // An entry can outlive the state that justified it — a record written by an
    // older build, or a write that landed and its index update that did not.
    // The listing must not serve it, and must not pay to rediscover it.
    const { kv, store } = counting()
    const publication = await publish(4)
    await store.put(publication)
    await kv.put(
      `pub:slug:${publication.slug}`,
      JSON.stringify({ ...publication, capabilities: { ...publication.capabilities, view: false } }),
    )

    expect((await store.listPublic()).entries).toEqual([])
    kv.reads = 0
    expect((await store.listPublic()).entries).toEqual([])
    expect(kv.reads).toBe(0)
  })
})

/**
 * Reports, and the two things the schema said this endpoint did.
 *
 * `submitReport` was documented as "rate-limited per reporterRef" and
 * `listReports` as "by_status". Neither held: the reference came off the
 * request body, so one account could file unlimited reports by sending a
 * different one each time, and the listing scanned every report ever filed and
 * filtered what came back — so once resolved reports outnumbered the window, a
 * moderation queue stopped showing new work without saying so.
 */
describe('the moderation queue', () => {
  const report = (overrides: Partial<Report> = {}): Report => ({
    id: 'rep_one',
    publicationId: 'pub_1',
    slug: 'rover-abc',
    reason: 'other',
    detail: 'This model reproduces a copyrighted set verbatim.',
    createdAt: '2026-09-01T12:00:00.000Z',
    status: 'open',
    reporterRef: 'a'.repeat(64),
    resolvedAt: null,
    ...overrides,
  })

  it('gives one reporter one report per publication', async () => {
    const first = await reporterPseudonym('pub_1', 'user_a')
    const again = await reporterPseudonym('pub_1', 'user_a')
    expect(reportIdFor(again)).toBe(reportIdFor(first))

    const { store } = build()
    await store.putReport(report({ id: reportIdFor(first), detail: 'First telling of it.' }))
    await store.putReport(report({ id: reportIdFor(again), detail: 'Second telling of it.' }))
    const open = await store.listReports({ status: 'open' })
    expect(open).toHaveLength(1)
    expect(open[0].detail).toBe('Second telling of it.')
  })

  it('keeps the same account’s reports on two publications apart', async () => {
    // Scoped per publication, so the table cannot be read as one person's
    // activity across the gallery.
    const here = await reporterPseudonym('pub_1', 'user_a')
    const there = await reporterPseudonym('pub_2', 'user_a')
    expect(there).not.toBe(here)
    expect(reportIdFor(there)).not.toBe(reportIdFor(here))
  })

  it('gives two reporters two reports', async () => {
    const { store } = build()
    for (const subject of ['user_a', 'user_b']) {
      const ref = await reporterPseudonym('pub_1', subject)
      await store.putReport(report({ id: reportIdFor(ref), reporterRef: ref }))
    }
    expect(await store.listReports({ status: 'open' })).toHaveLength(2)
  })

  it('still surfaces an open report behind a backlog past the scan window', async () => {
    // Deliberately more resolved reports than a `rep:` scan can return, and
    // named so they sort ahead of the open one. That is the shape the old
    // scan-and-filter listing could not see past, and the reason it had to
    // become an index rather than a wider window.
    const { store } = build()
    for (let index = 0; index < 520; index += 1) {
      await store.putReport(
        report({
          id: `rep_done_${String(index).padStart(4, '0')}`,
          status: 'dismissed',
          resolvedAt: '2026-09-01T13:00:00.000Z',
          createdAt: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
        }),
      )
    }
    await store.putReport(report({ id: 'rep_live', createdAt: '2026-09-02T12:00:00.000Z' }))

    const open = await store.listReports({ status: 'open' })
    expect(open.map((entry) => entry.id)).toEqual(['rep_live'])
  })

  it('drops a report from the queue when it is resolved', async () => {
    const { store } = build()
    const filed = report()
    await store.putReport(filed)
    expect(await store.listReports({ status: 'open' })).toHaveLength(1)

    await store.putReport(resolveReport(filed, 'dismissed'))
    expect(await store.listReports({ status: 'open' })).toEqual([])
    // Resolved reports are kept; a moderator's decision is a record.
    expect(await store.listReports({ status: 'dismissed' })).toHaveLength(1)
  })
})

/**
 * Half of an access change, because two KV writes are not one.
 *
 * The listing walks feed keys and reads each record, so it can repair an entry
 * whose record turns out not to be listable. It cannot notice an entry that
 * should exist and does not. That asymmetry decides the write order: the index
 * may be over-inclusive and must never be under-inclusive, or a publication
 * ends up live, reachable by its link, and absent from the gallery with nothing
 * able to discover that.
 */
describe('a partly applied access change', () => {
  /** Fails the nth write of a kind, so one half of a pair can be lost. */
  class FlakyKv extends MemoryKv {
    failPutMatching: RegExp | null = null
    failDeleteMatching: RegExp | null = null
    override async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void> {
      if (this.failPutMatching?.test(key)) throw new Error(`put refused for ${key}`)
      return super.put(key, value)
    }
    override async delete(key: string): Promise<void> {
      if (this.failDeleteMatching?.test(key)) throw new Error(`delete refused for ${key}`)
      return super.delete(key)
    }
  }

  const flaky = () => {
    const kv = new FlakyKv()
    return { kv, store: new KvPublicationStore(kv) }
  }

  it('does not strand a publication outside the gallery when revealing it', async () => {
    const { kv, store } = flaky()
    const publication = await publish(4, { capabilities: { ...FULL, view: false } })
    await store.put(publication)

    /*
     * The index write fails, which is the half that has to be able to fail
     * safely. Committing the record first and losing this one leaves a record
     * that says viewable with nothing pointing at it: live, reachable by its
     * link, and absent from the gallery, with no read able to discover it.
     */
    kv.failPutMatching = /^pub:feed:/
    await expect(
      store.updateMetadata(updatePublicationAccess(publication, { capabilities: { view: true } })),
    ).rejects.toThrow()
    kv.failPutMatching = null

    // Nothing claims to be viewable, so nothing is missing from the gallery.
    expect((await store.getBySlug(publication.slug))?.capabilities.view).toBe(false)
    expect((await store.listPublic()).entries).toEqual([])
  })

  it('leaves a reapable entry rather than a hidden one still listed, when hiding', async () => {
    const { kv, store } = flaky()
    const publication = await publish(4)
    await store.put(publication)
    expect((await store.listPublic()).entries).toHaveLength(1)

    // The delete is the second half here, so losing it is the recoverable case.
    kv.failDeleteMatching = /^pub:feed:/
    await expect(store.updateMetadata(revokePublication(publication))).rejects.toThrow()
    kv.failDeleteMatching = null

    // The record is authoritative and the listing agrees with it.
    expect((await store.getBySlug(publication.slug))?.revokedAt).toBeTruthy()
    expect((await store.listPublic()).entries).toEqual([])
  })

  it('does not leave an unlisted link its owner cannot revoke', async () => {
    /*
     * The worst half to lose. Verification reads the token record; `listTokens`
     * walks the index, and it is the only way an owner sees a link or withdraws
     * one. Record-first would leave a link that grants access, cannot be seen,
     * and cannot be revoked.
     */
    const { kv, store } = flaky()
    const publication = await publish(4)
    await store.put(publication)
    const minted = await mintShareToken({
      publicationId: publication.id,
      slug: publication.slug,
      scope: publication.capabilities,
      label: 'Link',
      expiresAt: null,
    })

    // The *index* write is the one to lose: record-first would already have
    // committed a verifiable token by the time this failed.
    kv.failPutMatching = /^tokidx:/
    await expect(store.putToken(minted.record)).rejects.toThrow()
    kv.failPutMatching = null

    // No record, so nothing verifies and nothing was granted out of reach.
    expect(await store.getToken(minted.record.id)).toBeNull()
    expect(await store.listTokens(publication.id)).toEqual([])
  })

  it('drops a token index entry whose record never landed', async () => {
    const { kv, store } = flaky()
    const publication = await publish(4)
    await store.put(publication)
    await kv.put('tokidx:' + publication.id + ':orphan', 'orphan')

    expect(await store.listTokens(publication.id)).toEqual([])
    expect(await kv.get('tokidx:' + publication.id + ':orphan', 'text')).toBeNull()
  })

  it('does not leave a publication its own tokens cannot resolve', async () => {
    // `getById` is how a token finds its publication. A record with no pointer
    // is live and reachable by slug while every token minted against it fails.
    const { kv, store } = flaky()
    const publication = await publish(4)

    // The pointer write is the one to lose. Record-first would already have
    // committed a publication its own tokens can never resolve.
    kv.failPutMatching = /^pub:id:/
    await expect(store.put(publication)).rejects.toThrow()
    kv.failPutMatching = null

    expect(await store.getBySlug(publication.slug)).toBeNull()
    expect(await store.getById(publication.id)).toBeNull()
  })

  it('does not leave a public publication missing from the gallery', async () => {
    const { kv, store } = flaky()
    const publication = await publish(4)

    kv.failPutMatching = /^pub:feed:/
    await expect(store.put(publication)).rejects.toThrow()
    kv.failPutMatching = null

    // Either it is in the gallery or it is not published at all.
    expect(await store.getBySlug(publication.slug)).toBeNull()
    expect((await store.listPublic()).entries).toEqual([])
  })

  it('does not leave a report the moderation queue will never surface', async () => {
    const { kv, store } = flaky()
    const filed = {
      id: 'rep_partial',
      publicationId: 'pub_1',
      slug: 'rover-abc',
      reason: 'other' as const,
      detail: 'This model reproduces a copyrighted set verbatim.',
      createdAt: '2026-09-01T12:00:00.000Z',
      status: 'open' as const,
      reporterRef: 'b'.repeat(64),
      resolvedAt: null,
    }

    kv.failPutMatching = /^repopen:/
    await expect(store.putReport(filed)).rejects.toThrow()
    kv.failPutMatching = null

    // A report that exists and is invisible is worse than one that was refused.
    expect(await store.listReports({ status: 'open' })).toEqual([])
    expect(await store.listReports()).toEqual([])
  })

  it('lets a publish retry finish what its own half-write started', async () => {
    // The id pointer lands before the record, so a retry meets its own pointer.
    // Refusing that would make one transient failure block the id forever.
    const { kv, store } = flaky()
    const publication = await publish(4)

    kv.failPutMatching = /^pub:slug:/
    await expect(store.put(publication)).rejects.toThrow()
    kv.failPutMatching = null

    await store.put(publication)
    expect((await store.getById(publication.id))?.slug).toBe(publication.slug)
    expect((await store.listPublic()).entries.map((entry) => entry.slug)).toEqual([publication.slug])
  })

  it('still refuses an id already pointing at a different publication', async () => {
    const { store } = flaky()
    const first = await publish(4)
    await store.put(first)
    const clash = { ...(await publish(5, { title: 'Different' })), id: first.id }
    await expect(store.put(clash)).rejects.toThrow(ShareError)
  })

  it('converges once the change is retried', async () => {
    const { kv, store } = flaky()
    const publication = await publish(4, { capabilities: { ...FULL, view: false } })
    await store.put(publication)
    const revealed = updatePublicationAccess(publication, { capabilities: { view: true } })

    kv.failPutMatching = /^pub:feed:/
    await expect(store.updateMetadata(revealed)).rejects.toThrow()
    kv.failPutMatching = null

    await store.updateMetadata(revealed)
    expect((await store.listPublic()).entries.map((entry) => entry.slug)).toEqual([publication.slug])
  })
})
