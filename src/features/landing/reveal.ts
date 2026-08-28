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

const FILM_STAGES = ['brief', 'candidate', 'refinement', 'validated'] as const

/**
 * Drives the pinned model from the chapter currently occupying the frame.
 *
 * The visitor's scroll is the timeline. Tabs on the stage still work because
 * the parent can call `setStage` directly; this hook only writes when a
 * chapter actually crosses the reading line.
 */
export function useFilmStage() {
  const [stage, setStage] = useState<(typeof FILM_STAGES)[number]>('brief')
  const userLock = useRef(false)

  useEffect(() => {
    const chapters = [...document.querySelectorAll<HTMLElement>('[data-film-stage]')]
    if (!chapters.length || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (userLock.current) return
        const hit = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (!hit) return
        const next = hit.target.getAttribute('data-film-stage')
        if (!next || !FILM_STAGES.includes(next as (typeof FILM_STAGES)[number])) return
        setStage(next as (typeof FILM_STAGES)[number])
      },
      { threshold: [0.4, 0.6, 0.8], rootMargin: '-12% 0px -30% 0px' },
    )
    for (const chapter of chapters) observer.observe(chapter)
    const onScroll = () => {
      userLock.current = false
    }
    const scroller = document.getElementById('pf-main') ?? window
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [])

  return {
    stage,
    setStage: (next: (typeof FILM_STAGES)[number]) => {
      userLock.current = true
      setStage(next)
    },
  }
}
