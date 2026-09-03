import { beforeEach, describe, expect, it } from 'vitest'
import { resetPreferences } from './persistence'
import {
  bottomHeight,
  clampLayout,
  COLLAPSED_BAR,
  COLLAPSED_RAIL,
  defaultLayout,
  DEFAULT_SECTIONS,
  DOCK_LIMITS,
  CHROME_HEIGHT,
  loadLayout,
  MIN_VIEWPORT_WIDTH,
  saveLayout,
  STATUSBAR_HEIGHT,
  TOOLRAIL_HEIGHT,
  TOPBAR_HEIGHT,
  workspaceColumns,
  workspaceRows,
} from './layout'

/**
 * The layout model exists to protect the viewport. These tests pin that: no
 * arrangement of docks or restored preferences may leave the 3D view unusably
 * narrow, and a saved layout has to survive a reload intact.
 */

beforeEach(resetPreferences)

describe('clamping', () => {
  it('never lets the docks squeeze the viewport below its minimum', () => {
    const greedy = {
      left: { size: DOCK_LIMITS.left.max, collapsed: false },
      right: { size: DOCK_LIMITS.right.max, collapsed: false },
      bottom: { size: 200, collapsed: false },
      sections: {},
      rightTab: 'design' as const,
    }
    const fitted = clampLayout(greedy, { width: 1024, height: 800 })
    const used =
      (fitted.left.collapsed ? COLLAPSED_RAIL : fitted.left.size) +
      (fitted.right.collapsed ? COLLAPSED_RAIL : fitted.right.size)
    expect(1024 - used).toBeGreaterThanOrEqual(MIN_VIEWPORT_WIDTH)
  })

  it('pulls an over-wide dock back inside its limit', () => {
    const fitted = clampLayout(
      { ...defaultLayout(), left: { size: 5000, collapsed: false } },
      { width: 2560, height: 1400 },
    )
    expect(fitted.left.size).toBe(DOCK_LIMITS.left.max)
  })

  it('collapses the timeline rather than crushing the viewport vertically', () => {
    const fitted = clampLayout(defaultLayout(), { width: 1600, height: 460 })
    expect(fitted.bottom.collapsed).toBe(true)
  })

  it('leaves a comfortable layout untouched', () => {
    const roomy = defaultLayout()
    const fitted = clampLayout(roomy, { width: 1920, height: 1080 })
    expect(fitted.left.size).toBe(roomy.left.size)
    expect(fitted.right.size).toBe(roomy.right.size)
    expect(fitted.bottom.size).toBe(roomy.bottom.size)
  })
})

describe('persistence', () => {
  it('round-trips a dragged layout', () => {
    saveLayout({ ...defaultLayout(), left: { size: 331, collapsed: false }, rightTab: 'object' })
    expect(loadLayout().left.size).toBe(331)
    expect(loadLayout().rightTab).toBe('object')
  })

  it('survives a stored value written by an older build rather than failing to boot', () => {
    // Version drift is the realistic corruption: the key parses, but it no
    // longer describes a layout this build understands.
    saveLayout({ preset: 'desktop' } as unknown as ReturnType<typeof defaultLayout>)
    expect(loadLayout().left.size).toBe(defaultLayout().left.size)
    expect(loadLayout().rightTab).toBe('design')
  })

  it('drops a stored size that is out of range', () => {
    saveLayout({ ...defaultLayout(), right: { size: 9000, collapsed: false } })
    expect(loadLayout().right.size).toBe(DOCK_LIMITS.right.max)
  })

  it('normalizes missing or invalid right tabs to Design', () => {
    const older = { ...defaultLayout() } as Partial<ReturnType<typeof defaultLayout>>
    Reflect.deleteProperty(older, 'rightTab')
    saveLayout(older as ReturnType<typeof defaultLayout>)
    expect(loadLayout().rightTab).toBe('design')

    saveLayout({ ...defaultLayout(), rightTab: 'layers' } as unknown as ReturnType<typeof defaultLayout>)
    expect(loadLayout().rightTab).toBe('design')
  })

  it('merges defaults without erasing stored section preferences', () => {
    saveLayout({
      ...defaultLayout(),
      sections: { 'generation.panel': false, selection: true },
    })
    const restored = loadLayout()
    expect(restored.sections['generation.panel']).toBe(false)
    expect(restored.sections.selection).toBe(true)
    expect(restored.sections['agent.workbench']).toBe(true)
  })
})

describe('grid templates', () => {
  it('reserves splitter tracks between every dock and the viewport', () => {
    expect(workspaceColumns(defaultLayout())).toBe('268px 4px minmax(0, 1fr) 4px 316px')
  })

  it('leaves a reopen rail when a dock is collapsed', () => {
    const collapsed = { ...defaultLayout(), left: { size: 268, collapsed: true } }
    expect(workspaceColumns(collapsed).startsWith(`${COLLAPSED_RAIL}px`)).toBe(true)
  })

  it('shrinks the bottom dock to a bar when collapsed', () => {
    expect(COLLAPSED_BAR).toBe(0)
    expect(bottomHeight({ ...defaultLayout(), bottom: { size: 152, collapsed: true } })).toBe(0)
  })

  it('lets the inline timeline row follow bottomHeight instead of a locked 0', () => {
    const open = defaultLayout()
    expect(workspaceRows({ ...open, bottom: { size: 152, collapsed: true } })).toBe('52px 0px minmax(0, 1fr) 0px')
    expect(workspaceRows({ ...open, bottom: { size: 152, collapsed: false } })).toBe('52px 0px minmax(0, 1fr) 152px')
  })
})

describe('chrome', () => {
  it('matches the quieter shell strip heights', () => {
    // Status and tool-rail heights stay zero: those surfaces overlay the
    // viewport instead of occupying grid rows. Pinning this stops a drive-by
    // remount from shrinking the model without a product decision.
    expect(TOPBAR_HEIGHT).toBe(52)
    expect(TOOLRAIL_HEIGHT).toBe(0)
    expect(STATUSBAR_HEIGHT).toBe(0)
    expect(CHROME_HEIGHT).toBe(52)
  })

  it('opens into a build-first workspace', () => {
    expect(defaultLayout().right.collapsed).toBe(false)
    expect(defaultLayout().bottom.collapsed).toBe(true)
    expect(defaultLayout().rightTab).toBe('design')
    expect(DEFAULT_SECTIONS['generation.panel']).toBe(true)
    expect(DEFAULT_SECTIONS['refinement.panel']).toBe(true)
    expect(DEFAULT_SECTIONS['agent.workbench']).toBe(true)
    // Selection answers the click; Position waits to be reached for, and the
    // frames, pivots and locks that made it a cockpit wait behind Precision.
    expect(DEFAULT_SECTIONS.selection).toBe(true)
    expect(DEFAULT_SECTIONS.transform).toBe(false)
    expect(DEFAULT_SECTIONS['transform.precision']).toBe(false)
    expect(DEFAULT_SECTIONS.health).toBe(false)
    expect(DEFAULT_SECTIONS.connect).toBe(false)
    expect(defaultLayout().sections['generation.panel']).toBe(true)
  })
})
