import { useCallback, useEffect, useRef, useState } from 'react'
import type { DemoPreviewStep } from '../../demos/types'

/**
 * The build order, which is the hardest thing this product does.
 *
 * Every published demo carries a derived, re-verified sequence in which its
 * parts can physically be assembled — 103 courses for 9,563 parts on the hero
 * whale — and until now the landing page mentioned it once, as a number in a
 * topline. The geometry is already downloaded for the envelope view and
 * `EnvelopeView` already accepts `stepLimit`, so showing the model actually
 * being built costs no bytes at all; it only had to be wired.
 *
 * It plays itself once when the stage arrives and then hands over. That is a
 * deliberate difference from the rest of the page, which is scrolled: a build
 * order is a sequence with a direction, so it gets a transport, not a scrub
 * position. Nothing loops — the play settles on the finished model.
 */

/** How long one pass through the whole order takes. */
const PLAY_MS = 4200

export interface BuildOrder {
  /** 1-based; `total` means the finished model. */
  step: number
  total: number
  /** Cumulative parts placed by the end of `step`. */
  placed: number
  parts: number
  name: string
  /** True while the visitor is dragging or keying the track. */
  inspecting: boolean
  playing: boolean
  setStep: (next: number) => void
  setInspecting: (next: boolean) => void
  replay: () => void
}

export function useBuildOrder(steps: readonly DemoPreviewStep[] | undefined, ready: boolean, still: boolean): BuildOrder {
  const total = steps?.length ?? 0
  const [step, setStepState] = useState(0)
  const [inspecting, setInspecting] = useState(false)
  const [playing, setPlaying] = useState(false)
  const played = useRef(false)
  const frame = useRef(0)

  const stop = () => {
    if (frame.current) cancelAnimationFrame(frame.current)
    frame.current = 0
  }

  const play = useCallback(() => {
    if (!total) return
    stop()
    setPlaying(true)
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / PLAY_MS)
      // Eased so the plinth courses do not crawl and the last details land soft.
      const eased = 1 - (1 - t) ** 2.2
      setStepState(Math.max(1, Math.round(eased * total)))
      if (t < 1) {
        frame.current = requestAnimationFrame(tick)
        return
      }
      frame.current = 0
      setPlaying(false)
    }
    frame.current = requestAnimationFrame(tick)
  }, [total])

  // One pass, when the stage is on screen and the geometry has landed. With
  // motion refused the model is simply finished, which is also the settled
  // state the pass ends on — nothing is behind the animation.
  useEffect(() => {
    if (!total) return
    if (still) {
      stop()
      setPlaying(false)
      setStepState(total)
      return
    }
    if (!ready || played.current) return
    played.current = true
    play()
    return stop
  }, [ready, still, total, play])

  useEffect(() => stop, [])

  const setStep = useCallback(
    (next: number) => {
      stop()
      setPlaying(false)
      played.current = true
      setStepState(Math.min(total, Math.max(1, Math.round(next))))
    },
    [total],
  )

  const replay = useCallback(() => {
    played.current = true
    play()
  }, [play])

  let placed = 0
  let name = ''
  if (steps) {
    for (const entry of steps) {
      if (entry.index > step) break
      placed += entry.partCount
      name = entry.name
    }
  }
  const parts = steps?.reduce((sum, entry) => sum + entry.partCount, 0) ?? 0

  return { step, total, placed, parts, name, inspecting, playing, setStep, setInspecting, replay }
}

/**
 * A transport for the order: draggable, keyable, and readable as a slider.
 *
 * The 103 courses are drawn as one repeating gradient rather than 103 nodes —
 * a tick per course is the right picture and the wrong amount of DOM.
 */
export function BuildOrderTrack({ order }: { order: BuildOrder }) {
  const rail = useRef<HTMLDivElement | null>(null)
  const { step, total, placed, parts, name, playing } = order
  if (!total) return null

  const seek = (clientX: number) => {
    const box = rail.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    order.setStep(1 + ((clientX - box.left) / box.width) * (total - 1))
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const jump: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }
    if (event.key in jump) {
      event.preventDefault()
      order.setStep(step + jump[event.key])
      return
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      order.setStep(step + (event.key === 'PageUp' ? 10 : -10))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      order.setStep(event.key === 'Home' ? 1 : total)
    }
  }

  return (
    <div className="bw-build-order" data-playing={playing ? 'true' : 'false'}>
      <p className="bw-build-readout">
        <span className="bw-build-index">
          Step <strong>{step || 1}</strong> / {total}
        </span>
        <span className="bw-build-name">{name || 'Verified build order'}</span>
        <span className="bw-build-count">
          {placed.toLocaleString()} / {parts.toLocaleString()} parts
        </span>
      </p>
      <div
        className="bw-build-rail"
        ref={rail}
        role="slider"
        tabIndex={0}
        aria-label={`Build order for ${total} steps`}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={step || 1}
        aria-valuetext={`Step ${step || 1} of ${total}${name ? `, ${name}` : ''}`}
        style={
          {
            '--bw-build-t': total > 1 ? (step - 1) / (total - 1) : 1,
            '--bw-build-steps': total,
          } as React.CSSProperties
        }
        onKeyDown={onKeyDown}
        onFocus={() => order.setInspecting(true)}
        onBlur={() => order.setInspecting(false)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          order.setInspecting(true)
          seek(event.clientX)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event.clientX)
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          order.setInspecting(false)
        }}
      >
        <span className="bw-build-ticks" aria-hidden="true" />
        <span className="bw-build-fill" aria-hidden="true" />
        <span className="bw-build-head" aria-hidden="true" />
      </div>
      <button type="button" className="bw-build-replay" onClick={order.replay}>
        {step >= total ? 'Build it again' : 'Play the build'}
      </button>
    </div>
  )
}
