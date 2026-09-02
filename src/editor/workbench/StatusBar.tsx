import { CloudOff, EyeOff, Layers3, MousePointer2, Sparkles } from 'lucide-react'
import { LAYOUT_PRESETS, type LayoutPresetId } from './layout'
import { describeVisibility } from './selection'
import { Slot } from './ExtensionRegistry'
import { formatChord, type ShortcutMap } from './shortcuts'
import type { Workbench } from './useWorkbench'

type ModeSource = Pick<Workbench, 'tool' | 'placement' | 'connect'>
type EscapeSource = Pick<Workbench, 'tool' | 'placement' | 'connect' | 'state'>

/** What the next click means, in the same words the chrome used to keep on a dedicated strip. */
export function describeWorkbenchMode({ tool, placement, connect }: ModeSource): string {
  if (placement) return 'PLACING'
  if (tool === 'connect') return `CONNECT · ${connect.stage.toUpperCase()}`
  return tool.toUpperCase()
}

/** How to leave the current mode. Always a sentence that names Esc. */
export function describeWorkbenchEscape({ tool, placement, connect, state }: EscapeSource): string {
  if (placement) return 'Esc puts the part back'
  if (tool === 'connect' && connect.stage !== 'source') return 'Esc backs out one stage'
  if (state.proposals.length) return 'Esc rejects the ghost proposal'
  return 'Esc returns to Select'
}

/**
 * The status bar.
 *
 * The quieter shell hid this footer (`STATUSBAR_HEIGHT = 0`, `.statusbar { display:
 * none }`) so the model keeps the pixels. Mode, escape and layout-preset now live
 * on the toolbar island and the top bar. This full readout is kept for a future
 * density option; it is not mounted today.
 */
export function StatusBar({
  workbench,
  shortcuts,
  online,
  preset,
  onPreset,
}: {
  workbench: Workbench
  shortcuts: ShortcutMap
  online: boolean
  preset: LayoutPresetId | null
  onPreset: (preset: LayoutPresetId) => void
}) {
  const { state, tool, visibility } = workbench
  const visibilityNote = describeVisibility(visibility, state.validation.partCount)
  const mode = describeWorkbenchMode(workbench)
  const cancel = describeWorkbenchEscape(workbench)

  return (
    <footer className="statusbar" role="status" aria-live="polite">
      <span className="status-mode" data-mode={tool}>
        <MousePointer2 size={11} />
        <b>{mode}</b>
      </span>
      <span className="status-scope">
        {state.selection.length
          ? `${state.selection.length} part${state.selection.length === 1 ? '' : 's'} scoped`
          : 'No selection'}
      </span>
      <span className="status-hint">{workbench.viewportHint}</span>
      <span className="status-cancel">{cancel}</span>
      {visibilityNote && (
        <button
          type="button"
          className="status-visibility"
          onClick={() => workbench.showEverything()}
          title="Clear hide, isolate and ghost"
        >
          <EyeOff size={11} /> {visibilityNote} · {formatChord(shortcuts['visibility.show-all'])}
        </button>
      )}
      {workbench.renderMode !== 'beauty' && (
        <button
          type="button"
          className="status-rendermode"
          onClick={() => workbench.setRenderMode('beauty')}
          title="Back to the shaded viewport"
        >
          <Layers3 size={11} /> {workbench.renderMode}
        </button>
      )}
      {state.proposals.length > 0 && (
        <span className="status-proposal">
          <Sparkles size={11} /> {state.proposals.length} proposal{state.proposals.length === 1 ? '' : 's'} awaiting review
        </span>
      )}
      {!online && (
        <span className="status-offline" title="The browser reports no network. Editing, validation and export are all local and unaffected.">
          <CloudOff size={11} /> Offline — local editing unaffected
        </span>
      )}
      <Slot id="status" />
      <label className="status-preset">
        <span className="visually-hidden">Layout preset</span>
        <select
          value={preset ?? 'custom'}
          onChange={(event) => onPreset(event.target.value as LayoutPresetId)}
          aria-label="Layout preset"
          title="Dock sizes tuned for a screen shape"
        >
          {preset === null && <option value="custom">Custom layout</option>}
          {(Object.keys(LAYOUT_PRESETS) as LayoutPresetId[]).map((id) => (
            <option key={id} value={id}>{LAYOUT_PRESETS[id].label}</option>
          ))}
        </select>
      </label>
    </footer>
  )
}
