import type { EditorTool } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import { WorkbenchIcon, type WorkbenchIconName } from './WorkbenchIcons'

type Position = readonly [number, number, number]

type SelectionHUDProps = {
  count: number
  label: string
  position: Position
  tool: EditorTool
  onTool: (tool: EditorTool) => void
  onFocus: () => void
  onGround: () => void
  onDuplicate: () => void
  onMore: (anchor: HTMLElement) => void
}

const readable = (value: number) => {
  const rounded = Math.abs(value) < 0.05 ? 0 : Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Direct manipulation controls that follow the selection, not a panel. */
export function SelectionHUD({
  count,
  label,
  position,
  tool,
  onTool,
  onFocus,
  onGround,
  onDuplicate,
  onMore,
}: SelectionHUDProps) {
  const action = (labelText: string, icon: WorkbenchIconName, onClick: () => void, pressed?: boolean) => (
    <button
      type="button"
      className="selection-hud-action"
      aria-label={labelText}
      aria-pressed={pressed}
      title={labelText}
      onClick={onClick}
    >
      <WorkbenchIcon name={icon} size={16} />
    </button>
  )

  return (
    <GlassIsland className="selection-hud" radius="section" blur="control">
      <button
        type="button"
        className="selection-hud-identity"
        aria-label="Selection actions"
        title="More selection actions"
        onClick={(event) => onMore(event.currentTarget)}
      >
        <span className="selection-hud-count">{count}</span>
        <span className="selection-hud-name">{label}</span>
        <span className="selection-hud-position" aria-label={`Position ${position.join(', ')} LDU`}>
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <i key={axis} data-axis={axis.toLowerCase()}>
              {axis}
              <b>{readable(position[index])}</b>
            </i>
          ))}
        </span>
      </button>
      <span className="selection-hud-divider" />
      <div className="selection-hud-tools" role="toolbar" aria-label="Selection tools">
        {action('Move selection', 'move', () => onTool('move'), tool === 'move')}
        {action('Rotate selection', 'rotate', () => onTool('rotate'), tool === 'rotate')}
        {action('Mate selection', 'connect', () => onTool('connect'), tool === 'connect')}
        {action('Focus selection', 'focus', onFocus)}
        {action('Ground selection', 'ground', onGround)}
        {action('Duplicate selection', 'duplicate', onDuplicate)}
      </div>
    </GlassIsland>
  )
}
