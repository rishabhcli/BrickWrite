import {
  NO_CAPABILITIES,
  type CapabilityKey,
  type Publication,
  type ShareCapabilities,
  type ShareErrorCode,
  type ShareTokenRecord,
} from './types'

/**
 * The access gate.
 *
 * One function decides what a visitor may do with a publication, and every
 * surface — the share page, the embed, the card endpoint, the JSON API, the
 * viewer — asks it rather than re-deriving the rules. A second copy of this
 * logic is how an embed ends up honouring a revoked link.
 *
 * The order of the checks is the policy:
 *
 *   1. **Revoked** beats everything, including ownership.
 *   2. **Moderation** hides a publication from the public without deleting it.
 *   3. **Owner** sees their own work with every capability the record allows.
 *   4. **Everyone else** gets the publication's own capabilities — every
 *      publication is public, so there is no narrower case to fall through to.
 */

export interface AccessDecision {
  allowed: boolean
  capabilities: ShareCapabilities
  /** Non-null when access was refused; drives the HTTP status. */
  reason: ShareErrorCode | null
  /** Safe to show a visitor. Never says whether a slug or token existed. */
  message: string | null
  /** True when the page must carry `noindex`. */
  noindex: boolean
  /** The token that granted access, for revocation UI. Never the secret. */
  tokenId: string | null
  status: number
}

export interface AccessRequest {
  publication: Publication
  /**
   * The `?t=` value, if any, and a way to look it up.
   *
   * No longer consulted: every publication is public, so there is no unlisted
   * state left for a token to unlock. Kept on the request shape rather than
   * ripped out of every caller — a link callers already pass along is now
   * simply inert, not a compile error.
   */
  presentedToken?: string | null
  /** True only when the caller has independently authenticated the owner. */
  viewerIsOwner?: boolean
  now?: Date
  lookupToken?: (id: string) => Promise<ShareTokenRecord | null>
}

const deny = (reason: ShareErrorCode, message: string, status: number): AccessDecision => ({
  allowed: false,
  capabilities: { ...NO_CAPABILITIES },
  reason,
  message,
  noindex: true,
  tokenId: null,
  status,
})

export async function resolveAccess(request: AccessRequest): Promise<AccessDecision> {
  const { publication } = request

  if (publication.revokedAt) {
    return deny('REVOKED', 'This publication has been withdrawn by its author.', 410)
  }
  if (publication.moderation?.status === 'hidden') {
    return deny('MODERATED', 'This publication is not available.', 451)
  }

  if (request.viewerIsOwner) {
    return {
      allowed: true,
      // The owner sees their own work with every capability the record allows,
      // and always the ability to view it.
      capabilities: { ...publication.capabilities, view: true },
      reason: null,
      message: null,
      noindex: false,
      tokenId: null,
      status: 200,
    }
  }

  return {
    allowed: publication.capabilities.view,
    capabilities: { ...publication.capabilities },
    reason: publication.capabilities.view ? null : 'CAPABILITY_DISABLED',
    message: publication.capabilities.view ? null : 'The author has turned off public viewing for this model.',
    noindex: !publication.capabilities.view,
    tokenId: null,
    status: publication.capabilities.view ? 200 : 403,
  }
}

/** Throws unless the decision grants a specific capability. */
export function requireCapability(decision: AccessDecision, capability: CapabilityKey): void {
  if (decision.capabilities[capability]) return
  const error = new Error(`This link does not grant ${capability} access.`)
  error.name = 'CapabilityError'
  throw error
}

/**
 * Whether a publication may appear in the gallery.
 *
 * Viewable, not revoked, not hidden. Every publication is public by
 * construction, so those three are the only ways left to be unlistable.
 */
export function isPubliclyListable(publication: Publication): boolean {
  return publication.capabilities.view && !publication.revokedAt && publication.moderation?.status !== 'hidden'
}
