import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Keep explicit output extensions: Vercel transpiles this TypeScript function
// to native ESM rather than bundling local modules, so extensionless imports
// fail in the Node runtime even though TypeScript can resolve them locally.
import { createAssistantRoute } from '../server/assistant/handler.js'
import type { RouteContext } from '../server/dispatch.js'
import { createGenerationRoute } from '../server/generation/index.js'
import { authorizePaidRoute } from '../server/security/auth.js'
import { budgetStatus, checkBudget, configureBudget, recordUsage } from '../server/security/budget.js'
import { budgetStoreFromEnv } from '../server/security/budgetStore.js'
import {
  acquireSlot,
  concurrencyCeiling,
  concurrencyStatus,
  configureConcurrency,
} from '../server/security/concurrency.js'
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
    json(response, 200, {
      ok: true,
      routes: routes.map((route) => route.prefix),
      metering: budgetStatus(),
      concurrency: { status: concurrencyStatus(), ceiling: concurrencyCeiling() },
    })
    return
  }

  let context: RouteContext | undefined
  let metering: Array<Promise<void>> = []
  let slot: { release(): Promise<void> } | null = null
  if (requiresIdentity(url.pathname, request.method)) {
    const authorization = await authorizePaidRoute(request)
    if (!authorization.ok) {
      json(response, authorization.status, { error: authorization.code, detail: authorization.detail })
      return
    }

    const { userId } = authorization.identity

    // Taken before the budget is read, because it is what makes that read mean
    // anything: the spend ceiling sees only *recorded* tokens, so concurrent
    // callers all read the same total and all pass. Capping how many can be in
    // flight is what turns the overshoot into a stated number.
    const admission = await acquireSlot(userId)
    if (!admission.ok) {
      json(
        response,
        429,
        { error: admission.code, detail: admission.detail },
        { 'retry-after': String(admission.retryAfterSeconds) },
      )
      return
    }
    slot = admission

    // The edge caps requests; this caps tokens, which is what is actually
    // bought. Checked before the call, because refusing after the tokens are
    // spent would meter nothing.
    const verdict = await checkBudget(userId)
    if (!verdict.ok) {
      await slot.release()
      json(
        response,
        429,
        { error: verdict.code, detail: verdict.detail },
        verdict.retryAfterSeconds ? { 'retry-after': String(verdict.retryAfterSeconds) } : {},
      )
      return
    }

    /*
     * Metering writes are started immediately and settled before this handler
     * returns.
     *
     * Not awaited at the call site, because a route reports usage mid-stream and
     * blocking there would stall the response. Not left floating either: a
     * serverless invocation may be frozen the moment the handler resolves, and a
     * promise that has not settled by then is a write that never happens — which
     * is how a ceiling silently stops counting.
     */
    metering = []
    context = {
      userId,
      reportUsage(usage) {
        metering.push(recordUsage(userId, usage))
      },
    }
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
      } finally {
        // `recordUsage` never rejects, so this only waits; it cannot turn a
        // metering failure into a request failure.
        if (metering.length) await Promise.allSettled(metering)
      }
    }
    json(response, 404, { error: 'not_found', detail: `No route claimed ${url.pathname}` })
  } finally {
    // Settled before the handler resolves, for the same reason the metering
    // writes are: a serverless invocation may be frozen the moment it returns,
    // and a slot released by a promise that never settles is a slot held until
    // its lease expires. `release` never rejects.
    await slot?.release()
  }
}
