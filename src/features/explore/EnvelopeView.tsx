import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DemoPreview } from '../../demos'
import {
  buildScene,
  cameraBasis,
  explodeOffsets,
  fitScene,
  PART_FIELDS,
  pointInPolygon,
  project,
  shadeHex,
  visibleFaces,
  type Camera,
  type Vec,
} from './projection'

/**
 * The interactive model view.
 *
 * A 2D canvas, deliberately. The landing and explore routes may not download
 * the compiled catalog or the Three.js renderer, and what this draws — every
 * part's measured LDraw envelope at its exact document transform, in its real
 * LDraw colour, with its real stud positions — is enough to orbit, explode,
 * scrub the build and pick a part out of the model. The caption says it is an
 * envelope view; the editor is where the compiled meshes live.
 *
 * The canvas is `aria-hidden`. Everything it shows is also in the DOM as text
 * and as focusable controls, so nothing here is reachable only by sighted mouse
 * users.
 */

export interface EnvelopeViewProps {
  preview: DemoPreview
  camera: Camera
  onCameraChange?: (camera: Camera) => void
  /** Draw only parts introduced before this step index. */
  stepLimit?: number
  /** Parts in this step are drawn at full strength, the rest washed back. */
  highlightStep?: number
  explode?: number
  selectedIndex?: number | null
  onSelectIndex?: (index: number | null) => void
  /**
   * Refinement sweep, 0–1. Parts ahead of the sweep are drawn as wireframe
   * candidates and parts behind it as resolved geometry, which is what makes
   * the landing hero a picture of a model being settled rather than a fade.
   */
  wave?: number
  interactive?: boolean
  className?: string
  /** Sentence describing the model, used as the canvas's accessible name. */
  label: string
}

interface HitTarget {
  index: number
  polygons: Array<Array<[number, number]>>
}

export function EnvelopeView({
  preview,
  camera,
  onCameraChange,
  stepLimit,
  highlightStep,
  explode = 0,
  selectedIndex = null,
  onSelectIndex,
  wave,
  interactive = true,
  className,
  label,
}: EnvelopeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const hitsRef = useRef<HitTarget[]>([])
  const [size, setSize] = useState({ width: 640, height: 420 })
  const dragRef = useRef<{ x: number; y: number; camera: Camera; moved: boolean } | null>(null)

  const offsets = useMemo(() => explodeOffsets(preview), [preview])
  const palette = useMemo(
    () => preview.colors.map((color) => ({ hex: color.hex, edge: color.edge, alpha: color.alpha })),
    [preview],
  )

  useEffect(() => {
    const element = frameRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    })
    observer.observe(element)
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
    canvas.width = Math.max(1, Math.round(size.width * ratio))
    canvas.height = Math.max(1, Math.round(size.height * ratio))
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)

    const basis = cameraBasis(camera)
    const fit = fitScene(preview.boundsLdu, basis, size, { padding: 0.12, zoom: camera.zoom })
    const scene = buildScene(preview, basis, { stepLimit, explode, explodeOffsets: offsets })
    const hits: HitTarget[] = []
    // Roughly a stud's radius, so the dimples scale with the model rather than
    // sitting at a fixed pixel size that turns into noise when zoomed out.
    const studRadiusLdu = 6
    const drawStuds = fit.scale * studRadiusLdu > 1.6

    context.lineJoin = 'round'
    for (const box of scene) {
      const color = palette[box.color] ?? { hex: '#8a928d', edge: '#4a5559', alpha: 1 }
      const resolved = wave === undefined ? true : normalisedU(box.centre, basis, preview) <= wave
      const dimmed = highlightStep !== undefined && box.step !== highlightStep
      const selected = selectedIndex === box.index
      const faces = visibleFaces(box.min, box.max, basis)
      const polygons: Array<Array<[number, number]>> = []

      for (const face of faces) {
        const points = face.corners.map((corner) => project(corner, basis, fit))
        polygons.push(points)
        context.beginPath()
        context.moveTo(points[0][0], points[0][1])
        for (let index = 1; index < points.length; index += 1) context.lineTo(points[index][0], points[index][1])
        context.closePath()

        if (!resolved) {
          // A candidate the refinement has not reached yet: drawn as the
          // proposal it is, not as finished geometry.
          context.globalAlpha = 0.22
          context.strokeStyle = '#83e7ee'
          context.lineWidth = 1
          context.stroke()
          context.globalAlpha = 1
          continue
        }

        context.globalAlpha = color.alpha < 1 ? 0.55 : dimmed ? 0.38 : 1
        context.fillStyle = shadeHex(color.hex, face.shade)
        context.fill()
        context.globalAlpha = dimmed ? 0.25 : 0.85
        context.strokeStyle = selected ? '#83e7ee' : shadeHex(color.edge, face.shade * 0.85)
        context.lineWidth = selected ? 1.6 : 0.6
        context.stroke()
        context.globalAlpha = 1

        if (drawStuds && face.axis === 1 && face.sign === -1 && box.studLayout >= 0) {
          drawStudRing(context, preview, box, basis, fit, color.hex, face.shade, studRadiusLdu, dimmed)
        }
      }
      hits.push({ index: box.index, polygons })
    }
    // Nearest first, so a click lands on the part in front.
    hitsRef.current = hits.reverse()
  }, [preview, camera, size, stepLimit, highlightStep, explode, selectedIndex, wave, offsets, palette])

  const orbitBy = useCallback(
    (deltaYaw: number, deltaPitch: number) => {
      if (!onCameraChange) return
      onCameraChange({
        ...camera,
        yaw: camera.yaw + deltaYaw,
        // Clamped short of the poles: at 90° the horizontal basis is degenerate
        // and the model would flip inside out.
        pitch: Math.max(-84, Math.min(84, camera.pitch + deltaPitch)),
      })
    },
    [camera, onCameraChange],
  )

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !onCameraChange) return
    dragRef.current = { x: event.clientX, y: event.clientY, camera, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || !onCameraChange) return
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true
    onCameraChange({
      ...drag.camera,
      yaw: drag.camera.yaw - deltaX * 0.4,
      pitch: Math.max(-84, Math.min(84, drag.camera.pitch + deltaY * 0.3)),
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!drag || drag.moved || !onSelectIndex) return
    const rect = event.currentTarget.getBoundingClientRect()
    const point: [number, number] = [event.clientX - rect.left, event.clientY - rect.top]
    const hit = hitsRef.current.find((target) => target.polygons.some((polygon) => pointInPolygon(point, polygon)))
    onSelectIndex(hit ? hit.index : null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    const step = event.shiftKey ? 15 : 5
    if (event.key === 'ArrowLeft') { orbitBy(-step, 0); event.preventDefault() }
    else if (event.key === 'ArrowRight') { orbitBy(step, 0); event.preventDefault() }
    else if (event.key === 'ArrowUp') { orbitBy(0, step); event.preventDefault() }
    else if (event.key === 'ArrowDown') { orbitBy(0, -step); event.preventDefault() }
  }

  return (
    <div
      ref={frameRef}
      className={className ? `bw-envelope ${className}` : 'bw-envelope'}
      role="img"
      aria-label={
        interactive
          ? `${label} Orbit with the arrow keys once this view has focus.`
          : label
      }
      tabIndex={interactive ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      data-interactive={interactive ? 'true' : 'false'}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden="true" />
    </div>
  )
}

/** How far along the screen's horizontal axis a point sits, as 0–1. */
function normalisedU(point: Vec, basis: ReturnType<typeof cameraBasis>, preview: DemoPreview): number {
  const { min, max } = preview.boundsLdu
  let low = Infinity
  let high = -Infinity
  for (let corner = 0; corner < 8; corner += 1) {
    const u =
      (corner & 1 ? max[0] : min[0]) * basis.right[0]
      + (corner & 2 ? max[1] : min[1]) * basis.right[1]
      + (corner & 4 ? max[2] : min[2]) * basis.right[2]
    if (u < low) low = u
    if (u > high) high = u
  }
  const u = point[0] * basis.right[0] + point[1] * basis.right[1] + point[2] * basis.right[2]
  return high - low < 1e-6 ? 0 : (u - low) / (high - low)
}

/** Draws the studs on a box's top face at their real positions. */
function drawStudRing(
  context: CanvasRenderingContext2D,
  preview: DemoPreview,
  box: { min: Vec; max: Vec; studLayout: number },
  basis: ReturnType<typeof cameraBasis>,
  fit: ReturnType<typeof fitScene>,
  hex: string,
  shade: number,
  radiusLdu: number,
  dimmed: boolean,
) {
  const layout = preview.studLayouts[box.studLayout]
  if (!layout) return
  const width = box.max[0] - box.min[0]
  const depth = box.max[2] - box.min[2]
  context.globalAlpha = dimmed ? 0.3 : 0.95
  context.fillStyle = shadeHex(hex, Math.min(1.25, shade * 1.16))
  for (let index = 0; index < layout.length; index += 2) {
    const x = box.min[0] + layout[index] * width
    const z = box.min[2] + layout[index + 1] * depth
    // Four points around the stud, projected individually, so the dimple is
    // foreshortened the same way the face it sits on is.
    const ring: Array<[number, number]> = [
      project([x - radiusLdu, box.min[1], z], basis, fit),
      project([x, box.min[1], z - radiusLdu], basis, fit),
      project([x + radiusLdu, box.min[1], z], basis, fit),
      project([x, box.min[1], z + radiusLdu], basis, fit),
    ]
    context.beginPath()
    context.moveTo(ring[0][0], ring[0][1])
    for (let point = 1; point < ring.length; point += 1) context.lineTo(ring[point][0], ring[point][1])
    context.closePath()
    context.fill()
  }
  context.globalAlpha = 1
}

export { PART_FIELDS }
export default EnvelopeView
