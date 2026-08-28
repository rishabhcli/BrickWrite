import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findArticulatedJoints } from '../../cad/articulation'
import { planSharedMutation, SharedCapabilityError, type SharedMutationId } from '../../cad/capabilities'
import { catalog, originForSurface, STUD_LDU, surfaceAbove } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { getDocumentBounds, getPartBounds } from '../../cad/geometry'
import { createId } from '../../cad/ids'
import { parseLDraw } from '../../cad/ldraw'
import { IDENTITY_BASIS, rotateLocal } from '../../cad/math'
import { session, type SessionStatus } from '../../cad/session'
import { bestSnapTransform } from '../../cad/snapping'
import type {
  CadOperation,
  CatalogSearchRecord,
  ModelDocument,
  PartDefinition,
  PartInstance,
  Proposal,
  Transform,
  Vec3,
} from '../../cad/types'
import type { CameraView, EditorTool, RenderMode } from '../CadViewport'
import type { PlacementRequest } from '../../cad/placement'
import { useCad } from '../useCad'
import { webMcpAdapter } from '../../webmcp/adapter'
import type { WorkbenchNotice } from './ExtensionRegistry'
import { usePersistentState } from './persistence'
import {
  applyVisibility,
  hiddenPartIds,
  resolveSelection,
  type SavedSelection,
  type SelectionMode,
  type VisibilityState,
} from './selection'
import { canonicalisePose, NO_LOCKS, type AxisLocks, type PivotMode, type ReferenceFrame } from './transform'

/**
 * The workbench controller.
 *
 * Everything `App.tsx` used to hold directly: the tool, the armed part, the
 * camera, the diagnostic view, playback, notices, and every action that reaches
 * the kernel. It lives here so the shell is a layout and the panels are views,
 * and so this behaviour can be tested without mounting a WebGL canvas.
 *
 * The rules the old cockpit established are kept exactly: every mutation goes
 * through `cadEngine.execute` with an expected revision, human and agent share
 * one planner, and nothing writes the document directly.
 */

export interface ArticulationControl {
  edgeId: string
  label: string
  family: string
  canRotate: boolean
  canSlide: boolean
  rotateStep: number
  slideStep: number
  movingCount: number
}

/** Which part of the two-stage Connect interaction the operator is in. */
export interface ConnectFlow {
  stage: 'source' | 'target' | 'review'
  sourcePartId: string | null
  sourceFeatureId: string | null
  targetPartId: string | null
  targetFeatureId: string | null
  /** Which of the ranked mates is previewed. Cycled with Tab. */
  candidateIndex: number
}

export const IDLE_CONNECT: ConnectFlow = {
  stage: 'source',
  sourcePartId: null,
  sourceFeatureId: null,
  targetPartId: null,
  targetFeatureId: null,
  candidateIndex: 0,
}

export interface TransformPrefs {
  frame: ReferenceFrame
  locks: AxisLocks
  pivot: PivotMode
  /** Whether a committed pose is resolved against real connectors. */
  connectorSnap: boolean
  /** Degrees per nudge in the rotation stepper. */
  rotationStep: number
  /** LDU per nudge in the translation stepper. */
  translateStep: number
}

const DEFAULT_TRANSFORM_PREFS: TransformPrefs = {
  frame: 'world',
  locks: NO_LOCKS,
  pivot: 'centre',
  connectorSnap: true,
  rotationStep: 90,
  translateStep: STUD_LDU,
}

/** Ghosting draws each part individually, so it is bounded and says so. */
export const GHOST_LIMIT = 150

export type ModalId = string | null

export function useWorkbench() {
  const state = useCad()

  const [activeColor, setActiveColor] = useState(72)
  const [tool, setToolRaw] = useState<EditorTool>('select')
  const [gridLdu, setGridLdu] = useState(STUD_LDU)
  const [cameraView, setCameraView] = useState<CameraView>('isometric')
  const [renderMode, setRenderMode] = useState<RenderMode>('beauty')
  const [cameraResetKey, setCameraResetKey] = useState(0)
  const [captureRequestId, setCaptureRequestId] = useState<string | null>(null)
  const [playbackStep, setPlaybackStep] = useState<number | null>(null)
  const [toast, setToast] = useState<WorkbenchNotice | null>(null)
  const [placement, setPlacement] = useState<PlacementRequest | null>(null)
  const [toolStatus, setToolStatus] = useState({ native: false, toolCount: 0, mode: state.autonomy })
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(() => session.status)
  const [modal, setModal] = useState<ModalId>(null)
  const [visibility, setVisibility] = useState<VisibilityState>({ hidden: new Set(), isolated: null, ghosted: new Set() })
  const [connect, setConnect] = useState<ConnectFlow>(IDLE_CONNECT)
  const [transformPrefs, setTransformPrefs] = usePersistentState<TransformPrefs>('transform.v1', DEFAULT_TRANSFORM_PREFS)
  const [savedSelections, setSavedSelections] = usePersistentState<SavedSelection[]>('selection-sets.v1', [])
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('part')
  /** Last committed pose, so the numeric fields can show what the gizmo produced. */
  const lastCommittedPose = useRef<{ partId: string; pose: Transform } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const selectedPart = state.selection.length === 1 ? state.document.parts[state.selection[0]] : undefined
  const selectedDefinition = selectedPart ? catalog.get(selectedPart.definitionId) : undefined

  // -- notices --------------------------------------------------------------
  const notify = useCallback((notice: WorkbenchNotice) => setToast(notice), [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 3600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  // -- WebMCP surface -------------------------------------------------------
  useEffect(() => {
    webMcpAdapter.start()
    setToolStatus(webMcpAdapter.getStatus())
    return () => webMcpAdapter.stop()
  }, [])

  // Persistence is driven by the session layer's commit hook, not by rendering:
  // every committed transaction is appended to the durable log immediately.
  useEffect(() => {
    setToolStatus(webMcpAdapter.getStatus())
    setSessionStatus(session.status)
  }, [state.autonomy, state.document])

  // -- agent perception capture handshake ----------------------------------
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

  // -- build playback -------------------------------------------------------
  useEffect(() => {
    if (playbackStep === null || playbackStep >= state.document.steps.length - 1) return
    const timeout = window.setTimeout(() => setPlaybackStep((step) => step === null ? null : step + 1), 720)
    return () => window.clearTimeout(timeout)
  }, [playbackStep, state.document.steps.length])

  // -- the command bus ------------------------------------------------------
  const dispatch = useCallback((label: string, operations: CadOperation[]) => {
    const result = cadEngine.execute(label, operations, 'human', cadEngine.getSnapshot().document.revision)
    if (!result.ok) {
      setToast({ kind: 'error', title: `[${result.error.code}]`, detail: result.error.message })
      return false
    }
    setToast({ kind: 'success', title: label, detail: `Committed atomically · revision ${result.value.resultRevision}` })
    return true
  }, [])

  /**
   * Human commands and WebMCP long-tail commands share the same pure planner.
   * The only difference is attribution; both still commit through CadEngine.
   */
  const runSharedMutation = useCallback((capability: SharedMutationId, args: Record<string, unknown> = {}) => {
    const snapshot = cadEngine.getSnapshot()
    try {
      const plan = planSharedMutation(capability, args, {
        document: snapshot.document,
        selection: snapshot.selection,
        actor: 'human',
      })
      if (!dispatch(plan.label, [...plan.operations])) return false
      if (plan.nextSelection) cadEngine.setSelection([...plan.nextSelection])
      setToast({ kind: 'success', title: plan.label, detail: plan.summary })
      return true
    } catch (cause) {
      const known = cause instanceof SharedCapabilityError
      setToast({
        kind: 'error',
        title: known ? `[${cause.code}]` : '[INVALID_OPERATION]',
        detail: known ? `${cause.message} ${cause.repair}` : cause instanceof Error ? cause.message : String(cause),
      })
      return false
    }
  }, [dispatch])

  // -- selection ------------------------------------------------------------
  const setTool = useCallback((next: EditorTool) => {
    setToolRaw(next)
    // Leaving Connect abandons a half-finished mate rather than leaving a stale
    // source connector armed behind an unrelated tool.
    if (next !== 'connect') setConnect(IDLE_CONNECT)
    else setConnect((flow) => (flow.stage === 'source' ? flow : IDLE_CONNECT))
  }, [])

  const handleSelect = useCallback((partId: string, additive: boolean, subassembly: boolean) => {
    const snapshot = cadEngine.getSnapshot()
    const clicked = snapshot.document.parts[partId]
    if (!clicked) return
    if (subassembly) {
      cadEngine.setSelection(snapshot.document.subassemblies[clicked.subassemblyId]?.partIds ?? [partId])
      return
    }
    if (tool === 'connect') {
      // Two explicit stages. The first click names the part that will move, the
      // second names what it mates onto; neither commits anything on its own.
      setConnect((flow) => {
        if (flow.stage === 'source' || !flow.sourcePartId) {
          cadEngine.setSelection([partId])
          return { ...IDLE_CONNECT, stage: 'target', sourcePartId: partId }
        }
        if (partId === flow.sourcePartId) return flow
        return { ...flow, stage: 'review', targetPartId: partId, candidateIndex: 0 }
      })
      return
    }
    if (additive) {
      cadEngine.setSelection(snapshot.selection.includes(partId) ? snapshot.selection.filter((id) => id !== partId) : [...snapshot.selection, partId])
    } else {
      cadEngine.setSelection([partId])
    }
  }, [tool])

  /** Region select. Additive by default, because it is reached by holding shift. */
  const handleSelectMany = useCallback((partIds: string[], additive: boolean) => {
    const snapshot = cadEngine.getSnapshot()
    const next = additive ? new Set([...snapshot.selection, ...partIds]) : new Set(partIds)
    cadEngine.setSelection([...next])
    if (partIds.length) {
      setToast({
        kind: 'info',
        title: `${partIds.length} part${partIds.length === 1 ? '' : 's'} selected`,
        detail: `${next.size} in the selection. Shift-drag again to add more, or click empty space to clear.`,
      })
    }
  }, [])

  const applySelectionMode = useCallback((mode: SelectionMode) => {
    const snapshot = cadEngine.getSnapshot()
    const hidden = hiddenPartIds(snapshot.document, visibility)
    const next = resolveSelection(mode, { document: snapshot.document, selection: snapshot.selection, hidden })
    cadEngine.setSelection(next)
    setSelectionMode(mode === 'inverse' ? 'part' : mode)
    return next.length
  }, [visibility])

  // -- transforms -----------------------------------------------------------
  const handleTransform = useCallback((partId: string, transform: Transform) => {
    const snapshot = cadEngine.getSnapshot()
    const part = snapshot.document.parts[partId]
    const canonical = canonicalisePose(transform)
    const snapped = part && transformPrefs.connectorSnap
      ? bestSnapTransform(part, snapshot.document, canonical, { radiusLdu: Math.max(4, gridLdu * 0.7) })
      : null
    const committed = canonicalisePose(snapped ?? canonical)
    lastCommittedPose.current = { partId, pose: committed }
    dispatch(snapped ? 'Snap part to connectors' : 'Transform part', [{ type: 'part.transform', partId, transform: committed }])
  }, [dispatch, gridLdu, transformPrefs.connectorSnap])

  /** Commits several poses as one transaction — align, distribute, nudge. */
  const commitTransforms = useCallback((label: string, operations: CadOperation[]) => {
    if (!operations.length) return false
    return dispatch(label, operations)
  }, [dispatch])

  // -- placement ------------------------------------------------------------
  /**
   * Builds the document record for a part at an already-resolved pose.
   *
   * Placement and quick-add differ only in how they arrive at the transform, so
   * everything downstream of that — subassembly, step, colour legality — is
   * decided in one place.
   */
  const buildPartAt = useCallback((definition: PartDefinition, transform: Transform): PartInstance => {
    const snapshot = cadEngine.getSnapshot()
    const selected = snapshot.selection[0] ? snapshot.document.parts[snapshot.selection[0]] : undefined
    const availableColor = definition.availableColors.includes(activeColor)
      ? activeColor
      : (definition.availableColors[0] ?? activeColor)
    return {
      id: createId('part'),
      definitionId: definition.canonicalId,
      color: availableColor,
      transform,
      subassemblyId: selected?.subassemblyId
        ?? Object.values(snapshot.document.subassemblies).find((item) => !item.locked)?.id
        ?? Object.keys(snapshot.document.subassemblies)[0],
      stepId: snapshot.document.steps.at(-1)?.id ?? 'step_1',
      provenance: 'human',
      protected: false,
    }
  }, [activeColor])

  /**
   * Arms a catalog part for click-to-place.
   *
   * Dropping a brick where the operator is looking is the interaction a CAD tool
   * is expected to have; the immediate-add path below stays for the keyboard and
   * for the agent, but it is no longer the only way in.
   */
  const armPart = useCallback((record: Pick<CatalogSearchRecord, 'id' | 'name'>) => {
    const definition = catalog.get(record.id)
    if (!definition) {
      setToast({
        kind: 'error',
        title: 'Part cannot be placed',
        detail: `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
      })
      return false
    }
    const color = definition.availableColors.includes(activeColor)
      ? activeColor
      : (definition.availableColors[0] ?? activeColor)
    setPlacement({ definitionId: definition.canonicalId, color, quarterTurns: 0 })
    setToolRaw('select')
    setConnect(IDLE_CONNECT)
    return true
  }, [activeColor])

  const placeArmed = useCallback((transform: Transform) => {
    if (!placement) return
    const definition = catalog.get(placement.definitionId)
    if (!definition) return
    const part = buildPartAt(definition, canonicalisePose(transform))
    if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part }])) {
      cadEngine.setSelection([part.id])
      // Staying armed is what makes building a wall bearable: the operator keeps
      // clicking, and each click lands another brick.
    }
  }, [buildPartAt, dispatch, placement])

  /**
   * Immediate add, used by the palette's `+` button and by keyboard flows.
   *
   * The pose is proposed from the selection or the model's edge and then handed
   * to the connector solver, so a quick add mates to the build instead of
   * floating beside it.
   */
  const addPart = useCallback((record: Pick<CatalogSearchRecord, 'id' | 'name'>) => {
    const definition = catalog.get(record.id)
    if (!definition) {
      setToast({
        kind: 'error',
        title: 'Part cannot be placed',
        detail: `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
      })
      return false
    }
    const snapshot = cadEngine.getSnapshot()
    const selected = snapshot.selection[0] ? snapshot.document.parts[snapshot.selection[0]] : undefined
    const documentBounds = getDocumentBounds(snapshot.document)
    const size = definition.dimensions?.ldu ?? [STUD_LDU, 0, STUD_LDU]
    let position: Vec3
    if (selected) {
      // Land on the selection's own exposed stud plane where it has one, so the
      // brick sits on top rather than merely above.
      const selectedDefinitionForAdd = catalog.get(selected.definitionId)
      const studs = surfaceAbove(selectedDefinitionForAdd, selected.transform.position[1])
      const bounds = getPartBounds(selected)
      position = [
        selected.transform.position[0],
        originForSurface(definition, studs ?? bounds.min[1]),
        selected.transform.position[2],
      ]
    } else if (snapshot.validation.partCount) {
      position = [documentBounds.max[0] + size[0] / 2 + STUD_LDU, originForSurface(definition, 0), 0]
    } else {
      position = [0, originForSurface(definition, 0), 0]
    }
    const cursor: Transform = { position, basis: IDENTITY_BASIS }
    const part = buildPartAt(definition, cursor)
    const snapped = bestSnapTransform(part, snapshot.document, cursor, { radiusLdu: STUD_LDU })
    const placed = snapped ? { ...part, transform: canonicalisePose(snapped) } : part
    if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part: placed }])) {
      cadEngine.setSelection([placed.id])
      setToolRaw('move')
      return true
    }
    return false
  }, [buildPartAt, dispatch])

  /**
   * Drag-and-drop from the palette.
   *
   * The viewport owns pointer resolution — it is the only thing that knows what
   * is under the cursor in 3D — so a drop arms the part and then replays the
   * equivalent pointer sequence on the canvas. If that does not resolve to a
   * surface the part simply stays armed and one click finishes the job, which is
   * the same fallback a mis-aimed drop deserves.
   */
  const dropPart = useCallback((record: Pick<CatalogSearchRecord, 'id' | 'name'>, clientX: number, clientY: number) => {
    if (!armPart(record)) return false
    const canvas = canvasRef.current
    if (!canvas) return true
    const replay = () => {
      const common = { clientX, clientY, bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' as const }
      canvas.dispatchEvent(new PointerEvent('pointermove', common))
      canvas.dispatchEvent(new PointerEvent('pointerdown', common))
      canvas.dispatchEvent(new PointerEvent('pointerup', common))
    }
    // Two frames: one for the placement controller to mount, one for its effect
    // to attach the listeners it resolves against.
    requestAnimationFrame(() => requestAnimationFrame(replay))
    return true
  }, [armPart])

  // -- everyday edits -------------------------------------------------------
  const duplicateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const selected = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
    const bounds = selected.map(getPartBounds)
    const offset = Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0])) + STUD_LDU
    return runSharedMutation('duplicate_selection', { offsetLdu: [offset, 0, 0] })
  }, [runSharedMutation])

  const deleteSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const committed = dispatch(
      `Remove ${snapshot.selection.length} part${snapshot.selection.length === 1 ? '' : 's'}`,
      snapshot.selection.map((partId) => ({ type: 'part.remove', partId })),
    )
    cadEngine.setSelection([])
    return committed
  }, [dispatch])

  const rotateSelection = useCallback((degrees = 90) => {
    const snapshot = cadEngine.getSnapshot()
    const operations: CadOperation[] = snapshot.selection.map((partId) => {
      const part = snapshot.document.parts[partId]
      // Quarter turn about the part's own vertical axis, composed on the basis
      // so repeated turns cannot drift through Euler round-tripping.
      return {
        type: 'part.transform',
        partId,
        transform: canonicalisePose(rotateLocal(part.transform, [0, 1, 0], (degrees * Math.PI) / 180)),
      }
    })
    if (!operations.length) return false
    return dispatch(degrees === 90 ? 'Quarter-turn selection' : `Turn selection ${degrees}°`, operations)
  }, [dispatch])

  const recolorSelection = useCallback((color: number) => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) {
      setActiveColor(color)
      return false
    }
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
      return true
    }
    return false
  }, [dispatch])

  /** Eyedropper: the selection's colour becomes the palette's active colour. */
  const pickColorFromSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    const first = snapshot.selection.map((id) => snapshot.document.parts[id]).find(Boolean)
    if (!first) {
      setToast({ kind: 'error', title: 'Nothing to sample', detail: 'Select a part first; the eyedropper reads its colour.' })
      return false
    }
    setActiveColor(first.color)
    setToast({ kind: 'info', title: 'Colour picked', detail: `${catalog.color(first.color).name} is now the active colour.` })
    return true
  }, [])

  const protectSelection = useCallback((protect: boolean) => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    return dispatch(
      protect ? 'Protect selection' : 'Unlock selection',
      snapshot.selection.map((partId) => ({ type: 'part.protect', partId, protected: protect })),
    )
  }, [dispatch])

  const toggleProtectSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const allProtected = snapshot.selection.every((id) => snapshot.document.parts[id]?.protected)
    return protectSelection(!allProtected)
  }, [protectSelection])

  // -- proposals ------------------------------------------------------------
  const acceptProposal = useCallback((id: string) => {
    const result = cadEngine.applyProposal(id, 'human')
    setToast(result.ok
      ? { kind: 'success', title: 'Proposal accepted', detail: `Committed as revision ${result.value.resultRevision}` }
      : { kind: 'error', title: `[${result.error.code}]`, detail: result.error.message })
  }, [])

  const rejectProposal = useCallback((id: string) => { cadEngine.rejectProposal(id) }, [])

  /**
   * Stands in for a Codex `build_preflight` call so the collaboration loop can
   * be exercised without the agent attached. It goes through the exact same
   * command bus, revision guard and validation the agent uses.
   */
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
        id: createId(`agent_rack_${index}`),
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

  const importModel = useCallback(async (file: File) => {
    const imported = parseLDraw(await file.text(), cadEngine.getDocument())
    cadEngine.replaceDocument(imported.document)
    setVisibility({ hidden: new Set(), isolated: null, ghosted: new Set() })
    const skipped = imported.report.unknownParts.length + imported.report.withoutGeometry.length
    setToast({
      kind: skipped ? 'info' : 'success',
      title: 'LDraw imported',
      detail: skipped
        ? `${imported.report.placed} parts placed across ${imported.report.submodels} submodels. ${skipped} references had no compiled geometry and were reported, not dropped silently.`
        : `${imported.report.placed} parts across ${imported.report.submodels} submodels are now an editable revisioned CAD document.`,
    })
  }, [])

  // -- mechanism ------------------------------------------------------------
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
      runSharedMutation('articulate_joint', { edgeId, ...request })
    },
    [runSharedMutation],
  )

  /**
   * Regenerates the build sequence from the connection graph.
   *
   * The generated order guarantees each part attaches to structure placed
   * earlier; where it cannot, the part begins a separately-built island and that
   * is reported rather than glossed over.
   */
  const regenerateBuildOrder = useCallback(() => runSharedMutation('apply_build_order'), [runSharedMutation])

  // -- visibility -----------------------------------------------------------
  const hidden = useMemo(() => hiddenPartIds(state.document, visibility), [state.document, visibility])

  const hideSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    setVisibility((current) => ({ ...current, hidden: new Set([...current.hidden, ...snapshot.selection]) }))
    cadEngine.setSelection([])
    return true
  }, [])

  const showEverything = useCallback(() => {
    setVisibility({ hidden: new Set(), isolated: null, ghosted: new Set() })
    return true
  }, [])

  const isolateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    setVisibility((current) => ({ ...current, hidden: new Set(), isolated: new Set(snapshot.selection) }))
    return true
  }, [])

  const ghostSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    if (snapshot.selection.length > GHOST_LIMIT) {
      setToast({
        kind: 'error',
        title: 'Selection too large to ghost',
        detail: `Ghosting draws each part on its own, so it is capped at ${GHOST_LIMIT}. Hide or isolate scales to any size.`,
      })
      return false
    }
    setVisibility((current) => ({ ...current, ghosted: new Set(snapshot.selection) }))
    return true
  }, [])

  /**
   * Frames the camera tightly on the selection.
   *
   * The camera rig frames whatever is drawn, so focus isolates for exactly one
   * frame, bumps the reset key, and restores. That gets a selection-tight frame
   * out of a viewport whose framing contract is document-wide.
   */
  const focusSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) {
      setCameraView('isometric')
      setCameraResetKey((value) => value + 1)
      return true
    }
    const restore = visibility
    setVisibility((current) => ({ ...current, isolated: new Set(snapshot.selection) }))
    setCameraResetKey((value) => value + 1)
    requestAnimationFrame(() => requestAnimationFrame(() => setVisibility(restore)))
    return true
  }, [visibility])

  // -- saved selection sets -------------------------------------------------
  const saveSelectionSet = useCallback((name: string) => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    setSavedSelections((current) => [
      ...current.filter((entry) => entry.name !== name),
      { id: createId('selset'), name, partIds: [...snapshot.selection], revision: snapshot.document.revision },
    ])
    setToast({ kind: 'success', title: 'Selection saved', detail: `“${name}” holds ${snapshot.selection.length} parts.` })
    return true
  }, [setSavedSelections])

  const deleteSelectionSet = useCallback((id: string) => {
    setSavedSelections((current) => current.filter((entry) => entry.id !== id))
  }, [setSavedSelections])

  // -- derived document views ----------------------------------------------
  const playbackFiltered = useMemo(() => {
    if (playbackStep === null) return state.document
    const visible = new Set(state.document.steps.filter((_, index) => index <= playbackStep).flatMap((step) => step.partIds))
    return { ...state.document, parts: Object.fromEntries(Object.entries(state.document.parts).filter(([id]) => visible.has(id))) }
  }, [playbackStep, state.document])

  /** What the viewport draws: playback filtering, then hide/isolate, then ghost. */
  const renderedDocument = useMemo<ModelDocument>(() => {
    const withoutHidden = applyVisibility(playbackFiltered, hidden)
    if (!visibility.ghosted.size) return withoutHidden
    const parts = Object.fromEntries(
      Object.entries(withoutHidden.parts).filter(([id]) => !visibility.ghosted.has(id)),
    )
    return { ...withoutHidden, parts }
  }, [hidden, playbackFiltered, visibility.ghosted])

  /**
   * Ghosted parts, handed to the viewport through its ghost-preview channel.
   *
   * Nothing here is invented: the operations list is genuinely empty, and the
   * validation attached is the document's own current report. It never enters
   * the engine's proposal set, so the review overlay and shared history are
   * unaffected — this is a view of parts the operator asked to see through.
   */
  const viewportProposals = useMemo<Proposal[]>(() => {
    if (!visibility.ghosted.size) return state.proposals
    const ghost: Proposal = {
      id: 'view:ghosted',
      label: 'Ghosted parts',
      author: 'human',
      baseRevision: state.document.revision,
      createdAt: state.document.updatedAt,
      operations: [],
      previewDocument: playbackFiltered,
      validation: state.validation,
      status: 'pending',
    }
    return [...state.proposals, ghost]
  }, [playbackFiltered, state.document.revision, state.document.updatedAt, state.proposals, state.validation, visibility.ghosted.size])

  const selectionLabel = useMemo(() => {
    if (!state.selection.length) return 'No selection'
    if (state.selection.length === 1 && selectedDefinition) return `${selectedDefinition.name} · ${selectedPart?.id}`
    return `${state.selection.length} parts selected`
  }, [selectedDefinition, selectedPart?.id, state.selection.length])

  const placementDefinition = placement ? catalog.get(placement.definitionId) : undefined

  /**
   * One line that says what the viewport will do with the next click.
   *
   * The status strip previously echoed the tool's own name back at the operator,
   * which told them nothing they had not just clicked.
   */
  const viewportHint = useMemo(() => {
    if (placement) return 'Click to place · R to turn'
    if (tool === 'connect') {
      if (connect.stage === 'source') return 'Pick the part to move'
      if (connect.stage === 'target') return 'Pick the part to mate onto · Esc to go back'
      return 'Review the mate · Tab cycles · Enter commits'
    }
    if (tool === 'move') return state.selection.length === 1 ? `Drag the arrows · ${gridLdu} LDU snap` : 'Select one part to move it'
    if (tool === 'rotate') return state.selection.length === 1 ? 'Drag a ring to turn' : 'Select one part to turn it'
    return state.selection.length ? `${state.selection.length} selected · double-click for the module` : 'Click a part · shift-drag to box select'
  }, [connect.stage, gridLdu, placement, state.selection.length, tool])

  const rotatePlacement = useCallback(() => {
    setPlacement((current) => (current ? { ...current, quarterTurns: current.quarterTurns + 1 } : current))
  }, [])

  const cancelPlacement = useCallback(() => setPlacement(null), [])

  const fitView = useCallback(() => {
    setCameraView('isometric')
    setCameraResetKey((value) => value + 1)
  }, [])

  return {
    state,
    selectedPart,
    selectedDefinition,
    activeColor,
    setActiveColor,
    tool,
    setTool,
    gridLdu,
    setGridLdu,
    cameraView,
    setCameraView,
    renderMode,
    setRenderMode,
    cameraResetKey,
    fitView,
    playbackStep,
    setPlaybackStep,
    toast,
    setToast,
    notify,
    placement,
    placementDefinition,
    setPlacement,
    rotatePlacement,
    cancelPlacement,
    toolStatus,
    sessionStatus,
    modal,
    setModal,
    visibility,
    setVisibility,
    hidden,
    connect,
    setConnect,
    transformPrefs,
    setTransformPrefs,
    savedSelections,
    saveSelectionSet,
    deleteSelectionSet,
    selectionMode,
    applySelectionMode,
    articulation,
    driveJoint,
    regenerateBuildOrder,
    renderedDocument,
    viewportProposals,
    selectionLabel,
    viewportHint,
    lastCommittedPose,
    canvasRef,
    dispatch,
    runSharedMutation,
    commitTransforms,
    handleSelect,
    handleSelectMany,
    handleTransform,
    armPart,
    addPart,
    dropPart,
    placeArmed,
    duplicateSelection,
    deleteSelection,
    rotateSelection,
    recolorSelection,
    pickColorFromSelection,
    protectSelection,
    toggleProtectSelection,
    acceptProposal,
    rejectProposal,
    createDemoProposal,
    importModel,
    hideSelection,
    showEverything,
    isolateSelection,
    ghostSelection,
    focusSelection,
  }
}

export type Workbench = ReturnType<typeof useWorkbench>
