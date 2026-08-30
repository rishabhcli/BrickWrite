import { Check, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { searchCatalog } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { CadViewport, type RenderMode } from '../CadViewport'
import { Slot } from './ExtensionRegistry'
import { EmptyBuildState } from './states'
import type { Workbench } from './useWorkbench'

/**
 * What each diagnostic view is showing.
 *
 * The modes render real kernel state — connector genders, collision pairs,
 * subassembly grouping — but the colours only mean something to someone who
 * already knows the conventions, so each one says what it is.
 */
const RENDER_MODE_COPY: Record<Exclude<RenderMode, 'beauty'>, { title: string; detail: string; keys?: Array<{ label: string; swatch: string }> }> = {
  orthographic: {
    title: 'Orthographic',
    detail: 'Parallel projection, so equal lengths measure equal on screen at any depth.',
  },
  connections: {
    title: 'Connector map',
    detail: 'Every compiled LDCad connector on every placed part, at its solved world position.',
    keys: [
      { label: 'Male — studs, pins, bars', swatch: '#f4aa45' },
      { label: 'Female — anti-studs, clips, sockets', swatch: '#7cefe7' },
    ],
  },
  violations: {
    title: 'Collision report',
    detail: 'Parts in a confirmed collision pair. Mating clearance is already subtracted, so legal stacking is not flagged.',
    keys: [{ label: 'In a collision pair', swatch: '#ff5c48' }],
  },
  silhouette: {
    title: 'Silhouette',
    detail: 'Colour removed, so form and overhangs read without the palette competing.',
  },
  exploded: {
    title: 'Exploded',
    detail: 'Subassemblies pushed apart along their own axis. Positions are display-only; the document is unchanged.',
  },
}

export function ViewportStage({ workbench }: { workbench: Workbench }) {
  const { state, renderMode, placement, placementDefinition } = workbench
  const [dragOver, setDragOver] = useState(false)

  const pickStarter = useCallback(() => {
    const first = searchCatalog({ requireGeometry: true, limit: 1, text: 'brick 2 x 4' })[0]
      ?? searchCatalog({ requireGeometry: true, limit: 1 })[0]
    if (first) workbench.armPart(first)
  }, [workbench])

  const onDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    const id = event.dataTransfer.getData('application/x-brickwright-part')
    setDragOver(false)
    if (!id) return
    event.preventDefault()
    const record = searchCatalog({ text: id, limit: 1, tier: 'all' })[0]
    workbench.dropPart(record ?? { id, name: id }, event.clientX, event.clientY)
  }, [workbench])

  return (
    <section
      className={`viewport-shell ${dragOver ? 'drag-target' : ''}`}
      aria-label="Three-dimensional CAD viewport"
      data-render-mode={renderMode}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-brickwright-part')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <CadViewport
        document={workbench.renderedDocument}
        selection={state.selection}
        proposals={workbench.viewportProposals}
        tool={workbench.tool}
        gridLdu={workbench.gridLdu}
        cameraView={workbench.cameraView}
        cameraResetKey={workbench.cameraResetKey}
        renderMode={renderMode}
        placement={placement}
        dropAt={workbench.dropPoint}
        onDropHandled={workbench.finishDrop}
        onSelect={workbench.handleSelect}
        onSelectMany={workbench.handleSelectMany}
        onClearSelection={() => cadEngine.setSelection([])}
        onTransform={workbench.handleTransform}
        onCommitTransforms={(operations) => workbench.commitTransforms(
          workbench.tool === 'rotate'
            ? (operations.length > 1 ? 'Turn selection' : 'Turn part')
            : (operations.length > 1 ? `Move ${operations.length} parts` : 'Transform part'),
          operations,
        )}
        onNudgeSelection={workbench.nudgeSelection}
        onPlace={workbench.placeArmed}
        onJointNudge={workbench.driveJoint}
        onCanvasReady={(canvas) => {
          workbench.canvasRef.current = canvas
          window.__brickwrightCanvas = canvas
        }}
      />
      <p id="viewport-keys" className="viewport-keys-hint">
        Arrow keys orbit · Shift for a coarser step · Page Up/Down or +/- zoom · Home or 0 frames · [ ] walk parts · , . joints · ; ' section · \ occlusion
      </p>
      <span id="viewport-live" className="visually-hidden" role="status" aria-live="polite" />
      <div className="viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="viewport-title-block">
        <p>{workbench.selectionLabel}</p>
      </div>
      <div className="viewport-metrics">
        <Metric label="PARTS" value={String(state.validation.partCount).padStart(3, '0')} />
        <Metric label="CONN" value={String(state.validation.connectionCount).padStart(3, '0')} />
        <Metric label="HITS" value={String(state.validation.collisions.length).padStart(2, '0')} good={state.validation.collisions.length === 0} />
      </div>

      {renderMode !== 'beauty' && (
        <div className="render-legend" role="status">
          <strong>{RENDER_MODE_COPY[renderMode].title}</strong>
          <p>{RENDER_MODE_COPY[renderMode].detail}</p>
          {RENDER_MODE_COPY[renderMode].keys && (
            <ul>
              {RENDER_MODE_COPY[renderMode].keys!.map((entry) => (
                <li key={entry.label}><i style={{ background: entry.swatch }} />{entry.label}</li>
              ))}
            </ul>
          )}
          <button onClick={() => workbench.setRenderMode('beauty')}>BACK TO BEAUTY</button>
        </div>
      )}

      {placement && placementDefinition && (
        <div className="placement-hud" role="status">
          <span className="placement-pulse" />
          <div>
            <small>PLACING</small>
            <strong>{placementDefinition.name}</strong>
          </div>
          <p>Click in the viewport to drop it · <kbd>R</kbd> turn · <kbd>Esc</kbd> cancel</p>
          <button onClick={workbench.cancelPlacement} aria-label="Cancel placement"><X size={13} /></button>
        </div>
      )}

      {dragOver && (
        <div className="viewport-droptarget" role="status">
          <strong>Drop to place</strong>
          <p>The part is solved onto whatever is under the cursor.</p>
        </div>
      )}

      {state.validation.partCount === 0 && !placement && <EmptyBuildState onPickStarter={pickStarter} />}

      {workbench.playbackStep !== null && (
        <div className="instruction-overlay">
          <span>BUILD PLAYBACK</span>
          <strong>
            STEP {String(workbench.playbackStep + 1).padStart(2, '0')} / {String(state.document.steps.length).padStart(2, '0')}
          </strong>
          <em>{state.document.steps[workbench.playbackStep]?.name}</em>
          <button onClick={() => workbench.setPlaybackStep(null)} aria-label="Stop build playback"><X size={12} /></button>
        </div>
      )}

      {state.proposals.length > 0 && (
        <div className="proposal-overlay">
          <span className="proposal-pulse" />
          <div><small>GHOST PROPOSAL</small><strong>{state.proposals[0].label}</strong></div>
          <em>{state.proposals[0].operations.length} edits</em>
          <button onClick={() => workbench.acceptProposal(state.proposals[0].id)}><Check size={13} /> Accept</button>
          <button onClick={() => workbench.rejectProposal(state.proposals[0].id)} aria-label="Reject proposal"><X size={13} /></button>
        </div>
      )}

      {/* Extension point. Agent overlays, share badges and refinement diffs draw
          here without this file knowing they exist. */}
      <Slot id="overlay" />
    </section>
  )
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className={good ? 'good' : ''}><span>{label}</span><strong>{value}</strong></div>
}
