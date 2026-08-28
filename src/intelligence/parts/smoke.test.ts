import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { resetPartIntelligence, resolvePartIntent } from './resolve'
import { resetSemanticIndex } from './semantic'

let disk: DiskFetch

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetPartIntelligence()
  resetSemanticIndex()
})

afterAll(() => disk.restore())

describe('smoke', () => {
  it('answers a handful of real requests', async () => {
    for (const query of [
      '3001',
      'a transparent windscreen about six studs wide',
      'the mirrored counterpart of wedge 41747',
      'a hinge whose axis points sideways',
      'something cheaper and more common with the same connections as 3068b',
      'a part that bridges a 3-stud gap between two plates',
      'clip that holds a bar',
      'a 40-stud transparent gear',
    ]) {
      const result = await resolvePartIntent(query, { limit: 5 })
      console.log(
        `\n== ${query}  (${result.elapsedMs.toFixed(1)} ms)  unmatched=${JSON.stringify(result.interpretation.unmatchedTerms)}`,
      )
      for (const match of result.matches) {
        console.log(
          `  ${match.confidence.toFixed(2)} ${match.canonicalId.padEnd(10)} ${match.tier.padEnd(10)} ${match.explanation.slice(0, 150)}`,
        )
      }
      expect(result.matches.length).toBeGreaterThan(0)
    }
  }, 60_000)
})
