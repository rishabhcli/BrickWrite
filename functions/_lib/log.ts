import { redactShareUrl } from '../../src/features/share/sanitize'

/**
 * Edge-side structured logs. Secrets never belong in Cloudflare's log drain.
 *
 * Two redactions, because two different kinds of secret reach this file. Model
 * and proxy credentials appear inside free text — a thrown message, an upstream
 * body — and are matched by shape. An unlisted share token appears as a URL
 * parameter, `?t=<secret>`, and is handled by the share module's own
 * `redactShareUrl`, the same function `respond.ts` runs every echoed request
 * path through.
 *
 * The share token used to be handled by neither. `path` was written verbatim and
 * `redactEdgeText` had no rule for `?t=`, so this was safe only because both
 * call sites happen to pass `URL.pathname`, which drops the query — safe by
 * circumstance rather than by construction, in a file whose whole job is not
 * leaking secrets. `respond.ts` says it outright: "a log line carrying
 * `?t=<secret>` hands out a working unlisted link."
 */

export function redactEdgeText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/BRICKWRIGHT_PROXY_SECRET|x-brickwright-proxy-key/gi, '[REDACTED]')
    // An unlisted share token, wherever it turns up in free text.
    .replace(/([?&]t=)[^&#\s"']*/gi, '$1redacted')
}

export function logEdgeFailure(event: {
  readonly path: string
  readonly detail: string
  readonly cause?: unknown
  /** Which surface failed. The proxy was the only caller, so it was hard-coded. */
  readonly service?: string
}): void {
  const payload = {
    ts: new Date().toISOString(),
    level: 'error',
    service: event.service ?? 'functions/api',
    // Redacted even though today's callers pass a bare pathname: the signature
    // accepts any path, and the next caller should not have to know that.
    path: redactEdgeText(redactShareUrl(event.path)),
    detail: redactEdgeText(event.detail),
    cause: event.cause === undefined ? undefined : redactEdgeText(event.cause instanceof Error ? event.cause.message : String(event.cause)),
  }
  console.error(JSON.stringify(payload))
}
