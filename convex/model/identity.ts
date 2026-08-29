/**
 * Convex identity claims, without a Convex runtime import.
 *
 * Hexclave's JWT puts `is_anonymous` / `is_restricted` on the token, and Convex
 * copies those custom claims onto `UserIdentity`. The anonymous issuer path is
 * a second, independent signal: `getConvexProvidersConfig` registers
 * `/api/v1/projects-anonymous-users/:id` as a trusted issuer, so a token can be
 * cryptographically valid and still not be a principal we will write as.
 */

export interface ConvexIdentityClaims {
  readonly tokenIdentifier?: string
  readonly subject?: string
  readonly issuer?: string
  readonly name?: string | null
  readonly nickname?: string | null
  readonly is_anonymous?: unknown
  readonly is_restricted?: unknown
}

export interface CloudIdentity {
  /** The `sub` claim: the Hexclave user id. Never an email. */
  subject: string
  displayName?: string
}

/**
 * Turns a Convex `UserIdentity` into a principal, or null when the token is
 * anonymous, restricted, or missing a subject.
 *
 * Returning null is the same signal as "no token": paid and mutating Convex
 * functions already map that to `UNAUTHENTICATED`. The paid HTTP API refuses
 * the same two classes in `server/security/auth.ts`; this is that gate for the
 * database layer.
 */
export function identityFromClaims(identity: ConvexIdentityClaims): CloudIdentity | null {
  if (identity.is_anonymous === true || identity.is_restricted === true) return null
  const issuer = identity.issuer ?? ''
  if (issuer.includes('projects-anonymous-users')) return null
  const subject = identity.tokenIdentifier || identity.subject
  if (!subject) return null
  const displayName = identity.name ?? identity.nickname ?? undefined
  return { subject, displayName: displayName || undefined }
}
