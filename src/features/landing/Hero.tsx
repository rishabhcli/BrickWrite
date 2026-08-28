import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { DemoEntry, DemoPreview } from '../../demos'
import { loadPreview } from '../../demos'
import { useOnScreen, useReducedMotion } from '../explore/motion'
import { trackLanding } from './analytics'

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
}

export function Hero({ demo }: HeroProps) {
  const reduced = useReducedMotion()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const visible = useOnScreen(stageRef, '120px')
  const [stage, setStage] = useState<HeroStage>('brief')
  const [wave, setWave] = useState(0)
  const [previews, setPreviews] = useState<{ rough: DemoPreview; published: DemoPreview } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [camera, setCamera] = useState(demo.camera)
  const [auto, setAuto] = useState(true)

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

  // The stage machine. It advances on a timer only when motion is welcome and
  // the visitor has not taken over; every stage is reachable from the track
  // below either way, so the story is never locked behind an animation.
  useEffect(() => {
    if (reduced || !auto || !visible || !previews) return
    const timer = window.setTimeout(() => {
      setStage((current) => STAGES[(STAGES.indexOf(current) + 1) % STAGES.length])
    }, DWELL[stage])
    return () => window.clearTimeout(timer)
  }, [reduced, auto, visible, previews, stage])

  // The refinement sweep. Reduced motion gets a fixed mid-sweep frame, which
  // still shows both states at once — resolved behind it, candidate ahead.
  useEffect(() => {
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
  }, [stage, reduced])

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
  const dotClass = stage === 'validated' ? 'dot done' : stage === 'refinement' ? 'dot settling' : 'dot'

  const takeOver = () => {
    if (auto) setAuto(false)
  }

  return (
    <div className="bw-hero-stage">
      <div className="bw-stage bw-corners" ref={stageRef} onPointerDown={takeOver}>
        <i /><i /><i /><i />
        {activePreview ? (
          <Suspense fallback={null}>
            <EnvelopeView
              preview={activePreview}
              camera={camera}
              onCameraChange={(next) => { takeOver(); setCamera(next) }}
              wave={stageWave}
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
            onClick={() => { setAuto(false); setStage(entry) }}
          >
            <b>{String(index + 1).padStart(2, '0')} {copy[entry].label}</b>
            <span>{copy[entry].detail}</span>
          </button>
        ))}
      </div>

      {demo.brief ? (
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

export default Hero
