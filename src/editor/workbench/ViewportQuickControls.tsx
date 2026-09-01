import { Box, Focus, Grid3X3, Magnet, Scan } from 'lucide-react'
import { GlassIsland } from '../../ui/liquid'
import type { Workbench } from './useWorkbench'

const GRID_PRESETS = [
  { value: 20, short: '1S', label: '1 stud' },
  { value: 10, short: '½S', label: 'half stud' },
  { value: 8, short: '1P', label: '1 plate' },
  { value: 4, short: '4', label: '4 LDU' },
  { value: 1, short: '1', label: '1 LDU' },
] as const

/**
 * Frequently changed modelling controls, in one row over the model.
 *
 * These were two stacked islands — camera above, grid below — which cost two
 * rows of the model's own top-left corner to say one thing: how you are looking
 * at the build, and what it lands on. One row, two groups, a rule between them.
 *
 * The rule matters. Six controls in an undifferentiated strip is a worse read
 * than the two rows were; the divider is what lets "how I look at it" and
 * "where it lands" stay separate ideas while sharing a line.
 */
export function ViewportQuickControls({ workbench: w }: { workbench: Workbench }) {
  return (
    <div className="viewport-quick-controls" role="toolbar" aria-label="Viewport quick controls">
      <GlassIsland className="viewport-control-row" radius="section" blur="control">
        {/* `Box` rather than `Scan`: the projection toggle and Focus selection
            two buttons along were drawn with the same glyph at two sizes, so
            the toolbar showed one icon meaning two unrelated things. */}
        <button
          type="button"
          aria-label="Orthographic projection"
          aria-pressed={w.renderMode === 'orthographic'}
          title="Toggle parallel projection for precise alignment"
          onClick={() => w.setRenderMode(w.renderMode === 'orthographic' ? 'beauty' : 'orthographic')}
        >
          <Box size={13} />
        </button>
        <button type="button" aria-label="Frame model" title="Frame model (F)" onClick={w.fitView}>
          <Focus size={14} />
        </button>
        <button
          type="button"
          aria-label="Frame selected parts"
          title="Focus selection (Shift+F)"
          disabled={!w.state.selection.length}
          onClick={w.focusSelection}
        >
          <Scan size={14} />
        </button>

        <hr className="viewport-control-divider" />

        <Grid3X3 size={13} aria-hidden="true" />
        <div className="grid-preset-group" role="group" aria-label="Grid snap increment">
          {GRID_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.value}
              aria-label={`Snap ${preset.label}`}
              aria-pressed={w.gridLdu === preset.value}
              title={`Snap to ${preset.label}`}
              onClick={() => w.setGridLdu(preset.value)}
            >
              {preset.short}
            </button>
          ))}
        </div>
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
