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
import { createRequestListener, type RouteModule } from './dispatch.js'
import { logProcessEvent } from './log.js'
import { configureBudget } from './security/budget.js'
import { budgetStoreFromEnv } from './security/budgetStore.js'
import { configureConcurrency } from './security/concurrency.js'
import { gateStatus } from './security/gate.js'

export type { RouteModule } from './dispatch.js'
export { createRequestListener } from './dispatch.js'

const CANDIDATES = ['./assistant/index.ts', './generation/index.ts', './analytics/index.ts'] as const

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
  // The same counter the Vercel entry uses, read from the same variables. Absent
  // is a supported mode and the boot line says which one this process is in, so
  // an unmetered deployment is a thing an operator can see rather than assume.
  const counter = budgetStoreFromEnv()
  configureBudget(counter)
  configureConcurrency(counter)

  /*
   * A last line, not a licence to throw.
   *
   * Every known synchronous hazard in the listener is fixed where it lives —
   * `requestUrl` is the one this was written for. But a route module is
   * third-party from this file's point of view, and an in-flight request holds
   * a concurrency slot whose lease runs for five minutes: dying takes the slot
   * with it and refuses that account until the lease expires. Logging and
   * staying up costs one bad response instead.
   */
  process.on('uncaughtException', (cause) => {
    logProcessEvent({ level: 'error', service: 'api', message: 'uncaught exception', cause })
  })
  process.on('unhandledRejection', (cause) => {
    logProcessEvent({ level: 'error', service: 'api', message: 'unhandled rejection', cause })
  })

  const server = createServer(createRequestListener(routes))
  const port = Number(process.env.BRICKWRIGHT_API_PORT ?? 8787)
  server.listen(port, '127.0.0.1', () => {
    const status = gateStatus()
    logProcessEvent({
      level: 'info',
      service: 'api',
      message: `listening on http://127.0.0.1:${port} with ${routes.length} route module(s): ${
        routes.map((route) => route.prefix).join(', ') || 'none'
      }; metering ${status.metering}, in-flight ceiling ${status.concurrency.status}`,
    })
  })
}
