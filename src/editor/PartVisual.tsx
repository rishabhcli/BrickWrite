import { memo, useMemo } from 'react'
import * as THREE from 'three'
import { getColor } from '../cad/catalog'
import { MAIN_COLOUR } from '../cad/mesh'
import { usePartGeometry } from './render/usePartGeometry'
import type { PartDefinition } from '../cad/types'

export type PartAppearance = 'solid' | 'selected' | 'target' | 'ghost' | 'removed' | 'silhouette' | 'invalid'

interface PartVisualProps {
  definition: PartDefinition
  colorCode: number
  appearance?: PartAppearance
  showEdges?: boolean
  /** Opacity multiplier for ghosted context, 0–1. */
  fade?: number
  /** Held parts must never impersonate their shape with a bounding box. */
  placeholder?: boolean
}

/**
 * Renders one placed part from its compiled LDraw geometry.
 *
 * Geometry is shared per definition through `geometryCache`, so a model with a
 * thousand 2×4 bricks holds exactly one vertex buffer for them. Only the
 * instance transform and material differ.
 */

/** Materials are keyed by appearance, colour and fade, so they are shared too. */
const materialCache = new Map<string, THREE.Material>()

/**
 * Whether transparent elements are rendered with true transmission.
 *
 * Physical transmission renders the scene again into a transmission target for
 * every transmissive draw. On a glazed building that took a 1,464-part model
 * from 106 draw calls a frame to 3,278, which is why the default is the alpha
 * approximation — a strong clearcoat at ABS's own index of refraction, which
 * reads as trans-plastic at constant cost.
 *
 * It is a *budget*, not a ban. Transmission is what makes a trans-clear
 * windscreen refract the studs behind it instead of merely tinting them, and on
 * a model with a handful of transparent parts that is worth one extra pass. The
 * viewport counts the transparent draws it is about to issue and switches here;
 * the count, not a guess about the machine, is what decides.
 */
let transmissionEnabled = false

/** Transparent draws above which transmission is switched off. Measured, not assumed. */
export const TRANSMISSION_DRAW_BUDGET = 6

/**
 * Turns real transmission on or off. Returns true when the setting changed,
 * which the caller uses to know a material rebuild is needed.
 */
export function setTransmissionEnabled(enabled: boolean): boolean {
  if (transmissionEnabled === enabled) return false
  transmissionEnabled = enabled
  // Cached materials were built for the previous setting. Disposing them is
  // correct: they are unreachable from any future call, so keeping them would be
  // the leak this renderer's disposal tests exist to catch.
  for (const [key, material] of materialCache) {
    if (key.startsWith('t1:') || key.startsWith('t0:')) {
      material.dispose()
      materialCache.delete(key)
    }
  }
  return true
}

export const isTransmissionEnabled = () => transmissionEnabled

export interface SurfaceOptions {
  /** Opacity multiplier for ghosted context. */
  readonly fade?: number
}

/**
 * Low-frequency roughness variation, injected rather than mapped.
 *
 * Compiled LDraw geometry carries positions, normals and indices — no texture
 * coordinates, because LDraw parts have none to carry. A `roughnessMap` would
 * therefore sample one texel for the whole model. The variation is instead
 * derived from world position at about half a stud, which is the scale at which
 * real moulded ABS varies: flow lines and mould texture across a face, not
 * per-pixel grain. Quantizing to cells keeps it stable under motion, so it reads
 * as surface rather than as shimmer.
 */
function applyMouldedFinish(material: THREE.MeshPhysicalMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBrickWorld;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vBrickWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
        #else
          vBrickWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBrickWorld;')
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float bwCell = fract( sin( dot( floor( vBrickWorld * 1.7 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
        roughnessFactor = clamp( roughnessFactor * ( 0.88 + 0.24 * bwCell ), 0.015, 1.0 );`,
      )
  }
  // Two materials that differ only in this hook would otherwise share a
  // compiled program, because three keys programs by the material's own
  // parameters and not by the source it was rewritten into.
  material.customProgramCacheKey = () => 'bw-moulded'
}

export function surfaceMaterialFor(
  colorCode: number,
  appearance: PartAppearance,
  options: SurfaceOptions = {},
): THREE.Material {
  const fade = Math.round(Math.min(1, Math.max(0, options.fade ?? 1)) * 100) / 100
  const key = `${transmissionEnabled ? 't1' : 't0'}:${appearance}:${colorCode}:${fade}`
  const cached = materialCache.get(key)
  if (cached) return cached

  const color = getColor(appearance === 'silhouette' ? 71 : colorCode)
  const transparent = color.alpha < 1
  const finish = color.finish.toLowerCase()
  const chrome = /chrome/.test(finish)
  const pearl = /pearl/.test(finish)
  const metallic = chrome || pearl || /metal/.test(finish)

  let material: THREE.Material
  if (appearance === 'ghost') {
    material = new THREE.MeshPhysicalMaterial({
      color: '#7ef2e2', roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.34 * fade,
      depthWrite: false, emissive: '#0b4c47', emissiveIntensity: 0.75, side: THREE.DoubleSide,
    })
  } else if (appearance === 'removed' || appearance === 'invalid') {
    material = new THREE.MeshPhysicalMaterial({
      color: '#ff5c48', roughness: 0.3, transparent: true, opacity: (appearance === 'removed' ? 0.36 : 0.62) * fade,
      depthWrite: false, emissive: '#4b0e09', emissiveIntensity: 0.8, side: THREE.DoubleSide,
    })
  } else {
    // Injection-moulded ABS: a satin dielectric with a thin, slightly rough
    // clearcoat. The numbers are the ones that make a brick read as plastic
    // rather than as painted resin — a roughness near 0.28 keeps the broad
    // softbox highlight without turning the face into a mirror, and the
    // clearcoat supplies the second, tighter specular that polished ABS has.
    //
    // The three metallic finishes are genuinely different materials and are
    // treated as such: chrome is a near-mirror conductor, a metallic paint is a
    // rougher one, and pearl is a dielectric with a thin interference film over
    // it — which is what `iridescence` models, and what makes pearl gold read as
    // pearl rather than as flat gold.
    const physical = new THREE.MeshPhysicalMaterial({
      color: color.hex,
      roughness: chrome ? 0.07 : pearl ? 0.32 : metallic ? 0.2 : transparent ? 0.05 : 0.28,
      metalness: chrome ? 1 : pearl ? 0.55 : metallic ? 0.9 : 0,
      clearcoat: metallic ? 0.2 : transparent ? 0.9 : 0.42,
      clearcoatRoughness: transparent ? 0.05 : 0.22,
      iridescence: pearl ? 0.35 : 0,
      iridescenceIOR: 1.6,
      iridescenceThicknessRange: [180, 420],
      // Polycarbonate's own index of refraction. Used by the alpha path for its
      // Fresnel term and by the transmission path for actual refraction, so the
      // two agree about the material even though they differ in cost.
      ior: 1.52,
      specularIntensity: 1,
      envMapIntensity: chrome ? 1.6 : metallic ? 1.35 : 1,
      transparent: transparent || fade < 1,
      opacity: (transparent ? Math.max(0.72, color.alpha) : 1) * fade,
      polygonOffset: appearance === 'selected' || appearance === 'target',
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      emissive: appearance === 'selected' ? '#3a2606' : appearance === 'target' ? '#053b3a' : '#000000',
      emissiveIntensity: appearance === 'selected' || appearance === 'target' ? 0.55 : 0,
    })
    if (transparent && transmissionEnabled && fade >= 1) {
      // True transmission: opacity returns to 1 and the transparency comes from
      // light passing *through* the solid, with thickness driving the tint. A
      // brick wall is ~24 LDU thick, which in scene units is 1.2.
      physical.transmission = Math.min(0.96, 1 - color.alpha * 0.35)
      physical.opacity = 1
      physical.thickness = 1.2
      physical.attenuationDistance = 6
      physical.attenuationColor = new THREE.Color(color.hex)
      physical.roughness = 0.03
    }
    if (appearance !== 'silhouette') applyMouldedFinish(physical)
    material = physical
  }
  materialCache.set(key, material)
  return material
}

/** Live material count, so a disposal test can assert the cache is bounded. */
export const cachedMaterialCount = () => materialCache.size

const edgeMaterialCache = new Map<string, THREE.LineBasicMaterial>()

function edgeMaterial(colorCode: number, appearance: PartAppearance): THREE.LineBasicMaterial {
  const key = `${appearance}:${colorCode}`
  const cached = edgeMaterialCache.get(key)
  if (cached) return cached
  const base = getColor(colorCode)
  const material = new THREE.LineBasicMaterial({
    color: appearance === 'selected' ? '#f7b04a' : appearance === 'target' ? '#7cefe7' : appearance === 'ghost' ? '#bafff5' : base.edge,
    transparent: true,
    opacity: appearance === 'selected' || appearance === 'target' ? 0.95 : appearance === 'ghost' ? 0.4 : 0.26,
    depthWrite: false,
  })
  edgeMaterialCache.set(key, material)
  return material
}

export const PartVisual = memo(function PartVisual({ definition, colorCode, appearance = 'solid', showEdges = true, fade = 1, placeholder = true }: PartVisualProps) {
  const geometry = usePartGeometry(definition)

  const materials = useMemo(() => {
    if (!geometry) return []
    // One material per compiled colour slice. Slice colour 16 means "use the
    // instance colour"; anything else is baked into the part, such as a black
    // rubber tyre or a printed face.
    return geometry.slices.map((slice) =>
      surfaceMaterialFor(slice.colour === MAIN_COLOUR ? colorCode : slice.colour, appearance, { fade }),
    )
  }, [geometry, colorCode, appearance, fade])

  if (!geometry) {
    if (!placeholder) return null
    // Placeholder while the mesh streams in: an accurate wireframe box from the
    // compiled bounds, never invented brick-shaped geometry.
    const bounds = definition.dimensions?.bounds
    if (!bounds) return null
    const size: [number, number, number] = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ]
    const center: [number, number, number] = [
      (bounds.max[0] + bounds.min[0]) / 2,
      (bounds.max[1] + bounds.min[1]) / 2,
      (bounds.max[2] + bounds.min[2]) / 2,
    ]
    return (
      <mesh position={center}>
        <boxGeometry args={size} />
        <meshBasicMaterial color={getColor(colorCode).hex} wireframe transparent opacity={0.4} />
      </mesh>
    )
  }

  const castShadow = appearance === 'solid' || appearance === 'selected' || appearance === 'target' || appearance === 'silhouette'

  return (
    <group>
      <mesh geometry={geometry.surface} material={materials} castShadow={castShadow} receiveShadow={castShadow} />
      {showEdges && geometry.edges && appearance !== 'silhouette' && (
        <lineSegments geometry={geometry.edges} material={edgeMaterial(colorCode, appearance)} />
      )}
    </group>
  )
})
