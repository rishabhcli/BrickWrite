import { Check, Eye, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { catalog, searchCatalog } from '../../cad/catalog'
import type { ResolvedPlacement } from '../../cad/placement'
import { PlacementBar } from './PlacementBar'
import { PartContextMenu } from './PartContextMenu'
import { cadEngine } from '../../cad/engine'
import { CadViewport, type RenderMode } from '../CadViewport'
import { Slot } from './ExtensionRegistry'
import { EmptyBuildState } from './states'
import type { Workbench } from './useWorkbench'
import { ViewportQuickControls } from './ViewportQuickControls'
import { ViewportNavigator } from './ViewportNavigator'
import { SelectionHUD } from './SelectionHUD'
import { describeConnectHudLabel } from './ConnectPanel'

/**
 * What each diagnostic view is showing.
 *
 * The modes render real kernel state — connector genders, collision pairs,
 * subassembly grouping — but the colours only mean something to someone who
 * already knows the conventions, so each one says what it is.
 */
const RENDER_MODE_COPY: Record<
  Exclude<RenderMode, 'beauty'>,
  { title: string; detail: string; keys?: Array<{ label: string; swatch: string }> }
> = {
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
    detail:
      'Parts in a confirmed collision pair. Mating clearance is already subtracted, so legal stacking is not flagged.',
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

export function ViewportStage({
  workbench,
  activeProposalId,
  onReviewProposal,
}: {
  workbench: Workbench
  activeProposalId?: string | null
  onReviewProposal?: (proposalId: string) => void
}) {
  const { state, renderMode, placement, placementDefinition } = workbench
  const [preview, setPreview] = useState<ResolvedPlacement | null>(null)
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number } | null>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  // The viewport stub (and a rotate that has not yet resampled) can leave the
  // last landing on the bar. A new yaw, a new part, or a committed revision
  // makes that preview a lie until the next sample.
  useEffect(() => {
    setPreview(null)
  }, [placement?.definitionId, placement?.quarterTurns, placement?.movingPartId, state.document.revision])
  const closeContext = useCallback(
    (focusCanvas = true) => {
      setContextPoint(null)
      if (focusCanvas) requestAnimationFrame(() => workbench.canvasRef.current?.focus({ preventScroll: true }))
    },
    [workbench.canvasRef],
  )
  const activeProposal =
    state.proposals.find((proposal) => proposal.id === activeProposalId) ?? state.proposals[0] ?? null
  const pendingProposalIds = new Set(state.proposals.map((proposal) => proposal.id))
  const visibleProposals = activeProposal
    ? workbench.viewportProposals.filter(
        (proposal) => proposal.id === activeProposal.id || !pendingProposalIds.has(proposal.id),
      )
    : workbench.viewportProposals
  const pickStarter = useCallback(() => {
    const first =
      searchCatalog({ requireGeometry: true, limit: 1, text: 'brick 2 x 4' })[0] ??
      searchCatalog({ requireGeometry: true, limit: 1 })[0]
    // Commit it, rather than arm it. See `EmptyBuildState`: the empty viewport is
    // the one place where "nothing visibly happened" is indistinguishable from a
    // broken application, and `addPart` ends with the brick selected, the Move
    // handles attached and the canvas focused.
    if (first) workbench.addPart(first)
  }, [workbench])

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const id = event.dataTransfer.getData('application/x-brickwright-part')
      if (!id) return
      event.preventDefault()
      const record = catalog.describe(id)
      workbench.dropPart(record ?? { id, name: id }, event.clientX, event.clientY)
    },
    [workbench],
  )

  return (
    <section
      className="viewport-shell"
      aria-label="Three-dimensional CAD viewport"
      data-render-mode={renderMode}
      onPointerDownCapture={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY }
      }}
      onContextMenu={(event) => {
        if (!(event.target instanceof HTMLCanvasElement)) return
        event.preventDefault()
        if (placement) return
        const start = pointerStart.current
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
        const rect = event.target.getBoundingClientRect()
        const hit = window.__brickwrightRenderer?.pick(event.clientX - rect.left, event.clientY - rect.top)
        if (hit?.partId && !state.selection.includes(hit.partId)) cadEngine.setSelection([hit.partId])
        if (!hit?.partId) cadEngine.setSelection([])
        setContextPoint({ x: event.clientX, y: event.clientY })
      }}
      onKeyDownCapture={(event) => {
        if (!(event.target instanceof HTMLCanvasElement) || placement) return
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.target.getBoundingClientRect()
          setContextPoint({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        }
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-brickwright-part')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      <CadViewport
        document={workbench.renderedDocument}
        selection={state.selection}
        highlightIds={
          workbench.connect.targetPartId && workbench.connect.stage !== 'source'
            ? [workbench.connect.targetPartId]
            : undefined
        }
        proposals={visibleProposals}
        tool={workbench.tool}
        gridLdu={workbench.gridLdu}
        transformPreferences={workbench.transformPrefs}
        cameraView={workbench.cameraView}
        cameraResetKey={workbench.cameraResetKey}
        renderMode={renderMode}
        placement={placement}
        placementDocument={state.document}
        onPlacementPreview={setPreview}
        dropAt={workbench.dropPoint}
        onDropHandled={workbench.finishDrop}
        onBeginPartDrag={() => workbench.pickUpSelection()}
        onEndPartDrag={(clientX, clientY) => workbench.dropReposition(clientX, clientY)}
        onSelect={workbench.handleSelect}
        onSelectMany={workbench.handleSelectMany}
        onClearSelection={() => cadEngine.setSelection([])}
        onTransform={workbench.handleTransform}
        onCommitTransforms={(operations) =>
          workbench.commitTransforms(
            workbench.tool === 'rotate'
              ? operations.length > 1
                ? 'Turn selection'
                : 'Turn part'
              : operations.length > 1
                ? `Move ${operations.length} parts`
                : 'Transform part',
            operations,
          )
        }
        onNudgeSelection={workbench.nudgeSelection}
        onPlace={workbench.placeArmed}
        onJointNudge={workbench.driveJoint}
        onCanvasReady={(canvas) => {
          workbench.canvasRef.current = canvas
          window.__brickwrightCanvas = canvas
        }}
      />
      {/* Kept in the document because the canvas points `aria-describedby` at
          it, but no longer printed over the model: a permanent cheat sheet in
          the viewport is 21 words the operator reads once and then looks past
          forever, and `?` already opens the full command map. */}
      <p id="viewport-keys" className="visually-hidden">
        {workbench.tool === 'move' || workbench.tool === 'rotate'
          ? 'Arrows move · Page Up/Down raise/lower · Shift for a coarser step · Escape cancels a drag'
          : 'Drag to orbit · Right-drag to pan · Scroll to zoom · Shift-drag to select'}
        {' · F frames · Shift+F focuses'}
      </p>
      <span id="viewport-live" className="visually-hidden" role="status" aria-live="polite" />
      <div className="viewport-top-stack" data-overlay-stack="top">
        {workbench.playbackStep !== null && (
          <div className="instruction-overlay">
            <span>BUILD PLAYBACK</span>
            <strong>
              STEP {String(workbench.playbackStep + 1).padStart(2, '0')} /{' '}
              {String(state.document.steps.length).padStart(2, '0')}
            </strong>
            <em>{state.document.steps[workbench.playbackStep]?.name}</em>
            <button onClick={() => workbench.setPlaybackStep(null)} aria-label="Stop build playback">
              <X size={12} />
            </button>
          </div>
        )}
        {!placement && state.selection.length ? (
          <SelectionHUD
            count={state.selection.length}
            label={describeConnectHudLabel(
              workbench.connect,
              state.document,
              workbench.selectedDefinition?.name ??
                (state.selection.length === 1
                  ? (state.document.parts[state.selection[0]]?.definitionId ?? 'Selected part')
                  : `${state.selection.length} selected`),
            )}
            position={workbench.selectionPosition}
            rotation={workbench.selectionRotation}
            locks={workbench.transformPrefs.locks}
            frame={workbench.transformPrefs.frame}
            tool={workbench.tool}
            onTool={workbench.setTool}
            onFocus={workbench.focusSelection}
            onGround={workbench.groundSelection}
            onDuplicate={workbench.duplicateSelection}
            onPosition={workbench.positionSelection}
            onRotate={workbench.orientSelection}
            onMore={(anchor) => {
              const rect = anchor.getBoundingClientRect()
              setContextPoint({ x: rect.left, y: rect.bottom + 6 })
            }}
          />
        ) : null}
      </div>
      <ViewportQuickControls workbench={workbench} />
      <ViewportNavigator view={workbench.cameraView} onView={workbench.setCameraView} />

      {/* Ortho is an editing projection, not a diagnostic overlay. Its pressed
          toolbar button is enough; a large legend used to obscure the model. */}
      {renderMode !== 'beauty' && renderMode !== 'orthographic' && (
        <div className="render-legend" role="status">
          <strong>{RENDER_MODE_COPY[renderMode].title}</strong>
          <p>{RENDER_MODE_COPY[renderMode].detail}</p>
          {RENDER_MODE_COPY[renderMode].keys && (
            <ul>
              {RENDER_MODE_COPY[renderMode].keys!.map((entry) => (
                <li key={entry.label}>
                  <i style={{ background: entry.swatch }} />
                  {entry.label}
                </li>
              ))}
            </ul>
          )}
          <button onClick={() => workbench.setRenderMode('beauty')}>BACK TO BEAUTY</button>
        </div>
      )}

      <div className="viewport-bottom-stack" data-overlay-stack="bottom">
        {placement && placementDefinition && <PlacementBar workbench={workbench} preview={preview} />}
        {activeProposal && (
          <div className="proposal-overlay">
            <span className="proposal-pulse" />
            <div>
              <small>GHOST PROPOSAL</small>
              <strong>{activeProposal.label}</strong>
            </div>
            <em>{activeProposal.operations.length} edits</em>
            {onReviewProposal && (
              <button onClick={() => onReviewProposal(activeProposal.id)}>
                <Eye size={13} /> Review
              </button>
            )}
            <button onClick={() => workbench.acceptProposal(activeProposal.id)}>
              <Check size={13} /> Accept
            </button>
            <button onClick={() => workbench.rejectProposal(activeProposal.id)} aria-label="Reject proposal">
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {contextPoint && <PartContextMenu workbench={workbench} point={contextPoint} onClose={closeContext} />}

      {state.validation.partCount === 0 && !placement && <EmptyBuildState onPickStarter={pickStarter} />}

      {/* Extension point. Agent overlays, share badges and refinement diffs draw
          here without this file knowing they exist. */}
      <Slot id="overlay" />
    </section>
  )
}
