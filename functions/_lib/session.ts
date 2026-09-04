/**
 * Hexclave session verification for the Cloudflare edge.
 *
 * The Node API verifies a session with `@hexclave/js`; a Pages Function cannot
 * run that SDK, and the share surface still needs to know *which account* is
 * asking before it will let anybody mutate a publication. So this checks the
 * signature itself, against the ES256 key set the project publishes — the same
 * key set `convex/auth.config.ts` hands to Convex.
 *
 * Three rules this file does not bend:
 *
 *   1. **The algorithm is the verifier's, not the token's.** `alg` is read only
 *      to reject anything that is not ES256. Trusting it is how `alg: none` and
 *      HMAC-confusion forgeries get accepted.
 *   2. **One issuer.** A verifier is built for exactly one issuer and checks
 *      `iss` exactly, so a key set that happens to serve more than one
 *      issuer's keys cannot make a verifier accept the wrong one.
 *   3. **Every failure is null.** A caller cannot distinguish an expired token
 *      from a forged one from an unreachable key set, and none of them is a
 *      principal.
 *
 * Brickwrite builds two verifiers from this factory: one for real Hexclave
 * sessions, which refuses `is_anonymous` / `is_restricted` — the same two
 * classes `server/security/auth.ts` and `convex/model/identity.ts` refuse —
 * and one for the anonymous-users issuer, which requires them, for the one
 * write (publishing) this deployment lets a guest session make. `allowAnonymous`
 * picks which; nothing about signature or expiry checking changes either way.
 */

export interface SessionClaims {
  readonly subject: string
}

export interface SessionVerifierOptions {
  readonly jwksUrl: string
  readonly issuer: string
  /**
   * The `aud` a valid token must carry. Hexclave's anonymous-users issuer uses
   * a different audience than the regular one, so a verifier built for one
   * cannot be tricked into accepting a token minted for the other even if a
   * future key rotation ever let their signatures overlap.
   */
  readonly audience?: string
  /**
   * Requires `is_anonymous: true` instead of refusing it. Set only for the
   * verifier built against Hexclave's anonymous-users issuer.
   */
  readonly allowAnonymous?: boolean
  /** Test seam. */
  readonly now?: () => number
  /** Test seam; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** How long a fetched key set is reused. */
  readonly cacheMs?: number
}

interface JsonWebKey_ {
  kid?: string
  kty?: string
  crv?: string
  alg?: string
  [key: string]: unknown
}

const DEFAULT_CACHE_MS = 5 * 60 * 1000
/** A miss may trigger at most one refetch in this window, so random `kid`s
 *  cannot be used to drive unbounded requests at the issuer. */
const REFETCH_COOLDOWN_MS = 60 * 1000

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function decodeSignature(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function createSessionVerifier(options: SessionVerifierOptions) {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS

  let keys = new Map<string, CryptoKey>()
  let fetchedAt = 0
  let lastMissRefetch = 0

  async function loadKeys(): Promise<void> {
    const response = await fetchImpl(options.jwksUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`The key set answered ${response.status}.`)
    const payload: unknown = await response.json()
    const list = isRecord(payload) && Array.isArray(payload.keys) ? (payload.keys as JsonWebKey_[]) : []
    const next = new Map<string, CryptoKey>()
    for (const jwk of list) {
      // Only P-256 signing keys. Importing whatever the endpoint offers would
      // let a compromised key set widen the accepted algorithm set.
      if (!jwk.kid || jwk.kty !== 'EC' || jwk.crv !== 'P-256') continue
      try {
        next.set(
          jwk.kid,
          await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'verify',
          ]),
        )
      } catch {
        // A key that will not import is skipped, not fatal: one bad entry must
        // not take down verification for every other key in the set.
      }
    }
    keys = next
    fetchedAt = now()
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const at = now()
    if (keys.size === 0 || at - fetchedAt > cacheMs) {
      try {
        await loadKeys()
      } catch {
        return null
      }
    }
    const found = keys.get(kid)
    if (found) return found
    // Rotation: the token names a key minted since the last fetch. Refetch, but
    // no more often than the cooldown allows.
    if (at - lastMissRefetch < REFETCH_COOLDOWN_MS) return null
    lastMissRefetch = at
    try {
      await loadKeys()
    } catch {
      return null
    }
    return keys.get(kid) ?? null
  }

  return {
    async verify(token: string): Promise<SessionClaims | null> {
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null
      const [rawHeader, rawPayload, rawSignature] = parts

      let header: unknown
      let payload: unknown
      try {
        header = decodeSegment(rawHeader)
        payload = decodeSegment(rawPayload)
      } catch {
        return null
      }
      if (!isRecord(header) || !isRecord(payload)) return null
      if (header.alg !== 'ES256' || typeof header.kid !== 'string') return null

      const key = await keyFor(header.kid)
      if (!key) return null

      let verified = false
      try {
        verified = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          key,
          decodeSignature(rawSignature),
          new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
        )
      } catch {
        return null
      }
      if (!verified) return null

      if (payload.iss !== options.issuer) return null
      if (options.audience) {
        const aud = payload.aud
        const matchesAudience = aud === options.audience || (Array.isArray(aud) && aud.includes(options.audience))
        if (!matchesAudience) return null
      }
      if (options.allowAnonymous) {
        if (payload.is_anonymous !== true) return null
      } else if (payload.is_anonymous === true || payload.is_restricted === true) {
        return null
      }

      const seconds = now() / 1000
      if (typeof payload.exp !== 'number' || payload.exp <= seconds) return null
      if (typeof payload.nbf === 'number' && payload.nbf > seconds) return null

      const subject = payload.sub
      if (typeof subject !== 'string' || subject.length === 0) return null
      return { subject }
    },
  }
}

export type SessionVerifier = ReturnType<typeof createSessionVerifier>
