import { describe, expect, it } from 'vitest'
import { canMirror, mirrorPlaneFor, mirrorTransform, type MirrorAxis } from './mirror'
import { applyMat3, basisFromAxisAngle, determinantMat3, IDENTITY_BASIS } from './math'
import { createEmptyDocument } from './sample'
import type { ModelDocument, PartInstance, Transform, Vec3 } from './types'

const place = (definitionId: string, transform: Transform): PartInstance => ({
  id: 'p',
  definitionId,
  color: 72,
  transform,
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const documentWith = (part: PartInstance): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: { [part.id]: part },
    subassemblies: { ...base.subassemblies, hull: { ...base.subassemblies.hull, partIds: [part.id] } },
  }
}

const worldPoint = (transform: Transform, local: Vec3): Vec3 => {
  const rotated = applyMat3(transform.basis, local)
  return [rotated[0] + transform.position[0], rotated[1] + transform.position[1], rotated[2] + transform.position[2]]
}

const reflect = (point: Vec3, axis: MirrorAxis, plane: number): Vec3 => {
  const out: Vec3 = [point[0], point[1], point[2]]
  out[axis] = 2 * plane - out[axis]
  return out
}

const round = (v: readonly number[]) => v.map((n) => Math.round(n * 1e6) / 1e6)

describe('mirroring a placement', () => {
  /**
   * The property that defines a mirror, and the one a position-only test misses.
   *
   * A reflection sends the point at local coordinate `L` to the reflection of
   * where it was. Because the emitted basis is a *rotation* — the part is never
   * turned inside out — the local coordinate reflects too: the mirrored pose
   * must carry `M·L` to `reflect(B·L + P)`.
   *
   * This is the assertion that catches composition order. `M·B·M` satisfies it;
   * `B·M`, which reflects in the part's own frame, does not, and for any part
   * that is not already axis-aligned with the mirror it produces a pose that is
   * merely rotated. A test that only compares positions cannot see the
   * difference, because both agree on where the origin lands.
   */
  it('carries the mirrored local point to the mirrored world point', () => {
    const basis = basisFromAxisAngle([0, 1, 0], Math.PI / 2)
    const transform: Transform = { position: [40, -24, 60], basis }
    for (const axis of [0, 1, 2] as MirrorAxis[]) {
      const plane = 10
      const mirrored = mirrorTransform(transform, axis, plane)
      for (const local of [[20, 0, 0], [0, 24, 0], [0, 0, 10], [7, -3, 11]] as Vec3[]) {
        expect(round(worldPoint(mirrored, reflect(local, axis, 0)))).toEqual(
          round(reflect(worldPoint(transform, local), axis, plane)),
        )
      }
    }
  })

  it('never emits an inside-out basis', () => {
    // A negative-determinant placement renders, and may name no part anyone can
    // buy. Every pose this module produces is a rotation of a real element.
    const basis = basisFromAxisAngle([0.3, 0.8, 0.5], 1.1)
    for (const axis of [0, 1, 2] as MirrorAxis[]) {
      const mirrored = mirrorTransform({ position: [12, 4, -9], basis }, axis, 33)
      expect(determinantMat3(mirrored.basis)).toBeCloseTo(1, 9)
    }
  })

  it('reflects the position through the named plane and leaves the others alone', () => {
    const mirrored = mirrorTransform({ position: [40, -24, 60], basis: IDENTITY_BASIS }, 2, 100)
    expect(mirrored.position).toEqual([40, -24, 140])
  })

  it('takes the mirror plane from the centre of an extent', () => {
    expect(mirrorPlaneFor({ min: [0, -48, 20], max: [80, 0, 100] }, 0)).toBe(40)
    expect(mirrorPlaneFor({ min: [0, -48, 20], max: [80, 0, 100] }, 2)).toBe(60)
  })
})

/**
 * Which reflections are honest.
 *
 * A 45° slope is symmetric across the plane that runs along its ramp and
 * asymmetric across the one that cuts through it — mirror it along the wall it
 * runs down and you get the same part in a legal pose; mirror it across its own
 * ramp and the answer is a slope of the opposite hand, which the catalog carries
 * no table to name. The test is on connectors, so it sees the chirality that
 * shows in how a part attaches.
 */
describe('whether a reflection is faithful', () => {
  it('lets a slope mirror along its ramp and not across it', () => {
    const slope = documentWith(place('3039', { position: [0, 0, 0], basis: IDENTITY_BASIS }))
    expect(canMirror(slope, 'p', 0)).toBe(true)
    expect(canMirror(slope, 'p', 2)).toBe(false)
  })

  it('asks the part about its own frame, not the world', () => {
    // The same slope, given a quarter turn. The world X plane now cuts across
    // the ramp, so the answer has to swap — a symmetry test that read world axes
    // directly would keep saying yes and quietly place an unbuyable part.
    const turned = documentWith(place('3039', { position: [0, 0, 0], basis: basisFromAxisAngle([0, 1, 0], Math.PI / 2) }))
    expect(canMirror(turned, 'p', 0)).toBe(false)
    expect(canMirror(turned, 'p', 2)).toBe(true)
  })

  it('mirrors a plain brick either way, and not through its own studs', () => {
    const brick = documentWith(place('3001', { position: [0, 0, 0], basis: IDENTITY_BASIS }))
    expect(canMirror(brick, 'p', 0)).toBe(true)
    expect(canMirror(brick, 'p', 2)).toBe(true)
    // Studs on top, anti-studs underneath: a brick is not symmetric vertically,
    // and reflecting one through its own waist is not a placement of that brick.
    expect(canMirror(brick, 'p', 1)).toBe(false)
  })

  it('refuses an orientation that lands on no local plane at all', () => {
    const askew = documentWith(place('3001', { position: [0, 0, 0], basis: basisFromAxisAngle([0, 1, 0], Math.PI / 5) }))
    expect(canMirror(askew, 'p', 0)).toBe(false)
  })

  it('says no for a part the catalog cannot describe', () => {
    const unknown = documentWith(place('not-a-part', { position: [0, 0, 0], basis: IDENTITY_BASIS }))
    expect(canMirror(unknown, 'p', 0)).toBe(false)
    expect(canMirror(unknown, 'missing', 0)).toBe(false)
  })
})
