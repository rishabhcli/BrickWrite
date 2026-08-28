import { base64url, constantTimeEqualHex, randomBytes, sha256Hex } from './canonical'
import { sanitizeLabel } from './sanitize'
import {
  NO_CAPABILITIES,
  type ShareCapabilities,
  type ShareTokenRecord,
  type TokenVerification,
  type Visibility,
} from './types'

/**
 * Unlisted-link tokens.
 *
 * The shape is `<id>.<secret>`:
 *
 *   - **id** is public. It is the lookup key, so the store never has to scan,
 *     and it is what lets a revocation be recorded against a specific link
 *     rather than against "whoever presented this string".
 *   - **secret** is 32 random bytes — 256 bits — and is returned exactly once,
 *     at mint time. Only its SHA-256 is stored, so a dump of the token table
 *     yields nothing usable.
 *
 * Verification is constant-time against the stored digest, and every failure —
 * malformed, unknown, wrong secret, revoked, expired, wrong publication — walks
 * the same path and does the same digest work before answering. A token that
 * has been revoked or has expired fails closed: the caller receives
 * `NO_CAPABILITIES`, never a partial grant.
 *
 * Tokens never appear in analytics or logs. `redactShareUrl` in `sanitize.ts`
 * is applied at every boundary that could echo a URL, and nothing in this
 * module writes to `console`.
 */

/** 256 bits, per the requirement that an unlisted link be unguessable. */
export const TOKEN_SECRET_BYTES = 32
/** 96 bits of public identifier: enough that ids never collide in practice. */
export const TOKEN_ID_BYTES = 12

export interface MintTokenInput {
  publicationId: string
  slug: string
  /** Capabilities the link grants; intersected with the publication's own. */
  scope: ShareCapabilities
  label?: string
  /** ISO timestamp. `null` means the link does not expire on its own. */
  expiresAt?: string | null
  now?: Date
}

export interface MintedToken {
  /** The full `<id>.<secret>` string. Shown once, never stored, never logged. */
  token: string
  record: ShareTokenRecord
}

const TOKEN_PATTERN = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{32,128})$/

export async function mintShareToken(input: MintTokenInput): Promise<MintedToken> {
  const id = base64url(randomBytes(TOKEN_ID_BYTES))
  const secret = base64url(randomBytes(TOKEN_SECRET_BYTES))
  const createdAt = (input.now ?? new Date()).toISOString()
  const record: ShareTokenRecord = {
    id,
    publicationId: input.publicationId,
    slug: input.slug,
    secretHash: await sha256Hex(secret),
    scope: { ...input.scope },
    label: sanitizeLabel(input.label ?? 'Unlisted link'),
    createdAt,
    expiresAt: normaliseExpiry(input.expiresAt ?? null),
    revokedAt: null,
  }
  return { token: `${id}.${secret}`, record }
}

function normaliseExpiry(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    // An unparseable expiry is treated as "expires now", not as "never
    // expires". Failing closed is the only safe reading of a corrupt field.
    return new Date(0).toISOString()
  }
  return parsed.toISOString()
}

/** Splits a presented token without revealing which half was malformed. */
export function parseShareToken(presented: unknown): { id: string; secret: string } | null {
  if (typeof presented !== 'string') return null
  const match = TOKEN_PATTERN.exec(presented.trim())
  return match ? { id: match[1], secret: match[2] } : null
}

/**
 * A digest of the right shape that no secret can produce.
 *
 * Used so an unknown or malformed token still performs a SHA-256 and a
 * full-length comparison. Without it, "no such token" would return measurably
 * faster than "wrong secret", which is enough to enumerate valid ids.
 */
const DECOY_HASH = '0'.repeat(64)
const DECOY_SECRET = 'x'.repeat(43)

export interface VerifyTokenOptions {
  /** Fetches a token record by its public id. Returns null when unknown. */
  lookup: (id: string) => Promise<ShareTokenRecord | null>
  /** The publication the token is being presented for. */
  publicationId: string
  now?: Date
}

/**
 * Verifies a presented token against the store.
 *
 * Order matters: the digest and the comparison run *before* the revocation and
 * expiry checks, so a revoked token and a wrong secret take the same path. The
 * checks after the compare are all data reads on a record we already hold.
 */
export async function verifyShareToken(
  presented: unknown,
  options: VerifyTokenOptions,
): Promise<TokenVerification> {
  const parsed = parseShareToken(presented)
  // Malformed input still pays for a lookup-shaped digest, so the shape of a
  // token is not learnable by timing either.
  const record = parsed ? await options.lookup(parsed.id) : null
  const presentedHash = await sha256Hex(parsed?.secret ?? DECOY_SECRET)
  const matches = constantTimeEqualHex(presentedHash, record?.secretHash ?? DECOY_HASH)

  if (!parsed) return { ok: false, reason: 'malformed' }
  if (!record) return { ok: false, reason: 'unknown' }
  if (!matches) return { ok: false, reason: 'mismatch' }
  if (record.publicationId !== options.publicationId) return { ok: false, reason: 'wrong-publication' }
  if (record.revokedAt) return { ok: false, reason: 'revoked' }
  if (isExpired(record, options.now ?? new Date())) return { ok: false, reason: 'expired' }
  return { ok: true, record, scope: { ...record.scope } }
}

export function isExpired(record: ShareTokenRecord, now: Date): boolean {
  if (!record.expiresAt) return false
  const expiry = new Date(record.expiresAt).getTime()
  // A record whose expiry cannot be read is treated as expired.
  if (Number.isNaN(expiry)) return true
  return expiry <= now.getTime()
}

export function revokeToken(record: ShareTokenRecord, now = new Date()): ShareTokenRecord {
  return record.revokedAt ? record : { ...record, revokedAt: now.toISOString() }
}

/**
 * Intersects a token's scope with the publication's own capabilities.
 *
 * A link can only ever narrow. If the publisher turns downloads off on the
 * publication, an older link that was minted with `download: true` stops
 * granting it — the publication is the ceiling, always.
 */
export function intersectCapabilities(
  publication: ShareCapabilities,
  token: ShareCapabilities,
): ShareCapabilities {
  return {
    view: publication.view && token.view,
    comment: publication.comment && token.comment,
    fork: publication.fork && token.fork,
    download: publication.download && token.download,
    embed: publication.embed && token.embed,
  }
}

/**
 * What an anonymous visitor gets before any token is considered.
 *
 * `private` grants nothing at all, `unlisted` grants nothing until a valid
 * token is presented, and `public` grants the publication's own capabilities.
 */
export function baseCapabilities(
  visibility: Visibility,
  capabilities: ShareCapabilities,
): ShareCapabilities {
  return visibility === 'public' ? { ...capabilities } : { ...NO_CAPABILITIES }
}

/**
 * Human-readable reason, safe to show a visitor.
 *
 * Deliberately coarse. Telling somebody "that link was revoked" rather than
 * "no such link" would confirm that the id existed, so both collapse to the
 * same sentence.
 */
export function describeTokenFailure(reason: TokenVerification extends { ok: false; reason: infer R } ? R : never): string {
  switch (reason) {
    case 'expired':
      return 'This link has expired. Ask the publisher for a new one.'
    case 'revoked':
    case 'unknown':
    case 'mismatch':
    case 'malformed':
    case 'wrong-publication':
    default:
      return 'This link is not valid. It may have been revoked, or the address may be incomplete.'
  }
}
