import { describe, expect, it } from 'vitest'
import {
  allowsAxialFlip,
  connectorsCompatible,
  isExclusiveFamily,
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
