import { describe, expect, it } from 'vitest'
import { RENDER_SETTLE_MS, RenderPolicy } from './renderPolicy'

describe('RenderPolicy', () => {
  it('draws on demand when nothing is animating', () => {
    expect(new RenderPolicy().mode(0)).toBe('demand')
  })

  it('runs continuously while a hold is taken', () => {
    const policy = new RenderPolicy()
    policy.hold('camera')
    expect(policy.mode(10_000)).toBe('always')
  })

  it('keeps drawing through the settle window after the last release', () => {
    const policy = new RenderPolicy()
    policy.hold('camera')
    policy.release('camera', 1000)
    expect(policy.mode(1000 + RENDER_SETTLE_MS - 1)).toBe('always')
    expect(policy.mode(1000 + RENDER_SETTLE_MS)).toBe('demand')
  })

  // Two overlapping gestures released out of order must not end the loop early:
  // an orbit that finishes mid-drag would freeze the drag's own preview.
  it('settles from the last release, not the first', () => {
    const policy = new RenderPolicy()
    policy.hold('camera')
    policy.hold('gizmo')
    policy.release('camera', 1000)
    expect(policy.mode(1000 + RENDER_SETTLE_MS + 1)).toBe('always')
    policy.release('gizmo', 2000)
    expect(policy.mode(2000 + RENDER_SETTLE_MS + 1)).toBe('demand')
  })

  it('ignores a release for a source that never held', () => {
    const policy = new RenderPolicy()
    policy.hold('camera')
    policy.release('animation', 1000)
    expect(policy.mode(5000)).toBe('always')
  })

  // Frame deltas taken across a demand-mode gap are seconds long. Feeding those
  // to the adaptive quality governor reads as 2 fps and drops the viewport to
  // its worst tier while it sits perfectly still.
  it('reports deltas as measurable only while running continuously', () => {
    const policy = new RenderPolicy()
    expect(policy.measurable(0)).toBe(false)
    policy.hold('animation')
    expect(policy.measurable(0)).toBe(true)
  })

  it('touch extends the settle window but takes no hold', () => {
    const policy = new RenderPolicy()
    policy.touch(1000)
    expect(policy.held).toEqual([])
    expect(policy.mode(1000 + RENDER_SETTLE_MS - 1)).toBe('always')
  })

  it('touch never shortens an active hold', () => {
    const policy = new RenderPolicy()
    policy.hold('capture')
    policy.touch(1000)
    expect(policy.mode(1000 + RENDER_SETTLE_MS + 1)).toBe('always')
  })
})
