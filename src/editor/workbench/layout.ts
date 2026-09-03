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

export type RightDockTab = 'design' | 'object'

export interface WorkbenchLayout {
  readonly left: DockGeometry
  readonly right: DockGeometry
  readonly bottom: DockGeometry
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
 * The starting geometry.
 *
 * One arrangement rather than a menu of them. The screen-shape presets this
 * replaced asked the operator to classify their own monitor before they had
 * seen the editor, and then persisted whichever answer they guessed; the docks
 * are draggable and `clampLayout` already fits them to any real window, which
 * is the same job done without the question.
 */
const STARTING_LAYOUT: Omit<WorkbenchLayout, 'sections'> = {
  left: { size: 268, collapsed: false },
  right: { size: 316, collapsed: false },
  bottom: { size: 152, collapsed: true },
  rightTab: 'design',
}

export const DEFAULT_SECTIONS: Record<string, boolean> = {
  palette: true,
  colors: true,
  'model.explorer': false,
  selection: true,
  transform: false,
  // Reference frames, axis locks, pivots and align rows unfurling because a
  // brick was clicked is how a viewport becomes a cockpit. They are still one
  // click away, and every one of them is in the command palette by name.
  'transform.precision': false,
  health: false,
  connect: false,
  // Design is the first-run workspace. These remain independently
  // collapsible: Generate, Refine and Agent form one intentional stack rather
  // than competing with the contextual Object sheets.
  'generation.panel': true,
  'refinement.panel': true,
  'agent.workbench': true,
}

export const defaultLayout = (): WorkbenchLayout => ({
  ...STARTING_LAYOUT,
  sections: { ...DEFAULT_SECTIONS },
})

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
    // has a home elsewhere — every Object block is reachable from the command
    // palette.
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
/**
 * Height of a collapsed bottom dock. Zero on purpose: there is no reopen
 * strip. Reopen the timeline from the toolbar island ("Build timeline").
 */
export const COLLAPSED_BAR = 0
/** Must match `.app-shell` in `workbench.css` and the Workbench inline grid. */
export const TOPBAR_HEIGHT = 52
/** The tools float inside the viewport now; no permanent grid strip is reserved. */
export const TOOLRAIL_HEIGHT = 0
/**
 * Zero on purpose. The tools float as a viewport island, and remounting a
 * dedicated status strip would steal model pixels the quieter shell already
 * gave back. Mode and Esc live on that island.
 */
export const STATUSBAR_HEIGHT = 0
/** Top bar + tool rail + status bar, which the docks never overlap. */
export const CHROME_HEIGHT = TOPBAR_HEIGHT + TOOLRAIL_HEIGHT + STATUSBAR_HEIGHT

// v6 splits the Position sheet: exact pose and steppers stay open, the frame,
// pivot, axis locks, array, mirror and align rows move to a Precision sheet
// that starts closed. v5 drops the screen-shape presets and folds the five
// Object sheets into one contextual panel. Earlier geometry stays isolated so
// nobody inherits a dock arrangement built for controls that no longer exist.
const STORAGE_KEY = 'layout.v6'

export function loadLayout(): WorkbenchLayout {
  const stored = readPreference<WorkbenchLayout | null>(STORAGE_KEY, null)
  if (!stored || typeof stored !== 'object' || !stored.left || !stored.right || !stored.bottom) {
    return defaultLayout()
  }
  return {
    left: { size: clampSize('left', Number(stored.left.size) || 268), collapsed: Boolean(stored.left.collapsed) },
    right: { size: clampSize('right', Number(stored.right.size) || 316), collapsed: Boolean(stored.right.collapsed) },
    bottom: {
      size: clampSize('bottom', Number(stored.bottom.size) || 152),
      collapsed: Boolean(stored.bottom.collapsed),
    },
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

/** Four tracks: topbar, unused toolrail, viewport, timeline. Inline style must win over CSS — never lock the last track to 0 with !important. */
export function workspaceRows(layout: WorkbenchLayout): string {
  return `${TOPBAR_HEIGHT}px ${TOOLRAIL_HEIGHT}px minmax(0, 1fr) ${bottomHeight(layout)}px`
}
