import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { PartDefinition } from '../../cad/types'
import type { ResolvedPlacement } from '../../cad/placement'
import { PartVisual } from '../PartVisual'
import { sceneMatrix } from './frame'
import type { MotionController } from './motion'

/** Display-only easing: commits always use the exact resolved kernel pose. */
export function PlacementGhost({ definition, color, placement, motion }: {
  definition: PartDefinition; color: number; placement: ResolvedPlacement; motion: MotionController
}) {
  const root = useRef<THREE.Group>(null)
  const initialized = useRef(false)
  const materials = useMemo(() => new Map<THREE.Material, number>(), [])
  const target = useMemo(() => {
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3()
    sceneMatrix(placement.transform).decompose(position, quaternion, scale)
    return { position, quaternion, scale }
  }, [placement.transform])
  useEffect(() => () => { for (const material of materials.keys()) material.dispose(); materials.clear() }, [materials])
  useFrame((_, delta) => {
    const group = root.current
    if (!group) return
    const amount = !initialized.current || !motion.policy.animated ? 1 : 1 - Math.exp(-32 * Math.min(delta, 0.1))
    group.position.lerp(target.position, amount)
    group.quaternion.slerp(target.quaternion, amount)
    group.scale.copy(target.scale)
    initialized.current = true
    const used = new Set<THREE.Material>()
    group.traverse((node) => {
      if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments)) return
      const own = (source: THREE.Material) => {
        if (materials.has(source)) return source
        const material = source.clone()
        materials.set(material, source.opacity)
        material.transparent = true
        material.depthWrite = false
        material.opacity = source.opacity
        return material
      }
      node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material)
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        used.add(material)
        const opacity = materials.get(material) ?? 1
        material.opacity += (opacity - material.opacity) * (motion.policy.animated ? 1 - Math.exp(-28 * delta) : 1)
      }
    })
    for (const material of materials.keys()) {
      if (!used.has(material)) { material.dispose(); materials.delete(material) }
    }
  })
  return <group ref={root}>
    <PartVisual key={definition.canonicalId} definition={definition} colorCode={color} appearance={placement.legal ? 'solid' : 'invalid'} fade={0.78} placeholder={false} />
  </group>
}
