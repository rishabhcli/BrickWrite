import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installAnalyticsDelivery } from './analyticsDelivery'
import { resetPlatformAnalytics, trackPlatformEvent } from './analytics'

// Installed once, like `main.tsx` does: this exercises the real idempotency
// guard rather than a reset seam nothing in production ever calls.
beforeAll(() => {
  installAnalyticsDelivery()
})

afterEach(() => {
  resetPlatformAnalytics()
  vi.unstubAllGlobals()
})

describe('analytics delivery', () => {
  it('posts a platform event to the ingestion route', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchSpy)

    trackPlatformEvent({ name: 'auth.signed_in' }, 1000)
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/analytics/events')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual({ surface: 'platform', event: { name: 'auth.signed_in' }, at: 1000 })
  })

  it('bridges a landing event carried on the window', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchSpy)

    window.dispatchEvent(
      new CustomEvent('brickwright:analytics', { detail: { event: { name: 'landing.viewed' }, at: 2000 } }),
    )
    await Promise.resolve()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/analytics/events')
    expect(JSON.parse(init.body as string)).toEqual({ surface: 'landing', event: { name: 'landing.viewed' }, at: 2000 })
  })

  it('never throws when delivery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('offline')),
    )
    expect(() => trackPlatformEvent({ name: 'auth.signed_out' })).not.toThrow()
    await Promise.resolve()
  })
})
