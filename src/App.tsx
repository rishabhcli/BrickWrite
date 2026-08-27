import {
  BoxSelect,
  Boxes,
  BringToFront,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  Download,
  Eye,
  Focus,
  Grid3X3,
  Link2,
  Lock,
  Maximize2,
  MousePointer2,
  Move3d,
  Redo2,
  Rotate3d,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { articulate, findArticulatedJoints } from './cad/articulation'
import { computeBuildOrder } from './cad/instructions'
import { catalog, originForSurface, STUD_LDU, surfaceAbove } from './cad/catalog'
import { IDENTITY_BASIS, rotateLocal } from './cad/math'
import { exportBomCsv } from './cad/bom'
import { cadEngine } from './cad/engine'
import { getDocumentBounds, getPartBounds } from './cad/geometry'
import { downloadText, exportLDraw, parseLDraw } from './cad/ldraw'
import { bestSnapTransform } from './cad/snapping'
import { session, type SessionStatus } from './cad/session'
import type { CadOperation, CatalogSearchRecord, PartInstance, Transform, Vec3 } from './cad/types'
import { CadViewport, type CameraView, type EditorTool, type RenderMode } from './editor/CadViewport'
import { AutonomySwitch, CatalogPanel, InspectorPanel, Timeline, type ArticulationControl } from './editor/Panels'
import { useCad } from './editor/useCad'
import { webMcpAdapter } from './webmcp/adapter'

const makeId = () => `part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

interface ToastState {
  kind: 'success' | 'error' | 'info'
  title: string
  detail: string
}

export default function App() {
  const state = useCad()
  const [activeColor, setActiveColor] = useState(72)
  const [tool, setTool] = useState<EditorTool>('select')
  const [gridLdu, setGridLdu] = useState(STUD_LDU)
  const [cameraView, setCameraView] = useState<CameraView>('isometric')
  const [renderMode, setRenderMode] = useState<RenderMode>('beauty')
  const [captureRequestId, setCaptureRequestId] = useState<string | null>(null)
  const [playbackStep, setPlaybackStep] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [toolStatus, setToolStatus] = useState({ native: false, toolCount: 0, mode: state.autonomy })
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(() => session.status)
  const importInput = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const selectedPart = state.selection.length === 1 ? state.document.parts[state.selection[0]] : undefined
  const selectedDefinition = selectedPart ? catalog.get(selectedPart.definitionId) : undefined

  useEffect(() => {
    webMcpAdapter.start()
    setToolStatus(webMcpAdapter.getStatus())
    return () => webMcpAdapter.stop()
  }, [])

  useEffect(() => {
    const changeView = (event: Event) => {
      const detail = (event as CustomEvent<CameraView | { view: CameraView; mode: RenderMode; requestId?: string }>).detail
      const requested = typeof detail === 'string' ? detail : detail.view
      if (['isometric', 'front', 'rear', 'left', 'right', 'top'].includes(requested)) setCameraView(requested)
      if (typeof detail !== 'string' && ['beauty', 'orthographic', 'silhouette', 'connections', 'violations', 'exploded'].includes(detail.mode)) setRenderMode(detail.mode)
      if (typeof detail !== 'string' && detail.requestId) setCaptureRequestId(detail.requestId)
    }
    window.addEventListener('brickwright:set-camera-view', changeView)
    return () => window.removeEventListener('brickwright:set-camera-view', changeView)
  }, [])

  useEffect(() => {
    if (!captureRequestId) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('brickwright:capture-ready', { detail: { requestId: captureRequestId } }))
        setCaptureRequestId(null)
      })
    })
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame) }
  }, [cameraView, captureRequestId, renderMode])

  // Persistence is driven by the session layer's commit hook, not by rendering:
  // every committed transaction is appended to the durable log immediately.
  useEffect(() => {
    setToolStatus(webMcpAdapter.getStatus())
    setSessionStatus(session.status)
  }, [state.autonomy, state.document])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 3600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (playbackStep === null || playbackStep >= state.document.steps.length - 1) return
    const timeout = window.setTimeout(() => setPlaybackStep((step) => step === null ? null : step + 1), 720)
    return () => window.clearTimeout(timeout)
  }, [playbackStep, state.document.steps.length])

  const dispatch = useCallback((label: string, operations: CadOperation[]) => {
    const result = cadEngine.execute(label, operations, 'human', cadEngine.getSnapshot().document.revision)
    if (!result.ok) {
      setToast({ kind: 'error', title: `[${result.error.code}]`, detail: result.error.message })
      return false
    }
    setToast({ kind: 'success', title: label, detail: `Committed atomically · revision ${result.value.resultRevision}` })
    return true
  }, [])

  const handleSelect = useCallback((partId: string, additive: boolean, subassembly: boolean) => {
    const snapshot = cadEngine.getSnapshot()
    const clicked = snapshot.document.parts[partId]
    if (!clicked) return
    if (subassembly) {
      cadEngine.setSelection(snapshot.document.subassemblies[clicked.subassemblyId]?.partIds ?? [partId])
      return
    }
    if (tool === 'connect' && snapshot.selection.length === 1 && snapshot.selection[0] !== partId) {
      const target = snapshot.document.parts[snapshot.selection[0]]
      const targetBounds = getPartBounds(target)
      // Seed the solver near the target's top face and let it derive the exact
      // pose, including any rotation the connector frames require.
      const coarseTransform: Transform = {
        position: [target.transform.position[0], targetBounds.min[1], target.transform.position[2]],
        basis: clicked.transform.basis,
      }
      const nextTransform = bestSnapTransform(clicked, snapshot.document, coarseTransform, { radiusLdu: STUD_LDU, targetPartIds: [target.id] }) ?? coarseTransform
      if (dispatch(`Connect ${clicked.definitionId} to ${target.definitionId}`, [{ type: 'part.transform', partId, transform: nextTransform }])) {
        cadEngine.setSelection([partId])
      }
      return
    }
    if (additive) {
      cadEngine.setSelection(snapshot.selection.includes(partId) ? snapshot.selection.filter((id) => id !== partId) : [...snapshot.selection, partId])
    } else {
      cadEngine.setSelection([partId])
    }
  }, [dispatch, tool])

  const handleTransform = useCallback((partId: string, transform: Transform) => {
    const snapshot = cadEngine.getSnapshot()
    const part = snapshot.document.parts[partId]
    const snapped = part ? bestSnapTransform(part, snapshot.document, transform, { radiusLdu: Math.max(4, gridLdu * 0.7) }) : null
    dispatch(snapped ? 'Snap part to connectors' : 'Transform part', [{ type: 'part.transform', partId, transform: snapped ?? transform }])
  }, [dispatch, gridLdu])

  const addPart = useCallback((record: CatalogSearchRecord) => {
    const definition = catalog.get(record.id)
    if (!definition) {
      setToast({
        kind: 'error',
        title: 'Part cannot be placed',
        detail: `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
      })
      return
    }
    const snapshot = cadEngine.getSnapshot()
    const selected = snapshot.selection[0] ? snapshot.document.parts[snapshot.selection[0]] : undefined
    const documentBounds = getDocumentBounds(snapshot.document)
    const size = definition.dimensions?.ldu ?? [STUD_LDU, 0, STUD_LDU]
    let position: Vec3
    if (selected) {
      // Land on top of the selection. LDraw is Y-down, so "on top" is the
      // selection's minimum Y, offset by the new part's own top overhang.
      const bounds = getPartBounds(selected)
      const local = definition.dimensions?.bounds
      position = [
        selected.transform.position[0],
        bounds.min[1] - (local ? local.min[1] : 0),
        selected.transform.position[2],
      ]
    } else if (snapshot.validation.partCount) {
      position = [documentBounds.max[0] + size[0] / 2 + STUD_LDU, 0, 0]
    } else {
      position = [0, 0, 0]
    }
    const availableColor = definition.availableColors.includes(activeColor)
      ? activeColor
      : (definition.availableColors[0] ?? activeColor)
    const part: PartInstance = {
      id: makeId(),
      definitionId: definition.canonicalId,
      color: availableColor,
      transform: { position, basis: IDENTITY_BASIS },
      subassemblyId: selected?.subassemblyId ?? Object.values(snapshot.document.subassemblies).find((item) => !item.locked)?.id ?? Object.keys(snapshot.document.subassemblies)[0],
      stepId: snapshot.document.steps.at(-1)?.id ?? 'step_1',
      provenance: 'human',
      protected: false,
    }
    if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part }])) {
      cadEngine.setSelection([part.id])
      setTool('move')
    }
  }, [activeColor, dispatch])

  const duplicateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return
    const selected = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
    const bounds = selected.map(getPartBounds)
    const offset = Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0])) + STUD_LDU
    const additions = selected.map((part, index): CadOperation => ({
      type: 'part.add',
      part: {
        ...structuredClone(part),
        id: `${makeId()}_${index}`,
        transform: { ...part.transform, position: [part.transform.position[0] + offset, part.transform.position[1], part.transform.position[2]] },
        protected: false,
      },
    }))
    if (dispatch(`Duplicate ${selected.length} part${selected.length === 1 ? '' : 's'}`, additions)) {
      cadEngine.setSelection(additions.map((operation) => operation.type === 'part.add' ? operation.part.id : ''))
    }
  }, [dispatch])

  const deleteSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return
    dispatch(`Remove ${snapshot.selection.length} part${snapshot.selection.length === 1 ? '' : 's'}`, snapshot.selection.map((partId) => ({ type: 'part.remove', partId })))
    cadEngine.setSelection([])
  }, [dispatch])

  const rotateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    const operations: CadOperation[] = snapshot.selection.map((partId) => {
      const part = snapshot.document.parts[partId]
      // Quarter turn about the part's own vertical axis, composed on the basis
      // so repeated turns cannot drift through Euler round-tripping.
      return { type: 'part.transform', partId, transform: rotateLocal(part.transform, [0, 1, 0], Math.PI / 2) }
    })
    if (operations.length) dispatch('Quarter-turn selection', operations)
  }, [dispatch])

  const recolorSelection = useCallback((color: number) => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return
    // Every LDraw colour is buildable. A pairing with no official-set evidence
    // is reported as virtual rather than blocked, matching how the validation
    // panel and the agent's error vocabulary describe it.
    const virtual = snapshot.selection.filter((id) => {
      const definition = catalog.get(snapshot.document.parts[id].definitionId)
      return definition ? !definition.availableColors.includes(color) : false
    })
    if (dispatch('Recolor selection', snapshot.selection.map((partId) => ({ type: 'part.recolor', partId, color })))) {
      setActiveColor(color)
      if (virtual.length) {
        setToast({
          kind: 'info',
          title: 'Virtual colour applied',
          detail: `${virtual.length} part${virtual.length === 1 ? '' : 's'} now use${virtual.length === 1 ? 's' : ''} ${catalog.color(color).name}, which has no observed official-set appearance for that mould.`,
        })
      }
    }
  }, [dispatch])

  const protectSelection = useCallback((protect: boolean) => {
    const snapshot = cadEngine.getSnapshot()
    if (snapshot.selection.length) dispatch(protect ? 'Protect selection' : 'Unlock selection', snapshot.selection.map((partId) => ({ type: 'part.protect', partId, protected: protect })))
  }, [dispatch])

  const acceptProposal = (id: string) => {
    const result = cadEngine.applyProposal(id, 'human')
    setToast(result.ok
      ? { kind: 'success', title: 'Proposal accepted', detail: `Committed as revision ${result.value.resultRevision}` }
      : { kind: 'error', title: `[${result.error.code}]`, detail: result.error.message })
  }

  /**
   * Stands in for a Codex `build_preflight` call so the collaboration loop can
   * be exercised without the agent attached. It goes through the exact same
   * command bus, revision guard and validation the agent uses.
   */
  /**
   * Joints the current selection can drive.
   *
   * Derived from the persisted connection graph, so it reflects what the model is
   * actually assembled from rather than what the selected part could in principle
   * connect to.
   */
  const articulation = useMemo<ArticulationControl[]>(() => {
    if (!state.selection.length) return []
    return findArticulatedJoints(state.document, state.selection).map((joint) => ({
      edgeId: joint.edgeId,
      label: joint.label,
      family: joint.family,
      canRotate: joint.joint.kind === 'revolute' || joint.joint.kind === 'cylindrical' || joint.joint.kind === 'spherical',
      canSlide: joint.joint.kind === 'cylindrical' || joint.joint.kind === 'prismatic',
      rotateStep:
        joint.joint.kind === 'revolute' && !joint.joint.continuous
          ? (joint.joint.stepDegrees ?? 90)
          : joint.joint.kind === 'cylindrical' && !joint.joint.continuousRotation
            ? 90
            : 15,
      slideStep: 4,
      movingCount: joint.movingPartIds.length,
    }))
  }, [state.document, state.selection])

  const driveJoint = useCallback(
    (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => {
      const snapshot = cadEngine.getSnapshot()
      const joint = findArticulatedJoints(snapshot.document, snapshot.selection).find((entry) => entry.edgeId === edgeId)
      if (!joint) return
      const operations = articulate(snapshot.document, joint, request)
      if (!operations.length) {
        setToast({
          kind: 'info',
          title: 'Joint did not move',
          detail: 'That amount is outside what this interface allows, so nothing was changed.',
        })
        return
      }
      dispatch(`Articulate ${joint.family}`, operations)
    },
    [dispatch],
  )

  /**
   * Regenerates the build sequence from the connection graph.
   *
   * The generated order guarantees each part attaches to structure placed
   * earlier; where it cannot, the part begins a separately-built island and that
   * is reported rather than glossed over.
   */
  const regenerateBuildOrder = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    const result = computeBuildOrder(snapshot.document)
    if (!result.steps.length) {
      setToast({ kind: 'info', title: 'Nothing to sequence', detail: 'The model has no parts yet.' })
      return
    }
    if (dispatch('Generate build order', [{ type: 'steps.replace', steps: result.steps }])) {
      const islands = result.unsupportedPartIds.length
      setToast({
        kind: islands ? 'info' : 'success',
        title: `${result.steps.length} steps generated`,
        detail: islands
          ? `Every part attaches to earlier structure except ${islands}, which begin separately-built subassemblies.`
          : 'Every part attaches to structure placed in an earlier step.',
      })
    }
  }, [dispatch])

  const createDemoProposal = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    // Find a real exposed stud plane on the rear deck rather than assuming one:
    // the surface is derived from the plate that is actually there.
    const deckPlate = Object.values(snapshot.document.parts)
      .filter((part) => part.subassemblyId === 'deck' && catalog.get(part.definitionId)?.category === 'Plates')
      .sort((a, b) => b.transform.position[2] - a.transform.position[2])[0]
    const plateDefinition = deckPlate ? catalog.get(deckPlate.definitionId) : undefined
    const surface = plateDefinition ? surfaceAbove(plateDefinition, deckPlate!.transform.position[1]) : null
    if (surface === null || surface === undefined) {
      setToast({ kind: 'error', title: 'No exposed studs', detail: 'The rear deck has no free stud plane to build on.' })
      return
    }
    const upright = catalog.get('3004')
    if (!upright) {
      setToast({ kind: 'error', title: '[GEOMETRY_UNAVAILABLE]', detail: 'Brick 1 × 2 is not in the compiled geometry pack.' })
      return
    }
    const y = originForSurface(upright, surface)
    const subassemblyId = Object.values(snapshot.document.subassemblies).find((item) => item.id === 'deck' && !item.locked)?.id
      ?? Object.values(snapshot.document.subassemblies).find((item) => !item.locked)?.id
      ?? 'deck'
    const stepId = snapshot.document.steps.at(-1)?.id ?? 'step_1'
    const operations: CadOperation[] = [-60, 60].map((x, index) => ({
      type: 'part.add',
      part: {
        id: `agent_rack_${Date.now().toString(36)}_${index}`,
        definitionId: upright.canonicalId,
        color: 25,
        transform: { position: [x, y, deckPlate!.transform.position[2] - 10] as Vec3, basis: IDENTITY_BASIS },
        subassemblyId,
        stepId,
        provenance: 'agent',
        protected: false,
      },
    }))
    const result = cadEngine.preflight('Add rear cargo rack uprights', operations, 'agent', snapshot.document.revision)
    setToast(result.ok
      ? { kind: 'info', title: 'Ghost proposal ready', detail: 'Rotate around the model, then accept or reject it in shared history.' }
      : { kind: 'error', title: `[${result.error.code}]`, detail: result.error.message })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, select')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? cadEngine.redo('human') : cadEngine.undo('human')
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection()
      } else if (event.key.toLowerCase() === 'g') setTool('move')
      else if (event.key.toLowerCase() === 'r') setTool('rotate')
      else if (event.key.toLowerCase() === 'v') setTool('select')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelection, duplicateSelection])

  const selectionLabel = useMemo(() => {
    if (!state.selection.length) return 'No selection'
    if (state.selection.length === 1 && selectedDefinition) return `${selectedDefinition.name} · ${selectedPart?.id}`
    return `${state.selection.length} parts selected`
  }, [selectedDefinition, selectedPart?.id, state.selection.length])

  const renderedDocument = useMemo(() => {
    if (playbackStep === null) return state.document
    const visible = new Set(state.document.steps.filter((_, index) => index <= playbackStep).flatMap((step) => step.partIds))
    return { ...state.document, parts: Object.fromEntries(Object.entries(state.document.parts).filter(([id]) => visible.has(id))) }
  }, [playbackStep, state.document])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><strong>BRICK<span>WRIGHT</span></strong><small>PHYSICAL CAD / 01</small></div>
        </div>
        <div className="project-identity">
          <span className="project-dot" />
          <div><strong>{state.document.name}</strong><small>LOCAL DOCUMENT · AUTOSAVED</small></div>
          <ChevronDown size={13} />
        </div>
        <div className="topbar-status">
          {/* The indicator reports what persistence actually achieved: a
              durable store, a fallback, or an outright failure. */}
          <div
            className={`save-state ${sessionStatus.error ? 'failing' : sessionStatus.durable ? '' : 'volatile'}`}
            title={
              sessionStatus.error
                ? `Autosave failed: ${sessionStatus.error}`
                : sessionStatus.durable
                  ? `Every transaction is appended to IndexedDB${sessionStatus.restore?.replayedTransactions ? ` · ${sessionStatus.restore.replayedTransactions} replayed on open` : ''}`
                  : 'IndexedDB is unavailable in this context; work is kept in memory only'
            }
          >
            <Save size={13} />
            <span>{sessionStatus.error ? 'Not saved' : sessionStatus.durable ? 'Saved' : 'In memory'}</span>
            <em>r{state.document.revision}</em>
          </div>
          <div className={`codex-state ${toolStatus.native ? 'connected' : 'ready'}`}>
            <span className="pulse-ring"><i /></span>
            <div><strong>{toolStatus.native ? 'Codex connected' : 'Site tools ready'}</strong><small>{toolStatus.toolCount} tools · {state.autonomy} access · catalog {catalog.version}</small></div>
          </div>
          <AutonomySwitch value={state.autonomy} onChange={(mode) => cadEngine.setAutonomy(mode)} />
        </div>
      </header>

      <nav className="toolrail" aria-label="CAD tools">
        <div className="toolgroup primary-tools">
          <ToolButton active={tool === 'select'} icon={<MousePointer2 />} label="Select" shortcut="V" onClick={() => setTool('select')} />
          <ToolButton active={tool === 'move'} icon={<Move3d />} label="Move" shortcut="G" onClick={() => setTool('move')} />
          <ToolButton active={tool === 'rotate'} icon={<Rotate3d />} label="Rotate" shortcut="R" onClick={() => setTool('rotate')} />
          <ToolButton active={tool === 'connect'} icon={<Link2 />} label="Connect" shortcut="C" onClick={() => setTool('connect')} />
        </div>
        <div className="rail-divider" />
        <div className="toolgroup compact-tools">
          <IconButton icon={<Copy />} label="Duplicate" onClick={duplicateSelection} disabled={!state.selection.length} />
          <IconButton icon={<Rotate3d />} label="Quarter turn" onClick={rotateSelection} disabled={!state.selection.length} />
          <IconButton icon={<Lock />} label="Protect selection" onClick={() => protectSelection(true)} disabled={!state.selection.length} />
          <IconButton icon={<Trash2 />} label="Remove selection" onClick={deleteSelection} disabled={!state.selection.length} />
        </div>
        <div className="rail-divider" />
        <label className="grid-picker">
          <Grid3X3 size={14} />
          <span>SNAP</span>
          <select value={gridLdu} onChange={(event) => setGridLdu(Number(event.target.value))}>
            <option value={20}>Stud grid</option>
            <option value={10}>Half-stud</option>
            <option value={1}>Fine LDU</option>
          </select>
        </label>
        <div className="rail-spacer" />
        <div className="toolgroup compact-tools camera-tools">
          <IconButton icon={<Eye />} label="Isometric view" onClick={() => setCameraView('isometric')} />
          <IconButton icon={<BringToFront />} label="Front view" onClick={() => setCameraView('front')} />
          <IconButton icon={<Maximize2 />} label="Top view" onClick={() => setCameraView('top')} />
          <IconButton icon={<Focus />} label="Fit model" onClick={() => setCameraView(cameraView === 'isometric' ? 'front' : 'isometric')} />
          <IconButton icon={<Boxes />} label="Play instruction steps" onClick={() => setPlaybackStep(playbackStep === null ? 0 : null)} />
        </div>
        <div className="rail-divider" />
        <div className="toolgroup compact-tools">
          <IconButton icon={<Undo2 />} label="Undo" onClick={() => cadEngine.undo('human')} disabled={!state.canUndo} />
          <IconButton icon={<Redo2 />} label="Redo" onClick={() => cadEngine.redo('human')} disabled={!state.canRedo} />
        </div>
        <button className="export-button" onClick={() => downloadText(`${state.document.name.replace(/\W+/g, '_')}.ldr`, exportLDraw(state.document))}><Download size={13} /> EXPORT LDR</button>
        <button className="bom-button" onClick={() => downloadText(`${state.document.name.replace(/\W+/g, '_')}_BOM.csv`, exportBomCsv(state.document), 'text/csv')}><Boxes size={13} /> BOM</button>
        <button className="import-button" onClick={() => importInput.current?.click()} aria-label="Import LDraw"><Upload size={14} /></button>
        <input
          ref={importInput}
          hidden
          type="file"
          accept=".ldr,.mpd,text/plain"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            const imported = parseLDraw(await file.text(), cadEngine.getDocument())
            cadEngine.replaceDocument(imported.document)
            const skipped = imported.report.unknownParts.length + imported.report.withoutGeometry.length
            setToast({
              kind: skipped ? 'info' : 'success',
              title: 'LDraw imported',
              detail: skipped
                ? `${imported.report.placed} parts placed across ${imported.report.submodels} submodels. ${skipped} references had no compiled geometry and were reported, not dropped silently.`
                : `${imported.report.placed} parts across ${imported.report.submodels} submodels are now an editable revisioned CAD document.`,
            })
            event.target.value = ''
          }}
        />
      </nav>

      <div className="workspace">
        <CatalogPanel activeColor={activeColor} onColorChange={setActiveColor} onAdd={addPart} />
        <section className="viewport-shell" aria-label="Three-dimensional CAD viewport" data-render-mode={renderMode}>
          <CadViewport
            document={renderedDocument}
            selection={state.selection}
            proposals={state.proposals}
            tool={tool}
            gridLdu={gridLdu}
            cameraView={cameraView}
            renderMode={renderMode}
            onSelect={handleSelect}
            onClearSelection={() => cadEngine.setSelection([])}
            onTransform={handleTransform}
            onCanvasReady={(canvas) => { canvasRef.current = canvas; window.__brickwrightCanvas = canvas }}
          />
          <div className="viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          <div className="viewport-breadcrumb"><span>ASSEMBLY</span><b>/</b><strong>{selectedPart ? state.document.subassemblies[selectedPart.subassemblyId]?.name : 'MASTER MODEL'}</strong></div>
          <div className="viewport-title-block">
            <span className="eyebrow">LIVE ASSEMBLY / REV {state.document.revision}</span>
            <h1>ASTRA <em>// 06</em></h1>
            <p>{selectionLabel}</p>
          </div>
          <div className="viewport-metrics">
            <Metric label="PARTS" value={String(state.validation.partCount).padStart(3, '0')} />
            <Metric label="CONNECTIONS" value={String(state.validation.connectionCount).padStart(3, '0')} />
            <Metric label="COLLISIONS" value={String(state.validation.collisions.length).padStart(2, '0')} good={state.validation.collisions.length === 0} />
          </div>
          <div className="viewport-status">
            <span><i /> LIVE KERNEL</span>
            <b>{tool === 'connect' && state.selection.length === 1 ? 'Choose a compatible target' : tool === 'move' ? `${gridLdu} LDU snap` : tool}</b>
          </div>
          {state.proposals.length === 0 && (
            <button className="agent-suggest" onClick={createDemoProposal}>
              <Sparkles size={14} />
              <span><small>AGENT WORKFLOW</small>Create a ghost reinforcement proposal</span>
              <b>TRY</b>
            </button>
          )}
          {playbackStep !== null && (
            <div className="instruction-overlay">
              <span>BUILD PLAYBACK</span>
              <strong>STEP {String(playbackStep + 1).padStart(2, '0')} / {String(state.document.steps.length).padStart(2, '0')}</strong>
              <em>{state.document.steps[playbackStep]?.name}</em>
              <button onClick={() => setPlaybackStep(null)}><X size={12} /></button>
            </div>
          )}
          {state.proposals.length > 0 && (
            <div className="proposal-overlay">
              <span className="proposal-pulse" />
              <div><small>GHOST PROPOSAL</small><strong>{state.proposals[0].label}</strong></div>
              <em>{state.proposals[0].operations.length} edits</em>
              <button onClick={() => acceptProposal(state.proposals[0].id)}><Check size={13} /> Accept</button>
              <button onClick={() => cadEngine.rejectProposal(state.proposals[0].id)}><X size={13} /></button>
            </div>
          )}
        </section>
        <InspectorPanel
          state={state}
          selectedPart={selectedPart}
          definition={selectedDefinition}
          articulation={articulation}
          onArticulate={driveJoint}
          onTransform={handleTransform}
          onRecolor={recolorSelection}
          onProtect={protectSelection}
          onSelectIds={(ids) => cadEngine.setSelection(ids)}
        />
      </div>

      <Timeline
        onSequence={regenerateBuildOrder}
        state={state}
        onAccept={acceptProposal}
        onReject={(id) => cadEngine.rejectProposal(id)}
        onSelectIds={(ids) => cadEngine.setSelection(ids)}
      />

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span>{toast.kind === 'success' ? <Check size={15} /> : toast.kind === 'error' ? <X size={15} /> : <CircleDot size={15} />}</span>
          <div><strong>{toast.title}</strong><p>{toast.detail}</p></div>
          <button onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      )}
    </main>
  )
}

function ToolButton({ icon, label, shortcut, active, onClick }: { icon: React.ReactElement; label: string; shortcut: string; active?: boolean; onClick: () => void }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span><kbd>{shortcut}</kbd></button>
}

function IconButton({ icon, label, onClick, disabled }: { icon: React.ReactElement; label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="icon-button" onClick={onClick} disabled={disabled} aria-label={label} title={label}>{icon}</button>
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className={good ? 'good' : ''}><span>{label}</span><strong>{value}</strong></div>
}
