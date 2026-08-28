import { baseCapabilities, intersectCapabilities, verifyShareToken } from './tokens'
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
 * One function decides what an anonymous visitor may do with a publication, and
 * every surface — the share page, the embed, the card endpoint, the JSON API,
 * the viewer — asks it rather than re-deriving the rules. A second copy of this
 * logic is how an embed ends up honouring a revoked link.
 *
 * The order of the checks is the policy:
 *
 *   1. **Revoked** beats everything, including ownership.
 *   2. **Moderation** hides a publication from the public without deleting it.
 *   3. **Owner** sees their own private work.
 *   4. **Public** grants the publication's own capabilities.
 *   5. **Unlisted** grants nothing until a valid token is presented, and then
 *      only the intersection of the token's scope and the publication's.
 *   6. **Private** grants nothing to anybody else, token or not.
 *
 * A publication that is unlisted and has no valid token fails *closed*: the
 * caller receives `NO_CAPABILITIES`, not a read-only fallback.
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
  /** The `?t=` value, if any. Never logged. */
  presentedToken?: string | null
  /** True only when the caller has independently authenticated the owner. */
  viewerIsOwner?: boolean
  now?: Date
  /** Fetches a token record by its public id. */
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
      // A private or unlisted page is never indexable, even for its owner: the
      // crawler and the owner see the same response headers.
      noindex: publication.visibility !== 'public',
      tokenId: null,
      status: 200,
    }
  }

  if (publication.visibility === 'public') {
    return {
      allowed: publication.capabilities.view,
      capabilities: baseCapabilities('public', publication.capabilities),
      reason: publication.capabilities.view ? null : 'CAPABILITY_DISABLED',
      message: publication.capabilities.view ? null : 'The author has turned off public viewing for this model.',
      noindex: !publication.capabilities.view,
      tokenId: null,
      status: publication.capabilities.view ? 200 : 403,
    }
  }

  if (publication.visibility === 'private') {
    // Deliberately the same response an unknown slug produces, so the existence
    // of a private publication is not confirmable by URL.
    return deny('NOT_FOUND', 'No published model was found at this address.', 404)
  }

  // Unlisted from here down.
  if (!request.presentedToken) {
    return deny('TOKEN_REQUIRED', 'This model is shared by link only. The address is missing its access token.', 404)
  }
  if (!request.lookupToken) {
    return deny('STORE_UNAVAILABLE', 'Link access cannot be checked right now. Try again shortly.', 503)
  }

  const verification = await verifyShareToken(request.presentedToken, {
    lookup: request.lookupToken,
    publicationId: publication.id,
    now: request.now,
  })

  if (!verification.ok) {
    // Expiry is the one failure worth distinguishing: it is not a security
    // boundary — the link was valid — and telling somebody their link aged out
    // saves a support round trip. Every other failure collapses to one message
    // so a wrong token cannot be told apart from a revoked or unknown one.
    const expired = verification.reason === 'expired'
    return deny(
      'TOKEN_REJECTED',
      expired
        ? 'This link has expired. Ask the author for a new one.'
        : 'This link is not valid. It may have been revoked, or the address may be incomplete.',
      expired ? 410 : 404,
    )
  }

  const capabilities = intersectCapabilities(publication.capabilities, verification.scope)
  return {
    allowed: capabilities.view,
    capabilities,
    reason: capabilities.view ? null : 'CAPABILITY_DISABLED',
    message: capabilities.view ? null : 'This link does not grant permission to view the model.',
    noindex: true,
    tokenId: verification.record.id,
    status: capabilities.view ? 200 : 403,
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
 * Public, viewable, not revoked, not hidden. An unlisted publication is never
 * listed — that is the entire meaning of the word — and this is the single
 * predicate that decides it.
 */
export function isPubliclyListable(publication: Publication): boolean {
  return (
    publication.visibility === 'public' &&
    publication.capabilities.view &&
    !publication.revokedAt &&
    publication.moderation?.status !== 'hidden'
  )
}
