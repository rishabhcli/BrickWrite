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
 * costs, cheapest sacrifice first. Hard-edge density drops before shadows because edges
 * are a legibility aid the silhouette and material already partly supply,
 * whereas losing contact shadows makes the model appear to float — a
 * *spatial* misreading, not a cosmetic one.
 */

export interface QualityTier {
  readonly name: string
  /** Device pixel ratio ceiling. */
  readonly maxDpr: number
  /** Draw budgeted hard edges; even minimum retains a small allocation. */
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
  { name: 'fast', maxDpr: 1, edges: true, shadowMapSize: 1024, contactShadowResolution: 0, environmentIntensity: 0.45, antialias: true },
  { name: 'minimum', maxDpr: 1, edges: true, shadowMapSize: 0, contactShadowResolution: 0, environmentIntensity: 0.4, antialias: false },
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
 * Pixels spanned by a normalised-device-coordinate height difference.
 *
 * The LOD decision has to be about *apparent* size, not distance: a baseplate
 * two hundred units away still covers half the screen, and dropping its edges
 * would be plainly visible, while a 1×1 plate at the same distance is three
 * pixels across and its edges are noise.
 *
 * The caller projects, so this works for an orthographic camera as well as a
 * perspective one — which matters, because the editor has an orthographic mode
 * and apparent size does not fall off with distance there at all.
 *
 * **The division by two is the point.** NDC runs from −1 to 1, so the viewport
 * is *two* units tall, and the obvious `delta * viewportHeight` over-reports by
 * exactly 2×. It did: measured against a known frustum, a sphere whose true
 * extent was 107.2 px was reported as 214.5. This replaced a closed-form
 * `screenExtentPixels` helper that had the same factor, was perspective-only,
 * and — despite two passing tests — was called by nothing; a constant factor is
 * invisible to a test that only checks the value grows and shrinks.
 */
export const ndcHeightToPixels = (ndcDelta: number, viewportHeight: number): number =>
  (Math.abs(ndcDelta) * viewportHeight) / 2

export interface EdgeBudget {
  /** Batches whose members are at least this many pixels across keep edges. */
  readonly minScreenPixels: number
  /** Total merged edge vertices allowed across the whole scene. */
  readonly vertexBudget: number
}

// 9, not 18: the screen-extent measurement used to over-report by 2× (see
// `ndcHeightToPixels`), so the old 18 was really nine pixels. Halved alongside
// the fix so the correction is a change of units and not a change of behaviour.
export const DEFAULT_EDGE_BUDGET: EdgeBudget = { minScreenPixels: 9, vertexBudget: 2_400_000 }

export interface EdgeCandidate {
  readonly key: string
  /** Merged edge vertices this batch would cost. */
  readonly vertices: number
  /** Apparent size of a member, in pixels. */
  readonly screenPixels: number
}

/**
 * How much of each batch's edge buffer to draw, best-visible first.
 *
 * A partial grant rather than a yes/no: an all-or-nothing allocator skipped any
 * batch bigger than the whole budget, so the largest thing on screen was the one
 * thing without outlines. Counts are always even because `setDrawRange` counts
 * vertices and an edge is two of them — an odd grant would draw a line from a
 * real corner to nowhere.
 *
 * Ranked by projected size so a model past its budget loses its distant
 * background, not whichever batch the plan happened to emit first, and ties break
 * on key so a still camera cannot produce a different frame each render.
 */
export function allocateEdgeVertexCounts(candidates: readonly EdgeCandidate[], budget: EdgeBudget = DEFAULT_EDGE_BUDGET): Map<string, number> {
  let remaining = Math.max(0, Math.floor(budget.vertexBudget / 2) * 2)
  const result = new Map<string, number>()
  const ranked = candidates.filter(candidate => candidate.screenPixels >= budget.minScreenPixels && candidate.vertices > 0)
    .sort((a, b) => b.screenPixels - a.screenPixels || a.key.localeCompare(b.key))
  for (const candidate of ranked) {
    const count = Math.min(remaining, Math.floor(candidate.vertices / 2) * 2)
    result.set(candidate.key, count)
    remaining -= count
  }
  return result
}

/** Automatic quality reduces outline density, never removes all large-model edges. */
export function edgeBudgetForTier(tier: QualityTier): EdgeBudget {
  const vertices: Record<string, number> = { ultra: 2_400_000, high: 2_400_000, balanced: 1_200_000, fast: 400_000, minimum: 120_000 }
  return { minScreenPixels: DEFAULT_EDGE_BUDGET.minScreenPixels, vertexBudget: vertices[tier.name] ?? DEFAULT_EDGE_BUDGET.vertexBudget }
}

/**
 * Merged edge vertices to draw while the camera is moving.
 *
 * Hard edges are the most expensive thing in a large frame and the cheapest
 * thing to thin out. Measured on an M3 Max at 5,000 parts, where the scene's
 * merged buffers hold 2,160,512 edge vertices — 1,080,256 line segments, drawn
 * in full because the `high` tier's budget of 2,400,000 never bites:
 *
 *   100% of the edges → 13.86 ms a frame
 *    50%              → 10.84 ms
 *    25%              →  9.40 ms
 *    10%              →  9.06 ms
 *     0%              →  8.13 ms
 *
 * The knee is around a quarter: a further cut to a tenth buys 0.34 ms where the
 * cut to a quarter bought 4.46 ms. Half a million vertices is that knee, and it
 * is an absolute figure rather than a fraction so that a model small enough to
 * draw every edge keeps every edge — below this many, motion changes nothing.
 *
 * Thinning only *while moving* is the whole point. A still frame is what the
 * operator reads a model from, and it keeps every outline. A moving frame is
 * what they judge the tool's responsiveness from, and 4.46 ms is a third of the
 * budget at 5,000 parts.
 */
export const MOTION_EDGE_VERTEX_BUDGET = 500_000

/** Seconds after the camera stops before full edge density comes back. */
export const EDGE_MOTION_SETTLE_SECONDS = 0.15

/**
 * Fraction of each batch's edge buffer to draw this frame.
 *
 * Proportional rather than a re-run of `allocateEdgeVertexCounts` against a
 * smaller budget, and deliberately so: that allocator fills greedily by apparent
 * size, which is right for batches that differ in apparent size but not for
 * merged edge buffers, every one of which spans its whole batch and therefore
 * reports the *model's* extent. Ranking them is a coin toss, and a greedy fill
 * would hand some part/colour groups every outline and others none — visibly,
 * and differently from one moment to the next.
 *
 * Cutting every batch by the same fraction, against `buildMergedEdgeGeometry`'s
 * longest-first ordering, instead takes each part's shortest edges: the chords
 * around a stud go before the twelve edges of the brick.
 */
export function movingEdgeShare(
  totalVertices: number,
  moving: boolean,
  budget = MOTION_EDGE_VERTEX_BUDGET,
): number {
  if (!moving || totalVertices <= budget || totalVertices <= 0) return 1
  return budget / totalVertices
}
