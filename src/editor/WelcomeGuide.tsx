import { Boxes, MousePointerClick, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { RefObject } from 'react'
import { useFocusTrap } from '../platform/a11y'

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
    hint: 'R turns the ghost, Esc puts it back, + on a card skips the viewport.',
  },
  {
    icon: <Boxes size={17} />,
    title: 'It mates on real connectors, not a grid',
    hint: 'Drag the arrows to move a part. G, R and C switch tools.',
  },
  {
    icon: <ShieldCheck size={17} />,
    title: 'Collisions and limits are checked live',
    hint: '⌘Z undoes any of it. Validate shows the current report.',
  },
  {
    icon: <Sparkles size={17} />,
    title: 'You decide what the agent may do',
    hint: 'Inspect reads, Propose stages, Build commits. Protected parts stay off-limits.',
  },
] as const

interface WelcomeGuideProps {
  open: boolean
  onClose: () => void
}

export function WelcomeGuide({ open, onClose }: WelcomeGuideProps) {
  const guide = useFocusTrap(open, { onEscape: onClose })

  if (!open) return null
  return (
    <div className="welcome-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={guide as RefObject<HTMLElement>} className="welcome-guide" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <header>
          <div>
            <span className="eyebrow">AGENT-NATIVE BRICK CAD</span>
            <h2 id="welcome-title">Build something real</h2>
            <p>Four things worth knowing before the first brick.</p>
          </div>
          <button onClick={onClose} aria-label="Close the welcome guide"><X size={15} /></button>
        </header>
        <ol className="welcome-steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="welcome-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="welcome-icon">{step.icon}</span>
              <strong>{step.title}</strong>

              <em>{step.hint}</em>
            </li>
          ))}
        </ol>
        <footer>
          <span>Press <kbd>?</kbd> at any time for the full command map.</span>
          <button className="welcome-start" onClick={onClose}>Start building</button>
        </footer>
      </section>
    </div>
  )
}
