import { baseSecurityHeaders, renderRefusalPage } from '../../src/features/share/page'
import { redactShareUrl } from '../../src/features/share/sanitize'
import { ShareError } from '../../src/features/share/types'
import { MissingBindingError } from './env'

/**
 * Response helpers shared by every route.
 *
 * Two things are centralised here on purpose. First, security headers: a route
 * that forgets `nosniff` is a route that serves a card as HTML. Second, error
 * handling — every handler funnels through `handleError`, which decides the
 * status, writes an honest message, and **never** echoes the request URL
 * without running it through `redactShareUrl` first. A stack trace or a log
 * line carrying `?t=<secret>` hands out a working unlisted link.
 */

export function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...baseSecurityHeaders(),
      ...extra,
    },
  })
}

export function html(
  page: { html: string; status: number; headers: Record<string, string> },
  extra: Record<string, string> = {},
): Response {
  return new Response(page.html, { status: page.status, headers: { ...page.headers, ...extra } })
}

/** Whether the caller already holds this representation. */
export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match')
  if (!header) return false
  return header
    .split(',')
    .map((entry) => entry.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .includes(etag)
}

/** A PNG card. Immutable, because it is addressed by the hash of its bytes. */
export function png(bytes: Uint8Array, etag: string, immutable: boolean): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      ETag: `"${etag}"`,
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : // An unlisted card is behind a token, so a shared cache must not keep it.
          'private, max-age=0, must-revalidate',
      ...baseSecurityHeaders(),
    },
  })
}

/**
 * A 304, carrying no Content-Security-Policy on purpose.
 *
 * A 304 updates the stored response's headers with the ones it carries, and the
 * stored page's inline script is bound to the nonce in the CSP it was served
 * with. Sending a fresh nonce here would replace that header and leave the
 * cached body holding a nonce nothing allows — a page that renders blank on
 * every revalidation.
 */
export function notModified(etag: string, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 304,
    headers: { ETag: `"${etag}"`, ...baseSecurityHeaders(), ...extra },
  })
}

/**
 * Turns anything thrown into a response.
 *
 * A `ShareError` carries its own status and a message written for a stranger. A
 * missing binding is a 503 with an operator-facing message, because it is a
 * deployment fault rather than a request fault. Anything else becomes a bare
 * 500: an unexpected exception's message may contain internals, and this is not
 * the place to find out.
 */
export function handleError(cause: unknown, context: { origin: string; wantsHtml: boolean; path: string }): Response {
  const safePath = redactShareUrl(context.path)

  if (cause instanceof ShareError) {
    return respond(cause.status, titleFor(cause.status), cause.message, context)
  }
  if (cause instanceof MissingBindingError) {
    return respond(503, 'Sharing is not configured', cause.message, context)
  }
  // Deliberately not `String(cause)`: the message could contain a key, a path
  // or a token, and none of those belong in a response body.
  void safePath
  return respond(500, 'Something went wrong', 'The share service could not complete this request.', context)
}

function respond(status: number, title: string, message: string, context: { origin: string; wantsHtml: boolean }): Response {
  if (!context.wantsHtml) return json({ error: title, message }, status)
  return html(renderRefusalPage({ origin: context.origin, status, title, message }))
}

function titleFor(status: number): string {
  if (status === 404) return 'Not found'
  if (status === 410) return 'No longer available'
  if (status === 403) return 'Not permitted'
  if (status === 409) return 'Already published'
  if (status === 413) return 'Too large'
  if (status === 451) return 'Unavailable'
  return 'Request refused'
}

/**
 * True when the caller is a browser or a crawler rather than a script.
 *
 * A JSON request body or an explicit `Accept: application/json` both mean the
 * caller wants a machine-readable refusal. Everything else — including the bare
 * `*` a crawler sends — gets HTML, because a person following a dead link
 * should land on a page rather than on a JSON blob.
 */
export function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''
  if (accept.includes('application/json')) return false
  if ((request.headers.get('content-type') ?? '').includes('application/json')) return false
  return accept.includes('text/html') || accept.includes('*/*') || accept === ''
}

/**
 * The `?t=` token, read once and never stored.
 *
 * Returned as a plain string so the caller can hand it straight to the access
 * gate. Nothing logs it, nothing puts it in a header, and `redactShareUrl` runs
 * on any URL that leaves the handler.
 */
export function presentedToken(url: URL): string | null {
  const value = url.searchParams.get('t')
  return value && value.length <= 256 ? value : null
}

/**
 * The cookie an unlisted link is exchanged for.
 *
 * `?t=` is a fine way to *deliver* a secret and a bad way to keep presenting
 * one: a query string is written into Cloudflare's access log, the visitor's
 * browser history and session restore, and every proxy in between.
 * `redactShareUrl` covers the strings this application echoes and can reach
 * none of those. So the parameter is a bootstrap — presented once, exchanged,
 * and redirected away.
 *
 * One cookie per publication, scoped by `Path`, so a link to one unlisted model
 * is never sent to another. `__Host-` is deliberately not used: that prefix
 * requires `Path=/`, which is the opposite of the scoping wanted here.
 */
const SHARE_COOKIE = 'bw_share_link'

/** The share path a cookie for `slug` is scoped to. */
const sharePath = (slug: string) => `/share/${encodeURIComponent(slug)}`

export function cookieToken(request: Request, slug: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  const name = `${SHARE_COOKIE}_${cookieSuffix(slug)}`
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    if (entry.slice(0, separator).trim() !== name) continue
    const value = decodeURIComponent(entry.slice(separator + 1).trim())
    return value.length > 0 && value.length <= 256 ? value : null
  }
  return null
}

/**
 * A cookie name derived from the slug.
 *
 * Slugs are already `[a-z0-9-]`, but a cookie name may not contain `-`-adjacent
 * surprises from a future slug format, and it must stay short. Non-word
 * characters are folded rather than escaped: a collision between two slugs
 * costs nothing, because `Path` is what actually scopes the cookie.
 */
const cookieSuffix = (slug: string) => slug.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64)

/**
 * Trades a working token for a cookie and sends the visitor to the clean URL.
 *
 * 303 rather than 302: the visitor is being sent to a different resource
 * representation, and 303 is unambiguously a GET. `Cache-Control: no-store`
 * because the response carries a credential in a header.
 */
export function exchangeTokenForCookie(slug: string, token: string): Response {
  const path = sharePath(slug)
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
      'Set-Cookie': [
        `${SHARE_COOKIE}_${cookieSuffix(slug)}=${encodeURIComponent(token)}`,
        `Path=${path}`,
        'HttpOnly',
        'Secure',
        // `Lax`, not `None`: this cookie is for someone following a link, and a
        // third-party frame is what `/embed/:slug` is for. Widening it to
        // `None` would make every embed on any site a carrier for the secret.
        'SameSite=Lax',
        'Max-Age=2592000',
      ].join('; '),
      'Cache-Control': 'private, no-store',
      ...baseSecurityHeaders(),
    },
  })
}
