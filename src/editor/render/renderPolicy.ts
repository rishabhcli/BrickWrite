/**
 * Which frames the viewport is allowed to draw.
 *
 * A CAD viewport is a still image almost all of the time: a model sits there
 * being looked at. Drawing it again sixty or a hundred and twenty times a
 * second changes nothing and costs a laptop its battery — measured here at
 * ~435 draw calls and ~560k triangles *per frame* on the starting document,
 * with nothing on screen moving.
 *
 * So frames are spent rather than assumed. Anything that genuinely animates
 * takes a hold; while one is held the renderer runs continuously. When the last
 * hold is released the renderer keeps drawing for a short settle window — long
 * enough for edge LOD to restore its full line budget and for camera smoothing
 * to land — and then stops until something invalidates it.
 */

/** What is asking for continuous frames. One string per independent source. */
export type RenderHold =
  | 'gesture'
  | 'camera'
  | 'animation'
  | 'placement'
  | 'gizmo'
  | 'capture'

/**
 * How long to keep drawing after the last hold is released.
 *
 * Must outlast `EDGE_MOTION_SETTLE_SECONDS` (150 ms): the frames that restore
 * the full edge allocation are drawn *after* the camera stops, so cutting the
 * loop at the moment of release would leave the model permanently wearing the
 * thinned outlines an orbit asked for.
 */
export const RENDER_SETTLE_MS = 420

export type RenderMode = 'always' | 'demand'

export class RenderPolicy {
  private readonly holds = new Set<RenderHold>()
  private settleUntil = -Infinity

  /** Sources currently demanding continuous frames, for assertions and debug. */
  get held(): readonly RenderHold[] {
    return [...this.holds]
  }

  hold(source: RenderHold): void {
    this.holds.add(source)
  }

  /** Releasing opens the settle window; releasing an unheld source is a no-op. */
  release(source: RenderHold, now: number): void {
    if (!this.holds.delete(source)) return
    if (this.holds.size === 0) this.settleUntil = now + RENDER_SETTLE_MS
  }

  /** Extends the settle window without taking a hold — for one-off invalidations. */
  touch(now: number): void {
    if (this.holds.size === 0) this.settleUntil = now + RENDER_SETTLE_MS
  }

  /**
   * Frames actually drawn.
   *
   * Read by the backdrop sampler, which reads pixels back off the canvas: with
   * nothing repainted since its last look the pixels are the ones it already
   * has, and the readback is a GPU pipeline stall bought for no information.
   */
  private painted = 0

  notePainted(): void {
    this.painted += 1
  }

  get framesPainted(): number {
    return this.painted
  }

  mode(now: number): RenderMode {
    if (this.holds.size > 0) return 'always'
    return now < this.settleUntil ? 'always' : 'demand'
  }

  /** True while frame deltas mean what the adaptive quality governor thinks they mean. */
  measurable(now: number): boolean {
    return this.mode(now) === 'always'
  }
}
