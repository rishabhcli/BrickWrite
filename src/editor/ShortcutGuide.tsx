import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface ShortcutGuideProps {
  open: boolean
  onClose: () => void
  /** Reopens the first-run orientation, so dismissing it is reversible. */
  onReplayWelcome?: () => void
}

const groups = [
  {
    title: 'Create & edit',
    items: [
      ['V / 1', 'Select'], ['⇧ drag', 'Box select'], ['G', 'Move'], ['R', 'Rotate'], ['C', 'Connect'],
      ['⌘ D', 'Duplicate'], ['Delete', 'Remove'], ['L', 'Lock or unlock'],
    ],
  },
  {
    title: 'Navigate',
    items: [['F', 'Frame the model'], ['⌘ K', 'Search parts'], ['⌘ /', 'Command deck'], ['Esc', 'Cancel placement or preview'], ['?', 'This guide']],
  },
  {
    title: 'History',
    items: [['⌘ Z', 'Undo'], ['⇧ ⌘ Z', 'Redo'], ['Enter', 'Accept proposal'], ['R', 'Turn the part being placed']],
  },
] as const

export function ShortcutGuide({ open, onClose, onReplayWelcome }: ShortcutGuideProps) {
  const close = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

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
          // Focus stays inside the dialog. It now holds more than one control,
          // so the trap cycles through them rather than pinning the close button.
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
          {groups.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map(([keys, label]) => (
                  <div key={label}><dt>{label}</dt><dd>{keys.split(' ').map((key) => <kbd key={key}>{key}</kbd>)}</dd></div>
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
