import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cameraMoved } from './EdgeLod'

/**
 * Motion detection for the edge allocator.
 *
 * The reduction is only applied while the camera is moving, so "is the camera
 * moving" has to be right in both directions: a missed drag is a stutter the
 * operator feels, and a false positive on a still camera thins the outlines of a
 * model nobody is moving.
 */
describe('camera motion', () => {
  it('reports a move once, then stillness', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(8, 6, 8)
    camera.updateMatrixWorld(true)
    const previous = new Float64Array(32)

    // The first sample has nothing to compare against and reads as movement,
    // which is what makes the first frame allocate rather than draw nothing.
    expect(cameraMoved(camera, previous)).toBe(true)
    expect(cameraMoved(camera, previous)).toBe(false)

    camera.position.x += 0.01
    camera.updateMatrixWorld(true)
    expect(cameraMoved(camera, previous)).toBe(true)
    expect(cameraMoved(camera, previous)).toBe(false)
  })

  it('sees an orthographic zoom, which moves no world matrix at all', () => {
    // The editor has an orthographic mode. Dollying it changes the projection
    // and nothing else, so a check that only watched `matrixWorld` would hold
    // full edge density through the one interaction that changes every pixel.
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 2000)
    camera.position.set(8, 6, 8)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    const previous = new Float64Array(32)
    cameraMoved(camera, previous)
    expect(cameraMoved(camera, previous)).toBe(false)

    camera.zoom = 2
    camera.updateProjectionMatrix()
    expect(cameraMoved(camera, previous)).toBe(true)
    expect(cameraMoved(camera, previous)).toBe(false)
  })

  it('sees a rotation with no translation', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(0, 0, 12)
    camera.updateMatrixWorld(true)
    const previous = new Float64Array(32)
    cameraMoved(camera, previous)
    expect(cameraMoved(camera, previous)).toBe(false)

    camera.rotateY(0.02)
    camera.updateMatrixWorld(true)
    expect(cameraMoved(camera, previous)).toBe(true)
  })
})
