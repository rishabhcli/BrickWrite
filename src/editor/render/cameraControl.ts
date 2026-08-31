import type CameraControls from 'camera-controls'
import * as THREE from 'three'
import type { Bounds } from '../../cad/types'
import { boundsFrame } from './framing'

export function cameraControlsOf(value: unknown): CameraControls | null {
  return value && typeof (value as CameraControls).getTarget === 'function' ? value as CameraControls : null
}
export function cameraTarget(value: unknown): THREE.Vector3 {
  return cameraControlsOf(value)?.getTarget(new THREE.Vector3()) ?? new THREE.Vector3()
}
/** All framing clients share the same aspect-correct fit and transition. */
export function frameCamera(controls: CameraControls, bounds: Pick<Bounds, 'min' | 'max'>,
  size: {width: number; height: number}, animated: boolean, direction?: THREE.Vector3) {
  const camera = controls.camera
  const fit = boundsFrame(camera, bounds, size, direction ?? controls.getPosition(new THREE.Vector3()).sub(cameraTarget(controls)))
  camera.far = fit.far
  camera.updateProjectionMatrix()
  void controls.setLookAt(...fit.position.toArray(), ...fit.target.toArray(), animated)
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) void controls.zoomTo(fit.zoom, animated)
  if (!animated) { controls.update(0); camera.updateMatrixWorld(true) }
}
export function cameraZoom(controls: CameraControls): number {
  return (JSON.parse(controls.toJSON()) as { zoom: number }).zoom
}
export function settleCamera(controls: CameraControls) {
  const position = controls.getPosition(new THREE.Vector3(), true)
  const target = controls.getTarget(new THREE.Vector3(), true)
  const zoom = cameraZoom(controls)
  void controls.setLookAt(...position.toArray(), ...target.toArray(), false)
  void controls.zoomTo(zoom, false)
  controls.update(0)
  controls.camera.updateMatrixWorld(true)
}
