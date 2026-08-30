import { describe, expect, it } from 'vitest'
import {
  commandFromViewportKey,
  nextInOrder,
  viewportMode,
  walkPartOrder,
  VIEWPORT_ORBIT_COARSE_DEG,
  VIEWPORT_ORBIT_STEP_DEG,
} from './viewportKeys'

describe('viewport keyboard mapping', () => {
  it('orbits with arrows and takes a coarser step with Shift', () => {
    const fine = commandFromViewportKey('ArrowLeft', { shift: false, mode: 'orbit', gridLdu: 20 })
    const coarse = commandFromViewportKey('ArrowLeft', { shift: true, mode: 'orbit', gridLdu: 20 })
    expect(fine).toEqual({ kind: 'orbit', yawDeg: -VIEWPORT_ORBIT_STEP_DEG, pitchDeg: 0 })
    expect(coarse).toEqual({ kind: 'orbit', yawDeg: -VIEWPORT_ORBIT_COARSE_DEG, pitchDeg: 0 })
  })

  it('nudges instead of orbiting while a transform tool is active', () => {
    expect(viewportMode('move', 1)).toBe('nudge')
    expect(viewportMode('select', 1)).toBe('orbit')
    const nudge = commandFromViewportKey('ArrowRight', { shift: false, mode: 'nudge', gridLdu: 20 })
    expect(nudge).toEqual({ kind: 'nudge', dx: 20, dz: 0 })
    const orbit = commandFromViewportKey('ArrowRight', { shift: false, mode: 'orbit', gridLdu: 20 })
    expect(orbit).toEqual({ kind: 'orbit', yawDeg: VIEWPORT_ORBIT_STEP_DEG, pitchDeg: 0 })
  })

  it('walks selection in build order, then document order', () => {
    const visible = new Set(['a', 'b', 'c'])
    const order = walkPartOrder([['b'], ['a']], ['c', 'a', 'b'], visible)
    expect(order).toEqual(['b', 'a', 'c'])
    expect(nextInOrder(order, 'b', 1)).toBe('a')
    expect(nextInOrder(order, 'c', 1)).toBe('b')
  })

  it('raises and lowers the selection with Page Up/Down in move mode', () => {
    const opts = { shift: false, mode: 'nudge' as const, gridLdu: 8 }
    expect(commandFromViewportKey('PageUp', opts)).toEqual({ kind: 'nudge', dx: 0, dz: 0, dy: -8 })
    expect(commandFromViewportKey('PageDown', { ...opts, shift: true })).toEqual({
      kind: 'nudge',
      dx: 0,
      dz: 0,
      dy: 32,
    })
  })

  it('maps joint, section, occlusion and enter commands', () => {
    const opts = { shift: false, mode: 'orbit' as const, gridLdu: 20 }
    expect(commandFromViewportKey(',', opts)).toEqual({ kind: 'joint', rotateDegrees: -15, slideLdu: 0 })
    expect(commandFromViewportKey('.', { ...opts, shift: true })).toEqual({
      kind: 'joint',
      rotateDegrees: 0,
      slideLdu: 4,
    })
    expect(commandFromViewportKey(';', opts)).toEqual({ kind: 'section', offsetLdu: -8 })
    expect(commandFromViewportKey('\\', opts)).toEqual({ kind: 'occlude' })
    expect(commandFromViewportKey('Enter', { ...opts, placing: true })).toEqual({ kind: 'place' })
    expect(commandFromViewportKey('Enter', opts)).toEqual({ kind: 'act' })
  })

  it('maps share-viewer zoom keys onto the same dolly and frame commands', () => {
    const opts = { shift: false, mode: 'orbit' as const, gridLdu: 20 }
    expect(commandFromViewportKey('+', opts)).toEqual(commandFromViewportKey('PageUp', opts))
    expect(commandFromViewportKey('=', opts)).toEqual(commandFromViewportKey('PageUp', opts))
    expect(commandFromViewportKey('-', opts)).toEqual(commandFromViewportKey('PageDown', opts))
    expect(commandFromViewportKey('0', opts)).toEqual(commandFromViewportKey('Home', opts))
  })
})
