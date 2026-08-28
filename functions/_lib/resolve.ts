import { resolveAccess, type AccessDecision } from '../../src/features/share/access'
import type { PublicationStore } from '../../src/features/share/backend/adapter'
import { isValidSlug } from '../../src/features/share/sanitize'
import { ShareError, type Publication } from '../../src/features/share/types'

/**
 * Slug to publication, with the access decision already made.
 *
 * Every route calls this, so the visibility, token, revocation and moderation
 * rules are applied exactly once per request and in exactly one place. A route
 * that resolved a publication itself would be a route that eventually forgot to
 * check revocation.
 *
 * A rejected request produces the *same* shape of refusal whether the slug does
 * not exist, is private, or is unlisted with no token: the caller cannot tell
 * them apart, which is the point.
 */
export interface Resolved {
  publication: Publication
  decision: AccessDecision
}

export async function resolvePublication(
  store: PublicationStore,
  slug: string,
  presentedToken: string | null,
): Promise<Resolved> {
  if (!isValidSlug(slug)) {
    throw new ShareError('NOT_FOUND', 'No published model was found at this address.', 404)
  }
  const publication = await store.getBySlug(slug)
  if (!publication) {
    throw new ShareError('NOT_FOUND', 'No published model was found at this address.', 404)
  }

  const decision = await resolveAccess({
    publication,
    presentedToken,
    lookupToken: (id) => store.getToken(id),
  })

  if (!decision.allowed) {
    throw new ShareError(
      decision.reason ?? 'FORBIDDEN',
      decision.message ?? 'This model is not available.',
      decision.status === 200 ? 403 : decision.status,
    )
  }
  return { publication, decision }
}
