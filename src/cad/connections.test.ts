import { describe, expect, it } from 'vitest'
import {
  allowsAxialFlip,
  connectorsCompatible,
  isExclusiveFamily,
  jointFor,
} from './connections'
import type { ConnectionFamily } from './types'

const pair = (a: ConnectionFamily, b: ConnectionFamily, genderA: 'male' | 'female' | 'neutral' = 'male', genderB: 'male' | 'female' | 'neutral' = 'female') =>
  connectorsCompatible({ family: a, gender: genderA }, { family: b, gender: genderB })

describe('connector compatibility', () => {
  it('accepts each of the seven documented pairs', () => {
    expect(pair('stud', 'anti-stud')).toBe(true)
    expect(pair('axle', 'axle-hole')).toBe(true)
    expect(pair('ball', 'socket')).toBe(true)
    expect(pair('bar', 'clip')).toBe(true)
    expect(pair('hinge', 'hinge', 'neutral', 'neutral')).toBe(true)
    expect(pair('pin', 'pin-hole')).toBe(true)
    expect(pair('generic', 'generic')).toBe(false)
    expect(
      connectorsCompatible(
        { family: 'generic', gender: 'neutral', group: 'turntable' },
        { family: 'generic', gender: 'neutral', group: 'turntable' },
      ),
    ).toBe(true)
  })

  it('rejects same-gender mates and unknown pairs', () => {
    expect(pair('stud', 'anti-stud', 'male', 'male')).toBe(false)
    expect(pair('stud', 'pin-hole')).toBe(false)
    expect(pair('bar', 'socket')).toBe(false)
  })

  it('lets pins, axles and bars flip along their axis, and not studs', () => {
    expect(allowsAxialFlip('pin', 'pin-hole')).toBe(true)
    expect(allowsAxialFlip('axle', 'axle-hole')).toBe(true)
    expect(allowsAxialFlip('bar', 'clip')).toBe(true)
    expect(allowsAxialFlip('stud', 'anti-stud')).toBe(false)
    expect(allowsAxialFlip('ball', 'socket')).toBe(false)
  })

  it('treats studs, pins, clips and balls as exclusive seats', () => {
    expect(isExclusiveFamily('stud')).toBe(true)
    expect(isExclusiveFamily('clip')).toBe(true)
    expect(isExclusiveFamily('ball')).toBe(true)
    expect(isExclusiveFamily('axle')).toBe(false)
    expect(isExclusiveFamily('bar')).toBe(false)
  })
})

/**
 * The freedom each mated pair retains.
 *
 * `jointFor` is the whole of the kernel's opinion about whether a built
 * mechanism can move: `findArticulatedJoints` reads it to decide what to offer,
 * `articulate` reads it to decide what to drive, and the joint manipulator
 * draws handles from it. It is the one function in this file with no direct
 * coverage — the compatibility matrix above says which parts *mate*, and this
 * says what happens next.
 *
 * The distinction it encodes is deliberate and easy to erode: placement freedom
 * and articulation freedom are different things. A round stud is geometrically
 * free to spin, but System building is a quarter-turn lattice and a built wall
 * does not hinge, so a stud pair is a *keyed* revolute rather than a continuous
 * one.
 */
describe('the freedom a mated pair keeps', () => {
  const feature = (family: ConnectionFamily, extra: { slide?: boolean; axial?: number } = {}) => ({
    family,
    gender: 'male' as const,
    ...extra,
  })
  const freedom = (a: ConnectionFamily, b: ConnectionFamily, extra?: { slide?: boolean; axial?: number }) =>
    jointFor(feature(a, extra), feature(b, extra))

  it('keys a stud pair to quarter turns rather than letting a wall spin', () => {
    const joint = freedom('stud', 'anti-stud')
    expect(joint.kind).toBe('revolute')
    expect(joint).toMatchObject({ continuous: false, stepDegrees: 90 })
  })

  it('lets a plain pin rotate freely and a sliding one slide too', () => {
    expect(freedom('pin', 'pin-hole')).toMatchObject({ kind: 'revolute', continuous: true })
    expect(freedom('pin', 'pin-hole', { slide: true, axial: 20 })).toMatchObject({
      kind: 'cylindrical',
      continuousRotation: true,
    })
  })

  it('keys a cross axle to quarter turns while still letting it slide', () => {
    // A cross axle is keyed by its profile: it slides through its hole freely
    // but only seats at quarter turns.
    expect(freedom('axle', 'axle-hole', { axial: 40 })).toMatchObject({
      kind: 'cylindrical',
      continuousRotation: false,
      minLdu: -20,
      maxLdu: 20,
    })
  })

  it('lets a bar spin in its clip', () => {
    expect(freedom('bar', 'clip', { axial: 8 })).toMatchObject({
      kind: 'cylindrical',
      continuousRotation: true,
      minLdu: -4,
      maxLdu: 4,
    })
  })

  it('gives a hinge a continuous swing and a ball a full ball joint', () => {
    expect(freedom('hinge', 'hinge')).toMatchObject({ kind: 'revolute', continuous: true })
    expect(freedom('ball', 'socket')).toMatchObject({ kind: 'spherical' })
  })

  it('says it does not know, rather than guessing, for a group-gated interface', () => {
    // `generic:generic` mates only within a named group — a turntable, a
    // magnet. Mating is known; the motion afterwards is not, and claiming it
    // was rigid would be a worse answer than admitting ignorance.
    expect(freedom('generic', 'generic')).toEqual({ kind: 'unknown' })
    expect(freedom('stud', 'clip')).toEqual({ kind: 'unknown' })
  })

  it('reports no travel where the connectors declare no axial extent', () => {
    // Only some clips carry an axial range in the compiled catalog. Where none
    // is declared the joint still rotates, but a caller must not be told it can
    // slide somewhere it cannot.
    const joint = freedom('axle', 'axle-hole') as Extract<
      ReturnType<typeof jointFor>,
      { minLdu: number; maxLdu: number }
    >
    expect(joint.kind).toBe('cylindrical')
    // The width, not the endpoints: an undeclared extent yields `-0` for the
    // lower bound, and `Object.is(-0, 0)` is false, so asserting the endpoints
    // would be a test of the sign of zero rather than of the travel.
    expect(joint.maxLdu - joint.minLdu).toBe(0)
  })
})
