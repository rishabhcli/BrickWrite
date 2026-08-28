import { beforeEach, describe, expect, it } from 'vitest'
import { resetPreferences } from './persistence'
import {
  bottomHeight,
  clampLayout,
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
    }
    const fitted = clampLayout(greedy, { width: 1024, height: 800 })
    const used = (fitted.left.collapsed ? COLLAPSED_RAIL : fitted.left.size)
      + (fitted.right.collapsed ? COLLAPSED_RAIL : fitted.right.size)
    expect(1024 - used).toBeGreaterThanOrEqual(MIN_VIEWPORT_WIDTH)
  })

  it('pulls an over-wide dock back inside its limit', () => {
    const fitted = clampLayout({ ...defaultLayout(), left: { size: 5000, collapsed: false } }, { width: 2560, height: 1400 })
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
    const dragged = { ...defaultLayout('desktop'), left: { size: 331, collapsed: false }, preset: null }
    saveLayout(dragged)
    expect(loadLayout(1600).left.size).toBe(331)
    expect(loadLayout(1600).preset).toBeNull()
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
})

describe('grid templates', () => {
  it('reserves splitter tracks between every dock and the viewport', () => {
    expect(workspaceColumns(defaultLayout('desktop'))).toBe('268px 4px minmax(0, 1fr) 4px 300px')
  })

  it('leaves a reopen rail when a dock is collapsed', () => {
    const collapsed = { ...defaultLayout('desktop'), left: { size: 268, collapsed: true } }
    expect(workspaceColumns(collapsed).startsWith(`${COLLAPSED_RAIL}px`)).toBe(true)
  })

  it('shrinks the bottom dock to a bar when collapsed', () => {
    expect(bottomHeight({ ...defaultLayout(), bottom: { size: 152, collapsed: true } })).toBeLessThan(40)
  })
})

describe('chrome', () => {
  it('matches the quieter shell strip heights', () => {
    expect(TOPBAR_HEIGHT).toBe(52)
    expect(TOOLRAIL_HEIGHT).toBe(44)
    expect(STATUSBAR_HEIGHT).toBe(24)
    expect(CHROME_HEIGHT).toBe(120)
  })

  it('keeps Generate, Refine and the design partner collapsed in a 300px dock', () => {
    expect(DEFAULT_SECTIONS['generation.panel']).toBe(false)
    expect(DEFAULT_SECTIONS['refinement.panel']).toBe(false)
    expect(DEFAULT_SECTIONS['agent.workbench']).toBe(false)
    expect(defaultLayout().sections['generation.panel']).toBe(false)
  })
})
