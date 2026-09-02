import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findArticulatedJoints } from '../../cad/articulation'
import { planSharedMutation, SharedCapabilityError, type SharedMutationId } from '../../cad/capabilities'
import { catalog, STUD_LDU } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { createId } from '../../cad/ids'
import { eulerDegreesFromBasis } from '../../cad/math'
import { geometryCache } from '../../cad/mesh'
import { parseLDraw, describeLDrawImport } from '../../cad/ldraw'
import { session, type SessionStatus } from '../../cad/session'
import { firstLegalSnap, resolveQuickAdd, type PlacementRequest } from '../../cad/placement'
import type {
  CadOperation,
  CatalogSearchRecord,
  ModelDocument,
  PartDefinition,
  PartInstance,
  Transform,
  Vec3,
} from '../../cad/types'
import type { CameraView, EditorTool, RenderMode } from '../CadViewport'
import { useCad } from '../useCad'
import { webMcpAdapter } from '../../webmcp/adapter'
import type { WorkbenchNotice } from './ExtensionRegistry'
import { summariseProposal } from './proposalReview'
import { usePersistentState } from './persistence'
import { captureParts, planPaste, type PartClipboard } from './clipboard'
import {
  applyVisibility,
  hiddenPartIds,
  resolveSelection,
  type SavedSelection,
  type SelectionMode,
  type VisibilityState,
} from './selection'
import { poseRefusal } from '../../cad/validation'
import {
  applyLocks,
  canonicalisePose,
  posesEqual,
  planGroundSelection,
  resolvePivot,
  translatePose,
  rotatePose,
  numericPose,
  planRotateSelection,
  readSelectionAttitude,
  referenceBasis,
  NO_LOCKS,
  type AxisLocks,
  type PivotMode,
  type ReferenceFrame,
} from './transform'

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
  /**
   * How many times the operator has *asked* for a tool.
   *
   * Several flows switch tools on the operator's behalf — quick-add and a plain
   * click both hand over the Move handles — and the shell needs to tell those
   * apart from a deliberate reach for Move or Rotate, because only the second
   * one is a request for exact numbers. Comparing the tool alone cannot: both
   * arrive as the same value. Only `setTool` advances this.
   */
  const [toolPicks, setToolPicks] = useState(0)
  const [gridLdu, setGridLdu] = useState(STUD_LDU)
  const [cameraView, setCameraView] = useState<CameraView>('isometric')
  const [renderMode, setRenderMode] = useState<RenderMode>('beauty')
  const [cameraResetKey, setCameraResetKey] = useState(0)
  const [captureRequestId, setCaptureRequestId] = useState<string | null>(null)
  const [playbackStep, setPlaybackStepRaw] = useState<number | null>(null)
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [toast, setToast] = useState<WorkbenchNotice | null>(null)
  const [placement, setPlacement] = useState<PlacementRequest | null>(null)
  const [repeatPlacement, setRepeatPlacement] = usePersistentState('placement.repeat.v2', false)
  const partDrag = useRef<'idle' | 'holding' | 'dropping'>('idle')
  const [clipboard, setClipboard] = useState<PartClipboard | null>(null)
  // Where a catalogue drag was released, when the armed part came from a drop.
  // The viewport commits it from its own mount effect; see `dropPart`.
  const [dropPoint, setDropPoint] = useState<{ clientX: number; clientY: number } | null>(null)
  const [toolStatus, setToolStatus] = useState({ native: false, toolCount: 0, mode: state.autonomy })
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(() => session.status)
  const [modal, setModal] = useState<ModalId>(null)
  const [visibility, setVisibility] = useState<VisibilityState>({
    hidden: new Set(),
    isolated: null,
    ghosted: new Set(),
  })
  const [connect, setConnect] = useState<ConnectFlow>(IDLE_CONNECT)
  const [transformPrefs, setTransformPrefs] = usePersistentState<TransformPrefs>(
    'transform.v1',
    DEFAULT_TRANSFORM_PREFS,
  )
  const [savedSelections, setSavedSelections] = usePersistentState<SavedSelection[]>('selection-sets.v1', [])
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('part')
  /** Last committed pose, so the numeric fields can show what the gizmo produced. */
  const lastCommittedPose = useRef<{ partId: string; pose: Transform } | null>(null)
  /** Mirrors `connect` so the viewport's click handler can read it without re-binding. */
  const connectRef = useRef(connect)
  connectRef.current = connect
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const selectedPart = state.selection.length === 1 ? state.document.parts[state.selection[0]] : undefined
  const selectedDefinition = selectedPart ? catalog.get(selectedPart.definitionId) : undefined
  const selectionPosition = useMemo<Vec3>(() => {
    const parts = state.selection.map((id) => state.document.parts[id]).filter(Boolean)
    if (!parts.length) return [0, 0, 0]
    return parts.length === 1 ? parts[0].transform.position : resolvePivot(parts, 'centre')
  }, [state.document.parts, state.selection])
  const selectionAttitude = useMemo(() => {
    const parts = state.selection.map((id) => state.document.parts[id]).filter(Boolean)
    return readSelectionAttitude(parts)
  }, [state.document.parts, state.selection])
  const selectionRotation = selectionAttitude.rotationDegrees

  // -- notices --------------------------------------------------------------
  const notify = useCallback((notice: WorkbenchNotice) => setToast(notice), [])

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
      const detail = (event as CustomEvent<CameraView | { view: CameraView; mode: RenderMode; requestId?: string }>)
        .detail
      const requested = typeof detail === 'string' ? detail : detail.view
      if (['isometric', 'front', 'rear', 'left', 'right', 'top'].includes(requested)) setCameraView(requested)
      if (
        typeof detail !== 'string' &&
        ['beauty', 'orthographic', 'silhouette', 'connections', 'violations', 'exploded'].includes(detail.mode)
      )
        setRenderMode(detail.mode)
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
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [cameraView, captureRequestId, renderMode])

  // -- build playback -------------------------------------------------------
  const stopPlayback = useCallback(() => {
    setPlaybackPlaying(false)
    setPlaybackStepRaw(null)
  }, [])
  const setPlaybackStep = useCallback((index: number | null) => {
    // A step click is a scrub. Only Play advances on a timer.
    setPlaybackPlaying(false)
    setPlaybackStepRaw(index)
  }, [])
  const playBuild = useCallback(() => {
    const total = cadEngine.getDocument().steps.length
    if (!total) return
    setPlaybackPlaying(true)
    setPlaybackStepRaw((current) => (current === null || current >= total - 1 ? 0 : current))
  }, [])
  const pausePlayback = useCallback(() => setPlaybackPlaying(false), [])

  useEffect(() => {
    if (!playbackPlaying || playbackStep === null) return
    if (playbackStep >= state.document.steps.length - 1) {
      setPlaybackPlaying(false)
      return
    }
    const timeout = window.setTimeout(() => setPlaybackStepRaw((step) => (step === null ? null : step + 1)), 720)
    return () => window.clearTimeout(timeout)
  }, [playbackPlaying, playbackStep, state.document.steps.length])

  useEffect(() => {
    if (playbackStep === null) return
    if (!state.document.steps.length) {
      setPlaybackPlaying(false)
      setPlaybackStepRaw(null)
      return
    }
    if (playbackStep >= state.document.steps.length) {
      setPlaybackPlaying(false)
      setPlaybackStepRaw(state.document.steps.length - 1)
    }
  }, [playbackStep, state.document.steps.length])

  // -- the command bus ------------------------------------------------------
  const dispatch = useCallback((label: string, operations: CadOperation[]) => {
    const result = cadEngine.execute(label, operations, 'human', cadEngine.getSnapshot().document.revision)
    if (!result.ok) {
      setToast({
        kind: 'error',
        title: `[${result.error.code}]`,
        detail: result.error.repair ? `${result.error.message} ${result.error.repair}` : result.error.message,
      })
      return false
    }
    setToast({
      kind: 'success',
      title: label,
      detail: `Committed atomically · revision ${result.value.resultRevision}`,
    })
    return true
  }, [])

  const replayHistory = useCallback((direction: 'undo' | 'redo') => {
    const result = cadEngine[direction]('human')
    if (!result.ok) {
      setToast({ kind: 'error', title: `Could not ${direction}`, detail: result.error.message })
      return false
    }
    const document = cadEngine.getDocument()
    // Restored parts should be immediately editable, not silently deselected.
    // Undoing a placement must also clear the now-dead id rather than leaving
    // chrome that still talks about a brick the kernel no longer holds.
    const restored = result.value.affectedPartIds.filter((id) => document.parts[id])
    cadEngine.setSelection(restored)
    setPlacement(null)
    setDropPoint(null)
    setPlaybackPlaying(false)
    setPlaybackStepRaw(null)
    if (!Object.keys(document.parts).length || !restored.length) {
      setToolRaw('select')
      setConnect(IDLE_CONNECT)
    }
    setToast({ kind: 'success', title: result.value.label, detail: `Revision ${result.value.resultRevision}` })
    return true
  }, [])

  /**
   * Human commands and WebMCP long-tail commands share the same pure planner.
   * The only difference is attribution; both still commit through CadEngine.
   */
  const runSharedMutation = useCallback(
    (capability: SharedMutationId, args: Record<string, unknown> = {}) => {
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
    },
    [dispatch],
  )

  // -- selection ------------------------------------------------------------
  const setTool = useCallback((next: EditorTool) => {
    setPlacement(null)
    setDropPoint(null)
    setToolRaw(next)
    setToolPicks((count) => count + 1)
    requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
    // Leaving Connect abandons a half-finished mate rather than leaving a stale
    // source connector armed behind an unrelated tool.
    if (next !== 'connect') {
      setConnect(IDLE_CONNECT)
      return
    }
    // Re-pressing Mate mid-flow must not dump a named target and restart.
    if (connectRef.current.sourcePartId) return
    // Picking up Connect with one part already selected means "connect this" —
    // making the operator click the part they just selected is a stage that
    // asks a question already answered.
    const selected = cadEngine.getSnapshot().selection
    setConnect(selected.length === 1 ? { ...IDLE_CONNECT, stage: 'target', sourcePartId: selected[0] } : IDLE_CONNECT)
  }, [])

  const handleSelect = useCallback(
    (partId: string, additive: boolean, subassembly: boolean) => {
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
        //
        // The transition is computed from a ref rather than inside a `setConnect`
        // updater: React may run an updater during render, and reaching into the
        // engine from there schedules a store update mid-render.
        const flow = connectRef.current
        if (flow.stage === 'source' || !flow.sourcePartId) {
          cadEngine.setSelection([partId])
          setConnect({ ...IDLE_CONNECT, stage: 'target', sourcePartId: partId })
        } else if (partId !== flow.sourcePartId) {
          setConnect({ ...flow, stage: 'review', targetPartId: partId, candidateIndex: 0 })
        }
        return
      }
      if (additive) {
        cadEngine.setSelection(
          snapshot.selection.includes(partId)
            ? snapshot.selection.filter((id) => id !== partId)
            : [...snapshot.selection, partId],
        )
        return
      }
      cadEngine.setSelection([partId])
      // Clicking a brick hands over its handles.
      //
      // Select drew no manipulator, so a newcomer who clicked a part and then
      // dragged it moved nothing at all and had no way to learn that a separate
      // Move mode existed: measured at five actions to shift one brick. Quick-add
      // already ends in Move for exactly this reason; a direct click now agrees
      // with it. Select survives as the mode Escape returns to and as the cheap
      // overlay-highlight path for selections too large to pull out of a batch,
      // but nobody has to find it to start building.
      if (tool === 'select') setToolRaw('move')
    },
    [tool],
  )

  /** Region select. Additive by default, because it is reached by holding shift. */
  const handleSelectMany = useCallback(
    (partIds: string[], additive: boolean) => {
      // Box-select during Connect would rewrite kernel selection without naming
      // a source or target, and HUD/inspector would then disagree with the sheet.
      if (tool === 'connect') return
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
      // Same rule as a single click: selecting in the viewport hands over the
      // handles. Boxing a wall and then finding the drag inert is the same dead
      // end, reached by a different gesture.
      if (tool === 'select' && partIds.length) setToolRaw('move')
    },
    [tool],
  )

  const applySelectionMode = useCallback(
    (mode: SelectionMode) => {
      const snapshot = cadEngine.getSnapshot()
      const hidden = hiddenPartIds(snapshot.document, visibility)
      const next = resolveSelection(mode, { document: snapshot.document, selection: snapshot.selection, hidden })
      cadEngine.setSelection(next)
      setSelectionMode(mode === 'inverse' ? 'part' : mode)
      return next.length
    },
    [visibility],
  )

  // -- transforms -----------------------------------------------------------
  const handleTransform = useCallback(
    (partId: string, transform: Transform, exact = false) => {
      const snapshot = cadEngine.getSnapshot()
      const part = snapshot.document.parts[partId]
      if (!part || posesEqual(part.transform, transform)) return false
      const canonical = canonicalisePose(transform)
      const snapped =
        !exact && transformPrefs.connectorSnap && !Object.values(transformPrefs.locks).some(Boolean)
          ? firstLegalSnap(part, snapshot.document, canonical, { radiusLdu: Math.max(4, gridLdu * 0.7) })
          : null
      const committed = canonicalisePose(snapped ?? canonical)
      if (posesEqual(part.transform, committed)) return false
      const refused = poseRefusal(snapshot.document, partId, committed)
      if (refused) {
        setToast({
          kind: 'error',
          title: `[${refused}]`,
          detail:
            refused === 'COLLISION'
              ? 'That pose would interpenetrate another part. Snap to a free face, or move clear of the overlap.'
              : refused === 'DISCONNECTED'
                ? 'That pose would leave the part hovering with no clutch. Mate it, or rest it on the ground.'
                : refused === 'CONNECTOR_OCCUPIED'
                  ? 'Every stud on that face is taken. Place on the ground, or on a part with free studs.'
                  : 'That surface cannot clutch this part. Place on the ground, or on a face with free studs.',
        })
        return false
      }
      lastCommittedPose.current = { partId, pose: committed }
      return dispatch(snapped ? 'Snap part to connectors' : 'Transform part', [
        { type: 'part.transform', partId, transform: committed },
      ])
    },
    [dispatch, gridLdu, transformPrefs.connectorSnap, transformPrefs.locks],
  )

  /** Commits several poses as one transaction — align, distribute, nudge. */
  const commitTransforms = useCallback(
    (label: string, operations: CadOperation[]) => {
      const snapshot = cadEngine.getSnapshot()
      operations = operations.filter(
        (operation) =>
          operation.type !== 'part.transform' ||
          !snapshot.document.parts[operation.partId] ||
          !posesEqual(snapshot.document.parts[operation.partId].transform, operation.transform),
      )
      if (!operations.length) return false
      const transforms = operations.filter(
        (operation): operation is Extract<CadOperation, { type: 'part.transform' }> =>
          operation.type === 'part.transform',
      )
      if (transforms.length === 1) {
        const operation = transforms[0]
        const refused = poseRefusal(snapshot.document, operation.partId, operation.transform)
        if (refused) {
          setToast({
            kind: 'error',
            title: `[${refused}]`,
            detail:
              refused === 'COLLISION'
                ? 'That pose would interpenetrate another part. Snap to a free face, or move clear of the overlap.'
                : refused === 'DISCONNECTED'
                  ? 'That pose would leave the part hovering with no clutch. Mate it, or rest it on the ground.'
                  : refused === 'CONNECTOR_OCCUPIED'
                    ? 'Every stud on that face is taken. Place on the ground, or on a part with free studs.'
                    : 'That surface cannot clutch this part. Place on the ground, or on a face with free studs.',
          })
          return false
        }
      }
      return dispatch(label, operations)
    },
    [dispatch],
  )

  /** Keyboard nudge of a multi-part selection as one transaction, so clutch is kept. */
  const nudgeSelection = useCallback(
    (dx: number, dz: number, dy = 0) => {
      const snapshot = cadEngine.getSnapshot()
      const operations: CadOperation[] = []
      const lead = snapshot.document.parts[snapshot.selection[0]]
      const frame = referenceBasis(lead, transformPrefs.frame)
      for (const partId of snapshot.selection) {
        const part = snapshot.document.parts[partId]
        if (!part) continue
        const moved = translatePose(part.transform, [dx, dy, dz], transformPrefs.frame, frame ?? undefined)
        const transform = applyLocks(part.transform, moved, transformPrefs.locks, frame)
        if (posesEqual(part.transform, transform)) continue
        operations.push({ type: 'part.transform', partId, transform })
      }
      if (!operations.length) return false
      return commitTransforms(`Nudge ${operations.length} part${operations.length === 1 ? '' : 's'}`, operations)
    },
    [commitTransforms, transformPrefs.frame, transformPrefs.locks],
  )

  /** Commit a finished HUD coordinate as one kernel transaction.
   *
   * Always world LDU, matching the Transform panel's numeric fields. LOCAL/MATE
   * only turn the gizmo and the steppers — typing a world X must not silently
   * become a local X because the frame switch is elsewhere.
   */
  const positionSelection = useCallback(
    (axis: 0 | 1 | 2, value: number) => {
      if (!Number.isFinite(value)) return false
      const snapshot = cadEngine.getSnapshot()
      const parts = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
      if (!parts.length) return false
      const current = parts.length === 1 ? parts[0].transform.position : resolvePivot(parts, 'centre')
      const delta: [number, number, number] = [0, 0, 0]
      delta[axis] = value - current[axis]
      const frame = referenceBasis(parts[0], transformPrefs.frame)
      const operations = parts.flatMap((part) => {
        const transform = applyLocks(
          part.transform,
          translatePose(part.transform, delta, 'world'),
          transformPrefs.locks,
          frame,
        )
        return posesEqual(part.transform, transform)
          ? []
          : [{ type: 'part.transform' as const, partId: part.id, transform }]
      })
      if (!operations.length) return false
      return commitTransforms(`Position ${parts.length} part${parts.length === 1 ? '' : 's'}`, operations)
    },
    [commitTransforms, transformPrefs.frame, transformPrefs.locks],
  )

  /**
   * Euler fields for one part or a rigid group.
   *
   * A single part writes an absolute basis. Several parts turn about the
   * selection centre by the delta from the lead part's displayed Euler, so the
   * numbers stay a group attitude rather than spinning each brick in place.
   */
  const orientSelection = useCallback(
    (axis: 0 | 1 | 2, value: number) => {
      if (!Number.isFinite(value)) return false
      const snapshot = cadEngine.getSnapshot()
      const parts = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
      if (!parts.length) return false
      const lead = parts[0]
      const current = eulerDegreesFromBasis(lead.transform.basis)
      if (parts.length === 1) {
        const rotation = [...current] as [number, number, number]
        rotation[axis] = value
        const next = numericPose(lead.transform, { rotationDegrees: rotation })
        const locked = applyLocks(
          lead.transform,
          next,
          transformPrefs.locks,
          referenceBasis(lead, transformPrefs.frame),
        )
        return handleTransform(lead.id, locked, true)
      }
      const delta = value - current[axis]
      if (Math.abs(delta) < 1e-6) return false
      const vector: [number, number, number] = [0, 0, 0]
      vector[axis] = 1
      const pivot = resolvePivot(parts, transformPrefs.pivot)
      const frame = referenceBasis(lead, transformPrefs.frame)
      if (transformPrefs.locks[(['x', 'y', 'z'] as const)[axis]]) return false
      const operations = parts.flatMap((part) => {
        const transform = rotatePose(part.transform, vector, delta, transformPrefs.frame, pivot, frame ?? undefined)
        return posesEqual(part.transform, transform)
          ? []
          : [{ type: 'part.transform' as const, partId: part.id, transform }]
      })
      if (!operations.length) return false
      return commitTransforms(`Orient ${parts.length} parts`, operations)
    },
    [commitTransforms, handleTransform, transformPrefs.frame, transformPrefs.locks, transformPrefs.pivot],
  )

  // -- placement ------------------------------------------------------------
  /**
   * Builds the document record for a part at an already-resolved pose.
   *
   * Placement and quick-add differ only in how they arrive at the transform, so
   * everything downstream of that — subassembly, step, colour legality — is
   * decided in one place.
   */
  const buildPartAt = useCallback(
    (definition: PartDefinition, transform: Transform): PartInstance => {
      const snapshot = cadEngine.getSnapshot()
      const selected = snapshot.selection[0] ? snapshot.document.parts[snapshot.selection[0]] : undefined
      const availableColor = activeColor
      return {
        id: createId('part'),
        definitionId: definition.canonicalId,
        color: availableColor,
        transform,
        subassemblyId:
          selected?.subassemblyId ??
          Object.values(snapshot.document.subassemblies).find((item) => !item.locked)?.id ??
          Object.keys(snapshot.document.subassemblies)[0],
        stepId: snapshot.document.steps.at(-1)?.id ?? 'step_1',
        provenance: 'human',
        protected: false,
      }
    },
    [activeColor],
  )

  /**
   * Arms a catalog part for click-to-place.
   *
   * Dropping a brick where the operator is looking is the interaction a CAD tool
   * is expected to have; the immediate-add path below stays for the keyboard and
   * for the agent, but it is no longer the only way in.
   */
  const armPart = useCallback(
    (record: Pick<CatalogSearchRecord, 'id' | 'name'>) => {
      const definition = catalog.get(record.id)
      if (!definition) {
        setToast({
          kind: 'error',
          title: 'Part cannot be placed',
          detail: `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
        })
        return false
      }
      const color = activeColor
      void geometryCache.load(definition)
      setPlacement({ definitionId: definition.canonicalId, color, quarterTurns: 0 })
      setDropPoint(null)
      setToolRaw('select')
      setConnect(IDLE_CONNECT)
      return true
    },
    [activeColor],
  )

  const placeArmed = useCallback(
    (transform: Transform, legal = true, reason?: string) => {
      if (!placement) return false
      if (!legal) {
        const title =
          reason === 'occupied'
            ? '[CONNECTOR_OCCUPIED]'
            : reason === 'collision'
              ? '[COLLISION]'
              : '[NO_COMPATIBLE_CONNECTOR]'
        setToast({
          kind: 'error',
          title,
          detail:
            reason === 'occupied'
              ? 'Every stud on that face is taken. Place on the ground, or on a part with free studs.'
              : reason === 'collision'
                ? 'That pose would interpenetrate another part. Place on remaining free studs, or on the ground.'
                : 'That surface cannot clutch this part. Place on the ground, or on a face with free studs.',
        })
        return false
      }
      const definition = catalog.get(placement.definitionId)
      if (!definition) {
        setToast({
          kind: 'error',
          title: 'Part cannot be placed',
          detail: `${placement.definitionId} is armed, but this build has no compiled geometry for it.`,
        })
        setPlacement(null)
        return false
      }
      if (placement.movingPartId) {
        const original = cadEngine.getDocument().parts[placement.movingPartId]
        if (!original) {
          setPlacement(null)
          return false
        }
        const pose = canonicalisePose(transform)
        if (
          !posesEqual(original.transform, pose) &&
          !commitTransforms('Reposition part', [{ type: 'part.transform', partId: original.id, transform: pose }])
        )
          return false
        setPlacement(null)
        setDropPoint(null)
        cadEngine.setSelection([original.id])
        return true
      }
      const part = buildPartAt(definition, canonicalisePose(transform))
      if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part }])) {
        cadEngine.setSelection([part.id])
        if (!repeatPlacement) setPlacement(null)
        return true
      }
      return false
    },
    [buildPartAt, commitTransforms, dispatch, placement, repeatPlacement],
  )

  /** Pick up a placed brick, or use it as the palette for another of the same. */
  const pickUpSelection = useCallback((copy = false) => {
    const snapshot = cadEngine.getSnapshot()
    if (snapshot.selection.length !== 1) return false
    const part = snapshot.document.parts[snapshot.selection[0]]
    if (!part) return false
    setActiveColor(part.color)
    setPlacement({
      definitionId: part.definitionId,
      color: part.color,
      basis: part.transform.basis,
      quarterTurns: 0,
      ...(copy ? {} : { movingPartId: part.id }),
    })
    setToolRaw('select')
    setConnect(IDLE_CONNECT)
    setDropPoint(null)
    requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
    return true
  }, [])

  /**
   * Immediate add, used by the palette's `+` button and by keyboard flows.
   *
   * The pose is proposed from the selection or the model's edge and then handed
   * to the connector solver, so a quick add mates to the build instead of
   * floating beside it.
   */
  const addPart = useCallback(
    (record: Pick<CatalogSearchRecord, 'id' | 'name'>) => {
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
      const selectedId = snapshot.selection[0] ?? null
      const resolved = resolveQuickAdd(
        {
          definitionId: definition.canonicalId,
          color: activeColor,
          quarterTurns: 0,
        },
        snapshot.document,
        selectedId,
        gridLdu,
      )
      if (!resolved) {
        setToast({
          kind: 'error',
          title: 'Part cannot be placed',
          detail: catalog.get(record.id)
            ? `${record.name} could not be seated on the ground or the current selection.`
            : `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
        })
        return false
      }
      if (selectedId && !resolved.legal) {
        setToast({
          kind: 'error',
          title:
            resolved.reason === 'occupied'
              ? '[CONNECTOR_OCCUPIED]'
              : resolved.reason === 'collision'
                ? '[COLLISION]'
                : '[NO_COMPATIBLE_CONNECTOR]',
          detail:
            resolved.reason === 'occupied'
              ? 'Every exclusive connector on the selected part is taken. Pick a different anchor.'
              : resolved.reason === 'collision'
                ? 'That pose would interpenetrate another part. Pick a different anchor, or place on the ground.'
                : `${definition.name} does not clutch to the selected part. Rotate it, pick a different identity, or click a stud the part can actually mate with.`,
        })
        return false
      }
      const part = buildPartAt(definition, canonicalisePose(resolved.transform))
      if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part }])) {
        cadEngine.setSelection([part.id])
        setToolRaw('move')
        requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
        return true
      }
      return false
    },
    [activeColor, buildPartAt, dispatch, gridLdu],
  )

  // Picking up, previewing and releasing all use the same placement request.
  // Drag-end may run before React consumes the drop, so keep that handoff alive.
  const beginPartDrag = useCallback(
    (record: Pick<CatalogSearchRecord, 'id' | 'name'>) => {
      if (!armPart(record)) return false
      partDrag.current = 'holding'
      return true
    },
    [armPart],
  )

  const endPartDrag = useCallback(() => {
    if (partDrag.current === 'holding') {
      setPlacement(null)
      setDropPoint(null)
    }
    if (partDrag.current !== 'dropping') partDrag.current = 'idle'
  }, [])

  const dropPart = useCallback(
    (record: Pick<CatalogSearchRecord, 'id' | 'name'>, clientX: number, clientY: number) => {
      if (partDrag.current !== 'holding' && !armPart(record)) return false
      partDrag.current = 'dropping'
      setDropPoint({ clientX, clientY })
      return true
    },
    [armPart],
  )

  /**
   * Land a part that was dragged off its seat.
   *
   * The pick-up already armed a placement carrying `movingPartId`, so this is
   * the palette's own drop path: the release point resolves to a snapped,
   * legality-checked pose and the commit reseats the original part instead of
   * adding a copy.
   */
  const dropReposition = useCallback((clientX: number, clientY: number) => {
    setDropPoint({ clientX, clientY })
  }, [])

  /** A release ends the gesture, including refused landings. No surprise second placement. */
  const finishDrop = useCallback(() => {
    partDrag.current = 'idle'
    setDropPoint(null)
    setPlacement(null)
  }, [])

  // -- everyday edits -------------------------------------------------------
  const duplicateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const selected = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
    const bounds = selected.map(getPartBounds)
    const right = Math.max(...Object.values(snapshot.document.parts).map((part) => getPartBounds(part).max[0]))
    const offset = Math.ceil((right - Math.min(...bounds.map((item) => item.min[0])) + STUD_LDU) / STUD_LDU) * STUD_LDU
    // Copying a roof brick should not leave its clone hovering at roof height.
    return runSharedMutation('duplicate_selection', {
      offsetLdu: [offset, -Math.max(...bounds.map((item) => item.max[1])), 0],
    })
  }, [runSharedMutation])

  const deleteSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const committed = dispatch(
      `Remove ${snapshot.selection.length} part${snapshot.selection.length === 1 ? '' : 's'}`,
      snapshot.selection.map((partId) => ({ type: 'part.remove', partId })),
    )
    if (committed) cadEngine.setSelection([])
    return committed
  }, [dispatch])

  const copySelection = useCallback(
    (cut = false) => {
      const snapshot = cadEngine.getSnapshot()
      try {
        const next = captureParts(snapshot.document, snapshot.selection, cut)
        if (!next) return false
        // A refused cut must preserve both the old clipboard and the selection.
        if (cut && !deleteSelection()) return false
        setClipboard(next)
        setToast({
          kind: 'info',
          title: `${cut ? 'Cut' : 'Copied'} ${next.parts.length} part${next.parts.length === 1 ? '' : 's'}`,
          detail: 'Saved in the editor clipboard. Paste here or in another project during this editor session.',
        })
        return true
      } catch (cause) {
        setToast({ kind: 'error', title: 'Could not copy selection', detail: String(cause) })
        return false
      }
    },
    [deleteSelection],
  )

  const pasteSelection = useCallback(() => {
    if (!clipboard) return false
    try {
      const plan = planPaste(cadEngine.getDocument(), clipboard)
      if (!dispatch(`Paste ${plan.selection.length} part${plan.selection.length === 1 ? '' : 's'}`, plan.operations))
        return false
      cadEngine.setSelection(plan.selection)
      setClipboard({ ...clipboard, cut: false })
      setPlacement(null)
      setToolRaw('move')
      return true
    } catch (cause) {
      setToast({ kind: 'error', title: 'Could not paste selection', detail: String(cause) })
      return false
    }
  }, [clipboard, dispatch])

  const groundSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    return commitTransforms(
      'Ground selection',
      planGroundSelection(snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)),
    )
  }, [commitTransforms])

  useEffect(() => {
    setPlacement((current) => (current && !current.movingPartId ? { ...current, color: activeColor } : current))
  }, [activeColor])

  useEffect(() => {
    if (placement?.movingPartId && !state.document.parts[placement.movingPartId]) {
      setPlacement(null)
      setDropPoint(null)
    }
  }, [placement?.movingPartId, state.document.parts])

  // Transient tools and hidden ids belong to a document, not to the next opened project.
  useEffect(() => {
    setPlacement(null)
    setDropPoint(null)
    setConnect(IDLE_CONNECT)
    setPlaybackStep(null)
    setVisibility({ hidden: new Set(), isolated: null, ghosted: new Set() })
  }, [state.document.id])

  const rotateSelection = useCallback(
    (degrees = 90) => {
      const snapshot = cadEngine.getSnapshot()
      const parts = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
      const operations = planRotateSelection(parts, degrees)
      if (!operations.length) return false
      return commitTransforms(degrees === 90 ? 'Quarter-turn selection' : `Turn selection ${degrees}°`, operations)
    },
    [commitTransforms],
  )

  const recolorSelection = useCallback(
    (color: number) => {
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
      if (
        dispatch(
          'Recolor selection',
          snapshot.selection.map((partId) => ({ type: 'part.recolor', partId, color })),
        )
      ) {
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
    },
    [dispatch],
  )

  /** Eyedropper: the selection's colour becomes the palette's active colour. */
  const pickColorFromSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    const first = snapshot.selection.map((id) => snapshot.document.parts[id]).find(Boolean)
    if (!first) {
      setToast({
        kind: 'error',
        title: 'Nothing to sample',
        detail: 'Select a part first; the eyedropper reads its colour.',
      })
      return false
    }
    setActiveColor(first.color)
    setToast({
      kind: 'info',
      title: 'Colour picked',
      detail: `${catalog.color(first.color).name} is now the active colour.`,
    })
    return true
  }, [])

  const protectSelection = useCallback(
    (protect: boolean) => {
      const snapshot = cadEngine.getSnapshot()
      if (!snapshot.selection.length) return false
      return dispatch(
        protect ? 'Protect selection' : 'Unlock selection',
        snapshot.selection.map((partId) => ({ type: 'part.protect', partId, protected: protect })),
      )
    },
    [dispatch],
  )

  const toggleProtectSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return false
    const allProtected = snapshot.selection.every((id) => snapshot.document.parts[id]?.protected)
    return protectSelection(!allProtected)
  }, [protectSelection])

  // -- proposals ------------------------------------------------------------
  const acceptProposal = useCallback((id: string) => {
    const snapshot = cadEngine.getSnapshot()
    const proposal = snapshot.proposals.find((entry) => entry.id === id)
    if (!proposal) {
      setToast({ kind: 'error', title: '[PROPOSAL_NOT_FOUND]', detail: `Proposal ${id} does not exist.` })
      return
    }
    const summary = summariseProposal(proposal, snapshot)
    if (!summary.ready) {
      setToast({
        kind: 'error',
        title: 'Proposal is not ready to commit',
        detail: summary.blockers[0] ?? 'The kernel marked this preview unhealthy.',
      })
      return
    }
    const result = cadEngine.applyProposal(id, 'human')
    setToast(
      result.ok
        ? {
            kind: 'success',
            title: 'Proposal accepted',
            detail: `Committed as revision ${result.value.resultRevision}`,
          }
        : { kind: 'error', title: `[${result.error.code}]`, detail: result.error.message },
    )
  }, [])

  const rejectProposal = useCallback((id: string) => {
    const result = cadEngine.rejectProposal(id)
    setToast(
      result.ok
        ? { kind: 'info', title: 'Proposal rejected', detail: result.value.label }
        : { kind: 'error', title: `[${result.error.code}]`, detail: result.error.message },
    )
  }, [])

  const importModel = useCallback(async (file: File) => {
    const imported = parseLDraw(await file.text(), cadEngine.getDocument())
    cadEngine.replaceDocument(imported.document)
    setVisibility({ hidden: new Set(), isolated: null, ghosted: new Set() })
    const copy = describeLDrawImport(imported.report)
    setToast({
      kind: imported.report.unknownParts.length + imported.report.withoutGeometry.length ? 'info' : 'success',
      title: copy.title,
      detail: copy.detail,
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
      canRotate:
        joint.joint.kind === 'revolute' || joint.joint.kind === 'cylindrical' || joint.joint.kind === 'spherical',
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

  /** Frame the selection without temporarily hiding the rest of the model. */
  const focusSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (snapshot.selection.length && window.__brickwrightRenderer?.frameParts(snapshot.selection)) return true
    setCameraResetKey((value) => value + 1)
    return true
  }, [])

  // -- saved selection sets -------------------------------------------------
  const saveSelectionSet = useCallback(
    (name: string) => {
      const snapshot = cadEngine.getSnapshot()
      if (!snapshot.selection.length) return false
      setSavedSelections((current) => [
        ...current.filter((entry) => entry.name !== name),
        { id: createId('selset'), name, partIds: [...snapshot.selection], revision: snapshot.document.revision },
      ])
      setToast({
        kind: 'success',
        title: 'Selection saved',
        detail: `“${name}” holds ${snapshot.selection.length} parts.`,
      })
      return true
    },
    [setSavedSelections],
  )

  const deleteSelectionSet = useCallback(
    (id: string) => {
      setSavedSelections((current) => current.filter((entry) => entry.id !== id))
    },
    [setSavedSelections],
  )

  // -- derived document views ----------------------------------------------
  const playbackFiltered = useMemo(() => {
    if (playbackStep === null) return state.document
    const visible = new Set(
      state.document.steps.filter((_, index) => index <= playbackStep).flatMap((step) => step.partIds),
    )
    return {
      ...state.document,
      parts: Object.fromEntries(Object.entries(state.document.parts).filter(([id]) => visible.has(id))),
    }
  }, [playbackStep, state.document])

  /** What the viewport draws: playback filtering, then hide/isolate, then ghost. */
  const renderedDocument = useMemo<ModelDocument>(() => {
    const withoutHidden = applyVisibility(playbackFiltered, hidden)
    if (!visibility.ghosted.size) return withoutHidden
    const parts = Object.fromEntries(Object.entries(withoutHidden.parts).filter(([id]) => !visibility.ghosted.has(id)))
    return { ...withoutHidden, parts }
  }, [hidden, playbackFiltered, visibility.ghosted])

  /**
   * Kernel preflights only. Operator-ghosted parts already draw through the
   * visibility ghost channel; stuffing them into this array as a pending
   * proposal made GhostProposal treat see-through bricks as an agent preview.
   */
  const viewportProposals = state.proposals

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
      return 'Review the mate · Tab cycles solutions · Shift+Tab leaves · Enter commits · Esc backs out'
    }
    if (tool === 'move')
      return state.selection.length ? `Drag the arrows · ${gridLdu} LDU snap` : 'Select parts to move them'
    if (tool === 'rotate') return state.selection.length ? 'Drag a ring to turn' : 'Select parts to turn them'
    return state.selection.length
      ? `${state.selection.length} selected · double-click for the module`
      : 'Click a part · shift-drag to box select'
  }, [connect.stage, gridLdu, placement, state.selection.length, tool])

  const rotatePlacement = useCallback((direction = 1) => {
    setPlacement((current) => (current ? { ...current, quarterTurns: current.quarterTurns + direction } : current))
  }, [])

  const cancelPlacement = useCallback(() => {
    partDrag.current = 'idle'
    setPlacement(null)
    setDropPoint(null)
  }, [])

  const fitView = useCallback(() => {
    if (!window.__brickwrightRenderer?.frameParts(Object.keys(cadEngine.getDocument().parts))) {
      setCameraResetKey((value) => value + 1)
    }
  }, [])

  return {
    state,
    selectedPart,
    selectedDefinition,
    selectionPosition,
    selectionRotation,
    selectionAttitude,
    activeColor,
    setActiveColor,
    toolPicks,
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
    playbackPlaying,
    setPlaybackStep,
    playBuild,
    pausePlayback,
    stopPlayback,
    toast,
    setToast,
    notify,
    placement,
    placementDefinition,
    setPlacement,
    rotatePlacement,
    repeatPlacement,
    setRepeatPlacement,
    pickUpSelection,
    dropReposition,
    cancelPlacement,
    dropPoint,
    finishDrop,
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
    replayHistory,
    runSharedMutation,
    commitTransforms,
    nudgeSelection,
    positionSelection,
    orientSelection,
    handleSelect,
    handleSelectMany,
    handleTransform,
    armPart,
    addPart,
    dropPart,
    beginPartDrag,
    endPartDrag,
    placeArmed,
    duplicateSelection,
    clipboard,
    copySelection,
    pasteSelection,
    groundSelection,
    deleteSelection,
    rotateSelection,
    recolorSelection,
    pickColorFromSelection,
    protectSelection,
    toggleProtectSelection,
    acceptProposal,
    rejectProposal,
    importModel,
    hideSelection,
    showEverything,
    isolateSelection,
    ghostSelection,
    focusSelection,
  }
}

export type Workbench = ReturnType<typeof useWorkbench>
