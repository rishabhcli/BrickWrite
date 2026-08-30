import { beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../../cad/engine'
import { createShowcaseDocument } from '../../cad/sample'
import type { CollisionIssue, Proposal } from '../../cad/types'
import { summariseProposal } from './proposalReview'

beforeEach(() => cadEngine.replaceDocument(createShowcaseDocument()))

function recolorProposal(): Proposal {
  const snapshot = cadEngine.getSnapshot()
  const part = Object.values(snapshot.document.parts)[0]
  const result = cadEngine.preflight(
    'Review a finish adjustment',
    [{ type: 'part.recolor', partId: part.id, color: part.color }],
    'agent',
    snapshot.document.revision,
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('proposal review summary', () => {
  it('turns a real kernel preflight into a measured review contract', () => {
    const proposal = recolorProposal()
    const summary = summariseProposal(proposal, cadEngine.getSnapshot())

    expect(summary).toMatchObject({
      ready: true,
      stale: false,
      partDelta: 0,
      collisionDelta: 0,
      groups: [{ id: 'appearance', label: 'Appearance and access', count: 1 }],
    })
    expect(summary.selectablePartIds).toEqual([proposal.operations[0].type === 'part.recolor' ? proposal.operations[0].partId : ''])
    expect(summary.blockers).toEqual([])
  })

  it('faces collision evidence instead of presenting a blocked ghost as safe', () => {
    const proposal = recolorProposal()
    const partIds = Object.keys(proposal.previewDocument.parts)
    const collision: CollisionIssue = {
      id: 'collision_review',
      partA: partIds[0],
      partB: partIds[1],
      overlapLdu: [4, 2, 3],
      message: 'Test collision',
      certainty: 'exact',
    }
    proposal.validation = { ...proposal.validation, collisions: [collision], healthy: false }

    const summary = summariseProposal(proposal, cadEngine.getSnapshot())

    expect(summary.ready).toBe(false)
    expect(summary.blockers).toContain('1 collision in the preview.')
    expect(summary.collisionDelta).toBe(1)
  })

  it('marks a preflight stale when the shared revision has moved', () => {
    const proposal = recolorProposal()
    proposal.baseRevision -= 1

    const summary = summariseProposal(proposal, cadEngine.getSnapshot())

    expect(summary.stale).toBe(true)
    expect(summary.ready).toBe(false)
    expect(summary.blockers[0]).toMatch(/Based on r0; the document is now r1/)
  })
})
