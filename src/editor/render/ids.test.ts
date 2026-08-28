import { describe, expect, it } from 'vitest'
import { decodeId, encodeId, MAX_ID, NO_ID, PickRegistry } from './ids'

describe('identity codec', () => {
  it('round-trips every byte boundary', () => {
    // The boundaries are where a packing bug hides: a shift-by-eight error
    // round-trips 1 and 2 perfectly and fails at 256.
    for (const id of [1, 255, 256, 257, 65535, 65536, 65537, 16_777_214, MAX_ID]) {
      const [r, g, b] = encodeId(id)
      expect([r, g, b].every((channel) => channel >= 0 && channel <= 255)).toBe(true)
      expect(decodeId(r, g, b)).toBe(id)
    }
  })

  it('decodes a cleared pixel as background, not as part zero', () => {
    // The id target is cleared to black and read back like any other pixel, so
    // this is what stops an empty frame from selecting the first drawn part.
    expect(decodeId(0, 0, 0)).toBe(NO_ID)
  })
})

describe('pick registry', () => {
  it('resolves an instance index within a batch to its own part', () => {
    const registry = new PickRegistry()
    const base = registry.reserve(['a', 'b', 'c'])
    expect(registry.resolve(base)).toBe('a')
    expect(registry.resolve(base + 2)).toBe('c')
    expect(registry.drawCount).toBe(1)
    expect(registry.size).toBe(3)
  })

  it('keeps ranges disjoint across draws', () => {
    const registry = new PickRegistry()
    const first = registry.reserve(['a', 'b'])
    const second = registry.reserve(['c'])
    expect(second).toBe(first + 2)
    expect(registry.resolve(second)).toBe('c')
  })

  it('resolves an unknown identity to nothing rather than to a neighbour', () => {
    const registry = new PickRegistry()
    registry.reserve(['a'])
    expect(registry.resolve(9999)).toBeNull()
    expect(registry.resolve(NO_ID)).toBeNull()
  })

  it('refuses a reservation past the 24-bit space instead of colliding', () => {
    const registry = new PickRegistry()
    // Colliding two parts onto one identity would make picking silently *wrong*;
    // refusing makes it absent, which is the recoverable failure.
    const huge = Array.from({ length: 4 }, (_, index) => `p${index}`)
    registry.reserve(new Array(MAX_ID - 2).fill('filler'))
    expect(registry.reserve(huge)).toBe(NO_ID)
  })

  it('forgets everything on reset, so a stale base cannot resolve', () => {
    const registry = new PickRegistry()
    const base = registry.reserve(['a'])
    registry.reset()
    expect(registry.resolve(base)).toBeNull()
    expect(registry.size).toBe(0)
  })

  it('reports the identity assigned to a part', () => {
    const registry = new PickRegistry()
    registry.reserve(['a', 'b'])
    const base = registry.reserve(['c'])
    expect(registry.idOf('c')).toBe(base)
    expect(registry.idOf('missing')).toBe(NO_ID)
  })
})
