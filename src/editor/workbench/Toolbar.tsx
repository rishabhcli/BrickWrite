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
  Search,
  Settings2,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { cadEngine } from '../../cad/engine'
import type { RenderMode } from '../CadViewport'
import { ExportCenter } from '../ExportCenter'
import { Slot } from './ExtensionRegistry'
import { formatChord, type ShortcutMap } from './shortcuts'
import type { Workbench } from './useWorkbench'

/**
 * The deliberately small tool rail.
 *
 * The previous version placed every possible action in one permanent row. That
 * made first use feel like learning a cockpit and left most controls disabled.
 * The rail now shows the four modelling modes, selection actions only when a
 * selection exists, and the three universal history/search controls. Camera,
 * snap, render, delivery and help live together behind Workspace.
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const menuRoot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!workspaceOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setWorkspaceOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', escape)
    }
  }, [workspaceOpen])

  return (
    <nav className="toolrail toolrail-simple" aria-label="CAD tools">
      <div className="toolgroup primary-tools" role="radiogroup" aria-label="Active tool">
        <ToolButton
          active={tool === 'select'}
          icon={<MousePointer2 />}
          label="Select"
          shortcut={chord('tool.select')}
          onClick={() => setTool('select')}
        />
        <ToolButton
          active={tool === 'move'}
          icon={<Move3d />}
          label="Move"
          shortcut={chord('tool.move')}
          onClick={() => setTool('move')}
        />
        <ToolButton
          active={tool === 'rotate'}
          icon={<Rotate3d />}
          label="Rotate"
          shortcut={chord('tool.rotate')}
          onClick={() => setTool('rotate')}
        />
        <ToolButton
          active={tool === 'connect'}
          icon={<Link2 />}
          label="Connect"
          shortcut={chord('tool.connect')}
          onClick={() => setTool('connect')}
        />
      </div>

      {selected > 0 && (
        <>
          <div className="rail-divider" />
          <div className="toolgroup compact-tools selection-tools" aria-label={`${selected} selected`}>
            <span className="selection-tool-count">{selected}</span>
            <IconButton
              icon={<Copy />}
              label="Duplicate selection"
              shortcut={chord('edit.clone')}
              onClick={() => workbench.duplicateSelection()}
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
          icon={<Search />}
          label="Command palette"
          shortcut={chord('project.command-palette')}
          onClick={() => workbench.setModal('core:command-palette')}
        />
      </div>

      <div className="workspace-menu" ref={menuRoot}>
        <button
          type="button"
          className={`workspace-trigger ${workspaceOpen ? 'active' : ''}`}
          aria-expanded={workspaceOpen}
          aria-haspopup="dialog"
          onClick={() => setWorkspaceOpen((open) => !open)}
        >
          <Settings2 size={15} />
          <span>Workspace</span>
        </button>

        {workspaceOpen && (
          <div className="workspace-popover" role="dialog" aria-label="Workspace actions">
            <header>
              <div>
                <span className="eyebrow">WORKSPACE</span>
                <strong>View and delivery</strong>
              </div>
              <kbd>{chord('project.command-palette')}</kbd>
            </header>

            <section>
              <span className="workspace-label">Snap</span>
              <label className="workspace-select">
                <Grid3X3 size={14} />
                <select
                  value={workbench.gridLdu}
                  onChange={(event) => workbench.setGridLdu(Number(event.target.value))}
                  aria-label="Grid snap increment"
                >
                  <option value={20}>Stud grid</option>
                  <option value={10}>Half-stud</option>
                  <option value={1}>Fine LDU</option>
                </select>
              </label>
            </section>

            <section>
              <span className="workspace-label">Camera</span>
              <div className="workspace-action-grid">
                <MenuButton
                  icon={<Eye />}
                  label="Isometric"
                  active={workbench.cameraView === 'isometric'}
                  onClick={() => workbench.setCameraView('isometric')}
                />
                <MenuButton
                  icon={<BringToFront />}
                  label="Front"
                  active={workbench.cameraView === 'front'}
                  onClick={() => workbench.setCameraView('front')}
                />
                <MenuButton
                  icon={<Maximize2 />}
                  label="Top"
                  active={workbench.cameraView === 'top'}
                  onClick={() => workbench.setCameraView('top')}
                />
                <MenuButton icon={<Focus />} label="Fit" onClick={workbench.fitView} />
              </div>
            </section>

            <section>
              <span className="workspace-label">Render</span>
              <label className="workspace-select">
                <Layers3 size={14} />
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
            </section>

            <section>
              <span className="workspace-label">More</span>
              <div className="workspace-list">
                <MenuButton
                  icon={<Command />}
                  label="Command deck"
                  detail={chord('project.command-deck')}
                  onClick={() => {
                    setWorkspaceOpen(false)
                    workbench.setModal('core:command-deck')
                  }}
                />
                <MenuButton
                  icon={<CircleHelp />}
                  label="Keyboard shortcuts"
                  detail={chord('help.shortcuts')}
                  onClick={() => {
                    setWorkspaceOpen(false)
                    workbench.setModal('core:shortcuts')
                  }}
                />
              </div>
              <Slot id="toolbar" />
            </section>

            <footer>
              <ExportCenter state={state} onImport={onImport} onNotice={workbench.notify} />
            </footer>
          </div>
        )}
      </div>
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
  const title =
    disabled && disabledReason ? `${label} — ${disabledReason}` : shortcut ? `${label} (${shortcut})` : label
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

function MenuButton({
  icon,
  label,
  detail,
  active,
  onClick,
}: {
  icon: ReactElement
  label: string
  detail?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`workspace-action ${active ? 'active' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
      {detail ? <kbd>{detail}</kbd> : null}
    </button>
  )
}
