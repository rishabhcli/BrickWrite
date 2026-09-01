import { Check, CircleAlert, Repeat2, RotateCcw, RotateCw, X } from 'lucide-react'
import type { ResolvedPlacement } from '../../cad/placement'
import { GlassIsland } from '../../ui/liquid'
import type { Workbench } from './useWorkbench'

export const placementMessage = (preview: ResolvedPlacement | null) => {
  if (!preview) return 'Choose a spot'
  switch (preview.reason) {
    case 'mated': return 'Snapped'
    case 'ground': return 'Ready to place'
    case 'collision': return 'Blocked — choose a clear spot'
    case 'occupied': return 'Studs occupied'
    default: return 'No connection on this face'
  }
}

export function PlacementBar({ workbench: w, preview }: { workbench: Workbench; preview: ResolvedPlacement | null }) {
  if (!w.placement || !w.placementDefinition) return null
  const message = placementMessage(preview)
  // The bar is icon-only on purpose, and the ghost under the cursor shows the
  // shape — but "what am I about to place" was reaching nobody who cannot see
  // it. Arming from the keyboard announced a placement state with no subject
  // at all. The name goes into the status element's accessible text and its
  // tooltip, where it costs no visible chrome.
  const announced = `${w.placementDefinition.name}: ${message}`
  return (
    <GlassIsland
      className="placement-bar"
      data-legal={preview ? String(preview.legal) : 'pending'}
      role="toolbar"
      aria-label="Placement controls"
    >
      <span className="placement-feedback" role="status" aria-label={announced} title={announced}>
        {preview && !preview.legal ? <CircleAlert size={16} /> : <Check size={16} />}
        <span className="visually-hidden">{announced}</span>
      </span>
      <button aria-label="Rotate placement counterclockwise" title="Rotate left (Shift+R)" onClick={() => w.rotatePlacement(-1)}>
        <RotateCcw size={16} />
      </button>
      <output className="visually-hidden" aria-label="Placement angle">{(((w.placement.quarterTurns % 4) + 4) % 4) * 90}°</output>
      <button aria-label="Rotate placement clockwise" title="Rotate right (R)" onClick={() => w.rotatePlacement(1)}>
        <RotateCw size={16} />
      </button>
      {!w.placement.movingPartId && (
        <button aria-label="Keep building" title="Repeat placement" aria-pressed={w.repeatPlacement} onClick={() => w.setRepeatPlacement(!w.repeatPlacement)}>
          <Repeat2 size={16} />
        </button>
      )}
      <button aria-label="Cancel placement" title="Cancel placement (Esc)" onClick={w.cancelPlacement}>
        <X size={16} />
      </button>
    </GlassIsland>
  )
}
