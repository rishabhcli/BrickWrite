import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  allocateEdgeVertexCounts,
  DEFAULT_EDGE_BUDGET,
  EDGE_MOTION_SETTLE_SECONDS,
  movingEdgeShare,
  ndcHeightToPixels,
  type EdgeBudget,
} from './quality'

type Entry = { key: string; object: THREE.LineSegments }
const EdgeRegistry = createContext<Set<Entry> | null>(null)

/** How often the allocation is recomputed when nothing has changed, in seconds. */
const REALLOCATE_INTERVAL = 0.2

/**
 * Whether the camera has moved since the last frame.
 *
 * World matrix *and* projection: an orbit moves the former, a zoom on the
 * orthographic camera only moves the latter, and both change what the operator
 * is looking at. Compared exactly rather than with a tolerance — any change at
 * all is motion, which is the conservative direction: the cost of treating a
 * one-pixel nudge as motion is one cheap frame, the cost of missing a slow drag
 * is a stutter.
 *
 * The store is 64-bit because `Matrix4.elements` is. Narrowing it to 32 bits
 * rounds every element on the way in, so the comparison never matched and a
 * still camera reported motion on every single frame.
 */
export function cameraMoved(camera: THREE.Camera, previous: Float64Array): boolean {
  let moved = false
  const write = (offset: number, elements: THREE.Matrix4['elements']) => {
    for (let index = 0; index < 16; index += 1) {
      const value = elements[index]
      if (previous[offset + index] !== value) {
        previous[offset + index] = value
        moved = true
      }
    }
  }
  write(0, camera.matrixWorld.elements)
  write(16, camera.projectionMatrix.elements)
  return moved
}

/** Place inside Canvas, around PartBatch children. No React state is written on frames. */
export function EdgeLodProvider({ children, enabled = true, budget = DEFAULT_EDGE_BUDGET }: { children: ReactNode; enabled?: boolean; budget?: EdgeBudget }) {
  const registry = useMemo(() => new Set<Entry>(), [])
  const scratch = useMemo(() => ({ frustum: new THREE.Frustum(), projection: new THREE.Matrix4(), sphere: new THREE.Sphere(), center: new THREE.Vector3(), edge: new THREE.Vector3(), pose: new Float64Array(32) }), [])
  const last = useRef(-Infinity)
  const movingUntil = useRef(-Infinity)
  const applied = useRef({ share: -1, size: -1 })
  useFrame(({ camera, clock, size }) => {
    const now = clock.elapsedTime
    if (cameraMoved(camera, scratch.pose)) movingUntil.current = now + EDGE_MOTION_SETTLE_SECONDS
    const moving = now < movingUntil.current
    let total = 0
    for (const entry of registry) total += entry.object.geometry.getAttribute('position').count
    const share = movingEdgeShare(total, moving)
    // Recomputed on a timer as before, but *immediately* when the share changes:
    // waiting a fifth of a second to thin the edges spends the reduction on the
    // frames after the drag has already begun, which are the ones it was for.
    const changed = share !== applied.current.share || registry.size !== applied.current.size
    if (!changed && now - last.current < REALLOCATE_INTERVAL) return
    last.current = now
    applied.current = { share, size: registry.size }
    camera.updateMatrixWorld()
    scratch.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    scratch.frustum.setFromProjectionMatrix(scratch.projection)
    const candidates = []
    for (const entry of registry) {
      const { object } = entry
      object.updateWorldMatrix(true, false)
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere()
      if (!object.geometry.boundingSphere) continue
      scratch.sphere.copy(object.geometry.boundingSphere).applyMatrix4(object.matrixWorld)
      let screenPixels = 0
      if (enabled && scratch.frustum.intersectsSphere(scratch.sphere)) {
        // Project in camera space: depth naturally prioritizes nearby chunks.
        scratch.center.copy(scratch.sphere.center).applyMatrix4(camera.matrixWorldInverse)
        if (scratch.center.z + scratch.sphere.radius >= -camera.near) screenPixels = size.height
        else {
          scratch.edge.copy(scratch.center)
          scratch.edge.y += scratch.sphere.radius
          scratch.center.applyMatrix4(camera.projectionMatrix)
          scratch.edge.applyMatrix4(camera.projectionMatrix)
          // `applyMatrix4` already divides by w, so these are NDC. Converting
          // through a named function rather than inline is what let the factor
          // of two be found and asserted.
          screenPixels = ndcHeightToPixels(scratch.edge.y - scratch.center.y, size.height)
        }
      }
      // The motion share is applied to each batch's own demand rather than to
      // the scene's budget, so the reduction lands on every batch equally
      // instead of cutting whole part/colour groups out of the allocation.
      const vertices = Math.floor((object.geometry.getAttribute('position').count * share) / 2) * 2
      candidates.push({ key: entry.key, vertices, screenPixels })
    }
    const allocations = allocateEdgeVertexCounts(candidates, budget)
    for (const entry of registry) {
      const count = enabled ? allocations.get(entry.key) ?? 0 : 0
      entry.object.geometry.setDrawRange(0, count)
      entry.object.visible = count > 0
    }
  })
  return <EdgeRegistry.Provider value={registry}>{children}</EdgeRegistry.Provider>
}

export function useEdgeLodRegistration(key: string, object: React.RefObject<THREE.LineSegments | null>, geometry: THREE.BufferGeometry | null) {
  const registry = useContext(EdgeRegistry)
  useLayoutEffect(() => {
    if (!registry || !object.current || !geometry) return
    const entry = { key, object: object.current }
    // Budget is applied before showing a newly allocated edge buffer.
    entry.object.visible = false
    registry.add(entry)
    return () => { registry.delete(entry) }
  }, [registry, key, object, geometry])
}
