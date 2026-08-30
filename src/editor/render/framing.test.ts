import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { boundsFrame } from './framing'
import { lduToScene } from './frame'

describe('camera framing', () => {
  for (const [width, height] of [
    [320, 900],
    [1200, 800],
    [2000, 400],
  ]) {
    for (const orthographic of [false, true]) {
      it(`fits all corners in ${width}x${height}, ortho=${orthographic}`, () => {
        const camera = orthographic
          ? new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 2000)
          : new THREE.PerspectiveCamera(34, width / height, 0.1, 2000)
        const box = { min: [-400, -280, -100] as const, max: [400, 0, 100] as const }
        const direction = new THREE.Vector3(0.86, 0.64, 1)
        const result = boundsFrame(camera, box, { width, height }, direction)
        camera.position.copy(result.position)
        camera.zoom = result.zoom
        camera.lookAt(result.target)
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld()
        for (const x of [box.min[0], box.max[0]]) {
          for (const y of [box.min[1], box.max[1]]) {
            for (const z of [box.min[2], box.max[2]]) {
              const projected = lduToScene([x, y, z]).project(camera)
              expect(Math.abs(projected.x)).toBeLessThan(0.84)
              expect(Math.abs(projected.y)).toBeLessThan(0.84)
            }
          }
        }
        expect(camera.position.clone().sub(result.target).normalize().distanceTo(direction.normalize())).toBeLessThan(
          1e-9,
        )
      })
    }
  }
  it('handles a perfectly vertical view and empty bounds without NaNs', () => {
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2000)
    const frame = boundsFrame(
      camera,
      { min: [0, 0, 0], max: [0, 0, 0] },
      { width: 300, height: 300 },
      new THREE.Vector3(0, 1, 0),
    )
    expect(frame.position.toArray().every(Number.isFinite)).toBe(true)
    expect(frame.zoom).toBeGreaterThan(0)
  })
})
