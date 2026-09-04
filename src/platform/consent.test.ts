import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAnalyticsConsent, reopenAnalyticsConsent, setAnalyticsConsent } from './consent'

let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true })
})

afterEach(() => {
  window.localStorage.clear()
})

describe('analytics consent', () => {
  it('defaults to unset', () => {
    expect(getAnalyticsConsent()).toBe('unset')
  })

  it('persists a granted choice and reloads', () => {
    setAnalyticsConsent('granted')
    expect(getAnalyticsConsent()).toBe('granted')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('persists a denied choice and reloads', () => {
    setAnalyticsConsent('denied')
    expect(getAnalyticsConsent()).toBe('denied')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('treats a corrupted stored value as unset', () => {
    window.localStorage.setItem('brickwright:analytics-consent', 'yes-please')
    expect(getAnalyticsConsent()).toBe('unset')
  })

  it('clears a decided consent back to unset and reloads', () => {
    setAnalyticsConsent('granted')
    reopenAnalyticsConsent()
    expect(getAnalyticsConsent()).toBe('unset')
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
