import * as THREE from 'three'
import type { Bounds } from '../../cad/types'
import { lduToScene } from './frame'

/** Fit all eight corners, not just the longest edge. Narrow views need more distance. */
export function boundsFrame(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  bounds: Pick<Bounds, 'min' | 'max'>,
  size: { width: number; height: number },
  direction: THREE.Vector3,
  padding = 1.22,
) {
  const target = lduToScene(bounds.min).add(lduToScene(bounds.max)).multiplyScalar(0.5)
  const back = direction.clone().normalize()
  if (back.lengthSq() < 0.01) back.set(0.6, 0.5, 0.7).normalize()
  const right = new THREE.Vector3().crossVectors(camera.up, back)
  if (right.lengthSq() < 0.000001) right.set(1, 0, 0)
  right.normalize()
  const up = new THREE.Vector3().crossVectors(back, right).normalize()
  const aspect = Math.max(0.01, size.width / Math.max(1, size.height))
  const tanY =
    camera instanceof THREE.PerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) : 1
  let distance = 24
  let halfWidth = 6
  let halfHeight = 6
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const point = lduToScene([x, y, z]).sub(target)
        const horizontal = Math.abs(point.dot(right)) * padding
        const vertical = Math.abs(point.dot(up)) * padding
        const depth = point.dot(back)
        halfWidth = Math.max(halfWidth, horizontal)
        halfHeight = Math.max(halfHeight, vertical)
        distance = Math.max(distance, depth + horizontal / (tanY * aspect), depth + vertical / tanY)
      }
    }
  }
  const zoom =
    camera instanceof THREE.OrthographicCamera
      ? Math.min((camera.right - camera.left) / (2 * halfWidth), (camera.top - camera.bottom) / (2 * halfHeight))
      : camera.zoom
  return {
    target,
    position: target.clone().addScaledVector(back, distance),
    zoom,
    far: Math.max(2000, distance * 4 + 50),
  }
}
