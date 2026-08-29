/**
 * Compact workbench chrome for WebMCP.
 *
 * The quieter dock stacks Generate, Refine and the design partner behind
 * collapsed sections. An agent that cannot see which docks are open, or open
 * the right one, fights the human over a 300px column. This module is the
 * bridge: the shell publishes what is on screen, tools read it, and
 * `workspace_reveal` asks the shell to open a named surface.
 *
 * Lives in `src/webmcp/` so the adapter can import it without pulling the
 * React workbench. The workbench writes here; it does not live in layout
 * persistence (those are UI prefs, not agent state).
 */

export const CHROME_SURFACES = [
  'generation',
  'refinement',
  'agent',
  'library',
  'inspector',
  'transform',
  'selection',
  'timeline',
] as const

export type ChromeSurface = (typeof CHROME_SURFACES)[number]

export const CHROME_SURFACE_TARGETS: Record<ChromeSurface, { dock: 'left' | 'right' | 'bottom'; section: string | null }> = {
  generation: { dock: 'right', section: 'generation.panel' },
  refinement: { dock: 'right', section: 'refinement.panel' },
  agent: { dock: 'right', section: 'agent.workbench' },
  library: { dock: 'left', section: 'palette' },
  inspector: { dock: 'right', section: 'inspector' },
  transform: { dock: 'right', section: 'transform' },
  selection: { dock: 'right', section: 'selection' },
  timeline: { dock: 'bottom', section: null },
}

export interface ChromeDock {
  collapsed: boolean
  size: number
}

export interface ChromeSnapshot {
  docks: { left: ChromeDock; right: ChromeDock; bottom: ChromeDock }
  sections: Record<string, boolean>
  tool: string
  cameraView: string
  activeColor: number
}

export interface ChromeReveal {
  surface: ChromeSurface
  applied: boolean
  dock: 'left' | 'right' | 'bottom'
  section: string | null
}

export type ChromeRevealHandler = (surface: ChromeSurface) => void

let snapshot: ChromeSnapshot | null = null
let revealHandler: ChromeRevealHandler | null = null

export function publishChrome(next: ChromeSnapshot | null): void {
  snapshot = next
}

export function readChrome(): ChromeSnapshot | null {
  return snapshot
}

export function setChromeRevealHandler(handler: ChromeRevealHandler | null): void {
  revealHandler = handler
}

export function revealChrome(surface: ChromeSurface): ChromeReveal {
  const target = CHROME_SURFACE_TARGETS[surface]
  if (revealHandler) revealHandler(surface)
  return {
    surface,
    applied: Boolean(revealHandler),
    dock: target.dock,
    section: target.section,
  }
}

/** Open the matching dock section, then attach the compact reveal receipt. */
export function withChromeReveal<T extends object>(surface: ChromeSurface, payload: T): T & { revealed: ChromeReveal } {
  return { ...payload, revealed: revealChrome(surface) }
}

/** Right-dock sections that compete for the same 300px column. Opening one closes the others. */
export const DOCK_FOCUS_SECTIONS = [
  'selection',
  'transform',
  'inspector',
  'connect',
  'generation.panel',
  'refinement.panel',
  'agent.workbench',
] as const

export function applyDockFocus<T extends { sections: Readonly<Record<string, boolean>> }>(
  layout: T,
  id: string,
  open: boolean,
): T {
  const sections = { ...layout.sections }
  const focused = (DOCK_FOCUS_SECTIONS as readonly string[]).includes(id)
  if (focused && open) {
    for (const other of DOCK_FOCUS_SECTIONS) sections[other] = other === id
  } else {
    sections[id] = open
  }
  return { ...layout, sections }
}

/** Collapse competing right-dock sheets so a restored layout is never a stack. */
export function applyExclusiveDock<T extends { sections: Readonly<Record<string, boolean>> }>(layout: T): T {
  const open = DOCK_FOCUS_SECTIONS.filter((id) => layout.sections[id] === true)
  if (open.length <= 1) return layout
  const keep = open.includes('selection') ? 'selection' : open[0]
  return applyDockFocus(layout, keep, true)
}

export function applyChromeReveal<T extends {
  left: ChromeDock
  right: ChromeDock
  bottom: ChromeDock
  sections: Readonly<Record<string, boolean>>
}>(layout: T, surface: ChromeSurface): T {
  const { dock, section } = CHROME_SURFACE_TARGETS[surface]
  const next = section ? applyDockFocus(layout, section, true) : layout
  return {
    ...next,
    [dock]: { ...next[dock], collapsed: false },
  }
}

export function resetChrome(): void {
  snapshot = null
  revealHandler = null
}
