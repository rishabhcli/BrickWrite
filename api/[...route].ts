import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Keep explicit output extensions: Vercel transpiles this TypeScript function
// to native ESM rather than bundling local modules, so extensionless imports
// fail in the Node runtime even though TypeScript can resolve them locally.
import { createAssistantRoute } from '../server/assistant/handler.js'
import type { RouteContext } from '../server/dispatch.js'
import { createGenerationRoute } from '../server/generation/index.js'
import { authorizePaidRoute } from '../server/security/auth.js'
import { configureBudget } from '../server/security/budget.js'
import { budgetStoreFromEnv } from '../server/security/budgetStore.js'
import { configureConcurrency } from '../server/security/concurrency.js'
import { gateStatus, isPaidRequest, openPaidGate } from '../server/security/gate.js'
import { logProcessEvent } from '../server/log.js'

const routes = [createAssistantRoute(), createGenerationRoute()]

/*
 * Installed at module scope, once per cold start.
 *
 * Both configure calls are idempotent and the store holds no per-request state,
 * so doing this on import rather than per invocation avoids rebuilding it on
 * every warm call. A deployment with no counter configured gets null, which is a
 * supported mode for both: the controls are off and `/api/health` says so.
 *
 * One store, two controls. The spend meter answers "has this account bought
 * enough today"; the in-flight limiter answers "is this account already using
 * more of the model API than it should at once" — which is the question that
 * bounds how far past the first answer a burst can get.
 */
const counter = budgetStoreFromEnv()
configureBudget(counter)
configureConcurrency(counter)

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
    json(response, 200, { ok: true, routes: routes.map((route) => route.prefix), ...gateStatus() })
    return
  }

  let context: RouteContext | undefined
  let release: (() => Promise<void>) | null = null
  if (isPaidRequest(url.pathname, request.method)) {
    // Identity first, and only here: a proxy is not an identity authority, and
    // the gate meters against a subject rather than deciding who owns one.
    const authorization = await authorizePaidRoute(request)
    if (!authorization.ok) {
      json(response, authorization.status, { error: authorization.code, detail: authorization.detail })
      return
    }
    const gate = await openPaidGate(authorization.identity.userId)
    if (!gate.ok) {
      json(response, gate.refusal.status, { error: gate.refusal.code, detail: gate.refusal.detail }, gate.refusal.headers)
      return
    }
    context = gate.admission.context
    release = () => gate.admission.release()
  }

  try {
    for (const route of routes) {
      if (!url.pathname.startsWith(route.prefix)) continue
      try {
        if (await route.handle(request, response, url, context)) return
      } catch (cause) {
        logProcessEvent({ level: 'error', service: 'api', message: `${route.prefix} failed`, cause })
        if (!response.headersSent) json(response, 500, { error: 'internal_error' })
        else response.end()
        return
      }
    }
    json(response, 404, { error: 'not_found', detail: `No route claimed ${url.pathname}` })
  } finally {
    // Settled before the handler resolves: a serverless invocation may be frozen
    // the moment it does, and a metering write or a slot release that has not
    // settled by then never happens.
    await release?.()
  }
}
