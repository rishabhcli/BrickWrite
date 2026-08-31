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
 * The placeholder is reached through a dynamic import so that this module stays
 * free of React: the route table is imported by the shell, by tests and by the
 * import-graph assertion, and none of those should have to pull the component
 * tree and its stylesheet to read a list of paths. It buys no separate chunk —
 * `AppShell.tsx` imports `not-installed` statically, because it resolves an
 * unregistered route synchronously inside a `useMemo` and cannot await — and the
 * build says so with an INEFFECTIVE_DYNAMIC_IMPORT notice, which is accurate.
 * The dynamic form is kept regardless: it is what keeps React out of this
 * module's own import graph, which is the property `import-graph.test.ts`
 * asserts and the reason the route table can be read by tests for free.
 */
async function loadSurface(id: RouteId): Promise<{ default: ComponentType }> {
  const loader = registry.get(id)
  if (loader) return await loader()
  const fallback = await import('./not-installed')
  return { default: fallback.createNotInstalledSurface(id) }
}

/**
 * Every top-level surface, with the stage it is allowed to boot to.
 *
 * `landing`, `explore`, `account` and `gallery` are `none`: they draw immutable,
 * content-addressed demo metadata and envelope previews, and downloading a
 * compiled LEGO catalog to browse those cards would be indefensible. The demo
 * compiler already proved catalog membership before publishing the bytes.
 * `projects` and `share` are `catalog`; `editor` is the only `editor` stage — it is the only surface
 * that mutates a document, so it is the only one that needs the kernel, the
 * session and warmed geometry.
 *
 * `parts` is declared by no route *yet*, and that is a pending decision rather
 * than a spare rung. It is the compiled pack without `search.json` — 423 KiB
 * gzip and ~24 ms of main-thread parse and index-build less than `catalog` (see
 * the table in `boot.ts`) — and `editor` already boots through it. A route
 * belongs at `parts` when it only ever names parts it was handed: measured
 * against the current sources, everything `/share` reaches uses `catalog.get`,
 * `catalog.color` and `catalog.version` and nothing uses `catalog.search`,
 * `catalog.describe` or `catalog.categories`, which makes it the obvious first
 * candidate. Moving it is the share workstream's call to confirm, not a
 * unilateral saving, because getting it wrong means an empty result set that
 * reads as "no such part".
 */
export const PLATFORM_ROUTES: readonly RouteModule[] = Object.freeze([
  { id: 'landing', path: '/', boot: 'none', load: () => loadSurface('landing') },
  { id: 'explore', path: '/explore', boot: 'none', load: () => loadSurface('explore') },
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
