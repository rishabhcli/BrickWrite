import { canonicalJson } from '../../../src/features/share/canonical'
import { sanitizeFilename } from '../../../src/features/share/sanitize'
import { ShareError } from '../../../src/features/share/types'
import { originFor, storeFor, type ShareEnv } from '../../_lib/env'
import { resolvePresented } from '../../_lib/resolve'
import { cookieToken, handleError, json, matchesEtag, notModified, png, presentedToken, wantsHtml } from '../../_lib/respond'

/**
 * Everything under `/share/:slug/`.
 *
 * One catch-all rather than a file per leaf, because the leaves share the same
 * three preconditions — the publication exists, it is not revoked, and this
 * caller may see it — and splitting them across files is how one of them ends
 * up skipping a check.
 *
 *   `card/<preset>.png`   the rendered social card
 *   `model.json`          the published snapshot, when download is granted
 *
 * Cards are served from storage, not rendered here. They were rendered at
 * publish time from the exact revision being published, and they are addressed
 * by the SHA-256 of their own bytes — so what this route serves is provably the
 * same image the publisher saw, and it can carry a year-long immutable cache
 * header without lying.
 */
export const onRequestGet = async (context: {
  request: Request
  env: ShareEnv
  params: { slug: string | string[]; rest?: string | string[] }
}): Promise<Response> => {
  const { request, env, params } = context
  const url = new URL(request.url)
  const origin = originFor(env, request)
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug
  const rest = Array.isArray(params.rest) ? params.rest : params.rest ? [params.rest] : []

  try {
    const store = storeFor(env)
    // The cookie, not just `?t=`: the page exchanges the parameter and
    // redirects, so by the time a card, view.json, model.json or summary.json
    // is fetched the URL no longer carries the token and only the cookie does.
    const { publication, decision } = await resolvePresented(store, slug, {
      fromUrl: presentedToken(url),
      fromCookie: cookieToken(request, slug),
    })

    if (rest.length === 2 && rest[0] === 'card') {
      const preset = rest[1].replace(/\.png$/i, '')
      const card = publication.cards.find((entry) => entry.preset === preset)
      if (!card) {
        throw new ShareError('NOT_FOUND', `This publication has no "${preset}" card.`, 404)
      }
      // The ETag is the content hash, so a conditional request is answered
      // without ever touching the stored bytes.
      if (matchesEtag(request, card.sha256)) return notModified(card.sha256)

      const stored = await store.getCard(card.sha256)
      if (!stored) {
        throw new ShareError('NOT_FOUND', 'This card was recorded but its bytes are missing from storage.', 404)
      }
      return png(stored.bytes, card.sha256, publication.visibility === 'public')
    }

    if (rest.length === 1 && rest[0] === 'model.json') {
      if (!decision.capabilities.download) {
        throw new ShareError('CAPABILITY_DISABLED', 'The author has not enabled downloads for this model.', 403)
      }
      // Canonical bytes, so a downloaded model hashes to the publication's own
      // content hash and anybody can check that for themselves.
      const filename = `${sanitizeFilename(publication.slug, 'model')}.json`
      return new Response(canonicalJson(publication.document), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Brickwright-Content-Hash': publication.contentHash,
          'Cache-Control': publication.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }

    if (rest.length === 1 && rest[0] === 'view.json') {
      // Everything the interactive viewer needs, including the snapshot.
      //
      // Deliberately *not* gated on the download capability. Anything rendered
      // can be extracted, so pretending the geometry is secret while drawing it
      // on screen would be theatre; `download` governs whether a file is
      // *offered*, which is a licensing and attribution decision, not a
      // confidentiality one. That distinction is recorded in the integration doc.
      return json({ publication, capabilities: decision.capabilities })
    }

    if (rest.length === 1 && rest[0] === 'summary.json') {
      return json({
        slug: publication.slug,
        title: publication.title,
        revision: publication.revision,
        contentHash: publication.contentHash,
        publishedAt: publication.publishedAt,
        author: publication.author,
        license: publication.license,
        summary: publication.summary,
        cards: publication.cards,
        capabilities: decision.capabilities,
        fork: publication.fork,
      })
    }

    throw new ShareError('NOT_FOUND', 'No such resource for this publication.', 404)
  } catch (cause) {
    return handleError(cause, { origin, wantsHtml: wantsHtml(request), path: url.pathname + url.search })
  }
}
