// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../src/cad/catalog'
import fixture from '../../src/cad/__fixtures__/catalog.fixture.json'
import { MemoryKv } from '../../src/features/share/backend/memory-kv'
import { KvPublicationStore } from '../../src/features/share/backend/kv-store'
import { createPublication, revokePublication, updatePublicationAccess } from '../../src/features/share/publish'
import type { ModelDocument } from '../../src/cad/types'
import type { ShareEnv } from '../_lib/env'
import { onRequestGet as sharePage } from './[slug]'
import { onRequestGet as embedPage } from '../embed/[slug]'

/**
 * The share and embed pages are revalidated rather than re-sent.
 *
 * Both carried `must-revalidate` with no validator, which is not caching at
 * all: every reload of a share link re-rendered the page and shipped the whole
 * body. What makes a validator safe here is that it is derived from the
 * publication and the access decision, so a revocation moves it on the next
 * request — the pages embed mutable state, and that is exactly why they must be
 * revalidated and must not be cached outright.
 */

catalog.install(fixture as unknown as CatalogPayload)

let kv: MemoryKv
let store: KvPublicationStore

beforeEach(() => {
  kv = new MemoryKv()
  store = new KvPublicationStore(kv)
})

const env = () => ({ SHARE_KV: kv, SHARE_ORIGIN: 'https://brickwrite.test' }) as ShareEnv

const document_ = () =>
  ({
    schemaVersion: 2,
    id: 'doc-1',
    name: 'Public build',
    revision: 0,
    catalogVersion: 'fixture-1',
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    parts: {},
    connections: {},
    subassemblies: {},
    steps: [],
    notes: [],
    constraints: [],
  }) as unknown as ModelDocument

/** Embedding is a capability, so the embed route needs it granted explicitly. */
const FULL = { view: true, comment: true, fork: true, download: true, embed: true }

async function published(title = 'Public build') {
  const publication = await createPublication({
    document: document_(),
    capabilities: FULL,
    title,
  })
  await store.put(publication)
  return publication
}

const get = (route: typeof sharePage, path: 'share' | 'embed', slug: string, ifNoneMatch?: string): Promise<Response> =>
  route({
    request: new Request(`https://brickwrite.test/${path}/${slug}`, {
      headers: { accept: 'text/html', ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}) },
    }),
    env: env(),
    params: { slug },
  })

const quoted = (response: Response) => response.headers.get('etag') ?? ''

describe('the share page', () => {
  it('offers a validator, and answers 304 to a caller that already holds it', async () => {
    const publication = await published()
    const first = await get(sharePage, 'share', publication.slug)
    expect(first.status).toBe(200)
    expect(quoted(first)).toMatch(/^"[0-9a-f]{64}"$/)

    const second = await get(sharePage, 'share', publication.slug, quoted(first))
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    expect(quoted(second)).toBe(quoted(first))
  })

  it('sends no Content-Security-Policy on a 304', async () => {
    /*
     * A 304 replaces the stored response's headers with the ones it carries,
     * and the stored page's inline script is bound to the nonce in the CSP it
     * was served with. A fresh nonce here would leave the cached body holding
     * one nothing allows — a page that renders blank on every revalidation.
     */
    const publication = await published()
    const first = await get(sharePage, 'share', publication.slug)
    expect(first.headers.get('content-security-policy')).toContain('nonce-')

    const second = await get(sharePage, 'share', publication.slug, quoted(first))
    expect(second.headers.get('content-security-policy')).toBeNull()
  })

  it('keeps revalidating rather than letting a cache serve the page outright', async () => {
    const publication = await published()
    for (const response of [
      await get(sharePage, 'share', publication.slug),
      await get(sharePage, 'share', publication.slug, quoted(await get(sharePage, 'share', publication.slug))),
    ]) {
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    }
  })

  it('moves the validator when mutable state changes the page', async () => {
    /*
     * The reason these pages may be revalidated but not cached. Capabilities
     * are the case worth asserting: access is still granted, so the request
     * reaches the validator, and a stale tag would serve a page whose fork and
     * download controls no longer match what the author allows.
     */
    const publication = await published()
    const before = quoted(await get(sharePage, 'share', publication.slug))

    await store.updateMetadata(
      updatePublicationAccess(publication, { capabilities: { ...FULL, fork: false, download: false } }),
    )
    const after = await get(sharePage, 'share', publication.slug, before)
    expect(after.status).toBe(200)
    expect(quoted(after)).not.toBe(before)
  })

  it('refuses a revoked publication even to a caller holding the old validator', async () => {
    // Access is resolved before the validator is consulted, so a tag cannot be
    // replayed to resurrect a page whose author withdrew it.
    const publication = await published()
    const before = quoted(await get(sharePage, 'share', publication.slug))

    await store.updateMetadata(revokePublication(publication))
    const after = await get(sharePage, 'share', publication.slug, before)
    expect(after.status).toBeGreaterThanOrEqual(400)
  })

  it('does not honour another page’s validator', async () => {
    const first = await published()
    const firstTag = quoted(await get(sharePage, 'share', first.slug))
    // A second publication of the same document is a different page.
    const second = await published('Another build')

    expect((await get(sharePage, 'share', second.slug, firstTag)).status).toBe(200)
  })
})

describe('the embed page', () => {
  it('answers 304 to a caller that already holds the page', async () => {
    const publication = await published()
    const first = await get(embedPage, 'embed', publication.slug)
    expect(first.status).toBe(200)

    const second = await get(embedPage, 'embed', publication.slug, quoted(first))
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('does not answer the share page’s validator', async () => {
    // Same publication, different document. One tag must not satisfy the other.
    const publication = await published()
    const shareTag = quoted(await get(sharePage, 'share', publication.slug))
    expect((await get(embedPage, 'embed', publication.slug, shareTag)).status).toBe(200)
  })
})
