import { describe, expect, it } from 'vitest'
import {
  basisFromAxisAngle,
  basisFromEulerDegrees,
  composeTransform,
  determinantMat3,
  eulerDegreesFromBasis,
  IDENTITY_BASIS,
  IDENTITY_TRANSFORM,
  invertTransform,
  isOrthonormal,
  multiplyMat3,
  orthonormalize,
  poseDistance,
  rotateLocal,
  transformPoint,
  transformsEqual,
  type Mat3,
  type RigidTransform,
  type Vec3,
} from './math'

/** Deterministic pseudo-random source so failures are reproducible. */
function makeRandom(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

const randomTransform = (next: () => number): RigidTransform => ({
  position: [(next() - 0.5) * 400, (next() - 0.5) * 400, (next() - 0.5) * 400],
  basis: basisFromAxisAngle([next() - 0.5, next() - 0.5, next() - 0.5], next() * Math.PI * 2),
})

describe('rigid transform algebra', () => {
  it('inverts exactly', () => {
    const next = makeRandom(1)
    for (let trial = 0; trial < 200; trial += 1) {
      const transform = randomTransform(next)
      expect(transformsEqual(composeTransform(transform, invertTransform(transform)), IDENTITY_TRANSFORM, 1e-9)).toBe(true)
      expect(transformsEqual(composeTransform(invertTransform(transform), transform), IDENTITY_TRANSFORM, 1e-9)).toBe(true)
    }
  })

  it('composes associatively', () => {
    const next = makeRandom(2)
    for (let trial = 0; trial < 100; trial += 1) {
      const [a, b, c] = [randomTransform(next), randomTransform(next), randomTransform(next)]
      const left = composeTransform(composeTransform(a, b), c)
      const right = composeTransform(a, composeTransform(b, c))
      expect(transformsEqual(left, right, 1e-8)).toBe(true)
    }
  })

  it('agrees with point transformation under composition', () => {
    const next = makeRandom(3)
    for (let trial = 0; trial < 100; trial += 1) {
      const a = randomTransform(next)
      const b = randomTransform(next)
      const point: Vec3 = [(next() - 0.5) * 100, (next() - 0.5) * 100, (next() - 0.5) * 100]
      const chained = transformPoint(a, transformPoint(b, point))
      const composed = transformPoint(composeTransform(a, b), point)
      chained.forEach((value, axis) => expect(value).toBeCloseTo(composed[axis], 6))
    }
  })

  it('keeps bases orthonormal through repeated rotation', () => {
    let transform: RigidTransform = IDENTITY_TRANSFORM
    // Without re-orthonormalization this drifts; 4,000 quarter turns is a
    // deliberately punishing accumulation.
    for (let step = 0; step < 4000; step += 1) {
      transform = rotateLocal(transform, [0, 1, 0], Math.PI / 2)
    }
    expect(isOrthonormal(transform.basis, 1e-9)).toBe(true)
    expect(transformsEqual(transform, IDENTITY_TRANSFORM, 1e-6)).toBe(true)
  })

  it('preserves mirrored handedness when re-orthonormalizing', () => {
    const mirrored: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1]
    expect(determinantMat3(mirrored)).toBeLessThan(0)
    expect(determinantMat3(orthonormalize(mirrored))).toBeLessThan(0)
  })

  it('round-trips Euler degrees through a basis for display', () => {
    for (const rotation of [[0, 0, 0], [0, 90, 0], [0, 180, 0], [0, -90, 0], [90, 0, 0], [0, 0, 45]] as Vec3[]) {
      const basis = basisFromEulerDegrees(rotation)
      const recovered = basisFromEulerDegrees(eulerDegreesFromBasis(basis))
      recovered.forEach((value, index) => expect(value).toBeCloseTo(basis[index], 9))
    }
  })

  it('reports a half turn as a readable yaw rather than a gimbal pair', () => {
    expect(eulerDegreesFromBasis(basisFromEulerDegrees([0, 180, 0]))).toEqual([0, 180, 0])
    expect(eulerDegreesFromBasis(IDENTITY_BASIS)).toEqual([0, 0, 0])
  })

  it('measures pose separation with translation and rotation kept apart', () => {
    const a: RigidTransform = { position: [0, 0, 0], basis: IDENTITY_BASIS }
    const b: RigidTransform = { position: [3, 4, 0], basis: basisFromAxisAngle([0, 1, 0], Math.PI / 2) }
    const separation = poseDistance(a, b)
    expect(separation.translationLdu).toBeCloseTo(5, 9)
    expect(separation.rotationRad).toBeCloseTo(Math.PI / 2, 9)
  })

  it('multiplies matrices in row-major order', () => {
    const rotate90 = basisFromAxisAngle([0, 1, 0], Math.PI / 2)
    const twice = multiplyMat3(rotate90, rotate90)
    const half = basisFromAxisAngle([0, 1, 0], Math.PI)
    twice.forEach((value, index) => expect(value).toBeCloseTo(half[index], 9))
  })
})
