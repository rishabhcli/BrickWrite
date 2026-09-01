// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { createSessionVerifier } from './session'

/**
 * Session verification at the edge.
 *
 * The Node API verifies a Hexclave session with the SDK; a Cloudflare Function
 * cannot, so it checks the signature itself against the project's published
 * JWKS. That makes this file an identity authority, and the assertions below are
 * the ones an identity authority has to survive: a token signed by the wrong
 * key, a token whose algorithm the caller chose, an expired one, one from
 * another issuer, and one that is valid but not a principal we write as.
 */

const ISSUER = 'https://api.hexclave.com/api/v1/projects/proj_test'
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`
const NOW = 1_800_000_000_000

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function keypair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, jwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' } }
}

async function sign(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(signature))}`
}

let signer: Awaited<ReturnType<typeof keypair>>
let served: unknown
let fetches: number

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'user_abc',
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000) - 60,
  ...overrides,
})

function verifier() {
  return createSessionVerifier({
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    now: () => NOW,
    fetchImpl: async () => {
      fetches += 1
      return new Response(JSON.stringify(served), { status: 200 })
    },
  })
}

const token = (payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
  sign(signer.pair.privateKey, { alg: 'ES256', kid: 'key-1', typ: 'JWT', ...header }, claims(payload))

beforeEach(async () => {
  signer = await keypair('key-1')
  served = { keys: [signer.jwk] }
  fetches = 0
})

describe('a valid session', () => {
  it('resolves to the subject on the token', async () => {
    await expect(verifier().verify(await token())).resolves.toEqual({ subject: 'user_abc' })
  })

  it('fetches the key set once and reuses it', async () => {
    const active = verifier()
    await active.verify(await token())
    await active.verify(await token({ sub: 'user_def' }))
    expect(fetches).toBe(1)
  })
})

describe('a token that must not be accepted', () => {
  it('is refused when signed by a key the issuer does not publish', async () => {
    const impostor = await keypair('key-1')
    const forged = await sign(impostor.pair.privateKey, { alg: 'ES256', kid: 'key-1', typ: 'JWT' }, claims())
    await expect(verifier().verify(forged)).resolves.toBeNull()
  })

  it('is refused when the payload is edited after signing', async () => {
    const [header, , signature] = (await token()).split('.')
    const tampered = `${header}.${encodeJson(claims({ sub: 'somebody_else' }))}.${signature}`
    await expect(verifier().verify(tampered)).resolves.toBeNull()
  })

  it('is refused when it names an algorithm this verifier does not use', async () => {
    // `alg: none` and HMAC confusion are the two classic JWT breaks. The
    // algorithm is fixed by the verifier, never read from the token.
    await expect(verifier().verify(await token({}, { alg: 'none' }))).resolves.toBeNull()
    await expect(verifier().verify(await token({}, { alg: 'HS256' }))).resolves.toBeNull()
  })

  it('is refused when it has expired', async () => {
    await expect(verifier().verify(await token({ exp: Math.floor(NOW / 1000) - 1 }))).resolves.toBeNull()
  })

  it('is refused when it is not valid yet', async () => {
    await expect(verifier().verify(await token({ nbf: Math.floor(NOW / 1000) + 600 }))).resolves.toBeNull()
  })

  it('is refused when it carries no expiry at all', async () => {
    await expect(verifier().verify(await token({ exp: undefined }))).resolves.toBeNull()
  })

  it('is refused when it comes from another issuer', async () => {
    const other = `${ISSUER}-anonymous`
    await expect(verifier().verify(await token({ iss: other }))).resolves.toBeNull()
  })

  it('is refused when it is anonymous or restricted', async () => {
    // The same two classes the Convex layer and the paid API route refuse. A
    // token can be cryptographically valid and still not be a principal.
    await expect(verifier().verify(await token({ is_anonymous: true }))).resolves.toBeNull()
    await expect(verifier().verify(await token({ is_restricted: true }))).resolves.toBeNull()
  })

  it('is refused when it carries no subject', async () => {
    await expect(verifier().verify(await token({ sub: undefined }))).resolves.toBeNull()
  })

  it('is refused when it is not three segments', async () => {
    for (const malformed of ['', 'a', 'a.b', 'a.b.c.d', '...']) {
      await expect(verifier().verify(malformed)).resolves.toBeNull()
    }
  })

  it('is refused when the key set cannot be fetched', async () => {
    const offline = createSessionVerifier({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      now: () => NOW,
      fetchImpl: async () => {
        throw new Error('jwks unreachable')
      },
    })
    await expect(offline.verify(await token())).resolves.toBeNull()
  })

  it('is refused when the key set has no key with the token’s id', async () => {
    served = { keys: [{ ...signer.jwk, kid: 'some-other-key' }] }
    await expect(verifier().verify(await token())).resolves.toBeNull()
  })
})

describe('key rotation', () => {
  it('refetches once when a token names a key it has not seen', async () => {
    const active = verifier()
    await active.verify(await token())
    expect(fetches).toBe(1)

    const rotated = await keypair('key-2')
    served = { keys: [rotated.jwk] }
    const next = await sign(rotated.pair.privateKey, { alg: 'ES256', kid: 'key-2', typ: 'JWT' }, claims())
    await expect(active.verify(next)).resolves.toEqual({ subject: 'user_abc' })
    expect(fetches).toBe(2)
  })

  it('does not refetch on every unknown key', async () => {
    const active = verifier()
    await active.verify(await token())
    const before = fetches
    // Two misses in a row must not become two more fetches: an attacker sending
    // random `kid`s would otherwise drive unbounded requests at the issuer.
    await active.verify(await token({}, { kid: 'nope-1' }))
    await active.verify(await token({}, { kid: 'nope-2' }))
    expect(fetches).toBe(before + 1)
  })
})
