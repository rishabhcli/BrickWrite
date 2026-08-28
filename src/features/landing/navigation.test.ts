import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NAVIGATION_EVENT, hrefFor, navigate, parseRoute, setLandingNavigator } from './navigation'

describe('landing and explore navigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    setLandingNavigator(null)
  })

  it('uses shell-owned paths and keeps demo selection in the query', () => {
    expect(hrefFor({ kind: 'landing' })).toBe('/')
    expect(hrefFor({ kind: 'editor' })).toBe('/editor')
    expect(hrefFor({ kind: 'explore', demoId: 'shutter bay', step: 7 })).toBe('/explore?demo=shutter+bay&step=7')
  })

  it('parses current URLs and still honours a pasted fragment deep link', () => {
    expect(parseRoute('/explore', '?demo=ridgeline-hauler&step=4')).toEqual({
      surface: 'explore',
      demoId: 'ridgeline-hauler',
      step: 4,
    })
    expect(parseRoute('/', '', '#/explore/shutter-bay?step=3')).toEqual({
      surface: 'explore',
      demoId: 'shutter-bay',
      step: 3,
    })
  })

  it('announces a same-surface history change, since pushState fires nothing', () => {
    window.history.replaceState(null, '', '/explore?demo=snot-kiosk')
    const seen = vi.fn()
    window.addEventListener(NAVIGATION_EVENT, seen)
    try {
      navigate({ kind: 'explore', demoId: 'snot-kiosk', step: 2 })
      expect(window.location.pathname).toBe('/explore')
      expect(window.location.search).toBe('?demo=snot-kiosk&step=2')
      expect(seen).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(NAVIGATION_EVENT, seen)
    }
  })

  it('hands a cross-surface move to a registered navigator instead of reloading', () => {
    const shell = vi.fn().mockReturnValue(true)
    const restore = setLandingNavigator(shell)
    try {
      navigate({ kind: 'editor' })
      expect(shell).toHaveBeenCalledWith({ kind: 'editor' }, '/editor')
      // The registered navigator claimed it, so the document did not move.
      expect(window.location.pathname).toBe('/')
    } finally {
      restore()
    }
  })
})
