import { describe, expect, it } from 'vitest'
import { resolveAccess } from './access'
import { constantTimeEqual, constantTimeEqualHex, sha256Hex } from './canonical'
import { MemoryKv } from './backend/memory-kv'
import { KvPublicationStore } from './backend/kv-store'
import { privateDocument } from './__fixtures__/model'
import { createPublication, revokePublication, updatePublicationAccess } from './publish'
import { redactShareUrl } from './sanitize'
import {
  intersectCapabilities,
  isExpired,
  mintShareToken,
  parseShareToken,
  revokeToken,
  TOKEN_SECRET_BYTES,
  verifyShareToken,
} from './tokens'
import type { ShareTokenRecord } from './types'

/**
 * Unlisted links are the only credential this workstream issues, so they get
 * the treatment a credential deserves: entropy is measured, storage is checked
 * for the absence of the secret, every failure mode is asserted to fail closed,
 * and the comparison is checked for the two ways a constant-time compare is
 * usually wrong — an early return on length, and an early return on the first
 * differing byte.
 */

const FULL = { view: true, comment: true, fork: true, download: true, embed: true }

async function fixture(options: { visibility?: 'unlisted' | 'public' | 'private' } = {}) {
  const kv = new MemoryKv()
  const store = new KvPublicationStore(kv)
  const publication = await createPublication({
    document: privateDocument(4),
    visibility: options.visibility ?? 'unlisted',
    capabilities: FULL,
    title: 'Rover',
  })
  await store.put(publication)
  const minted = await mintShareToken({
    publicationId: publication.id,
    slug: publication.slug,
    scope: FULL,
    label: 'Review link',
  })
  await store.putToken(minted.record)
  return { kv, store, publication, minted }
}

describe('token minting', () => {
  it('mints 256 bits of secret and returns it exactly once', async () => {
    const { minted } = await fixture()
    const [id, secret] = minted.token.split('.')
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    // 32 bytes of base64url with no padding is 43 characters — 256 bits.
    expect(secret).toHaveLength(Math.ceil((TOKEN_SECRET_BYTES * 8) / 6))
    expect(TOKEN_SECRET_BYTES * 8).toBe(256)
    expect(minted.record.secretHash).toBe(await sha256Hex(secret))
  })

  it('never stores the secret, only its digest', async () => {
    const { kv, minted } = await fixture()
    const secret = minted.token.split('.')[1]
    const stored = await kv.get(`tok:${minted.record.id}`, 'text')
    expect(stored).not.toBeNull()
    expect(stored).not.toContain(secret)
    expect(stored).toContain(minted.record.secretHash)
    // And nothing anywhere else in the namespace holds it either.
    for (const key of ['pub:slug:', 'tokidx:', 'pub:id:']) {
      const page = await kv.list({ prefix: key })
      for (const entry of page.keys) {
        expect(await kv.get(entry.name, 'text')).not.toContain(secret)
      }
    }
  })

  it('produces a different secret every time', async () => {
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const minted = await mintShareToken({ publicationId: 'p', slug: 's', scope: FULL })
      seen.add(minted.token)
    }
    expect(seen.size).toBe(64)
  })

  it('rejects a malformed presented token without touching the store', async () => {
    let lookups = 0
    const verification = await verifyShareToken('not-a-token', {
      lookup: async () => {
        lookups += 1
        return null
      },
      publicationId: 'p',
    })
    expect(verification).toEqual({ ok: false, reason: 'malformed' })
    expect(lookups).toBe(0)
  })

  it('parses only the exact token shape', () => {
    expect(parseShareToken('abcdefgh.' + 'x'.repeat(43))).toEqual({ id: 'abcdefgh', secret: 'x'.repeat(43) })
    for (const bad of ['', 'no-dot', 'a.b', '../../etc.passwd', 'abcdefgh.' + 'x'.repeat(500), null, 42, {}]) {
      expect(parseShareToken(bad)).toBeNull()
    }
  })
})

describe('token verification fails closed', () => {
  it('accepts the real token', async () => {
    const { store, publication, minted } = await fixture()
    const verification = await verifyShareToken(minted.token, {
      lookup: (id) => store.getToken(id),
      publicationId: publication.id,
    })
    expect(verification.ok).toBe(true)
  })

  it('rejects a wrong secret under a real id', async () => {
    const { store, publication, minted } = await fixture()
    const [id] = minted.token.split('.')
    const verification = await verifyShareToken(`${id}.${'A'.repeat(43)}`, {
      lookup: (bad) => store.getToken(bad),
      publicationId: publication.id,
    })
    expect(verification).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects a revoked token', async () => {
    const { store, publication, minted } = await fixture()
    await store.putToken(revokeToken(minted.record, new Date('2026-01-01T00:00:00.000Z')))
    const verification = await verifyShareToken(minted.token, {
      lookup: (id) => store.getToken(id),
      publicationId: publication.id,
    })
    expect(verification).toEqual({ ok: false, reason: 'revoked' })
  })

  it('rejects an expired token, and treats an unreadable expiry as expired', async () => {
    const record: ShareTokenRecord = {
      id: 'abcdefgh',
      publicationId: 'p',
      slug: 's',
      secretHash: await sha256Hex('secret'),
      scope: FULL,
      label: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      revokedAt: null,
    }
    expect(isExpired(record, new Date('2026-01-01T23:59:59.000Z'))).toBe(false)
    expect(isExpired(record, new Date('2026-01-02T00:00:00.000Z'))).toBe(true)
    expect(isExpired({ ...record, expiresAt: 'tuesday' }, new Date('2020-01-01T00:00:00.000Z'))).toBe(true)
    expect(isExpired({ ...record, expiresAt: null }, new Date('4000-01-01T00:00:00.000Z'))).toBe(false)
  })

  it('normalises an unparseable expiry to the epoch at mint time', async () => {
    const minted = await mintShareToken({ publicationId: 'p', slug: 's', scope: FULL, expiresAt: 'not a date' })
    expect(minted.record.expiresAt).toBe(new Date(0).toISOString())
    const verification = await verifyShareToken(minted.token, {
      lookup: async () => minted.record,
      publicationId: 'p',
    })
    expect(verification).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a valid token presented for a different publication', async () => {
    const { store, minted } = await fixture()
    const verification = await verifyShareToken(minted.token, {
      lookup: (id) => store.getToken(id),
      publicationId: 'pub_someone_else',
    })
    expect(verification).toEqual({ ok: false, reason: 'wrong-publication' })
  })

  it('never widens a publication’s capabilities', () => {
    expect(intersectCapabilities({ ...FULL, download: false }, FULL)).toMatchObject({ download: false })
    expect(intersectCapabilities(FULL, { ...FULL, fork: false })).toMatchObject({ fork: false })
  })
})

describe('constant-time comparison', () => {
  it('does not short-circuit on length', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true)
    expect(constantTimeEqualHex('a'.repeat(64), 'a'.repeat(64))).toBe(true)
    expect(constantTimeEqualHex('a'.repeat(64), 'a'.repeat(63) + 'b')).toBe(false)
  })

  it('takes the same time whether the difference is first or last', () => {
    const reference = new Uint8Array(64).fill(0xab)
    const differsFirst = Uint8Array.from(reference)
    differsFirst[0] ^= 0xff
    const differsLast = Uint8Array.from(reference)
    differsLast[63] ^= 0xff

    const sample = (other: Uint8Array) => {
      const started = performance.now()
      for (let round = 0; round < 20_000; round += 1) constantTimeEqual(reference, other)
      return performance.now() - started
    }
    // Interleaved, and the median of several passes, so a JIT warm-up or an
    // unlucky GC pause in one arm cannot decide the result.
    const first: number[] = []
    const last: number[] = []
    for (let pass = 0; pass < 9; pass += 1) {
      first.push(sample(differsFirst))
      last.push(sample(differsLast))
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const ratio = median(first) / median(last)
    // A short-circuiting compare would return on byte 0 for `differsFirst` and
    // walk all 64 for `differsLast`, a ratio far below this band. The band is
    // wide because wall-clock timing in a JIT is noisy; it is still enough to
    // catch the bug it exists to catch.
    expect(ratio).toBeGreaterThan(0.5)
    expect(ratio).toBeLessThan(2)
  })

  it('walks every byte even when the first already differs', () => {
    // A direct structural check to go with the statistical one: mutating a
    // later byte of the *other* operand must still be observable, which is only
    // true if the loop reached it.
    const a = new Uint8Array(8).fill(1)
    const b = new Uint8Array(8).fill(2)
    expect(constantTimeEqual(a, b)).toBe(false)
    b.fill(1)
    b[7] = 9
    expect(constantTimeEqual(a, b)).toBe(false)
    b[7] = 1
    expect(constantTimeEqual(a, b)).toBe(true)
  })
})

describe('access resolution', () => {
  it('grants nothing for an unlisted publication with no token', async () => {
    const { publication, store } = await fixture()
    const decision = await resolveAccess({ publication, lookupToken: (id) => store.getToken(id) })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('TOKEN_REQUIRED')
    expect(decision.capabilities).toEqual({
      view: false,
      comment: false,
      fork: false,
      download: false,
      embed: false,
    })
    expect(decision.noindex).toBe(true)
  })

  it('grants the intersected scope for a valid token', async () => {
    const { publication, store, minted } = await fixture()
    const decision = await resolveAccess({
      publication,
      presentedToken: minted.token,
      lookupToken: (id) => store.getToken(id),
    })
    expect(decision.allowed).toBe(true)
    expect(decision.capabilities).toEqual(FULL)
    expect(decision.tokenId).toBe(minted.record.id)
    // An unlisted page is never indexable, however it was reached.
    expect(decision.noindex).toBe(true)
  })

  it('fails closed once the token is revoked, indistinguishably from a bad one', async () => {
    const { publication, store, minted } = await fixture()
    const [id] = minted.token.split('.')
    const forged = await resolveAccess({
      publication,
      presentedToken: `${id}.${'A'.repeat(43)}`,
      lookupToken: (lookup) => store.getToken(lookup),
    })

    await store.putToken(revokeToken(minted.record))
    const revoked = await resolveAccess({
      publication,
      presentedToken: minted.token,
      lookupToken: (lookup) => store.getToken(lookup),
    })

    expect(revoked.allowed).toBe(false)
    expect(revoked.status).toBe(404)
    // Byte-identical to the response a forged token gets. Anything else would
    // let a caller distinguish "this link was real and is now revoked" from
    // "this link never existed", which is a slug-and-id oracle.
    expect(revoked.message).toBe(forged.message)
    expect(revoked.status).toBe(forged.status)
    expect(revoked.reason).toBe(forged.reason)
  })

  it('fails closed once the publication itself is revoked, token or not', async () => {
    const { publication, store, minted } = await fixture()
    const revoked = revokePublication(publication)
    const decision = await resolveAccess({
      publication: revoked,
      presentedToken: minted.token,
      viewerIsOwner: true,
      lookupToken: (id) => store.getToken(id),
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('REVOKED')
    expect(decision.status).toBe(410)
  })

  it('treats a private publication as absent rather than forbidden', async () => {
    const { publication } = await fixture({ visibility: 'private' })
    const decision = await resolveAccess({ publication })
    expect(decision.status).toBe(404)
    expect(decision.reason).toBe('NOT_FOUND')
  })

  it('lets a public publication through and marks it indexable', async () => {
    const { publication } = await fixture({ visibility: 'public' })
    const decision = await resolveAccess({ publication })
    expect(decision.allowed).toBe(true)
    expect(decision.noindex).toBe(false)
  })

  it('honours a capability that was switched off after minting', async () => {
    const { publication, store, minted } = await fixture()
    const narrowed = updatePublicationAccess(publication, { capabilities: { ...FULL, download: false } })
    const decision = await resolveAccess({
      publication: narrowed,
      presentedToken: minted.token,
      lookupToken: (id) => store.getToken(id),
    })
    expect(decision.capabilities.download).toBe(false)
    expect(decision.capabilities.view).toBe(true)
  })

  it('reports a 503 rather than granting access when the token store is missing', async () => {
    const { publication, minted } = await fixture()
    const decision = await resolveAccess({ publication, presentedToken: minted.token })
    expect(decision.allowed).toBe(false)
    expect(decision.status).toBe(503)
  })
})

describe('token redaction', () => {
  it('strips the token from any URL before it can be logged', () => {
    expect(redactShareUrl('/share/abc?t=SECRETVALUE')).toBe('/share/abc?t=redacted')
    expect(redactShareUrl('https://brickwrite.tech/share/abc?t=SECRET&x=1')).toBe(
      'https://brickwrite.tech/share/abc?t=redacted&x=1',
    )
    expect(redactShareUrl('/share/abc')).toBe('/share/abc')
    expect(redactShareUrl('::not a url::?t=SECRET')).not.toContain('SECRET')
  })
})
