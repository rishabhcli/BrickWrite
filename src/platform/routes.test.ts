import { afterEach, describe, expect, it } from 'vitest'
import {
  PLATFORM_ROUTES,
  PRIMARY_NAV,
  isRouteRegistered,
  listRegisteredRoutes,
  registerRoute,
  resetRouteRegistry,
  routeById,
  routeHasAppFrame,
} from './routes'

afterEach(() => {
  resetRouteRegistry()
})

describe('route registry', () => {
  it('declares every top-level surface exactly once', () => {
    const ids = PLATFORM_ROUTES.map((route) => route.id)
    expect(ids).toEqual(['landing', 'explore', 'editor', 'projects', 'account', 'share', 'gallery', 'terms', 'privacy'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps the marketing and account surfaces at boot level "none"', () => {
    const byId = Object.fromEntries(PLATFORM_ROUTES.map((route) => [route.id, route.boot]))
    expect(byId.landing).toBe('none')
    expect(byId.account).toBe('none')
    expect(byId.gallery).toBe('none')
    expect(byId.explore).toBe('none')
    expect(byId.terms).toBe('none')
    expect(byId.privacy).toBe('none')
    expect(byId.editor).toBe('editor')
    expect(byId.projects).toBe('catalog')
    expect(byId.share).toBe('catalog')
  })

  it('gates only the surfaces that genuinely need an account', () => {
    const gated = PLATFORM_ROUTES.filter((route) => route.requiresAuth).map((route) => route.id)
    expect(gated).toEqual(['projects', 'account'])
    // The load-bearing half of this assertion: signed-out CAD editing works.
    expect(routeById('editor').requiresAuth).toBeUndefined()
  })

  it('resolves a registered surface through the registration hook', async () => {
    const marker = () => null
    const remove = registerRoute('gallery', async () => ({ default: marker }))
    expect(isRouteRegistered('gallery')).toBe(true)
    expect(listRegisteredRoutes()).toContain('gallery')

    const loaded = await routeById('gallery').load()
    expect(loaded.default).toBe(marker)

    remove()
    expect(isRouteRegistered('gallery')).toBe(false)
  })

  it('falls back to the honest placeholder for an unregistered id', async () => {
    expect(isRouteRegistered('share')).toBe(false)
    const loaded = await routeById('share').load()
    expect(loaded.default.displayName).toBe('NotInstalledSurface(share)')
  })

  it('replaces rather than duplicates a registration', async () => {
    const first = () => null
    const second = () => null
    registerRoute('explore', async () => ({ default: first }))
    registerRoute('explore', async () => ({ default: second }))
    expect((await routeById('explore').load()).default).toBe(second)
  })

  it('only detaches its own registration', async () => {
    const first = () => null
    const second = () => null
    const removeFirst = registerRoute('explore', async () => ({ default: first }))
    registerRoute('explore', async () => ({ default: second }))
    removeFirst()
    expect(isRouteRegistered('explore')).toBe(true)
    expect((await routeById('explore').load()).default).toBe(second)
  })

  it('throws on an id that is not declared', () => {
    // @ts-expect-error — the point of the test is the runtime guard.
    expect(() => routeById('nope')).toThrow(/No route is declared/)
  })

  it('keeps the editor out of the persistent frame', () => {
    expect(routeHasAppFrame('editor')).toBe(false)
    for (const route of PLATFORM_ROUTES) {
      if (route.id === 'editor') continue
      expect(routeHasAppFrame(route.id)).toBe(true)
    }
  })

  it('navigates only to declared routes', () => {
    for (const entry of PRIMARY_NAV) expect(() => routeById(entry.id)).not.toThrow()
  })
})
