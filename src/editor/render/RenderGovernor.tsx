import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import type CameraControlsImpl from 'camera-controls'
import { RENDER_SETTLE_MS, RenderPolicy, type RenderHold } from './renderPolicy'

/**
 * Spends frames instead of assuming them.
 *
 * Sits inside the Canvas and drives `frameloop` from a `RenderPolicy`: `always`
 * while something genuinely moves, `demand` the rest of the time, `never` on a
 * hidden tab. Everything that changes the picture without taking a hold —
 * a commit, a selection, an orbit — already reaches the renderer through
 * react-three-fiber's own invalidation, so the still frame stays correct.
 */
export function RenderGovernor({
  policy,
  animating,
  onModeChange,
}: {
  policy: RenderPolicy
  /** True while a timed animation is running: turntable, playback, reveal, ghost. */
  animating: boolean
  onModeChange?: (mode: 'always' | 'demand' | 'never') => void
}) {
  const setFrameloop = useThree((state) => state.setFrameloop)
  const invalidate = useThree((state) => state.invalidate)
  const gl = useThree((state) => state.gl)
  const controls = useThree((state) => state.controls) as CameraControlsImpl | null

  // Counts frames for the backdrop sampler. Priority 1000 so it runs after the
  // passes that draw, and therefore counts a frame that happened.
  useFrame(() => policy.notePainted(), 1000)

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hidden = useRef(false)

  const api = useMemo(() => {
    const apply = () => {
      clearTimeout(timer.current)
      timer.current = undefined
      if (hidden.current) {
        setFrameloop('never')
        onModeChange?.('never')
        return
      }
      const mode = policy.mode(performance.now())
      setFrameloop(mode)
      onModeChange?.(mode)
      // Same spirit as `__brickwrightRenderStats`: the browser acceptance run
      // asserts that an idle viewport actually stops, and "why is it still
      // drawing" is unanswerable from draw counts alone.
      ;(window as unknown as { __brickwrightFrameMode?: () => unknown }).__brickwrightFrameMode = () => ({
        mode,
        held: policy.held,
      })
      if (mode === 'demand') {
        // One last frame, so whatever the settle window was for is on screen.
        invalidate()
        return
      }
      // No hold is left; only the settle window is keeping the loop alive, so
      // re-decide when it expires. A held source re-applies on its own release.
      if (policy.held.length === 0) timer.current = setTimeout(apply, RENDER_SETTLE_MS)
    }
    return {
      apply,
      hold: (source: RenderHold) => {
        policy.hold(source)
        apply()
      },
      release: (source: RenderHold) => {
        policy.release(source, performance.now())
        apply()
      },
      touch: () => {
        policy.touch(performance.now())
        apply()
      },
    }
  }, [invalidate, onModeChange, policy, setFrameloop])

  // Timed animations are the one source the React tree knows about directly.
  useEffect(() => {
    if (animating) api.hold('animation')
    else api.release('animation')
  }, [animating, api])

  // A gesture on the canvas moves something every frame it lasts.
  useEffect(() => {
    const canvas = gl.domElement
    const begin = () => api.hold('gesture')
    const end = () => api.release('gesture')
    canvas.addEventListener('pointerdown', begin, { passive: true })
    window.addEventListener('pointerup', end, { passive: true })
    window.addEventListener('pointercancel', end, { passive: true })
    window.addEventListener('blur', end)
    // A wheel burst has no press and release to bracket it; each notch simply
    // extends the settle window, which turns a stream of notches into one run.
    const wheel = () => api.touch()
    canvas.addEventListener('wheel', wheel, { passive: true })
    return () => {
      canvas.removeEventListener('pointerdown', begin)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
      canvas.removeEventListener('wheel', wheel)
      // Unmounting mid-drag must not strand the loop on `always` forever.
      policy.release('gesture', performance.now())
    }
  }, [api, gl, policy])

  // camera-controls damps for a while after the pointer is up, and drives its
  // own smoothing from the frame clock, so the hold follows wake/sleep rather
  // than the gesture.
  useEffect(() => {
    if (!controls) return
    const wake = () => api.hold('camera')
    const sleep = () => api.release('camera')
    controls.addEventListener('wake', wake)
    controls.addEventListener('transitionstart', wake)
    controls.addEventListener('sleep', sleep)
    controls.addEventListener('rest', sleep)
    return () => {
      controls.removeEventListener('wake', wake)
      controls.removeEventListener('transitionstart', wake)
      controls.removeEventListener('sleep', sleep)
      controls.removeEventListener('rest', sleep)
      policy.release('camera', performance.now())
    }
  }, [api, controls, policy])

  // A hidden tab draws nothing at all. Returning to it repaints immediately:
  // the drawing buffer of a backgrounded context is not guaranteed to survive.
  useEffect(() => {
    const onVisibility = () => {
      hidden.current = document.hidden
      if (!document.hidden) policy.touch(performance.now())
      api.apply()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [api, policy])

  useEffect(() => {
    api.apply()
    return () => clearTimeout(timer.current)
  }, [api])

  // A restored context has to redraw whatever it lost, and a lost one has no
  // reason to keep asking for frames it cannot serve.
  useEffect(() => {
    const canvas = gl.domElement
    const restored = () => {
      policy.touch(performance.now())
      api.apply()
    }
    canvas.addEventListener('webglcontextrestored', restored)
    return () => canvas.removeEventListener('webglcontextrestored', restored)
  }, [api, gl, policy])

  return null
}
