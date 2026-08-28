import { describe, expect, it } from 'vitest'
import { deriveConnections } from '../cad/snapping'
import { IDENTITY_BASIS } from '../cad/math'
import type { CadOperation } from '../cad/types'
import { createScope } from './analyse'
import {
  ScopeViolationError,
  assertScopeIsolation,
  checkKernelValidity,
  checkProtection,
  checkSilhouette,
  guardCandidate,
  heldPartIds,
} from './guards'
import { runRefinement } from './pipeline'
import { buildCandidateDocument, referenceFor } from './search'
import { silhouetteOf } from './cache'
import { silhouetteFrame } from './silhouette'
import { getDocumentBounds } from '../cad/geometry'
import { compileRequest } from './pipeline'
import { refinementFixture } from './__fixtures__'

/**
 * The invariants, tested as invariants.
 *
 * Each case here constructs the violation deliberately rather than hoping a
 * generator produces one, because the guards exist precisely for the case no
 * generator was supposed to produce.
 */

const scopeOf = (fixture: ReturnType<typeof refinementFixture>) =>
  createScope({
    partIds: fixture.scopePartIds,
    protectedPartIds: fixture.protectedPartIds,
    boundaryPartIds: fixture.boundaryPartIds,
    symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
  })

describe('scope isolation', () => {
  it('throws when an operation reaches a part the request never offered', () => {
    const fixture = refinementFixture('seam-wall')
    const outside = Object.keys(fixture.document.parts).find((id) => !fixture.scopePartIds.includes(id))!
    const operations: CadOperation[] = [{ type: 'part.remove', partId: outside }]
    const after = buildCandidateDocument(fixture.document, operations)

    expect(() => assertScopeIsolation(fixture.document, after, scopeOf(fixture))).toThrow(ScopeViolationError)
    try {
      assertScopeIsolation(fixture.document, after, scopeOf(fixture))
    } catch (cause) {
      expect((cause as ScopeViolationError).partIds).toContain(outside)
    }
  })

  it('throws when a protected part inside the scope is rewritten', () => {
    const fixture = refinementFixture('protected-cap')
    const protectedId = fixture.protectedPartIds[0]
    const operations: CadOperation[] = [
      { type: 'part.transform', partId: protectedId, transform: { position: [0, -100, 0], basis: IDENTITY_BASIS } },
    ]
    const after = buildCandidateDocument(fixture.document, operations)
    expect(() => assertScopeIsolation(fixture.document, after, scopeOf(fixture))).toThrow(/protected or boundary/)
  })

  it('accepts a change confined to the scope', () => {
    const fixture = refinementFixture('seam-wall')
    const inside = fixture.scopePartIds[0]
    const after = buildCandidateDocument(fixture.document, [{ type: 'part.recolor', partId: inside, color: 0 }])
    expect(() => assertScopeIsolation(fixture.document, after, scopeOf(fixture))).not.toThrow()
  })
})

describe('protection', () => {
  it('counts document-locked, document-protected and request-named parts as held', () => {
    const locked = refinementFixture('locked-cockpit')
    const held = heldPartIds(locked.document, scopeOf(locked))
    const lockedIds = locked.document.subassemblies.cockpit.partIds
    expect(lockedIds.length).toBe(2)
    for (const partId of lockedIds) expect(held).toContain(partId)

    const flagged = refinementFixture('protected-cap')
    expect(heldPartIds(flagged.document, scopeOf(flagged))).toContain(flagged.protectedPartIds[0])
  })

  it('refuses a candidate that moves a protected part, naming it', () => {
    const fixture = refinementFixture('protected-cap')
    const protectedId = fixture.protectedPartIds[0]
    const after = buildCandidateDocument(fixture.document, [{ type: 'part.remove', partId: protectedId }])
    const verdict = checkProtection(fixture.document, after, scopeOf(fixture))
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('PROTECTED_PART')
    expect(verdict.partIds).toContain(protectedId)
    expect(verdict.reason).toMatch(/protected/i)
  })

  it('refuses a candidate that severs a boundary connector even when the part itself stays put', () => {
    const fixture = refinementFixture('mechanism-hinge-deck')
    const [hingeBase, hingeTop] = fixture.boundaryPartIds
    // The hinge base does not move; its counterpart is deleted from under it.
    const scope = createScope({
      partIds: [...fixture.scopePartIds, hingeTop],
      boundaryPartIds: [hingeBase],
    })
    const before = fixture.document
    const mates = deriveConnections(before).pairs.filter(
      (pair) => pair.a.partId === hingeBase || pair.b.partId === hingeBase,
    )
    expect(mates.length).toBeGreaterThan(0)

    const after = buildCandidateDocument(before, [{ type: 'part.remove', partId: hingeTop }])
    const verdict = checkProtection(before, after, scope)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('BOUNDARY_MOVED')
    expect(verdict.partIds).toContain(hingeBase)
  })

  it('surfaces the refusal as a rejected proposal with a reason', { timeout: 60_000 }, () => {
    const fixture = refinementFixture('locked-cockpit')
    const run = runRefinement(
      {
        version: 1,
        id: 'req_locked',
        scopePartIds: fixture.scopePartIds,
        baseRevision: fixture.document.revision,
        instruction: fixture.instruction,
        seed: 3,
      },
      fixture.document,
      { budget: { maxIterations: 200, wallClockMs: 8_000 } },
    )
    const refusal = run.proposals.find((proposal) => proposal.rejection?.code === 'PROTECTED_PART')
    expect(refusal).toBeDefined()
    expect(refusal!.status).toBe('rejected')
    expect(refusal!.operations).toHaveLength(0)
    expect(refusal!.rejection!.reason).toMatch(/locked/i)
    for (const partId of fixture.document.subassemblies.cockpit.partIds) {
      expect(refusal!.rejection!.partIds).toContain(partId)
    }
    // The rest of the region is still refined around the held parts.
    expect(run.proposals.some((proposal) => proposal.status === 'ranked')).toBe(true)
  })
})

describe('kernel validity', () => {
  it('rejects a candidate that introduces an intersection', () => {
    const fixture = refinementFixture('seam-wall')
    const [first, second] = fixture.scopePartIds
    // Drop one brick exactly on top of another.
    const target = fixture.document.parts[second]
    const after = buildCandidateDocument(fixture.document, [
      { type: 'part.transform', partId: first, transform: target.transform },
    ])
    const verdict = checkKernelValidity(fixture.document, after)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('COLLISION')
  })

  it('rejects a candidate that orphans a part', () => {
    const fixture = refinementFixture('weak-antenna')
    // Removing the plate under a 1 × 1 brick leaves it attached to nothing.
    const base = Object.keys(fixture.document.parts).find((id) => !fixture.scopePartIds.includes(id))!
    const scope = createScope({ partIds: [base, ...fixture.scopePartIds] })
    const after = buildCandidateDocument(fixture.document, [{ type: 'part.remove', partId: base }])
    const verdict = checkKernelValidity(fixture.document, after)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('DISCONNECTED')
    void scope
  })

  it('accepts a candidate that changes nothing physical', () => {
    const fixture = refinementFixture('seam-wall')
    const after = buildCandidateDocument(fixture.document, [
      { type: 'part.recolor', partId: fixture.scopePartIds[0], color: 0 },
    ])
    expect(checkKernelValidity(fixture.document, after).ok).toBe(true)
  })
})

describe('silhouette tolerance', () => {
  it('passes when no reference was supplied', () => {
    const fixture = refinementFixture('seam-wall')
    expect(checkSilhouette(fixture.document, null, 0).ok).toBe(true)
  })

  it('refuses a change that moves the outline past the request tolerance', () => {
    const fixture = refinementFixture('micro-run-deck')
    const reference = silhouetteOf(fixture.document, silhouetteFrame(getDocumentBounds(fixture.document)))
    // Remove half the run: the outline loses a visible chunk.
    const after = buildCandidateDocument(
      fixture.document,
      fixture.scopePartIds.slice(0, 4).map((partId) => ({ type: 'part.remove', partId }) as const),
    )
    const strict = checkSilhouette(after, reference, 0.01)
    expect(strict.ok).toBe(false)
    expect(strict.code).toBe('SILHOUETTE_DRIFT')
    expect(strict.reason).toMatch(/% of its area/)
    expect(checkSilhouette(after, reference, 0.9).ok).toBe(true)
  })
})

describe('composite guard', () => {
  it('runs every check and passes a legitimate refinement', () => {
    const fixture = refinementFixture('seam-wall')
    const request = compileRequest({
      version: 1,
      id: 'req',
      scopePartIds: fixture.scopePartIds,
      baseRevision: fixture.document.revision,
      instruction: fixture.instruction,
    })
    const reference = referenceFor(fixture.document, request)
    const after = buildCandidateDocument(fixture.document, [
      { type: 'part.recolor', partId: fixture.scopePartIds[0], color: 0 },
    ])
    const verdict = guardCandidate(fixture.document, after, scopeOf(fixture), {
      reference,
      silhouetteToleranceFraction: 0.12,
    })
    expect(verdict.ok).toBe(true)
  })
})
