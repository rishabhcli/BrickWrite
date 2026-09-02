import { readPreference, writePreference } from './persistence'

/**
 * Dock geometry for the workbench.
 *
 * The viewport is the subject of this application, so the layout model is built
 * around protecting it: docks have hard minimum and maximum widths, and any
 * arrangement that would squeeze the 3D view below a usable size is clamped
 * rather than allowed. That is what makes "drag the splitter as far as you
 * like" safe to offer at all.
 */

export type DockId = 'left' | 'right' | 'bottom'

export interface DockGeometry {
  /** Width for the side docks, height for the bottom one, in CSS pixels. */
  readonly size: number
  readonly collapsed: boolean
}

export type LayoutPresetId = 'laptop' | 'desktop' | 'ultrawide'
export type RightDockTab = 'design' | 'object'

export interface WorkbenchLayout {
  readonly left: DockGeometry
  readonly right: DockGeometry
  readonly bottom: DockGeometry
  /** The preset this layout came from, or null once it has been dragged. */
  readonly preset: LayoutPresetId | null
  /** Open/closed state of the collapsible sections inside the docks. */
  readonly sections: Readonly<Record<string, boolean>>
  /** The durable top-level view shown in the right dock. */
  readonly rightTab: RightDockTab
}

export const DOCK_LIMITS: Record<DockId, { min: number; max: number }> = {
  left: { min: 208, max: 460 },
  right: { min: 240, max: 520 },
  bottom: { min: 108, max: 360 },
}

/** The viewport never goes below this, whatever the docks are asked for. */
export const MIN_VIEWPORT_WIDTH = 420
export const MIN_VIEWPORT_HEIGHT = 280

/**
 * Presets, sized from the shapes people actually work on.
 *
 * Laptop protects the viewport by shrinking both docks and shortening the
 * timeline; ultrawide spends the extra pixels on the palette and inspector
 * rather than on an ever-wider viewport nobody asked for.
 */
export const LAYOUT_PRESETS: Record<
  LayoutPresetId,
  { label: string; hint: string; layout: Omit<WorkbenchLayout, 'sections'> }
> = {
  laptop: {
    label: 'Laptop',
    hint: '13–14 inch. Narrow docks, short timeline, viewport first.',
    layout: {
      left: { size: 224, collapsed: false },
      right: { size: 276, collapsed: false },
      bottom: { size: 124, collapsed: true },
      preset: 'laptop',
      rightTab: 'design',
    },
  },
  desktop: {
    label: 'Desktop',
    hint: '1600–1920 wide. The default balance.',
    layout: {
      left: { size: 268, collapsed: false },
      right: { size: 316, collapsed: false },
      bottom: { size: 152, collapsed: true },
      preset: 'desktop',
      rightTab: 'design',
    },
  },
  ultrawide: {
    label: 'Ultrawide',
    hint: '2560 and wider. Both docks open at full width.',
    layout: {
      left: { size: 340, collapsed: false },
      right: { size: 392, collapsed: false },
      bottom: { size: 168, collapsed: true },
      preset: 'ultrawide',
      rightTab: 'design',
    },
  },
}

export const DEFAULT_SECTIONS: Record<string, boolean> = {
  palette: true,
  colors: true,
  'model.explorer': false,
  selection: false,
  transform: false,
  inspector: false,
  validate: false,
  connect: false,
  // Design is the first-run workspace. These remain independently
  // collapsible: Generate, Refine and Agent form one intentional stack rather
  // than competing with the contextual Object sheets.
  'generation.panel': true,
  'refinement.panel': true,
  'agent.workbench': true,
}

export const defaultLayout = (preset: LayoutPresetId = 'desktop'): WorkbenchLayout => ({
  ...LAYOUT_PRESETS[preset].layout,
  sections: { ...DEFAULT_SECTIONS },
})

/** The preset that suits a viewport width, used for the first-run layout only. */
export function recommendedPreset(width: number): LayoutPresetId {
  if (width >= 2200) return 'ultrawide'
  if (width <= 1450) return 'laptop'
  return 'desktop'
}

const clampSize = (dock: DockId, size: number) =>
  Math.round(Math.min(DOCK_LIMITS[dock].max, Math.max(DOCK_LIMITS[dock].min, size)))

/**
 * Fits a layout inside a real window.
 *
 * Both side docks are reduced proportionally when they would leave the viewport
 * too narrow, and collapsed first if even their minimums do not fit. A window
 * narrow enough to need that is rare, but returning an impossible layout and
 * letting the grid overflow is not an acceptable alternative.
 */
export function clampLayout(layout: WorkbenchLayout, viewport: { width: number; height: number }): WorkbenchLayout {
  const left = { ...layout.left, size: clampSize('left', layout.left.size) }
  const right = { ...layout.right, size: clampSize('right', layout.right.size) }
  const bottom = { ...layout.bottom, size: clampSize('bottom', layout.bottom.size) }

  const leftWidth = left.collapsed ? COLLAPSED_RAIL : left.size
  const rightWidth = right.collapsed ? COLLAPSED_RAIL : right.size
  const spare = viewport.width - MIN_VIEWPORT_WIDTH - leftWidth - rightWidth

  let fitted = { left, right, bottom }
  if (spare < 0) {
    const flexible =
      (left.collapsed ? 0 : left.size - DOCK_LIMITS.left.min) +
      (right.collapsed ? 0 : right.size - DOCK_LIMITS.right.min)
    if (flexible > 0) {
      const ratio = Math.max(0, 1 + spare / flexible)
      fitted = {
        left: left.collapsed
          ? left
          : { ...left, size: Math.round(DOCK_LIMITS.left.min + (left.size - DOCK_LIMITS.left.min) * ratio) },
        right: right.collapsed
          ? right
          : { ...right, size: Math.round(DOCK_LIMITS.right.min + (right.size - DOCK_LIMITS.right.min) * ratio) },
        bottom,
      }
    }
    // Still impossible: collapse the right dock, which is the one whose content
    // has a home elsewhere — the inspector's sections are all reachable from
    // the command palette.
    const stillShort =
      viewport.width -
      MIN_VIEWPORT_WIDTH -
      (fitted.left.collapsed ? COLLAPSED_RAIL : fitted.left.size) -
      (fitted.right.collapsed ? COLLAPSED_RAIL : fitted.right.size)
    if (stillShort < 0) fitted = { ...fitted, right: { ...fitted.right, collapsed: true } }
  }

  const verticalSpare = viewport.height - CHROME_HEIGHT - MIN_VIEWPORT_HEIGHT
  if (!fitted.bottom.collapsed && fitted.bottom.size > verticalSpare) {
    fitted = {
      ...fitted,
      bottom:
        verticalSpare < DOCK_LIMITS.bottom.min
          ? { ...fitted.bottom, collapsed: true }
          : { ...fitted.bottom, size: Math.round(verticalSpare) },
    }
  }

  return { ...layout, ...fitted }
}

/** Width of a collapsed side dock: the reopen rail stays clickable. */
export const COLLAPSED_RAIL = 34
/** Height of a collapsed bottom dock. */
export const COLLAPSED_BAR = 0
/** Must match `.app-shell` in `workbench.css` and the Workbench inline grid. */
export const TOPBAR_HEIGHT = 52
/** The tools float inside the viewport now; no permanent grid strip is reserved. */
export const TOOLRAIL_HEIGHT = 0
/**
 * Zero on purpose. The tools float as a viewport island, and remounting a
 * dedicated status strip would steal model pixels the quieter shell already
 * gave back. Mode, Esc and layout-preset live on that island and the top bar.
 * StatusBar.tsx is the full readout if a density option ever wants it back.
 */
export const STATUSBAR_HEIGHT = 0
/** Top bar + tool rail + status bar, which the docks never overlap. */
export const CHROME_HEIGHT = TOPBAR_HEIGHT + TOOLRAIL_HEIGHT + STATUSBAR_HEIGHT

// v4 puts the creative surface back on screen and promotes the core tools out
// of the old Workspace menu. Earlier geometry stays isolated so every operator
// receives the discoverable layout rather than a persisted collapsed rail.
const STORAGE_KEY = 'layout.v4'

export function loadLayout(viewportWidth: number): WorkbenchLayout {
  const stored = readPreference<WorkbenchLayout | null>(STORAGE_KEY, null)
  if (!stored || typeof stored !== 'object' || !stored.left || !stored.right || !stored.bottom) {
    return defaultLayout(recommendedPreset(viewportWidth))
  }
  return {
    left: { size: clampSize('left', Number(stored.left.size) || 268), collapsed: Boolean(stored.left.collapsed) },
    right: { size: clampSize('right', Number(stored.right.size) || 300), collapsed: Boolean(stored.right.collapsed) },
    bottom: {
      size: clampSize('bottom', Number(stored.bottom.size) || 152),
      collapsed: Boolean(stored.bottom.collapsed),
    },
    preset: stored.preset ?? null,
    sections: { ...DEFAULT_SECTIONS, ...(stored.sections ?? {}) },
    rightTab: stored.rightTab === 'object' ? 'object' : 'design',
  }
}

export function saveLayout(layout: WorkbenchLayout): void {
  writePreference(STORAGE_KEY, layout)
}

/** CSS grid template for the workspace row, given a fitted layout. */
export function workspaceColumns(layout: WorkbenchLayout): string {
  const left = layout.left.collapsed ? COLLAPSED_RAIL : layout.left.size
  const right = layout.right.collapsed ? COLLAPSED_RAIL : layout.right.size
  return `${left}px 4px minmax(0, 1fr) 4px ${right}px`
}

export const bottomHeight = (layout: WorkbenchLayout): number =>
  layout.bottom.collapsed ? COLLAPSED_BAR : layout.bottom.size
