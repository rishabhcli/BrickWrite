/**
 * Motion policy for chrome, in two tiers.
 *
 * The viewport has its own policy in src/editor/render/motion.ts and this file
 * deliberately does not import it. `src/ui/liquid` is loaded by the landing
 * page, and main.tsx goes to real trouble to keep Three.js out of that bundle;
 * one import from `src/editor/**` would undo it. The five lines of duplicated
 * preference reading are the price of that isolation, and they are the same
 * five lines on both sides on purpose: the viewport and its chrome must not
 * disagree about what a motion preference means.
 */

import type { Transition } from 'motion/react'
import { REDUCED_MOTION_QUERY } from './capability'

/**
 * `intent` is what the operator asked for; `work` is what happens while they
 * are busy. A panel arriving with a visible overshoot reads as a response. The
 * same overshoot on a surface that moves because you are dragging a brick past
 * it reads as the interface being unable to hold still.
 */
export type MotionTier = 'intent' | 'work'

export const SPRINGS = {
  intent: { type: 'spring', stiffness: 220, damping: 26, mass: 1 },
  work: { type: 'spring', stiffness: 520, damping: 40, mass: 0.6 },
} as const satisfies Record<MotionTier, Transition>

/**
 * Reduced motion jumps to the settled state rather than running the same
 * animation faster, because a fast animation is still animation. A zero
 * duration tween is the only transition here that is genuinely no motion.
 */
export const SETTLED: Transition = { duration: 0 }

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

export function transitionFor(tier: MotionTier, reducedMotion: boolean): Transition {
  return reducedMotion ? SETTLED : SPRINGS[tier]
}

/** A 2.5% compression, which is the most a surface can give without the text inside it visibly moving. */
export const PRESS_SCALE = 0.975

export function pressScale(reducedMotion: boolean): number {
  return reducedMotion ? 1 : PRESS_SCALE
}

/**
 * How long after the last gesture event a surface may return to the expensive
 * material.
 *
 * Long enough that the gaps between pointer events during a slow drag do not
 * flicker the tier, short enough that letting go feels like letting go.
 */
export const SETTLE_DELAY_MS = 180
