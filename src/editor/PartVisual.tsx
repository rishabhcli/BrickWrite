import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { getColor } from '../cad/catalog'
import { geometryCache, MAIN_COLOUR, type PartGeometry } from '../cad/mesh'
import type { PartDefinition } from '../cad/types'

export type PartAppearance = 'solid' | 'selected' | 'ghost' | 'removed' | 'silhouette' | 'invalid'

interface PartVisualProps {
  definition: PartDefinition
  colorCode: number
  appearance?: PartAppearance
  showEdges?: boolean
}

/**
 * Renders one placed part from its compiled LDraw geometry.
 *
 * Geometry is shared per definition through `geometryCache`, so a model with a
 * thousand 2×4 bricks holds exactly one vertex buffer for them. Only the
 * instance transform and material differ.
 */

/** Materials are keyed by appearance and colour, so they are shared too. */
const materialCache = new Map<string, THREE.Material>()

export function surfaceMaterialFor(colorCode: number, appearance: PartAppearance): THREE.Material {
  const key = `${appearance}:${colorCode}`
  const cached = materialCache.get(key)
  if (cached) return cached

  const color = getColor(appearance === 'silhouette' ? 71 : colorCode)
  const transparent = color.alpha < 1
  const metallic = /chrome|metal|pearl/.test(color.finish)

  let material: THREE.Material
  if (appearance === 'ghost') {
    material = new THREE.MeshPhysicalMaterial({
      color: '#7ef2e2', roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.34,
      depthWrite: false, emissive: '#0b4c47', emissiveIntensity: 0.75, side: THREE.DoubleSide,
    })
  } else if (appearance === 'removed' || appearance === 'invalid') {
    material = new THREE.MeshPhysicalMaterial({
      color: '#ff5c48', roughness: 0.3, transparent: true, opacity: appearance === 'removed' ? 0.36 : 0.62,
      depthWrite: false, emissive: '#4b0e09', emissiveIntensity: 0.8, side: THREE.DoubleSide,
    })
  } else {
    // Injection-moulded ABS: a satin dielectric with a thin, slightly rough
    // clearcoat. The numbers are the ones that make a brick read as plastic
    // rather than as painted resin — a roughness near 0.28 keeps the broad
    // softbox highlight without turning the face into a mirror, and the
    // clearcoat supplies the second, tighter specular that polished ABS has.
    // Transparent elements are true transmission at ABS's own index of
    // refraction, so they bend what is behind them instead of just fading.
    material = new THREE.MeshPhysicalMaterial({
      color: color.hex,
      roughness: metallic ? 0.2 : transparent ? 0.06 : 0.28,
      metalness: metallic ? 0.9 : 0.0,
      clearcoat: metallic ? 0.2 : transparent ? 0.85 : 0.42,
      clearcoatRoughness: transparent ? 0.06 : 0.22,
      // Deliberately *not* `transmission`. Physical transmission renders the
      // whole scene again into a transmission target for every transmissive
      // draw: on a glazed building it took a 1,464-part model from 106 draw
      // calls a frame to 3,278. Alpha with a strong clearcoat and ABS's own
      // index of refraction reads as trans-plastic at a constant cost, which is
      // the right trade for a tool that has to hold thousands of parts.
      ior: 1.52,
      specularIntensity: 1,
      envMapIntensity: metallic ? 1.35 : 1,
      transparent,
      opacity: transparent ? Math.max(0.72, color.alpha) : 1,
      emissive: appearance === 'selected' ? '#3a2606' : '#000000',
      emissiveIntensity: appearance === 'selected' ? 0.55 : 0,
    })
  }
  materialCache.set(key, material)
  return material
}

const edgeMaterialCache = new Map<string, THREE.LineBasicMaterial>()

function edgeMaterial(colorCode: number, appearance: PartAppearance): THREE.LineBasicMaterial {
  const key = `${appearance}:${colorCode}`
  const cached = edgeMaterialCache.get(key)
  if (cached) return cached
  const base = getColor(colorCode)
  const material = new THREE.LineBasicMaterial({
    color: appearance === 'selected' ? '#f7b04a' : appearance === 'ghost' ? '#bafff5' : base.edge,
    transparent: true,
    opacity: appearance === 'selected' ? 0.95 : appearance === 'ghost' ? 0.4 : 0.26,
    depthWrite: false,
  })
  edgeMaterialCache.set(key, material)
  return material
}

/** Subscribes to the shared cache so a part appears as soon as its mesh lands. */
function usePartGeometry(definition: PartDefinition): PartGeometry | null {
  const [geometry, setGeometry] = useState<PartGeometry | null>(() => geometryCache.get(definition))
  useEffect(() => {
    let cancelled = false
    setGeometry(geometryCache.get(definition))
    void geometryCache.load(definition).then((loaded) => {
      if (!cancelled) setGeometry(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [definition])
  return geometry
}

export function PartVisual({ definition, colorCode, appearance = 'solid', showEdges = true }: PartVisualProps) {
  const geometry = usePartGeometry(definition)

  const materials = useMemo(() => {
    if (!geometry) return []
    // One material per compiled colour slice. Slice colour 16 means "use the
    // instance colour"; anything else is baked into the part, such as a black
    // rubber tyre or a printed face.
    return geometry.slices.map((slice) =>
      surfaceMaterialFor(slice.colour === MAIN_COLOUR ? colorCode : slice.colour, appearance),
    )
  }, [geometry, colorCode, appearance])

  if (!geometry) {
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

  const castShadow = appearance === 'solid' || appearance === 'selected' || appearance === 'silhouette'

  return (
    <group>
      <mesh geometry={geometry.surface} material={materials} castShadow={castShadow} receiveShadow={castShadow} />
      {showEdges && geometry.edges && appearance !== 'silhouette' && (
        <lineSegments geometry={geometry.edges} material={edgeMaterial(colorCode, appearance)} />
      )}
    </group>
  )
}
