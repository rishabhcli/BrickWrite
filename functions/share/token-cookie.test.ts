// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../src/cad/catalog'
import fixture from '../../src/cad/__fixtures__/catalog.fixture.json'
import { MemoryKv } from '../../src/features/share/backend/memory-kv'
import { KvPublicationStore } from '../../src/features/share/backend/kv-store'
import { createPublication } from '../../src/features/share/publish'
import type { ModelDocument } from '../../src/cad/types'
import type { ShareEnv } from '../_lib/env'
import { onRequestGet } from './[slug]'
import { onRequestGet as subResource } from './[slug]/[[rest]]'

/**
 * A publication needs no credential.
 *
 * This route used to exchange an unlisted link's `?t=` secret for an
 * `HttpOnly` cookie before serving anything, because the secret itself must
 * never linger in a log, a browser history entry or a referrer. Every
 * publication is public now, so there is no secret to protect — what these
 * tests hold onto is that the page and its sub-resources (`view.json`,
 * `summary.json`, `model.json`, cards) serve directly, that a stray `?t=`
 * does nothing rather than something surprising, and that a capability the
 * publisher turned off is still enforced with no visibility exception to
 * hide behind.
 */

catalog.install(fixture as unknown as CatalogPayload)

let kv: MemoryKv
let store: KvPublicationStore

const env = () => ({ SHARE_KV: kv, SHARE_ORIGIN: 'https://brickwrite.test' }) as ShareEnv

const document_ = () =>
  ({
    schemaVersion: 2,
    id: 'doc-1',
    name: 'Test build',
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

async function published(capabilities?: Partial<{ view: boolean; comment: boolean; fork: boolean; download: boolean; embed: boolean }>) {
  const publication = await createPublication({ document: document_(), capabilities })
  await store.put(publication)
  return publication
}

function get(slug: string, options: { token?: string } = {}): Promise<Response> {
  const url = new URL(`https://brickwrite.test/share/${slug}`)
  if (options.token) url.searchParams.set('t', options.token)
  return onRequestGet({
    request: new Request(url, { headers: { accept: 'text/html' } }),
    env: env(),
    params: { slug },
  })
}

function sub(slug: string, rest: string[], options: { token?: string } = {}): Promise<Response> {
  const url = new URL(`https://brickwrite.test/share/${slug}/${rest.join('/')}`)
  if (options.token) url.searchParams.set('t', options.token)
  return subResource({ request: new Request(url), env: env(), params: { slug, rest } })
}

beforeEach(() => {
  kv = new MemoryKv()
  store = new KvPublicationStore(kv)
})

describe('a published build', () => {
  it('needs no token and is served directly, with no cookie set', async () => {
    const publication = await published()
    const response = await get(publication.slug)
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('ignores a token in the address, since nothing needs one anymore', async () => {
    const publication = await published()
    const response = await get(publication.slug, { token: 'whatever-a-visitor-might-still-have-bookmarked' })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('refuses an unknown slug', async () => {
    expect((await get('no-such-build')).status).toBeGreaterThanOrEqual(400)
  })
})

describe('sub-resources', () => {
  it('serves JSON sub-resources with no credential needed', async () => {
    const publication = await published()
    for (const resource of ['view.json', 'summary.json']) {
      const response = await sub(publication.slug, [resource])
      expect(response.status, `${resource} refused an ordinary request`).toBe(200)
    }
  })

  it('still gates a capability the publisher turned off, with no visibility exception to hide behind', async () => {
    const publication = await published({ download: false })
    expect((await sub(publication.slug, ['model.json'])).status).toBe(403)
  })

  it('refuses a sub-resource for an unknown slug', async () => {
    expect((await sub('no-such-build', ['view.json'])).status).toBe(404)
  })
})
