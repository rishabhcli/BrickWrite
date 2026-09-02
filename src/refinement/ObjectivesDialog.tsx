import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { objectiveList } from './objectives'
import './panel.css'

/**
 * The objective reference.
 *
 * Thirteen weight sliders in a 300 px dock cannot also carry the sentence that
 * says what each one measures, and a weight nobody understands is a weight
 * nobody moves. The engine already publishes a description, a unit and a
 * direction per objective, so the dialog is a rendering of that rather than a
 * second, drifting copy of it.
 *
 * Focus is trapped and restored here rather than assumed from the shell: the
 * modal slot renders whatever the active contribution returns, so the keyboard
 * contract is this component's to keep.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function ObjectivesDialog({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Captured before the dialog takes focus, so closing returns the operator to
  // the control they opened it from rather than to the top of the document.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  if (returnFocusRef.current === null && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement as HTMLElement | null
  }

  useEffect(() => {
    closeRef.current?.focus()
    const restore = returnFocusRef.current
    return () => {
      if (restore && typeof restore.focus === 'function' && restore.isConnected) restore.focus()
    }
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  return (
    <div
      className="bw-refine-dialog"
      role="presentation"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="bw-refine-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bw-refine-objectives-title"
        ref={panelRef}
      >
        <div className="bw-refine-dialog__head">
          <h2 id="bw-refine-objectives-title">Objectives — what each weight buys</h2>
          <button ref={closeRef} className="bw-refine__btn" onClick={onClose} aria-label="Close the objective reference">
            <X size={12} aria-hidden="true" /> Close
          </button>
        </div>
        <div className="bw-refine-dialog__body">
          <p className="bw-refine-dialog__intro">
            Every proposal is measured on all {objectiveList.length} axes and every axis is reported, improved or not.
            A weight says how much one unit of improvement on that axis is worth when proposals are ranked against each
            other; it never switches an axis off, and a regression is named whatever the weights say.
          </p>
          {objectiveList.map((objective) => (
            <section className="bw-refine-dialog__objective" key={objective.id}>
              <h3>{objective.label}</h3>
              <div className="bw-refine-dialog__meta">
                {objective.unit} · {objective.direction === 'higher-is-better' ? 'higher is better' : 'lower is better'} ·
                one unit of improvement = {objective.scale} {objective.unit} · default weight {objective.defaultWeight}
              </div>
              <p>{objective.description}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
