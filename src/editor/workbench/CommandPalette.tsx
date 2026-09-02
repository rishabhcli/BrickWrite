import { AlertTriangle, Command as CommandIcon, Keyboard, RotateCcw, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  COMMAND_GROUP_LABEL,
  RESERVED_CHORDS,
  WORKBENCH_COMMANDS,
  chordFromEvent,
  defaultShortcutMap,
  detectConflicts,
  formatChord,
  type CommandGroup,
  type ShortcutMap,
} from './shortcuts'
import type { CommandOutcome } from './commands'

/**
 * The command palette.
 *
 * Two surfaces in one modal, because they are two views of the same list: run a
 * command by name, or rebind it. Keeping the keymap editor here rather than in a
 * settings screen means the moment an operator notices a shortcut is wrong is
 * the moment they can fix it.
 */

function optionDomId(commandId: string) {
  return `command-palette-option-${commandId}`
}

export interface CommandPaletteProps {
  open: boolean
  shortcuts: ShortcutMap
  onShortcuts: (map: ShortcutMap) => void
  onRun: (commandId: string) => CommandOutcome
  disabledReason: (commandId: string) => string | null
  onClose: () => void
  /** Opens directly on the keyboard map. */
  initialTab?: 'run' | 'keys'
}

export function CommandPalette({
  open,
  shortcuts,
  onShortcuts,
  onRun,
  disabledReason,
  onClose,
  initialTab = 'run',
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [tab, setTab] = useState<'run' | 'keys'>(initialTab)
  const [recording, setRecording] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setQuery('')
    setCursor(0)
    setOutcome(null)
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => input.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      // Focus goes back where it came from, so closing the palette does not
      // strand the keyboard on `<body>`.
      returnFocus.current?.focus()
      returnFocus.current = null
    }
  }, [initialTab, open])

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    const scored = WORKBENCH_COMMANDS.map((command) => {
      const hay = `${command.title} ${command.detail} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
      if (!text) return { command, score: 0 }
      if (!text.split(/\s+/).every((token) => hay.includes(token))) return null
      let score = 0
      if (command.title.toLowerCase().startsWith(text)) score += 40
      else if (command.title.toLowerCase().includes(text)) score += 20
      if (command.group.startsWith(text)) score += 6
      return { command, score }
    }).filter((entry): entry is { command: (typeof WORKBENCH_COMMANDS)[number]; score: number } => entry !== null)
    return scored.sort((a, b) => b.score - a.score).map((entry) => entry.command)
  }, [query])

  useEffect(() => setCursor(0), [query])

  const conflicts = useMemo(() => detectConflicts(shortcuts), [shortcuts])
  const conflictedCommands = useMemo(
    () => new Set(conflicts.flatMap((conflict) => conflict.commandIds)),
    [conflicts],
  )

  const run = useCallback((commandId: string) => {
    const result = onRun(commandId)
    if (result.ran) onClose()
    else setOutcome(result.reason ?? 'That command is not available right now.')
  }, [onClose, onRun])

  /** Focus trap. A modal that lets Tab escape is a modal in name only. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (recording) setRecording(null)
      else onClose()
      return
    }
    if (event.key === 'Tab') {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
      return
    }
    if (tab !== 'run') return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((value) => Math.min(matches.length - 1, value + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((value) => Math.max(0, value - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = matches[cursor]
      if (command) run(command.id)
    }
  }, [cursor, matches, onClose, recording, run, tab])

  /** Chord capture. The next keystroke becomes the binding. */
  useEffect(() => {
    if (!recording) return
    const capture = (event: KeyboardEvent) => {
      const chord = chordFromEvent(event)
      if (!chord) return
      event.preventDefault()
      event.stopPropagation()
      if (chord === 'escape') { setRecording(null); return }
      onShortcuts({ ...shortcuts, [recording]: chord })
      setRecording(null)
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [onShortcuts, recording, shortcuts])

  if (!open) return null

  const grouped = new Map<CommandGroup, typeof WORKBENCH_COMMANDS[number][]>()
  for (const command of matches) {
    const bucket = grouped.get(command.group)
    if (bucket) bucket.push(command)
    else grouped.set(command.group, [command])
  }
  let rowIndex = -1
  const activeOptionId = matches[cursor] ? optionDomId(matches[cursor].id) : undefined

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        ref={dialog}
        onKeyDown={onKeyDown}
      >
        <header>
          <span className="command-glyph"><CommandIcon size={16} /></span>
          <div>
            <span className="eyebrow">WORKBENCH</span>
            <h2 id="command-palette-title">Command palette</h2>
          </div>
          <div className="palette-tabs" role="tablist" aria-label="Palette mode">
            <button type="button" role="tab" aria-selected={tab === 'run'} className={tab === 'run' ? 'active' : ''} onClick={() => setTab('run')}>
              <Search size={11} /> RUN
            </button>
            <button type="button" role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>
              <Keyboard size={11} /> KEYS
              {conflicts.length > 0 && <em className="conflict-count">{conflicts.length}</em>}
            </button>
          </div>
          <button type="button" className="command-close" onClick={onClose} aria-label="Close the command palette"><X size={15} /></button>
        </header>

        {tab === 'run' ? (
          <>
            <label className="command-palette-search">
              <Search size={13} />
              <input
                ref={input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Run a command…"
                aria-label="Search commands"
                aria-controls="command-palette-results"
                role="combobox"
                aria-expanded="true"
                aria-haspopup="listbox"
                aria-autocomplete="list"
                aria-activedescendant={activeOptionId}
              />
              <kbd>↑↓ ↵</kbd>
            </label>
            <div className="command-palette-results" id="command-palette-results" role="listbox" aria-label="Commands">
              {matches.length === 0 && (
                <div className="command-empty">
                  <Search size={18} />
                  <strong>No command matches “{query}”</strong>
                  <small>Try “array”, “isolate”, “connector”, “export” or “shortcut”.</small>
                </div>
              )}
              {[...grouped.entries()].map(([group, commands]) => (
                <section key={group}>
                  <h3>{COMMAND_GROUP_LABEL[group]}</h3>
                  {commands.map((command) => {
                    rowIndex += 1
                    const index = rowIndex
                    const reason = disabledReason(command.id)
                    return (
                      <button
                        key={command.id}
                        id={optionDomId(command.id)}
                        type="button"
                        role="option"
                        aria-selected={cursor === index}
                        aria-disabled={Boolean(reason)}
                        className={`${cursor === index ? 'cursor' : ''} ${reason ? 'unavailable' : ''}`}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => run(command.id)}
                        title={reason ?? command.detail}
                      >
                        <div>
                          <strong>{command.title}</strong>
                          <small>{reason ?? command.detail}</small>
                        </div>
                        <kbd>{formatChord(shortcuts[command.id])}</kbd>
                      </button>
                    )
                  })}
                </section>
              ))}
            </div>
            {outcome && <p className="command-palette-outcome" role="alert">{outcome}</p>}
          </>
        ) : (
          <>
            <div className="keymap-toolbar">
              <p>
                Click a binding, then press the keys you want. <kbd>Esc</kbd> cancels the capture.
                {RESERVED_CHORDS.length > 0 && ' Escape, Enter and Tab stay with the shell so a dialog can always be left.'}
              </p>
              <button
                type="button"
                className="keymap-reset"
                onClick={() => onShortcuts(defaultShortcutMap())}
                title="Restore every default binding"
              >
                <RotateCcw size={11} /> RESET ALL
              </button>
            </div>
            {conflicts.length > 0 && (
              <div className="keymap-conflicts" role="alert">
                <AlertTriangle size={13} />
                <div>
                  <strong>{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</strong>
                  <small>
                    A chord claimed twice fires nothing at all, so it is reported rather than resolved by guessing:
                    {' '}
                    {conflicts.map((conflict) => `${formatChord(conflict.chord)} (${conflict.commandIds.join(', ')})`).join(' · ')}
                  </small>
                </div>
              </div>
            )}
            <div className="keymap-list">
              {(Object.keys(COMMAND_GROUP_LABEL) as CommandGroup[]).map((group) => (
                <section key={group}>
                  <h3>{COMMAND_GROUP_LABEL[group]}</h3>
                  {WORKBENCH_COMMANDS.filter((command) => command.group === group).map((command) => (
                    <div key={command.id} className={`keymap-row ${conflictedCommands.has(command.id) ? 'conflict' : ''}`}>
                      <div>
                        <strong>{command.title}</strong>
                        <small>{command.detail}</small>
                      </div>
                      <button
                        type="button"
                        className={`keymap-chord ${recording === command.id ? 'recording' : ''}`}
                        aria-label={`Change the shortcut for ${command.title}, currently ${formatChord(shortcuts[command.id])}`}
                        onClick={() => setRecording(recording === command.id ? null : command.id)}
                      >
                        {recording === command.id ? 'press keys…' : formatChord(shortcuts[command.id])}
                      </button>
                      <button
                        type="button"
                        className="keymap-clear"
                        aria-label={`Remove the shortcut for ${command.title}`}
                        disabled={!shortcuts[command.id]}
                        onClick={() => onShortcuts({ ...shortcuts, [command.id]: null })}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
