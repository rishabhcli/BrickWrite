import { useEffect, useState } from 'react'

/**
 * Navigation for the landing and explore surfaces.
 *
 * The shell owns pathnames — `/`, `/explore`, `/editor` are its routes — so
 * these surfaces address each other by *path* and keep their own state in the
 * query string. That is what makes `/explore?demo=heron-sculpture&step=4` a
 * real deep link: the shell's router matches `/explore` and the surface reads
 * the rest itself, so neither has to know about the other's vocabulary.
 *
 * Three navigation modes, in order of preference:
 *
 *   1. a navigator the shell registered — a soft, client-side transition;
 *   2. `history.pushState` when only the query changes, because the surface
 *      that is already mounted is the one that renders the result;
 *   3. a real document navigation, which is always correct and is what an
 *      unregistered build gets rather than a link that silently does nothing.
 */

export type LandingTarget =
  | { kind: 'landing' }
  | { kind: 'explore'; demoId?: string; step?: number }
  | { kind: 'editor' }
  | { kind: 'editor-project'; projectId: string }
  | { kind: 'describe' }
  | { kind: 'gallery' }

export type LandingNavigator = (target: LandingTarget, href: string) => boolean

/** Fired after an in-place query change, since `pushState` fires nothing. */
export const NAVIGATION_EVENT = 'brickwright:navigation'

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
      if (!target.demoId) return '/explore'
      const query = new URLSearchParams({ demo: target.demoId })
      if (target.step !== undefined) query.set('step', String(target.step))
      return `/explore?${query.toString()}`
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

  const next = new URL(href, window.location.origin)
  if (next.pathname !== window.location.pathname) {
    // A different surface. Without a registered navigator the honest thing is a
    // real navigation: the shell's router is not listening to `pushState`, and
    // a link that changes the address bar and nothing else is a broken link.
    window.location.assign(next.toString())
    return
  }
  const url = `${next.pathname}${next.search}${window.location.hash}`
  if (options.replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  window.dispatchEvent(new CustomEvent(NAVIGATION_EVENT))
}

export interface LandingRoute {
  surface: 'landing' | 'explore'
  demoId: string | null
  step: number | null
}

/**
 * Reads a route out of a location.
 *
 * Accepts the fragment form too (`#/explore/<id>?step=N`), because a hash link
 * is what survives a static host with no SPA rewrite and somebody will paste
 * one. It is read, never written.
 */
export function parseRoute(pathname: string, search = '', hash = ''): LandingRoute {
  const fragment = hash.replace(/^#\/?/, '')
  if (fragment) {
    const [fragmentPath, fragmentQuery] = fragment.split('?')
    const segments = fragmentPath.split('/').filter(Boolean)
    if (segments[0] === 'explore') {
      return {
        surface: 'explore',
        demoId: segments[1] ? decodeURIComponent(segments[1]) : null,
        step: readStep(new URLSearchParams(fragmentQuery ?? '')),
      }
    }
  }

  const query = new URLSearchParams(search)
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'explore') return { surface: 'landing', demoId: null, step: null }
  return {
    surface: 'explore',
    demoId: query.get('demo') ?? (segments[1] ? decodeURIComponent(segments[1]) : null),
    step: readStep(query),
  }
}

function readStep(query: URLSearchParams): number | null {
  const raw = query.get('step')
  if (raw === null) return null
  const step = Number.parseInt(raw, 10)
  return Number.isFinite(step) ? step : null
}

/**
 * The current route, kept in step with the back and forward buttons.
 *
 * `popstate` covers history moves, `hashchange` covers a pasted fragment and
 * the in-place event covers a query change this module made. A deep link that
 * survives only one of the three is a broken back button.
 */
export function useLandingRoute(): LandingRoute {
  const [route, setRoute] = useState<LandingRoute>(() =>
    typeof window === 'undefined'
      ? { surface: 'landing', demoId: null, step: null }
      : parseRoute(window.location.pathname, window.location.search, window.location.hash),
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setRoute(parseRoute(window.location.pathname, window.location.search, window.location.hash))
    update()
    window.addEventListener('popstate', update)
    window.addEventListener('hashchange', update)
    window.addEventListener(NAVIGATION_EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener('hashchange', update)
      window.removeEventListener(NAVIGATION_EVENT, update)
    }
  }, [])

  return route
}
