import { X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import {
  COMMAND_GROUP_LABEL,
  WORKBENCH_COMMANDS,
  defaultShortcutMap,
  formatChord,
  type ShortcutMap,
} from './workbench/shortcuts'

interface ShortcutGuideProps {
  open: boolean
  onClose: () => void
  shortcuts?: ShortcutMap
  /** Reopens the first-run orientation, so dismissing it is reversible. */
  onReplayWelcome?: () => void
}

export function ShortcutGuide({
  open,
  onClose,
  shortcuts = defaultShortcutMap(),
  onReplayWelcome,
}: ShortcutGuideProps) {
  const close = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const groups = useMemo(() => {
    const byGroup = new Map<string, Array<{ title: string; chord: string }>>()
    for (const command of WORKBENCH_COMMANDS) {
      const label = COMMAND_GROUP_LABEL[command.group]
      const list = byGroup.get(label) ?? []
      list.push({ title: command.title, chord: formatChord(shortcuts[command.id] ?? command.defaultChord) })
      byGroup.set(label, list)
    }
    return [...byGroup.entries()]
  }, [shortcuts])

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => {
      returnFocus.current?.focus()
      returnFocus.current = null
    }
  }, [open])

  if (!open) return null
  return (
    <div className="shortcut-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="shortcut-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header>
          <div><span className="eyebrow">COMMAND MAP</span><h2 id="shortcut-title">Work at the speed of thought</h2></div>
          <button ref={close} onClick={onClose} aria-label="Close keyboard shortcuts"><X size={15} /></button>
        </header>
        <div className="shortcut-groups">
          {groups.map(([title, items]) => (
            <section key={title}>
              <h3>{title}</h3>
              <dl>
                {items.map((item) => (
                  <div key={item.title}><dt>{item.title}</dt><dd><kbd>{item.chord}</kbd></dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer>
          <span>Human and agent edits share one revisioned history. Keyboard commands never bypass the CAD kernel.</span>
          {onReplayWelcome && <button className="shortcut-replay" onClick={onReplayWelcome}>Show the welcome guide</button>}
        </footer>
      </section>
    </div>
  )
}
