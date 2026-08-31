import { useEffect, useState, type RefObject } from 'react'

/** A plain box. DOMRect carries live-layout semantics this never wants. */
export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const same = (a: Box | null, b: Box): boolean =>
  a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

/**
 * Tracks an element's box without reading layout on every pointer frame.
 *
 * getBoundingClientRect during a pointermove is a forced synchronous layout,
 * and four lensed surfaces at 60 Hz is 240 of them a second. The box only
 * actually changes when the element resizes or the page scrolls, so it is
 * cached against exactly those two events, and the state is left alone when the
 * measurement comes back identical.
 */
export function useHostRect(hostRef: RefObject<HTMLElement | null>): Box | null {
  const [rect, setRect] = useState<Box | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const measure = () => {
      const { left, top, width, height } = host.getBoundingClientRect()
      const next = { left, top, width, height }
      setRect((current) => (same(current, next) ? current : next))
    }
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(host)
    window.addEventListener('scroll', measure, { passive: true, capture: true })
    window.addEventListener('resize', measure, { passive: true })

    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [hostRef])

  return rect
}

/**
 * How much of `surface` lies inside `region`, as 0..1.
 *
 * Used to decide whether a surface is actually sitting over the rendered scene.
 * In this editor's grid the docks sit *beside* the canvas and the topbar above
 * it, so they overlap it not at all and must keep reading their tint from the
 * page behind them rather than from the model.
 */
export function overlapFraction(surface: Box, region: Box): number {
  const area = surface.width * surface.height
  if (area <= 0) return 0
  const overlapWidth = Math.max(
    0,
    Math.min(surface.left + surface.width, region.left + region.width) - Math.max(surface.left, region.left),
  )
  const overlapHeight = Math.max(
    0,
    Math.min(surface.top + surface.height, region.top + region.height) - Math.max(surface.top, region.top),
  )
  return (overlapWidth * overlapHeight) / area
}

/**
 * Half covered is enough to adopt the region's luminance.
 *
 * A surface straddling the canvas edge has to pick one answer, and picking the
 * scene's is the one that keeps a floating control legible while it drifts over
 * a bright model.
 */
export const OVERLAP_THRESHOLD = 0.5
