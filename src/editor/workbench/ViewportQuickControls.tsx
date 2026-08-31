import { Focus, Grid3X3, Magnet, Scan } from 'lucide-react'
import type { CameraView } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import type { Workbench } from './useWorkbench'

/** Frequently changed modelling controls should not require opening a settings menu. */
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
        <button
          type="button"
          aria-label="Orthographic projection"
          aria-pressed={w.renderMode === 'orthographic'}
          title="Toggle parallel projection for precise alignment"
          onClick={() => w.setRenderMode(w.renderMode === 'orthographic' ? 'beauty' : 'orthographic')}
        >
          <Scan size={13} />
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
      </GlassIsland>
      <GlassIsland className="viewport-control-row" radius="section" blur="control">
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
