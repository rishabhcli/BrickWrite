/**
 * Capture integrity.
 *
 * `render_capture` is how an agent sees the model. That makes it a *measuring
 * instrument*, and a measuring instrument that quietly returns a stale or
 * mid-animation frame is worse than one that refuses: the agent has no way to
 * tell, so it reasons confidently about a picture of nothing.
 *
 * Three guarantees are enforced here, and each has a test that can fail:
 *
 *   1. **Settled.** Motion is suppressed and every tween jumped to its target
 *      before a pixel is read, so the same revision in the same mode produces
 *      the same image whether or not an animation happened to be running.
 *   2. **Revision-exact.** The revision recorded in the metadata is read *after*
 *      the frame is drawn, from the same snapshot the frame came from, so a
 *      commit landing during the capture cannot leave the picture describing one
 *      revision and the metadata another.
 *   3. **Distinguishable.** Two meaningfully different render modes hash
 *      differently. A hash that collided across modes would let an agent
 *      conclude that switching to the collision view showed it nothing new.
 */

/**
 * FNV-1a over the drawing buffer, widened to 64 bits by running two
 * independently seeded lanes.
 *
 * A 32-bit digest over a two-megapixel image collides often enough to matter
 * when the comparison being made is "did anything change" — birthday collisions
 * at 2^16 samples are already a percent. Two lanes with different primes give a
 * digest whose collisions are not a practical concern, at the cost of one extra
 * multiply per byte. Deliberately not a cryptographic hash: this detects change,
 * it does not resist forgery, and SHA over four megabytes per capture would show
 * up in the capture latency.
 */
export function hashPixels(pixels: Uint8Array | Uint8ClampedArray, stride = 1): string {
  let low = 0x811c9dc5
  let high = 0x01000193
  const step = Math.max(1, Math.floor(stride))
  for (let index = 0; index < pixels.length; index += step) {
    const byte = pixels[index]
    low = Math.imul(low ^ byte, 0x01000193)
    high = Math.imul(high ^ (byte + index), 0x85ebca6b)
  }
  return `${(low >>> 0).toString(16).padStart(8, '0')}${(high >>> 0).toString(16).padStart(8, '0')}`
}

/** Digest of a data URL's payload, for callers that only hold the encoded image. */
export function hashDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const bytes = new Uint8Array(payload.length)
  for (let index = 0; index < payload.length; index += 1) bytes[index] = payload.charCodeAt(index) & 0xff
  return hashPixels(bytes)
}

export interface CaptureMetadata {
  readonly documentRevision: number
  readonly renderMode: string
  readonly cameraView: string
  readonly width: number
  readonly height: number
  /** Digest of the drawing buffer, stable for the same revision and mode. */
  readonly pixelHash: string
  /** True when animation was suppressed for the read, which it always should be. */
  readonly settled: boolean
  /** Parts drawn at full fidelity, which isolation and clipping can reduce. */
  readonly visiblePartCount: number
}

/**
 * The capture contract, as a checkable statement rather than a comment.
 *
 * Returns the reasons a capture is not trustworthy. An empty array is the only
 * acceptable result; anything else belongs in the tool response as a warning,
 * because an agent told "here is your picture, and by the way the renderer was
 * mid-animation" can act sensibly, and an agent told nothing cannot.
 */
export function captureWarnings(metadata: CaptureMetadata, expectedRevision?: number): string[] {
  const warnings: string[] = []
  if (!metadata.settled) warnings.push('Captured while animation was running; the frame may not be reproducible.')
  if (expectedRevision !== undefined && expectedRevision !== metadata.documentRevision) {
    warnings.push(
      `Document moved from revision ${expectedRevision} to ${metadata.documentRevision} during the capture.`,
    )
  }
  if (!metadata.width || !metadata.height) warnings.push('The drawing buffer was empty when the capture was read.')
  return warnings
}

/**
 * Render modes that must never share a digest.
 *
 * Listed explicitly so the assertion is about the *product decision* — these
 * views show genuinely different things — rather than about whatever the
 * renderer happens to do today. `orthographic` is in the list because a parallel
 * projection of the same model is a different picture, and an agent asking for
 * measurable geometry needs to know it got one.
 */
export const DISTINCT_CAPTURE_MODES = ['beauty', 'orthographic', 'silhouette', 'connections', 'violations', 'exploded'] as const

export type DistinctCaptureMode = (typeof DISTINCT_CAPTURE_MODES)[number]

/**
 * Checks a set of captures for the properties the contract promises.
 *
 * Returns the failures rather than throwing, so both the unit test and the
 * browser acceptance run can report *which* pair collided instead of only that
 * something did.
 */
export function checkCaptureSet(
  captures: ReadonlyArray<{ mode: string; revision: number; hash: string }>,
): string[] {
  const failures: string[] = []
  const byMode = new Map<string, Set<string>>()
  for (const capture of captures) {
    const key = `${capture.mode}@${capture.revision}`
    const seen = byMode.get(key) ?? new Set<string>()
    seen.add(capture.hash)
    byMode.set(key, seen)
  }
  for (const [key, hashes] of byMode) {
    if (hashes.size > 1) failures.push(`${key} produced ${hashes.size} different hashes; capture is not reproducible`)
  }
  const representative = new Map<string, string>()
  for (const capture of captures) {
    const key = `${capture.mode}@${capture.revision}`
    if (!representative.has(key)) representative.set(key, capture.hash)
  }
  const byHash = new Map<string, string[]>()
  for (const [key, hash] of representative) {
    const bucket = byHash.get(hash) ?? []
    bucket.push(key)
    byHash.set(hash, bucket)
  }
  for (const [hash, keys] of byHash) {
    if (keys.length > 1) failures.push(`${keys.join(' and ')} share hash ${hash}; the modes are indistinguishable`)
  }
  return failures
}
