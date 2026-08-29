// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createRequestListener, type RouteModule } from './dispatch.ts'

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
      await expect(response.json()).resolves.toEqual({
        ok: true,
        routes: ['/api/assistant', '/api/generate'],
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
