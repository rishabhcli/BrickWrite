import { describe, expect, it } from 'vitest'
import { mulberry32, stableStringify } from '../platform/contracts'
import type { CadOperation, ModelDocument } from '../cad/types'
import { createScope } from './analyse'
import { STRATEGIES, strategiesFor, strategyById, STRATEGY_IDS } from './strategies'
import { refinementOperationSchema } from './types'
import { buildCandidateDocument } from './search'
import { assertScopeIsolation } from './guards'
import { refinementFixtures, refinementFixture } from './__fixtures__'

/**
 * The generator contract.
 *
 * Every alternative generator is a pure `(document, scope, rng) => operations[][]`.
 * "Pure" is asserted rather than stated: the document is compared before and
 * after, the same seed is required to produce the same batches, and every
 * operation is parsed against the narrow refinement vocabulary so a generator
 * cannot reach an operation kind the workflow does not permit.
 */

const fixtures = refinementFixtures()

const scopeOf = (fixture: (typeof fixtures)[number]) =>
  createScope({
    partIds: fixture.scopePartIds,
    protectedPartIds: fixture.protectedPartIds,
    boundaryPartIds: fixture.boundaryPartIds,
    symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
  })

const runAll = (document: ModelDocument, fixture: (typeof fixtures)[number], seed: number) =>
  STRATEGIES.map((entry) => ({ entry, batches: entry.run(document, scopeOf(fixture), mulberry32(seed)) }))

describe('registry', () => {
  it('names every generator once, with the objectives it exists to move', () => {
    expect(new Set(STRATEGY_IDS).size).toBe(STRATEGIES.length)
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(7)
    for (const entry of STRATEGIES) {
      expect(strategyById(entry.id)).toBe(entry)
      expect(entry.targets.length).toBeGreaterThan(0)
      expect(entry.summary.length).toBeGreaterThan(20)
    }
    for (const required of ['restack', 'substitute', 'reinforce', 'smooth', 'symmetrize', 'simplify', 'detail']) {
      expect(STRATEGY_IDS).toContain(required)
    }
  })

  it('selects generators by the objectives a request actually weights', () => {
    expect(strategiesFor({ symmetryError: 2 }).map((entry) => entry.id)).toEqual(['symmetrize'])
    expect(strategiesFor({ seamBonding: 1 }).map((entry) => entry.id)).toContain('restack')
    // A weight vector nothing can move runs everything rather than nothing.
    expect(strategiesFor({}).length).toBe(STRATEGIES.length)
    expect(strategiesFor({ silhouetteFidelity: 0 }).length).toBe(STRATEGIES.length)
  })
})

describe('generators are pure and deterministic', () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))('%s', { timeout: 60_000 }, (_id, fixture) => {
    const snapshot = stableStringify(fixture.document)
    const first = runAll(fixture.document, fixture, 99)
    expect(stableStringify(fixture.document)).toBe(snapshot)

    const second = runAll(fixture.document, fixture, 99)
    for (let index = 0; index < first.length; index += 1) {
      expect(stableStringify(second[index].batches)).toBe(stableStringify(first[index].batches))
    }
  })
})

describe('generators emit only the refinement vocabulary', () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))('%s', { timeout: 60_000 }, (_id, fixture) => {
    for (const { entry, batches } of runAll(fixture.document, fixture, 5)) {
      for (const batch of batches) {
        expect(batch.length, `${entry.id} emitted an empty batch`).toBeGreaterThan(0)
        for (const operation of batch as CadOperation[]) {
          const parsed = refinementOperationSchema.safeParse(operation)
          expect(parsed.success, `${entry.id} emitted ${JSON.stringify(operation).slice(0, 80)}`).toBe(true)
        }
        // And whatever it emitted stays inside the scope it was handed.
        const after = buildCandidateDocument(fixture.document, batch as CadOperation[])
        expect(() => assertScopeIsolation(fixture.document, after, scopeOf(fixture))).not.toThrow()
      }
    }
  })
})

describe('generators use content-derived ids', () => {
  it('never invents a random identifier, so two identical plans are one plan', () => {
    const fixture = refinementFixture('seam-wall')
    const added = runAll(fixture.document, fixture, 1)
      .flatMap(({ batches }) => batches.flat())
      .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
    expect(added.length).toBeGreaterThan(0)
    for (const operation of added) {
      expect(operation.part.id).toMatch(/^ref_[0-9a-z]+_[0-9a-z]+$/)
      expect(operation.part.id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
    }
  })
})

describe('each generator fires on the fixture it was written for', () => {
  it.each([
    ['restack', 'seam-wall'],
    ['substitute', 'rare-hull'],
    ['reinforce', 'weak-antenna'],
    ['smooth', 'stepped-shelf'],
    ['symmetrize', 'symmetric-antenna'],
    ['simplify', 'micro-run-deck'],
    ['detail', 'tile-recess'],
  ])('%s on %s', (strategyId, fixtureId) => {
    const fixture = refinementFixture(fixtureId)
    const entry = strategyById(strategyId)!
    const batches = entry.run(fixture.document, scopeOf(fixture), mulberry32(3))
    expect(batches.length).toBeGreaterThan(0)
  })

  it('produces nothing when there is nothing of its kind to fix', () => {
    const fixture = refinementFixture('tile-recess')
    // A tiled recess has no stacked joints and no runs of identical bricks.
    expect(strategyById('restack')!.run(fixture.document, scopeOf(fixture), mulberry32(1))).toEqual([])
    expect(strategyById('simplify')!.run(fixture.document, scopeOf(fixture), mulberry32(1))).toEqual([])
  })
})
