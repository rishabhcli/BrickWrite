// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../src/cad/catalog'
import fixture from '../../src/cad/__fixtures__/catalog.fixture.json'
import { MemoryKv } from '../../src/features/share/backend/memory-kv'
import { createPublication } from '../../src/features/share/publish'
import type { ModelDocument } from '../../src/cad/types'
import type { Publication } from '../../src/features/share/types'
import { OPERATOR_SUBJECT, resetShareSessionVerifier, type ShareEnv } from '../_lib/env'
import { onRequest } from './[[route]]'

/**
 * `/publications/*`, against the handler that deploys.
 *
 * The property under test is ownership. Before this existed, one shared bearer
 * gated every write and `mustFind` resolved a publication by slug and mutated it
 * without ever asking who was holding the pen — so any principal that satisfied
 * the secret could revoke, retarget or mint links against anybody's model. The
 * assertions below are that a second account cannot, and that what gets stored
 * is what this deployment derived rather than what the caller sent.
 */

catalog.install(fixture as unknown as CatalogPayload)

const ISSUER = 'https://hexclave.test/api/v1/projects/proj_test'
const ANONYMOUS_ISSUER = 'https://hexclave.test/api/v1/projects-anonymous-users/proj_test'
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

let signing: CryptoKeyPair
let jwks: { keys: unknown[] }

/** A real ES256 session for `subject`, signed by the key the JWKS serves. */
async function session(subject: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const input = `${encodeJson({ alg: 'ES256', kid: 'key-1', typ: 'JWT' })}.${encodeJson({
    iss: ISSUER,
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signing.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${b64url(new Uint8Array(signature))}`
}

/** A Hexclave guest session: its own issuer and audience, never a real one's. */
const anonymousSession = (subject: string) =>
  session(subject, { iss: ANONYMOUS_ISSUER, aud: 'proj_test:anon', is_anonymous: true, is_restricted: true })

let kv: MemoryKv

const env = (): ShareEnv =>
  ({
    SHARE_KV: kv,
    SHARE_PUBLISH_TOKEN: 'operator-secret',
    SHARE_ORIGIN: 'https://brickwrite.test',
    HEXCLAVE_PROJECT_ID: 'proj_test',
    HEXCLAVE_API_URL: 'https://hexclave.test',
  }) as ShareEnv

function call(
  path: string,
  options: { method?: string; credential?: string; body?: unknown } = {},
): Promise<Response> {
  const route = path.split('/').filter(Boolean)
  return onRequest({
    request: new Request(`https://brickwrite.test/publications/${route.join('/')}`, {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
      },
      ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }),
    env: env(),
    params: { route },
  })
}

const document_ = (): ModelDocument =>
  ({
    schemaVersion: 2,
    id: 'doc-1',
    name: 'Test build',
    revision: 3,
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

async function record(overrides: Partial<Publication> = {}): Promise<Publication> {
  const base = await createPublication({
    document: document_(),
    title: 'Test build',
  })
  return { ...base, ...overrides }
}

/** Publishes as `credential` and returns the stored record. */
async function publishAs(credential: string, overrides: Partial<Publication> = {}) {
  const publication = await record(overrides)
  const response = await call('', { credential, body: { publication, cards: {} } })
  return { response, publication }
}

const stored = (slug: string) =>
  kv.get(`pub:slug:${slug}`, 'text').then((raw) => (raw ? (JSON.parse(raw) as Publication) : null))

beforeEach(async () => {
  kv = new MemoryKv()
  resetShareSessionVerifier()
  signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', signing.publicKey)
  jwks = { keys: [{ ...publicJwk, kid: 'key-1', alg: 'ES256', use: 'sig' }] }
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes('jwks.json')
      ? new Response(JSON.stringify(jwks), { status: 200 })
      : new Response('no', { status: 404 })) as typeof fetch
})

describe('who may write at all', () => {
  it('refuses an unauthenticated caller', async () => {
    const { response } = await publishAs('')
    expect(response.status).toBe(403)
  })

  it('refuses a bearer that is neither a session nor the operator secret', async () => {
    expect((await publishAs('not-the-secret')).response.status).toBe(403)
  })

  it('refuses a session signed by a key the issuer does not publish', async () => {
    const impostor = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const real = signing
    signing = impostor
    const forged = await session('user_a')
    signing = real
    expect((await publishAs(forged)).response.status).toBe(403)
  })

  it('accepts a verified session', async () => {
    expect((await publishAs(await session('user_a'))).response.status).toBe(201)
  })

  it('accepts the operator secret', async () => {
    expect((await publishAs('operator-secret')).response.status).toBe(201)
  })
})

describe('publishing without an account', () => {
  it('accepts a Hexclave anonymous session', async () => {
    expect((await publishAs(await anonymousSession('anon_a'))).response.status).toBe(201)
  })

  it('records the anonymous session as the owner', async () => {
    const { publication } = await publishAs(await anonymousSession('anon_a'))
    expect((await stored(publication.slug))?.ownerSubject).toBe('anon_a')
  })

  it('still checks the anonymous session’s signature, not just its issuer', async () => {
    const impostor = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const real = signing
    signing = impostor
    const forged = await anonymousSession('anon_a')
    signing = real
    expect((await publishAs(forged)).response.status).toBe(403)
  })

  it('lets the same guest session manage what it published', async () => {
    const credential = await anonymousSession('anon_a')
    const { publication } = await publishAs(credential)
    const response = await call(`${publication.slug}/revoke`, { credential, body: {} })
    expect(response.status).toBe(200)
  })

  it('still requires the is_anonymous claim on the anonymous issuer, not just the right issuer and audience', async () => {
    const incomplete = await session('someone', { iss: ANONYMOUS_ISSUER, aud: 'proj_test:anon' })
    expect((await publishAs(incomplete)).response.status).toBe(403)
  })
})

describe('ownership', () => {
  it('records the publishing session as the owner', async () => {
    const { publication } = await publishAs(await session('user_a'))
    expect((await stored(publication.slug))?.ownerSubject).toBe('user_a')
  })

  it('records the operator, distinguishably, for tooling', async () => {
    const { publication } = await publishAs('operator-secret')
    expect((await stored(publication.slug))?.ownerSubject).toBe(OPERATOR_SUBJECT)
  })

  it('never takes the owner from the request body', async () => {
    const { publication } = await publishAs(await session('user_a'), { ownerSubject: 'user_victim' })
    expect((await stored(publication.slug))?.ownerSubject).toBe('user_a')
  })

  for (const [name, path, body] of [
    ['revoke', 'revoke', {}],
    ['access', 'access', { capabilities: { view: true, comment: false, fork: false, download: false, embed: false } }],
    ['tokens', 'tokens', {}],
  ] as const) {
    it(`refuses ${name} from a different account`, async () => {
      const { publication } = await publishAs(await session('user_a'))
      const response = await call(`${publication.slug}/${path}`, {
        credential: await session('user_b'),
        body,
      })
      // 404, not 403: for a private or unlisted publication, confirming the
      // slug exists is the fact its publisher chose not to disclose.
      expect(response.status).toBe(404)
    })

    it(`allows ${name} from the owner`, async () => {
      const { publication } = await publishAs(await session('user_a'))
      const response = await call(`${publication.slug}/${path}`, {
        credential: await session('user_a'),
        body,
      })
      expect(response.status).toBeLessThan(300)
    })
  }

  it('does not let another account read the owner’s unlisted links', async () => {
    const { publication } = await publishAs(await session('user_a'))
    await call(`${publication.slug}/tokens`, { credential: await session('user_a'), body: {} })

    const theirs = await call(`${publication.slug}/tokens`, { method: 'GET', credential: await session('user_b') })
    expect(theirs.status).toBe(404)
    const mine = await call(`${publication.slug}/tokens`, { method: 'GET', credential: await session('user_a') })
    expect(mine.status).toBe(200)
    expect((await mine.json()).tokens).toHaveLength(1)
  })

  it('leaves the record untouched when a write is refused', async () => {
    const { publication } = await publishAs(await session('user_a'))
    await call(`${publication.slug}/revoke`, { credential: await session('user_b'), body: {} })
    expect((await stored(publication.slug))?.revokedAt).toBeNull()
  })

  it('lets the operator administer a legacy publication that carries no owner', async () => {
    const { publication } = await publishAs('operator-secret')
    // Strip the owner, reproducing a record written before ownership existed.
    const legacy = { ...(await stored(publication.slug))!, ownerSubject: undefined }
    await kv.put(`pub:slug:${publication.slug}`, JSON.stringify(legacy))

    expect((await call(`${publication.slug}/revoke`, { credential: 'operator-secret', body: {} })).status).toBe(200)
  })

  it('does not let a session claim a legacy publication that carries no owner', async () => {
    const { publication } = await publishAs('operator-secret')
    const legacy = { ...(await stored(publication.slug))!, ownerSubject: undefined }
    await kv.put(`pub:slug:${publication.slug}`, JSON.stringify(legacy))

    expect((await call(`${publication.slug}/revoke`, { credential: await session('user_a'), body: {} })).status).toBe(404)
  })

  it('lets anyone signed in report somebody else’s publication', async () => {
    const { publication } = await publishAs(await session('user_a'))
    // Reporting is the one write a non-owner is supposed to be able to make.
    const response = await call(`${publication.slug}/report`, {
      credential: await session('user_b'),
      body: { reason: 'infringement', detail: 'Copied from my build.' },
    })
    expect(response.status).toBe(201)
  })
})

describe('what actually gets stored', () => {
  it('refuses a record whose content hash does not match its document', async () => {
    const { response } = await publishAs(await session('user_a'), { contentHash: 'f'.repeat(64) })
    expect(response.status).toBe(400)
  })

  it('refuses a record whose summary does not describe its own snapshot', async () => {
    const base = await record()
    const { response } = await publishAs(await session('user_a'), {
      summary: { ...base.summary, partCount: base.summary.partCount + 500 },
    })
    expect(response.status).toBe(400)
  })

  it('refuses a record whose revision disagrees with its snapshot', async () => {
    const { response } = await publishAs(await session('user_a'), { revision: 99 })
    expect(response.status).toBe(400)
  })

  it('refuses a slug that is not the shape mintSlug produces', async () => {
    for (const slug of ['../escape', 'Has Capitals', 'trailing-', 'a'.repeat(120)]) {
      const { response } = await publishAs(await session('user_a'), { slug })
      expect(response.status).toBe(400)
    }
  })

  it('refuses to overwrite an address that already has a publication', async () => {
    const { publication } = await publishAs(await session('user_a'))
    // Immutability: somebody already holds a link to that artifact.
    const again = await call('', {
      credential: await session('user_b'),
      body: { publication: await record({ slug: publication.slug }), cards: {} },
    })
    expect(again.status).toBe(409)
  })

  it('forces a submitted revocation and moderation state back to null', async () => {
    const { publication } = await publishAs(await session('user_a'), {
      revokedAt: new Date().toISOString(),
      moderation: { status: 'cleared', reason: 'I cleared myself', decidedAt: new Date().toISOString() },
    })
    const saved = await stored(publication.slug)
    expect(saved?.revokedAt).toBeNull()
    expect(saved?.moderation).toBeNull()
  })

  it('stores every publication as public, whatever the client claims', async () => {
    const { publication } = await publishAs(await session('user_a'), {
      visibility: 'private' as Publication['visibility'],
    })
    const saved = await stored(publication.slug)
    expect(saved?.visibility).toBe('public')
  })

  it('re-sanitises text the client is trusted to have sanitised', async () => {
    const { publication } = await publishAs(await session('user_a'), {
      title: '  <script>alert(1)</script>  ',
      description: '<img src=x onerror=alert(1)>',
      tags: ['<b>bold</b>', '   ', 'ok'],
    })
    const saved = await stored(publication.slug)
    // The sanitizers strip the delimiters rather than the words: what makes
    // `<script>alert(1)</script>` inert is that no `<` survives to open a tag.
    // Output escaping in `page.ts` is the second layer; this is the first one,
    // which until now only ever ran in the browser that chose the text.
    expect(saved?.title).not.toMatch(/[<>]/)
    expect(saved?.description).not.toMatch(/[<>]/)
    expect(saved?.title).not.toMatch(/^\s|\s$/)
    // Tags are narrowed further, to a single lowercase word, and blanks drop.
    expect(saved?.tags).toEqual(['b-bold-b', 'ok'])
  })

})

/**
 * A publish whose response went missing.
 *
 * The client mints the slug and posts the record, so a retry resends exactly
 * what it sent before. This used to answer that with 409 "a publication already
 * exists at that address" — telling the publisher their address was taken by
 * their own publication. A large model over a slow link is precisely when a
 * response goes missing, and the ways out were to reload and guess or to
 * publish a second copy at a second address.
 */
describe('a repeated publish', () => {
  it('answers with the original outcome rather than a conflict', async () => {
    const credential = await session('user_a')
    const publication = await record()

    const first = await call('', { credential, body: { publication, cards: {} } })
    expect(first.status).toBe(201)

    const again = await call('', { credential, body: { publication, cards: {} } })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    // One publication, not two, and it is the one that was published.
    expect((await stored(publication.slug))?.id).toBe(publication.id)
  })

  it('still refuses a different snapshot at the same address', async () => {
    const credential = await session('user_a')
    const publication = await record()
    expect((await call('', { credential, body: { publication, cards: {} } })).status).toBe(201)

    const different = { ...publication, contentHash: 'f'.repeat(64) }
    const clash = await call('', { credential, body: { publication: different, cards: {} } })
    expect(clash.status).toBe(409)
    // The stored snapshot is untouched, which is what create-only is for.
    expect((await stored(publication.slug))?.contentHash).toBe(publication.contentHash)
  })

  it('does not acknowledge another account’s publication as its own retry', async () => {
    // Identity alone is not enough: the retry has to come from the publisher.
    const publication = await record()
    expect((await call('', { credential: await session('user_a'), body: { publication, cards: {} } })).status).toBe(201)

    const other = await call('', { credential: await session('user_b'), body: { publication, cards: {} } })
    expect(other.status).toBe(409)
    expect((await stored(publication.slug))?.ownerSubject).toBe('user_a')
  })
})
