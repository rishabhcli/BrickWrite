import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Keep explicit output extensions: Vercel transpiles this TypeScript function
// to native ESM rather than bundling local modules, so extensionless imports
// fail in the Node runtime even though TypeScript can resolve them locally.
import { createAssistantRoute } from '../server/assistant/handler.js'
import { createGenerationRoute } from '../server/generation/index.js'
import { authorizePaidRoute } from '../server/security/auth.js'

const routes = [createAssistantRoute(), createGenerationRoute()]

function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  response.end(JSON.stringify(body))
}

function proxyAccepted(request: IncomingMessage): boolean {
  const expected = process.env.BRICKWRIGHT_PROXY_SECRET?.trim()
  if (!expected) return false
  const raw = request.headers['x-brickwright-proxy-key']
  const presented = Array.isArray(raw) ? raw[0] : raw
  if (!presented) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(presented)
  return left.length === right.length && timingSafeEqual(left, right)
}

const requiresIdentity = (pathname: string, method: string | undefined) =>
  method === 'POST' && ['/api/assistant', '/api/generate', '/api/brief'].includes(pathname)

/**
 * Vercel's Node entry for Brickwright's secret-bearing API process.
 *
 * The public application reaches this only through the Cloudflare Pages proxy.
 * The proxy secret prevents callers from bypassing its edge rate limit, and the
 * Hexclave session check is still repeated here because a proxy is not an
 * identity authority. The existing audited route modules own request bounds,
 * streaming, aborts and provider redaction after those two gates pass.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', `https://${request.headers.host ?? 'api.brickwrite.tech'}`)

  if (!proxyAccepted(request)) {
    json(response, 403, { error: 'proxy_required', detail: 'Use the Brickwright application API origin.' })
    return
  }

  if (url.pathname === '/api/health') {
    json(response, 200, { ok: true, routes: routes.map((route) => route.prefix) })
    return
  }

  if (requiresIdentity(url.pathname, request.method)) {
    const authorization = await authorizePaidRoute(request)
    if (!authorization.ok) {
      json(response, authorization.status, { error: authorization.code, detail: authorization.detail })
      return
    }
  }

  for (const route of routes) {
    if (!url.pathname.startsWith(route.prefix)) continue
    try {
      if (await route.handle(request, response, url)) return
    } catch (cause) {
      process.stderr.write(`[api] ${route.prefix} failed: ${String(cause)}\n`)
      if (!response.headersSent) json(response, 500, { error: 'internal_error' })
      else response.end()
      return
    }
  }
  json(response, 404, { error: 'not_found', detail: `No route claimed ${url.pathname}` })
}
