import { useEffect, useRef, type RefObject } from 'react'

/**
 * Keyboard behaviour for the shell's transient surfaces.
 *
 * The account menu is a dialog: while it is open, Tab must stay inside it, and
 * closing it must put focus back on the control that opened it. Neither is
 * automatic in React, and a menu that dumps focus back at the top of the
 * document is unusable with a keyboard — which matters here more than usual,
 * because Brickwright's editor is a keyboard-driven tool and an operator who
 * opened the menu with a keystroke expects to land back where they were.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Focusable descendants, in document order, skipping anything hidden. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex !== -1,
  )
}

export interface FocusTrapOptions {
  /** Called on Escape, so the owner decides what closing means. */
  onEscape?: () => void
  /**
   * Where focus goes when the trap closes.
   *
   * Defaults to whatever had focus when the trap opened, which is the right
   * answer whenever the trap was opened by a button.
   */
  restoreTo?: RefObject<HTMLElement | null>
  /**
   * Identity of the container being trapped.
   *
   * A trap that stays active while its dialog swaps one panel for another —
   * the project menu moving from Projects to Licences — would otherwise keep
   * its listeners on the panel that just unmounted, leaving Escape and Tab
   * bound to a detached node. Pass whatever names the current panel and the
   * trap re-binds when it changes.
   */
  key?: string | number
}

/**
 * Trap Tab inside a container while `active`, and restore focus when it closes.
 *
 * Returns the ref to put on the container.
 */
export function useFocusTrap(
  active: boolean,
  { onEscape, restoreTo, key }: FocusTrapOptions = {},
): RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const initial = focusableWithin(container)[0] ?? container
    initial.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onEscapeRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableWithin(container)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const activeElement = document.activeElement
      if (event.shiftKey && (activeElement === first || !container.contains(activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || !container.contains(activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore on the way out, not on every render: React 19 StrictMode runs
      // effects twice, and stealing focus back mid-mount would fight the user.
      const target = restoreTo?.current ?? previouslyFocused.current
      if (target && target.isConnected) target.focus()
    }
  }, [active, restoreTo, key])

  return containerRef
}
