import { describe, expect, it } from 'vitest'
import { createEmptyDocument } from './sample'
import { bestSnapTransform, computeOccupancy, connectorsCompatible, findSnapCandidates } from './snapping'
import type { ConnectionFamily, PartInstance } from './types'

const part = (id: string, y: number, definitionId = '3001'): PartInstance => ({
  id,
  definitionId,
  color: 72,
  transform: { position: [0, y, 0], rotation: [0, 0, 0] },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const feature = (family: ConnectionFamily, gender: 'male' | 'female', group?: string) => ({ family, gender, group })

describe('connector snapping', () => {
  it('enforces connector family and gender compatibility', () => {
    expect(connectorsCompatible(feature('stud', 'male'), feature('anti-stud', 'female'))).toBe(true)
    expect(connectorsCompatible(feature('stud', 'male'), feature('stud', 'male'))).toBe(false)
    expect(connectorsCompatible(feature('axle', 'male'), feature('anti-stud', 'female'))).toBe(false)
    expect(connectorsCompatible(feature('pin', 'male'), feature('pin-hole', 'female'))).toBe(true)
  })

  it('requires a matching group before mating generic connectors', () => {
    expect(connectorsCompatible(feature('generic', 'male', 'turntable'), feature('generic', 'female', 'turntable'))).toBe(true)
    expect(connectorsCompatible(feature('generic', 'male', 'turntable'), feature('generic', 'female', 'door'))).toBe(false)
    expect(connectorsCompatible(feature('generic', 'male'), feature('generic', 'female'))).toBe(false)
  })

  it('scores a full eight-stud alignment above single-point alternatives', () => {
    const document = createEmptyDocument()
    document.parts.base = part('base', 0)
    // LDraw is Y-down, so a brick resting on top of another sits 24 LDU lower.
    const moving = part('moving', -25)
    document.parts.moving = moving
    const candidates = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 10 })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].simultaneousMatches).toBe(8)
    expect(bestSnapTransform(moving, document, moving.transform, { radiusLdu: 10 })?.position).toEqual([0, -24, 0])
  })

  it('will not propose a stud that is already carrying a part', () => {
    const document = createEmptyDocument()
    document.parts.base = part('base', 0)
    document.parts.stacked = part('stacked', -24)
    const moving = part('moving', -26)
    document.parts.moving = moving
    const occupied = computeOccupancy(document, new Set(['moving']))
    expect(occupied.size).toBeGreaterThan(0)
    const candidates = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 12 })
    // Every remaining candidate must sit clear of the occupied interface.
    expect(candidates.every((candidate) => candidate.transform.position[1] !== -24)).toBe(true)
  })

  it('restricts candidates to a chosen connector pair for the Connect tool', () => {
    const document = createEmptyDocument()
    document.parts.base = part('base', 0)
    const moving = part('moving', -25)
    document.parts.moving = moving
    const base = document.parts.base
    const targetFeatureId = document.parts.base ? undefined : undefined
    void base
    void targetFeatureId
    const all = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 30 })
    const pinned = findSnapCandidates(moving, document, moving.transform, {
      radiusLdu: 30,
      movingFeatureId: all[0].movingFeatureId,
      targetFeatureId: all[0].targetFeatureId,
    })
    expect(pinned).toHaveLength(1)
    expect(pinned[0].transform).toEqual(all[0].transform)
  })
})
