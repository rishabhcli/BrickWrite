import { CircleDot, ShieldCheck, Sparkles } from 'lucide-react'
import type { AutonomyMode, ColorDefinition } from '../../cad/types'

export function AutonomySwitch({ value, onChange }: { value: AutonomyMode; onChange: (mode: AutonomyMode) => void }) {
  return (
    <div className="autonomy-switch" aria-label="Codex autonomy mode">
      {(['inspect', 'propose', 'build'] as AutonomyMode[]).map((mode) => (
        <button key={mode} className={value === mode ? `active ${mode}` : ''} onClick={() => onChange(mode)}>
          {mode === 'inspect' && <CircleDot size={11} />}
          {mode === 'propose' && <Sparkles size={11} />}
          {mode === 'build' && <ShieldCheck size={11} />}
          {mode}
        </button>
      ))}
    </div>
  )
}

export function ColorLabel({ color }: { color: ColorDefinition }) {
  return <span className="color-label"><i style={{ background: color.hex }} />{color.name}</span>
}
