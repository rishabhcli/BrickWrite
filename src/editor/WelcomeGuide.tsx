import { Boxes, MousePointerClick, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

/**
 * First-run orientation.
 *
 * Brickwright is a dense CAD console, and every control on it was legible only
 * to someone who already knew the model it implements: a catalog you arm from,
 * a viewport you drop into, a kernel that mates parts by their real connectors,
 * and an agent whose reach you set. Nothing on screen said any of that, so the
 * opening move — "how do I put a brick down?" — had no answer short of clicking
 * around. This says it once, in the order the work happens, and then gets out of
 * the way.
 *
 * It is reachable again from the keyboard map, so dismissing it is not a
 * one-way door.
 */

export const WELCOME_SEEN_KEY = 'brickwright.welcome.v1'

/** Whether the guide should open unprompted. Storage failures show it, not hide it. */
export function welcomeUnseen(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_SEEN_KEY) !== 'seen'
  } catch {
    return true
  }
}

export function markWelcomeSeen(): void {
  try {
    window.localStorage.setItem(WELCOME_SEEN_KEY, 'seen')
  } catch {
    // A blocked storage context is not a reason to fail an editor session.
  }
}

const STEPS = [
  {
    icon: <MousePointerClick size={17} />,
    title: 'Pick a part, then click in the viewport',
    body: 'Choosing a part from the library arms it, and a ghost follows your cursor. R turns it, Esc puts it back. Each click drops another one.',
    hint: 'The + on a card drops it straight onto the build instead.',
  },
  {
    icon: <Boxes size={17} />,
    title: 'It mates on real connectors, not a grid',
    body: 'Placement is solved against LDraw stud, clutch and pin geometry, so slopes, brackets and sideways studs land the way the physical part would.',
    hint: 'Select a part and drag the arrows to move it — G, R and C switch tools.',
  },
  {
    icon: <ShieldCheck size={17} />,
    title: 'Collisions and limits are checked live',
    body: 'Every edit commits as one reversible transaction. The kernel refuses anything that breaks a hard constraint and reports what it found.',
    hint: '⌘Z undoes any of it. The Validate tab shows the current report.',
  },
  {
    icon: <Sparkles size={17} />,
    title: 'You decide what the agent may do',
    body: 'Inspect lets it read. Propose lets it stage ghost edits you accept or reject. Build lets it commit directly, still bound by the same kernel.',
    hint: 'Protected parts stay off-limits to the agent in every mode.',
  },
] as const

interface WelcomeGuideProps {
  open: boolean
  onClose: () => void
}

export function WelcomeGuide({ open, onClose }: WelcomeGuideProps) {
  const dismiss = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dismiss.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // Capture, so the editor's own Escape handling does not also fire behind
    // a modal the operator is only trying to close.
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      returnFocus.current?.focus()
      returnFocus.current = null
    }
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="welcome-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="welcome-guide" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <header>
          <div>
            <span className="eyebrow">AGENT-NATIVE BRICK CAD</span>
            <h2 id="welcome-title">Build something real</h2>
            <p>
              Every part here is a compiled LDraw element with its own measured connectors. Four things worth knowing
              before the first brick.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close the welcome guide"><X size={15} /></button>
        </header>
        <ol className="welcome-steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="welcome-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="welcome-icon">{step.icon}</span>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
              <em>{step.hint}</em>
            </li>
          ))}
        </ol>
        <footer>
          <span>Press <kbd>?</kbd> at any time for the full command map.</span>
          <button ref={dismiss} className="welcome-start" onClick={onClose}>Start building</button>
        </footer>
      </section>
    </div>
  )
}
