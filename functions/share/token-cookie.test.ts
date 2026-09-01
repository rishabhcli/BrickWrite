// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../src/cad/catalog'
import fixture from '../../src/cad/__fixtures__/catalog.fixture.json'
import { MemoryKv } from '../../src/features/share/backend/memory-kv'
import { KvPublicationStore } from '../../src/features/share/backend/kv-store'
import { createPublication, updatePublicationAccess } from '../../src/features/share/publish'
import { mintShareToken } from '../../src/features/share/tokens'
import type { ModelDocument } from '../../src/cad/types'
import type { ShareEnv } from '../_lib/env'
import { onRequestGet } from './[slug]'

/**
 * Getting the unlisted-link secret out of the query string.
 *
 * The token design is sound — 256-bit secret, hashed at rest, constant-time
 * compare — but a secret that travels as `?t=` is a secret written into
 * Cloudflare's access log, the visitor's browser history, their session
 * restore, and every proxy between. `redactShareUrl` sanitises the strings this
 * application echoes; it cannot reach any of those.
 *
 * So the parameter becomes a bootstrap: presented once, exchanged for an
 * `HttpOnly` cookie scoped to that publication's path, and redirected away.
 * What is asserted below is that the exchange happens, that the clean URL still
 * works afterwards, and that a rejected token is never written to a cookie.
 */

catalog.install(fixture as unknown as CatalogPayload)

let kv: MemoryKv
let store: KvPublicationStore

const env = () => ({ SHARE_KV: kv, SHARE_ORIGIN: 'https://brickwrite.test' }) as ShareEnv

const document_ = () =>
  ({
    schemaVersion: 2,
    id: 'doc-1',
    name: 'Unlisted build',
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

/** An unlisted publication plus a working link secret for it. */
async function unlisted() {
  const created = await createPublication({ document: document_(), visibility: 'unlisted', title: 'Unlisted build' })
  const publication = updatePublicationAccess(created, { visibility: 'unlisted' })
  await store.put(publication)
  const minted = await mintShareToken({
    publicationId: publication.id,
    slug: publication.slug,
    scope: publication.capabilities,
    label: 'Link',
    expiresAt: null,
  })
  await store.putToken(minted.record)
  return { publication, token: minted.token }
}

function get(slug: string, options: { token?: string; cookie?: string } = {}): Promise<Response> {
  const url = new URL(`https://brickwrite.test/share/${slug}`)
  if (options.token) url.searchParams.set('t', options.token)
  return onRequestGet({
    request: new Request(url, {
      headers: { accept: 'text/html', ...(options.cookie ? { cookie: options.cookie } : {}) },
    }),
    env: env(),
    params: { slug },
  })
}

/** The `name=value` pair from a `Set-Cookie`, without its attributes. */
const cookiePair = (header: string | null) => (header ? header.split(';')[0] : null)

beforeEach(() => {
  kv = new MemoryKv()
  store = new KvPublicationStore(kv)
})

describe('the query parameter is a bootstrap, not the credential', () => {
  it('exchanges a valid token for a cookie and redirects to the clean address', async () => {
    const { publication, token } = await unlisted()
    const response = await get(publication.slug, { token })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/share/${publication.slug}`)
    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    // Scoped to the one publication, so a link to one unlisted model is never
    // sent to another.
    expect(setCookie).toContain(`Path=/share/${publication.slug}`)
  })

  it('never lets the redirect carry the secret onward', async () => {
    const { publication, token } = await unlisted()
    const response = await get(publication.slug, { token })
    expect(response.headers.get('location')).not.toContain(token)
    expect(response.headers.get('location')).not.toContain('t=')
  })

  it('serves the page from the cookie once the parameter is gone', async () => {
    const { publication, token } = await unlisted()
    const handoff = await get(publication.slug, { token })
    const cookie = cookiePair(handoff.headers.get('set-cookie'))!

    const page = await get(publication.slug, { cookie })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Unlisted build')
  })

  it('refuses the clean address with no cookie and no parameter', async () => {
    const { publication } = await unlisted()
    const response = await get(publication.slug)
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('does not tell a caller with a cookie for another publication anything', async () => {
    const mine = await unlisted()
    const theirs = await unlisted()
    const handoff = await get(mine.publication.slug, { token: mine.token })
    const cookie = cookiePair(handoff.headers.get('set-cookie'))!

    const response = await get(theirs.publication.slug, { cookie })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('a token that does not work', () => {
  it('is never written to a cookie', async () => {
    const { publication } = await unlisted()
    const response = await get(publication.slug, { token: 'not-a-real-token' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('does not clear a working cookie the visitor already holds', async () => {
    const { publication, token } = await unlisted()
    const handoff = await get(publication.slug, { token })
    const cookie = cookiePair(handoff.headers.get('set-cookie'))!
    // A bad `?t=` alongside a good cookie must not lock the visitor out of a
    // publication they already have access to.
    const response = await get(publication.slug, { token: 'wrong', cookie })
    expect(response.status).toBe(200)
  })
})

describe('a public publication', () => {
  it('needs no token and is served directly, with no cookie set', async () => {
    const created = await createPublication({ document: document_(), visibility: 'public', title: 'Public build' })
    await store.put(updatePublicationAccess(created, { visibility: 'public' }))

    const response = await get(created.slug)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
