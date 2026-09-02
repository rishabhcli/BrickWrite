import { afterEach, describe, expect, it } from 'vitest'
import { defaultLayout, type WorkbenchLayout } from '../editor/workbench/layout'
import {
  applyChromeReveal,
  applyDockFocus,
  focusModelHealth,
  focusProposalReview,
  focusWorkspace,
  publishChrome,
  readChrome,
  resetChrome,
  revealChrome,
  setChromeRevealHandler,
  setModelHealthHandler,
  setProposalReviewHandler,
  setWorkspaceFocusHandler,
  withChromeReveal,
} from './chrome'

afterEach(resetChrome)

describe('chrome reveal', () => {
  it('opens the right dock and Generate section without touching the left dock', () => {
    const closed: WorkbenchLayout = {
      ...defaultLayout('desktop'),
      right: { size: 300, collapsed: true },
      sections: { ...defaultLayout().sections, 'generation.panel': false },
    }
    const next = applyChromeReveal(closed, 'generation')
    expect(next.right.collapsed).toBe(false)
    expect(next.left.collapsed).toBe(false)
    expect(next.sections['generation.panel']).toBe(true)
    expect(next.sections.selection).toBe(false)
    expect(next.sections['refinement.panel']).toBe(false)
  })

  it('opens one Design sheet by closing the other Design sheets, leaving Object companions', () => {
    const crowded: WorkbenchLayout = {
      ...defaultLayout(),
      sections: {
        ...defaultLayout().sections,
        selection: true,
        transform: true,
        inspector: true,
        'generation.panel': false,
      },
    }
    const next = applyDockFocus(crowded, 'generation.panel', true)
    expect(next.sections['generation.panel']).toBe(true)
    expect(next.sections['refinement.panel']).toBe(false)
    expect(next.sections.selection).toBe(true)
    expect(next.sections.transform).toBe(true)
    expect(next.sections.inspector).toBe(true)
    expect(next.sections.palette).toBe(true)
  })

  it('uncollapses the timeline without inventing a section id', () => {
    const collapsed = { ...defaultLayout(), bottom: { size: 152, collapsed: true } }
    const next = applyChromeReveal(collapsed, 'timeline')
    expect(next.bottom.collapsed).toBe(false)
    expect(next.sections).toEqual(collapsed.sections)
  })

  it('opens the shared feedback inbox in the bottom dock', () => {
    const collapsed = { ...defaultLayout(), bottom: { size: 152, collapsed: true } }
    const next = applyChromeReveal(collapsed, 'feedback')
    expect(next.bottom.collapsed).toBe(false)
    expect(next.sections).toEqual(collapsed.sections)
  })

  it('opens the shared model map as one focused right-dock sheet', () => {
    const closed: WorkbenchLayout = {
      ...defaultLayout(),
      right: { size: 300, collapsed: true },
      sections: { ...defaultLayout().sections, selection: true, 'model.explorer': false },
    }
    const next = applyChromeReveal(closed, 'model')
    expect(next.right.collapsed).toBe(false)
    expect(next.sections['model.explorer']).toBe(true)
    expect(next.sections.selection).toBe(true)
  })

  it('opens Model Health inside the focused inspector sheet', () => {
    const closed: WorkbenchLayout = {
      ...defaultLayout(),
      right: { size: 300, collapsed: true },
      sections: { ...defaultLayout().sections, selection: true, inspector: false },
    }
    const next = applyChromeReveal(closed, 'health')
    expect(next.right.collapsed).toBe(false)
    expect(next.sections.inspector).toBe(true)
    expect(next.sections.selection).toBe(true)
  })

  it('opens the measured proposal review queue in the bottom dock', () => {
    const collapsed = { ...defaultLayout(), bottom: { size: 152, collapsed: true } }
    const next = applyChromeReveal(collapsed, 'review')
    expect(next.bottom.collapsed).toBe(false)
    expect(next.sections).toEqual(collapsed.sections)
  })

  it('focuses an exact pending proposal in the mounted shared review surface', () => {
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))
    setProposalReviewHandler((proposalId) => ({
      activeProposalId: proposalId ?? null,
      found: proposalId === 'proposal_2',
      pending: 2,
    }))

    const receipt = focusProposalReview('proposal_2')

    expect(seen).toEqual(['review'])
    expect(receipt).toMatchObject({
      applied: true,
      activeProposalId: 'proposal_2',
      found: true,
      pending: 2,
      revealed: { surface: 'review', dock: 'bottom', section: null },
    })
  })

  it('focuses an exact deterministic issue in the mounted health navigator', () => {
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))
    setModelHealthHandler((issueId) => ({
      activeIssueId: issueId ?? null,
      found: issueId === 'collision:pair_a_b',
      revision: 7,
      blockers: 1,
      warnings: 2,
      selectedPartIds: ['part_a', 'part_b'],
      truncated: false,
    }))

    const receipt = focusModelHealth('collision:pair_a_b')

    expect(seen).toEqual(['health'])
    expect(receipt).toMatchObject({
      applied: true,
      activeIssueId: 'collision:pair_a_b',
      found: true,
      revision: 7,
      selectedPartIds: ['part_a', 'part_b'],
      revealed: { surface: 'health', dock: 'right', section: 'inspector' },
    })
  })

  it('hands exact focus scope to the mounted model map without touching the document contract', () => {
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))
    setWorkspaceFocusHandler((request) => ({
      requestedCount: request.partIds?.length ?? 0,
      matchedCount: 1,
      selectedPartIds: ['part_ok'],
      missingPartIds: ['part_missing'],
      subassemblyFound: null,
      truncated: false,
    }))

    const receipt = focusWorkspace({ partIds: ['part_ok', 'part_missing'], mode: 'frame' })

    expect(seen).toEqual(['model'])
    expect(receipt).toMatchObject({
      applied: true,
      mode: 'frame',
      requestedCount: 2,
      matchedCount: 1,
      selectedPartIds: ['part_ok'],
      missingPartIds: ['part_missing'],
      revealed: { surface: 'model', dock: 'right', section: 'model.explorer' },
    })
  })

  it('reports applied:false when the workbench is not mounted', () => {
    expect(revealChrome('generation')).toEqual({
      surface: 'generation',
      applied: false,
      dock: 'right',
      section: 'generation.panel',
    })
  })

  it('runs the workbench handler and returns a compact receipt', () => {
    const seen: string[] = []
    setChromeRevealHandler((surface) => {
      seen.push(surface)
      publishChrome({
        docks: {
          left: { collapsed: false, size: 268 },
          right: { collapsed: false, size: 300 },
          bottom: { collapsed: false, size: 152 },
        },
        sections: { 'generation.panel': true },
        tool: 'select',
        cameraView: 'isometric',
        activeColor: 15,
      })
    })
    const receipt = withChromeReveal('generation', { candidateCount: 1 })
    expect(seen).toEqual(['generation'])
    expect(receipt.revealed.applied).toBe(true)
    expect(receipt.candidateCount).toBe(1)
    expect(readChrome()?.sections['generation.panel']).toBe(true)
  })

  it('keeps Connect open beside inspector instead of exclusive-closing the mate', () => {
    const crowded: WorkbenchLayout = {
      ...defaultLayout(),
      sections: { ...defaultLayout().sections, connect: true, inspector: false, transform: true },
    }
    const next = applyDockFocus(crowded, 'inspector', true)
    expect(next.sections.inspector).toBe(true)
    expect(next.sections.connect).toBe(true)
    expect(next.sections.transform).toBe(true)
  })

  it('opens inspector beside transform instead of exclusive-closing Object sheets', () => {
    const crowded: WorkbenchLayout = {
      ...defaultLayout(),
      sections: { ...defaultLayout().sections, transform: true, inspector: false, selection: true, 'model.explorer': true },
    }
    const next = applyDockFocus(crowded, 'inspector', true)
    expect(next.sections.inspector).toBe(true)
    expect(next.sections.transform).toBe(true)
    expect(next.sections.selection).toBe(true)
    expect(next.sections['model.explorer']).toBe(true)
  })

  it('targets the Connect sheet as a real chrome surface', () => {
    const closed: WorkbenchLayout = {
      ...defaultLayout(),
      right: { size: 300, collapsed: true },
      sections: { ...defaultLayout().sections, connect: false, inspector: true },
    }
    const next = applyChromeReveal(closed, 'connect')
    expect(next.right.collapsed).toBe(false)
    expect(next.sections.connect).toBe(true)
    expect(next.sections.inspector).toBe(true)
  })
})
