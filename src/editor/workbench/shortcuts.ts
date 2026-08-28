import { readPreference, writePreference } from './persistence'

/**
 * The keyboard map.
 *
 * Two things this has to be that a hardcoded `switch` on `event.key` could not:
 * remappable, because muscle memory belongs to the operator and not to us; and
 * enumerable, because the command palette, the status bar and the shortcut
 * sheet all need to state the current binding rather than a literal that was
 * true when it was written.
 *
 * Chords are stored platform-neutrally. `Mod` means ⌘ on Apple hardware and
 * Ctrl everywhere else, so one saved map works on both.
 */

export type CommandGroup = 'tools' | 'edit' | 'select' | 'view' | 'visibility' | 'panels' | 'project' | 'help'

export interface CommandDefinition {
  readonly id: string
  readonly title: string
  readonly group: CommandGroup
  /** One line saying what it does, shown in the palette. */
  readonly detail: string
  /** Platform-neutral default chord, or null for commands with no default key. */
  readonly defaultChord: string | null
  /** Keywords the palette also matches on. */
  readonly keywords?: string
}

/**
 * Chords the shell owns outright.
 *
 * Escape cancels, Enter accepts, Tab moves focus. Letting these be rebound would
 * let an operator lock themselves out of a modal, so the editor keeps them and
 * says so in the shortcut editor rather than silently refusing.
 */
export const RESERVED_CHORDS: readonly string[] = ['escape', 'enter', 'tab', 'shift+tab']

export const WORKBENCH_COMMANDS: readonly CommandDefinition[] = [
  // Tools ------------------------------------------------------------------
  { id: 'tool.select', title: 'Select tool', group: 'tools', detail: 'Pick parts, shift-drag to box select.', defaultChord: 'v', keywords: 'pointer arrow pick' },
  { id: 'tool.move', title: 'Move tool', group: 'tools', detail: 'Drag the translate gizmo on the selection.', defaultChord: 'g', keywords: 'translate grab gizmo' },
  { id: 'tool.rotate', title: 'Rotate tool', group: 'tools', detail: 'Drag the rotate rings on the selection.', defaultChord: 'r', keywords: 'turn spin gizmo' },
  { id: 'tool.connect', title: 'Connect tool', group: 'tools', detail: 'Mate two parts through their real connectors.', defaultChord: 'c', keywords: 'mate snap join hinge' },

  // Edit -------------------------------------------------------------------
  { id: 'edit.undo', title: 'Undo', group: 'edit', detail: 'Reverse the last transaction, human or agent.', defaultChord: 'mod+z' },
  { id: 'edit.redo', title: 'Redo', group: 'edit', detail: 'Reapply the last undone transaction.', defaultChord: 'shift+mod+z' },
  { id: 'edit.clone', title: 'Clone selection', group: 'edit', detail: 'Duplicate the selection one part-width along X.', defaultChord: 'mod+d', keywords: 'duplicate copy' },
  { id: 'edit.delete', title: 'Delete selection', group: 'edit', detail: 'Remove every selected part in one transaction.', defaultChord: 'delete', keywords: 'remove erase' },
  { id: 'edit.quarter-turn', title: 'Quarter turn', group: 'edit', detail: 'Turn the selection 90° about its own vertical axis.', defaultChord: 'shift+r', keywords: 'rotate 90' },
  { id: 'edit.mirror', title: 'Mirror across X', group: 'edit', detail: 'Reflect the selection through an exact X plane.', defaultChord: 'shift+m' },
  { id: 'edit.array', title: 'Linear array…', group: 'edit', detail: 'Repeat the selection along an exact vector.', defaultChord: 'shift+a', keywords: 'repeat pattern' },
  { id: 'edit.protect', title: 'Protect / unlock selection', group: 'edit', detail: 'Toggle the kernel-enforced agent lock.', defaultChord: 'l', keywords: 'lock' },
  { id: 'edit.paint', title: 'Paint with active colour', group: 'edit', detail: 'Recolour the selection to the palette’s active colour.', defaultChord: 'p', keywords: 'recolour recolor colour' },
  { id: 'edit.eyedropper', title: 'Pick colour from selection', group: 'edit', detail: 'Make the selected part’s colour the active colour.', defaultChord: 'k', keywords: 'eyedropper sample' },

  // Selection --------------------------------------------------------------
  { id: 'select.all', title: 'Select all', group: 'select', detail: 'Select every part in the document.', defaultChord: 'mod+a' },
  { id: 'select.none', title: 'Clear selection', group: 'select', detail: 'Deselect everything.', defaultChord: 'shift+mod+a' },
  { id: 'select.inverse', title: 'Invert selection', group: 'select', detail: 'Select everything the selection does not cover.', defaultChord: 'mod+i' },
  { id: 'select.connected', title: 'Grow to connected island', group: 'select', detail: 'Expand through mated connectors to the whole rigid island.', defaultChord: 'alt+c' },
  { id: 'select.colour', title: 'Select same colour', group: 'select', detail: 'Every part sharing a colour with the selection.', defaultChord: 'alt+k' },
  { id: 'select.subassembly', title: 'Select whole module', group: 'select', detail: 'Every part in the selection’s subassemblies.', defaultChord: 'alt+m' },
  { id: 'select.definition', title: 'Select same part number', group: 'select', detail: 'Every instance of the selected part numbers.', defaultChord: 'alt+p' },
  { id: 'select.save', title: 'Save selection set…', group: 'select', detail: 'Name the current selection so it can be recalled.', defaultChord: 'shift+mod+s' },

  // View -------------------------------------------------------------------
  { id: 'view.fit', title: 'Frame the model', group: 'view', detail: 'Reset to isometric and fit everything on screen.', defaultChord: 'f' },
  { id: 'view.iso', title: 'Isometric view', group: 'view', detail: 'Look at the model from three-quarters.', defaultChord: 'alt+1' },
  { id: 'view.front', title: 'Front view', group: 'view', detail: 'Look along +Z.', defaultChord: 'alt+2' },
  { id: 'view.top', title: 'Top view', group: 'view', detail: 'Look straight down.', defaultChord: 'alt+3' },
  { id: 'view.beauty', title: 'Beauty render', group: 'view', detail: 'The normal shaded viewport.', defaultChord: 'alt+b' },
  { id: 'view.connections', title: 'Connector map', group: 'view', detail: 'Draw every compiled connector at its solved world position.', defaultChord: 'alt+n' },
  { id: 'view.violations', title: 'Collision report', group: 'view', detail: 'Highlight parts in a confirmed collision pair.', defaultChord: 'alt+x' },
  { id: 'view.exploded', title: 'Exploded view', group: 'view', detail: 'Push subassemblies apart. Display only.', defaultChord: 'alt+e' },

  // Visibility -------------------------------------------------------------
  { id: 'visibility.hide', title: 'Hide selection', group: 'visibility', detail: 'Stop drawing the selection. The document is unchanged.', defaultChord: 'h' },
  { id: 'visibility.show-all', title: 'Show everything', group: 'visibility', detail: 'Clear hide, isolate and ghost.', defaultChord: 'shift+h' },
  { id: 'visibility.isolate', title: 'Isolate selection', group: 'visibility', detail: 'Draw only the selection until cleared.', defaultChord: 'shift+i' },
  { id: 'visibility.ghost', title: 'Ghost selection', group: 'visibility', detail: 'Draw the selection translucent so context stays readable.', defaultChord: 'shift+g' },
  { id: 'visibility.focus', title: 'Focus selection', group: 'visibility', detail: 'Frame the camera tightly on the selection.', defaultChord: 'shift+f' },

  // Panels -----------------------------------------------------------------
  { id: 'panel.left', title: 'Toggle the palette dock', group: 'panels', detail: 'Collapse or restore the left dock.', defaultChord: 'mod+b' },
  { id: 'panel.right', title: 'Toggle the inspector dock', group: 'panels', detail: 'Collapse or restore the right dock.', defaultChord: 'shift+mod+b' },
  { id: 'panel.bottom', title: 'Toggle the timeline', group: 'panels', detail: 'Collapse or restore the bottom dock.', defaultChord: 'mod+j' },
  { id: 'panel.search', title: 'Search parts', group: 'panels', detail: 'Put the cursor in the catalogue search field.', defaultChord: 'mod+k' },

  // Project ----------------------------------------------------------------
  { id: 'project.command-palette', title: 'Command palette', group: 'project', detail: 'Find and run any command by name.', defaultChord: 'mod+p' },
  { id: 'project.command-deck', title: 'Command deck', group: 'project', detail: 'The parameterised console for every shared capability.', defaultChord: 'mod+/' },
  { id: 'project.export', title: 'Export LDraw', group: 'project', detail: 'Download the exact flat .ldr for this revision.', defaultChord: 'mod+e' },
  { id: 'project.resequence', title: 'Regenerate build order', group: 'project', detail: 'Derive a verified attachment-aware build sequence.', defaultChord: null },

  // Help -------------------------------------------------------------------
  { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'help', detail: 'The full command map.', defaultChord: '?' },
  { id: 'help.welcome', title: 'Replay the welcome guide', group: 'help', detail: 'Show the first-run orientation again.', defaultChord: null },
  { id: 'help.keymap', title: 'Customise shortcuts…', group: 'help', detail: 'Rebind any command and see conflicts.', defaultChord: null },
  { id: 'help.reset-workspace', title: 'Reset workspace preferences', group: 'help', detail: 'Put the dock layout, palette sets and shortcut map back to their defaults. The model is untouched.', defaultChord: null, keywords: 'layout default restore shortcuts' },
]

export const COMMAND_GROUP_LABEL: Record<CommandGroup, string> = {
  tools: 'Tools',
  edit: 'Edit',
  select: 'Selection',
  view: 'View',
  visibility: 'Visibility',
  panels: 'Panels',
  project: 'Project',
  help: 'Help',
}

export type ShortcutMap = Record<string, string | null>

const STORAGE_KEY = 'shortcuts.v1'

export const defaultShortcutMap = (): ShortcutMap =>
  Object.fromEntries(WORKBENCH_COMMANDS.map((command) => [command.id, command.defaultChord]))

/**
 * Normalises a chord into its stored form.
 *
 * Modifier order is fixed so `Shift+Mod+Z` and `Mod+Shift+Z` are the same
 * binding, which is the difference between conflict detection working and
 * quietly missing half the collisions.
 */
export function normaliseChord(input: string): string {
  const parts = input
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (!parts.length) return ''
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))
  const ordered = ['mod', 'ctrl', 'alt', 'shift'].filter((modifier) => modifiers.has(modifier))
  return [...ordered, key === 'del' ? 'delete' : key].join('+')
}

const isApple = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** The chord a keyboard event produces, in stored form. */
export function chordFromEvent(event: KeyboardEvent): string {
  const key = event.key
  if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') return ''
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('mod')
  if (event.altKey) parts.push('alt')
  // Shift is only meaningful when it did not already change the character. `?`
  // is Shift+/ on most layouts, and recording it as `shift+?` would mean the
  // binding could never fire.
  const lower = key.length === 1 ? key.toLowerCase() : key.toLowerCase()
  const shiftChangedCharacter = key.length === 1 && key !== key.toLowerCase()
  if (event.shiftKey && (key.length > 1 || shiftChangedCharacter)) parts.push('shift')
  parts.push(lower === 'backspace' ? 'delete' : lower)
  return normaliseChord(parts.join('+'))
}

const KEY_LABEL: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  delete: 'Del',
  escape: 'Esc',
  enter: '↵',
  ' ': 'Space',
}

/** Display form for a chord, using platform glyphs. */
export function formatChord(chord: string | null | undefined): string {
  if (!chord) return '—'
  const mac = isApple()
  return chord
    .split('+')
    .map((part) => {
      if (part === 'mod') return mac ? '⌘' : 'Ctrl'
      if (part === 'ctrl') return mac ? '⌃' : 'Ctrl'
      if (part === 'alt') return mac ? '⌥' : 'Alt'
      if (part === 'shift') return mac ? '⇧' : 'Shift'
      return KEY_LABEL[part] ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    })
    .join(mac ? '' : '+')
}

export interface ShortcutConflict {
  readonly chord: string
  readonly commandIds: readonly string[]
}

/** Every chord claimed by more than one command, plus any reserved collisions. */
export function detectConflicts(map: ShortcutMap): ShortcutConflict[] {
  const byChord = new Map<string, string[]>()
  for (const [commandId, chord] of Object.entries(map)) {
    if (!chord) continue
    const bucket = byChord.get(chord)
    if (bucket) bucket.push(commandId)
    else byChord.set(chord, [commandId])
  }
  const conflicts: ShortcutConflict[] = []
  for (const [chord, commandIds] of byChord) {
    if (commandIds.length > 1) conflicts.push({ chord, commandIds: commandIds.sort() })
    else if (RESERVED_CHORDS.includes(chord)) conflicts.push({ chord, commandIds })
  }
  return conflicts.sort((a, b) => a.chord.localeCompare(b.chord))
}

/** The command a chord should run, or null. Conflicted chords resolve to none. */
export function commandForChord(map: ShortcutMap, chord: string): string | null {
  if (!chord) return null
  const matches = Object.entries(map).filter(([, value]) => value === chord)
  return matches.length === 1 ? matches[0][0] : null
}

export const loadShortcutMap = (): ShortcutMap => {
  const stored = readPreference<Partial<ShortcutMap>>(STORAGE_KEY, {})
  const map = defaultShortcutMap()
  for (const [commandId, chord] of Object.entries(stored)) {
    // A stored binding for a command that no longer exists is dropped rather
    // than kept as a phantom conflict.
    if (!(commandId in map)) continue
    map[commandId] = chord ? normaliseChord(chord) : null
  }
  return map
}

export const saveShortcutMap = (map: ShortcutMap): void => writePreference(STORAGE_KEY, map)

export const commandById = (id: string): CommandDefinition | undefined =>
  WORKBENCH_COMMANDS.find((command) => command.id === id)

/** Whether a keyboard event originated inside something the operator is typing in. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
