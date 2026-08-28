/**
 * Motion policy for the viewport.
 *
 * Animation in a CAD tool is not decoration: a camera that teleports between
 * named views loses the operator's sense of where the model is, and a proposal
 * that appears fully formed gives no clue which parts it added. Both are
 * legibility problems that motion solves.
 *
 * But motion is also a correctness hazard here, for two reasons that this
 * module exists to contain:
 *
 *   - `render_capture` has to be **deterministic**. A capture taken mid-tween
 *     is a picture of a moment that does not correspond to any document state,
 *     and an agent comparing two captures would be reading animation noise as
 *     model change. So every animation has a defined settled state, and capture
 *     forces it before a pixel is read.
 *   - Some people cannot use animation at all. `prefers-reduced-motion` is
 *     honoured by jumping straight to the settled state rather than by running
 *     the same animation faster, because a fast animation is still animation.
 */

export type EasingName = 'linear' | 'easeOutCubic' | 'easeInOutCubic' | 'easeOutBack'

const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  // A small overshoot on selection, which is what makes a highlight read as
  // "this one" rather than as a colour change. Deliberately mild: 1.70158 is
  // the classic constant and lands ~10% past the target, which on a 90 ms
  // transition is perceptible without looking springy.
  easeOutBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
}

export const ease = (name: EasingName, t: number): number =>
  EASINGS[name](Math.min(1, Math.max(0, t)))

/**
 * Named durations, in milliseconds.
 *
 * Collected here rather than spread through components so that "the viewport
 * feels slow" is one table to argue with, and so reduced motion has a single
 * place to zero.
 */
export const MOTION_DURATIONS = {
  /** Selection highlight cross-fade. */
  selection: 110,
  /** Camera flight to a named view or a framing reset. */
  camera: 520,
  /** Per-part stagger while a proposal reveals itself. */
  proposalStagger: 14,
  /** How long one proposal part takes to fade in. */
  proposalFade: 260,
  /** Coarse-to-detail assembly reveal, whole model. */
  assembly: 900,
  /** Exploded view opening or closing. */
  explode: 620,
  /** One instruction step during playback. */
  instructionStep: 720,
  /** A full turntable revolution. */
  turntable: 9000,
} as const

export type MotionChannel = keyof typeof MOTION_DURATIONS

/**
 * Reads the user's motion preference.
 *
 * Split out so the acceptance run can force it: `matchMedia` cannot be
 * overridden per page in every driver, and a reduced-motion assertion that
 * cannot be made to fail is not an assertion.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface MotionPolicy {
  /** False when animation is suppressed and every channel settles instantly. */
  readonly animated: boolean
  /** Why animation is off, for the diagnostic surface. */
  readonly reason: 'enabled' | 'reduced-motion' | 'capture' | 'disabled'
}

/**
 * The single authority on whether the viewport is allowed to animate.
 *
 * `capture` outranks the user preference in both directions: a capture must be
 * settled even for someone who has animation on, and a settled capture is
 * exactly what someone with reduced motion already sees.
 */
export class MotionController {
  private captureHolds = 0
  private forced: boolean | null = null
  private listeners = new Set<(policy: MotionPolicy) => void>()

  constructor(private reduced: boolean = prefersReducedMotion()) {}

  /** Overrides the media query. Null returns control to the preference. */
  forceReducedMotion(value: boolean | null) {
    this.forced = value
    this.emit()
  }

  /** Re-reads the media query, for a `change` listener. */
  refresh(reduced = prefersReducedMotion()) {
    this.reduced = reduced
    this.emit()
  }

  /**
   * Suppresses animation for the duration of a capture.
   *
   * Reference counted, because two overlapping capture requests must not have
   * the first one's release re-enable animation under the second.
   */
  beginCapture(): () => void {
    this.captureHolds += 1
    this.emit()
    let released = false
    return () => {
      if (released) return
      released = true
      this.captureHolds = Math.max(0, this.captureHolds - 1)
      this.emit()
    }
  }

  get capturing(): boolean {
    return this.captureHolds > 0
  }

  get policy(): MotionPolicy {
    if (this.captureHolds > 0) return { animated: false, reason: 'capture' }
    const reduced = this.forced ?? this.reduced
    if (reduced) return { animated: false, reason: this.forced === true ? 'disabled' : 'reduced-motion' }
    return { animated: true, reason: 'enabled' }
  }

  /** The effective duration of a channel: zero whenever animation is off. */
  duration(channel: MotionChannel): number {
    return this.policy.animated ? MOTION_DURATIONS[channel] : 0
  }

  subscribe(listener: (policy: MotionPolicy) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    const policy = this.policy
    for (const listener of this.listeners) listener(policy)
  }
}

/**
 * A scalar that eases toward a target and reports when it has settled.
 *
 * Deliberately not a spring. A spring has no defined end, so "the animation has
 * finished" becomes a threshold test, and a capture would have to either wait an
 * unbounded time or accept a nearly-settled frame. A duration-bounded tween
 * settles exactly.
 */
export class Tween {
  private from = 0
  private to = 0
  private startedAt = 0
  private durationMs = 0

  constructor(initial = 0, private readonly easing: EasingName = 'easeOutCubic') {
    this.from = initial
    this.to = initial
  }

  /** Retargets from wherever the tween currently is, so it never snaps back. */
  retarget(value: number, durationMs: number, now: number) {
    if (durationMs <= 0) {
      this.from = value
      this.to = value
      this.durationMs = 0
      this.startedAt = now
      return
    }
    this.from = this.valueAt(now)
    this.to = value
    this.durationMs = durationMs
    this.startedAt = now
  }

  valueAt(now: number): number {
    if (this.durationMs <= 0) return this.to
    const t = (now - this.startedAt) / this.durationMs
    if (t >= 1) return this.to
    return this.from + (this.to - this.from) * ease(this.easing, t)
  }

  settledAt(now: number): boolean {
    return this.durationMs <= 0 || now - this.startedAt >= this.durationMs
  }

  /** Jumps to the target. This is what capture calls. */
  settle() {
    this.from = this.to
    this.durationMs = 0
  }

  get target(): number {
    return this.to
  }
}

/**
 * Progress of one item in a staggered reveal.
 *
 * Used by the proposal wave and by coarse-to-detail assembly. The stagger is
 * capped so that a five-hundred-part proposal does not take seven seconds to
 * finish revealing itself — past the cap the wave compresses instead of
 * lengthening, which keeps the *order* legible without keeping the operator
 * waiting.
 */
export function staggeredProgress(
  index: number,
  count: number,
  elapsedMs: number,
  options: { readonly staggerMs?: number; readonly fadeMs?: number; readonly totalCapMs?: number } = {},
): number {
  const fade = options.fadeMs ?? MOTION_DURATIONS.proposalFade
  const cap = options.totalCapMs ?? 1400
  const requested = options.staggerMs ?? MOTION_DURATIONS.proposalStagger
  const stagger = count > 1 ? Math.min(requested, Math.max(0, cap - fade) / (count - 1)) : 0
  const delay = index * stagger
  if (fade <= 0) return 1
  return ease('easeOutCubic', (elapsedMs - delay) / fade)
}

/** True once every item in a staggered reveal has finished. */
export function staggerSettled(
  count: number,
  elapsedMs: number,
  options: { readonly staggerMs?: number; readonly fadeMs?: number; readonly totalCapMs?: number } = {},
): boolean {
  if (count <= 0) return true
  return staggeredProgress(count - 1, count, elapsedMs, options) >= 1
}

/**
 * Which parts an instruction playback has revealed at a given time.
 *
 * Returns an index into the step list rather than a part set, so the caller
 * decides what "revealed" means for its own render mode.
 */
export function playbackStepAt(
  elapsedMs: number,
  stepCount: number,
  stepMs: number = MOTION_DURATIONS.instructionStep,
): number {
  if (stepCount <= 0) return 0
  if (stepMs <= 0) return stepCount - 1
  return Math.min(stepCount - 1, Math.floor(elapsedMs / stepMs))
}

/** Turntable azimuth in radians, wrapped, for a deterministic settled pose at t=0. */
export function turntableAngle(elapsedMs: number, periodMs: number = MOTION_DURATIONS.turntable): number {
  if (periodMs <= 0) return 0
  return ((elapsedMs % periodMs) / periodMs) * Math.PI * 2
}
