import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rgbFromHex } from '../../../cad/raster'
import { catalog } from '../../../cad/catalog'
import { renderFrame } from '../render/cards'
import { cloneSettings, STUDIO_PRESETS, type ShareStudioSettings } from '../render/presets'
import type { GeometryResolver } from '../render/scene'
import type { PublishedDocument } from '../types'
import { stepSelection, type ViewerAction, type ViewerState } from './state'

/**
 * The orbit surface.
 *
 * Rendered by the same software rasteriser that produces the share cards, into
 * a 2D canvas, with no WebGL anywhere. That is a deliberate trade:
 *
 *   - a viewer that cannot fail on a machine with no GPU acceleration, in a
 *     headless browser, or inside an embed on a locked-down device;
 *   - one renderer to reason about, so what a visitor orbits is pixel-for-pixel
 *     what the card shows;
 *   - and a viewer with no scene graph to write into, which is the structural
 *     half of "the public viewer cannot mutate the project".
 *
 * The cost is frame rate. Dragging renders at supersample 1 and settles to the
 * full-quality pass on release, which is the same technique a progressive
 * raytracer uses and reads as intentional rather than slow.
 */

export interface ModelCanvasProps {
  document: PublishedDocument
  geometry: GeometryResolver
  state: ViewerState
  dispatch: (action: ViewerAction) => void
  width: number
  height: number
  /** Overrides the studio preset; the embed uses a quieter one. */
  settings?: ShareStudioSettings
  label: string
}

const palette = (code: number) => rgbFromHex(catalog.color(code).hex)

export function ModelCanvas({
  document: published,
  geometry,
  state,
  dispatch,
  width,
  height,
  settings,
  label,
}: ModelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const [renderMs, setRenderMs] = useState<number | null>(null)

  const base = useMemo(() => cloneSettings(settings ?? STUDIO_PRESETS.studio), [settings])

  const frameSettings = useMemo<ShareStudioSettings>(
    () => ({
      ...base,
      camera: { yaw: state.yaw, pitch: state.pitch, roll: 0 },
      framing: { ...base.framing, zoom: state.zoom },
      // While the pointer is down the frame has to land inside a pointermove,
      // so quality drops to one sample per pixel and comes back on release.
      supersample: state.dragging ? 1 : base.supersample,
      watermark: null,
    }),
    [base, state.yaw, state.pitch, state.zoom, state.dragging],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const started = performance.now()
    const { include, highlight } = stepSelection(published, state.step)
    const frame = renderFrame({ document: published, geometry, palette, settings: frameSettings }, width, height, {
      include,
      highlight,
      explode: state.explode,
      // Framing never follows the visible subset: a scrubber that reframed on
      // every step would make the model appear to jump and shrink as it grows.
      fixedFraming: true,
    })
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.image.rgba), width, height), 0, 0)
    setRenderMs(performance.now() - started)
  }, [published, geometry, frameSettings, width, height, state.step, state.explode])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      dispatch({ type: 'drag', dragging: true })
    },
    [dispatch],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const active = pointer.current
      if (!active || active.id !== event.pointerId) return
      const deltaX = event.clientX - active.x
      const deltaY = event.clientY - active.y
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      // 0.4°/px is the rate at which a full turn takes roughly the width of the
      // canvas, which is what makes a drag feel like turning an object.
      dispatch({ type: 'orbit', deltaYaw: deltaX * 0.4, deltaPitch: -deltaY * 0.35 })
    },
    [dispatch],
  )

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (pointer.current?.id !== event.pointerId) return
      pointer.current = null
      dispatch({ type: 'drag', dragging: false })
    },
    [dispatch],
  )

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      dispatch({ type: 'zoom', delta: -event.deltaY * 0.0015 })
    },
    [dispatch],
  )

  /**
   * Keyboard orbit.
   *
   * The canvas is focusable and the arrow keys turn the model, because an orbit
   * control that only responds to a pointer is an orbit control half the
   * audience cannot use. Shift steps ten times further for a fast sweep.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      const step = event.shiftKey ? 45 : 5
      const actions: Record<string, ViewerAction> = {
        ArrowLeft: { type: 'orbit', deltaYaw: -step, deltaPitch: 0 },
        ArrowRight: { type: 'orbit', deltaYaw: step, deltaPitch: 0 },
        ArrowUp: { type: 'orbit', deltaYaw: 0, deltaPitch: step },
        ArrowDown: { type: 'orbit', deltaYaw: 0, deltaPitch: -step },
        '+': { type: 'zoom', delta: 0.12 },
        '=': { type: 'zoom', delta: 0.12 },
        Add: { type: 'zoom', delta: 0.12 },
        PageUp: { type: 'zoom', delta: 0.12 },
        '-': { type: 'zoom', delta: -0.12 },
        _: { type: 'zoom', delta: -0.12 },
        Subtract: { type: 'zoom', delta: -0.12 },
        PageDown: { type: 'zoom', delta: -0.12 },
        '0': { type: 'reset' },
        Home: { type: 'reset' },
      }
      const action = actions[event.key]
      if (!action) return
      event.preventDefault()
      dispatch(action)
    },
    [dispatch],
  )

  return (
    <div className="bw-share-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="bw-share-canvas"
        width={width}
        height={height}
        tabIndex={0}
        role="img"
        aria-label={label}
        data-testid="share-viewer-canvas"
        data-yaw={Math.round(state.yaw)}
        data-pitch={Math.round(state.pitch)}
        data-step={state.step ?? 'all'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      />
      <p className="bw-share-canvas-hint">
        Drag or use the arrow keys to orbit · scroll, Page Up/Down, or +/− to zoom · 0 or Home to reset
        {renderMs === null ? '' : ` · ${renderMs.toFixed(0)} ms/frame`}
      </p>
    </div>
  )
}
