import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { BrowserRouter, Link, Route, Routes, useNavigate } from 'react-router-dom'
import { setLandingNavigator } from '../features/landing/navigation'
import { startSiteTools } from '../webmcp/site'
import type { RouteModule } from './contracts'
import { BootCancelledError, bootForRoute, bootPhaseMs, bootTo, resetBoot, type BootStage } from './boot'
import { BootStageProvider } from './boot-context'
import { PLATFORM_ROUTES, isRouteRegistered, registerRoute, routeById, routeHasAppFrame } from './routes'
import { trackPlatformEvent, usePlatformAnalytics } from './analytics'
import { BootFailureState, LoadingState, ShellErrorState, StatePanel } from './states'
import { createNotInstalledSurface } from './not-installed'
import { FramedLayout } from './AppFrame'
import { AccountAvailabilityProvider } from './auth/account'
import './platform.css'

/**
 * The application shell.
 *
 * This is the generalisation of what `main.tsx` used to do inline. The old boot
 * was correct but universal: it fetched the compiled catalog, started the
 * session and warmed geometry before anything at all could paint, because the
 * only thing that could paint was the editor. Now that a landing page, a
 * gallery and an account page live in the same bundle, the same sequence would
 * mean downloading a LEGO catalog to read marketing copy.
 *
 * So the sequence is kept exactly, and gated on the route's declared stage.
 * Everything else that `main.tsx` established stays: Hexclave sits outside the
 * catalog boot so its suspending hooks have a boundary to land in from
 * anywhere, `HexclaveTheme` still only emits a `.stack-scope`d stylesheet, and
 * an unconfigured account layer degrades to local-only rather than taking the
 * CAD editor down with it.
 */

/* --- Built-in surfaces --------------------------------------------------- */

/**
 * The account page is the platform's own surface, so the platform installs it.
 *
 * Registered rather than imported statically for the same reason as every other
 * surface: `/account` declares `boot: 'none'`, and its Hexclave settings tree
 * has no business being in the landing page's chunk.
 */
export function installPlatformSurfaces(): void {
  registerRoute('account', () => import('./auth/AccountPage'))
}

installPlatformSurfaces()

const AuthRoutes = lazy(() => import('./auth/AuthRoutes').then((mod) => ({ default: mod.AuthRoutes })))
const RouteAuthGuard = lazy(() => import('./auth/guards').then((mod) => ({ default: mod.RouteAuthGuard })))

/* --- Error boundary ------------------------------------------------------ */

interface ErrorBoundaryProps {
  children: ReactNode
  onRecover: () => void
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * The last line before a white screen.
 *
 * Both recovery actions do something real: resetting drops the cached boot
 * stages and remounts the subtree, which genuinely clears a failed catalog
 * fetch or a surface that threw on first render; reloading is the escape hatch
 * for a corrupted module graph, which a remount cannot fix.
 */
class PlatformErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // Kept as an error, not swallowed: this is the one place where a console
    // error is the correct output, because the surface really did fail.
    console.error('Brickwright surface failed', error, info.componentStack)
  }

  private recover = () => {
    resetBoot()
    this.setState({ error: null })
    this.props.onRecover()
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <ShellErrorState
        message={error.stack ?? error.message}
        onRecover={this.recover}
        onReload={() => window.location.reload()}
      />
    )
  }
}

/* --- Account layer ------------------------------------------------------- */

/**
 * Mount Hexclave after first paint.
 *
 * A static import of the provider puts ~480 KB gzip on `/`. `import()` inside
 * an effect is not in the landing modulepreload set; until it resolves the
 * tree renders with `pending` availability so AccountMenu shows "Checking…"
 * rather than flashing "Local only".
 */
function AccountGate({ children }: { children: ReactNode }) {
  const [Layer, setLayer] = useState<ComponentType<{ children: ReactNode }> | null>(null)

  useEffect(() => {
    let cancelled = false
    void import('./auth/HexclaveLayer').then((mod) => {
      if (!cancelled) setLayer(() => mod.HexclaveLayer)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!Layer) {
    return <AccountAvailabilityProvider availability={{ status: 'pending' }}>{children}</AccountAvailabilityProvider>
  }
  return <Layer>{children}</Layer>
}

/* --- Route host ---------------------------------------------------------- */

type HostState = { kind: 'booting' } | { kind: 'ready'; stage: BootStage } | { kind: 'failed'; message: string }

function bootHeadline(route: RouteModule): { headline: string; detail?: string } {
  if (route.boot === 'parts') {
    return {
      headline: 'Loading the compiled parts',
      detail: 'LDraw geometry, LDCad connection metadata and the LDraw colour table.',
    }
  }
  if (route.boot === 'catalog') {
    return {
      headline: 'Loading the compiled catalog',
      detail: 'LDraw identities, LDCad connection metadata and the LDraw colour table.',
    }
  }
  return {
    headline: 'Compiling catalog into the CAD kernel',
    detail:
      'Loading LDraw identities, LDCad connection metadata and the LDraw colour table, then restoring your project.',
  }
}

/**
 * Start the surface's chunk download alongside the boot, not after it.
 *
 * `lazy()` calls its factory when the lazy component first *renders*, and the
 * surface only renders once the boot gate resolves. That put the whole editor
 * bundle — the workbench, Three.js, the renderer — behind the catalog fetch,
 * the session restore and the geometry warm rather than beside them, even
 * though the two are independent and both network-bound. Handing `lazy` a
 * promise that is already in flight collapses that waterfall.
 *
 * The gate is the `parts` stage rather than nothing, and that is load-bearing:
 * `src/cad/engine.ts` builds the showcase document at module scope, which
 * throws unless the compiled pack is installed, so a surface that imports the
 * kernel cannot be *evaluated* before the parts tier is resident. `boot: 'none'`
 * surfaces are forbidden the kernel by their own declaration, so they start at
 * once.
 */
function prefetchSurface(route: RouteModule): () => Promise<{ default: ComponentType }> {
  const kernelSafe = route.boot === 'none' ? Promise.resolve() : bootTo('parts').then(() => undefined)
  const pending = kernelSafe.then(() => route.load())
  // Observed so a surface that fails to arrive while the gate is still showing
  // its own spinner cannot raise an unhandled rejection. `lazy` is handed the
  // same promise and still sees the rejection, so the error boundary is
  // reached exactly as before.
  void pending.catch(() => undefined)
  return () => pending
}

/**
 * One mounted surface: boot gate, auth gate, then the surface itself.
 *
 * The boot level comes from `route.boot` and nowhere else — the surface is
 * never consulted, which is what keeps a marketing route from quietly acquiring
 * the renderer.
 */
export function RouteHost({ route }: { route: RouteModule }) {
  const [state, setState] = useState<HostState>(() =>
    route.boot === 'none' ? { kind: 'ready', stage: { level: 'none' } } : { kind: 'booting' },
  )
  const [attempt, setAttempt] = useState(0)
  const { track } = usePlatformAnalytics()

  useEffect(() => {
    track({ name: 'route.viewed', route: route.id, boot: route.boot })
    if (!isRouteRegistered(route.id)) track({ name: 'route.not_installed', route: route.id })
  }, [route.boot, route.id, track])

  useEffect(() => {
    document.title = ROUTE_TITLES[route.id] ?? 'Brickwright'
    if (route.id === 'editor') {
      announcedRouteId = route.id
      return
    }
    const moved = announcedRouteId !== null && announcedRouteId !== route.id
    announcedRouteId = route.id
    if (moved) document.getElementById('pf-main')?.focus()
  }, [route.id])

  useEffect(() => {
    if (route.boot === 'none') {
      setState({ kind: 'ready', stage: { level: 'none' } })
      return
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    setState({ kind: 'booting' })
    bootForRoute(route, { signal: controller.signal }).then(
      (stage) => {
        // The phase breakdown, not just the total. A boot that spends 40 ms in
        // the catalog and 900 ms restoring a project is a completely different
        // problem from the reverse, and one number cannot tell them apart.
        track({
          name: 'boot.completed',
          boot: route.boot,
          elapsedMs: Date.now() - startedAt,
          catalogMs: Math.round(bootPhaseMs('catalog.parts')),
          kernelMs: Math.round(bootPhaseMs('kernel.module')),
          sessionMs: Math.round(bootPhaseMs('session.restore') + bootPhaseMs('session.query')),
          geometryMs: Math.round(bootPhaseMs('geometry.preload')),
        })
        setState({ kind: 'ready', stage })
      },
      (cause: unknown) => {
        // An abandoned wait is not a failure to report: the operator navigated
        // away, and the shared boot is still running for whoever asks next.
        if (cause instanceof BootCancelledError) return
        track({ name: 'boot.failed', boot: route.boot, failure: route.boot === 'editor' ? 'kernel' : 'catalog' })
        setState({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
      },
    )
    return () => controller.abort()
  }, [attempt, route, track])

  // A new lazy component per attempt, because React caches a rejected lazy
  // forever and "try again" has to mean it.
  const Surface = useMemo<ComponentType>(() => {
    if (!isRouteRegistered(route.id)) return createNotInstalledSurface(route.id)
    return lazy(prefetchSurface(route))
  }, [attempt, route])

  if (state.kind === 'booting') {
    const { headline, detail } = bootHeadline(route)
    return <LoadingState headline={headline} detail={detail} />
  }

  if (state.kind === 'failed') {
    return (
      <BootFailureState
        level={route.boot === 'editor' ? 'editor' : 'catalog'}
        message={state.message}
        onRetry={() => {
          resetBoot()
          setAttempt((value) => value + 1)
        }}
      />
    )
  }

  const surface = (
    <Suspense fallback={<LoadingState headline="Loading this surface" />}>
      <Surface />
    </Suspense>
  )

  return (
    <BootStageProvider stage={state.stage}>
      {route.requiresAuth ? (
        <Suspense fallback={<LoadingState headline="Checking your account" />}>
          <RouteAuthGuard route={route.id}>{surface}</RouteAuthGuard>
        </Suspense>
      ) : (
        surface
      )}
    </BootStageProvider>
  )
}

/* --- Routing ------------------------------------------------------------- */

function UnknownRoute() {
  return (
    <StatePanel
      tone="notice"
      eyebrow="NO SUCH PAGE"
      heading="Brickwright has no page at this address"
      actions={
        <Link className="pf-button pf-button--primary" to={routeById('landing').path}>
          Back to the start
        </Link>
      }
    >
      <p>The address does not match any surface this build knows about.</p>
    </StatePanel>
  )
}

const EDITOR_ROUTE = routeById('editor')

const ROUTE_TITLES: Record<string, string> = {
  landing: 'Brickwright',
  explore: 'Explore / Brickwright',
  editor: 'Editor / Brickwright',
  projects: 'Projects / Brickwright',
  account: 'Account / Brickwright',
  share: 'Share / Brickwright',
  gallery: 'Gallery / Brickwright',
}

/** Last route whose title was announced. Skips focus on first paint and on AccountGate remounts. */
let announcedRouteId: string | null = null

export function resetRouteAnnouncement(): void {
  announcedRouteId = null
}

/**
 * Two layout groups, deliberately.
 *
 * Everything except the editor shares one mounted frame, so navigating between
 * the gallery and explore does not tear down and rebuild the navigation. The
 * editor sits outside it entirely and keeps the full viewport.
 */
export function ShellRoutes() {
  return (
    <Routes>
      <Route element={<FramedLayout />}>
        {PLATFORM_ROUTES.filter((route) => routeHasAppFrame(route.id)).map((route) => (
          <Route key={route.id} path={route.path} element={<RouteHost route={route} />} />
        ))}
        <Route
          path="/auth/*"
          element={
            <Suspense fallback={<LoadingState headline="Loading sign-in" />}>
              <AuthRoutes />
            </Suspense>
          }
        />
        <Route path="*" element={<UnknownRoute />} />
      </Route>
      <Route path={EDITOR_ROUTE.path} element={<RouteHost route={EDITOR_ROUTE} />} />
    </Routes>
  )
}

/** The shell without its router, so a host can supply its own. */
export function PlatformShell() {
  const [generation, setGeneration] = useState(0)
  const recover = useCallback(() => {
    // Emitted here rather than in the boundary because the boundary is a class
    // and the event vocabulary is the only telemetry path the shell has.
    trackPlatformEvent({ name: 'shell.recovered_from_error', route: 'landing' })
    setGeneration((value) => value + 1)
  }, [])

  return (
    <PlatformErrorBoundary key={generation} onRecover={recover}>
      <LandingNavigationBridge />
      <SiteToolHost />
      <AccountGate>
        <Suspense fallback={<LoadingState headline="Starting Brickwright" />}>
          <ShellRoutes />
        </Suspense>
      </AccountGate>
    </PlatformErrorBoundary>
  )
}

/**
 * Landing and Explore predate the platform router and expose a tiny navigation
 * seam so they can also render in isolation. The shell must install that seam:
 * without it, every marketing CTA falls back to `location.assign`, turning a
 * working SPA route into a brittle full-page reload on static hosts.
 */
function LandingNavigationBridge() {
  const routerNavigate = useNavigate()
  useEffect(
    () =>
      setLandingNavigator((_target, href, options) => {
        routerNavigate(href, { replace: options?.replace })
        return true
      }),
    [routerNavigate],
  )
  return null
}

/**
 * The WebMCP site surface, registered for every route.
 *
 * It lives here rather than in `main.tsx` for one reason: `brickwright_navigate`
 * has to reach the shell's *router*, and the only thing that owns a client-side
 * transition is the bridge above. Registering earlier would mean the first
 * navigation an agent made was a document load, which would immediately
 * unregister every tool it had just discovered.
 *
 * `useEffect` rather than module scope so the registration is torn down with
 * the tree, and so StrictMode's double mount aborts the first generation
 * instead of leaving two hosts answering the same tool name.
 */
function SiteToolHost() {
  useEffect(() => startSiteTools(), [])
  return null
}

/**
 * The application root.
 *
 * `main.tsx` renders exactly this inside `StrictMode`, and nothing else.
 */
export function AppShell() {
  return (
    <BrowserRouter useTransitions={false}>
      <PlatformShell />
    </BrowserRouter>
  )
}

export default AppShell
