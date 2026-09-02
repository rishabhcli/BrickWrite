import { pageEtag, renderSharePage } from '../../src/features/share/page'
import { originFor, storeFor, type ShareEnv } from '../_lib/env'
import { resolvePublication } from '../_lib/resolve'
import {
  cookieToken,
  exchangeTokenForCookie,
  handleError,
  html,
  matchesEtag,
  notModified,
  presentedToken,
  wantsHtml,
} from '../_lib/respond'

/**
 * `GET /share/:slug` — the crawlable share page.
 *
 * This runs at the edge and returns finished HTML. That is not a preference;
 * it is the requirement. A crawler, a link unfurler and `curl` all read the
 * bytes of the first response and none of them run JavaScript, so a title and
 * an `og:image` written by React on mount are a title and an `og:image` that
 * nobody outside a browser ever sees.
 *
 * The application shell may also claim `/share/:slug` client-side once it is
 * mounted — see `PLATFORM_ROUTES` — which upgrades an in-app navigation to the
 * interactive viewer. Both surfaces read the same publication; only this one is
 * reachable without JavaScript.
 */
export const onRequestGet = async (context: {
  request: Request
  env: ShareEnv
  params: { slug: string | string[] }
}): Promise<Response> => {
  const { request, env, params } = context
  const url = new URL(request.url)
  const origin = originFor(env, request)
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug

  const fromUrl = presentedToken(url)
  const fromCookie = cookieToken(request, slug)

  try {
    const store = storeFor(env)

    /*
     * Both credentials are tried, the URL's first.
     *
     * A stale `?t=` in browser history or a chat scrollback must not lock
     * somebody out of a publication they already hold a working cookie for, and
     * trying the second grants no access the visitor did not already have —
     * both are credentials the visitor was given, for this same path.
     */
    const attempt = (token: string | null) =>
      resolvePublication(store, slug, token)
        .then((value) => ({ ok: true as const, value }))
        .catch((cause: unknown) => ({ ok: false as const, cause }))

    let resolved = await attempt(fromUrl ?? fromCookie)
    // Which credential actually worked, not which one was offered. The
    // exchange below turns on this: a `?t=` that failed must not be written to
    // a cookie just because the *cookie* then succeeded.
    let grantedByUrl = resolved.ok && fromUrl !== null
    if (!resolved.ok && fromUrl && fromCookie && fromCookie !== fromUrl) {
      resolved = await attempt(fromCookie)
      grantedByUrl = false
    }
    if (!resolved.ok) throw resolved.cause
    const { publication, decision } = resolved.value

    /*
     * The secret arrived in the URL and access was actually granted by it, so
     * trade it for a path-scoped cookie and send the visitor to the clean
     * address. Done only after the request has been allowed: writing a cookie
     * first would persist a token that does not work, and doing it for a
     * publication that needed no token would store a credential nothing reads.
     *
     * `decision.tokenId` is what distinguishes "a token let you in" from "this
     * is public anyway"; the parameter being present is not enough, because a
     * public page ignores it.
     */
    if (grantedByUrl && fromUrl && fromUrl !== fromCookie && decision.tokenId) {
      return exchangeTokenForCookie(slug, fromUrl)
    }

    /*
     * Revalidation, now that there is something to revalidate against.
     *
     * The page has always been `must-revalidate` with no validator, so a reload
     * re-rendered it and re-sent the whole body. The tag covers the publication
     * and the access decision, so a revocation moves it on the next request —
     * which is what lets this be a conditional request rather than a cached one.
     */
    const etag = await pageEtag('share', { publication, decision, origin })
    if (matchesEtag(request, etag)) {
      return notModified(etag, { 'Cache-Control': page304CacheControl(decision.noindex) })
    }

    const page = renderSharePage({ publication, decision, origin })
    // A HEAD request must produce identical headers with no body; Cloudflare
    // derives HEAD from GET, so nothing extra is needed here.
    return html(page, { ETag: `"${etag}"` })
  } catch (cause) {
    return handleError(cause, { origin, wantsHtml: wantsHtml(request), path: url.pathname + url.search })
  }
}

/** Mirrors what the rendered page sends, so a 304 does not relax its own caching. */
const page304CacheControl = (noindex: boolean): string =>
  noindex ? 'private, no-store' : 'public, max-age=0, must-revalidate'
