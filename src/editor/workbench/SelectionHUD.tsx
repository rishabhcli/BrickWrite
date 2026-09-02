import type { EditorTool } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import { WorkbenchIcon, type WorkbenchIconName } from './WorkbenchIcons'
import { NumberField } from './NumberField'
import type { AxisLocks } from './transform'

type Position = readonly [number, number, number]

type SelectionHUDProps = {
  count: number
  label: string
  position: Position
  locks: AxisLocks
  tool: EditorTool
  onTool: (tool: EditorTool) => void
  onFocus: () => void
  onGround: () => void
  onDuplicate: () => void
  onPosition: (axis: 0 | 1 | 2, value: number) => unknown
  onMore: (anchor: HTMLElement) => void
}

/** Direct manipulation controls that follow the selection, not a panel. */
export function SelectionHUD({
  count,
  label,
  position,
  locks,
  tool,
  onTool,
  onFocus,
  onGround,
  onDuplicate,
  onPosition,
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
    <GlassIsland className="selection-hud" radius="section" blur="control" role="toolbar" aria-label="Selection HUD">
      <button
        type="button"
        className="selection-hud-identity"
        aria-label={`More actions for ${label}`}
        title="More selection actions"
        onClick={(event) => onMore(event.currentTarget)}
      >
        <span className="selection-hud-count">{count}</span>
        <span className="selection-hud-name">{label}</span>
      </button>
      <div className="selection-hud-position" aria-label={`Position ${position.join(', ')} LDU`}>
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <NumberField
            key={axis}
            label={axis}
            value={position[index]}
            suffix="LDU"
            disabled={locks[axis.toLowerCase() as keyof AxisLocks]}
            onCommit={(value) => onPosition(index as 0 | 1 | 2, value)}
          />
        ))}
      </div>
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
