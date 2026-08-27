import type { Transform, Vec3 } from './types'

/**
 * Rigid-transform helpers shared by the kernel, the snap solver and the LDraw
 * serializer.
 *
 * Rotations are Euler degrees composed as Rx · Ry · Rz, matching three.js'
 * default `XYZ` Euler order, so a document rotation can be handed to a scene
 * object unchanged. Matrices are row-major 3×3 in the same layout LDraw type-1
 * lines use, so export needs no transposition.
 */

export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY_MATRIX: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

const radians = (degrees: number) => (degrees * Math.PI) / 180

export function eulerToMatrix(rotation: Vec3): Matrix3 {
  const [x, y, z] = rotation.map(radians)
  const cx = Math.cos(x)
  const sx = Math.sin(x)
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  const cz = Math.cos(z)
  const sz = Math.sin(z)
  return [
    cy * cz,
    -cy * sz,
    sy,
    cx * sz + cz * sx * sy,
    cx * cz - sx * sy * sz,
    -cy * sx,
    sx * sz - cx * cz * sy,
    cz * sx + cx * sy * sz,
    cx * cy,
  ]
}

export function multiplyMatrix(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] = a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]
    }
  }
  return out as unknown as Matrix3
}

export function applyMatrix(matrix: Matrix3 | readonly number[], point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2],
  ]
}

/** Maps a point from a part's local LDraw frame into model space. */
export function localToModel(transform: Transform, local: Vec3): Vec3 {
  const rotated = applyMatrix(eulerToMatrix(transform.rotation), local)
  return [
    transform.position[0] + rotated[0],
    transform.position[1] + rotated[1],
    transform.position[2] + rotated[2],
  ]
}

/** Axis-aligned bounds of a rotated, translated local box. */
export function transformBounds(
  local: { min: Vec3; max: Vec3 },
  transform: Transform,
): { min: Vec3; max: Vec3 } {
  const matrix = eulerToMatrix(transform.rotation)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let corner = 0; corner < 8; corner += 1) {
    const point: Vec3 = [
      corner & 1 ? local.max[0] : local.min[0],
      corner & 2 ? local.max[1] : local.min[1],
      corner & 4 ? local.max[2] : local.min[2],
    ]
    const rotated = applyMatrix(matrix, point)
    for (let axis = 0; axis < 3; axis += 1) {
      const value = transform.position[axis] + rotated[axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  return { min, max }
}

export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export const addVec = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

export const subVec = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
