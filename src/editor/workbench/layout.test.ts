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
  LAYOUT_PRESETS,
  CHROME_HEIGHT,
  loadLayout,
  MIN_VIEWPORT_WIDTH,
  recommendedPreset,
  saveLayout,
  STATUSBAR_HEIGHT,
  TOOLRAIL_HEIGHT,
  TOPBAR_HEIGHT,
  workspaceColumns,
  workspaceRows,
} from './layout'

/**
 * The layout model exists to protect the viewport. These tests pin that: no
 * arrangement of docks, presets or restored preferences may leave the 3D view
 * unusably narrow, and a saved layout has to survive a reload intact.
 */

beforeEach(resetPreferences)

describe('presets', () => {
  it('offers a preset for laptop, desktop and ultrawide', () => {
    expect(Object.keys(LAYOUT_PRESETS)).toEqual(['laptop', 'desktop', 'ultrawide'])
  })

  it('keeps every preset inside its own dock limits', () => {
    for (const preset of Object.values(LAYOUT_PRESETS)) {
      for (const dock of ['left', 'right', 'bottom'] as const) {
        expect(preset.layout[dock].size).toBeGreaterThanOrEqual(DOCK_LIMITS[dock].min)
        expect(preset.layout[dock].size).toBeLessThanOrEqual(DOCK_LIMITS[dock].max)
      }
    }
  })

  it('recommends a preset from the screen it is opening on', () => {
    expect(recommendedPreset(1280)).toBe('laptop')
    expect(recommendedPreset(1600)).toBe('desktop')
    expect(recommendedPreset(2560)).toBe('ultrawide')
  })

  it('fits every preset on its own target width', () => {
    const widths: Record<string, number> = { laptop: 1280, desktop: 1600, ultrawide: 2560 }
    for (const [id, preset] of Object.entries(LAYOUT_PRESETS)) {
      const fitted = clampLayout({ ...preset.layout, sections: {} }, { width: widths[id], height: 800 })
      const used = fitted.left.size + fitted.right.size
      expect(widths[id] - used).toBeGreaterThanOrEqual(MIN_VIEWPORT_WIDTH)
    }
  })
})

describe('clamping', () => {
  it('never lets the docks squeeze the viewport below its minimum', () => {
    const greedy = {
      left: { size: DOCK_LIMITS.left.max, collapsed: false },
      right: { size: DOCK_LIMITS.right.max, collapsed: false },
      bottom: { size: 200, collapsed: false },
      preset: null,
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
    const fitted = clampLayout(defaultLayout('desktop'), { width: 1600, height: 460 })
    expect(fitted.bottom.collapsed).toBe(true)
  })

  it('leaves a comfortable layout untouched', () => {
    const desktop = defaultLayout('desktop')
    const fitted = clampLayout(desktop, { width: 1920, height: 1080 })
    expect(fitted.left.size).toBe(desktop.left.size)
    expect(fitted.right.size).toBe(desktop.right.size)
    expect(fitted.bottom.size).toBe(desktop.bottom.size)
  })
})

describe('persistence', () => {
  it('round-trips a dragged layout', () => {
    const dragged = {
      ...defaultLayout('desktop'),
      left: { size: 331, collapsed: false },
      preset: null,
      rightTab: 'object' as const,
    }
    saveLayout(dragged)
    expect(loadLayout(1600).left.size).toBe(331)
    expect(loadLayout(1600).preset).toBeNull()
    expect(loadLayout(1600).rightTab).toBe('object')
  })

  it('falls back to a recommended preset when nothing is stored', () => {
    expect(loadLayout(2560).preset).toBe('ultrawide')
  })

  it('survives a stored value written by an older build rather than failing to boot', () => {
    // Version drift is the realistic corruption: the key parses, but it no
    // longer describes a layout this build understands.
    saveLayout({ preset: 'desktop' } as unknown as ReturnType<typeof defaultLayout>)
    expect(loadLayout(1600).preset).toBe('desktop')
    expect(loadLayout(1600).left.size).toBe(LAYOUT_PRESETS.desktop.layout.left.size)
  })

  it('drops a stored size that is out of range', () => {
    saveLayout({ ...defaultLayout(), right: { size: 9000, collapsed: false } })
    expect(loadLayout(1600).right.size).toBe(DOCK_LIMITS.right.max)
  })

  it('normalizes missing or invalid right tabs to Design', () => {
    const older = { ...defaultLayout() } as Partial<ReturnType<typeof defaultLayout>>
    Reflect.deleteProperty(older, 'rightTab')
    saveLayout(older as ReturnType<typeof defaultLayout>)
    expect(loadLayout(1600).rightTab).toBe('design')

    saveLayout({ ...defaultLayout(), rightTab: 'layers' } as unknown as ReturnType<typeof defaultLayout>)
    expect(loadLayout(1600).rightTab).toBe('design')
  })

  it('merges defaults without erasing stored section preferences', () => {
    saveLayout({
      ...defaultLayout(),
      sections: { 'generation.panel': false, selection: true },
    })
    const restored = loadLayout(1600)
    expect(restored.sections['generation.panel']).toBe(false)
    expect(restored.sections.selection).toBe(true)
    expect(restored.sections['agent.workbench']).toBe(true)
  })
})

describe('grid templates', () => {
  it('reserves splitter tracks between every dock and the viewport', () => {
    expect(workspaceColumns(defaultLayout('desktop'))).toBe('268px 4px minmax(0, 1fr) 4px 316px')
  })

  it('leaves a reopen rail when a dock is collapsed', () => {
    const collapsed = { ...defaultLayout('desktop'), left: { size: 268, collapsed: true } }
    expect(workspaceColumns(collapsed).startsWith(`${COLLAPSED_RAIL}px`)).toBe(true)
  })

  it('shrinks the bottom dock to a bar when collapsed', () => {
    expect(COLLAPSED_BAR).toBe(0)
    expect(bottomHeight({ ...defaultLayout(), bottom: { size: 152, collapsed: true } })).toBe(0)
  })

  it('lets the inline timeline row follow bottomHeight instead of a locked 0', () => {
    const open = defaultLayout('desktop')
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
    expect(DEFAULT_SECTIONS.transform).toBe(false)
    expect(DEFAULT_SECTIONS.inspector).toBe(false)
    expect(DEFAULT_SECTIONS.selection).toBe(false)
    expect(DEFAULT_SECTIONS['model.explorer']).toBe(false)
    expect(DEFAULT_SECTIONS.connect).toBe(false)
    expect(defaultLayout().sections['generation.panel']).toBe(true)
  })

  it('keeps the creative dock visible and Design ready in every preset', () => {
    for (const preset of Object.values(LAYOUT_PRESETS)) {
      expect(preset.layout.right.collapsed).toBe(false)
      expect(preset.layout.bottom.collapsed).toBe(true)
      expect(preset.layout.rightTab).toBe('design')
    }
  })
})
