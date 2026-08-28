import type { ModelDocument } from '../../cad/types'

/**
 * Selection algebra.
 *
 * Clicking one brick at a time is the only selection a thousand-part model does
 * not support. Everything here answers the same question — "which parts does the
 * operator mean?" — from a different piece of evidence the document already
 * holds: colour, the connection graph, subassembly membership, or what is
 * currently on screen.
 *
 * All of these are pure functions of the document plus a seed, so they are
 * testable without a renderer and reusable by the agent.
 */

export type SelectionMode =
  | 'part'
  | 'colour'
  | 'connected'
  | 'subassembly'
  | 'definition'
  | 'visible'
  | 'inverse'

export interface SelectionModeInfo {
  readonly id: SelectionMode
  readonly label: string
  readonly hint: string
  /** True when the mode needs something already selected to work from. */
  readonly needsSeed: boolean
  readonly shortcut?: string
}

export const SELECTION_MODES: readonly SelectionModeInfo[] = [
  { id: 'part', label: 'Part', hint: 'Click one part. Shift-click adds, shift-drag boxes.', needsSeed: false, shortcut: '1' },
  { id: 'colour', label: 'Colour', hint: 'Every part sharing a colour with the selection.', needsSeed: true, shortcut: '2' },
  { id: 'connected', label: 'Connected', hint: 'The whole rigid island reachable through mated connectors.', needsSeed: true, shortcut: '3' },
  { id: 'subassembly', label: 'Module', hint: 'Every part in the selection’s subassemblies.', needsSeed: true, shortcut: '4' },
  { id: 'definition', label: 'Same part', hint: 'Every instance of the selected part numbers.', needsSeed: true, shortcut: '5' },
  { id: 'visible', label: 'Visible', hint: 'Everything currently drawn, ignoring hidden and isolated parts.', needsSeed: false, shortcut: '6' },
  { id: 'inverse', label: 'Inverse', hint: 'Everything except the current selection.', needsSeed: true, shortcut: '7' },
]

export interface SelectionContext {
  readonly document: ModelDocument
  readonly selection: readonly string[]
  /** Ids not currently drawn, so `visible` and `inverse` respect isolation. */
  readonly hidden: ReadonlySet<string>
}

/** Adjacency over the document's persisted connection edges. */
export function connectionAdjacency(document: ModelDocument): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    const bucket = adjacency.get(a)
    if (bucket) bucket.add(b)
    else adjacency.set(a, new Set([b]))
  }
  for (const edge of Object.values(document.connections)) {
    if (!document.parts[edge.a.partId] || !document.parts[edge.b.partId]) continue
    link(edge.a.partId, edge.b.partId)
    link(edge.b.partId, edge.a.partId)
  }
  return adjacency
}

/** Every part reachable from `seed` through mated connectors. */
export function connectedComponent(document: ModelDocument, seed: readonly string[]): string[] {
  const adjacency = connectionAdjacency(document)
  const seen = new Set<string>()
  const queue = seed.filter((id) => document.parts[id])
  for (const id of queue) seen.add(id)
  while (queue.length) {
    const current = queue.shift()!
    for (const neighbour of adjacency.get(current) ?? []) {
      if (seen.has(neighbour)) continue
      seen.add(neighbour)
      queue.push(neighbour)
    }
  }
  return [...seen]
}

/**
 * Resolves a selection mode into concrete part ids.
 *
 * Returns the current selection unchanged when a mode needs a seed and has
 * none, so a mode button is never a way to silently clear the selection.
 */
export function resolveSelection(mode: SelectionMode, context: SelectionContext): string[] {
  const { document, selection, hidden } = context
  const seeds = selection.filter((id) => document.parts[id])
  const info = SELECTION_MODES.find((entry) => entry.id === mode)
  if (info?.needsSeed && !seeds.length) return [...selection]

  switch (mode) {
    case 'part':
      return [...seeds]
    case 'colour': {
      const colours = new Set(seeds.map((id) => document.parts[id].color))
      return Object.values(document.parts).filter((part) => colours.has(part.color)).map((part) => part.id)
    }
    case 'connected':
      return connectedComponent(document, seeds)
    case 'subassembly': {
      const groups = new Set(seeds.map((id) => document.parts[id].subassemblyId))
      return Object.values(document.parts).filter((part) => groups.has(part.subassemblyId)).map((part) => part.id)
    }
    case 'definition': {
      const definitions = new Set(seeds.map((id) => document.parts[id].definitionId))
      return Object.values(document.parts).filter((part) => definitions.has(part.definitionId)).map((part) => part.id)
    }
    case 'visible':
      return Object.keys(document.parts).filter((id) => !hidden.has(id))
    case 'inverse': {
      const current = new Set(seeds)
      return Object.keys(document.parts).filter((id) => !current.has(id))
    }
  }
}

export interface SavedSelection {
  readonly id: string
  readonly name: string
  readonly partIds: readonly string[]
  /** Revision the set was captured at, so a stale set can say so. */
  readonly revision: number
}

/**
 * How much of a saved set still exists.
 *
 * A set captured before a delete is not an error and is not silently repaired:
 * it reports how many of its parts survive, and restoring it selects those.
 */
export function resolveSavedSelection(document: ModelDocument, saved: SavedSelection) {
  const present = saved.partIds.filter((id) => Boolean(document.parts[id]))
  return { present, missing: saved.partIds.length - present.length }
}

export interface VisibilityState {
  /** Explicitly hidden ids. */
  readonly hidden: ReadonlySet<string>
  /** When non-null, only these ids are drawn. */
  readonly isolated: ReadonlySet<string> | null
  /** Drawn at reduced opacity through the renderer's ghost path. */
  readonly ghosted: ReadonlySet<string>
}

export const EMPTY_VISIBILITY: VisibilityState = {
  hidden: new Set(),
  isolated: null,
  ghosted: new Set(),
}

/** Ids that are not drawn at all, given hide + isolate. Ghosts still draw. */
export function hiddenPartIds(document: ModelDocument, visibility: VisibilityState): Set<string> {
  const hidden = new Set<string>()
  for (const id of Object.keys(document.parts)) {
    if (visibility.hidden.has(id)) hidden.add(id)
    else if (visibility.isolated && !visibility.isolated.has(id)) hidden.add(id)
  }
  return hidden
}

export const visibilityActive = (visibility: VisibilityState): boolean =>
  visibility.hidden.size > 0 || visibility.isolated !== null || visibility.ghosted.size > 0

/**
 * The document handed to the renderer.
 *
 * Hidden parts are removed from the *rendered* copy only. The stored document
 * is untouched, which is what makes hide and isolate view state rather than a
 * destructive edit — no transaction, no revision, nothing to undo.
 */
export function applyVisibility(document: ModelDocument, hidden: ReadonlySet<string>): ModelDocument {
  if (!hidden.size) return document
  const parts = Object.fromEntries(Object.entries(document.parts).filter(([id]) => !hidden.has(id)))
  return { ...document, parts }
}

/** Human sentence for what visibility is currently doing, for the status bar. */
export function describeVisibility(visibility: VisibilityState, total: number): string | null {
  if (visibility.isolated) {
    return `Isolated ${visibility.isolated.size} of ${total} parts`
  }
  if (visibility.hidden.size) {
    return `${visibility.hidden.size} part${visibility.hidden.size === 1 ? '' : 's'} hidden`
  }
  if (visibility.ghosted.size) {
    return `${visibility.ghosted.size} part${visibility.ghosted.size === 1 ? '' : 's'} ghosted`
  }
  return null
}
