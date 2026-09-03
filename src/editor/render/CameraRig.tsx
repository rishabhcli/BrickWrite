import { CameraControls, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import CameraControlsImpl from 'camera-controls'
import * as THREE from 'three'
import type { Bounds } from '../../cad/types'
import type { CameraView, EditorTool } from '../CadViewport'
import { boundsFrame } from './framing'
import { cameraTarget, cameraZoom, frameCamera, settleCamera } from './cameraControl'
import type { MotionController } from './motion'
import { cameraOwnsPointer, installPointerRouter, pointerRouterFor, type DragIntent } from './pointerRouter'

const DIRECTIONS: Record<CameraView, THREE.Vector3> = {
  isometric: new THREE.Vector3(0.86, 0.64, 1), front: new THREE.Vector3(0, 0, 1),
  rear: new THREE.Vector3(0, 0, -1), left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0), top: new THREE.Vector3(0, 1, 0.001),
}

export function CameraRig({ bounds, documentId, hasParts, exploded, view, resetKey, motion, placing, tool }: {
  bounds: Bounds; documentId: string; hasParts: boolean; exploded: boolean; view: CameraView;
  resetKey: number; motion: MotionController; placing: boolean; tool: EditorTool
}) {
  const controls = useRef<CameraControlsImpl>(null)
  const { camera, gl, size } = useThree()
  const latest = useRef({ bounds, size, hasParts, marquee: tool === 'select' })
  latest.current = { bounds, size, hasParts, marquee: tool === 'select' }
  const framed = useRef(false)
  const router = pointerRouterFor(gl.domElement)
  /**
   * Space is the pan everyone already knows, and it has to work from any tool.
   * Held rather than toggled, so it borrows the button and gives it straight
   * back — the same shape as the Pan tool, reached without leaving Move.
   */
  const [spacePan, setSpacePan] = useState(false)
  const panning = tool === 'pan' || spacePan
  const cameraTool = panning || tool === 'orbit'
  const toolRef = useRef({ panning, cameraTool })
  toolRef.current = { panning, cameraTool }

  useLayoutEffect(() => {
    router.setPlacement(placing)
    return () => router.setPlacement(false)
  }, [router, placing])

  useLayoutEffect(() => {
    // Placement outranks everything, including a camera tool, so an armed part
    // is still placed with a click while Pan happens to be selected.
    router.setCameraTool(cameraTool && !placing)
    return () => router.setCameraTool(false)
  }, [router, cameraTool, placing])

  useLayoutEffect(() => {
    const element = gl.domElement
    if (placing) return
    const previous = element.style.cursor
    if (panning) element.style.cursor = 'grab'
    else if (tool === 'orbit') element.style.cursor = 'move'
    else return
    return () => { element.style.cursor = previous }
  }, [gl, panning, placing, tool])

  // Held, not typed: a chord would fire on repeat and would not know when the
  // key came back up. Buttons take Space as an activation, so the canvas has to
  // own the focus for this to be unambiguous.
  useEffect(() => {
    const canvas = gl.domElement
    const isSpace = (event: KeyboardEvent) => event.code === 'Space' || event.key === ' '
    const down = (event: KeyboardEvent) => {
      if (!isSpace(event) || event.repeat) return
      if (window.document.activeElement !== canvas) return
      event.preventDefault()
      setSpacePan(true)
    }
    const up = (event: KeyboardEvent) => { if (isSpace(event)) setSpacePan(false) }
    const clear = () => setSpacePan(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
      setSpacePan(false)
    }
  }, [gl])

  useEffect(() => {
    const control = controls.current
    if (!control) return
    const syncOwner = router.subscribe((owner) => {
      if (!cameraOwnsPointer(owner)) { control.cancel(); control.stop() }
      control.enabled = cameraOwnsPointer(owner)
    })
    // What a left drag means, asked once it clears the click slop. Select keeps
    // the gesture for a marquee; every other tool hands it to the camera. Pan
    // and Orbit never reach here — their press is camera-owned from the start
    // and CameraControls drives it natively through `mouseButtons.left`.
    const uninstall = installPointerRouter(gl.domElement, router, (dx, dy): DragIntent => {
      if (toolRef.current.cameraTool) return 'orbit'
      if (latest.current.marquee) return 'marquee'
      const radiansPerPixel = 2 * Math.PI / Math.max(1, latest.current.size.height)
      void control.rotate(-dx * radiansPerPixel, -dy * radiansPerPixel, motion.policy.animated)
      return 'orbit'
    })
    const policy = () => {
      control.smoothTime = motion.policy.animated ? 0.35 : 0
      control.draggingSmoothTime = motion.policy.animated ? 0.06 : 0
      if (!motion.policy.animated) settleCamera(control)
    }
    policy()
    const unsubscribe = motion.subscribe(policy)
    const settle = () => settleCamera(control)
    const cancel = () => { control.cancel(); control.stop(); router.release() }
    window.addEventListener('brickwright:renderer-settle', settle)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', cancel)
    return () => {
      uninstall(); syncOwner(); unsubscribe(); control.cancel(); control.enabled = true
      window.removeEventListener('brickwright:renderer-settle', settle)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', cancel)
    }
  }, [camera, gl, motion, router])

  useEffect(() => {
    if (!controls.current) return
    frameCamera(controls.current, latest.current.bounds, latest.current.size,
      framed.current && motion.policy.animated, DIRECTIONS[view])
    framed.current = latest.current.hasParts
  }, [camera, documentId, exploded, resetKey, view, motion])

  useEffect(() => {
    if (framed.current || !hasParts || !controls.current) return
    frameCamera(controls.current, latest.current.bounds, latest.current.size, false, DIRECTIONS[view])
    framed.current = true
  }, [camera, hasParts, view])

  const previousSize = useRef(size)
  useEffect(() => {
    const previous = previousSize.current
    previousSize.current = size
    const control = controls.current
    if (!control || !previous.width || !previous.height || (previous.width === size.width && previous.height === size.height)) return
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      void control.zoomTo(cameraZoom(control) * Math.min(size.width, size.height) / Math.min(previous.width, previous.height), motion.policy.animated)
    } else {
      const direction = control.getPosition(new THREE.Vector3(), true).sub(control.getTarget(new THREE.Vector3(), true))
      const before = boundsFrame(control.camera, latest.current.bounds, previous, direction)
      const after = boundsFrame(control.camera, latest.current.bounds, size, direction)
      void control.dollyTo(control.distance * after.position.distanceTo(after.target) / before.position.distanceTo(before.target), motion.policy.animated)
    }
  }, [camera, size, motion])

  return <>
    <CameraControls ref={controls} makeDefault smoothTime={motion.policy.animated ? 0.35 : 0}
      draggingSmoothTime={motion.policy.animated ? 0.06 : 0} restThreshold={0.002}
      minDistance={1} maxDistance={100000} dollyToCursor
      mouseButtons={{
        left: panning ? CameraControlsImpl.ACTION.TRUCK : CameraControlsImpl.ACTION.ROTATE,
        // Orbit, not dolly. The wheel already zooms toward the cursor, which is
        // where a hand reaches for zoom; giving the middle button the orbit is
        // what lets Select keep the left button for a marquee without leaving
        // the camera a tool switch away.
        middle: CameraControlsImpl.ACTION.ROTATE,
        right: CameraControlsImpl.ACTION.TRUCK,
        wheel: (camera as THREE.OrthographicCamera).isOrthographicCamera ? CameraControlsImpl.ACTION.ZOOM : CameraControlsImpl.ACTION.DOLLY }} />
    <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
      {/* Disable the helper's private flight; heads use the same rig as every other view client. */}
      <GizmoViewport disabled axisColors={['#ff6a55', '#8bcf65', '#6bbbd6']} labelColor="#0c1112"
        onPointerDown={(event) => {
          if (!(event.object instanceof THREE.Sprite) || !controls.current) return
          event.stopPropagation()
          const control = controls.current
          const target = cameraTarget(control)
          const position = event.object.position.clone().normalize().multiplyScalar(control.distance).add(target)
          void control.setLookAt(...position.toArray(), ...target.toArray(), motion.policy.animated)
        }} />
    </GizmoHelper>
  </>
}
