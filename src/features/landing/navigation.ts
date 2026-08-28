import { useEffect, useState } from 'react'

/**
 * Navigation for the landing and explore surfaces.
 *
 * Path routing, shared with the application shell. Earlier standalone builds
 * used fragments, which made an in-shell click change the address bar while
 * React Router continued rendering the old surface. Query parameters keep demo
 * selection on the declared `/explore` route, so refreshes and copied links are
 * ordinary application URLs.
 *
 * A shell that would rather route these itself can call
 * {@link setLandingNavigator}; every link on both surfaces goes through
 * {@link navigate}, so one registration takes over the whole thing.
 */

export type LandingTarget =
  | { kind: 'landing' }
  | { kind: 'explore'; demoId?: string; step?: number }
  | { kind: 'editor' }
  | { kind: 'editor-project'; projectId: string }
  | { kind: 'describe' }
  | { kind: 'gallery' }

export type LandingNavigator = (target: LandingTarget, href: string) => boolean

let navigator: LandingNavigator | null = null

/** Hand navigation to the shell. Returns a function that gives it back. */
export function setLandingNavigator(next: LandingNavigator | null): () => void {
  const previous = navigator
  navigator = next
  return () => {
    if (navigator === next) navigator = previous
  }
}

export function hrefFor(target: LandingTarget): string {
  switch (target.kind) {
    case 'landing':
      return '/'
    case 'explore': {
      const query = new URLSearchParams()
      if (target.demoId) query.set('demo', target.demoId)
      if (target.step !== undefined) query.set('step', String(target.step))
      const suffix = query.size ? `?${query.toString()}` : ''
      return `/explore${suffix}`
    }
    case 'editor':
      return '/editor'
    case 'editor-project':
      return `/editor?project=${encodeURIComponent(target.projectId)}`
    case 'describe':
      return '/editor?intent=describe'
    case 'gallery':
      return '/gallery'
  }
}

export function navigate(target: LandingTarget, options: { replace?: boolean } = {}): void {
  const href = hrefFor(target)
  if (navigator?.(target, href)) return
  if (typeof window === 'undefined') return

  const destination = new URL(href, window.location.href)
  if (destination.pathname !== window.location.pathname) {
    // A plain history mutation does not notify BrowserRouter. Without a shell
    // adapter, use a real navigation between surfaces; Vite and the production
    // SPA host both serve index.html for these declared paths. Same-surface
    // changes below stay client-side so scrubbing a demo does not reload it.
    if (options.replace) window.location.replace(href)
    else window.location.assign(href)
    return
  }
  if (options.replace) window.history.replaceState(null, '', href)
  else window.history.pushState(null, '', href)
  // `pushState` does not notify this module's route hook.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export interface LandingRoute {
  /** `''` for the landing page, `explore` for the explorer. */
  surface: 'landing' | 'explore'
  demoId: string | null
  step: number | null
}

/** Reads the current route, retaining legacy fragment deep links. */
export function parseRoute(hash: string, pathname = ''): LandingRoute {
  const raw = hash.replace(/^#\/?/, '')
  const source = raw || pathname.replace(/^\/+/, '')
  const [pathPart, queryPart] = source.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  const query = new URLSearchParams(queryPart ?? '')
  const stepParam = query.get('step')
  const step = stepParam === null ? null : Number.parseInt(stepParam, 10)
  if (segments[0] !== 'explore') return { surface: 'landing', demoId: null, step: null }
  return {
    surface: 'explore',
    demoId: query.get('demo') ?? (segments[1] ? decodeURIComponent(segments[1]) : null),
    step: Number.isFinite(step) ? step : null,
  }
}

/**
 * The current route, kept in step with the back and forward buttons.
 *
 * Both `popstate` and `hashchange` are listened for: the browser fires the
 * first for history moves and the second for fragment edits, and a deep link
 * that only survives one of them is a broken back button.
 */
export function useLandingRoute(): LandingRoute {
  const [route, setRoute] = useState<LandingRoute>(() =>
    typeof window === 'undefined'
      ? { surface: 'landing', demoId: null, step: null }
      : parseRoute(window.location.hash, `${window.location.pathname}${window.location.search}`),
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setRoute(parseRoute(window.location.hash, `${window.location.pathname}${window.location.search}`))
    update()
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])

  return route
}
