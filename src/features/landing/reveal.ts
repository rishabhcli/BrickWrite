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
