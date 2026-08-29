import { afterEach, describe, expect, it } from 'vitest'
import { defaultLayout, type WorkbenchLayout } from '../editor/workbench/layout'
import {
  applyChromeReveal,
  applyDockFocus,
  applyExclusiveDock,
  publishChrome,
  readChrome,
  resetChrome,
  revealChrome,
  setChromeRevealHandler,
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

  it('opens one right-dock section by closing the others', () => {
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
    expect(next.sections.selection).toBe(false)
    expect(next.sections.transform).toBe(false)
    expect(next.sections.inspector).toBe(false)
    expect(next.sections.palette).toBe(true)
  })

  it('collapses a restored stack down to one focused sheet', () => {
    const stacked: WorkbenchLayout = {
      ...defaultLayout(),
      sections: {
        ...defaultLayout().sections,
        selection: true,
        transform: true,
        inspector: true,
      },
    }
    const next = applyExclusiveDock(stacked)
    expect(next.sections.selection).toBe(true)
    expect(next.sections.transform).toBe(false)
    expect(next.sections.inspector).toBe(false)
  })

  it('uncollapses the timeline without inventing a section id', () => {
    const collapsed = { ...defaultLayout(), bottom: { size: 152, collapsed: true } }
    const next = applyChromeReveal(collapsed, 'timeline')
    expect(next.bottom.collapsed).toBe(false)
    expect(next.sections).toEqual(collapsed.sections)
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
})
