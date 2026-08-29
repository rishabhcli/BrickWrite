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
import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { createRequestListener, type RouteModule } from './dispatch.ts'
import { logProcessEvent } from './log.ts'

export type { RouteModule } from './dispatch.ts'
export { createRequestListener } from './dispatch.ts'

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
    else logProcessEvent({ level: 'error', service: 'api', message: `${specifier} exports no route module; skipping` })
  }
  return loaded
}

export const routes = await loadRoutes()

const shouldListen =
  process.env.BRICKWRIGHT_API_LISTEN === '1' ||
  (process.env.BRICKWRIGHT_API_LISTEN !== '0' && !process.env.VITEST)

if (shouldListen) {
  const server = createServer(createRequestListener(routes))
  const port = Number(process.env.BRICKWRIGHT_API_PORT ?? 8787)
  server.listen(port, '127.0.0.1', () => {
    logProcessEvent({
      level: 'info',
      service: 'api',
      message: `listening on http://127.0.0.1:${port} with ${routes.length} route module(s): ${
        routes.map((route) => route.prefix).join(', ') || 'none'
      }`,
    })
  })
}
