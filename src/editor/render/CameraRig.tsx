import { CameraControls, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import CameraControlsImpl from 'camera-controls'
import * as THREE from 'three'
import type { Bounds } from '../../cad/types'
import type { CameraView } from '../CadViewport'
import { boundsFrame } from './framing'
import { cameraTarget, cameraZoom, frameCamera, settleCamera } from './cameraControl'
import type { MotionController } from './motion'
import { cameraOwnsPointer, installPointerRouter, pointerRouterFor } from './pointerRouter'

const DIRECTIONS: Record<CameraView, THREE.Vector3> = {
  isometric: new THREE.Vector3(0.86, 0.64, 1), front: new THREE.Vector3(0, 0, 1),
  rear: new THREE.Vector3(0, 0, -1), left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0), top: new THREE.Vector3(0, 1, 0.001),
}

export function CameraRig({ bounds, documentId, hasParts, exploded, view, resetKey, motion, placing }: {
  bounds: Bounds; documentId: string; hasParts: boolean; exploded: boolean; view: CameraView;
  resetKey: number; motion: MotionController; placing: boolean
}) {
  const controls = useRef<CameraControlsImpl>(null)
  const { camera, gl, size } = useThree()
  const latest = useRef({ bounds, size, hasParts })
  latest.current = { bounds, size, hasParts }
  const framed = useRef(false)
  const router = pointerRouterFor(gl.domElement)

  useLayoutEffect(() => {
    router.setPlacement(placing)
    return () => router.setPlacement(false)
  }, [router, placing])

  useEffect(() => {
    const control = controls.current
    if (!control) return
    const syncOwner = router.subscribe((owner) => {
      if (!cameraOwnsPointer(owner)) { control.cancel(); control.stop() }
      control.enabled = cameraOwnsPointer(owner)
    })
    const uninstall = installPointerRouter(gl.domElement, router, (dx, dy) => {
      const radiansPerPixel = 2 * Math.PI / Math.max(1, latest.current.size.height)
      void control.rotate(-dx * radiansPerPixel, -dy * radiansPerPixel, motion.policy.animated)
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
      mouseButtons={{ left: CameraControlsImpl.ACTION.ROTATE, middle: CameraControlsImpl.ACTION.DOLLY,
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
