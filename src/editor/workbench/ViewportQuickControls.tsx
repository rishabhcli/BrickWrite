import { Box, Focus, Grid3X3, Magnet, Scan } from 'lucide-react'
import type { CameraView } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import type { Workbench } from './useWorkbench'

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
        <select
          aria-label="Camera view"
          value={w.cameraView}
          onChange={(event) => w.setCameraView(event.target.value as CameraView)}
        >
          <option value="isometric">Isometric</option>
          <option value="front">Front</option>
          <option value="rear">Back</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
          <option value="top">Top</option>
        </select>
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

        <Grid3X3 size={13} />
        <select
          aria-label="Quick grid snap"
          value={w.gridLdu}
          onChange={(event) => w.setGridLdu(Number(event.target.value))}
        >
          <option value={20}>1 stud</option>
          <option value={10}>½ stud</option>
          <option value={8}>1 plate</option>
          <option value={4}>4 LDU</option>
          <option value={1}>1 LDU</option>
        </select>
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
