import { MoreHorizontal } from 'lucide-react'
import { GlassIsland } from '../../ui/liquid'
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
  onPosition,
  onRotate,
  onMore,
}: SelectionHUDProps) {
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
    </GlassIsland>
  )
}
