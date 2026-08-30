import { useEffect, useRef, useState } from 'react'

/** A draft is not a model edit. Enter/blur commit once; Escape and invalid input restore. */
export function NumberField({
  label,
  value,
  suffix,
  disabled,
  onCommit,
}: {
  label: string
  value: number
  suffix: string
  disabled?: boolean
  onCommit: (value: number) => unknown
}) {
  const display = Number(value.toFixed(4)).toString()
  const [draft, setDraft] = useState(display)
  const dirty = useRef(false)
  useEffect(() => {
    setDraft(display)
    dirty.current = false
  }, [display])
  const commit = () => {
    if (!dirty.current) return
    dirty.current = false
    const next = draft.trim() ? Number(draft) : NaN
    if (Number.isFinite(next) && Math.abs(next - value) > 0.00001) onCommit(next)
    setDraft(display)
  }
  return (
    <label className={`number-field ${disabled ? 'disabled' : ''}`}>
      <span>{label}</span>
      <div>
        <input
          type="number"
          step="any"
          value={draft}
          disabled={disabled}
          aria-label={`${label} ${suffix === '°' ? 'rotation in degrees' : 'in LDraw units'}`}
          title={disabled ? `${label} is locked` : 'Enter to apply · Escape to cancel'}
          onChange={(event) => {
            dirty.current = true
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
