/**
 * Adaptive quality, measured rather than guessed.
 *
 * A viewport that is beautiful at four hundred parts and unusable at five
 * thousand has not been tuned, it has been decorated. The honest approach is to
 * pick the settings from *measured frame time* on the machine actually running,
 * because the same model costs wildly different amounts on an integrated GPU
 * and a discrete one, and neither part count nor a user-agent string predicts
 * which one it is.
 *
 * The ladder below is ordered by what each setting buys per millisecond it
 * costs, cheapest sacrifice first. Hard edges go before shadows because edges
 * are a legibility aid the silhouette and material already partly supply,
 * whereas losing contact shadows makes the model appear to float — a
 * *spatial* misreading, not a cosmetic one.
 */

export interface QualityTier {
  readonly name: string
  /** Device pixel ratio ceiling. */
  readonly maxDpr: number
  /** Draw merged hard edges. */
  readonly edges: boolean
  /** Directional shadow map resolution, or 0 for no cast shadows. */
  readonly shadowMapSize: number
  /** Ground contact shadow resolution, or 0 for none. */
  readonly contactShadowResolution: number
  /** Environment prefilter contribution; the studio is cheap, so it survives. */
  readonly environmentIntensity: number
  /** Antialias the beauty pass. */
  readonly antialias: boolean
}

/**
 * Five steps, from "this machine has room to spare" to "keep it interactive".
 *
 * `minimum` still renders true geometry and true materials: the tool never
 * substitutes boxes for parts, because a picture of the wrong shape is worse
 * than a slow picture of the right one.
 */
export const QUALITY_TIERS: readonly QualityTier[] = [
  { name: 'ultra', maxDpr: 2, edges: true, shadowMapSize: 2048, contactShadowResolution: 1024, environmentIntensity: 0.55, antialias: true },
  { name: 'high', maxDpr: 1.65, edges: true, shadowMapSize: 2048, contactShadowResolution: 1024, environmentIntensity: 0.55, antialias: true },
  { name: 'balanced', maxDpr: 1.35, edges: true, shadowMapSize: 1024, contactShadowResolution: 512, environmentIntensity: 0.5, antialias: true },
  { name: 'fast', maxDpr: 1, edges: false, shadowMapSize: 1024, contactShadowResolution: 0, environmentIntensity: 0.45, antialias: true },
  { name: 'minimum', maxDpr: 1, edges: false, shadowMapSize: 0, contactShadowResolution: 0, environmentIntensity: 0.4, antialias: false },
]

export const DEFAULT_TIER_INDEX = 1

export interface QualityDecision {
  readonly tier: QualityTier
  readonly index: number
  /** Frames per second the controller is currently measuring. */
  readonly fps: number
  /** True on the frame the tier changed, so a caller can log it once. */
  readonly changed: boolean
}

/**
 * Frame-time governor with hysteresis.
 *
 * Two properties matter more than the exact thresholds:
 *
 *   - It must not oscillate. A controller that drops quality, recovers, and
 *     immediately drops again produces visible pumping that is worse than
 *     simply being slow. Recovery therefore needs a *higher* bar than the drop
 *     and a dwell time, so a single fast frame cannot promote.
 *   - It must react within a fraction of a second when a model is opened that
 *     the machine genuinely cannot hold, because the first seconds are when the
 *     operator decides whether the tool works.
 */
export class QualityController {
  private samples: number[] = []
  private index: number
  private lastChangeAt = -Infinity
  private lastFps = 60

  constructor(
    startIndex = DEFAULT_TIER_INDEX,
    private readonly options: {
      /** Drop a tier below this. 30 FPS is the interaction floor this tool targets. */
      readonly demoteBelowFps?: number
      /** Only promote above this, well clear of the demote threshold. */
      readonly promoteAboveFps?: number
      /** Frames averaged before any decision. */
      readonly window?: number
      /** Minimum milliseconds between changes. */
      readonly dwellMs?: number
    } = {},
  ) {
    this.index = Math.min(QUALITY_TIERS.length - 1, Math.max(0, startIndex))
  }

  /** Feeds one frame's duration in milliseconds and returns the decision. */
  sample(frameMs: number, now: number): QualityDecision {
    const window = this.options.window ?? 30
    if (frameMs > 0 && Number.isFinite(frameMs)) this.samples.push(frameMs)
    if (this.samples.length > window) this.samples.splice(0, this.samples.length - window)

    if (this.samples.length >= Math.min(8, window)) {
      const mean = this.samples.reduce((total, value) => total + value, 0) / this.samples.length
      this.lastFps = mean > 0 ? 1000 / mean : 0
    }

    const demoteBelow = this.options.demoteBelowFps ?? 30
    const promoteAbove = this.options.promoteAboveFps ?? 52
    const dwell = this.options.dwellMs ?? 1200
    let changed = false

    if (this.samples.length >= Math.min(8, window) && now - this.lastChangeAt >= dwell) {
      if (this.lastFps < demoteBelow && this.index < QUALITY_TIERS.length - 1) {
        this.index += 1
        changed = true
      } else if (this.lastFps > promoteAbove && this.index > 0) {
        this.index -= 1
        changed = true
      }
      if (changed) {
        this.lastChangeAt = now
        // Start the next window clean: samples taken at the old tier say nothing
        // about the new one, and keeping them is what makes a governor ring.
        this.samples = []
      }
    }

    return { tier: QUALITY_TIERS[this.index], index: this.index, fps: this.lastFps, changed }
  }

  /** Pins the tier, for capture and for the benchmark's controlled runs. */
  pin(index: number) {
    this.index = Math.min(QUALITY_TIERS.length - 1, Math.max(0, index))
    this.samples = []
    this.lastChangeAt = Infinity
  }

  get current(): QualityDecision {
    return { tier: QUALITY_TIERS[this.index], index: this.index, fps: this.lastFps, changed: false }
  }
}

// ---------------------------------------------------------------------------
// Geometric level of detail
// ---------------------------------------------------------------------------

/**
 * Screen extent of a world-space sphere, in pixels.
 *
 * The LOD decision has to be about *apparent* size, not distance: a baseplate
 * two hundred units away still covers half the screen, and dropping its edges
 * would be plainly visible, while a 1×1 plate at the same distance is three
 * pixels across and its edges are noise.
 */
export function screenExtentPixels(
  radiusWorld: number,
  distance: number,
  fovRadians: number,
  viewportHeight: number,
): number {
  if (distance <= 1e-6) return viewportHeight
  return (radiusWorld / (distance * Math.tan(fovRadians / 2))) * viewportHeight
}

export interface EdgeBudget {
  /** Batches whose members are at least this many pixels across keep edges. */
  readonly minScreenPixels: number
  /** Total merged edge vertices allowed across the whole scene. */
  readonly vertexBudget: number
}

export const DEFAULT_EDGE_BUDGET: EdgeBudget = { minScreenPixels: 18, vertexBudget: 2_400_000 }

export interface EdgeCandidate {
  readonly key: string
  /** Merged edge vertices this batch would cost. */
  readonly vertices: number
  /** Apparent size of a member, in pixels. */
  readonly screenPixels: number
}

/**
 * Chooses which batches get hard edges under a global vertex budget.
 *
 * Sorted by apparent size so the budget is spent where it is visible, which is
 * the whole point of having one: a model that exceeds the budget should lose
 * the edges on its distant background first, not lose them arbitrarily by
 * whichever batch the plan happened to emit first.
 */
export function allocateEdgeBudget(
  candidates: readonly EdgeCandidate[],
  budget: EdgeBudget = DEFAULT_EDGE_BUDGET,
): Set<string> {
  const eligible = candidates
    .filter((candidate) => candidate.screenPixels >= budget.minScreenPixels && candidate.vertices > 0)
    .sort((a, b) => b.screenPixels - a.screenPixels || a.key.localeCompare(b.key))
  const chosen = new Set<string>()
  let spent = 0
  for (const candidate of eligible) {
    if (spent + candidate.vertices > budget.vertexBudget) continue
    chosen.add(candidate.key)
    spent += candidate.vertices
  }
  return chosen
}
