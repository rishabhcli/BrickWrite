import type { ComponentType } from 'react'
import type { RouteId, RouteModule } from './contracts'

/**
 * The route registry.
 *
 * Ten workstreams build the surfaces this table points at, and they land at
 * different times. So the table is not a list of imports — it is a list of
 * *declarations*, and each one resolves through {@link registerRoute} at
 * runtime. A build in which only the editor has shipped is a working build: the
 * other paths render an honest "not installed in this build" state instead of a
 * white screen or a module-not-found crash.
 *
 * The `boot` field is the load-bearing part. It is declared here, by the shell,
 * and never by the surface — see `boot.ts` for why that matters.
 */

export type RouteLoader = () => Promise<{ default: ComponentType }>

const registry = new Map<RouteId, RouteLoader>()

/**
 * Attach a surface to a route id.
 *
 * Returns a function that detaches it again, so a test can register a double
 * without leaking into the next test. Registering over an existing id is
 * allowed and replaces it: the integrator wires each surface exactly once, and a
 * silent duplicate is easier to diagnose as a replacement than as a throw
 * during module evaluation.
 */
export function registerRoute(id: RouteId, loader: RouteLoader): () => void {
  registry.set(id, loader)
  return () => {
    if (registry.get(id) === loader) registry.delete(id)
  }
}

export function isRouteRegistered(id: RouteId): boolean {
  return registry.has(id)
}

export function listRegisteredRoutes(): RouteId[] {
  return [...registry.keys()]
}

/** Drop every registration. Tests use this; runtime code does not. */
export function resetRouteRegistry(): void {
  registry.clear()
}

/**
 * Resolve a route to its surface, or to the honest placeholder.
 *
 * The placeholder is imported dynamically so an application in which every
 * surface is installed never downloads it.
 */
async function loadSurface(id: RouteId): Promise<{ default: ComponentType }> {
  const loader = registry.get(id)
  if (loader) return await loader()
  const states = await import('./states')
  return { default: states.createNotInstalledSurface(id) }
}

/**
 * Every top-level surface, with the stage it is allowed to boot to.
 *
 * `landing`, `account` and `gallery` are `none`: they are HTML and account
 * chrome, and downloading a compiled LEGO catalog to read them would be
 * indefensible. `explore`, `projects` and `share` are `catalog`, because each
 * one names real parts and the catalog is the only thing that can say whether a
 * part is real. `editor` is the only `editor` stage — it is the only surface
 * that mutates a document, so it is the only one that needs the kernel, the
 * session and warmed geometry.
 */
export const PLATFORM_ROUTES: readonly RouteModule[] = Object.freeze([
  { id: 'landing', path: '/', boot: 'none', load: () => loadSurface('landing') },
  { id: 'explore', path: '/explore', boot: 'catalog', load: () => loadSurface('explore') },
  { id: 'editor', path: '/editor', boot: 'editor', load: () => loadSurface('editor') },
  { id: 'projects', path: '/projects', boot: 'catalog', load: () => loadSurface('projects'), requiresAuth: true },
  { id: 'account', path: '/account', boot: 'none', load: () => loadSurface('account'), requiresAuth: true },
  { id: 'share', path: '/share/:slug', boot: 'catalog', load: () => loadSurface('share') },
  { id: 'gallery', path: '/gallery', boot: 'none', load: () => loadSurface('gallery') },
])

export function routeById(id: RouteId): RouteModule {
  const route = PLATFORM_ROUTES.find((entry) => entry.id === id)
  if (!route) throw new Error(`No route is declared for id "${id}".`)
  return route
}

/**
 * The routes that carry the persistent application frame.
 *
 * The editor is deliberately absent: it is a full-bleed cockpit whose own
 * chrome occupies the top of the viewport, and a second bar above it would both
 * steal vertical space and duplicate the project identity it already shows.
 */
export function routeHasAppFrame(id: RouteId): boolean {
  return id !== 'editor'
}

/** Human labels for the primary navigation, in the order they are shown. */
export const PRIMARY_NAV: readonly { id: RouteId; label: string }[] = Object.freeze([
  { id: 'editor', label: 'Editor' },
  { id: 'explore', label: 'Explore' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'projects', label: 'Projects' },
])
