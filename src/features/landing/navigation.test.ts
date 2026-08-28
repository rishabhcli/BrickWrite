import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hrefFor, navigate, parseRoute, setLandingNavigator } from './navigation'

describe('landing and explore navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    setLandingNavigator(null)
  })

  it('uses shell-owned paths and preserves demo selection in the query', () => {
    expect(hrefFor({ kind: 'landing' })).toBe('/')
    expect(hrefFor({ kind: 'editor' })).toBe('/editor')
    expect(hrefFor({ kind: 'explore', demoId: 'shutter bay', step: 7 })).toBe(
      '/explore?demo=shutter+bay&step=7',
    )
  })

  it('parses current URLs and retains old fragment deep links', () => {
    expect(parseRoute('', '/explore?demo=ridgeline-hauler&step=4')).toEqual({
      surface: 'explore',
      demoId: 'ridgeline-hauler',
      step: 4,
    })
    expect(parseRoute('#/explore/shutter-bay?step=3', '/')).toEqual({
      surface: 'explore',
      demoId: 'shutter-bay',
      step: 3,
    })
  })

  it('notifies the explore route hook after a same-surface history change', () => {
    window.history.replaceState(null, '', '/explore?demo=snot-kiosk')
    const seen = vi.fn()
    window.addEventListener('popstate', seen)
    try {
      navigate({ kind: 'explore', demoId: 'snot-kiosk', step: 2 })
      expect(window.location.pathname).toBe('/explore')
      expect(window.location.search).toBe('?demo=snot-kiosk&step=2')
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('popstate', seen)
    }
  })
})
