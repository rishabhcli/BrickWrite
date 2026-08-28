import { renderSharePage } from '../../src/features/share/page'
import { originFor, storeFor, type ShareEnv } from '../_lib/env'
import { resolvePublication } from '../_lib/resolve'
import { handleError, html, presentedToken, wantsHtml } from '../_lib/respond'

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

  try {
    const store = storeFor(env)
    const { publication, decision } = await resolvePublication(store, slug, presentedToken(url))
    const page = renderSharePage({ publication, decision, origin })
    // A HEAD request must produce identical headers with no body; Cloudflare
    // derives HEAD from GET, so nothing extra is needed here.
    return html(page)
  } catch (cause) {
    return handleError(cause, { origin, wantsHtml: wantsHtml(request), path: url.pathname + url.search })
  }
}
