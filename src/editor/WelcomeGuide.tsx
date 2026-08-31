import { MousePointerClick, Undo2, X } from 'lucide-react'
import type { RefObject } from 'react'
import { useFocusTrap } from '../platform/a11y'

/**
 * First-run orientation.
 *
 * This used to introduce the whole console — connector mating, agent autonomy
 * tiers, the validation report — in four headings and four hints, all of it
 * before a single brick existed. None of that is usable on move one, and a
 * beginner reading eight lines of CAD vocabulary learns only that this
 * application is for somebody else. What is left is the one thing that gets a
 * brick on screen and the promise that makes experimenting safe. Everything
 * else is on the surface that needs it, or behind `?`.
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
    title: 'Click a part on the left, then click in the grid',
    hint: 'It lands snapped to whatever is under it.',
  },
  {
    icon: <Undo2 size={17} />,
    title: 'Nothing here is permanent',
    hint: '⌘Z undoes anything you do.',
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
            <h2 id="welcome-title">Before the first brick</h2>
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
          <span>Press <kbd>?</kbd> for everything else.</span>
          <button className="welcome-start" onClick={onClose}>Start building</button>
        </footer>
      </section>
    </div>
  )
}
