import { boundedTimeout, readRequestText, RequestBodyError, requestLifetime } from '../http/lifecycle.js'
import { logProcessEvent } from '../log.js'
import type { RouteModule } from '../dispatch.js'

/**
 * `POST /api/analytics/events`.
 *
 * The browser's closed-vocabulary event systems (`src/platform/analytics.ts`,
 * `src/features/landing/analytics.ts`) already reject anything outside their
 * enums before a `RecordedEvent` ever reaches a sink, so this route re-checks
 * shape, not the enum tables — duplicating those tables here would mean two
 * copies to keep in sync, and the one that drifts is never the one a test
 * catches. A caller that skips the browser and posts arbitrary JSON directly
 * still cannot smuggle anything beyond flat string/number/boolean fields.
 *
 * There is deliberately no dashboard behind this yet: events land as
 * structured JSON on stdout, the same channel `log.ts` already uses for this
 * process's own errors, so whatever log aggregation the deployment has for
 * that also has this. Set `BRICKWRIGHT_ANALYTICS_WEBHOOK_URL` to also forward
 * each event to a real destination without a code change.
 */

const MAX_BODY_BYTES = 4 * 1024
const PREFIX = '/api/analytics'
const PATH = '/api/analytics/events'
const SURFACES = new Set(['platform', 'landing'])

class BadRequest extends Error {}

type FlatValue = string | number | boolean

function isFlatValue(value: unknown): value is FlatValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

export interface IngestedEvent {
  readonly surface: 'platform' | 'landing'
  readonly name: string
  readonly at: number
  readonly fields: Readonly<Record<string, FlatValue>>
}

/**
 * Validates shape only: a non-empty `surface`, an `event.name` string, every
 * other `event` field a flat scalar, and a finite `at` (defaulted if absent or
 * bad, since a clock skew is not a reason to drop an otherwise-valid event).
 */
export function parseIngestedEvent(body: unknown, now: number = Date.now()): IngestedEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Request body must be a JSON object.')
  const { surface, event, at } = body as Record<string, unknown>
  if (typeof surface !== 'string' || !SURFACES.has(surface)) {
    throw new BadRequest('"surface" must be "platform" or "landing".')
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new BadRequest('"event" must be a JSON object.')
  const { name, ...rest } = event as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim()) throw new BadRequest('"event.name" must be a non-empty string.')
  const fields: Record<string, FlatValue> = {}
  for (const [field, value] of Object.entries(rest)) {
    if (!isFlatValue(value)) throw new BadRequest(`"event.${field}" must be a string, finite number or boolean.`)
    fields[field] = value
  }
  return {
    surface: surface as 'platform' | 'landing',
    name,
    at: typeof at === 'number' && Number.isFinite(at) ? at : now,
    fields,
  }
}

/** Best-effort mirror to a real destination. Never throws, never awaited by the caller. */
async function forwardToWebhook(event: IngestedEvent): Promise<void> {
  const url = process.env.BRICKWRIGHT_ANALYTICS_WEBHOOK_URL?.trim()
  if (!url) return
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (cause) {
    logProcessEvent({ level: 'error', service: 'analytics', message: 'webhook forward failed', cause })
  }
}

export function createAnalyticsRoute(): RouteModule {
  const timeoutMs = boundedTimeout(process.env.BRICKWRIGHT_ANALYTICS_TIMEOUT_MS, 5000)
  return {
    prefix: PREFIX,
    async handle(request, response, url) {
      if (url.pathname !== PATH) return false

      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
        response.end(JSON.stringify({ error: 'method_not_allowed', detail: 'Use POST.' }))
        return true
      }

      const mediaType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        response.writeHead(415, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'unsupported_media_type', detail: 'Use Content-Type: application/json.' }))
        return true
      }

      const span = requestLifetime(request, response, timeoutMs)
      try {
        let ingested: IngestedEvent
        try {
          const text = await readRequestText(request, span.signal, MAX_BODY_BYTES)
          let body: unknown
          try {
            body = JSON.parse(text)
          } catch {
            throw new BadRequest('Request body was not valid JSON.')
          }
          ingested = parseIngestedEvent(body)
        } catch (cause) {
          if (span.reason === 'client') return true
          const tooLarge = cause instanceof RequestBodyError && cause.code === 'PAYLOAD_TOO_LARGE'
          const status = span.reason === 'timeout' ? 408 : tooLarge ? 413 : 400
          response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(
            JSON.stringify({
              error: span.reason === 'timeout' ? 'timeout' : tooLarge ? 'payload_too_large' : 'bad_request',
              detail:
                span.reason === 'timeout'
                  ? 'The request body did not arrive before its deadline.'
                  : cause instanceof Error
                    ? cause.message
                    : 'Request body could not be read.',
            }),
          )
          return true
        }

        logProcessEvent({
          level: 'info',
          service: 'analytics',
          message: JSON.stringify({ surface: ingested.surface, name: ingested.name, at: ingested.at, ...ingested.fields }),
        })
        void forwardToWebhook(ingested)

        response.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: true }))
        return true
      } finally {
        span.dispose()
      }
    },
  }
}

export const route: RouteModule = createAnalyticsRoute()

export default route
