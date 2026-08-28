import { describe, expect, it } from 'vitest'
import { findCollisions, residentGeometryProvider } from '../cad/collision'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { connectedComponent, evaluateConstraints, validateDocument } from '../cad/validation'
import { stableStringify } from '../platform/contracts'
import { componentsOf } from './guards'
import { OBJECTIVES, improvementOf } from './objectives'
import { runRefinement } from './pipeline'
import { buildCandidateDocument } from './search'
import { refinementFixtures, type RefinementFixture } from './__fixtures__'
import type { RefinementProposalV1, RefinementRequestInput } from './types'

/**
 * The fixture suite.
 *
 * Twenty deliberately-broken models, each carrying a claim: this defect is
 * measurable, and the engine measurably reduces it. Every gate below is asserted
 * against all twenty rather than against a chosen example, because a refinement
 * engine that works on the case it was written for is not a refinement engine.
 */

const BUDGET = { maxIterations: 600, wallClockMs: 15_000 }

const requestFor = (fixture: RefinementFixture): RefinementRequestInput => ({
  version: 1,
  id: `req_${fixture.id}`,
  scopePartIds: fixture.scopePartIds,
  protectedPartIds: fixture.protectedPartIds,
  boundaryPartIds: fixture.boundaryPartIds,
  symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
  baseRevision: fixture.document.revision,
  instruction: fixture.instruction,
  seed: 7,
  ...(fixture.silhouetteToleranceFraction === undefined
    ? {}
    : { silhouetteToleranceFraction: fixture.silhouetteToleranceFraction }),
})

const fixtures = refinementFixtures()

/** One pipeline run per fixture, shared by every gate below. */
const runs = new Map<string, ReturnType<typeof runRefinement>>()
const runFor = (fixture: RefinementFixture) => {
  const cached = runs.get(fixture.id)
  if (cached) return cached
  const run = runRefinement(requestFor(fixture), fixture.document, { budget: BUDGET, createdAt: '2026-08-28T00:00:00.000Z' })
  runs.set(fixture.id, run)
  return run
}

const rankedOf = (fixture: RefinementFixture): RefinementProposalV1[] =>
  runFor(fixture).proposals.filter((proposal) => proposal.status === 'ranked')

describe('refinement fixtures', () => {
  it('covers every class the engine claims to handle', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15)
    const classes = new Set(fixtures.map((fixture) => fixture.klass))
    for (const klass of ['structural', 'aesthetic', 'palette', 'rarity', 'silhouette', 'mechanism', 'protection']) {
      expect(classes).toContain(klass)
    }
    // Fixture ids are used as test names and as cache keys; duplicates would
    // silently halve the suite.
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(fixtures.length)
  })

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    '%s loads, validates and is one connected model',
    (_id, fixture) => {
      const report = validateDocument(fixture.document)
      expect(report.partCount).toBe(Object.keys(fixture.document.parts).length)
      expect(report.collisions).toHaveLength(0)
      // A fixture in a colour the element was never produced in would make every
      // palette assertion meaningless.
      expect(report.virtualColors).toHaveLength(0)
      expect(report.componentCount).toBe(1)
      expect(report.connectionCount).toBeGreaterThan(0)
      expect(report.healthy).toBe(true)
      expect(verifyBuildOrder(fixture.document, computeBuildOrder(fixture.document).steps).valid).toBe(true)
      for (const partId of fixture.scopePartIds) expect(fixture.document.parts[partId]).toBeDefined()
    },
  )
})

describe('refinement improves the objective each fixture targets', () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    '%s',
    (_id, fixture) => {
      const ranked = rankedOf(fixture)
      expect(ranked.length).toBeGreaterThanOrEqual(1)

      const target = fixture.targetObjective
      const definition = OBJECTIVES[target]
      const best = ranked
        .map((proposal) => ({
          proposal,
          gain: improvementOf(target, proposal.metrics.before[target], proposal.metrics.after[target]),
        }))
        .sort((a, b) => b.gain - a.gain)[0]

      // eslint-disable-next-line no-console
      console.log(
        `[${fixture.id}] ${definition.label} (${definition.direction}) ` +
          `${best.proposal.metrics.before[target].toFixed(3)} → ${best.proposal.metrics.after[target].toFixed(3)} ` +
          `via "${best.proposal.label}" (${best.proposal.strategy}); ${ranked.length} ranked, ` +
          `${runFor(fixture).report.evaluated} candidates scored in ${runFor(fixture).report.elapsedMs} ms`,
      )

      expect(best.gain).toBeGreaterThan(0)
      const before = best.proposal.metrics.before[target]
      const after = best.proposal.metrics.after[target]
      if (definition.direction === 'lower-is-better') expect(after).toBeLessThan(before)
      else expect(after).toBeGreaterThan(before)
      // The delta the proposal reports must be the delta its own numbers imply.
      expect(best.proposal.metrics.delta[target]).toBeCloseTo(after - before, 9)
    },
  )
})

describe('scope isolation', () => {
  /**
   * The single most important property in this workstream.
   *
   * Every part the request did not name is byte-identical afterwards — compared
   * by canonical serialization, so a field added to `PartInstance` later is
   * covered without anybody remembering to extend this test. Checked for every
   * proposal of every fixture, not for a sampled one, because the failure mode
   * is a strategy that is *usually* well behaved.
   */
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    '%s leaves every part outside the scope untouched',
    (_id, fixture) => {
      const scope = new Set(fixture.scopePartIds)
      const outside = Object.keys(fixture.document.parts).filter((partId) => !scope.has(partId))
      const proposals = runFor(fixture).proposals.filter((proposal) => proposal.operations.length > 0)
      expect(proposals.length).toBeGreaterThan(0)

      for (const proposal of proposals) {
        const after = buildCandidateDocument(fixture.document, proposal.operations)
        for (const partId of outside) {
          expect(after.parts[partId], `${proposal.id} deleted out-of-scope part ${partId}`).toBeDefined()
          expect(
            stableStringify(after.parts[partId]),
            `${proposal.id} (${proposal.strategy}) modified out-of-scope part ${partId}`,
          ).toBe(stableStringify(fixture.document.parts[partId]))
        }
        // And the converse: nothing it reports as changed may be outside either.
        for (const partId of proposal.changedPartIds) {
          const preExisting = Boolean(fixture.document.parts[partId])
          if (preExisting) expect(scope.has(partId)).toBe(true)
        }
      }
    },
  )
})

describe('kernel validity of every ranked proposal', () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    '%s: no new collisions, orphans, constraint failures or unreachable steps',
    (_id, fixture) => {
      const before = fixture.document
      const baseCollisions = findCollisions(before, { provide: residentGeometryProvider })
      const baseComponents = componentsOf(before).length
      const baseConstraints = new Map(evaluateConstraints(before).map((entry) => [entry.id, entry.status]))

      for (const proposal of rankedOf(fixture)) {
        const after = buildCandidateDocument(before, proposal.operations)
        const collisions = findCollisions(after, { provide: residentGeometryProvider })

        // Nothing triangle-confirmed, ever.
        expect(collisions.filter((contact) => contact.certainty !== 'unknown')).toHaveLength(0)
        expect(collisions.length).toBeLessThanOrEqual(baseCollisions.length)

        expect(componentsOf(after).length).toBeLessThanOrEqual(baseComponents)
        const anchors = fixture.scopePartIds.filter((partId) => after.parts[partId])
        if (anchors.length) {
          const reachable = new Set(connectedComponent(after, anchors))
          for (const partId of proposal.overlay.filter((entry) => entry.changeKind === 'added')) {
            expect(reachable.has(partId.partId)).toBe(true)
          }
        }

        for (const constraint of evaluateConstraints(after)) {
          if (constraint.status === 'fail') expect(baseConstraints.get(constraint.id)).toBe('fail')
        }

        const order = computeBuildOrder(after)
        expect(verifyBuildOrder(after, order.steps).valid).toBe(true)
      }
    },
  )
})

describe('overlay instructions', () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    '%s describes every changed part exactly once',
    (_id, fixture) => {
      for (const proposal of rankedOf(fixture)) {
        const ids = proposal.overlay.map((entry) => entry.partId)
        expect(new Set(ids).size).toBe(ids.length)
        expect([...ids].sort()).toEqual([...proposal.changedPartIds].sort())
        for (const entry of proposal.overlay) {
          expect(entry.magnitude).toBeGreaterThan(0)
          expect(entry.magnitude).toBeLessThanOrEqual(1)
          expect(entry.detail.length).toBeGreaterThan(0)
          expect(entry.atLdu.every((value) => Number.isFinite(value))).toBe(true)
        }
        // Sorted hottest-first, so a viewport can truncate the list and still be
        // showing the biggest changes.
        const magnitudes = proposal.overlay.map((entry) => entry.magnitude)
        expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes)
      }
    },
  )
})
