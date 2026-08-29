import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../explore/motion'

/**
 * Shared plate chrome: the clutch atmosphere, ticking CAD figures, and the
 * HUD that sits on an envelope stage. Landing, explore, gallery and projects
 * all stand on the same night plate — the cursor and the film stay landing-only.
 */

export function PlateAtmosphere() {
  return (
    <div className="bw-atmosphere" aria-hidden="true">
      <i className="bw-orb bw-orb-a" />
      <i className="bw-orb bw-orb-b" />
      <i className="bw-clutch" />
    </div>
  )
}

/**
 * Interpolates a integer when the value changes. Fine pointers only: jsdom
 * stubs matchMedia to false, so tests always see the real figure on first paint.
 */
export function CountUp({
  value,
  fromZero = false,
  play = true,
}: {
  value: number
  fromZero?: boolean
  play?: boolean
}) {
  const reduced = useReducedMotion()
  const previous = useRef(fromZero ? 0 : value)
  const [display, setDisplay] = useState(value)

  useEffect(() => {
    const fine = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    if (!play || reduced || !fine) {
      setDisplay(value)
      previous.current = fromZero && !play ? 0 : value
      return
    }
    const from = previous.current
    previous.current = value
    if (from === value) {
      setDisplay(value)
      return
    }
    const started = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 620)
      const eased = 1 - (1 - t) ** 3
      setDisplay(Math.round(from + (value - from) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, play, reduced, fromZero])

  return <>{display}</>
}

export function StageHud({
  yaw,
  pitch,
  zoom,
  explode,
  parts,
  mates,
  bodies,
}: {
  yaw: number
  pitch: number
  zoom: number
  explode: number
  parts: number
  mates: number
  bodies: number
}) {
  return (
    <>
      <span className="bw-reticle" aria-hidden="true" />
      <dl className="bw-stage-hud" aria-hidden="true">
        <div>
          <dt>Yaw</dt>
          <dd>{yaw.toFixed(1)}°</dd>
        </div>
        <div>
          <dt>Pitch</dt>
          <dd>{pitch.toFixed(1)}°</dd>
        </div>
        <div>
          <dt>Zoom</dt>
          <dd>{zoom.toFixed(2)}</dd>
        </div>
        <div data-muted={explode < 0.02 ? 'true' : 'false'}>
          <dt>Sep</dt>
          <dd><CountUp value={Math.round(explode * 100)} />%</dd>
        </div>
      </dl>
      <dl className="bw-stage-readout" aria-hidden="true">
        <div>
          <dt>Parts</dt>
          <dd><CountUp value={parts} /></dd>
        </div>
        <div>
          <dt>Mates</dt>
          <dd><CountUp value={mates} /></dd>
        </div>
        <div>
          <dt>Bodies</dt>
          <dd><CountUp value={bodies} /></dd>
        </div>
      </dl>
    </>
  )
}
