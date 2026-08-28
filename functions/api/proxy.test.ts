// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequest } from './[[route]]'

class MemoryRateLimit {
  values = new Map<string, string>()
  get(key: string) { return Promise.resolve(this.values.get(key) ?? null) }
  put(key: string, value: string) { this.values.set(key, value); return Promise.resolve() }
}

afterEach(() => vi.unstubAllGlobals())

describe('production API proxy', () => {
  it('fails closed when its upstream is not configured', async () => {
    const response = await onRequest({ request: new Request('https://brickwrite.tech/api/health'), env: {} })
    expect(response.status).toBe(503)
  })

  it('requires the durable limiter before forwarding a paid call', async () => {
    const response = await onRequest({
      request: new Request('https://brickwrite.tech/api/generate', { method: 'POST', body: '{}' }),
      env: { BRICKWRIGHT_API_ORIGIN: 'https://brickwrite-api.vercel.app', BRICKWRIGHT_PROXY_SECRET: 'secret' },
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'rate_limit_unavailable' })
  })

  it('forwards the session, adds the private proxy proof and preserves streaming bodies', async () => {
    let receivedUrl = ''
    let receivedHeaders = new Headers()
    vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      receivedUrl = input instanceof Request ? input.url : String(input)
      receivedHeaders = new Headers(input instanceof Request ? input.headers : init?.headers)
      return new Response('one\ntwo\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    })
    const response = await onRequest({
      request: new Request('https://brickwrite.tech/api/assistant?mode=build', {
        method: 'POST',
        headers: { authorization: 'Bearer stackauth_test', 'content-type': 'application/json' },
        body: '{}',
      }),
      env: {
        BRICKWRIGHT_API_ORIGIN: 'https://brickwrite-api.vercel.app',
        BRICKWRIGHT_PROXY_SECRET: 'proxy-proof',
        RATE_LIMIT_KV: new MemoryRateLimit(),
      },
    })
    expect(receivedUrl).toBe('https://brickwrite-api.vercel.app/api/assistant?mode=build')
    expect(receivedHeaders.get('authorization')).toBe('Bearer stackauth_test')
    expect(receivedHeaders.get('x-brickwright-proxy-key')).toBe('proxy-proof')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.text()).resolves.toBe('one\ntwo\n')
  })

  it('bounds each credential and address to twenty paid calls per minute', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'))
    const kv = new MemoryRateLimit()
    const env = {
      BRICKWRIGHT_API_ORIGIN: 'https://brickwrite-api.vercel.app',
      BRICKWRIGHT_PROXY_SECRET: 'proxy-proof',
      RATE_LIMIT_KV: kv,
    }
    for (let index = 0; index < 20; index += 1) {
      const response = await onRequest({
        request: new Request('https://brickwrite.tech/api/brief', {
          method: 'POST', headers: { authorization: 'Bearer same-user' }, body: '{}',
        }),
        env,
      })
      expect(response.status).toBe(200)
    }
    const refused = await onRequest({
      request: new Request('https://brickwrite.tech/api/brief', {
        method: 'POST', headers: { authorization: 'Bearer same-user' }, body: '{}',
      }),
      env,
    })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/)
  })
})
