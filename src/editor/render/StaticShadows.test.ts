import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { invalidateOnContextRestore, ShadowRefreshGate, shadowContentFingerprint } from './StaticShadows'

/**
 * The whole saving rests on one property, so it is asserted first and on its
 * own: **moving the camera must not change the fingerprint.** Both shadow passes
 * are rendered from the light and from a fixed patch camera, so a frame that
 * only changed the view can reuse them. A fingerprint that folded in the view
 * camera would mark every frame of an orbit as changed and hand the whole
 * reduction back — silently, because the picture would still be correct.
 */
describe('shadow content fingerprint', () => {
  const sceneWithBrick = () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mesh.castShadow = true
    scene.add(mesh)
    const light = new THREE.DirectionalLight()
    light.position.set(-16, 24, 13)
    scene.add(light)
    const camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 2000)
    camera.position.set(10, 10, 10)
    scene.add(camera)
    scene.updateMatrixWorld(true)
    return { scene, mesh, light, camera }
  }

  it('ignores the view camera', () => {
    const { scene, camera } = sceneWithBrick()
    const before = shadowContentFingerprint(scene)
    camera.position.set(-40, 22, 7)
    camera.lookAt(0, 0, 0)
    scene.updateMatrixWorld(true)
    expect(shadowContentFingerprint(scene)).toBe(before)
  })

  it('notices a part that moved', () => {
    const { scene, mesh } = sceneWithBrick()
    const before = shadowContentFingerprint(scene)
    mesh.position.x += 0.4
    scene.updateMatrixWorld(true)
    expect(shadowContentFingerprint(scene)).not.toBe(before)
  })

  it('notices the key light moving', () => {
    const { scene, light } = sceneWithBrick()
    const before = shadowContentFingerprint(scene)
    light.position.set(16, 24, 13)
    scene.updateMatrixWorld(true)
    expect(shadowContentFingerprint(scene)).not.toBe(before)
  })

  it('notices a part being hidden', () => {
    const { scene, mesh } = sceneWithBrick()
    const before = shadowContentFingerprint(scene)
    mesh.visible = false
    expect(shadowContentFingerprint(scene)).not.toBe(before)
  })

  it('notices a part being added and removed', () => {
    const { scene } = sceneWithBrick()
    const before = shadowContentFingerprint(scene)
    const extra = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    scene.add(extra)
    scene.updateMatrixWorld(true)
    const added = shadowContentFingerprint(scene)
    expect(added).not.toBe(before)
    scene.remove(extra)
    expect(shadowContentFingerprint(scene)).toBe(before)
  })

  it('notices a batch rewriting its instance matrices', () => {
    // The case that matters most in practice: a commit does not add or remove a
    // batch, it rewrites the instance buffer in place. Nothing about the object
    // changes except the buffer's version, so the version is in the digest.
    const scene = new THREE.Scene()
    const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 4)
    batch.count = 4
    for (let index = 0; index < 4; index += 1) {
      batch.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index, 0, 0))
    }
    scene.add(batch)
    scene.updateMatrixWorld(true)
    const before = shadowContentFingerprint(scene)

    batch.setMatrixAt(2, new THREE.Matrix4().makeTranslation(2, 3, 0))
    batch.instanceMatrix.needsUpdate = true
    expect(shadowContentFingerprint(scene)).not.toBe(before)
  })

  it('notices a batch changing how many instances it draws', () => {
    const scene = new THREE.Scene()
    const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 8)
    batch.count = 8
    scene.add(batch)
    scene.updateMatrixWorld(true)
    const before = shadowContentFingerprint(scene)
    batch.count = 5
    expect(shadowContentFingerprint(scene)).not.toBe(before)
  })
})

describe('shadow refresh gate', () => {
  it('renders once for a change and never for an unchanged frame', () => {
    const gate = new ShadowRefreshGate()
    // The first frame has nothing to reuse.
    expect(gate.sample(1234)).toBe(true)
    expect(gate.sample(1234)).toBe(false)
    expect(gate.sample(1234)).toBe(false)
    expect(gate.sample(5678)).toBe(true)
    expect(gate.sample(5678)).toBe(false)
  })

  it('can be forced, for a reallocated shadow map or a capture', () => {
    const gate = new ShadowRefreshGate()
    gate.sample(42)
    expect(gate.sample(42)).toBe(false)
    gate.invalidate()
    expect(gate.sample(42)).toBe(true)
  })
})

describe('a restored context', () => {
  it('redraws both passes, though nothing in the scene changed', () => {
    // The one event that empties the GPU's copy without touching the scene
    // graph: the shadow map and the contact target lived in the lost context,
    // and the fingerprint is identical either side of the loss. Gating the
    // shadows on content is what makes this necessary — without it the model
    // comes back sitting on nothing, and stays that way.
    const canvas = new EventTarget()
    const gate = new ShadowRefreshGate()
    const unsubscribe = invalidateOnContextRestore(canvas, gate)

    gate.sample(99)
    expect(gate.sample(99)).toBe(false)
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(gate.sample(99)).toBe(true)

    unsubscribe()
    expect(gate.sample(99)).toBe(false)
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(gate.sample(99)).toBe(false)
  })
})
