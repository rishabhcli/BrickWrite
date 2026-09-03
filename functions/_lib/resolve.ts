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

/**
 * Resolves using either credential the visitor holds, URL first.
 *
 * An unlisted link delivers its token as `?t=`, is exchanged for a
 * path-scoped cookie, and redirects to the clean address. Only the page route
 * ever read that cookie — `[[rest]].ts` resolved with `presentedToken(url)`
 * alone — so once the exchange had happened every card, `view.json`,
 * `model.json` and `summary.json` answered TOKEN_REQUIRED. An unlisted link
 * rendered a page with a broken hero image, a viewer that could not load the
 * model, and a 404 og:image in every unfurl. There was no path on which the
 * token was still in the URL when those requests went out.
 *
 * A stale `?t=` must not lock out a visitor holding a working cookie, so the
 * second credential is tried when the first fails. Trying it grants nothing
 * they were not already given, for this same path.
 *
 * `grantedByUrl` is which credential *worked*, not which was offered: the page
 * route writes the cookie on that, and a failed `?t=` must not be persisted
 * because the cookie then succeeded.
 */
export async function resolvePresented(
  store: PublicationStore,
  slug: string,
  credentials: { fromUrl: string | null; fromCookie: string | null },
): Promise<Resolved & { grantedByUrl: boolean }> {
  const { fromUrl, fromCookie } = credentials
  const attempt = (token: string | null) =>
    resolvePublication(store, slug, token)
      .then((value) => ({ ok: true as const, value }))
      .catch((cause: unknown) => ({ ok: false as const, cause }))

  let resolved = await attempt(fromUrl ?? fromCookie)
  let grantedByUrl = resolved.ok && fromUrl !== null
  if (!resolved.ok && fromUrl && fromCookie && fromCookie !== fromUrl) {
    resolved = await attempt(fromCookie)
    grantedByUrl = false
  }
  if (!resolved.ok) throw resolved.cause
  return { ...resolved.value, grantedByUrl }
}
