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
  'model',
  'health',
  'timeline',
  'review',
  'feedback',
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
  model: { dock: 'right', section: 'model.explorer' },
  health: { dock: 'right', section: 'inspector' },
  timeline: { dock: 'bottom', section: null },
  review: { dock: 'bottom', section: null },
  feedback: { dock: 'bottom', section: null },
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

export type WorkspaceFocusMode = 'select' | 'frame' | 'isolate'

export interface WorkspaceFocusRequest {
  readonly partIds?: readonly string[]
  readonly subassemblyId?: string
  readonly mode: WorkspaceFocusMode
}

export interface WorkspaceFocusResolution {
  readonly requestedCount: number
  readonly matchedCount: number
  /** Bounded evidence for the caller; a large assembly can still be selected in full. */
  readonly selectedPartIds: readonly string[]
  readonly missingPartIds: readonly string[]
  readonly subassemblyFound: boolean | null
  readonly truncated: boolean
}

export interface WorkspaceFocusReceipt extends WorkspaceFocusResolution {
  readonly applied: boolean
  readonly mode: WorkspaceFocusMode
  readonly revealed: ChromeReveal
}

export type WorkspaceFocusHandler = (request: WorkspaceFocusRequest) => WorkspaceFocusResolution

export interface ProposalReviewResolution {
  readonly activeProposalId: string | null
  readonly found: boolean
  readonly pending: number
}

export interface ProposalReviewReceipt extends ProposalReviewResolution {
  readonly applied: boolean
  readonly revealed: ChromeReveal
}

export type ProposalReviewHandler = (proposalId?: string) => ProposalReviewResolution

export interface ModelHealthResolution {
  readonly activeIssueId: string | null
  readonly found: boolean
  readonly revision: number
  readonly blockers: number
  readonly warnings: number
  /** Bounded receipt only; the mounted workbench may select the complete issue scope. */
  readonly selectedPartIds: readonly string[]
  readonly truncated: boolean
}

export interface ModelHealthReceipt extends ModelHealthResolution {
  readonly applied: boolean
  readonly revealed: ChromeReveal
}

export type ModelHealthHandler = (issueId?: string) => ModelHealthResolution

let snapshot: ChromeSnapshot | null = null
let revealHandler: ChromeRevealHandler | null = null
let focusHandler: WorkspaceFocusHandler | null = null
let proposalReviewHandler: ProposalReviewHandler | null = null
let modelHealthHandler: ModelHealthHandler | null = null

export function publishChrome(next: ChromeSnapshot | null): void {
  snapshot = next
}

export function readChrome(): ChromeSnapshot | null {
  return snapshot
}

export function setChromeRevealHandler(handler: ChromeRevealHandler | null): void {
  revealHandler = handler
}

export function setWorkspaceFocusHandler(handler: WorkspaceFocusHandler | null): void {
  focusHandler = handler
}

export function setProposalReviewHandler(handler: ProposalReviewHandler | null): void {
  proposalReviewHandler = handler
}

export function setModelHealthHandler(handler: ModelHealthHandler | null): void {
  modelHealthHandler = handler
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

/**
 * Put exact model entities under the shared human/agent cursor.
 *
 * This changes selection and viewport chrome only; it never writes the CAD
 * document or advances its revision. The mounted workbench resolves ids so the
 * tool and the model map cannot disagree about what is actually visible.
 */
export function focusWorkspace(request: WorkspaceFocusRequest): WorkspaceFocusReceipt {
  const revealed = revealChrome('model')
  const resolution = focusHandler?.(request) ?? {
    requestedCount: request.partIds?.length ?? 0,
    matchedCount: 0,
    selectedPartIds: [],
    missingPartIds: request.partIds ?? [],
    subassemblyFound: request.subassemblyId ? false : null,
    truncated: false,
  }
  return {
    ...resolution,
    applied: Boolean(focusHandler),
    mode: request.mode,
    revealed,
  }
}

/** Open the measured change-review surface and choose one pending ghost. */
export function focusProposalReview(proposalId?: string): ProposalReviewReceipt {
  const revealed = revealChrome('review')
  const resolution = proposalReviewHandler?.(proposalId) ?? {
    activeProposalId: null,
    found: false,
    pending: 0,
  }
  return {
    ...resolution,
    applied: Boolean(proposalReviewHandler),
    revealed,
  }
}

/** Open the exact deterministic issue a human sees in the Model Health navigator. */
export function focusModelHealth(issueId?: string): ModelHealthReceipt {
  const revealed = revealChrome('health')
  const resolution = modelHealthHandler?.(issueId) ?? {
    activeIssueId: null,
    found: false,
    revision: 0,
    blockers: 0,
    warnings: 0,
    selectedPartIds: [],
    truncated: false,
  }
  return {
    ...resolution,
    applied: Boolean(modelHealthHandler),
    revealed,
  }
}

/** Open the matching dock section, then attach the compact reveal receipt. */
export function withChromeReveal<T extends object>(surface: ChromeSurface, payload: T): T & { revealed: ChromeReveal } {
  return { ...payload, revealed: revealChrome(surface) }
}

/**
 * Right-dock sections that compete for the same 300px column. Opening one closes
 * the others — but see `applyWorkbenchReveal`, which deliberately exempts the
 * three Design sheets, because Generate, Refine and the design partner are one
 * intentional stack rather than rivals for the column.
 *
 * There was also an `applyExclusiveDock` here, collapsing a *restored* layout to
 * a single sheet. It was removed rather than kept: nothing called it, and it
 * folded over this whole list, so reviving it would have quietly closed two of
 * the three Design panels that the default layout deliberately opens.
 */
export const DOCK_FOCUS_SECTIONS = [
  'selection',
  'model.explorer',
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
  focusHandler = null
  proposalReviewHandler = null
  modelHealthHandler = null
}
