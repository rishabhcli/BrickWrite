import { describe, expect, it } from 'vitest'
import {
  ease,
  MotionController,
  MOTION_DURATIONS,
  playbackStepAt,
  staggeredProgress,
  staggerSettled,
  turntableAngle,
  Tween,
} from './motion'

describe('easing', () => {
  it('is clamped and anchored at both ends', () => {
    for (const name of ['linear', 'easeOutCubic', 'easeInOutCubic', 'easeOutBack'] as const) {
      expect(ease(name, 0)).toBeCloseTo(0, 6)
      expect(ease(name, 1)).toBeCloseTo(1, 6)
      expect(ease(name, -4)).toBeCloseTo(0, 6)
      expect(ease(name, 4)).toBeCloseTo(1, 6)
    }
  })

  it('overshoots only where an overshoot was asked for', () => {
    expect(Math.max(...[0.25, 0.5, 0.75].map((t) => ease('easeOutCubic', t)))).toBeLessThanOrEqual(1)
    expect(ease('easeOutBack', 0.8)).toBeGreaterThan(1)
  })
})

describe('motion policy', () => {
  it('suppresses animation for someone who asked for less of it', () => {
    const motion = new MotionController(true)
    expect(motion.policy.animated).toBe(false)
    expect(motion.policy.reason).toBe('reduced-motion')
    expect(motion.duration('camera')).toBe(0)
  })

  it('runs animation otherwise', () => {
    const motion = new MotionController(false)
    expect(motion.policy.animated).toBe(true)
    expect(motion.duration('camera')).toBe(MOTION_DURATIONS.camera)
  })

  it('forces every channel to zero during a capture, whatever the preference', () => {
    // A capture taken mid-tween is a picture of a moment that corresponds to no
    // document state, and an agent comparing two captures would read animation
    // noise as model change.
    const motion = new MotionController(false)
    const release = motion.beginCapture()
    expect(motion.policy.animated).toBe(false)
    expect(motion.policy.reason).toBe('capture')
    expect(motion.duration('proposalFade')).toBe(0)
    release()
    expect(motion.policy.animated).toBe(true)
  })

  it('reference-counts overlapping captures', () => {
    const motion = new MotionController(false)
    const first = motion.beginCapture()
    const second = motion.beginCapture()
    first()
    expect(motion.capturing).toBe(true)
    second()
    expect(motion.capturing).toBe(false)
  })

  it('ignores a release called twice', () => {
    const motion = new MotionController(false)
    const release = motion.beginCapture()
    release()
    release()
    expect(motion.capturing).toBe(false)
  })

  it('lets a test override the media query in both directions', () => {
    const motion = new MotionController(true)
    motion.forceReducedMotion(false)
    expect(motion.policy.animated).toBe(true)
    motion.forceReducedMotion(true)
    expect(motion.policy.animated).toBe(false)
    motion.forceReducedMotion(null)
    expect(motion.policy.animated).toBe(false)
  })

  it('notifies subscribers when the policy changes', () => {
    const motion = new MotionController(false)
    const seen: boolean[] = []
    const unsubscribe = motion.subscribe((policy) => seen.push(policy.animated))
    const release = motion.beginCapture()
    release()
    unsubscribe()
    expect(seen).toEqual([false, true])
  })
})

describe('tweens', () => {
  it('settles exactly, rather than approaching forever', () => {
    // A spring has no defined end, so "the animation has finished" becomes a
    // threshold test and a capture would have to accept a nearly-settled frame.
    const tween = new Tween(0)
    tween.retarget(10, 100, 1000)
    expect(tween.valueAt(1000)).toBeCloseTo(0, 6)
    expect(tween.settledAt(1099)).toBe(false)
    expect(tween.valueAt(1100)).toBe(10)
    expect(tween.settledAt(1100)).toBe(true)
  })

  it('retargets from wherever it currently is, so it never snaps back', () => {
    const tween = new Tween(0)
    tween.retarget(10, 100, 0)
    const midway = tween.valueAt(50)
    tween.retarget(0, 100, 50)
    expect(tween.valueAt(50)).toBeCloseTo(midway, 6)
  })

  it('is instant when handed a zero duration', () => {
    const tween = new Tween(0)
    tween.retarget(7, 0, 0)
    expect(tween.valueAt(0)).toBe(7)
    expect(tween.settledAt(0)).toBe(true)
  })

  it('jumps to the target when settled', () => {
    const tween = new Tween(0)
    tween.retarget(5, 1000, 0)
    tween.settle()
    expect(tween.valueAt(1)).toBe(5)
  })
})

describe('staggered reveals', () => {
  it('reveals in order', () => {
    expect(staggeredProgress(0, 40, 40)).toBeGreaterThan(staggeredProgress(20, 40, 40))
  })

  it('compresses rather than lengthening past the cap', () => {
    // A five-hundred-part proposal must not take seven seconds to finish
    // revealing itself; the order stays legible, the wait does not grow.
    const smallSettle = 40 * MOTION_DURATIONS.proposalStagger + MOTION_DURATIONS.proposalFade
    expect(staggerSettled(40, smallSettle)).toBe(true)
    expect(staggerSettled(500, 1500)).toBe(true)
  })

  it('is complete immediately when the fade is zero', () => {
    expect(staggeredProgress(9, 10, 0, { fadeMs: 0 })).toBe(1)
  })
})

describe('playback and turntable', () => {
  it('advances one step per interval and stops at the last', () => {
    expect(playbackStepAt(0, 4, 100)).toBe(0)
    expect(playbackStepAt(250, 4, 100)).toBe(2)
    expect(playbackStepAt(9999, 4, 100)).toBe(3)
  })

  it('jumps to the finished model when the step duration is zero', () => {
    expect(playbackStepAt(0, 4, 0)).toBe(3)
  })

  it('starts a turntable at zero, so a capture is deterministic', () => {
    expect(turntableAngle(0)).toBe(0)
    expect(turntableAngle(4500, 9000)).toBeCloseTo(Math.PI, 6)
    expect(turntableAngle(9000, 9000)).toBeCloseTo(0, 6)
  })
})
