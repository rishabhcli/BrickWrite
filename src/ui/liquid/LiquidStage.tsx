import { domAnimation, LazyMotion } from 'motion/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import './tokens.css'
import {
  INCREASED_CONTRAST_QUERY,
  probeCapabilities,
  readPreferences,
  REDUCED_MOTION_QUERY,
  REDUCED_TRANSPARENCY_QUERY,
  type CapabilityReport,
  type PreferenceReport,
} from './capability'
import { SETTLE_DELAY_MS } from './motion'
import type { Box } from './rect'

export interface PointerPosition {
  readonly x: number
  readonly y: number
}

/**
 * What is actually behind the chrome, measured.
 *
 * `luminance` is the mean relative luminance of the rendered scene; `region` is
 * the box it occupies. A surface overlapping that box takes its tint from the
 * measurement, which is the difference between glass that responds to a white
 * baseplate filling the frame and glass that is a permanently grey rectangle.
 */
export interface BackdropReport {
  /** Where the sampled scene sits on screen. */
  readonly region: Box
  /** Row-major luminance cells covering `region`. */
  readonly cells: readonly number[]
  readonly columns: number
  readonly rows: number
}

export interface LiquidEnvironment {
  readonly capabilities: CapabilityReport
  readonly preferences: PreferenceReport
  readonly reducedMotion: boolean
  /** Index into the renderer's quality ladder; undefined where no renderer is mounted. */
  readonly qualityTierIndex?: number
  /** True while a continuous gesture is in flight. */
  readonly interacting: boolean
  /** The measured scene backdrop, where one has been reported. */
  readonly backdrop?: BackdropReport
}

export interface PerformanceReport {
  readonly qualityTierIndex?: number
  readonly interacting?: boolean
  readonly backdrop?: BackdropReport
}

interface RenderState {
  readonly qualityTierIndex: number | undefined
  readonly interacting: boolean
  readonly backdrop: BackdropReport | undefined
}

const FALLBACK_ENVIRONMENT: LiquidEnvironment = {
  capabilities: { backdropBlur: false, backdropUrlFilter: false },
  preferences: { reducedTransparency: false, reducedMotion: false, increasedContrast: false },
  reducedMotion: false,
  interacting: false,
}

/*
 * Two contexts, not one.
 *
 * Pointer position changes up to once a frame; everything else changes when a
 * media query flips or the renderer changes gear. Merging them would re-render
 * every blur and opaque surface in the app on every pointer move, to deliver a
 * value only the lensed ones read.
 */
const EnvironmentContext = createContext<LiquidEnvironment>(FALLBACK_ENVIRONMENT)
const PointerContext = createContext<PointerPosition>({ x: 0, y: 0 })
const ReportContext = createContext<(report: PerformanceReport) => void>(() => {})

export const useLiquidEnvironment = (): LiquidEnvironment => useContext(EnvironmentContext)
export const useLiquidPointer = (): PointerPosition => useContext(PointerContext)

/**
 * How the editor tells the chrome what the renderer is doing.
 *
 * Inverted deliberately: src/ui/liquid must not import from src/editor, or the
 * landing page starts downloading Three.js to draw a nav bar. The renderer
 * pushes; the chrome never pulls.
 */
export const useLiquidPerformance = (): ((report: PerformanceReport) => void) => useContext(ReportContext)

function restoreAttribute(element: HTMLElement, name: string, previous: string | null): void {
  if (previous === null) element.removeAttribute(name)
  else element.setAttribute(name, previous)
}

const isOverCanvas = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('canvas') !== null

export interface LiquidStageProps {
  children: ReactNode
}

/**
 * Owns every input the material tiers depend on, exactly once.
 *
 * It also keeps setting the document attributes GlassRoot used to set, so the
 * legacy stylesheet keeps behaving correctly on surfaces that have not migrated
 * yet. One provider serves both systems for the whole migration; there is never
 * a window where a surface has no material policy.
 */
export function LiquidStage({ children }: LiquidStageProps) {
  const [preferences, setPreferences] = useState<PreferenceReport>(() => readPreferences())
  const [capabilities, setCapabilities] = useState<CapabilityReport>(FALLBACK_ENVIRONMENT.capabilities)
  const [pointer, setPointer] = useState<PointerPosition>({ x: 0, y: 0 })
  const [renderState, setRenderState] = useState<RenderState>({
    qualityTierIndex: undefined,
    interacting: false,
    backdrop: undefined,
  })

  // Probed after mount so a server-rendered or test-rendered tree starts from
  // the honest "cannot paint it" answer rather than an optimistic one.
  useEffect(() => {
    setCapabilities(probeCapabilities())
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const queries = [REDUCED_TRANSPARENCY_QUERY, REDUCED_MOTION_QUERY, INCREASED_CONTRAST_QUERY].map((query) =>
      window.matchMedia(query),
    )
    const synchronize = () => setPreferences(readPreferences())
    for (const query of queries) query.addEventListener('change', synchronize)
    synchronize()
    return () => {
      for (const query of queries) query.removeEventListener('change', synchronize)
    }
  }, [])

  useEffect(() => {
    const html = document.documentElement
    const previousTheme = html.getAttribute('data-theme')
    const previousTransparency = html.getAttribute('data-reduced-transparency')
    html.setAttribute('data-theme', 'dark')
    html.setAttribute('data-reduced-transparency', String(preferences.reducedTransparency))
    return () => {
      restoreAttribute(html, 'data-theme', previousTheme)
      restoreAttribute(html, 'data-reduced-transparency', previousTransparency)
    }
  }, [preferences.reducedTransparency])

  /*
   * One pointer listener for the entire application.
   *
   * liquid-glass-react attaches its own per instance, driving two setState
   * calls per mousemove each. Supplying both pointer props short-circuits that
   * path entirely (see its index.esm.js:325), so this is the only listener.
   *
   * Two economies on top of that: updates are coalesced to one per frame, and
   * a pointer travelling across the WebGL canvas is ignored outright. Orbiting
   * a model is where pointer events are densest and where chrome refraction is
   * least worth paying for, so that case costs nothing at all.
   */
  const frameRef = useRef(0)
  const latestRef = useRef<PointerPosition>({ x: 0, y: 0 })
  const interacting = renderState.interacting

  useEffect(() => {
    if (interacting) return

    const flush = () => {
      frameRef.current = 0
      setPointer(latestRef.current)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (isOverCanvas(event.target)) return
      latestRef.current = { x: event.clientX, y: event.clientY }
      if (frameRef.current === 0) frameRef.current = requestAnimationFrame(flush)
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [interacting])

  /*
   * Settling.
   *
   * Clearing `interacting` the instant a gesture stops would let the tier
   * flicker in the gaps between pointer events during a slow drag. Promotion
   * therefore waits; demotion is immediate, because the frame that needs the
   * cheaper material is the one already in flight.
   */
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const report = useCallback((next: PerformanceReport) => {
    // A gesture starting is applied on the spot. A gesture ending is not:
    // `interacting` stays true until the settle timer fires, so the value here
    // is never lowered directly.
    setRenderState((current) => {
      const backdrop = next.backdrop ?? current.backdrop
      // A field where no cell moved by more than a couple of percent is not a
      // change anyone can see, and re-rendering every lensed surface for it
      // would make the sampler cost more than the effect it drives.
      const sameRegion =
        current.backdrop !== undefined &&
        backdrop !== undefined &&
        current.backdrop.region.width === backdrop.region.width &&
        current.backdrop.region.height === backdrop.region.height &&
        current.backdrop.region.left === backdrop.region.left &&
        current.backdrop.region.top === backdrop.region.top
      const settled =
        sameRegion &&
        current.backdrop!.cells.length === backdrop!.cells.length &&
        current.backdrop!.cells.every((cell, index) => Math.abs(cell - backdrop!.cells[index]) < 0.02)
      return {
        qualityTierIndex: next.qualityTierIndex ?? current.qualityTierIndex,
        interacting: next.interacting === true ? true : current.interacting,
        backdrop: settled ? current.backdrop : backdrop,
      }
    })

    if (next.interacting === true) {
      clearTimeout(settleRef.current)
      settleRef.current = undefined
      return
    }

    if (next.interacting === false) {
      clearTimeout(settleRef.current)
      settleRef.current = setTimeout(() => {
        settleRef.current = undefined
        setRenderState((current) => (current.interacting ? { ...current, interacting: false } : current))
      }, SETTLE_DELAY_MS)
    }
  }, [])

  useEffect(() => () => clearTimeout(settleRef.current), [])

  const environment = useMemo<LiquidEnvironment>(
    () => ({
      capabilities,
      preferences,
      reducedMotion: preferences.reducedMotion,
      qualityTierIndex: renderState.qualityTierIndex,
      interacting: renderState.interacting,
      backdrop: renderState.backdrop,
    }),
    [capabilities, preferences, renderState.qualityTierIndex, renderState.interacting, renderState.backdrop],
  )

  return (
    <EnvironmentContext.Provider value={environment}>
      <ReportContext.Provider value={report}>
        <PointerContext.Provider value={pointer}>
          {/*
            `strict` forbids the `motion.*` components and allows only `m.*`,
            which is what keeps the full animation runtime out of the bundle:
            domAnimation carries transforms and springs and leaves layout
            projection and 3D behind. index.html's head budget is policed at
            220 KB gzip by tools/check-dist-budget.mjs.
          */}
          <LazyMotion features={domAnimation} strict>
            {children}
          </LazyMotion>
        </PointerContext.Provider>
      </ReportContext.Provider>
    </EnvironmentContext.Provider>
  )
}
