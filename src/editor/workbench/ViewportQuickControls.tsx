import { Focus, Magnet } from 'lucide-react'
import { GlassIsland } from '../../ui/liquid'
import { COARSE_GRID, GRID_PRESETS, nextGridPreset } from './transform'
import type { Workbench } from './useWorkbench'

/**
 * The three modelling controls that earn permanent pixels over the model.
 *
 * This was nine: a projection toggle, two framing buttons, five snap presets and
 * the magnet. Framing the selection duplicated Focus in the Selection panel,
 * projection duplicated an option of the toolbar's render select, and three of
 * the five increments are precision work that belongs in the Precision sheet.
 * All of them kept their names and gained a chord; they are simply no longer
 * occupying the corner of the model on a first load that has no model in it.
 *
 * Snap stays here because it changes what the next drag *does*, which is a
 * different thing from a command you run and forget.
 */
export function ViewportQuickControls({ workbench: w }: { workbench: Workbench }) {
  const preset = GRID_PRESETS.find((entry) => entry.value === w.gridLdu) ?? GRID_PRESETS[0]
  // Coarse clicks cycle stud ↔ plate. A fine increment set from Precision or
  // `alt+g` still shows here, and clicking then rejoins the coarse pair rather
  // than stranding the button on a value it cannot reach again.
  const nextCoarse = COARSE_GRID.includes(w.gridLdu as (typeof COARSE_GRID)[number])
    ? COARSE_GRID[(COARSE_GRID.indexOf(w.gridLdu as (typeof COARSE_GRID)[number]) + 1) % COARSE_GRID.length]
    : nextGridPreset(w.gridLdu)

  return (
    <div className="viewport-quick-controls" role="toolbar" aria-label="Viewport quick controls">
      <GlassIsland className="viewport-control-row" radius="section" blur="control">
        <button type="button" aria-label="Frame model" title="Frame model (F)" onClick={w.fitView}>
          <Focus size={14} />
        </button>

        <hr className="viewport-control-divider" />

        <button
          type="button"
          className="grid-preset-current"
          aria-label={`Snap ${preset.label}`}
          title={`Snapping to ${preset.label} · click to change · alt+G cycles all five`}
          onClick={() => w.setGridLdu(nextCoarse)}
        >
          {preset.short}
        </button>
        <button
          type="button"
          aria-label="Connector snapping"
          aria-pressed={w.transformPrefs.connectorSnap}
          title="Snap moved parts to nearby connectors"
          onClick={() => w.setTransformPrefs({ ...w.transformPrefs, connectorSnap: !w.transformPrefs.connectorSnap })}
        >
          <Magnet size={13} />
        </button>
      </GlassIsland>
    </div>
  )
}
