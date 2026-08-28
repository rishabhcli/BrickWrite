import {
  BringToFront,
  CircleHelp,
  Command,
  Copy,
  Eye,
  Focus,
  Grid3X3,
  Layers3,
  Link2,
  Lock,
  Maximize2,
  MousePointer2,
  Move3d,
  Redo2,
  Rotate3d,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { ReactElement } from 'react'
import { cadEngine } from '../../cad/engine'
import type { CameraView, EditorTool, RenderMode } from '../CadViewport'
import { ExportCenter } from '../ExportCenter'
import { Slot } from './ExtensionRegistry'
import { formatChord, type ShortcutMap } from './shortcuts'
import type { Workbench } from './useWorkbench'

/**
 * The tool rail.
 *
 * Every control states its mode, its shortcut and — when it is unavailable —
 * why. A greyed button that does not say what would make it live again is a
 * dead end, and there are a lot of buttons here.
 */
export function Toolbar({
  workbench,
  shortcuts,
  onImport,
}: {
  workbench: Workbench
  shortcuts: ShortcutMap
  onImport: (file: File) => Promise<void>
}) {
  const { state, tool, setTool } = workbench
  const selected = state.selection.length
  const chord = (id: string) => formatChord(shortcuts[id])

  return (
    <nav className="toolrail" aria-label="CAD tools">
      <div className="toolgroup primary-tools" role="radiogroup" aria-label="Active tool">
        <ToolButton active={tool === 'select'} icon={<MousePointer2 />} label="Select" shortcut={chord('tool.select')} onClick={() => setTool('select')} />
        <ToolButton active={tool === 'move'} icon={<Move3d />} label="Move" shortcut={chord('tool.move')} onClick={() => setTool('move')} />
        <ToolButton active={tool === 'rotate'} icon={<Rotate3d />} label="Rotate" shortcut={chord('tool.rotate')} onClick={() => setTool('rotate')} />
        <ToolButton active={tool === 'connect'} icon={<Link2 />} label="Connect" shortcut={chord('tool.connect')} onClick={() => setTool('connect')} />
      </div>
      <div className="rail-divider" />
      <div className="toolgroup compact-tools">
        <IconButton
          icon={<Copy />}
          label="Duplicate selection"
          shortcut={chord('edit.clone')}
          onClick={() => workbench.duplicateSelection()}
          disabled={!selected}
          disabledReason="Select at least one part first"
        />
        <IconButton
          icon={<Rotate3d />}
          label="Quarter turn"
          shortcut={chord('edit.quarter-turn')}
          onClick={() => workbench.rotateSelection(90)}
          disabled={!selected}
          disabledReason="Select at least one part first"
        />
        <IconButton
          icon={<Lock />}
          label="Protect selection from agent edits"
          shortcut={chord('edit.protect')}
          onClick={() => workbench.protectSelection(true)}
          disabled={!selected}
          disabledReason="Select at least one part first"
        />
        <IconButton
          icon={<Trash2 />}
          label="Remove selection"
          shortcut={chord('edit.delete')}
          onClick={() => workbench.deleteSelection()}
          disabled={!selected}
          disabledReason="Select at least one part first"
        />
      </div>
      <div className="rail-divider" />
      <label className="grid-picker">
        <Grid3X3 size={14} />
        <span>SNAP</span>
        <select value={workbench.gridLdu} onChange={(event) => workbench.setGridLdu(Number(event.target.value))} aria-label="Grid snap increment">
          <option value={20}>Stud grid</option>
          <option value={10}>Half-stud</option>
          <option value={1}>Fine LDU</option>
        </select>
      </label>
      <div className="rail-spacer" />
      <Slot id="toolbar" />
      <div className="toolgroup camera-tools" role="group" aria-label="Camera view">
        <IconButton icon={<Eye />} label="Isometric view" shortcut={chord('view.iso')} active={workbench.cameraView === 'isometric'} onClick={() => workbench.setCameraView('isometric')} />
        <IconButton icon={<BringToFront />} label="Front view" shortcut={chord('view.front')} active={workbench.cameraView === 'front'} onClick={() => workbench.setCameraView('front')} />
        <IconButton icon={<Maximize2 />} label="Top view" shortcut={chord('view.top')} active={workbench.cameraView === 'top'} onClick={() => workbench.setCameraView('top')} />
        <IconButton icon={<Focus />} label="Fit model to view" shortcut={chord('view.fit')} onClick={workbench.fitView} />
      </div>
      <label className="render-picker">
        <Layers3 size={14} />
        <span>VIEW</span>
        <select
          value={workbench.renderMode}
          onChange={(event) => workbench.setRenderMode(event.target.value as RenderMode)}
          aria-label="Viewport render mode"
        >
          <option value="beauty">Beauty</option>
          <option value="orthographic">Orthographic</option>
          <option value="connections">Connections</option>
          <option value="violations">Violations</option>
          <option value="silhouette">Silhouette</option>
          <option value="exploded">Exploded</option>
        </select>
      </label>
      <div className="rail-divider" />
      <div className="toolgroup compact-tools">
        <IconButton
          icon={<Undo2 />}
          label={state.canUndo ? `Undo ${state.transactions.at(-1)?.label ?? ''}`.trim() : 'Undo'}
          shortcut={chord('edit.undo')}
          onClick={() => cadEngine.undo('human')}
          disabled={!state.canUndo}
          disabledReason="Nothing to undo"
        />
        <IconButton
          icon={<Redo2 />}
          label="Redo"
          shortcut={chord('edit.redo')}
          onClick={() => cadEngine.redo('human')}
          disabled={!state.canRedo}
          disabledReason="Nothing to redo"
        />
        <IconButton
          icon={<Command />}
          label="Command deck"
          shortcut={chord('project.command-deck')}
          onClick={() => workbench.setModal('core:command-deck')}
        />
        <IconButton
          icon={<CircleHelp />}
          label="Keyboard shortcuts"
          shortcut={chord('help.shortcuts')}
          onClick={() => workbench.setModal('core:shortcuts')}
        />
      </div>
      <ExportCenter state={state} onImport={onImport} onNotice={workbench.notify} />
    </nav>
  )
}

function ToolButton({
  icon,
  label,
  shortcut,
  active,
  onClick,
}: {
  icon: ReactElement
  label: string
  shortcut: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`tool-button ${active ? 'active' : ''}`}
      onClick={onClick}
      role="radio"
      aria-checked={active}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      title={`${label} (${shortcut})`}
    >
      {icon}
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  )
}

function IconButton({
  icon,
  label,
  onClick,
  disabled,
  disabledReason,
  shortcut,
  active,
}: {
  icon: ReactElement
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  shortcut?: string
  active?: boolean
}) {
  const title = disabled && disabledReason
    ? `${label} — ${disabledReason}`
    : shortcut
      ? `${label} (${shortcut})`
      : label
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      aria-disabled={disabled}
      title={title}
    >
      {icon}
    </button>
  )
}
