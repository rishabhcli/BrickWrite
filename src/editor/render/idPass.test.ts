import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../cad/types'
import {
  documentRayFromCanvas,
  lduDirectionToScene,
  lduToScene,
  MODEL_ROOT_SCALE,
  projectLdu,
  sceneDirectionToLdu,
  sceneToLdu,
} from './frame'
import { OcclusionCycle, PICK_LAYER } from './idPass'

/**
 * The GPU pass itself needs a WebGL context and is exercised by
 * `tools/e2e/renderer.mjs` against a real one. What can be asserted here is
 * everything around it: the frame conversions the pass depends on, and the
 * cycling rules, which are an *interaction* concern rather than a buffer one.
 */

describe('the document frame', () => {
  it('puts LDraw’s +Y downward on screen-up', () => {
    // Getting this backwards mirrors the whole model, and every drag would move
    // the wrong way. It is worth one explicit assertion.
    const scene = lduToScene([0, 24, 0])
    expect(scene.y).toBeLessThan(0)
    expect(scene.y).toBeCloseTo(-24 * MODEL_ROOT_SCALE, 9)
  })

  it('round-trips a point through the root matrix', () => {
    const original: Vec3 = [37, -104, 12.5]
    const back = sceneToLdu(lduToScene(original))
    for (let axis = 0; axis < 3; axis += 1) expect(back[axis]).toBeCloseTo(original[axis], 6)
  })

  it('carries a direction without the root’s scale', () => {
    // A direction is not a point: carrying the 1/20 scale would return a ray
    // twenty times too long, and every closest-approach solve would report a
    // parameter in the wrong units.
    const direction = sceneDirectionToLdu(new THREE.Vector3(0, 1, 0))
    expect(Math.hypot(...direction)).toBeCloseTo(1, 9)
    expect(direction[1]).toBeCloseTo(-1, 9)
  })

  it('round-trips a direction', () => {
    const original: Vec3 = [0.6, -0.8, 0]
    const back = sceneDirectionToLdu(lduDirectionToScene(original))
    for (let axis = 0; axis < 3; axis += 1) expect(back[axis]).toBeCloseTo(original[axis], 6)
  })

  it('builds a document-space ray from a canvas point', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(0, 0, 60)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const ray = documentRayFromCanvas(camera, 800, 500, 1600, 1000)
    expect(Math.hypot(...ray.direction)).toBeCloseTo(1, 6)
    // The camera sits on scene +Z looking at the origin; in document space that
    // is −Z, because the root turns 180° about X.
    expect(ray.direction[2]).toBeGreaterThan(0.99)
  })

  it('projects a document point back to canvas pixels', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(0, 0, 60)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    const projected = projectLdu(camera, [0, 0, 0], 1600, 1000)
    expect(projected.x).toBeCloseTo(800, 3)
    expect(projected.y).toBeCloseTo(500, 3)
    expect(projected.behindCamera).toBe(false)
  })

  it('flags a point behind the camera', () => {
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 200)
    camera.position.set(0, 0, 60)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    // 4000 LDU behind the camera in document space, well past the far plane.
    expect(projectLdu(camera, [0, 0, 4000], 1600, 1000).behindCamera).toBe(true)
  })
})

describe('occlusion cycling', () => {
  it('walks strictly backwards through depth at one point', () => {
    const cycle = new OcclusionCycle()
    expect(cycle.hiddenFor(100, 100, 0)).toEqual([])
    cycle.record(7)
    expect(cycle.hiddenFor(100, 100, 100)).toEqual([7])
    cycle.record(9)
    expect(cycle.hiddenFor(101, 100, 200)).toEqual([7, 9])
  })

  it('restarts when the pointer moves off the point', () => {
    // An operator clicking a different brick means "select this", not "give me
    // the fourth thing behind the last one".
    const cycle = new OcclusionCycle(3, 1400)
    cycle.hiddenFor(100, 100, 0)
    cycle.record(7)
    expect(cycle.hiddenFor(140, 100, 100)).toEqual([])
  })

  it('restarts after the timeout', () => {
    const cycle = new OcclusionCycle(3, 500)
    cycle.hiddenFor(100, 100, 0)
    cycle.record(7)
    expect(cycle.hiddenFor(100, 100, 5000)).toEqual([])
  })

  it('loops back to the frontmost rather than becoming exhausted', () => {
    const cycle = new OcclusionCycle()
    cycle.hiddenFor(50, 50, 0)
    cycle.record(1)
    cycle.hiddenFor(50, 50, 10)
    // Hitting background means the stack ran out; the next click starts again.
    cycle.record(0)
    expect(cycle.hiddenFor(50, 50, 20)).toEqual([])
  })

  it('is bounded, because the shader carries a fixed number of slots', () => {
    const cycle = new OcclusionCycle()
    for (let step = 0; step < 12; step += 1) {
      cycle.hiddenFor(10, 10, step * 10)
      cycle.record(step + 1)
    }
    expect(cycle.depth).toBeLessThanOrEqual(8)
  })

  it('forgets everything on reset', () => {
    const cycle = new OcclusionCycle()
    cycle.hiddenFor(10, 10, 0)
    cycle.record(4)
    cycle.reset()
    expect(cycle.hiddenFor(10, 10, 10)).toEqual([])
  })
})

describe('the pick layer', () => {
  it('is not the default layer, so the id camera sees only pickable geometry', () => {
    // The grid, the contact shadow and the orientation gizmo all live on layer
    // 0; if picking shared it they would write identities of their own.
    expect(PICK_LAYER).not.toBe(0)
    const object = new THREE.Object3D()
    expect(object.layers.isEnabled(PICK_LAYER)).toBe(false)
  })
})
