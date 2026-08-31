import { describe, expect, it } from 'vitest'
import CameraControls from 'camera-controls'
import * as THREE from 'three'
import { cameraTarget, frameCamera, settleCamera } from './cameraControl'
CameraControls.install({ THREE })
const bounds = { min: [0, -48, 0] as const, max: [200, 0, 100] as const }
describe('shared camera rig API', () => {
  it('interpolates named framing and settles exactly without changing document coordinates', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(30, 30, 30)
    const controls = new CameraControls(camera)
    const before = camera.position.clone()
    frameCamera(controls, bounds, {width: 1200, height: 750}, true, new THREE.Vector3(0, 0, 1))
    expect(camera.position.equals(before)).toBe(true)
    controls.update(0.08)
    const target = controls.getPosition(new THREE.Vector3(), true)
    expect(camera.position.equals(before)).toBe(false)
    expect(camera.position.distanceTo(target)).toBeGreaterThan(0.001)
    settleCamera(controls)
    expect(camera.position.distanceTo(target)).toBeLessThan(1e-8)
    expect(cameraTarget(controls).distanceTo(new THREE.Vector3(5, 1.2, -2.5))).toBeLessThan(1e-8)
    controls.dispose()
  })
  it('jumps immediately for reduced motion, including orthographic zoom', () => {
    const camera = new THREE.OrthographicCamera(-600, 600, 375, -375, 0.1, 2000)
    camera.position.set(30, 30, 30)
    const controls = new CameraControls(camera)
    frameCamera(controls, bounds, {width: 1200, height: 750}, false)
    expect(camera.position.distanceTo(controls.getPosition(new THREE.Vector3(), true))).toBeLessThan(1e-8)
    expect(camera.zoom).toBeGreaterThan(1)
    controls.dispose()
  })
})
