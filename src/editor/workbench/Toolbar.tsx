import {
  Copy,
  CopyPlus,
  ClipboardPaste,
  Scissors,
  Lock,
  Hand,
  Redo2,
  Rotate3d,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react'
import { type ReactElement } from 'react'
import { GlassIsland } from '../../ui/liquid'
import type { RenderMode } from '../CadViewport'
import { ExportCenter } from '../ExportCenter'
import { Slot } from './ExtensionRegistry'
import { formatChord, type ShortcutMap } from './shortcuts'
import { WorkbenchIcon } from './WorkbenchIcons'
import { describeWorkbenchEscape, describeWorkbenchMode } from './StatusBar'
import type { Workbench } from './useWorkbench'

/**
 * The always-reachable tool shelf.
 *
 * Modelling modes stay at the left, contextual actions appear only when they can
 * do something, and the durable tools stay at the right. Nothing essential is
 * hidden under a generic gear: render, build order, command tools, help and
 * delivery each have a first-class control with an honest accessible name.
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
  const selected = state.selection.length
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

        {selected > 0 && (
          <>
            <div className="rail-divider" />
            <div className="toolgroup compact-tools selection-tools" aria-label={`${selected} selected`}>
              <span className="selection-tool-count">{selected}</span>
              {/* First, because moving the thing you just selected is the most
               * common next action — and until now the only always-visible
               * control named after it was the Move *tool*, which arms a
               * translate gizmo rather than picking the part up. Someone
               * hunting for how to move a brick found that button, dragged,
               * got nothing, and concluded the editor could not do it. */}
              <IconButton
                icon={<Hand />}
                label="Reposition"
                shortcut={chord('edit.reposition')}
                disabled={selected !== 1}
                disabledReason="select one part"
                onClick={() => workbench.pickUpSelection()}
              />
              <IconButton
                icon={<CopyPlus />}
                label="Duplicate selection"
                shortcut={chord('edit.clone')}
                onClick={() => workbench.duplicateSelection()}
              />
              <IconButton
                icon={<Copy />}
                label="Copy parts"
                shortcut={chord('edit.copy')}
                onClick={() => workbench.copySelection()}
              />
              <IconButton
                icon={<Scissors />}
                label="Cut parts"
                shortcut={chord('edit.cut')}
                onClick={() => workbench.copySelection(true)}
              />
              <IconButton
                icon={<Rotate3d />}
                label="Quarter turn"
                shortcut={chord('edit.quarter-turn')}
                onClick={() => workbench.rotateSelection(90)}
              />
              <IconButton
                icon={<Lock />}
                label="Protect selection from agent edits"
                shortcut={chord('edit.protect')}
                onClick={() => workbench.protectSelection(true)}
              />
              <IconButton
                icon={<Trash2 />}
                label="Remove selection"
                shortcut={chord('edit.delete')}
                onClick={() => workbench.deleteSelection()}
              />
            </div>
          </>
        )}

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
          <label className="render-direct" title={`Render mode: ${workbench.renderMode}`}>
            <WorkbenchIcon name="render" size={16} />
            <span className="visually-hidden">Viewport render mode</span>
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
          {onToggleTimeline && (
            <IconButton
              icon={<WorkbenchIcon name="timeline" />}
              label="Build timeline"
              active={timelineOpen}
              onClick={onToggleTimeline}
            />
          )}
          <IconButton
            icon={<WorkbenchIcon name="commands" />}
            label="Command deck"
            shortcut={chord('project.command-deck')}
            onClick={() => workbench.setModal('core:command-deck')}
          />
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
