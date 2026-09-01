/**
 * HTTP dispatch for the API process.
 *
 * Kept separate from `index.ts` so the listener can be tested without binding a
 * port or discovering route modules from disk.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { logProcessEvent } from './log.js'

export interface RouteModule {
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>
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
