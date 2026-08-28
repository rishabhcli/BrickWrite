import { renderEmbedPage } from '../../src/features/share/page'
import { ShareError } from '../../src/features/share/types'
import { embedAncestors, originFor, storeFor, type ShareEnv } from '../_lib/env'
import { resolvePublication } from '../_lib/resolve'
import { handleError, html, presentedToken, wantsHtml } from '../_lib/respond'

/**
 * `GET /embed/:slug` — the framed, read-only surface.
 *
 * Separate from the share page for one reason that matters: this is the only
 * response in the workstream whose `frame-ancestors` is not `'none'`, and
 * keeping that on its own route means the share page can stay `X-Frame-Options:
 * DENY` unconditionally. Clickjacking an embed is uninteresting — it is a
 * picture and a link — but clickjacking a page with a fork button is not.
 *
 * Embedding is a capability, so a publication with `embed: false` returns 403
 * here even though the same visitor may read the share page.
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
    if (!decision.capabilities.embed) {
      throw new ShareError('CAPABILITY_DISABLED', 'The author has not enabled embedding for this model.', 403)
    }
    return html(
      renderEmbedPage({ publication, decision, origin, embedAncestors: embedAncestors(env) }),
    )
  } catch (cause) {
    return handleError(cause, { origin, wantsHtml: wantsHtml(request), path: url.pathname + url.search })
  }
}
