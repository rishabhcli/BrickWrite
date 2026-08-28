import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import evaluation from './__fixtures__/evaluation.json'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { resetPartIntelligence, resolvePartIntent, warmPartIntelligence } from './resolve'
import { resetSemanticIndex } from './semantic'
import type { PartIntentResult } from '../../platform/contracts'

/**
 * The accuracy gate.
 *
 * 129 requests written by hand against the real catalog - shape, function,
 * dimension, colour, connector, derived relation and ten requests that cannot
 * be satisfied at all. Acceptable answers were chosen from catalog facts (LDraw
 * names, measured envelopes, connector families, LEGO numbering) before any of
 * them was run through the resolver, so this measures the resolver rather than
 * describing it.
 *
 * The impossible cases are scored separately and deliberately: their pass
 * condition is not a part number, it is that the resolver says out loud which
 * part of the request it could not meet.
 */

interface EvaluationQuery {
  query: string
  kind: string
  accept: string[]
  rationale: string
  expectUnmatched?: string[]
}

const QUERIES = evaluation.queries as EvaluationQuery[]
const TOP_K = 5
/** Every answerable query must be reachable in the top five at least this often. */
const RECALL_FLOOR = 0.9

let disk: DiskFetch
const results = new Map<string, PartIntentResult>()

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetPartIntelligence()
  resetSemanticIndex()
  await warmPartIntelligence()
  for (const entry of QUERIES) {
    results.set(entry.query, await resolvePartIntent(entry.query, { limit: TOP_K }))
  }
}, 120_000)

afterAll(() => disk.restore())

describe('part intent evaluation', () => {
  it(`recalls an acceptable identity in the top ${TOP_K} for at least ${RECALL_FLOOR * 100}% of requests`, () => {
    const answerable = QUERIES.filter((entry) => entry.kind !== 'impossible')
    const misses: string[] = []
    const byKind = new Map<string, { hit: number; total: number }>()

    for (const entry of answerable) {
      const result = results.get(entry.query)!
      const returned = result.matches.slice(0, TOP_K).map((match) => match.canonicalId)
      const hit = returned.some((id) => entry.accept.includes(id))
      const bucket = byKind.get(entry.kind) ?? { hit: 0, total: 0 }
      bucket.total += 1
      if (hit) bucket.hit += 1
      else misses.push(`  ${entry.kind.padEnd(11)} "${entry.query}" -> ${returned.join(', ') || '(nothing)'}`)
      byKind.set(entry.kind, bucket)
    }

    const recall = (answerable.length - misses.length) / answerable.length
    console.log(
      `\ntop-${TOP_K} recall: ${(recall * 100).toFixed(1)}% (${answerable.length - misses.length}/${answerable.length})`,
    )
    for (const [kind, bucket] of [...byKind].sort()) {
      console.log(`  ${kind.padEnd(11)} ${bucket.hit}/${bucket.total}`)
    }
    if (misses.length) console.log(`misses:\n${misses.join('\n')}`)

    expect(QUERIES.length).toBeGreaterThanOrEqual(100)
    expect(recall).toBeGreaterThanOrEqual(RECALL_FLOOR)
  })

  it('answers an impossible request with low confidence and a named unmet condition', () => {
    const impossible = QUERIES.filter((entry) => entry.kind === 'impossible')
    expect(impossible.length).toBeGreaterThanOrEqual(5)

    for (const entry of impossible) {
      const result = results.get(entry.query)!
      const best = result.matches[0]?.confidence ?? 0
      // A wrong answer delivered confidently is the failure mode this whole
      // module exists to avoid, so the bar is the confidence, not the ids.
      expect(best, `${entry.query} came back at ${best.toFixed(2)}`).toBeLessThan(0.35)
      expect(result.interpretation.unmatchedTerms.length, `${entry.query} reported nothing unmatched`).toBeGreaterThan(0)
      for (const fragment of entry.expectUnmatched ?? []) {
        // Matched as a fragment: the parser reports the phrase it actually read
        // ("30 studs wide"), which is more specific than the fixture needs to
        // pin down, and pinning the exact wording would test the wording.
        expect(
          result.interpretation.unmatchedTerms.some((term) => term.includes(fragment)),
          `${entry.query} -> ${JSON.stringify(result.interpretation.unmatchedTerms)}`,
        ).toBe(true)
      }
    }
  })

  it('never reports a part as placeable unless this build carries its geometry', () => {
    for (const [query, result] of results) {
      for (const match of result.matches) {
        if (match.placeable) {
          expect(match.tier, query).toBe('placeable')
        } else {
          expect(match.tier === 'modelled' || match.tier === 'catalogued' || match.tier === 'placeable').toBe(true)
        }
      }
    }
  })
})
