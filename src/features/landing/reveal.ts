import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../explore/motion'

/**
 * Scroll choreography.
 *
 * One observer per revealed element, unobserved as soon as it fires: the
 * intent is a single entrance, and a listener that keeps firing on every scroll
 * is a jank source for a page whose whole point is that it paints fast.
 *
 * With reduced motion requested, elements start shown. Not "animate faster" —
 * shown, immediately, with no transform to interrupt.
 */
export function useReveal<T extends HTMLElement>(delayMs = 0) {
  const ref = useRef<T | null>(null)
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced)

  useEffect(() => {
    if (reduced) {
      setShown(true)
      return
    }
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setShown(true)
        observer.disconnect()
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [reduced])

  return {
    ref,
    props: {
      className: 'bw-reveal',
      'data-shown': shown ? 'true' : 'false',
      style: reduced ? undefined : ({ '--bw-delay': `${delayMs}ms` } as React.CSSProperties),
    },
  }
}

export const FILM_STAGES = ['brief', 'candidate', 'refinement', 'validated'] as const
export type FilmStage = (typeof FILM_STAGES)[number]

const CYAN = [131, 231, 238] as const
const ORANGE = [245, 163, 63] as const
const GREEN = [152, 213, 109] as const

function mixChannel(from: number, to: number, t: number) {
  return Math.round(from + (to - from) * t)
}

/** Cyan → orange → green along the film, so the rim does not jump. */
export function filmAccent(t: number): string {
  const clamped = Math.min(1, Math.max(0, t))
  const [r, g, b] =
    clamped < 0.5
      ? [
          mixChannel(CYAN[0], ORANGE[0], clamped / 0.5),
          mixChannel(CYAN[1], ORANGE[1], clamped / 0.5),
          mixChannel(CYAN[2], ORANGE[2], clamped / 0.5),
        ]
      : [
          mixChannel(ORANGE[0], GREEN[0], (clamped - 0.5) / 0.5),
          mixChannel(ORANGE[1], GREEN[1], (clamped - 0.5) / 0.5),
          mixChannel(ORANGE[2], GREEN[2], (clamped - 0.5) / 0.5),
        ]
  return `rgb(${r} ${g} ${b})`
}

function writeBeat(next: FilmStage) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (url.pathname !== '/' && url.pathname !== '') return
  url.searchParams.set('beat', next)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function readBeat(): FilmStage | null {
  if (typeof window === 'undefined') return null
  const beat = new URLSearchParams(window.location.search).get('beat')
  return beat && FILM_STAGES.includes(beat as FilmStage) ? (beat as FilmStage) : null
}

function typingIn(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Drives the pinned model from the chapter currently occupying the frame.
 *
 * The visitor's scroll is the timeline. Tabs on the stage still work because
 * the parent can call `setStage` directly; this hook only writes when a
 * chapter actually crosses the reading line.
 *
 * Which chapter is being read is information, not decoration, so this keeps
 * working with motion paused — a reader who turned animation off should still
 * not be shown "an idea arrives in pieces" beside a finished building. What
 * `paused` changes is how the reel gets from one chapter to the next: the
 * stylesheet zeroes the durations, and `--bw-film-t` settles at 0 so the stage
 * floor alone decides the pose.
 */
export function useFilmStage(paused = false) {
  const [stage, setStage] = useState<FilmStage>('brief')
  const userLock = useRef(false)
  const stageRef = useRef<FilmStage>('brief')
  const jumpRef = useRef<(next: FilmStage, record: boolean) => void>(() => undefined)
  const reduced = useReducedMotion()
  stageRef.current = stage
  jumpRef.current = (next, record) => {
    userLock.current = true
    setStage(next)
    if (record) writeBeat(next)
    document.querySelector<HTMLElement>(`[data-film-stage="${next}"]`)?.scrollIntoView?.({
      behavior: reduced || paused ? 'auto' : 'smooth',
      block: window.matchMedia?.('(max-width: 899px)').matches ? 'start' : 'center',
      inline: 'nearest',
    })
  }

  useEffect(() => {
    const chapters = [...document.querySelectorAll<HTMLElement>('[data-film-stage]')]
    if (!chapters.length || typeof IntersectionObserver === 'undefined') return
    const scroller = document.getElementById('pf-main')
    const observer = new IntersectionObserver(
      (entries) => {
        if (userLock.current) return
        const hit = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (!hit) return
        const next = hit.target.getAttribute('data-film-stage')
        if (!next || !FILM_STAGES.includes(next as FilmStage)) return
        setStage(next as FilmStage)
      },
      {
        root: scroller,
        threshold: [0.25, 0.45, 0.65, 0.85],
        rootMargin: '-10% 0px -28% 0px',
      },
    )
    for (const chapter of chapters) observer.observe(chapter)

    // The chapter observer is suppressed while a tab click is scrolling the page;
    // any real scroll releases it. `--bw-film-t` itself is written by the page's
    // one scroll driver (scroll.ts), not from here.
    const release = () => {
      userLock.current = false
    }
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', release, { passive: true })
    return () => {
      observer.disconnect()
      target.removeEventListener('scroll', release)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return
      if (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4') {
        event.preventDefault()
        jumpRef.current(FILM_STAGES[Number(event.key) - 1], true)
        return
      }
      if (event.key === '[' || event.key === ']') {
        const next = FILM_STAGES[FILM_STAGES.indexOf(stageRef.current) + (event.key === ']' ? 1 : -1)]
        if (!next) return
        event.preventDefault()
        jumpRef.current(next, true)
      }
    }
    window.addEventListener('keydown', onKey)
    const beat = readBeat()
    if (beat) {
      userLock.current = true
      setStage(beat)
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-film-stage="${beat}"]`)?.scrollIntoView?.({
          behavior: 'auto',
          block: window.matchMedia?.('(max-width: 899px)').matches ? 'start' : 'center',
          inline: 'nearest',
        })
      })
    }
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    stage,
    setStage: (next: FilmStage) => jumpRef.current(next, true),
  }
}

/**
 * Linear / Clerk / Raycast all light the page from the pointer. Brickwright
 * does the same with a clutch-lamp over the stud plate: one listener, CSS
 * variables, a lerp so the lamp does not stutter. Touch and reduced motion
 * leave the lamp parked — a wandering highlight on a phone is not craft,
 * it is a fingerprint smudge.
 */
export function usePointerField<T extends HTMLElement>(paused = false) {
  const ref = useRef<T | null>(null)
  const reduced = useReducedMotion()
  const [live, setLive] = useState(false)

  useEffect(() => {
    const root = ref.current
    if (!root || reduced || paused || typeof window === 'undefined' || !window.matchMedia) {
      setLive(false)
      return
    }
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    if (!fine.matches) {
      setLive(false)
      return
    }

    let frame = 0
    let running = false
    let armed = false
    let currentX = window.innerWidth * 0.62
    let currentY = window.innerHeight * 0.2
    let targetX = currentX
    let targetY = currentY
    const scroller = document.getElementById('pf-main')
    // `.pf-frame__body` is both the scroller and Chromium's containing block
    // for the fixed landing chrome. Add its scroll position back, then remove
    // its top-bar offset so the decorative lamp follows the pointer on scroll.
    const scrollOffset = () => (scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : window.scrollY)
    const paintScrollOffset = () => {
      const offset = scrollOffset()
      root.style.setProperty('--bw-scroll-y', `${offset.toFixed(1)}px`)
      root.style.setProperty('--bw-ptr-y', `${(currentY + offset).toFixed(1)}px`)
    }

    let magnets: HTMLElement[] = [...root.querySelectorAll<HTMLElement>('.bw-magnet')]
    const recount = () => {
      magnets = [...root.querySelectorAll<HTMLElement>('.bw-magnet')]
    }
    const park = () => {
      for (const magnet of magnets) {
        magnet.style.setProperty('--bw-mag-x', '0px')
        magnet.style.setProperty('--bw-mag-y', '0px')
      }
    }

    const tick = () => {
      running = false
      currentX += (targetX - currentX) * 0.14
      currentY += (targetY - currentY) * 0.14
      root.style.setProperty('--bw-ptr-x', `${currentX.toFixed(1)}px`)
      paintScrollOffset()
      for (const magnet of magnets) {
        const box = magnet.getBoundingClientRect()
        const cx = box.left + box.width / 2
        const cy = box.top + box.height / 2
        const reach = Math.max(box.width, box.height) * 0.9 + 48
        const dx = targetX - cx
        const dy = targetY - cy
        if (dx * dx + dy * dy > reach * reach) {
          magnet.style.setProperty('--bw-mag-x', '0px')
          magnet.style.setProperty('--bw-mag-y', '0px')
          continue
        }
        const step = (value: number) => `${Math.round(value / 2) * 2}px`
        magnet.style.setProperty('--bw-mag-x', step((dx / Math.max(1, box.width)) * 8))
        magnet.style.setProperty('--bw-mag-y', step((dy / Math.max(1, box.height)) * 6))
      }
      if (Math.abs(targetX - currentX) > 0.4 || Math.abs(targetY - currentY) > 0.4) {
        running = true
        frame = requestAnimationFrame(tick)
      }
    }

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX
      targetY = event.clientY
      if (!armed) {
        armed = true
        setLive(true)
      }
      if (!running) {
        running = true
        frame = requestAnimationFrame(tick)
      }
    }

    const onLeave = () => {
      armed = false
      setLive(false)
      park()
    }

    paintScrollOffset()
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', recount, { passive: true })
    scroller?.addEventListener('scroll', paintScrollOffset, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', recount)
      scroller?.removeEventListener('scroll', paintScrollOffset)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [reduced, paused])

  return { ref, live }
}
