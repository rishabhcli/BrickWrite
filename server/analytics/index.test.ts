// @vitest-environment node
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestListener } from '../dispatch.ts'
import { createAnalyticsRoute, parseIngestedEvent } from './index.ts'

async function withServer(run: (base: string) => Promise<void>) {
  const server = createServer(createRequestListener([createAnalyticsRoute()]))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server bound no port')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

const post = (base: string, body: unknown, contentType = 'application/json') =>
  fetch(`${base}/api/analytics/events`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('parseIngestedEvent', () => {
  it('accepts a flat platform event and defaults a missing timestamp', () => {
    const parsed = parseIngestedEvent({ surface: 'platform', event: { name: 'auth.signed_in' } }, 1234)
    expect(parsed).toEqual({ surface: 'platform', name: 'auth.signed_in', at: 1234, fields: {} })
  })

  it('keeps flat scalar fields alongside the name', () => {
    const parsed = parseIngestedEvent({
      surface: 'landing',
      event: { name: 'demo.step_scrubbed', demoId: 'meridian-green', step: 3 },
      at: 999,
    })
    expect(parsed).toEqual({
      surface: 'landing',
      name: 'demo.step_scrubbed',
      at: 999,
      fields: { demoId: 'meridian-green', step: 3 },
    })
  })

  it.each([
    [{}],
    [{ surface: 'not-a-surface', event: { name: 'x' } }],
    [{ surface: 'platform' }],
    [{ surface: 'platform', event: {} }],
    [{ surface: 'platform', event: { name: '' } }],
    [{ surface: 'platform', event: { name: 'x', nested: { a: 1 } } }],
    [{ surface: 'platform', event: { name: 'x', bad: [1, 2] } }],
  ])('rejects %j', (body) => {
    expect(() => parseIngestedEvent(body)).toThrow()
  })
})

describe('POST /api/analytics/events', () => {
  afterEach(() => {
    delete process.env.BRICKWRIGHT_ANALYTICS_WEBHOOK_URL
    vi.unstubAllGlobals()
  })

  it('accepts a valid event and logs it to stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await withServer(async (base) => {
        const response = await post(base, { surface: 'landing', event: { name: 'landing.viewed' } })
        expect(response.status).toBe(202)
        await expect(response.json()).resolves.toEqual({ ok: true })
      })
      expect(write).toHaveBeenCalledTimes(1)
      const logged = JSON.parse(String(write.mock.calls[0]?.[0]))
      expect(logged).toMatchObject({ level: 'info', service: 'analytics' })
      expect(JSON.parse(logged.message)).toMatchObject({ surface: 'landing', name: 'landing.viewed' })
    } finally {
      write.mockRestore()
    }
  })

  it('rejects a non-JSON content type', async () => {
    await withServer(async (base) => {
      const response = await post(base, { surface: 'platform', event: { name: 'x' } }, 'text/plain')
      expect(response.status).toBe(415)
    })
  })

  it('rejects a body outside the closed shape', async () => {
    await withServer(async (base) => {
      const response = await post(base, { surface: 'platform', event: { name: 'x', nested: {} } })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'bad_request' })
    })
  })

  it('rejects a body over the byte ceiling', async () => {
    await withServer(async (base) => {
      const response = await post(base, {
        surface: 'platform',
        event: { name: 'x', big: 'a'.repeat(8 * 1024) },
      })
      expect(response.status).toBe(413)
    })
  })

  it('rejects GET', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/analytics/events`)
      expect(response.status).toBe(405)
    })
  })

  it('does not claim an unrelated path under its prefix', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/analytics/other`)
      expect(response.status).toBe(404)
    })
  })

  it('forwards to a configured webhook without delaying or failing the response', async () => {
    process.env.BRICKWRIGHT_ANALYTICS_WEBHOOK_URL = 'https://example.invalid/hook'
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', Object.assign(fetchSpy, { preconnect: vi.fn() }))
    // Re-import is unnecessary: the route reads the env var per-request, not at module load.
    const { createAnalyticsRoute: createRoute } = await import('./index.ts')
    const server = createServer(createRequestListener([createRoute()]))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server bound no port')
    try {
      // The stubbed global fetch also intercepts the test's own outbound POST,
      // so this hits the real listener over a raw socket instead.
      const { request } = await import('node:http')
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: address.port, path: '/api/analytics/events', method: 'POST', headers: { 'content-type': 'application/json' } },
          (response) => {
            response.resume()
            response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
          },
        )
        req.on('error', reject)
        req.end(JSON.stringify({ surface: 'platform', event: { name: 'auth.signed_in' } }))
      })
      expect(res.status).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchSpy).toHaveBeenCalledWith('https://example.invalid/hook', expect.objectContaining({ method: 'POST' }))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
