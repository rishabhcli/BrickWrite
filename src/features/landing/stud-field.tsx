import { useEffect, useRef } from 'react'
import { useOnScreen } from '../explore/motion'

/**
 * One stud, drawn once, for every part in the build.
 *
 * The page says "enormous" in eight places and states 9,563 in four, and a
 * four-digit number is not a size — it is a word for a size. This is the size:
 * a field with exactly `count` studs in it, no sampling and no rounding, so the
 * 14,714-part bridge is visibly a bigger object than the 9,563-part whale when
 * the spotlight picker switches between them.
 *
 * Canvas rather than 9,563 nodes, for the obvious reason. It is a texture and
 * it never animates, so there is nothing here for the motion toggle to stop.
 */
export function StudField({ count, label }: { count: number; label: string }) {
  const host = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const seen = useOnScreen(host, '200px')

  useEffect(() => {
    if (!seen) return
    const frame = host.current
    const surface = canvas.current
    if (!frame || !surface) return
    // `installCanvasStub` hands back null, and jsdom has no layout — both are
    // "nothing to draw" rather than a reason to throw on the landing route.
    const context = surface.getContext('2d')
    if (!context) return

    // A stud is a fixed size, so the *height* of the block is what changes when
    // the spotlight switches builds. That is the whole point: 14,714 parts has
    // to look like more than 9,563, and a full-width strip that always fills the
    // same box cannot say that. Only a build too big for the cap gets denser.
    const STUD = 6
    const MAX_HEIGHT = 460

    const paint = () => {
      const width = frame.clientWidth
      if (!width || count <= 0) return
      let cell = STUD
      let columns = Math.max(1, Math.floor(width / cell))
      let rows = Math.ceil(count / columns)
      while (cell > 2 && rows * cell > MAX_HEIGHT) {
        cell -= 1
        columns = Math.max(1, Math.floor(width / cell))
        rows = Math.ceil(count / columns)
      }
      const height = Math.min(MAX_HEIGHT, rows * cell)
      frame.style.height = `${height}px`

      const ratio = Math.min(2, window.devicePixelRatio || 1)
      surface.width = Math.round(width * ratio)
      surface.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)

      const radius = Math.max(0.7, cell * 0.3)
      context.fillStyle = '#7f8b70'
      for (let index = 0; index < count; index += 1) {
        const column = index % columns
        const row = (index - column) / columns
        const y = row * cell + cell / 2
        if (y > height) break
        context.beginPath()
        context.arc(column * cell + cell / 2, y, radius, 0, Math.PI * 2)
        context.fill()
      }
    }

    paint()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(paint)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [seen, count])

  return (
    <div className="bw-stud-field" ref={host} role="img" aria-label={label}>
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  )
}
