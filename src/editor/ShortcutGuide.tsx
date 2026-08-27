import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface ShortcutGuideProps {
  open: boolean
  onClose: () => void
}

const groups = [
  {
    title: 'Create & edit',
    items: [
      ['V / 1', 'Select'], ['G', 'Move'], ['R', 'Rotate'], ['C', 'Connect'],
      ['⌘ D', 'Duplicate'], ['Delete', 'Remove'], ['L', 'Lock or unlock'],
    ],
  },
  {
    title: 'Navigate',
    items: [['F', 'Frame the model'], ['⌘ K', 'Search parts'], ['⌘ /', 'Command deck'], ['Esc', 'Cancel preview'], ['?', 'This guide']],
  },
  {
    title: 'History',
    items: [['⌘ Z', 'Undo'], ['⇧ ⌘ Z', 'Redo'], ['Enter', 'Accept proposal']],
  },
] as const

export function ShortcutGuide({ open, onClose }: ShortcutGuideProps) {
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
          // The close control is the modal's only focusable element.
          if (event.key === 'Tab') {
            event.preventDefault()
            close.current?.focus()
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
        <footer>Human and agent edits share one revisioned history. Keyboard commands never bypass the CAD kernel.</footer>
      </section>
    </div>
  )
}
