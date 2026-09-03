import { useCallback, useEffect, useRef } from 'react'
import { useReducedMotion } from '../explore/motion'
import { filmAccent } from './reveal'

/**
 * One scroll listener for the whole page.
 *
 * Three of them used to run here — the hero parallax, the film scrub and the
 * pointer lamp's scroll offset — each with its own rAF loop and each calling
 * `getBoundingClientRect()` inside the frame it was also writing styles in, which
 * is the interleaving that forces a synchronous layout per element per frame. This
 * reads every tracked section first, then writes every property, so a frame costs
 * one layout no matter how many sections are registered.
 *
 * Nothing here animates on a clock, so there is nothing to pause: with reduced
 * motion or the page-wide toggle each property is pinned at its settled value and
 * the listener is never attached.
 */

/** 0 while the section fills the frame, 1 once it has left — for parallax and scrubs. */
type Exit = { mode: 'exit'; span: number }
/** 0 before the section enters, 1 once it is `span` of a viewport in — for arrivals. */
type Enter = { mode: 'enter'; span: number }

export type Track = (Exit | Enter) & {
  settled: number
  /**
   * Anything this progress drives that CSS cannot express from the number alone.
   * `host` is the surface root, because a few consumers of the film's rim colour
   * (the stage caption dot, the tab underline) sit outside the film itself.
   */
  also?: (host: HTMLElement, t: number) => void
}

const EXIT = (span: number, settled = 0): Track => ({ mode: 'exit', span, settled })
const ENTER = (span: number, settled = 1): Track => ({ mode: 'enter', span, settled })

const paintAccent = (host: HTMLElement, t: number) => host.style.setProperty('--bw-film-accent', filmAccent(t))

export const TRACKS = {
  '--bw-hero-t': EXIT(0.82),
  '--bw-film-t': { ...EXIT(0.58, 0), also: paintAccent },
  '--bw-close-t': ENTER(0.55),
} satisfies Record<string, Track>

export type TrackName = keyof typeof TRACKS
/** What `useScrollDriver` hands back: `track('--bw-hero-t')` is a section's ref. */
export type ScrollTrack = (property: TrackName) => (element: HTMLElement | null) => void

export function useScrollDriver(paused = false) {
  const targets = useRef(new Map<TrackName, HTMLElement>())
  const setters = useRef(new Map<TrackName, (element: HTMLElement | null) => void>())
  const reduced = useReducedMotion()
  const still = reduced || paused

  /** A stable ref callback per property, so React does not detach on every render. */
  const track = useCallback((property: TrackName) => {
    const existing = setters.current.get(property)
    if (existing) return existing
    const setter = (element: HTMLElement | null) => {
      if (element) targets.current.set(property, element)
      else targets.current.delete(property)
    }
    setters.current.set(property, setter)
    return setter
  }, [])

  useEffect(() => {
    const registered = targets.current
    const hostOf = (element: HTMLElement) => element.closest<HTMLElement>('.bw-surface') ?? element
    if (still) {
      for (const [property, element] of registered) {
        const track = TRACKS[property]
        element.style.setProperty(property, String(track.settled))
        track.also?.(hostOf(element), track.settled)
      }
      return
    }

    const scroller = document.getElementById('pf-main')
    const listener: HTMLElement | Window = scroller ?? window
    let frame = 0

    const paint = () => {
      frame = 0
      // Read every rect before writing anything: interleaving is what makes a
      // scroll handler cost one forced layout per element instead of one per frame.
      const viewTop = scroller ? scroller.getBoundingClientRect().top : 0
      const viewHeight = scroller ? scroller.clientHeight : window.innerHeight
      const measured: Array<[TrackName, number]> = []
      for (const [property, element] of registered) {
        const box = element.getBoundingClientRect()
        const track = TRACKS[property]
        const t =
          track.mode === 'exit'
            ? Math.max(0, viewTop - box.top) / Math.max(1, box.height * track.span)
            : (viewTop + viewHeight - box.top) / Math.max(1, viewHeight * track.span)
        measured.push([property, Math.min(1, Math.max(0, t))])
      }
      for (const [property, value] of measured) {
        const element = registered.get(property)
        if (!element) continue
        element.style.setProperty(property, value.toFixed(4))
        TRACKS[property].also?.(hostOf(element), value)
      }
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    listener.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    paint()
    return () => {
      cancelAnimationFrame(frame)
      listener.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [still])

  return track
}
