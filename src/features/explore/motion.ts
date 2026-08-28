import { useEffect, useState } from 'react'

/**
 * Whether this visitor has asked for reduced motion.
 *
 * Reactive rather than read-once: the setting can change while the page is
 * open, and a landing page that keeps animating after somebody turns motion off
 * in the middle of a session has not honoured the request, it has sampled it.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return reduced
}

/**
 * True once the element has been on screen.
 *
 * The landing route is not allowed to fetch preview geometry before it paints,
 * so every heavy thing on the page waits for this — or for a deliberate
 * interaction — before it loads anything. Without `IntersectionObserver` the
 * answer is "yes", because degrading to *never loading* would be worse than
 * degrading to loading early.
 */
export function useOnScreen(ref: { current: Element | null }, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (seen) return
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, rootMargin, seen])

  return seen
}
