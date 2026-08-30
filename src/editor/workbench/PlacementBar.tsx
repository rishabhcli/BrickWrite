import { Check, RotateCcw, RotateCw, X } from 'lucide-react'
import type { ResolvedPlacement } from '../../cad/placement'
import type { Workbench } from './useWorkbench'

export const placementMessage = (preview: ResolvedPlacement | null) => {
  if (!preview) return 'Point at a surface to preview the landing'
  switch (preview.reason) {
    case 'mated':
      return 'Snapped to connectors · click to place'
    case 'ground':
      return 'On the ground · click to place'
    case 'collision':
      return 'Blocked by another part · try a clear spot'
    case 'occupied':
      return 'Connectors occupied · try a free stud'
    default:
      return 'No clutch on this face · try studs or the ground'
  }
}

export function PlacementBar({ workbench: w, preview }: { workbench: Workbench; preview: ResolvedPlacement | null }) {
  if (!w.placement || !w.placementDefinition) return null
  const moving = Boolean(w.placement.movingPartId)
  return (
    <div
      className="placement-bar"
      data-legal={preview ? String(preview.legal) : 'pending'}
      aria-label="Placement controls"
    >
      <div className="placement-bar-heading">
        <span className="placement-state-dot" />
        <div>
          <small>{moving ? 'REPOSITIONING' : 'BUILDING'}</small>
          <strong>{w.placementDefinition.name}</strong>
        </div>
        <button aria-label="Cancel placement" title="Cancel (Esc)" onClick={w.cancelPlacement}>
          <X size={15} />
        </button>
      </div>
      <p className="placement-feedback" role="status">
        {placementMessage(preview)}
      </p>
      <div className="placement-bar-actions">
        <div className="placement-turns" role="group" aria-label="Placement rotation">
          <button
            aria-label="Rotate placement counterclockwise"
            title="Turn back (Shift+R)"
            onClick={() => w.rotatePlacement(-1)}
          >
            <RotateCcw size={14} />
          </button>
          <output aria-label="Placement angle">{(((w.placement.quarterTurns % 4) + 4) % 4) * 90}°</output>
          <button aria-label="Rotate placement clockwise" title="Turn (R)" onClick={() => w.rotatePlacement(1)}>
            <RotateCw size={14} />
          </button>
        </div>
        {!moving && (
          <label className="placement-repeat">
            <input
              type="checkbox"
              checked={w.repeatPlacement}
              onChange={(e) => w.setRepeatPlacement(e.target.checked)}
            />
            Keep building
          </label>
        )}
        <button className="placement-done" onClick={w.cancelPlacement}>
          <Check size={13} />
          {moving ? 'Put back' : 'Done'}
        </button>
      </div>
      {preview && (
        <output className="placement-coordinates" aria-label="Placement coordinates">
          {preview.transform.position
            .map((value, i) => `${['X', 'Y', 'Z'][i]} ${Math.round(value * 100) / 100}`)
            .join('   ·   ')}{' '}
          LDU
        </output>
      )}
    </div>
  )
}
