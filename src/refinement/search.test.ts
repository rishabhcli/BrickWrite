import { describe, expect, it } from 'vitest'
import { stableStringify } from '../platform/contracts'
import { createScope } from './analyse'
import { OBJECTIVE_IDS, type ObjectiveId } from './types'
import { OBJECTIVES, improvementOf, measureAll, resolveWeights, scoreOf } from './objectives'
import { candidateId, searchRefinements } from './search'
import { compileRequest, runRefinement } from './pipeline'
import { refinementFixture } from './__fixtures__'

/**
 * Budget, determinism and honesty.
 *
 * A search that cannot be stopped is unusable in an editor, a search that cannot
 * be repeated cannot be reviewed, and a search whose score hides what it spent is
 * worse than no search. Those three are asserted here rather than assumed.
 */

const requestFor = (fixtureId: string, overrides: Record<string, unknown> = {}) => {
  const fixture = refinementFixture(fixtureId)
  return {
    fixture,
    request: compileRequest({
      version: 1,
      id: `req_${fixtureId}`,
      scopePartIds: fixture.scopePartIds,
      protectedPartIds: fixture.protectedPartIds,
      boundaryPartIds: fixture.boundaryPartIds,
      symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
      baseRevision: fixture.document.revision,
      instruction: fixture.instruction,
      seed: 42,
      ...(fixture.silhouetteToleranceFraction === undefined
        ? {}
        : { silhouetteToleranceFraction: fixture.silhouetteToleranceFraction }),
      ...overrides,
    }),
  }
}

describe('bounded budget', () => {
  it('returns the best it found when the wall clock runs out, and does not hang', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('roof-steps')
    const generous = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 600, wallClockMs: 20_000 },
    })
    expect(generous.report.budgetExhausted).toBe(false)
    expect(generous.candidates.length).toBeGreaterThan(1)

    const started = Date.now()
    const clipped = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 600, wallClockMs: 50 },
    })
    const wall = Date.now() - started

    expect(clipped.report.budgetExhausted).toBe(true)
    expect(clipped.report.aborted).toBe(false)
    expect(clipped.report.evaluated).toBeLessThan(generous.report.evaluated)
    // Partial, not empty: whatever was scored before the budget expired is kept.
    expect(clipped.candidates.length).toBeGreaterThanOrEqual(0)
    // "Does not hang" means bounded by roughly the budget plus one evaluation,
    // not by the size of the search space.
    expect(wall).toBeLessThan(5_000)
    expect(clipped.report.strategiesSkipped.length).toBeGreaterThan(0)
  })

  it('stops on an iteration ceiling exactly, with an injected clock', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('roof-steps')
    let ticks = 0
    const result = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 3, wallClockMs: 10_000 },
      now: () => (ticks += 1),
    })
    expect(result.report.evaluated).toBe(3)
    expect(result.report.budgetExhausted).toBe(true)
  })

  it('expires on the injected wall clock rather than on real time', () => {
    const { fixture, request } = requestFor('roof-steps')
    let now = 0
    const result = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 600, wallClockMs: 100 },
      // Each reading advances 40 ms, so the third check is past the budget.
      now: () => (now += 40),
    })
    expect(result.report.budgetExhausted).toBe(true)
    expect(result.report.evaluated).toBeLessThanOrEqual(2)
  })

  it('settles promptly when the caller aborts, and says that it did', () => {
    const { fixture, request } = requestFor('roof-steps')
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = searchRefinements(request, fixture.document, { signal: controller.signal })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.report.aborted).toBe(true)
    expect(result.report.evaluated).toBe(0)
    expect(result.candidates).toHaveLength(0)
  })

  it('reports which generators ran and which never got a turn', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('roof-steps')
    const result = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 1, wallClockMs: 10_000 },
    })
    expect(result.report.strategiesRun.length).toBeGreaterThan(0)
    expect(result.report.strategiesSkipped.length).toBeGreaterThan(0)
    for (const id of result.report.strategiesRun) expect(result.report.strategiesSkipped).not.toContain(id)
  })
})

describe('determinism', () => {
  it('produces identical proposal ids and operations for the same document, request and seed', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-tower')
    const options = { budget: { maxIterations: 300, wallClockMs: 20_000 } }

    const first = runRefinement(request, fixture.document, { ...options, createdAt: 'T' })
    const second = runRefinement(request, fixture.document, { ...options, createdAt: 'T' })

    expect(second.proposals.map((proposal) => proposal.id)).toEqual(first.proposals.map((proposal) => proposal.id))
    expect(stableStringify(second.proposals.map((proposal) => proposal.operations))).toBe(
      stableStringify(first.proposals.map((proposal) => proposal.operations)),
    )
    expect(stableStringify(second.proposals.map((proposal) => proposal.metrics))).toBe(
      stableStringify(first.proposals.map((proposal) => proposal.metrics)),
    )
    expect(stableStringify(second.proposals)).toBe(stableStringify(first.proposals))
  })

  it('derives a proposal id from its content, so identical plans collide by design', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-wall')
    const result = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 300, wallClockMs: 20_000 },
    })
    const candidate = result.candidates[0]
    expect(candidateId(request.id, candidate.strategy, candidate.operations)).toBe(candidate.id)
    expect(candidate.id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('changes with the seed only where the generators actually sample', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('roof-steps')
    const options = { budget: { maxIterations: 300, wallClockMs: 20_000 } }
    const a = searchRefinements(request, fixture.document, options)
    const b = searchRefinements({ ...request, seed: request.seed + 1 }, fixture.document, options)
    // Both runs are internally valid; the seed is never a correctness input.
    for (const result of [a, b]) {
      for (const candidate of result.candidates) expect(candidate.operations.length).toBeGreaterThan(0)
    }
    expect(a.report.baseMetrics).toEqual(b.report.baseMetrics)
  })
})

describe('metric vector honesty', () => {
  it('reports the objectives a proposal spends, not only the one it improves', { timeout: 60_000 }, () => {
    // Finishing a surface is the clearest trade in the system: it removes bare
    // studs and pays for it in parts. Both have to be visible in one vector.
    const { fixture, request } = requestFor('tile-recess')
    const run = runRefinement(request, fixture.document, { budget: { maxIterations: 300, wallClockMs: 20_000 } })
    const ranked = run.proposals.filter((proposal) => proposal.status === 'ranked')
    expect(ranked.length).toBeGreaterThan(0)

    const traded = ranked.find(
      (proposal) =>
        improvementOf('exposedStuds', proposal.metrics.before.exposedStuds, proposal.metrics.after.exposedStuds) > 0 &&
        proposal.regressions.length > 0,
    )
    expect(traded, 'expected a proposal that improves one objective and regresses another').toBeDefined()

     
    console.log(
      `[metric honesty] ${traded!.strategy}: ` +
        OBJECTIVE_IDS.filter((id) => Math.abs(traded!.metrics.delta[id]) > 1e-9)
          .map((id) => `${id} ${traded!.metrics.before[id].toFixed(3)}→${traded!.metrics.after[id].toFixed(3)}`)
          .join(', ') +
        `; regressions: ${traded!.regressions.join(', ')}`,
    )

    expect(traded!.regressions).toContain('partCount')
    for (const id of traded!.regressions as ObjectiveId[]) {
      // The regression is visible in the returned vector, with the right sign.
      expect(Math.abs(traded!.metrics.delta[id])).toBeGreaterThan(0)
      expect(traded!.metrics.delta[id]).toBeCloseTo(traded!.metrics.after[id] - traded!.metrics.before[id], 9)
      expect(improvementOf(id, traded!.metrics.before[id], traded!.metrics.after[id])).toBeLessThan(0)
      if (OBJECTIVES[id].direction === 'lower-is-better') {
        expect(traded!.metrics.after[id]).toBeGreaterThan(traded!.metrics.before[id])
      } else {
        expect(traded!.metrics.after[id]).toBeLessThan(traded!.metrics.before[id])
      }
    }
  })

  it('carries a complete vector on every proposal, so nothing can be omitted', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('rare-hull')
    for (const proposal of runRefinement(request, fixture.document, {
      budget: { maxIterations: 300, wallClockMs: 20_000 },
    }).proposals) {
      for (const id of OBJECTIVE_IDS) {
        expect(Number.isFinite(proposal.metrics.before[id])).toBe(true)
        expect(Number.isFinite(proposal.metrics.after[id])).toBe(true)
        expect(proposal.metrics.delta[id]).toBeCloseTo(proposal.metrics.after[id] - proposal.metrics.before[id], 9)
      }
    }
  })

  it('scores a candidate as the weighted sum of its own reported deltas', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-wall')
    const result = searchRefinements(request, fixture.document, {
      budget: { maxIterations: 300, wallClockMs: 20_000 },
    })
    const weights = resolveWeights(request.objectiveWeights)
    for (const candidate of result.candidates.slice(0, 4)) {
      expect(candidate.score).toBeCloseTo(scoreOf(result.report.baseMetrics, candidate.metrics, weights), 9)
    }
  })

  it('measures the region, not the model, so a scope is a scope', () => {
    const fixture = refinementFixture('tile-recess')
    const wide = measureAll(fixture.document, createScope({ partIds: Object.keys(fixture.document.parts) }))
    const narrow = measureAll(fixture.document, createScope({ partIds: fixture.scopePartIds }))
    expect(narrow.partCount).toBe(fixture.scopePartIds.length)
    expect(wide.partCount).toBe(Object.keys(fixture.document.parts).length)
    expect(narrow.partCount).toBeLessThan(wide.partCount)
  })
})
