/**
 * HTTP dispatch for the API process.
 *
 * Kept separate from `index.ts` so the listener can be tested without binding a
 * port or discovering route modules from disk.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { logProcessEvent } from './log.js'

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
  /** Records what a completed model call cost. Never throws, never awaited. */
  reportUsage?(usage: { readonly inputTokens: number; readonly outputTokens: number }): void
}

export interface RouteModule {
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context?: RouteContext): Promise<boolean>
}

export function createRequestListener(routes: RouteModule[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, routes: routes.map((route) => route.prefix) }))
      return
    }

    void (async () => {
      for (const route of routes) {
        if (!url.pathname.startsWith(route.prefix)) continue
        try {
          if (await route.handle(request, response, url)) return
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
    })()
  }
}
