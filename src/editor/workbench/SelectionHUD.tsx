import { MoreHorizontal } from 'lucide-react'
import type { EditorTool } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import { WorkbenchIcon, type WorkbenchIconName } from './WorkbenchIcons'
import { NumberField } from './NumberField'
import type { AxisLocks, ReferenceFrame } from './transform'

type Position = readonly [number, number, number]

type SelectionHUDProps = {
  count: number
  label: string
  position: Position
  rotation?: Position | null
  rotationMixed?: boolean
  locks: AxisLocks
  frame: ReferenceFrame
  tool: EditorTool
  onTool: (tool: EditorTool) => void
  onFocus: () => void
  onGround: () => void
  onDuplicate: () => void
  onPosition: (axis: 0 | 1 | 2, value: number) => unknown
  onRotate?: (axis: 0 | 1 | 2, value: number) => unknown
  onMore: (anchor: HTMLElement) => void
}

/** Direct manipulation controls that follow the selection, not a panel. */
export function SelectionHUD({
  count,
  label,
  position,
  rotation,
  rotationMixed = false,
  locks,
  frame,
  tool,
  onTool,
  onFocus,
  onGround,
  onDuplicate,
  onPosition,
  onRotate,
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
      <div className="selection-hud-identity" aria-label={label}>
        <span className="selection-hud-count">{count}</span>
        <span className="selection-hud-name">{label}</span>
      </div>
      <button
        type="button"
        className="selection-hud-more"
        aria-label={`More actions for ${label}`}
        title="More selection actions"
        onClick={(event) => onMore(event.currentTarget)}
      >
        <MoreHorizontal size={14} />
      </button>
      <div
        className="selection-hud-position"
        data-position-frame="world"
        aria-label={`World position ${position.join(', ')} LDU`}
      >
        <span className="selection-hud-frame" title="Typed values are world LDU, even when the gizmo is local">
          WORLD
        </span>
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <NumberField
            key={axis}
            compact
            label={axis}
            value={position[index]}
            suffix="LDU"
            disabled={frame === 'world' && locks[axis.toLowerCase() as keyof AxisLocks]}
            onCommit={(value) => onPosition(index as 0 | 1 | 2, value)}
          />
        ))}
      </div>
      {rotationMixed ? (
        <div className="selection-hud-rotation" data-mixed="true" aria-label="Mixed orientations">
          {(['RX', 'RY', 'RZ'] as const).map((axis) => (
            <label key={axis} className="number-field compact disabled mixed-euler">
              <span>{axis}</span>
              <div>
                <input disabled value="" placeholder="MIXED" aria-label={`${axis} mixed orientations`} />
                <em>°</em>
              </div>
            </label>
          ))}
        </div>
      ) : rotation && onRotate ? (
        <div className="selection-hud-rotation" aria-label={`Rotation ${rotation.join(', ')} degrees`}>
          {(['RX', 'RY', 'RZ'] as const).map((axis, index) => (
            <NumberField
              key={axis}
              compact
              label={axis}
              value={rotation[index]}
              suffix="°"
              disabled={locks[(['x', 'y', 'z'] as const)[index]]}
              onCommit={(value) => onRotate(index as 0 | 1 | 2, value)}
            />
          ))}
        </div>
      ) : null}
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
