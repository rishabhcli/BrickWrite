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
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { HexclaveProvider, HexclaveTheme } from '@hexclave/react'
import { getHexclaveClientApp } from '../hexclave/client'
import type { RouteModule } from './contracts'
import { BootCancelledError, bootForRoute, resetBoot, type BootStage } from './boot'
import { BootStageProvider } from './boot-context'
import { PLATFORM_ROUTES, isRouteRegistered, registerRoute, routeById, routeHasAppFrame } from './routes'
import { resolvePlatformConfig } from './config'
import { trackPlatformEvent, usePlatformAnalytics } from './analytics'
import { BootFailureState, LoadingState, ShellErrorState, StatePanel } from './states'
import { FramedLayout } from './AppFrame'
import { AccountAvailabilityProvider, type AccountAvailability } from './auth/account'
import { AuthRoutes } from './auth/AuthRoutes'
import { RouteAuthGuard } from './auth/guards'
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
 * Decide once whether there is an account layer, and say why when there is not.
 *
 * The Hexclave client app is constructed from an injected project ID. When that
 * ID is absent the constructor throws — a supported situation, not a bug — so
 * the shell renders unwrapped and every account control switches to its
 * local-only state.
 */
function accountAvailability(): AccountAvailability {
  const app = getHexclaveClientApp()
  if (app.status === 'ok') return { status: 'ready' }
  const config = resolvePlatformConfig()
  if (config.status === 'misconfigured') {
    return { status: 'unavailable', reason: config.reason, checked: config.checked }
  }
  return {
    status: 'unavailable',
    reason: `Hexclave could not be initialised in this environment: ${app.error.message}`,
    checked: [],
  }
}

function AccountLayer({ children }: { children: ReactNode }) {
  const app = getHexclaveClientApp()
  const availability = useMemo(accountAvailability, [])

  if (app.status === 'error') {
    return <AccountAvailabilityProvider availability={availability}>{children}</AccountAvailabilityProvider>
  }

  return (
    <AccountAvailabilityProvider availability={availability}>
      <HexclaveProvider app={app.data}>
        <HexclaveTheme>{children}</HexclaveTheme>
      </HexclaveProvider>
    </AccountAvailabilityProvider>
  )
}

/* --- Route host ---------------------------------------------------------- */

type HostState =
  | { kind: 'booting' }
  | { kind: 'ready'; stage: BootStage }
  | { kind: 'failed'; message: string }

function bootHeadline(route: RouteModule): { headline: string; detail?: string } {
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
    if (route.boot === 'none') {
      setState({ kind: 'ready', stage: { level: 'none' } })
      return
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    setState({ kind: 'booting' })
    bootForRoute(route, { signal: controller.signal }).then(
      (stage) => {
        track({ name: 'boot.completed', boot: route.boot, elapsedMs: Date.now() - startedAt })
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
  const Surface = useMemo<ComponentType>(() => lazy(() => route.load()), [attempt, route])

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
      {route.requiresAuth ? <RouteAuthGuard route={route.id}>{surface}</RouteAuthGuard> : surface}
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
        <Route path="/auth/*" element={<AuthRoutes />} />
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
      <AccountLayer>
        <Suspense fallback={<LoadingState headline="Starting Brickwright" />}>
          <ShellRoutes />
        </Suspense>
      </AccountLayer>
    </PlatformErrorBoundary>
  )
}

/**
 * The application root.
 *
 * `main.tsx` renders exactly this inside `StrictMode`, and nothing else.
 */
export function AppShell() {
  return (
    <BrowserRouter>
      <PlatformShell />
    </BrowserRouter>
  )
}

export default AppShell
