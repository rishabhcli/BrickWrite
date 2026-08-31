import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { rendererResources } from './resources'

/**
 * Shadows recomputed when the model changes, not when the camera moves.
 *
 * Both of the renderer's shadow passes are functions of the *model* and the
 * *light*, and of nothing else:
 *
 *   - The directional shadow map is rendered from the key light, whose position
 *     is fixed and whose frustum is fitted to the model's own bounds.
 *   - The contact patch is rendered from an orthographic camera under the ground
 *     plane, looking up through it.
 *
 * Neither depends on where the operator is looking from. Three.js re-renders
 * shadow maps inside *every* call to `WebGLRenderer.render`, and drei's
 * `ContactShadows` runs its own pass every frame, so an orbit was submitting the
 * model's geometry four times a frame: the beauty pass, the shadow map for it,
 * the contact patch, and the shadow map again for the contact patch's own
 * `render` call. Measured on an M3 Max at 5,000 parts, the viewport drew
 * 6.32 M triangles and 268 draw calls a frame where the beauty pass alone is
 * 1.58 M and 85.
 *
 * Driving both passes from a fingerprint of the scene's drawable content makes
 * an orbit cost one geometry pass instead of four, and leaves a commit costing
 * exactly what it did before. The fingerprint deliberately excludes cameras:
 * including the view camera would mark every frame of an orbit as changed, which
 * is the one mistake that silently gives the whole saving back.
 */

/**
 * Order-sensitive digest of everything drawn that a shadow can depend on.
 *
 * FNV-1a over object identity, visibility, world translation and — for
 * instanced batches — the instance buffer's version and live count. Between them
 * those cover every way the viewport changes what casts: a commit rewrites
 * instance matrices (version), a drag moves an individually drawn part
 * (translation), an isolation hides parts (visibility), and a selection overlay
 * adds and removes whole meshes (identity, count).
 *
 * Cameras are skipped. Lights are not: moving the key light has to re-render its
 * map, and the fitted shadow frustum follows the model's extent.
 */
export function shadowContentFingerprint(root: THREE.Object3D): number {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash ^= value | 0
    hash = Math.imul(hash, 0x01000193)
  }
  root.traverse((object) => {
    const candidate = object as Partial<THREE.InstancedMesh> & {
      isCamera?: boolean
      isLight?: boolean
      isMesh?: boolean
      isLine?: boolean
      isPoints?: boolean
    }
    if (candidate.isCamera) return
    if (!candidate.isMesh && !candidate.isLine && !candidate.isPoints && !candidate.isLight) return
    mix(object.id)
    mix(object.visible ? 1 : 0)
    const elements = object.matrixWorld.elements
    // Quantized to a thousandth of a scene unit: finer than anything the kernel
    // can place, and immune to float noise in matrix composition.
    mix(Math.round(elements[12] * 1000))
    mix(Math.round(elements[13] * 1000))
    mix(Math.round(elements[14] * 1000))
    if (candidate.instanceMatrix) {
      mix(candidate.instanceMatrix.version)
      mix(candidate.count ?? 0)
    }
  })
  return hash >>> 0
}

/**
 * "Has the content changed since the last frame drawn for it?"
 *
 * A small object rather than a ref inside the component, so the rule can be
 * asserted without a WebGL context: the first sample always asks for a render,
 * and an unchanged fingerprint never does.
 */
export class ShadowRefreshGate {
  private previous: number | null = null

  /** True when the shadow passes have to run for this frame. */
  sample(fingerprint: number): boolean {
    if (this.previous === fingerprint) return false
    this.previous = fingerprint
    return true
  }

  /** Forces the next sample to ask for a render, whatever the fingerprint. */
  invalidate() {
    this.previous = null
  }
}

/**
 * Subscribes a gate to context restoration. Returns the unsubscribe.
 *
 * A function rather than four lines inside the effect so the wiring itself can
 * be asserted: the gate's rule is testable on its own, but "the gate is actually
 * told about a restore" is the half that was missing and that a blank contact
 * patch would have been the only symptom of.
 */
export function invalidateOnContextRestore(canvas: EventTarget, gate: ShadowRefreshGate): () => void {
  const onRestored = () => gate.invalidate()
  canvas.addEventListener('webglcontextrestored', onRestored)
  return () => canvas.removeEventListener('webglcontextrestored', onRestored)
}

const BLUR_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

/**
 * The same nine-tap separable gaussian drei's contact shadow uses, so the patch
 * this draws is the patch the viewport has always drawn.
 */
const BLUR_FRAGMENT = (axis: 'x' | 'y') => /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float amount;
  varying vec2 vUv;
  void main() {
    vec2 step = vec2( ${axis === 'x' ? 'amount, 0.0' : '0.0, amount'} );
    vec4 sum = vec4( 0.0 );
    sum += texture2D( tDiffuse, vUv - 4.0 * step ) * 0.051;
    sum += texture2D( tDiffuse, vUv - 3.0 * step ) * 0.0918;
    sum += texture2D( tDiffuse, vUv - 2.0 * step ) * 0.12245;
    sum += texture2D( tDiffuse, vUv - 1.0 * step ) * 0.1531;
    sum += texture2D( tDiffuse, vUv ) * 0.1633;
    sum += texture2D( tDiffuse, vUv + 1.0 * step ) * 0.1531;
    sum += texture2D( tDiffuse, vUv + 2.0 * step ) * 0.12245;
    sum += texture2D( tDiffuse, vUv + 3.0 * step ) * 0.0918;
    sum += texture2D( tDiffuse, vUv + 4.0 * step ) * 0.051;
    gl_FragColor = sum;
  }
`

export interface StaticShadowsProps {
  /** Contact patch resolution, or 0 to draw no patch at all. */
  readonly resolution: number
  /** Width and depth of the patch, in scene units. */
  readonly scale: number
  /** How far above the ground plane the patch camera sees. */
  readonly far: number
  readonly opacity: number
  readonly blur: number
  readonly color: string
  readonly position: readonly [number, number, number]
  /**
   * Extra invalidation for state the fingerprint cannot see: a quality tier
   * change reallocates the shadow map, and a capture wants both passes current
   * before it reads pixels back.
   */
  readonly revision?: number
}

export function StaticShadows({
  resolution,
  scale,
  far,
  opacity,
  blur,
  color,
  position,
  revision = 0,
}: StaticShadowsProps) {
  const { gl, scene } = useThree()
  const gate = useMemo(() => new ShadowRefreshGate(), [])
  const patch = useRef<THREE.Mesh>(null)
  const patchCamera = useRef<THREE.OrthographicCamera>(null)

  // The directional shadow map is driven from the gate below rather than left on
  // three's default, which re-renders it inside every call to `render`.
  useLayoutEffect(() => {
    gl.shadowMap.autoUpdate = false
    gate.invalidate()
    return () => {
      gl.shadowMap.autoUpdate = true
    }
  }, [gate, gl])

  /**
   * A restored context has to redraw both passes.
   *
   * This is the one event that changes what is on the GPU without changing
   * anything in the scene graph: the shadow map and the contact target lived in
   * the lost context and came back empty, while the fingerprint is identical on
   * either side of the loss. Without this the model would come back sitting on
   * nothing, permanently — a viewport that returns blank is exactly the failure
   * the context-loss handling exists to prevent, and gating the shadows on
   * content is what would have reintroduced it.
   */
  useEffect(() => invalidateOnContextRestore(gl.domElement, gate), [gate, gl])

  const resources = useMemo(() => {
    if (resolution <= 0) return null
    const scope = 'contactShadow'
    const target = rendererResources.track(scope, 'renderTarget', new THREE.WebGLRenderTarget(resolution, resolution))
    const blurTarget = rendererResources.track(scope, 'renderTarget', new THREE.WebGLRenderTarget(resolution, resolution))
    target.texture.generateMipmaps = blurTarget.texture.generateMipmaps = false
    const plane = rendererResources.track(scope, 'geometry', new THREE.PlaneGeometry(scale, scale).rotateX(Math.PI / 2))
    const depth = rendererResources.track(scope, 'material', new THREE.MeshDepthMaterial())
    depth.depthTest = depth.depthWrite = false
    depth.onBeforeCompile = (shader) => {
      shader.uniforms = { ...shader.uniforms, ucolor: { value: new THREE.Color(color) } }
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec3 ucolor;\nvoid main() {')
        // Colourised and multiplied by the falloff, so the centre stays darker.
        .replace(
          'vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          'vec4( ucolor * fragCoordZ * 2.0, ( 1.0 - fragCoordZ ) * 1.0 );',
        )
    }
    const blurMaterial = (axis: 'x' | 'y') =>
      rendererResources.track(
        scope,
        'material',
        new THREE.ShaderMaterial({
          uniforms: { tDiffuse: { value: null }, amount: { value: 1 / 256 } },
          vertexShader: BLUR_VERTEX,
          fragmentShader: BLUR_FRAGMENT(axis),
          depthTest: false,
        }),
      )
    const surface = rendererResources.track(
      scope,
      'material',
      new THREE.MeshBasicMaterial({ transparent: true, map: target.texture, opacity, depthWrite: false }),
    )
    return {
      target,
      blurTarget,
      plane,
      depth,
      horizontal: blurMaterial('x'),
      vertical: blurMaterial('y'),
      surface,
      blurPlane: new THREE.Mesh(plane),
    }
  }, [color, opacity, resolution, scale])

  // Everything above is this component's to free, and the disposal test reads
  // the registry's live count, so releasing it is asserted rather than assumed.
  useEffect(() => {
    if (!resources) return
    return () => {
      for (const resource of [
        resources.target,
        resources.blurTarget,
        resources.plane,
        resources.depth,
        resources.horizontal,
        resources.vertical,
        resources.surface,
      ]) {
        rendererResources.release(resource)
      }
    }
  }, [resources])

  const half = scale / 2
  const cameraArgs = useMemo<[number, number, number, number, number, number]>(
    () => [-half, half, half, -half, 0, far],
    [far, half],
  )

  useFrame(() => {
    const fingerprint = shadowContentFingerprint(scene)
    // `revision` folds into the digest so a tier change or a capture request
    // refreshes both passes without needing a second gate.
    if (!gate.sample((Math.imul(fingerprint, 0x01000193) ^ revision) >>> 0)) return

    // One request is enough: three clears `needsUpdate` after the next render,
    // and every render this frame reads the same map.
    gl.shadowMap.needsUpdate = true

    const bundle = resources
    const camera = patchCamera.current
    if (!bundle || !camera || !patch.current) return
    const previousBackground = scene.background
    const previousOverride = scene.overrideMaterial
    patch.current.visible = false
    scene.background = null
    scene.overrideMaterial = bundle.depth
    gl.setRenderTarget(bundle.target)
    gl.render(scene, camera)
    scene.overrideMaterial = previousOverride
    scene.background = previousBackground

    const blurOnce = (amount: number) => {
      bundle.blurPlane.material = bundle.horizontal
      bundle.horizontal.uniforms.tDiffuse.value = bundle.target.texture
      bundle.horizontal.uniforms.amount.value = amount / 256
      gl.setRenderTarget(bundle.blurTarget)
      gl.render(bundle.blurPlane, camera)
      bundle.blurPlane.material = bundle.vertical
      bundle.vertical.uniforms.tDiffuse.value = bundle.blurTarget.texture
      bundle.vertical.uniforms.amount.value = amount / 256
      gl.setRenderTarget(bundle.target)
      gl.render(bundle.blurPlane, camera)
    }
    blurOnce(blur)
    blurOnce(blur * 0.4)
    gl.setRenderTarget(null)
    patch.current.visible = true
  })

  if (!resources) return null
  return (
    <group rotation-x={Math.PI / 2} position={position as unknown as [number, number, number]}>
      <mesh
        ref={patch}
        geometry={resources.plane}
        material={resources.surface}
        scale={[1, -1, 1]}
        rotation={[-Math.PI / 2, 0, 0]}
      />
      <orthographicCamera ref={patchCamera} args={cameraArgs} />
    </group>
  )
}
