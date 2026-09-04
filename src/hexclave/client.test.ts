import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hexclave/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  HexclaveClientApp: vi.fn().mockImplementation((options: unknown) => ({ options })),
}))
vi.mock('../platform/consent', () => ({ getAnalyticsConsent: vi.fn().mockReturnValue('unset') }))

const { HexclaveClientApp } = await import('@hexclave/react')
const { getAnalyticsConsent } = await import('../platform/consent')
const { getHexclaveClientApp, resetHexclaveClientApp } = await import('./client')

afterEach(() => {
  resetHexclaveClientApp()
  vi.mocked(HexclaveClientApp).mockClear()
})

describe('Hexclave client analytics gating', () => {
  it('disables analytics outright when consent is unset', () => {
    vi.mocked(getAnalyticsConsent).mockReturnValue('unset')
    getHexclaveClientApp()
    const options = vi.mocked(HexclaveClientApp).mock.calls[0]?.[0] as { analytics: unknown }
    expect(options.analytics).toEqual({ enabled: false })
  })

  it('disables analytics outright when consent is denied', () => {
    vi.mocked(getAnalyticsConsent).mockReturnValue('denied')
    getHexclaveClientApp()
    const options = vi.mocked(HexclaveClientApp).mock.calls[0]?.[0] as { analytics: unknown }
    expect(options.analytics).toEqual({ enabled: false })
  })

  it('builds the full analytics options once consent is granted', () => {
    vi.mocked(getAnalyticsConsent).mockReturnValue('granted')
    getHexclaveClientApp()
    const options = vi.mocked(HexclaveClientApp).mock.calls[0]?.[0] as { analytics: { enabled: boolean; replays?: unknown } }
    expect(options.analytics.enabled).toBe(true)
    expect(options.analytics.replays).toBeDefined()
  })
})
