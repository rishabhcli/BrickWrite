import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { getColor } from '../cad/catalog'
import type { DesignBrief } from '../platform/contracts'
import type { ConflictChoice } from './session'
import './panel.css'

/**
 * The brief, as fields rather than as a paragraph.
 *
 * A compiled brief is a set of decisions the operator is accountable for, so
 * every one of them is editable here and every one shows the phrase it was read
 * from. `amendBrief` records the edit in the same evidence map, so a field the
 * operator changed says so instead of continuing to cite a sentence that no
 * longer describes it.
 *
 * Contradictions are the part that must not be quietly decided. The compiler
 * records what it did — "the request says both micro and minifig scale; micro
 * was recorded" — and this surface turns each one into an explicit choice that
 * blocks generation until it is made.
 */

const SCALES: DesignBrief['scale'][] = ['micro', 'minifig', 'midi', 'large', 'unspecified']
const SYMMETRIES: DesignBrief['symmetry'][] = ['none', 'mirror-x', 'mirror-z', 'radial']

export function BriefEditor({
  brief,
  method,
  modelId,
  notes,
  choices,
  disabled,
  onEdit,
  onResolve,
}: {
  brief: DesignBrief
  method: 'model' | 'deterministic'
  modelId: string | null
  notes: readonly string[]
  choices: Readonly<Record<string, ConflictChoice>>
  disabled: boolean
  onEdit: (patch: Partial<DesignBrief>, reason: string) => void
  onResolve: (field: string, choice: ConflictChoice) => void
}) {
  const envelope = brief.envelopeStuds
  return (
    <div className="bw-gen__brief">
      <div className="bw-gen__brief-head">
        <strong>{brief.subject || 'Untitled build'}</strong>
        <span className="bw-gen__provenance" data-method={method}>
          {method === 'model' ? `compiled by ${modelId ?? 'the model'}` : 'compiled from rules'}
        </span>
      </div>

      {notes.map((note) => (
        <p className="bw-gen__hint" key={note}>
          {note}
        </p>
      ))}

      {brief.conflicts.map((conflict) => {
        const choice = choices[conflict.field]
        return (
          <fieldset className="bw-gen__conflict" key={conflict.field} data-resolved={Boolean(choice)}>
            <legend>
              {choice ? 'Resolved' : 'Decide'} · {conflict.field}
            </legend>
            <p>{conflict.detail}</p>
            <label className="bw-gen__choice">
              <input
                type="radio"
                name={`bw-gen-conflict-${conflict.field}`}
                checked={choice === 'compiler'}
                onChange={() => onResolve(conflict.field, 'compiler')}
                disabled={disabled}
              />
              <span>Keep the reading above.</span>
            </label>
            <label className="bw-gen__choice">
              <input
                type="radio"
                name={`bw-gen-conflict-${conflict.field}`}
                checked={choice === 'operator'}
                onChange={() => onResolve(conflict.field, 'operator')}
                disabled={disabled}
              />
              <span>I have set {conflict.field} myself below.</span>
            </label>
          </fieldset>
        )
      })}

      <Field label="Subject" evidence={brief.evidence.subject}>
        <input
          type="text"
          value={brief.subject}
          aria-label="Subject"
          disabled={disabled}
          onChange={(event) => onEdit({ subject: event.target.value }, 'subject rewritten')}
        />
      </Field>

      <fieldset className="bw-gen__field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="bw-gen__legend">Envelope (studs)</legend>
        <div className="bw-gen__triple">
          {(['width', 'height', 'depth'] as const).map((axis, index) => (
            <input
              key={axis}
              type="number"
              min={1}
              aria-label={`Envelope ${axis} in studs`}
              value={envelope ? envelope[index] : ''}
              placeholder="—"
              disabled={disabled}
              onChange={(event) => {
                const next: [number, number, number] = envelope ? [...envelope] : [12, 8, 10]
                next[index] = Math.max(1, Number(event.target.value) || 1)
                onEdit({ envelopeStuds: next }, `envelope ${axis} set to ${next[index]}`)
              }}
            />
          ))}
        </div>
        <label className="bw-gen__choice">
          <input
            type="checkbox"
            checked={envelope === null}
            disabled={disabled}
            onChange={(event) =>
              onEdit(
                { envelopeStuds: event.target.checked ? null : [12, 8, 10] },
                event.target.checked ? 'envelope left to the generator' : 'envelope stated',
              )
            }
          />
          <span>Let the generator choose the envelope</span>
        </label>
        {brief.evidence.envelopeStuds && <p className="bw-gen__evidence">“{brief.evidence.envelopeStuds}”</p>}
      </fieldset>

      <Field label="Scale" evidence={brief.evidence.scale}>
        <select
          value={brief.scale}
          aria-label="Scale"
          disabled={disabled}
          onChange={(event) => onEdit({ scale: event.target.value as DesignBrief['scale'] }, 'scale chosen')}
        >
          {SCALES.map((scale) => (
            <option key={scale} value={scale}>
              {scale}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Symmetry" evidence={brief.evidence.symmetry}>
        <select
          value={brief.symmetry}
          aria-label="Symmetry"
          disabled={disabled}
          onChange={(event) => onEdit({ symmetry: event.target.value as DesignBrief['symmetry'] }, 'symmetry chosen')}
        >
          {SYMMETRIES.map((symmetry) => (
            <option key={symmetry} value={symmetry}>
              {symmetry}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Part budget" evidence={brief.evidence.partBudget}>
        <input
          type="number"
          min={1}
          aria-label="Part budget"
          value={brief.partBudget ?? ''}
          placeholder="unbounded"
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value.trim()
            onEdit(
              { partBudget: raw === '' ? null : Math.max(1, Number(raw) || 1) },
              raw === '' ? 'budget removed' : `budget set to ${raw}`,
            )
          }}
        />
      </Field>

      <ChipField
        label="Functions"
        values={brief.functions}
        evidence={brief.evidence.functions}
        placeholder="roof lifts off"
        disabled={disabled}
        onChange={(functions) => onEdit({ functions }, 'functions edited')}
      />

      <PaletteField
        palette={brief.palette}
        evidence={brief.evidence.palette}
        disabled={disabled}
        onChange={(palette) => onEdit({ palette }, 'palette edited')}
      />

      <ChipField
        label="Style"
        values={brief.style}
        evidence={brief.evidence.style}
        placeholder="brutalist"
        disabled={disabled}
        onChange={(style) => onEdit({ style }, 'style edited')}
      />
    </div>
  )
}

function Field({
  label,
  evidence,
  children,
}: {
  label: string
  evidence?: string
  children: ReactNode
}) {
  return (
    <label className="bw-gen__field">
      <span>{label}</span>
      {children}
      {evidence && <span className="bw-gen__evidence">“{evidence}”</span>}
    </label>
  )
}

function ChipField({
  label,
  values,
  evidence,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  values: readonly string[]
  evidence?: string
  placeholder: string
  disabled: boolean
  onChange: (values: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const value = draft.trim()
    if (!value || values.includes(value)) return
    onChange([...values, value])
    setDraft('')
  }
  return (
    <fieldset className="bw-gen__field" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="bw-gen__legend">{label}</legend>
      <div className="bw-gen__chips">
        {values.length === 0 && <span className="bw-gen__hint">None stated.</span>}
        {values.map((value) => (
          <span className="bw-gen__chip" key={value}>
            {value}
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()} ${value}`}
              disabled={disabled}
              onClick={() => onChange(values.filter((entry) => entry !== value))}
            >
              <X size={9} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="bw-gen__actions">
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          aria-label={`Add ${label.toLowerCase()}`}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add()
          }}
        />
        <button
          type="button"
          className="bw-gen__btn"
          onClick={add}
          disabled={disabled || !draft.trim()}
          aria-label={`Add ${label.toLowerCase()} entry`}
        >
          <Plus size={10} aria-hidden="true" />
        </button>
      </div>
      {evidence && <span className="bw-gen__evidence">“{evidence}”</span>}
    </fieldset>
  )
}

function PaletteField({
  palette,
  evidence,
  disabled,
  onChange,
}: {
  palette: readonly number[]
  evidence?: string
  disabled: boolean
  onChange: (palette: number[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const code = Number(draft.trim())
    if (!Number.isInteger(code) || palette.includes(code)) return
    onChange([...palette, code])
    setDraft('')
  }
  return (
    <fieldset className="bw-gen__field" style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="bw-gen__legend">Palette</legend>
      <div className="bw-gen__chips">
        {palette.length === 0 && <span className="bw-gen__hint">Any colour. The generator is unconstrained.</span>}
        {palette.map((code) => {
          const colour = getColor(code)
          return (
            <span className="bw-gen__chip" key={code}>
              <i className="bw-gen__swatch" style={{ background: colour.hex }} aria-hidden="true" />
              {colour.name} ({code})
              <button
                type="button"
                aria-label={`Remove ${colour.name} from the palette`}
                disabled={disabled}
                onClick={() => onChange(palette.filter((entry) => entry !== code))}
              >
                <X size={9} aria-hidden="true" />
              </button>
            </span>
          )
        })}
      </div>
      <div className="bw-gen__actions">
        <input
          type="number"
          value={draft}
          placeholder="LDraw code"
          aria-label="Add an LDraw colour code to the palette"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            add()
          }}
        />
        <button
          type="button"
          className="bw-gen__btn"
          onClick={add}
          disabled={disabled || !draft.trim()}
          aria-label="Add palette colour"
        >
          <Plus size={10} aria-hidden="true" />
        </button>
      </div>
      {evidence && <span className="bw-gen__evidence">“{evidence}”</span>}
    </fieldset>
  )
}
