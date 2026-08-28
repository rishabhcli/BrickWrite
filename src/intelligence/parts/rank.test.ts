import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import evaluation from './__fixtures__/evaluation.json'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { CALIBRATION_PARAMETERS, calibrateConfidence } from './rank'
import { resetPartIntelligence, resolvePartIntent, warmPartIntelligence } from './resolve'
import { resetSemanticIndex } from './semantic'

/**
 * Confidence has to mean something.
 *
 * The number this resolver publishes is a claim that the match is what the
 * person asked for, and an agent is expected to act on it, so it is fitted
 * rather than invented: a logistic over the fused evidence score, trained on
 * every ranked candidate of every evaluation query, labelled by whether that
 * candidate is one of the query's acceptable answers.
 *
 * This test refits the same objective from scratch and fails if the constants
 * baked into `rank.ts` have drifted away from it, and then checks the thing
 * that actually matters: that within each confidence band, roughly that
 * fraction of matches really are correct.
 */

interface EvaluationQuery {
  query: string
  kind: string
  accept: string[]
}

const QUERIES = evaluation.queries as EvaluationQuery[]
/** Confidences are clamped at the extremes, where the score is unrecoverable. */
const CLAMP_LOW = 0.011
const CLAMP_HIGH = 0.969

let disk: DiskFetch
const samples: Array<{ score: number; label: number; confidence: number }> = []

/** Inverts the published confidence back to the fused evidence score it came from. */
const scoreOf = (confidence: number) =>
  (Math.log(confidence / (1 - confidence)) - CALIBRATION_PARAMETERS.intercept) / CALIBRATION_PARAMETERS.slope

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetPartIntelligence()
  resetSemanticIndex()
  await warmPartIntelligence()
  for (const entry of QUERIES) {
    const result = await resolvePartIntent(entry.query, { limit: 10 })
    for (const match of result.matches) {
      if (match.confidence <= CLAMP_LOW || match.confidence >= CLAMP_HIGH) continue
      samples.push({
        score: scoreOf(match.confidence),
        label: entry.accept.includes(match.canonicalId) ? 1 : 0,
        confidence: match.confidence,
      })
    }
  }
}, 120_000)

afterAll(() => disk.restore())

describe('confidence calibration', () => {
  it('matches a logistic refitted from the evaluation set', () => {
    expect(samples.length).toBeGreaterThan(400)

    // Plain batch gradient ascent on the log-likelihood. Deterministic: fixed
    // start, fixed step, fixed iteration count, samples in fixture order.
    let slope = 0.5
    let intercept = -3
    const rate = 0.05
    for (let step = 0; step < 4000; step += 1) {
      let slopeGradient = 0
      let interceptGradient = 0
      for (const sample of samples) {
        const predicted = 1 / (1 + Math.exp(-(slope * sample.score + intercept)))
        const error = sample.label - predicted
        slopeGradient += error * sample.score
        interceptGradient += error
      }
      slope += (rate * slopeGradient) / samples.length
      intercept += (rate * interceptGradient) / samples.length
    }

    console.log(
      `\ncalibration: ${samples.length} samples, refit slope ${slope.toFixed(4)} intercept ${intercept.toFixed(4)}` +
        ` (baked ${CALIBRATION_PARAMETERS.slope} / ${CALIBRATION_PARAMETERS.intercept})`,
    )
    expect(Math.abs(slope - CALIBRATION_PARAMETERS.slope)).toBeLessThan(0.12)
    expect(Math.abs(intercept - CALIBRATION_PARAMETERS.intercept)).toBeLessThan(0.35)
  })

  it('reports confidences that track the observed hit rate', () => {
    const bins = Array.from({ length: 10 }, () => ({ total: 0, hits: 0, sum: 0 }))
    for (const sample of samples) {
      const bin = bins[Math.min(9, Math.floor(sample.confidence * 10))]
      bin.total += 1
      bin.hits += sample.label
      bin.sum += sample.confidence
    }

    let error = 0
    const lines: string[] = []
    for (const [index, bin] of bins.entries()) {
      if (!bin.total) continue
      const observed = bin.hits / bin.total
      const predicted = bin.sum / bin.total
      error += (bin.total / samples.length) * Math.abs(observed - predicted)
      lines.push(
        `  ${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}  n=${String(bin.total).padStart(4)}` +
          `  predicted ${predicted.toFixed(3)}  observed ${observed.toFixed(3)}`,
      )
    }
    console.log(`\nexpected calibration error: ${error.toFixed(4)}\n${lines.join('\n')}`)
    // A resolver whose 70% band is right 40% of the time is worse than one with
    // no confidence at all, because a caller cannot tell the two apart.
    expect(error).toBeLessThan(0.12)
  })

  it('never claims certainty', () => {
    expect(calibrateConfidence(1000)).toBeLessThanOrEqual(0.97)
    expect(calibrateConfidence(-1000)).toBeGreaterThanOrEqual(0.01)
    // Monotone in evidence, so a stronger match can never look weaker.
    expect(calibrateConfidence(4)).toBeGreaterThan(calibrateConfidence(2))
  })
})
