import { logEdgeFailure } from '../_lib/log'

interface RateLimitKv {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/**
 * Cloudflare's native rate-limiting binding: increment-and-test in one call.
 *
 * The KV counter below cannot express that. `get` then `put` is two operations
 * with a gap, KV is eventually consistent, and it throttles repeated writes to
 * one key — so concurrent requests read the same stale count and the ceiling
 * does not hold. This binding is the atomic primitive that fixes it, and when
 * it is present the KV path is not consulted at all.
 */
interface AtomicRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface ApiProxyEnv {
  BRICKWRIGHT_API_ORIGIN?: string
  BRICKWRIGHT_PROXY_SECRET?: string
  API_RATE_LIMITER?: AtomicRateLimiter
  RATE_LIMIT_KV?: RateLimitKv
}

const PAID_PATHS = new Set(['/api/assistant', '/api/generate', '/api/brief'])
const WINDOW_SECONDS = 60
const REQUESTS_PER_WINDOW = 20

function json(status: number, body: unknown, retryAfter?: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
    },
  })
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The caller, as a key.
 *
 * Hashed before it becomes a limiter key or a KV key. A dashboard listing must
 * never turn into a list of live session headers.
 */
async function callerKey(request: Request): Promise<string> {
  const identity = request.headers.get('authorization') ?? ''
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return digest(`${ip}\n${identity}`)
}

/**
 * Whether this caller may make another paid request.
 *
 * Two implementations, preferred in order, and both fail **closed**: a limiter
 * that cannot answer means the spend control is not in force, and admitting
 * traffic in that state is the one outcome an operator who configured a ceiling
 * did not ask for.
 */
async function withinRateLimit(request: Request, env: ApiProxyEnv): Promise<boolean> {
  const key = await callerKey(request)

  if (env.API_RATE_LIMITER) {
    try {
      const { success } = await env.API_RATE_LIMITER.limit({ key })
      return success
    } catch (cause) {
      logEdgeFailure({ path: '/api', detail: 'The atomic rate limiter could not be reached.', cause })
      return false
    }
  }

  // Fallback for deployments without the binding. Read-modify-write, so the
  // ceiling holds on average rather than exactly; the overshoot is bounded by
  // concurrency. `docs/deployment.md` carries the binding that removes this.
  const kv = env.RATE_LIMIT_KV
  if (!kv) return false
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS)
  const windowKey = `api-rate:${window}:${key}`
  let stored: string | null
  try {
    stored = await kv.get(windowKey, 'text')
  } catch (cause) {
    logEdgeFailure({ path: '/api', detail: 'The rate-limit counter could not be read.', cause })
    return false
  }
  const used = stored === null ? 0 : Number.parseInt(stored, 10)
  // Unreadable counters used to fail open. An unparseable value is treated as
  // already over-limit so a corrupt row cannot bypass the spend control.
  if (!Number.isFinite(used) || used >= REQUESTS_PER_WINDOW) return false
  await kv.put(windowKey, String(used + 1), { expirationTtl: WINDOW_SECONDS * 2 })
  return true
}

/**
 * Same-origin edge proxy for the separately deployed secret-bearing Node API.
 *
 * Paid calls are bounded at the edge before they can consume Vercel or model
 * capacity. The Node service still validates the Hexclave session; the hash
 * here is only a rate-limit key, never an authorization decision.
 */
export const onRequest = async (context: { request: Request; env: ApiProxyEnv }): Promise<Response> => {
  const { request, env } = context
  const incoming = new URL(request.url)
  const configuredOrigin = env.BRICKWRIGHT_API_ORIGIN?.trim()
  const proxySecret = env.BRICKWRIGHT_PROXY_SECRET?.trim()
  if (!configuredOrigin || !proxySecret) {
    return json(503, { error: 'api_unavailable', detail: 'The production API proxy is not configured.' })
  }

  let origin: URL
  try {
    origin = new URL(configuredOrigin)
  } catch {
    logEdgeFailure({ path: incoming.pathname, detail: 'The production API origin is invalid.' })
    return json(503, { error: 'api_unavailable', detail: 'The production API origin is invalid.' })
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
    return json(503, { error: 'api_unavailable', detail: 'The production API origin must be an HTTPS origin.' })
  }

  if (request.method === 'POST' && PAID_PATHS.has(incoming.pathname)) {
    if (!env.API_RATE_LIMITER && !env.RATE_LIMIT_KV) {
      return json(503, { error: 'rate_limit_unavailable', detail: 'The API rate limiter is not configured.' })
    }
    if (!(await withinRateLimit(request, env))) {
      const remaining = WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS)
      return json(429, { error: 'rate_limited', detail: 'Too many model requests. Retry shortly.' }, remaining)
    }
  }

  const target = new URL(`${incoming.pathname}${incoming.search}`, origin)
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('cf-connecting-ip')
  headers.delete('cf-ray')
  headers.set('x-brickwright-proxy-key', proxySecret)
  headers.set('x-forwarded-host', incoming.host)

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      signal: request.signal,
      redirect: 'manual',
    })
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.set('cache-control', 'private, no-store')
    responseHeaders.set('x-content-type-options', 'nosniff')
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    })
  } catch (cause) {
    logEdgeFailure({ path: incoming.pathname, detail: 'The model API could not be reached.', cause })
    return json(502, { error: 'api_unreachable', detail: 'The model API could not be reached.' })
  }
}
