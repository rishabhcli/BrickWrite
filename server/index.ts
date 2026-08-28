/**
 * The API process.
 *
 * Everything that holds a secret runs here rather than in Vite's module graph:
 * the model API key must never be reachable from a browser bundle, and the only
 * durable way to guarantee that is for the code that reads it to live in a
 * different process. Vite proxies `/api` here in development. A production host
 * must run this Node entry point (or provide audited function adapters), put
 * authentication and rate limits in front of paid routes, and keep the model
 * credential server-only; the Pages share functions are not model API adapters.
 *
 * Route modules are discovered rather than imported statically, so a build that
 * ships without the assistant — or without generation — still starts and
 * reports the missing route honestly instead of failing to boot.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'

/**
 * The contract a route module exports.
 *
 * `handle` returns true when it has taken responsibility for the response, and
 * false when the request was not its concern. That is what lets several modules
 * share one prefix without a router dependency.
 */
export interface RouteModule {
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>
}

const CANDIDATES = ['./assistant/index.ts', './generation/index.ts'] as const

async function loadRoutes(): Promise<RouteModule[]> {
  const loaded: RouteModule[] = []
  for (const specifier of CANDIDATES) {
    const path = new URL(specifier, import.meta.url)
    try {
      await stat(path)
    } catch {
      continue
    }
    const module = (await import(specifier)) as { route?: RouteModule; default?: RouteModule }
    const route = module.route ?? module.default
    if (route && typeof route.handle === 'function') loaded.push(route)
    else process.stderr.write(`[api] ${specifier} exports no route module; skipping\n`)
  }
  return loaded
}

function notFound(response: ServerResponse, detail: string) {
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'not_found', detail }))
}

const routes = await loadRoutes()

const server = createServer((request, response) => {
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
        // Never surface a stack or a key to the client; the process log keeps
        // the detail an operator needs.
        process.stderr.write(`[api] ${route.prefix} failed: ${String(cause)}\n`)
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'internal_error' }))
        } else {
          response.end()
        }
        return
      }
    }
    notFound(response, `No route module claimed ${url.pathname}`)
  })()
})

const port = Number(process.env.BRICKWRIGHT_API_PORT ?? 8787)
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `[api] listening on http://127.0.0.1:${port} with ${routes.length} route module(s): ${
      routes.map((route) => route.prefix).join(', ') || 'none'
    }\n`,
  )
})
