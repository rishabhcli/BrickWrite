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

  // jsdom has no `sendBeacon` at all (confirmed: `typeof navigator.sendBeacon`
  // is `undefined` here), which is exactly why the three tests above — run
  // against the very same environment — never notice it is meant to be the
  // primary path. These stub it in directly so that path has its own coverage
  // rather than relying on a real browser to exercise it for the first time.
  //
  // Dispatched through the window bridge rather than `trackPlatformEvent`,
  // like the landing test above and for the same reason: `afterEach` nulls
  // the platform sink once the first test in this file has used it, and
  // `installAnalyticsDelivery`'s idempotency guard means nothing re-arms it
  // afterwards. The window listener `post` sits behind, unlike the sink, is
  // never torn down, so it is the only delivery path later tests can reach.
  it('prefers sendBeacon over fetch when the browser has one', async () => {
    const beacon = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    window.dispatchEvent(
      new CustomEvent('brickwright:analytics', { detail: { event: { name: 'auth.signed_in' }, at: 1000 } }),
    )
    await Promise.resolve()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, payload] = beacon.mock.calls[0] as [string, Blob]
    expect(url).toBe('/api/analytics/events')
    expect(payload.type).toBe('application/json')
    expect(JSON.parse(await payload.text())).toEqual({ surface: 'landing', event: { name: 'auth.signed_in' }, at: 1000 })
  })

  it('never throws when sendBeacon reports it could not queue the beacon', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) })
    expect(() =>
      window.dispatchEvent(
        new CustomEvent('brickwright:analytics', { detail: { event: { name: 'auth.signed_out' }, at: 3000 } }),
      ),
    ).not.toThrow()
  })
})
