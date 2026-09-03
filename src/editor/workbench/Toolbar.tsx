import { ClipboardPaste, Redo2, Search, Undo2 } from 'lucide-react'
import { type ReactElement } from 'react'
import { GlassIsland } from '../../ui/liquid'
import { ExportCenter } from '../ExportCenter'
import { Slot } from './ExtensionRegistry'
import { formatChord, type ShortcutMap } from './shortcuts'
import { WorkbenchIcon } from './WorkbenchIcons'
import { describeWorkbenchEscape, describeWorkbenchMode } from './mode'
import type { Workbench } from './useWorkbench'

/**
 * The always-reachable tool shelf.
 *
 * Modelling modes at the left, the durable tools at the right, and nothing in
 * between that the model itself already answers. The seven selection buttons
 * that used to appear here on every click — reposition, duplicate, copy, cut,
 * quarter turn, protect, remove — were the fourth on-screen copy of actions the
 * right-click menu, the palette and a chord all already carried; the render
 * `select` was a sixth copy of four `view.*` commands.
 *
 * Nothing essential is hidden under a generic gear. The palette is not a gear:
 * it lists every command under the control's own accessible name with its live
 * chord, which is the same argument `layout.ts` already makes when it collapses
 * the right dock on a narrow window.
 */
export function Toolbar({
  workbench,
  shortcuts,
  onImport,
  timelineOpen,
  onToggleTimeline,
}: {
  workbench: Workbench
  shortcuts: ShortcutMap
  onImport: (file: File) => Promise<void>
  timelineOpen?: boolean
  onToggleTimeline?: () => void
}) {
  const { state, tool, setTool } = workbench
  const chord = (id: string) => formatChord(shortcuts[id])

  return (
    <GlassIsland className="toolbar-island">
      <nav className="toolrail toolrail-simple" aria-label="CAD tools">
        <div className="toolgroup primary-tools" role="radiogroup" aria-label="Active tool">
          <ToolButton
            active={tool === 'select'}
            icon={<WorkbenchIcon name="select" />}
            label="Select"
            shortcut={chord('tool.select')}
            onClick={() => setTool('select')}
          />
          <ToolButton
            active={tool === 'move'}
            icon={<WorkbenchIcon name="move" />}
            label="Move"
            shortcut={chord('tool.move')}
            onClick={() => setTool('move')}
          />
          <ToolButton
            active={tool === 'rotate'}
            icon={<WorkbenchIcon name="rotate" />}
            label="Rotate"
            shortcut={chord('tool.rotate')}
            onClick={() => setTool('rotate')}
          />
          <ToolButton
            active={tool === 'connect'}
            icon={<WorkbenchIcon name="connect" />}
            label="Connect"
            shortcut={chord('tool.connect')}
            onClick={() => setTool('connect')}
          />
        </div>
        <span className="tool-mode" data-mode={tool} data-testid="tool-mode" role="status">
          <b>{describeWorkbenchMode(workbench)}</b>
          <em>{describeWorkbenchEscape(workbench)}</em>
        </span>

        <div className="rail-spacer" />

        <div className="toolgroup compact-tools history-tools">
          <IconButton
            icon={<ClipboardPaste />}
            label="Paste parts"
            shortcut={chord('edit.paste')}
            disabled={!workbench.clipboard}
            disabledReason="Copy or cut parts in this editor first"
            onClick={() => workbench.pasteSelection()}
          />
          <IconButton
            icon={<Undo2 />}
            label={state.canUndo ? `Undo ${state.transactions.at(-1)?.label ?? ''}`.trim() : 'Undo'}
            shortcut={chord('edit.undo')}
            onClick={() => workbench.replayHistory('undo')}
            disabled={!state.canUndo}
            disabledReason="Nothing to undo"
          />
          <IconButton
            icon={<Redo2 />}
            label="Redo"
            shortcut={chord('edit.redo')}
            onClick={() => workbench.replayHistory('redo')}
            disabled={!state.canRedo}
            disabledReason="Nothing to redo"
          />
          <IconButton
            icon={<Search />}
            label="Command palette"
            shortcut={chord('project.command-palette')}
            onClick={() => workbench.setModal('core:command-palette')}
          />
        </div>

        <div className="rail-divider" />

        <div className="toolgroup compact-tools direct-tools" aria-label="Workspace tools">
          {onToggleTimeline && (
            <IconButton
              icon={<WorkbenchIcon name="timeline" />}
              label="Build timeline"
              active={timelineOpen}
              onClick={onToggleTimeline}
            />
          )}
          <IconButton
            icon={<WorkbenchIcon name="help" />}
            label="Keyboard shortcuts"
            shortcut={chord('help.shortcuts')}
            onClick={() => workbench.setModal('core:shortcuts')}
          />
          <Slot id="toolbar" />
          <ExportCenter state={state} onImport={onImport} onNotice={workbench.notify} />
        </div>
      </nav>
    </GlassIsland>
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
      type="button"
      className={`tool-button ${active ? 'active' : ''}`}
      onClick={onClick}
      role="radio"
      aria-label={label}
      aria-checked={active}
      aria-keyshortcuts={shortcut}
      title={`${label} (${shortcut})`}
    >
      {icon}
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
  const title =
    disabled && disabledReason ? `${label} — ${disabledReason}` : shortcut ? `${label} (${shortcut})` : label
  return (
    <button
      type="button"
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
