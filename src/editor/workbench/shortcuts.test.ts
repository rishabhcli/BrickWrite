import { beforeEach, describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  commandForChord,
  defaultShortcutMap,
  detectConflicts,
  formatChord,
  isTypingTarget,
  loadShortcutMap,
  normaliseChord,
  RESERVED_CHORDS,
  saveShortcutMap,
  WORKBENCH_COMMANDS,
} from './shortcuts'

beforeEach(() => window.localStorage.clear())

const press = (init: KeyboardEventInit) => chordFromEvent(new KeyboardEvent('keydown', init))

describe('the default map', () => {
  it('binds every command that claims a default', () => {
    const map = defaultShortcutMap()
    for (const command of WORKBENCH_COMMANDS) expect(map[command.id]).toBe(command.defaultChord)
  })

  it('ships with no conflicts', () => {
    expect(detectConflicts(defaultShortcutMap())).toEqual([])
  })

  it('never claims a chord the shell reserves', () => {
    const claimed = Object.values(defaultShortcutMap()).filter(Boolean)
    for (const reserved of RESERVED_CHORDS) expect(claimed).not.toContain(reserved)
  })
})

describe('chord normalisation', () => {
  it('puts modifiers in one fixed order, so two spellings are one binding', () => {
    expect(normaliseChord('Shift+Mod+Z')).toBe('mod+shift+z')
    expect(normaliseChord('mod+shift+z')).toBe('mod+shift+z')
  })

  it('folds Del into Delete', () => {
    expect(normaliseChord('Del')).toBe('delete')
  })

  it('reads a chord off a keyboard event', () => {
    expect(press({ key: 'z', metaKey: true })).toBe('mod+z')
    expect(press({ key: 'Z', metaKey: true, shiftKey: true })).toBe('mod+shift+z')
    expect(press({ key: 'g' })).toBe('g')
    expect(press({ key: 'Backspace' })).toBe('delete')
  })

  it('ignores a bare modifier press', () => {
    expect(press({ key: 'Meta', metaKey: true })).toBe('')
  })

  it('does not record shift for a character shift already produced', () => {
    // `?` is Shift+/ on most layouts. Recording it as shift+? would make the
    // binding unfireable.
    expect(press({ key: '?', shiftKey: true })).toBe('?')
  })
})

describe('conflict detection', () => {
  it('names both commands that claim one chord', () => {
    const map = { ...defaultShortcutMap(), 'tool.move': 'v' }
    const conflicts = detectConflicts(map)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].chord).toBe('v')
    expect(conflicts[0].commandIds).toEqual(['tool.move', 'tool.select'])
  })

  it('flags a binding that steals a reserved chord', () => {
    expect(detectConflicts({ 'tool.move': 'escape' })).toEqual([{ chord: 'escape', commandIds: ['tool.move'] }])
  })

  it('resolves a conflicted chord to nothing rather than guessing', () => {
    const map = { ...defaultShortcutMap(), 'tool.move': 'v' }
    expect(commandForChord(map, 'v')).toBeNull()
    expect(commandForChord(defaultShortcutMap(), 'v')).toBe('tool.select')
  })

  it('ignores unbound commands', () => {
    expect(commandForChord({ a: null, b: null }, '')).toBeNull()
  })
})

describe('persistence', () => {
  it('round-trips a remapped binding', () => {
    saveShortcutMap({ ...defaultShortcutMap(), 'tool.move': 'w' })
    expect(loadShortcutMap()['tool.move']).toBe('w')
  })

  it('keeps defaults for commands the stored map never mentioned', () => {
    saveShortcutMap({ 'tool.move': 'w' })
    expect(loadShortcutMap()['tool.select']).toBe('v')
  })

  it('drops a stored binding for a command that no longer exists', () => {
    saveShortcutMap({ 'tool.retired': 'q' } as Record<string, string>)
    expect(loadShortcutMap()).not.toHaveProperty('tool.retired')
  })

  it('normalises a stored chord written in another order', () => {
    saveShortcutMap({ 'edit.redo': 'Shift+Mod+Y' })
    expect(loadShortcutMap()['edit.redo']).toBe('mod+shift+y')
  })
})

describe('display', () => {
  it('renders an unbound command as an em dash rather than an empty gap', () => {
    expect(formatChord(null)).toBe('—')
  })

  it('spells a chord with platform glyphs', () => {
    const rendered = formatChord('mod+shift+z')
    expect(rendered === '⌘⇧Z' || rendered === 'Ctrl+Shift+Z').toBe(true)
  })
})

describe('typing targets', () => {
  it('recognises the fields a shortcut must not fire inside', () => {
    const input = window.document.createElement('input')
    const div = window.document.createElement('div')
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(div)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
