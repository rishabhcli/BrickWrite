import type { RouteId } from '../../platform/contracts'
import { LandingPage } from './LandingPage'

/**
 * Workstream 10 — landing. Published surface.
 *
 * The route is registered by the shell in `src/main.tsx`; see
 * `docs/integration/landing.md` for the exact lines. This module additionally
 * offers {@link registerLandingRoutes} for a host that builds its registry
 * somewhere else, and self-registers against a registrar published on
 * `globalThis` if one is there — feature detection rather than an import,
 * because a build in which the registry has not landed yet must still export
 * the components rather than fail to resolve.
 */

export { LandingPage, default as Landing } from './LandingPage'
export { Hero, type HeroProps, type HeroStage } from './Hero'
export {
  hrefFor,
  navigate,
  parseRoute,
  setLandingNavigator,
  useLandingRoute,
  NAVIGATION_EVENT,
  type LandingNavigator,
  type LandingRoute,
  type LandingTarget,
} from './navigation'
export {
  assertLandingVocabulary,
  landingAnalyticsStatus,
  LANDING_EVENT_NAMES,
  LandingAnalyticsVocabularyError,
  peekLandingAnalytics,
  resetLandingAnalytics,
  setKnownDemoIds,
  setLandingAnalyticsSink,
  trackLanding,
  type LandingAnalyticsEvent,
  type LandingAnalyticsSink,
  type LandingAnalyticsStatus,
  type RecordedLandingEvent,
} from './analytics'
export { useReveal, useFilmStage } from './reveal'

export type RouteRegistrar = (id: RouteId, loader: () => Promise<{ default: React.ComponentType }>) => (() => void) | void

/** The loaders the shell attaches to `landing` and `explore`. */
export const LANDING_ROUTE_LOADERS: ReadonlyArray<{ id: RouteId; load: () => Promise<{ default: React.ComponentType }> }> = [
  { id: 'landing', load: () => import('./LandingPage') },
  { id: 'explore', load: () => import('../explore/ExplorePage') },
]

/**
 * Attaches both surfaces to a route registry.
 *
 * Returns a function that detaches them again, so a test can register these
 * without leaking into the next one.
 */
export function registerLandingRoutes(register?: RouteRegistrar): () => void {
  const registrar = register ?? ambientRegistrar()
  if (!registrar) return () => undefined
  const undo = LANDING_ROUTE_LOADERS.map((route) => registrar(route.id, route.load))
  return () => {
    for (const detach of undo) detach?.()
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __brickwrightRegisterRoute: RouteRegistrar | undefined
}

/** A registrar the host published before this module evaluated, if any. */
function ambientRegistrar(): RouteRegistrar | null {
  return typeof globalThis.__brickwrightRegisterRoute === 'function' ? globalThis.__brickwrightRegisterRoute : null
}

// Self-registration, defensively. A host that wires routes in its entry module
// (which is what `src/main.tsx` does) never sets this up, and nothing happens.
registerLandingRoutes()

export default LandingPage
