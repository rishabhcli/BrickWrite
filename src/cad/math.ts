/**
 * Rigid-transform algebra for the CAD kernel.
 *
 * The canonical orientation representation is an orthonormal **row-major 3×3
 * basis**, not Euler angles. That is deliberate:
 *
 *   - An LDraw type-1 reference already carries a translation plus a 3×3
 *     matrix, so import and export are lossless with no decomposition step.
 *   - Connector metadata from the LDCad Shadow Library is also expressed as
 *     frames, so the snap solver can compose frames directly instead of
 *     round-tripping through angles.
 *   - Euler decomposition is ambiguous at gimbal poses and loses the
 *     distinction between a rotation and a mirrored basis.
 *
 * Euler degrees survive only as a UI affordance and as a migration path for
 * documents written before this representation existed.
 */

export type Vec3 = readonly [number, number, number]

export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export interface RigidTransform {
  /** Document-space translation in LDraw units. */
  readonly position: Vec3
  /** Orthonormal local → document rotation, row-major. */
  readonly basis: Mat3
}

export const IDENTITY_BASIS: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export const IDENTITY_TRANSFORM: RigidTransform = { position: [0, 0, 0], basis: IDENTITY_BASIS }

const EPSILON = 1e-9

export const degreesToRadians = (degrees: number) => (degrees * Math.PI) / 180
export const radiansToDegrees = (radians: number) => (radians * 180) / Math.PI

// ---------------------------------------------------------------------------
// Matrix primitives
// ---------------------------------------------------------------------------

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] = a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]
    }
  }
  return out as unknown as Mat3
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

export function applyMat3(m: Mat3 | readonly number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

export function determinantMat3(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  )
}

/**
 * Re-orthonormalizes a basis with modified Gram-Schmidt.
 *
 * Repeated composition accumulates float error; without periodic
 * re-orthonormalization a part's basis slowly shears, which would corrupt both
 * connector frames and the exported LDraw matrix. Mirrored bases (negative
 * determinant) are preserved, because LDraw uses them legitimately.
 */
export function orthonormalize(m: Mat3): Mat3 {
  const rows: Vec3[] = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ]
  const mirrored = determinantMat3(m) < 0

  const out: Vec3[] = []
  for (const row of rows) {
    let [x, y, z] = row
    for (const previous of out) {
      const dot = x * previous[0] + y * previous[1] + z * previous[2]
      x -= dot * previous[0]
      y -= dot * previous[1]
      z -= dot * previous[2]
    }
    const length = Math.hypot(x, y, z)
    if (length < EPSILON) return mirrored ? [-1, 0, 0, 0, 1, 0, 0, 0, 1] : IDENTITY_BASIS
    out.push([x / length, y / length, z / length])
  }
  return [...out[0], ...out[1], ...out[2]] as unknown as Mat3
}

export function isOrthonormal(m: Mat3, tolerance = 1e-6): boolean {
  const product = multiplyMat3(m, transposeMat3(m))
  for (let index = 0; index < 9; index += 1) {
    if (Math.abs(product[index] - IDENTITY_BASIS[index]) > tolerance) return false
  }
  return true
}

/** Rotation about an arbitrary unit-normalizable axis (Rodrigues form). */
export function basisFromAxisAngle(axis: Vec3, radians: number): Mat3 {
  const length = Math.hypot(axis[0], axis[1], axis[2])
  if (length < EPSILON) return IDENTITY_BASIS
  const [x, y, z] = [axis[0] / length, axis[1] / length, axis[2] / length]
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  const t = 1 - c
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ]
}

/** Angle of the rotation carried by an orthonormal basis, in radians. */
export function basisAngle(m: Mat3): number {
  const trace = m[0] + m[4] + m[8]
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)))
}

// ---------------------------------------------------------------------------
// Rigid transforms
// ---------------------------------------------------------------------------

export function composeTransform(outer: RigidTransform, inner: RigidTransform): RigidTransform {
  const rotated = applyMat3(outer.basis, inner.position)
  return {
    position: [
      outer.position[0] + rotated[0],
      outer.position[1] + rotated[1],
      outer.position[2] + rotated[2],
    ],
    basis: multiplyMat3(outer.basis, inner.basis),
  }
}

export function invertTransform(transform: RigidTransform): RigidTransform {
  const inverse = transposeMat3(transform.basis)
  const moved = applyMat3(inverse, transform.position)
  return { position: [-moved[0], -moved[1], -moved[2]], basis: inverse }
}

export function transformPoint(transform: RigidTransform, local: Vec3): Vec3 {
  const rotated = applyMat3(transform.basis, local)
  return [
    transform.position[0] + rotated[0],
    transform.position[1] + rotated[1],
    transform.position[2] + rotated[2],
  ]
}

export function transformDirection(transform: RigidTransform, local: Vec3): Vec3 {
  return applyMat3(transform.basis, local)
}

export function translation(offset: Vec3): RigidTransform {
  return { position: offset, basis: IDENTITY_BASIS }
}

export function rotationAboutAxis(axis: Vec3, radians: number): RigidTransform {
  return { position: [0, 0, 0], basis: basisFromAxisAngle(axis, radians) }
}

/** Rotates a transform about an axis expressed in its own local frame. */
export function rotateLocal(transform: RigidTransform, axis: Vec3, radians: number): RigidTransform {
  return {
    position: transform.position,
    basis: orthonormalize(multiplyMat3(transform.basis, basisFromAxisAngle(axis, radians))),
  }
}

/**
 * Stable textual form of a transform, for comparison, deduplication and content
 * hashing. Quantizing to a fixed precision and fixing field order means two
 * transforms that are equal within tolerance compare equal as strings, which
 * `JSON.stringify` cannot guarantee.
 */
export function canonicalTransform(transform: RigidTransform, precision = 6): string {
  const scale = 10 ** precision
  const round = (value: number) => {
    const scaled = Math.round(value * scale) / scale
    return scaled === 0 ? 0 : scaled
  }
  return `${transform.position.map(round).join(',')}|${transform.basis.map(round).join(',')}`
}

/** Rotates a transform about a document-space axis through a document-space pivot. */
export function rotateWorld(transform: RigidTransform, axis: Vec3, radians: number, pivot: Vec3 = [0, 0, 0]): RigidTransform {
  const rotation = basisFromAxisAngle(axis, radians)
  const offset: Vec3 = [
    transform.position[0] - pivot[0],
    transform.position[1] - pivot[1],
    transform.position[2] - pivot[2],
  ]
  const moved = applyMat3(rotation, offset)
  return {
    position: [pivot[0] + moved[0], pivot[1] + moved[1], pivot[2] + moved[2]],
    basis: orthonormalize(multiplyMat3(rotation, transform.basis)),
  }
}

export function transformsEqual(a: RigidTransform, b: RigidTransform, tolerance = 1e-6): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(a.position[axis] - b.position[axis]) > tolerance) return false
  }
  for (let index = 0; index < 9; index += 1) {
    if (Math.abs(a.basis[index] - b.basis[index]) > tolerance) return false
  }
  return true
}

export interface PoseDistance {
  /** LDU between the two origins. */
  translationLdu: number
  /** Radians of relative rotation. */
  rotationRad: number
}

/**
 * Separation between two poses, used to rank snap candidates against the pose
 * the operator actually indicated. Translation and rotation stay separate so
 * the solver can weight them independently rather than inventing a single
 * unit-mixing scalar.
 */
export function poseDistance(a: RigidTransform, b: RigidTransform): PoseDistance {
  const relative = multiplyMat3(transposeMat3(a.basis), b.basis)
  return {
    translationLdu: Math.hypot(
      a.position[0] - b.position[0],
      a.position[1] - b.position[1],
      a.position[2] - b.position[2],
    ),
    rotationRad: basisAngle(relative),
  }
}

/** Axis-aligned document bounds of a rotated, translated local box. */
export function transformBounds(
  local: { min: Vec3; max: Vec3 },
  transform: RigidTransform,
): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let corner = 0; corner < 8; corner += 1) {
    const point = transformPoint(transform, [
      corner & 1 ? local.max[0] : local.min[0],
      corner & 2 ? local.max[1] : local.min[1],
      corner & 4 ? local.max[2] : local.min[2],
    ])
    for (let axis = 0; axis < 3; axis += 1) {
      if (point[axis] < min[axis]) min[axis] = point[axis]
      if (point[axis] > max[axis]) max[axis] = point[axis]
    }
  }
  return { min, max }
}

// ---------------------------------------------------------------------------
// Euler interop — UI affordance and schema migration only
// ---------------------------------------------------------------------------

/**
 * Builds a basis from Euler degrees composed as Rx · Ry · Rz, matching
 * three.js' default `XYZ` order. Used to migrate documents written before the
 * basis representation, and to interpret numeric rotation fields typed into the
 * inspector.
 */
export function basisFromEulerDegrees(rotation: Vec3): Mat3 {
  const [x, y, z] = rotation.map(degreesToRadians)
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

/**
 * Recovers display Euler degrees from a basis.
 *
 * Yaw-only orientations — the overwhelming majority of brick placements — are
 * detected first so a half turn reads as `[0, 180, 0]` rather than the
 * algebraically equivalent but unreadable `[180, 0, 180]` the general
 * decomposition produces.
 */
export function eulerDegreesFromBasis(m: Mat3): Vec3 {
  const yawOnly =
    Math.abs(m[1]) < 1e-9 && Math.abs(m[3]) < 1e-9 && Math.abs(m[5]) < 1e-9 && Math.abs(m[7]) < 1e-9 && m[4] > 0.9999
  if (yawOnly) return snapDegrees([0, Math.atan2(m[2], m[0]), 0])

  const clamped = Math.max(-1, Math.min(1, m[2]))
  const pitch = Math.asin(clamped)
  if (Math.abs(clamped) < 0.9999) {
    return snapDegrees([Math.atan2(-m[5], m[8]), pitch, Math.atan2(-m[1], m[0])])
  }
  // Gimbal-locked: fold the remaining freedom into the X rotation.
  return snapDegrees([Math.atan2(Math.sign(clamped) * m[3], m[4]), pitch, 0])
}

function snapDegrees(radians: readonly [number, number, number]): Vec3 {
  return radians.map((value) => {
    const degrees = radiansToDegrees(value)
    const rounded = Math.round(degrees)
    // Whole-degree placements lose float noise; genuinely off-angle articulated
    // poses keep four decimals.
    if (Math.abs(degrees - rounded) < 1e-6) return rounded === 0 ? 0 : rounded
    return Number(degrees.toFixed(4))
  }) as unknown as Vec3
}

/** Rounds a basis's near-integer entries, keeping exported matrices readable. */
export function cleanBasis(m: Mat3): Mat3 {
  return m.map((value) => {
    const rounded = Math.round(value)
    return Math.abs(value - rounded) < 1e-9 ? (rounded === 0 ? 0 : rounded) : value
  }) as unknown as Mat3
}

export const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export const addVec = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

export const subVec = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

export const scaleVec = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor]

export const dotVec = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function normalizeVec(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2])
  return length < EPSILON ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length]
}
