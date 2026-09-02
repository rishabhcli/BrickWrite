// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequestListener, type RouteModule } from './dispatch.ts'
import { configureBudget } from './security/budget.ts'
import { configureConcurrency, DEFAULT_MAX_IN_FLIGHT } from './security/concurrency.ts'

async function withServer(routes: RouteModule[], run: (base: string) => Promise<void>) {
  const server = createServer(createRequestListener(routes))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server bound no port')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

describe('API process dispatch', () => {
  it('reports health and the loaded route prefixes', async () => {
    const routes: RouteModule[] = [
      { prefix: '/api/assistant', handle: async () => false },
      { prefix: '/api/generate', handle: async () => false },
    ]
    await withServer(routes, async (base) => {
      const response = await fetch(`${base}/api/health`)
      expect(response.status).toBe(200)
      // Says which spend controls are in force, so an unmetered process is
      // something an operator can see rather than assume.
      await expect(response.json()).resolves.toEqual({
        ok: true,
        routes: ['/api/assistant', '/api/generate'],
        metering: 'unconfigured',
        concurrency: { status: 'unconfigured', ceiling: DEFAULT_MAX_IN_FLIGHT },
      })
    })
  })

  it('returns a typed 404 for an unclaimed path', async () => {
    await withServer([], async (base) => {
      const response = await fetch(`${base}/api/missing`)
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ error: 'not_found' })
    })
  })

  it('returns a generic 500 without leaking the thrown stack', async () => {
    const routes: RouteModule[] = [
      {
        prefix: '/api/boom',
        handle: async () => {
          throw new Error('secret stack should not ship')
        },
      },
    ]
    await withServer(routes, async (base) => {
      const response = await fetch(`${base}/api/boom`)
      expect(response.status).toBe(500)
      const body = await response.text()
      expect(body).toBe(JSON.stringify({ error: 'internal_error' }))
      expect(body).not.toContain('secret stack')
    })
  })

  it('does not write a second status when the route already sent headers', async () => {
    const routes: RouteModule[] = [
      {
        prefix: '/api/partial',
        handle: async (_request: IncomingMessage, response: ServerResponse) => {
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.write('partial')
          throw new Error('failed after headers')
        },
      },
    ]
    await withServer(routes, async (base) => {
      const response = await fetch(`${base}/api/partial`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('partial')
    })
  })
})

/**
 * Spend controls on the self-hosted listener.
 *
 * This process passed no `RouteContext`, so `reportUsage` was a call into
 * nothing and a configured counter counted nothing — the Vercel entry metered
 * paid routes and this one did not. Both now open the same gate.
 */
describe('paid routes on the API process', () => {
  const rows = new Map<string, number>()
  const counter = {
    async read(key: string) {
      const value = rows.get(key)
      return value === undefined ? null : String(value)
    },
    async write(key: string, value: string) {
      rows.set(key, Number.parseInt(value, 10))
    },
    async increment(key: string, by: number) {
      const next = (rows.get(key) ?? 0) + by
      rows.set(key, next)
      return next
    },
    async adjust(key: string, by: number) {
      const next = (rows.get(key) ?? 0) + by
      rows.set(key, next)
      return next
    },
  }

  /** Answers 200 and reports whatever the current test set as a cost. */
  const paid = (usage?: { inputTokens: number; outputTokens: number }): RouteModule[] => [
    {
      prefix: '/api/assistant',
      handle: async (_request, response, _url, context) => {
        if (usage) context?.reportUsage?.(usage)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
        return true
      },
    },
  ]

  const post = (base: string) =>
    fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

  afterEach(() => {
    configureBudget(null)
    configureConcurrency(null)
    rows.clear()
  })

  it('meters a completed call against the local account', async () => {
    configureBudget(counter, 1000)
    await withServer(paid({ inputTokens: 100, outputTokens: 10 }), async (base) => {
      expect((await post(base)).status).toBe(200)
    })
    // 100 input + 10 output × 5 = 150 weighted tokens.
    expect([...rows.values()]).toEqual([150])
  })

  it('refuses the next call once the local account passes its ceiling', async () => {
    configureBudget(counter, 1000)
    await withServer(paid({ inputTokens: 2000, outputTokens: 0 }), async (base) => {
      expect((await post(base)).status).toBe(200)
      const refused = await post(base)
      expect(refused.status).toBe(429)
      await expect(refused.json()).resolves.toMatchObject({ error: 'budget_exhausted' })
    })
  })

  it('does not meter a route that spends nothing', async () => {
    configureBudget(counter, 1000)
    await withServer(paid({ inputTokens: 100, outputTokens: 0 }), async (base) => {
      // A GET on the same path is not a paid request and takes no slot.
      expect((await fetch(`${base}/api/assistant`)).status).toBe(200)
    })
    expect(rows.size).toBe(0)
  })

  it('leaves paid routes unmetered when no counter is configured', async () => {
    configureBudget(null)
    configureConcurrency(null)
    await withServer(paid({ inputTokens: 5_000_000, outputTokens: 0 }), async (base) => {
      expect((await post(base)).status).toBe(200)
      expect((await post(base)).status).toBe(200)
    })
    expect(rows.size).toBe(0)
  })

  it('hands the in-flight slot back so sequential calls are not refused', async () => {
    configureConcurrency(counter, 1)
    await withServer(paid(), async (base) => {
      expect((await post(base)).status).toBe(200)
      expect((await post(base)).status).toBe(200)
      expect((await post(base)).status).toBe(200)
    })
  })
})
