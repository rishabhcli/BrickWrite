import {
  BoxSelect,
  BringToFront,
  Check,
  CircleHelp,
  CircleDot,
  Command,
  Copy,
  Eye,
  Focus,
  Grid3X3,
  Layers3,
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
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { findArticulatedJoints } from './cad/articulation'
import { planSharedMutation, SharedCapabilityError, type SharedMutationId } from './cad/capabilities'
import { catalog, originForSurface, searchCatalog, STUD_LDU, surfaceAbove } from './cad/catalog'
import { IDENTITY_BASIS, rotateLocal } from './cad/math'
import { createId } from './cad/ids'
import { cadEngine } from './cad/engine'
import { getDocumentBounds, getPartBounds } from './cad/geometry'
import { parseLDraw } from './cad/ldraw'
import { bestSnapTransform } from './cad/snapping'
import { session, type SessionStatus } from './cad/session'
import type { CadOperation, CatalogSearchRecord, PartDefinition, PartInstance, Transform, Vec3 } from './cad/types'
import { CadViewport, type CameraView, type EditorTool, type PlacementRequest, type RenderMode } from './editor/CadViewport'
import { CommandDeck } from './editor/CommandDeck'
import { ExportCenter } from './editor/ExportCenter'
import { AutonomySwitch, CatalogPanel, InspectorPanel, Timeline, type ArticulationControl } from './editor/Panels'
import { ProjectMenu } from './editor/ProjectMenu'
import { ShortcutGuide } from './editor/ShortcutGuide'
import { markWelcomeSeen, WelcomeGuide, welcomeUnseen } from './editor/WelcomeGuide'
import { useCad } from './editor/useCad'
import { webMcpAdapter } from './webmcp/adapter'

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
  const [cameraResetKey, setCameraResetKey] = useState(0)
  const [captureRequestId, setCaptureRequestId] = useState<string | null>(null)
  const [playbackStep, setPlaybackStep] = useState<number | null>(null)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(() => welcomeUnseen())
  const [commandOpen, setCommandOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [placement, setPlacement] = useState<PlacementRequest | null>(null)
  const [toolStatus, setToolStatus] = useState({ native: false, toolCount: 0, mode: state.autonomy })
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(() => session.status)

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
      runSharedMutation('connect_parts', { movingPartId: clicked.id, targetPartId: target.id })
      return
    }
    if (additive) {
      cadEngine.setSelection(snapshot.selection.includes(partId) ? snapshot.selection.filter((id) => id !== partId) : [...snapshot.selection, partId])
    } else {
      cadEngine.setSelection([partId])
    }
  }, [runSharedMutation, tool])

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

  const handleTransform = useCallback((partId: string, transform: Transform) => {
    const snapshot = cadEngine.getSnapshot()
    const part = snapshot.document.parts[partId]
    const snapped = part ? bestSnapTransform(part, snapshot.document, transform, { radiusLdu: Math.max(4, gridLdu * 0.7) }) : null
    dispatch(snapped ? 'Snap part to connectors' : 'Transform part', [{ type: 'part.transform', partId, transform: snapped ?? transform }])
  }, [dispatch, gridLdu])

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
  const armPart = useCallback((record: CatalogSearchRecord) => {
    const definition = catalog.get(record.id)
    if (!definition) {
      setToast({
        kind: 'error',
        title: 'Part cannot be placed',
        detail: `${record.name} is a real catalog identity, but this build has no compiled geometry for it.`,
      })
      return
    }
    const color = definition.availableColors.includes(activeColor)
      ? activeColor
      : (definition.availableColors[0] ?? activeColor)
    setPlacement({ definitionId: definition.canonicalId, color, quarterTurns: 0 })
    setTool('select')
  }, [activeColor])

  const placeArmed = useCallback((transform: Transform) => {
    if (!placement) return
    const definition = catalog.get(placement.definitionId)
    if (!definition) return
    const part = buildPartAt(definition, transform)
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
      // Land on the selection's own exposed stud plane where it has one, so the
      // brick sits on top rather than merely above.
      const selectedDefinition = catalog.get(selected.definitionId)
      const studs = surfaceAbove(selectedDefinition, selected.transform.position[1])
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
    const placed = snapped ? { ...part, transform: snapped } : part
    if (dispatch(`Place ${definition.name}`, [{ type: 'part.add', part: placed }])) {
      cadEngine.setSelection([placed.id])
      setTool('move')
    }
  }, [buildPartAt, dispatch])

  const duplicateSelection = useCallback(() => {
    const snapshot = cadEngine.getSnapshot()
    if (!snapshot.selection.length) return
    const selected = snapshot.selection.map((id) => snapshot.document.parts[id]).filter(Boolean)
    const bounds = selected.map(getPartBounds)
    const offset = Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0])) + STUD_LDU
    runSharedMutation('duplicate_selection', { offsetLdu: [offset, 0, 0] })
  }, [runSharedMutation])

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
  const regenerateBuildOrder = useCallback(() => {
    runSharedMutation('apply_build_order')
  }, [runSharedMutation])

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
    const skipped = imported.report.unknownParts.length + imported.report.withoutGeometry.length
    setToast({
      kind: skipped ? 'info' : 'success',
      title: 'LDraw imported',
      detail: skipped
        ? `${imported.report.placed} parts placed across ${imported.report.submodels} submodels. ${skipped} references had no compiled geometry and were reported, not dropped silently.`
        : `${imported.report.placed} parts across ${imported.report.submodels} submodels are now an editable revisioned CAD document.`,
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const modifier = event.metaKey || event.ctrlKey
      if (welcomeOpen) return
      if (commandOpen) {
        if (event.key === 'Escape' || (modifier && event.key === '/')) {
          event.preventDefault()
          setCommandOpen(false)
        }
        // Commands never leak through a modal surface into the viewport.
        return
      }
      if (shortcutOpen) {
        if (event.key === 'Escape' || event.key === '?') {
          event.preventDefault()
          setShortcutOpen(false)
        }
        // A modal command map must not let keystrokes mutate the model behind it.
        return
      }
      if (modifier && event.key === '/') {
        event.preventDefault()
        setShortcutOpen(false)
        setCommandOpen(true)
        return
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('[data-catalog-search]')?.focus()
        return
      }
      if (target.matches('input, textarea, select')) return
      if (event.key === '?') {
        event.preventDefault()
        setShortcutOpen((value) => !value)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // Menus and dialogs own their own Escape lifecycle. Returning here
        // prevents closing an export panel from also rejecting a CAD proposal.
        if (document.querySelector('.export-panel, .project-panel')) return
        if (placement) setPlacement(null)
        else if (playbackStep !== null) setPlaybackStep(null)
        else {
          const proposal = cadEngine.getSnapshot().proposals[0]
          if (proposal) cadEngine.rejectProposal(proposal.id)
          setTool('select')
          setRenderMode('beauty')
        }
        return
      }
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? cadEngine.redo('human') : cadEngine.undo('human')
      } else if (modifier && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
      } else if (event.key === 'Enter') {
        const proposal = cadEngine.getSnapshot().proposals[0]
        if (proposal) acceptProposal(proposal.id)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelection()
      } else if (event.key.toLowerCase() === 'g') setTool('move')
      else if (event.key.toLowerCase() === 'r') {
        // While a ghost follows the cursor, R turns the ghost. Only once nothing
        // is armed does it mean "pick up the rotate tool".
        if (placement) setPlacement({ ...placement, quarterTurns: placement.quarterTurns + 1 })
        else setTool('rotate')
      }
      else if (event.key.toLowerCase() === 'c') setTool('connect')
      else if (event.key.toLowerCase() === 'v' || event.key === '1') setTool('select')
      else if (event.key.toLowerCase() === 'f') {
        setCameraView('isometric')
        setCameraResetKey((value) => value + 1)
      } else if (event.key.toLowerCase() === 'l') {
        const snapshot = cadEngine.getSnapshot()
        if (snapshot.selection.length) {
          const allProtected = snapshot.selection.every((id) => snapshot.document.parts[id]?.protected)
          protectSelection(!allProtected)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commandOpen, deleteSelection, duplicateSelection, placement, playbackStep, protectSelection, shortcutOpen, welcomeOpen])

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
    if (tool === 'connect') return state.selection.length === 1 ? 'Pick the part to mate onto' : 'Select the part to move first'
    if (tool === 'move') return state.selection.length === 1 ? `Drag the arrows · ${gridLdu} LDU snap` : 'Select one part to move it'
    if (tool === 'rotate') return state.selection.length === 1 ? 'Drag a ring to turn' : 'Select one part to turn it'
    return state.selection.length ? `${state.selection.length} selected · double-click for the module` : 'Click a part · shift-drag to box select'
  }, [gridLdu, placement, state.selection.length, tool])

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
        <ProjectMenu
          documentName={state.document.name}
          documentId={state.document.id}
          revision={state.document.revision}
          sessionStatus={sessionStatus}
          onNotice={setToast}
        />
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
          <IconButton icon={<Copy />} label="Duplicate selection" shortcut="⌘D" onClick={duplicateSelection} disabled={!state.selection.length} />
          <IconButton icon={<Rotate3d />} label="Quarter turn" onClick={rotateSelection} disabled={!state.selection.length} />
          <IconButton icon={<Lock />} label="Protect selection from agent edits" shortcut="L" onClick={() => protectSelection(true)} disabled={!state.selection.length} />
          <IconButton icon={<Trash2 />} label="Remove selection" shortcut="Delete" onClick={deleteSelection} disabled={!state.selection.length} />
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
        <div className="toolgroup camera-tools" role="group" aria-label="Camera view">
          <IconButton icon={<Eye />} label="Isometric view" active={cameraView === 'isometric'} onClick={() => setCameraView('isometric')} />
          <IconButton icon={<BringToFront />} label="Front view" active={cameraView === 'front'} onClick={() => setCameraView('front')} />
          <IconButton icon={<Maximize2 />} label="Top view" active={cameraView === 'top'} onClick={() => setCameraView('top')} />
          <IconButton icon={<Focus />} label="Fit model to view" shortcut="F" onClick={() => { setCameraView('isometric'); setCameraResetKey((value) => value + 1) }} />
        </div>
        <label className="render-picker">
          <Layers3 size={14} />
          <span>VIEW</span>
          <select value={renderMode} onChange={(event) => setRenderMode(event.target.value as RenderMode)} aria-label="Viewport render mode">
            <option value="beauty">Beauty</option>
            <option value="orthographic">Orthographic</option>
            <option value="connections">Connections</option>
            <option value="violations">Violations</option>
            <option value="silhouette">Silhouette</option>
            <option value="exploded">Exploded</option>
          </select>
        </label>
        <div className="rail-divider" />
        <div className="toolgroup compact-tools">
          <IconButton icon={<Undo2 />} label={state.canUndo ? `Undo ${state.transactions.at(-1)?.label ?? ''}`.trim() : 'Nothing to undo'} shortcut="⌘Z" onClick={() => cadEngine.undo('human')} disabled={!state.canUndo} />
          <IconButton icon={<Redo2 />} label="Redo" shortcut="⇧⌘Z" onClick={() => cadEngine.redo('human')} disabled={!state.canRedo} />
          <IconButton icon={<Command />} label="Command deck" shortcut="⌘/" onClick={() => { setShortcutOpen(false); setCommandOpen(true) }} />
          <IconButton icon={<CircleHelp />} label="Keyboard shortcuts" shortcut="?" onClick={() => { setCommandOpen(false); setShortcutOpen(true) }} />
        </div>
        <ExportCenter state={state} onImport={importModel} onNotice={setToast} />
      </nav>

      <div className="workspace">
        <CatalogPanel
          activeColor={activeColor}
          armedId={placement?.definitionId ?? null}
          onColorChange={setActiveColor}
          onAdd={addPart}
          onArm={armPart}
        />
        <section className="viewport-shell" aria-label="Three-dimensional CAD viewport" data-render-mode={renderMode}>
          <CadViewport
            document={renderedDocument}
            selection={state.selection}
            proposals={state.proposals}
            tool={tool}
            gridLdu={gridLdu}
            cameraView={cameraView}
            cameraResetKey={cameraResetKey}
            renderMode={renderMode}
            placement={placement}
            onSelect={handleSelect}
            onSelectMany={handleSelectMany}
            onClearSelection={() => cadEngine.setSelection([])}
            onTransform={handleTransform}
            onPlace={placeArmed}
            onCanvasReady={(canvas) => { window.__brickwrightCanvas = canvas }}
          />
          <div className="viewport-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          <div className="viewport-breadcrumb"><span>ASSEMBLY</span><b>/</b><strong>{selectedPart ? state.document.subassemblies[selectedPart.subassemblyId]?.name : 'MASTER MODEL'}</strong></div>
          <div className="viewport-title-block">
            <span className="eyebrow">CATALOG-BACKED ASSEMBLY / REV {state.document.revision}</span>
            <h1 title={state.document.name}><span>{state.document.name}</span> <em>// R{String(state.document.revision).padStart(2, '0')}</em></h1>
            <p>{selectionLabel}</p>
          </div>
          <div className="viewport-metrics">
            <Metric label="PARTS" value={String(state.validation.partCount).padStart(3, '0')} />
            <Metric label="CONNECTIONS" value={String(state.validation.connectionCount).padStart(3, '0')} />
            <Metric label="COLLISIONS" value={String(state.validation.collisions.length).padStart(2, '0')} good={state.validation.collisions.length === 0} />
          </div>
          <div className="viewport-status">
            <span><i /> LIVE KERNEL</span>
            <b>{viewportHint}</b>
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
              <button onClick={() => setRenderMode('beauty')}>BACK TO BEAUTY</button>
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
              <button onClick={() => setPlacement(null)} aria-label="Cancel placement"><X size={13} /></button>
            </div>
          )}
          {state.validation.partCount === 0 && !placement && (
            <div className="viewport-empty">
              <div className="viewport-empty-mark" aria-hidden="true"><span /><span /><span /></div>
              <strong>Nothing placed yet</strong>
              <p>
                Choose a part on the left, then click here to drop it. Placement is solved against the part's real
                LDraw connectors, so the first brick sets the frame everything else mates into.
              </p>
              <button
                onClick={() => {
                  const first = searchCatalog({ requireGeometry: true, limit: 1, text: 'brick 2 x 4' })[0]
                    ?? searchCatalog({ requireGeometry: true, limit: 1 })[0]
                  if (first) armPart(first)
                }}
              >
                Pick a starter brick
              </button>
            </div>
          )}
          {state.proposals.length === 0 && state.validation.partCount > 0 && (
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
        playbackStep={playbackStep}
        onPlayStep={setPlaybackStep}
        onAccept={acceptProposal}
        onReject={(id) => cadEngine.rejectProposal(id)}
        onSelectIds={(ids) => cadEngine.setSelection(ids)}
      />

      <CommandDeck open={commandOpen} state={state} onClose={() => setCommandOpen(false)} onRun={runSharedMutation} />
      <ShortcutGuide open={shortcutOpen} onClose={() => setShortcutOpen(false)} onReplayWelcome={() => { setShortcutOpen(false); setWelcomeOpen(true) }} />
      <WelcomeGuide open={welcomeOpen} onClose={() => { markWelcomeSeen(); setWelcomeOpen(false) }} />

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
  return <button className={`tool-button ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active} aria-keyshortcuts={shortcut}>{icon}<span>{label}</span><kbd>{shortcut}</kbd></button>
}

function IconButton({ icon, label, onClick, disabled, shortcut, active }: { icon: React.ReactElement; label: string; onClick: () => void; disabled?: boolean; shortcut?: string; active?: boolean }) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {icon}
    </button>
  )
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className={good ? 'good' : ''}><span>{label}</span><strong>{value}</strong></div>
}
