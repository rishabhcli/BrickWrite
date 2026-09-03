/**
 * HTTP dispatch for the API process.
 *
 * Kept separate from `index.ts` so the listener can be tested without binding a
 * port or discovering route modules from disk.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requestUrl } from './http/lifecycle.js'
import { logProcessEvent } from './log.js'
import { gateStatus, isPaidRequest, openPaidGate } from './security/gate.js'

/**
 * What the entry point knows about a request that a route module does not.
 *
 * Identity and spend metering are decided at the boundary — the Vercel entry
 * verifies the Hexclave session and owns the budget store — but the token counts
 * only exist inside the route that made the model call. This carries the one
 * across to the other without either importing the other's concerns: a route
 * calls `reportUsage` and does not know what a ceiling is.
 *
 * Optional throughout, because the local dev listener authenticates nobody and
 * meters nothing.
 */
export interface RouteContext {
  /** The verified caller's Hexclave user id, on routes that required one. */
  readonly userId?: string
  /**
   * Records what a completed model call cost. Never throws, never awaited.
   *
   * The two cache counts are separate fields because the provider reports them
   * separately: neither is included in `inputTokens`, and a route that omits
   * them meters a cached prefix as free. They are optional so a provider that
   * does not cache — or a test double — does not have to name them.
   */
  reportUsage?(usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
  }): void
}

export interface RouteModule {
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context?: RouteContext): Promise<boolean>
}

/**
 * The subject this process meters against.
 *
 * It authenticates nobody — Vite proxies a developer's own browser to it — so
 * there is one account here by construction, and metering everything it serves
 * as that account is the honest reading. What it buys is real: a configured
 * counter now bounds what a runaway loop can spend against a developer's own
 * key, which it previously did not, because this listener passed no context and
 * `reportUsage` was a call into nothing.
 */
export const LOCAL_SUBJECT = '@local'

export function createRequestListener(routes: RouteModule[], subject = LOCAL_SUBJECT) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const url = requestUrl(request)

    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, routes: routes.map((route) => route.prefix), ...gateStatus() }))
      return
    }

    void (async () => {
      let context: RouteContext | undefined
      let release: (() => Promise<void>) | null = null
      if (isPaidRequest(url.pathname, request.method)) {
        const gate = await openPaidGate(subject)
        if (!gate.ok) {
          response.writeHead(gate.refusal.status, { 'content-type': 'application/json', ...gate.refusal.headers })
          response.end(JSON.stringify({ error: gate.refusal.code, detail: gate.refusal.detail }))
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
            logProcessEvent({
              level: 'error',
              service: 'api',
              message: `${route.prefix} failed`,
              cause,
            })
            if (!response.headersSent) {
              response.writeHead(500, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ error: 'internal_error' }))
            } else {
              response.end()
            }
            return
          }
        }
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'not_found', detail: `No route module claimed ${url.pathname}` }))
      } finally {
        await release?.()
      }
    })()
  }
}
