import { useEffect, useRef, useState } from 'react'

/** A draft is not a model edit. Enter/blur commit once; Escape restores. Invalid input stays put. */
export function NumberField({
  label,
  value,
  suffix,
  disabled,
  compact,
  onCommit,
}: {
  label: string
  value: number
  suffix: string
  disabled?: boolean
  /** HUD density: keep the unit visible without eating the island. */
  compact?: boolean
  onCommit: (value: number) => unknown
}) {
  const display = Number(value.toFixed(4)).toString()
  const [draft, setDraft] = useState(display)
  const [invalid, setInvalid] = useState(false)
  const dirty = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setDraft(display)
    dirty.current = false
    setInvalid(false)
  }, [display])
  const commit = () => {
    if (!dirty.current) return
    if (inputRef.current?.validity.badInput) {
      setInvalid(true)
      return
    }
    const trimmed = draft.trim()
    if (!trimmed) {
      dirty.current = false
      setInvalid(false)
      setDraft(display)
      return
    }
    const next = Number(trimmed)
    if (!Number.isFinite(next)) {
      setInvalid(true)
      return
    }
    dirty.current = false
    setInvalid(false)
    if (Math.abs(next - value) > 0.00001) onCommit(next)
    setDraft(display)
  }
  return (
    <label
      className={`number-field ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''} ${invalid ? 'invalid' : ''}`
        .replace(/  +/g, ' ')
        .trim()}
    >
      <span>{label}</span>
      <div>
        <input
          ref={inputRef}
          type="number"
          step="any"
          value={draft}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={`${label} ${suffix === '°' ? 'rotation in degrees' : 'in LDraw units'}`}
          title={
            disabled
              ? `${label} is locked`
              : invalid
                ? 'Not a number — fix it or press Escape'
                : 'Enter to apply · Escape to cancel'
          }
          onChange={(event) => {
            dirty.current = true
            setInvalid(false)
            setDraft(event.target.value)
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              commit()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              dirty.current = false
              setInvalid(false)
              setDraft(display)
              event.currentTarget.blur()
            }
          }}
        />
        <em>{suffix}</em>
      </div>
    </label>
  )
}
