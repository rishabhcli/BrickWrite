import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { DemoEntry, DemoPreview } from '../../demos'
import { loadPreview } from '../../demos'
import { useOnScreen, useReducedMotion } from '../explore/motion'
import { trackLanding } from './analytics'
import { StageHud } from './plate'

const EnvelopeView = lazy(() => import('../explore/EnvelopeView'))

/**
 * The hero.
 *
 * It replays a real piece of work: the brief a person wrote, the candidate the
 * generators produced from it, the refinement pass, and the model the kernel
 * finally accepted. All four stages are the *same two documents* —
 * `<demo>/rough.json` and `<demo>/document.json` — drawn from their published
 * envelope previews, and every number beside them comes from the validation run
 * that gated them. There is no scripted transcript and no recorded video: turn
 * off JavaScript timers and the same numbers are still on screen.
 *
 * Nothing here is loaded until the stage is on screen, because the landing
 * route is not allowed to fetch anything heavy before it paints.
 */

export type HeroStage = 'brief' | 'candidate' | 'refinement' | 'validated'

const STAGES: readonly HeroStage[] = ['brief', 'candidate', 'refinement', 'validated']

/** How long each stage holds before the next one, in milliseconds. */
const DWELL: Record<HeroStage, number> = { brief: 2600, candidate: 2800, refinement: 2600, validated: 6200 }

interface StageCopy {
  label: string
  detail: string
}

export interface HeroProps {
  demo: DemoEntry
  /** When set, the parent owns the stage — used by the landing film. */
  stage?: HeroStage
  onStageChange?: (stage: HeroStage) => void
  /** Timer-driven playback. Scroll storytelling turns this off once the visitor moves. */
  autoPlay?: boolean
  /** Hide the brief quote; the landing film already tells that story in type. */
  hideBrief?: boolean
  /**
   * 0–1 position through the landing film. When set, scroll owns the camera,
   * the explode, and the refinement sweep instead of the dwell timer.
   */
  scrub?: number
}

export function Hero({ demo, stage: stageProp, onStageChange, autoPlay = true, hideBrief = false, scrub }: HeroProps) {
  const reduced = useReducedMotion()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const visible = useOnScreen(stageRef, '120px')
  const [internalStage, setInternalStage] = useState<HeroStage>('brief')
  const stage = stageProp ?? internalStage
  const [wave, setWave] = useState(0)
  const [previews, setPreviews] = useState<{ rough: DemoPreview; published: DemoPreview } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [camera, setCamera] = useState(demo.camera)
  const [auto, setAuto] = useState(autoPlay)
  const [orbitLocked, setOrbitLocked] = useState(false)

  // Preview geometry is fetched only once the stage is on screen. Two files,
  // together a few tens of kilobytes; the compiled catalog is never touched.
  useEffect(() => {
    if (!visible || previews) return
    const controller = new AbortController()
    Promise.all([
      loadPreview(demo, 'rough', controller.signal),
      loadPreview(demo, 'published', controller.signal),
    ])
      .then(([rough, published]) => setPreviews({ rough, published }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setLoadError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [visible, previews, demo])

  const commitStage = (next: HeroStage | ((current: HeroStage) => HeroStage)) => {
    const resolved = typeof next === 'function' ? next(stage) : next
    if (stageProp === undefined) setInternalStage(resolved)
    onStageChange?.(resolved)
  }

  // The stage machine. It advances on a timer only when motion is welcome and
  // the visitor has not taken over; every stage is reachable from the track
  // below either way, so the story is never locked behind an animation.
  useEffect(() => {
    if (reduced || !auto || !autoPlay || !visible || !previews) return
    const timer = window.setTimeout(() => {
      commitStage((current) => STAGES[(STAGES.indexOf(current) + 1) % STAGES.length])
    }, DWELL[stage])
    return () => window.clearTimeout(timer)
  }, [reduced, auto, autoPlay, visible, previews, stage])

  // The refinement sweep. Scroll owns it on the landing film; elsewhere a
  // timer still plays it once per visit. Reduced motion gets a fixed mid-sweep.
  useEffect(() => {
    if (typeof scrub === 'number' && !reduced) {
      setWave(waveFromScrub(scrub))
      return
    }
    if (stage !== 'refinement') {
      setWave(stage === 'brief' ? 0 : 1)
      return
    }
    if (reduced) {
      setWave(0.55)
      return
    }
    let frame = 0
    const started = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 2200)
      setWave(progress)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [stage, reduced, scrub])

  useEffect(() => {
    trackLanding({ name: 'landing.hero_stage_advanced', stage })
  }, [stage])

  const copy = useMemo<Record<HeroStage, StageCopy>>(() => {
    const rough = demo.roughValidation
    const good = demo.validation
    return {
      brief: {
        label: 'Brief',
        detail: `${rough.partCount} parts proposed inside ${good.footprintStuds[0]} × ${good.footprintStuds[1]} studs.`,
      },
      candidate: {
        label: 'Candidate',
        detail:
          rough.componentCount > 1
            ? `${rough.componentCount} disconnected pieces, ${rough.disconnectedPartCount} parts off the main body.`
            : `${rough.statics.unsupportedParts} parts the load path never reaches.`,
      },
      refinement: {
        label: 'Refinement',
        detail: `${demo.delta.partsAdded > 0 ? `+${demo.delta.partsAdded} parts, ` : ''}${demo.delta.connectionsAdded > 0 ? `+${demo.delta.connectionsAdded} mated connectors` : 'reseated'}.`,
      },
      validated: {
        label: 'Validated',
        detail: `${good.collisionCount} collisions, ${good.componentCount} connected component, stable with ${good.statics.tippingMarginLdu} LDU of margin.`,
      },
    }
  }, [demo])

  const activePreview = previews ? (stage === 'brief' || stage === 'candidate' ? previews.rough : previews.published) : null
  const stageWave = stage === 'validated' ? undefined : wave
  const explode = reduced || typeof scrub !== 'number' ? 0 : explodeFromScrub(scrub)
  const displayCamera = orbitLocked || reduced || typeof scrub !== 'number'
    ? camera
    : {
        yaw: demo.camera.yaw + scrub * 52,
        pitch: demo.camera.pitch + Math.sin(scrub * Math.PI) * 10,
        zoom: demo.camera.zoom * (1 - scrub * 0.08),
      }
  const telemetry = stage === 'brief' || stage === 'candidate' ? demo.roughValidation : demo.validation
  const dotClass = stage === 'validated' ? 'dot done' : stage === 'refinement' ? 'dot settling' : 'dot'

  const takeOver = () => {
    if (auto) setAuto(false)
    if (!orbitLocked) setOrbitLocked(true)
  }

  return (
    <div className="bw-hero-stage">
      <div className="bw-stage bw-corners" ref={stageRef} onPointerDown={takeOver}>
        <i /><i /><i /><i />
        <StageHud
          yaw={displayCamera.yaw}
          pitch={displayCamera.pitch}
          zoom={displayCamera.zoom}
          explode={explode}
          parts={telemetry.partCount}
          mates={telemetry.connectionCount}
          bodies={telemetry.componentCount}
        />
        {activePreview ? (
          <Suspense fallback={null}>
            <EnvelopeView
              preview={activePreview}
              camera={displayCamera}
              onCameraChange={(next) => { takeOver(); setCamera(next) }}
              wave={stageWave}
              explode={explode}
              label={describeStage(demo, stage)}
            />
          </Suspense>
        ) : null}
        {loadError ? (
          <p className="bw-note" style={{ position: 'absolute', inset: 'auto 16px 16px', color: 'var(--bw-orange)' }} role="status">
            The demo preview could not be loaded: {loadError}
          </p>
        ) : null}
      </div>

      <p className="bw-stage-caption">
        <span className={dotClass} aria-hidden="true" />
        <span>{demo.title} · {copy[stage].label}</span>
        <span className="spacer" />
        <span className="bw-stage-hint">Drag to orbit</span>
        {typeof scrub === 'number' ? <span className="bw-stage-keys" aria-hidden="true">1–4</span> : null}
        <span>Envelope view · catalog {demo.catalogVersion}</span>
      </p>

      <div className="bw-stage-track" role="tablist" aria-label="Hero stages">
        {STAGES.map((entry, index) => (
          <button
            key={entry}
            type="button"
            role="tab"
            className="bw-stage-step"
            aria-current={entry === stage ? 'true' : undefined}
            aria-selected={entry === stage}
            data-done={STAGES.indexOf(stage) > index ? 'true' : 'false'}
            onClick={() => { setAuto(false); commitStage(entry) }}
          >
            <b>{String(index + 1).padStart(2, '0')} {copy[entry].label}</b>
            <span>{copy[entry].detail}</span>
          </button>
        ))}
      </div>

      {demo.brief && !hideBrief ? (
        <div className="bw-brief">
          <span className="bw-eyebrow">The brief this build answers</span>
          <blockquote>{demo.brief.prompt}</blockquote>
          <div className="bw-brief-fields">
            {demo.brief.envelopeStuds[0] && demo.brief.envelopeStuds[2] ? (
              <span className="bw-brief-field">Envelope <b>{demo.brief.envelopeStuds[0]} × {demo.brief.envelopeStuds[2]} studs</b></span>
            ) : null}
            {demo.brief.functions.map((entry) => (
              <span className="bw-brief-field" key={entry}>Requires <b>{entry}</b></span>
            ))}
            {demo.brief.palette.map((entry) => (
              <span className="bw-brief-field" key={entry}>Palette <b>{entry}</b></span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The accessible description of what the canvas is showing right now. */
function describeStage(demo: DemoEntry, stage: HeroStage): string {
  const good = demo.validation
  const rough = demo.roughValidation
  if (stage === 'brief') {
    return `${demo.title}: the first candidate drawn as ${rough.partCount} unresolved part outlines.`
  }
  if (stage === 'candidate') {
    return `${demo.title}: the first candidate, ${rough.partCount} parts in ${rough.componentCount} disconnected pieces.`
  }
  if (stage === 'refinement') {
    return `${demo.title}: the refinement pass resolving candidate parts into validated geometry.`
  }
  return `${demo.title}: the published model, ${good.partCount} parts, ${good.connectionCount} mated connectors, ${good.steps} build steps.`
}

/** Refinement sweep occupies the third quarter of the film. */
function waveFromScrub(t: number) {
  if (t <= 0.5) return 0
  if (t >= 0.78) return 1
  return (t - 0.5) / 0.28
}

/** Candidate band pulls the assemblies apart, then seats them again. */
function explodeFromScrub(t: number) {
  if (t <= 0.2 || t >= 0.52) return 0
  return Math.sin(((t - 0.2) / 0.32) * Math.PI) * 0.45
}

export default Hero
