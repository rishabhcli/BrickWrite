import { CircleDot, ShieldCheck, Sparkles } from 'lucide-react'
import { useCallback, useRef, useState, type RefObject } from 'react'
import type { AutonomyMode, ColorDefinition } from '../../cad/types'
import { useFocusTrap } from '../../platform/a11y'

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

  return (
    <>
      <div className="autonomy-switch" role="radiogroup" aria-label="Agent autonomy mode">
        {(['inspect', 'propose', 'build'] as AutonomyMode[]).map((mode) => (
          <button
            ref={mode === 'build' ? buildButton : undefined}
            type="button"
            role="radio"
            aria-checked={value === mode}
            key={mode}
            className={value === mode ? `active ${mode}` : ''}
            onClick={() => request(mode)}
          >
            {mode === 'inspect' && <CircleDot size={11} />}
            {mode === 'propose' && <Sparkles size={11} />}
            {mode === 'build' && <ShieldCheck size={11} />}
            {mode}
          </button>
        ))}
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
