import { describe, expect, it } from 'vitest'
import { CadEngine, cadEngine } from '../cad/engine'
import { stableStringify } from '../platform/contracts'
import {
  RefinementRequestError,
  applyRefinement,
  busFor,
  compileRequest,
  proposeRefinements,
  runRefinement,
} from './pipeline'
import { refinementFixture } from './__fixtures__'
import type { RefinementProposalV1 } from './types'

/**
 * Proposing changes nothing; applying goes through the bus or not at all.
 *
 * These are the two halves of the promise the workflow makes to an operator: you
 * will see what is going to happen before it happens, and when it happens it will
 * be one transaction against the revision you were shown.
 */

const BUDGET = { maxIterations: 300, wallClockMs: 10_000 }

const requestFor = (fixtureId: string) => {
  const fixture = refinementFixture(fixtureId)
  return {
    fixture,
    request: {
      version: 1 as const,
      id: `req_${fixtureId}`,
      scopePartIds: fixture.scopePartIds,
      protectedPartIds: fixture.protectedPartIds,
      boundaryPartIds: fixture.boundaryPartIds,
      symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
      baseRevision: fixture.document.revision,
      instruction: fixture.instruction,
      seed: 11,
      ...(fixture.silhouetteToleranceFraction === undefined
        ? {}
        : { silhouetteToleranceFraction: fixture.silhouetteToleranceFraction }),
    },
  }
}

describe('request compilation', () => {
  it('fills defaults and keeps what the caller stated', () => {
    const request = compileRequest({ version: 1, id: 'r', scopePartIds: ['a'], baseRevision: 4 })
    expect(request.protectedPartIds).toEqual([])
    expect(request.objectiveWeights).toEqual({})
    expect(request.referenceSilhouette).toBeNull()
    expect(request.budget.wallClockMs).toBeGreaterThan(0)
    expect(request.baseRevision).toBe(4)
    expect(request.maxProposals).toBeGreaterThan(0)
  })

  it('refuses a malformed request rather than guessing', () => {
    expect(() => compileRequest({ version: 1, id: '', scopePartIds: [], baseRevision: -1 } as never)).toThrow(
      RefinementRequestError,
    )
  })
})

describe('proposeRefinements mutates nothing', () => {
  it('leaves the document it was handed byte-identical', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-wall')
    const snapshot = stableStringify(fixture.document)
    const proposals = proposeRefinements(request, fixture.document, { budget: BUDGET })
    expect(proposals.length).toBeGreaterThan(0)
    expect(stableStringify(fixture.document)).toBe(snapshot)
  })

  it('leaves the engine at the revision it was found at', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-wall')
    const engine = new CadEngine(fixture.document)
    const revision = engine.getSnapshot().document.revision
    proposeRefinements(request, engine.getDocument(), { budget: BUDGET })
    expect(engine.getSnapshot().document.revision).toBe(revision)
    expect(engine.getSnapshot().transactions).toHaveLength(0)
  })

  it('stamps proposals with the revision of the document they were computed against', { timeout: 60_000 }, () => {
    const { fixture, request } = requestFor('seam-wall')
    for (const proposal of proposeRefinements(request, fixture.document, { budget: BUDGET })) {
      expect(proposal.baseRevision).toBe(fixture.document.revision)
      expect(proposal.requestId).toBe(request.id)
      expect(proposal.version).toBe(1)
    }
  })
})

describe('applyRefinement', () => {
  const rankedProposal = (fixtureId: string): { document: ReturnType<typeof refinementFixture>['document']; proposal: RefinementProposalV1 } => {
    const { fixture, request } = requestFor(fixtureId)
    const proposals = proposeRefinements(request, fixture.document, { budget: BUDGET })
    const proposal = proposals.find((entry) => entry.status === 'ranked')
    expect(proposal).toBeDefined()
    return { document: fixture.document, proposal: proposal! }
  }

  it('commits exactly one transaction through the bus', { timeout: 60_000 }, () => {
    const { document, proposal } = rankedProposal('seam-wall')
    const engine = new CadEngine(document)
    const before = engine.getSnapshot().document.revision

    const result = applyRefinement(proposal, 'human', busFor(engine))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.baseRevision).toBe(before)
    expect(result.value.resultRevision).toBe(before + 1)
    expect(result.value.sourceTool).toBe('refinement_apply')
    expect(engine.getSnapshot().transactions).toHaveLength(1)

    // The committed document holds exactly the parts the proposal promised.
    const after = engine.getSnapshot().document
    for (const partId of proposal.overlay.filter((entry) => entry.changeKind === 'removed')) {
      expect(after.parts[partId.partId]).toBeUndefined()
    }
    for (const partId of proposal.overlay.filter((entry) => entry.changeKind === 'added')) {
      expect(after.parts[partId.partId]).toBeDefined()
    }
  })

  it('undoes as one unit, because it committed as one', { timeout: 60_000 }, () => {
    const { document, proposal } = rankedProposal('seam-wall')
    const engine = new CadEngine(document)
    const before = stableStringify(engine.getSnapshot().document.parts)
    expect(applyRefinement(proposal, 'human', busFor(engine)).ok).toBe(true)
    expect(engine.undo('human').ok).toBe(true)
    expect(stableStringify(engine.getSnapshot().document.parts)).toBe(before)
  })

  it('refuses a rejected proposal without creating a transaction', { timeout: 60_000 }, () => {
    const fixture = refinementFixture('locked-cockpit')
    cadEngine.replaceDocument(fixture.document)
    const revision = cadEngine.getSnapshot().document.revision
    const transactions = cadEngine.getSnapshot().transactions.length

    const run = runRefinement(
      {
        version: 1,
        id: 'req_reject',
        scopePartIds: fixture.scopePartIds,
        baseRevision: fixture.document.revision,
        instruction: fixture.instruction,
        seed: 5,
      },
      cadEngine.getDocument(),
      { budget: BUDGET },
    )
    const rejected = run.proposals.find((proposal) => proposal.status === 'rejected')
    expect(rejected).toBeDefined()

    const result = applyRefinement(rejected!, 'human')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_OPERATION')
    expect(result.error.message).toContain(rejected!.id)
    expect(cadEngine.getSnapshot().document.revision).toBe(revision)
    expect(cadEngine.getSnapshot().transactions).toHaveLength(transactions)
  })

  it('fails with the kernel’s stale-document result rather than clobbering', { timeout: 60_000 }, () => {
    const { document, proposal } = rankedProposal('seam-wall')
    const engine = new CadEngine(document)
    const base = engine.getSnapshot().document.revision
    expect(proposal.baseRevision).toBe(base)

    // Somebody else edits the model between the proposal and the apply.
    const other = Object.keys(engine.getSnapshot().document.parts)[0]
    const interleaved = engine.execute('Recolour', [{ type: 'part.recolor', partId: other, color: 0 }], 'human', base)
    expect(interleaved.ok).toBe(true)
    const advanced = engine.getSnapshot().document.revision
    expect(advanced).toBe(base + 1)
    const partsBefore = stableStringify(engine.getSnapshot().document.parts)

    const result = applyRefinement(proposal, 'human', busFor(engine))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('STALE_DOCUMENT')
    expect(engine.getSnapshot().document.revision).toBe(advanced)
    expect(stableStringify(engine.getSnapshot().document.parts)).toBe(partsBefore)
    expect(engine.getSnapshot().transactions).toHaveLength(1)
  })

  it('refuses an empty proposal', { timeout: 60_000 }, () => {
    const { document, proposal } = rankedProposal('seam-wall')
    const engine = new CadEngine(document)
    const result = applyRefinement({ ...proposal, operations: [] }, 'human', busFor(engine))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/no operations/)
  })
})
