import { ChevronDown, CircleDot, ShieldCheck, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AutonomyMode, ColorDefinition } from '../../cad/types'
import { useFocusTrap } from '../../platform/a11y'

const MODES: readonly AutonomyMode[] = ['inspect', 'propose', 'build']

const MODE_ICON: Record<AutonomyMode, React.ReactElement> = {
  inspect: <CircleDot size={11} />,
  propose: <Sparkles size={11} />,
  build: <ShieldCheck size={11} />,
}

const MODE_HINT: Record<AutonomyMode, string> = {
  inspect: 'The agent may read the model and answer. It cannot propose edits.',
  propose: 'The agent drafts edits as ghost proposals you accept or reject.',
  build: 'The agent commits edits directly, still through every kernel check.',
}

/**
 * How much the agent is allowed to do, as one control.
 *
 * It was three radios in the top bar, shown to everybody on a first load
 * before there was a model to be autonomous about — and a second, independent
 * copy of the same radiogroup lives in the Ask panel, which is where the
 * conversation it governs actually happens. What the top bar owes is the
 * current answer; the choice opens on demand.
 */
export function AutonomySwitch({
  value,
  onChange,
  agentConnected = false,
}: {
  value: AutonomyMode
  onChange: (mode: AutonomyMode) => void
  /** Build confirmation is only needed while an agent can actually receive the grant. */
  agentConnected?: boolean
}) {
  const [confirmBuild, setConfirmBuild] = useState(false)
  const buildConfirmed = useRef(false)
  const buildButton = useRef<HTMLButtonElement>(null)
  const cancel = useCallback(() => setConfirmBuild(false), [])
  const confirmation = useFocusTrap(confirmBuild, { onEscape: cancel, restoreTo: buildButton })

  const request = (mode: AutonomyMode) => {
    if (mode === 'build' && agentConnected && !buildConfirmed.current && value !== 'build') {
      setConfirmBuild(true)
      return
    }
    onChange(mode)
  }

  const [open, setOpen] = useState(false)
  const popover = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!popover.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open])

  return (
    <>
      <div className="autonomy-switch">
        <button
          ref={trigger}
          type="button"
          className={`autonomy-current ${value}`}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={`Agent autonomy: ${value}`}
          title={MODE_HINT[value]}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
        >
          {MODE_ICON[value]}
          {value}
          <ChevronDown size={10} aria-hidden="true" />
        </button>
        {open && (
          <div className="autonomy-menu" ref={popover} role="radiogroup" aria-label="Agent autonomy mode">
            {MODES.map((mode) => (
              <button
                ref={mode === 'build' ? buildButton : undefined}
                type="button"
                role="radio"
                aria-checked={value === mode}
                key={mode}
                className={value === mode ? `active ${mode}` : ''}
                title={MODE_HINT[mode]}
                onClick={() => {
                  setOpen(false)
                  request(mode)
                }}
              >
                {MODE_ICON[mode]}
                <span>
                  <strong>{mode}</strong>
                  <small>{MODE_HINT[mode]}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {confirmBuild && (
        <div className="autonomy-confirm-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
          <div
            ref={confirmation as RefObject<HTMLDivElement>}
            className="autonomy-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="autonomy-confirm-title"
            aria-describedby="autonomy-confirm-detail"
          >
            <span className="eyebrow">AGENT ACCESS</span>
            <h2 id="autonomy-confirm-title">Grant Build access?</h2>
            <p id="autonomy-confirm-detail">
              The connected agent may commit edits directly. Every edit still passes the same constraints, protected-region checks and revision history.
            </p>
            <div>
              <button type="button" onClick={cancel}>Keep Propose access</button>
              <button
                type="button"
                className="confirm-build"
                onClick={() => {
                  buildConfirmed.current = true
                  setConfirmBuild(false)
                  onChange('build')
                }}
              >
                Grant Build access
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function ColorLabel({ color }: { color: ColorDefinition }) {
  return <span className="color-label"><i style={{ background: color.hex }} />{color.name}</span>
}
