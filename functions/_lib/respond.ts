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

export function html(page: { html: string; status: number; headers: Record<string, string> }): Response {
  return new Response(page.html, { status: page.status, headers: page.headers })
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

export function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: `"${etag}"`, ...baseSecurityHeaders() } })
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
