import {
  Grid,
  OrthographicCamera,
  PerspectiveCamera,
} from '@react-three/drei'
import { Canvas, useFrame, type ThreeEvent, useThree } from '@react-three/fiber'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { ArticulatedJoint } from '../cad/articulation'
import { catalog } from '../cad/catalog'
import { getPartBounds } from '../cad/geometry'
import { resolvePlacement, type PlacementRequest, type ResolvedPlacement } from '../cad/placement'
import { getWorldConnectors } from '../cad/snapping'
import type { Bounds, CadOperation, ModelDocument, PartInstance, Proposal, Transform, Vec3 } from '../cad/types'
import { validateDocument } from '../cad/validation'
import {
  MAX_LENSED_QUALITY_INDEX,
  luminanceGrid,
  SAMPLE_BUDGET_MS,
  SAMPLE_INTERVAL_MS,
  useLiquidPerformance,
} from '../ui/liquid'
import { INDIVIDUAL_SELECTION_LIMIT, PartBatch, planBatches, type BatchMember } from './PartBatch'
import { createStudioEnvironment, type EnvironmentName } from './environment'
import { PartVisual, setTransmissionEnabled, TRANSMISSION_DRAW_BUDGET, type PartAppearance } from './PartVisual'
import { BlockingMarker, JointManipulators, SectionManipulators } from './render/Manipulators'
import {
  canvasPointOf,
  ViewportControls,
  type OverlayState,
  type ViewportControlsHandle,
} from './render/ViewportControls'
import { ViewportKeyboard } from './render/ViewportKeyboard'
import { useCadSnapshot } from './useCad'
import { EdgeLodProvider } from './render/EdgeLod'
import { CameraRig } from './render/CameraRig'
import { SelectionManipulator } from './render/SelectionManipulator'
import { StaticShadows } from './render/StaticShadows'
import { cameraControlsOf, cameraTarget } from './render/cameraControl'
import { pointerRouterFor } from './render/pointerRouter'
import { proposalDelta } from './render/proposalDelta'
import { PlacementGhost } from './render/PlacementGhost'
import type { RendererControlSurface } from './render/controlSurface'
import {
  MODEL_ROOT_ROTATION,
  MODEL_ROOT_SCALE,
  sceneMatrix,
  sceneToLdu,
} from './render/frame'
import { registerPickable, unregisterPickable } from './render/idPass'
import { PickRegistry } from './render/ids'
import { MotionController, MOTION_DURATIONS, playbackStepAt, staggeredProgress, turntableAngle } from './render/motion'
import { edgeBudgetForTier, QUALITY_TIERS, type QualityTier } from './render/quality'
import type { SectionPlane } from './render/sectionPlanes'
import type { SweepResult } from './render/sweep'
import { DEFAULT_VISIBILITY, resolveVisibility, type VisibilityState } from './render/visibility'
import {
  DEFAULT_MANIPULATION,
  type ManipulationOptions,
} from './workbench/transform'

export type EditorTool = 'select' | 'move' | 'rotate' | 'connect'
export type CameraView = 'isometric' | 'front' | 'rear' | 'left' | 'right' | 'top'
export type RenderMode = 'beauty' | 'orthographic' | 'silhouette' | 'connections' | 'violations' | 'exploded'
export type { PlacementRequest }

/**
 * The frame conversion, the pick registry, the motion policy and the control
 * surface all live under `./render`. What remains here is the scene itself: what
 * is drawn, in what pose, with which materials.
 *
 * The document is stored in LDraw's own frame — LDU units, **+Y downward** — and
 * the whole model hangs off one root node that rotates 180° about X and scales
 * LDU into scene units, so children use raw document coordinates. See
 * `render/frame.ts` for the matrices and every conversion that uses them.
 */

interface PartObjectProps {
  part: PartInstance
  appearance: PartAppearance
  displayTransform?: Transform
  interactive: boolean
  idBase?: number
  fade?: number
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
}

function PartObject({ part, appearance, displayTransform, interactive, idBase, fade = 1, onSelect }: PartObjectProps) {
  const definition = catalog.get(part.definitionId)
  const group = useRef<THREE.Group>(null)

  // Individually drawn parts join the identity pass exactly like batches do.
  // The layer has to go on the drawn mesh rather than the group: three tests
  // layers per renderable object, and a group is not one.
  useLayoutEffect(() => {
    const node = group.current
    if (!node) return
    const meshes: THREE.Object3D[] = []
    node.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child)
    })
    if (idBase === undefined) {
      for (const mesh of meshes) unregisterPickable(mesh)
      return
    }
    for (const mesh of meshes) registerPickable(mesh, idBase)
    return () => {
      for (const mesh of meshes) unregisterPickable(mesh)
    }
  }, [idBase, definition, appearance])

  if (!definition) return null

  const rendered = displayTransform ?? part.transform
  return (
    <group
      ref={group}
      matrixAutoUpdate={false}
      matrix={sceneMatrix(rendered)}
      userData={{ partId: part.id }}
      onPointerDown={interactive ? (event: ThreeEvent<PointerEvent>) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(part.id, event.nativeEvent.shiftKey, event.nativeEvent.detail > 1)
      } : undefined}
      onDoubleClick={interactive ? (event) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(part.id, false, true)
      } : undefined}
    >
      <PartVisual definition={definition} colorCode={part.color} appearance={appearance} fade={fade} />
    </group>
  )
}

/**
 * Drives the follow-the-cursor placement ghost.
 *
 * Runs its own raycast rather than relying on per-mesh pointer events: the model
 * is drawn as instanced batches, and a batch reports an `instanceId` on hover
 * regardless of which part the operator means, so resolving the hit here keeps
 * one code path for batched and individually drawn parts alike.
 */
function PlacementController({
  request,
  model,
  gridLdu,
  root,
  dropAt,
  onPreview,
  onPlace,
  onDropHandled,
}: {
  request: PlacementRequest
  model: ModelDocument
  gridLdu: number
  root: React.RefObject<THREE.Group | null>
  /** Client point a catalogue drag was released at, if the part came from a drop. */
  dropAt?: { clientX: number; clientY: number } | null
  onPreview: (placement: ResolvedPlacement | null) => void
  onPlace: (transform: Transform, legal?: boolean, reason?: string) => boolean | void
  onDropHandled?: (committed: boolean) => void
}) {
  const { camera, gl, raycaster, pointer } = useThree()
  const resolved = useRef<{ transform: Transform; legal: boolean; reason: string } | null>(null)
  const pressedAt = useRef<{ x: number; y: number } | null>(null)
  // Committing a drop changes the model, which re-runs the effect below. The
  // identity of the drop point that was already committed is remembered so the
  // second pass cannot place the same drop twice.
  const committedDrop = useRef<{ clientX: number; clientY: number } | null>(null)

  useEffect(() => {
    const element = gl.domElement
    const router = pointerRouterFor(element)
    let frame = 0
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const scratch = new THREE.Vector3()

    const sample = () => {
      if (!root.current) return
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObject(root.current, true)
      // Ghosts, proposals and helper meshes must never become placement surfaces.
      // In particular, raycasting our own preview caused a ghost to jump back to
      // the ground as soon as it had appeared over a stud.
      const surface = hits.find((entry) => {
        const id = partIdOf(entry.object, entry.instanceId)
        return (
          entry.object.visible &&
          (entry.object as THREE.Mesh).isMesh &&
          id &&
          model.parts[id] &&
          id !== request.movingPartId
        )
      })
      let point: Vec3 | null = null
      let partId: string | null = null
      if (surface) {
        point = sceneToLdu(surface.point)
        partId = partIdOf(surface.object, surface.instanceId)
      } else if (raycaster.ray.intersectPlane(ground, scratch)) {
        point = sceneToLdu(scratch)
      }
      if (!point) {
        resolved.current = null
        onPreview(null)
        element.style.cursor = 'crosshair'
        return
      }
      const placement = resolvePlacement(request, model, { point, partId }, gridLdu)
      if (!placement) {
        resolved.current = null
        onPreview(null)
        element.style.cursor = 'crosshair'
        return
      }
      resolved.current = { transform: placement.transform, legal: placement.legal, reason: placement.reason }
      onPreview(placement)
      element.style.cursor = placement.legal ? 'crosshair' : 'not-allowed'
    }

    const updatePointer = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect()
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; sample() })
    }
    const onMove = (event: PointerEvent) => {
      if (router.accepts(event)) updatePointer(event)
    }
    // Native catalogue drags suppress pointermove. Sample dragover instead of
    // waiting until drop; both paths resolve the exact same physical landing.
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('application/x-brickwright-part')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      updatePointer(event)
    }
    const onPartDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ clientX: number; clientY: number }>).detail
      if (detail) updatePointer(detail)
    }
    const onLeave = () => {
      cancelAnimationFrame(frame)
      frame = 0
      resolved.current = null
      onPreview(null)
    }
    const onDown = (event: PointerEvent) => {
      if (!router.accepts(event)) return
      if (event.button !== 0) return
      if (router.owner !== 'placement') return
      onMove(event)
      sample()
      pressedAt.current = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      if (!router.accepts(event)) return
      const start = pressedAt.current
      pressedAt.current = null
      // An orbit drag is not a placement. Only a click that stayed put commits.
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return
      if (event.button !== 0) return
      onMove(event)
      sample()
      if (resolved.current) onPlace(resolved.current.transform, resolved.current.legal, resolved.current.reason)
    }

    const cancel = (event?: Event) => { if (!event || !('pointerId' in event) || router.accepts(event as PointerEvent)) pressedAt.current = null }
    element.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('dragover', onDragOver)
    window.addEventListener('brickwright:part-drag', onPartDrag)
    element.addEventListener('dragleave', onLeave)
    element.addEventListener('pointerleave', onLeave)
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    element.style.cursor = 'crosshair'
    // Resolve once immediately: arming a part from the catalog and clicking
    // straight into the viewport without moving the mouse first is a normal
    // thing to do, and waiting for a move event made that click do nothing.
    sample()

    // A part dragged out of the catalogue commits where it was released. It is
    // done here, in the effect that attaches the listeners above, because the
    // drop handler cannot know when this controller has mounted — it used to
    // guess at two frames, miss, and leave the part armed under the cursor.
    if (dropAt && committedDrop.current !== dropAt) {
      committedDrop.current = dropAt
      const rect = element.getBoundingClientRect()
      pointer.set(
        ((dropAt.clientX - rect.left) / rect.width) * 2 - 1,
        -((dropAt.clientY - rect.top) / rect.height) * 2 + 1,
      )
      sample()
      const landing = resolved.current
      const placed = landing ? onPlace(landing.transform, landing.legal, landing.reason) !== false : false
      onDropHandled?.(Boolean(landing?.legal && placed))
    }

    return () => {
      cancelAnimationFrame(frame)
      cancel()
      element.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('dragover', onDragOver)
      window.removeEventListener('brickwright:part-drag', onPartDrag)
      element.removeEventListener('dragleave', onLeave)
      element.removeEventListener('pointerleave', onLeave)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerup', onUp)
      element.style.cursor = ''
      onPreview(null)
    }
  }, [camera, dropAt, gl, gridLdu, model, onDropHandled, onPlace, onPreview, pointer, raycaster, request, root])

  return null
}

/** Resolves a raycast hit back to the part it belongs to. */
function partIdOf(object: THREE.Object3D, instanceId: number | undefined): string | null {
  const members = object.userData?.members as { part: { id: string } }[] | undefined
  if (members && instanceId !== undefined) return members[instanceId]?.part.id ?? null
  let node: THREE.Object3D | null = object
  while (node) {
    if (typeof node.userData?.partId === 'string') return node.userData.partId
    node = node.parent
  }
  return null
}

/** Screen-space rectangle the operator is dragging out, in CSS pixels. */
export interface MarqueeRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * The proposal reveal.
 *
 * A proposal that appears fully formed gives no clue which parts it added,
 * which is the one thing the operator has to judge before accepting it. Parts
 * are therefore revealed in a wave — deterministic, bounded, and instantly
 * complete under reduced motion or during a capture, because a half-revealed
 * proposal in a screenshot would be a picture of a document state that does not
 * exist.
 */
function GhostProposal({
  proposal,
  current,
  revealed,
}: {
  proposal: Proposal
  current: ModelDocument
  revealed: number
}) {
  // `revealed` advances on every frame of the reveal wave, so this component
  // re-renders every frame — and the delta was recomputed each time, building
  // two canonical-transform *strings* per part in the proposal. Memoized, the
  // wave costs one pass over the proposal instead of one per frame.
  const { added, removed } = useMemo(() => proposalDelta(proposal, current), [proposal, current])

  return (
    <group>
      {added.slice(0, revealed).map((part) => {
        const definition = catalog.get(part.definitionId)
        if (!definition) return null
        return (
          <group key={`ghost_${part.id}`} matrixAutoUpdate={false} matrix={sceneMatrix(part.transform)}>
            <PartVisual definition={definition} colorCode={part.color} appearance="ghost" />
          </group>
        )
      })}
      {removed.map((part) => {
        const definition = catalog.get(part.definitionId)
        if (!definition) return null
        return (
          <group key={`removed_${part.id}`} matrixAutoUpdate={false} matrix={sceneMatrix(part.transform)}>
            <PartVisual definition={definition} colorCode={part.color} appearance="removed" />
          </group>
        )
      })}
    </group>
  )
}

/**
 * Advances the timed animations.
 *
 * All of them are driven from one place, off one clock, so "settled" is a single
 * question with a single answer. Anything that animated on its own schedule
 * would be one more thing a capture could catch mid-flight.
 */
function AnimationDriver({
  motion,
  proposalPartCount,
  turntable,
  playback,
  stepCount,
  onReveal,
  onPlayback,
}: {
  motion: MotionController
  proposalPartCount: number
  turntable: boolean
  playback: boolean
  stepCount: number
  onReveal: (count: number) => void
  onPlayback: (step: number) => void
}) {
  const { camera, controls } = useThree()
  const startedAt = useRef(performance.now())
  const lastReveal = useRef(-1)
  const lastStep = useRef(-1)

  useEffect(() => {
    startedAt.current = performance.now()
    lastReveal.current = -1
    lastStep.current = -1
  }, [proposalPartCount, playback])

  useFrame(() => {
    const animated = motion.policy.animated
    const elapsed = performance.now() - startedAt.current

    if (proposalPartCount > 0) {
      let revealed = proposalPartCount
      if (animated) {
        revealed = 0
        for (let index = 0; index < proposalPartCount; index += 1) {
          if (staggeredProgress(index, proposalPartCount, elapsed) > 0) revealed = index + 1
        }
      }
      if (revealed !== lastReveal.current) {
        lastReveal.current = revealed
        onReveal(revealed)
      }
    } else if (lastReveal.current !== 0) {
      lastReveal.current = 0
      onReveal(0)
    }

    if (playback && stepCount > 0) {
      const step = animated ? playbackStepAt(elapsed, stepCount) : stepCount - 1
      if (step !== lastStep.current) {
        lastStep.current = step
        onPlayback(step)
      }
    }

    if (turntable && animated) {
      const target = cameraTarget(controls)
      const offset = camera.position.clone().sub(target)
      const radius = Math.hypot(offset.x, offset.z)
      const angle = turntableAngle(elapsed)
      void cameraControlsOf(controls)?.setLookAt(target.x + Math.cos(angle) * radius, camera.position.y, target.z + Math.sin(angle) * radius, ...target.toArray(), false)
    }
  })

  return null
}

/** Optional animation channels. Every one settles deterministically. */
export interface ViewportAnimation {
  /** Reveal a pending proposal's parts as a wave. Defaults to on. */
  readonly proposalReveal?: boolean
  /** Rotate the camera continuously, for a presentation view. */
  readonly turntable?: boolean
  /** Step through the build sequence, revealing parts as they are placed. */
  readonly instructionPlayback?: boolean
}

interface CadViewportProps {
  document: ModelDocument
  selection: string[]
  proposals: Proposal[]
  tool: EditorTool
  gridLdu: number
  cameraView: CameraView
  /** Increment to frame the current document even when the named view is unchanged. */
  cameraResetKey: number
  renderMode: RenderMode
  /** A catalog part armed for click-to-place, or null when nothing is armed. */
  placement?: PlacementRequest | null
  /** Full physical model, including temporarily hidden parts, for collision truth. */
  placementDocument?: ModelDocument
  onPlacementPreview?: (placement: ResolvedPlacement | null) => void
  dropAt?: { clientX: number; clientY: number } | null
  onDropHandled?: (committed: boolean) => void
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onSelectMany?: (partIds: string[], additive: boolean) => void
  onClearSelection: () => void
  onTransform: (partId: string, transform: Transform) => void
  /** Multi-part gizmo commit — one rigid transaction. */
  onCommitTransforms?: (operations: CadOperation[]) => void
  onNudgeSelection?: (dx: number, dz: number, dy?: number) => void
  transformPreferences?: ManipulationOptions
  onPlace?: (transform: Transform, legal?: boolean, reason?: string) => boolean | void
  onJointNudge?: (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => void
  onCanvasReady?: (canvas: HTMLCanvasElement) => void

  // -- optional renderer capabilities, all defaulting to the previous behaviour
  /** Isolation, ghosting and explicit hiding. Uncontrolled when omitted. */
  visibility?: VisibilityState
  onVisibilityChange?: (next: VisibilityState) => void
  /** Clipping and section planes, in document space. Uncontrolled when omitted. */
  sectionPlanes?: readonly SectionPlane[]
  onSectionPlanesChange?: (next: readonly SectionPlane[]) => void
  environment?: EnvironmentName
  /** Overrides `prefers-reduced-motion`; null returns control to the preference. */
  reducedMotion?: boolean | null
  animation?: ViewportAnimation
  /** A fixed quality tier index, or `auto` to govern from measured frame time. */
  quality?: number | 'auto'
  /** Receives the imperative control surface once the renderer is live. */
  onRendererReady?: (surface: RendererControlSurface) => void
  /** Live swept-collision result during a joint drag. */
  onSweep?: (result: SweepResult | null) => void
  /** Articulated joints available for the current selection. */
  onJoints?: (joints: readonly ArticulatedJoint[]) => void
}

type ViewportEventKey = Extract<keyof CadViewportProps, `on${string}`>
const VIEWPORT_EVENTS: readonly ViewportEventKey[] = ['onPlacementPreview', 'onDropHandled', 'onSelect', 'onSelectMany',
  'onClearSelection', 'onTransform', 'onCommitTransforms', 'onNudgeSelection', 'onPlace', 'onJointNudge', 'onCanvasReady',
  'onVisibilityChange', 'onSectionPlanesChange', 'onRendererReady', 'onSweep', 'onJoints']

/** Parent chrome may recreate closures; keep their implementations fresh without
 * invalidating the scene on a toast, status change or dock hover. */
export function CadViewport(props: CadViewportProps) {
  const current = useRef(props)
  useLayoutEffect(() => { current.current = props })
  const present = VIEWPORT_EVENTS.map(key => typeof props[key] === 'function' ? '1' : '0').join('')
  const events = useMemo(() => Object.fromEntries(VIEWPORT_EVENTS.map((key, index) => [key,
    present[index] === '1' ? (...args: unknown[]) => {
      const callback = current.current[key] as ((...values: unknown[]) => unknown) | undefined
      return callback?.(...args)
    } : undefined])) as Pick<CadViewportProps, ViewportEventKey>, [present])
  return <MemoViewportScene {...props} {...events} />
}
const MemoViewportScene = memo(CadViewportScene, (previous, next) => {
  for (const key of Object.keys(next) as Array<keyof CadViewportProps>) {
    const a = previous[key], b = next[key]
    if (a === b) continue
    if ((key === 'selection' || key === 'proposals') && Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((value, index) => value === b[index])) continue
    return false
  }
  return Object.keys(previous).length === Object.keys(next).length
})

function CadViewportScene({
  document,
  selection,
  proposals,
  tool,
  gridLdu,
  cameraView,
  cameraResetKey,
  renderMode,
  placement,
  placementDocument,
  onPlacementPreview,
  dropAt,
  onDropHandled,
  onSelect,
  onSelectMany,
  onClearSelection,
  onTransform,
  onCommitTransforms,
  onNudgeSelection,
  transformPreferences = DEFAULT_MANIPULATION,
  onPlace,
  onJointNudge,
  onCanvasReady,
  visibility: visibilityProp,
  onVisibilityChange,
  sectionPlanes: sectionPlanesProp,
  onSectionPlanesChange,
  environment = 'studio',
  reducedMotion = null,
  animation,
  quality = 'auto',
  onRendererReady,
  onSweep,
  onJoints,
}: CadViewportProps) {
  const kernelValidation = useCadSnapshot(snapshot => snapshot.document === document ? snapshot.validation : null)
  const validation = useMemo(() => kernelValidation ?? validateDocument(document), [document, kernelValidation])
  const invalidIds = useMemo(
    () => new Set(validation.collisions.flatMap((issue) => [issue.partA, issue.partB])),
    [validation.collisions],
  )
  const subassemblyOrder = useMemo(() => Object.keys(document.subassemblies), [document.subassemblies])
  const selected = useMemo(() => new Set(selection), [selection])
  const root = useRef<THREE.Group>(null)

  /** Pose being dragged right now, shown live instead of waiting for the commit. */
  const [dragPreview, setDragPreview] = useState<ReadonlyMap<string, Transform> | null>(null)
  const [placementPreview, setPlacementPreview] = useState<ResolvedPlacement | null>(null)
  const reportPlacement = useCallback(
    (preview: ResolvedPlacement | null) => {
      setPlacementPreview(preview)
      onPlacementPreview?.(preview)
    },
    [onPlacementPreview],
  )
  const placementModel = useMemo(() => {
    const model = placementDocument ?? document
    if (!placement?.movingPartId) return model
    return {
      ...model,
      parts: Object.fromEntries(Object.entries(model.parts).filter(([id]) => id !== placement.movingPartId)),
    }
  }, [document, placementDocument, placement?.movingPartId])
  const [overlay, setOverlay] = useState<OverlayState>({ marquee: null, lasso: null, sweep: null })
  const [jointPreview, setJointPreview] = useState<Map<string, Transform> | null>(null)
  const [activeJointEdge, setActiveJointEdge] = useState<string | null>(null)
  const [joints, setJoints] = useState<readonly ArticulatedJoint[]>([])
  const [sweep, setSweep] = useState<SweepResult | null>(null)
  const [revealed, setRevealed] = useState(0)
  const [playbackStep, setPlaybackStep] = useState(0)
  const [tier, setTier] = useState<QualityTier>(QUALITY_TIERS[1])
  const controlsHandle = useRef<ViewportControlsHandle | null>(null)

  /*
   * Telling the chrome what the renderer is doing.
   *
   * The glass above this viewport refracts, and refraction is not free. It has
   * to stand down when the renderer is already short of frame time and while a
   * gesture is in flight — which is exactly when the operator is looking at the
   * model rather than at the chrome.
   *
   * The direction is deliberate: src/ui/liquid never imports from src/editor,
   * because main.tsx goes to real trouble to keep Three.js out of the landing
   * bundle. The renderer pushes; the chrome never pulls. This hook is called on
   * the DOM side of the tree rather than inside <Canvas>, so it does not depend
   * on React context crossing into the three.js reconciler.
   */
  const reportPerformance = useLiquidPerformance()

  // Read by the backdrop sampler below, which must not resubscribe every time
  // the renderer changes gear.
  const tierIndexRef = useRef<number | undefined>(undefined)

  const handleQuality = useCallback(
    (next: QualityTier, index: number) => {
      setTier(next)
      tierIndexRef.current = index
      reportPerformance({ qualityTierIndex: index })
    },
    [reportPerformance],
  )

  const interactingRef = useRef(false)

  useEffect(() => {
    const onCanvas = (target: EventTarget | null) => target instanceof Element && target.closest('canvas') !== null
    const begin = (event: PointerEvent) => {
      if (!onCanvas(event.target)) return
      interactingRef.current = true
      reportPerformance({ interacting: true })
    }
    const end = () => {
      interactingRef.current = false
      reportPerformance({ interacting: false })
    }
    // A wheel burst has no down and up to bracket it, so each notch reports
    // both. The stage promotes on a delay, which turns a stream of notches into
    // one continuous interaction that settles once the wheel stops.
    const wheel = (event: WheelEvent) => {
      if (!onCanvas(event.target)) return
      reportPerformance({ interacting: true })
      reportPerformance({ interacting: false })
    }

    window.addEventListener('pointerdown', begin, { passive: true })
    window.addEventListener('pointerup', end, { passive: true })
    window.addEventListener('pointercancel', end, { passive: true })
    window.addEventListener('wheel', wheel, { passive: true })
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerdown', begin)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('wheel', wheel)
      window.removeEventListener('blur', end)
      // Leaving the viewport mounted-then-unmounted mid-drag must not strand
      // the chrome on the cheap material forever.
      interactingRef.current = false
      reportPerformance({ interacting: false })
    }
  }, [reportPerformance])

  /*
   * What the chrome is actually sitting on.
   *
   * Glass that never changes with its backdrop is a grey rectangle with a
   * gradient on it. Real glass over a white baseplate shows a dark rim and an
   * inverted specular, and getting that requires *measuring* the scene rather
   * than assuming it, because the scene is whatever the operator just built.
   *
   * `preserveDrawingBuffer: true` on the Canvas above is what makes this legal:
   * without it the drawing buffer is undefined after compositing and drawImage
   * returns cleared pixels. Sixteen by sixteen is plenty — this feeds a single
   * luminance average and a threshold, not a histogram.
   *
   * Gated hard, because it stalls the GPU pipeline: never while a gesture is in
   * flight, never on a hidden tab, never once the renderer has admitted it is
   * short of frame time, and never again if a sample overruns its budget.
   */
  useEffect(() => {
    // `document` is shadowed in this component by the ModelDocument prop, so
    // the global has to be named explicitly.
    const scratch = window.document.createElement('canvas')
    /*
     * Thirty-two squared, not sixteen.
     *
     * Measured on a framed model: at 16 the brightest cell in the whole scene
     * read 0.283, because each cell averaged a bright brick face together with
     * the dark gaps around it, and no surface could ever cross the over-light
     * threshold. At 32 the same view resolves that face at 0.724. The readback
     * costs the same — the stall is pipeline depth, not the kilobyte copied.
     */
    scratch.width = 32
    scratch.height = 32
    const context = scratch.getContext('2d', { willReadFrequently: true })
    if (!context) return

    let retired = false
    let taken = 0
    let overruns = 0

    const sample = () => {
      if (retired || window.document.hidden || interactingRef.current) return
      const tier = tierIndexRef.current
      if (tier !== undefined && tier > MAX_LENSED_QUALITY_INDEX) return
      const canvas = window.document.querySelector('canvas')
      if (!canvas || canvas.width === 0) return

      const started = performance.now()
      try {
        context.drawImage(canvas, 0, 0, scratch.width, scratch.height)
        const { data } = context.getImageData(0, 0, scratch.width, scratch.height)
        const { left, top, width, height } = canvas.getBoundingClientRect()
        reportPerformance({
          backdrop: {
            region: { left, top, width, height },
            cells: luminanceGrid(data),
            columns: scratch.width,
            rows: scratch.height,
          },
        })
      } catch {
        // A tainted or lost canvas is not an error worth surfacing: the static
        // per-surface tint is a perfectly good answer.
        retired = true
        return
      }

      /*
       * Retiring takes a pattern, not one bad reading.
       *
       * The first sample allocates the readback path and measured 4 ms on a
       * machine where later ones are well inside budget — retiring on it, which
       * an earlier version did, disabled the adaptation everywhere on the one
       * sample guaranteed to be slowest. So the warm-up is skipped and it takes
       * three consecutive overruns, which is a machine that genuinely cannot
       * afford this rather than a cold cache.
       */
      taken += 1
      if (taken === 1) return
      overruns = performance.now() - started > SAMPLE_BUDGET_MS ? overruns + 1 : 0
      if (overruns >= 3) retired = true
    }

    const timer = setInterval(sample, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [reportPerformance])
  // Environment, quality and transmission arrive as props but are also
  // reachable from the imperative surface, so the viewport keeps an override
  // and prefers it. A panel and an agent then drive the same state rather than
  // two copies of it that can disagree.
  const [environmentOverride, setEnvironmentOverride] = useState<EnvironmentName | null>(null)
  const [qualityOverride, setQualityOverride] = useState<number | 'auto' | null>(null)
  const [transmissionOverride, setTransmissionOverride] = useState<boolean | null>(null)
  useEffect(() => setEnvironmentOverride(null), [environment])
  useEffect(() => setQualityOverride(null), [quality])

  // Visibility and section planes are optionally controlled: the workbench can
  // own them, and when it does not the viewport keeps its own so the imperative
  // surface still works.
  const [visibilityState, setVisibilityState] = useState<VisibilityState>(DEFAULT_VISIBILITY)
  const [sectionState, setSectionState] = useState<readonly SectionPlane[]>([])
  const visibility = visibilityProp ?? visibilityState
  const sectionPlanes = sectionPlanesProp ?? sectionState
  const setVisibility = useCallback(
    (next: VisibilityState) => {
      setVisibilityState(next)
      onVisibilityChange?.(next)
    },
    [onVisibilityChange],
  )
  const setSectionPlanes = useCallback(
    (next: readonly SectionPlane[]) => {
      setSectionState(next)
      onSectionPlanesChange?.(next)
    },
    [onSectionPlanesChange],
  )

  /**
   * Bumped whenever an agent capture is requested, and added to `cameraResetKey`.
   *
   * `render_capture` names a view, and the contract is that the same revision in
   * the same mode and view produces the same pixels. Reframing only when the
   * *named view changes* broke that: a capture sequence that visited the
   * exploded view and came back to beauty left the camera wherever the explode
   * had put it, so two "isometric beauty" captures of one revision differed.
   * A capture therefore always reframes, which makes the framing a function of
   * (view, bounds) and nothing else.
   */
  const [captureFrameKey, setCaptureFrameKey] = useState(0)
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string } | string>).detail
      if (typeof detail === 'string' || !detail?.requestId) return
      setCaptureFrameKey((key) => key + 1)
    }
    window.addEventListener('brickwright:set-camera-view', onRequest)
    return () => window.removeEventListener('brickwright:set-camera-view', onRequest)
  }, [])

  const motion = useMemo(() => new MotionController(), [])
  useEffect(() => motion.forceReducedMotion(reducedMotion), [motion, reducedMotion])
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => motion.refresh(query.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [motion])

  const registry = useMemo(() => new PickRegistry(), [])
  const resolvedVisibility = useMemo(() => resolveVisibility(document, visibility), [document, visibility])

  const stepIds = useMemo(() => {
    if (!animation?.instructionPlayback) return null
    const ids = new Set<string>()
    document.steps.slice(0, playbackStep + 1).forEach((step) => step.partIds.forEach((id) => ids.add(id)))
    return ids
  }, [animation?.instructionPlayback, document.steps, playbackStep])

  const members = useMemo<BatchMember[]>(
    () =>
      Object.values(document.parts)
        .filter((part) => !resolvedVisibility.hidden.has(part.id))
        .filter((part) => !stepIds || stepIds.has(part.id))
        .map((part) => {
          const displayed = jointPreview?.get(part.id) ?? part.transform
          if (renderMode !== 'exploded') return { part, transform: displayed }
          const subassemblyIndex = Math.max(0, subassemblyOrder.indexOf(part.subassemblyId))
          const angle = (subassemblyIndex / Math.max(1, subassemblyOrder.length)) * Math.PI * 2
          return {
            part,
            transform: {
              ...displayed,
              position: [
                displayed.position[0] + Math.cos(angle) * 140,
                displayed.position[1] - (subassemblyIndex % 3) * 40,
                displayed.position[2] + Math.sin(angle) * 140,
              ] as Vec3,
            },
          }
        }),
    [document.parts, jointPreview, renderMode, resolvedVisibility.hidden, stepIds, subassemblyOrder],
  )

  const solidMembers = useMemo(
    () => members.filter((member) => !resolvedVisibility.ghosted.has(member.part.id)),
    [members, resolvedVisibility.ghosted],
  )
  const ghostMembers = useMemo(
    () => members.filter((member) => resolvedVisibility.ghosted.has(member.part.id)),
    [members, resolvedVisibility.ghosted],
  )

  // A selection overlay does not change the source batches or their identity
  // ranges. Only move/rotate tools pull parts out for a live transform preview.
  const overlaySelection = tool === 'select' || tool === 'connect'
  const excluded = useMemo(() => {
    const ids = new Set(!overlaySelection && selection.length <= INDIVIDUAL_SELECTION_LIMIT ? selection : [])
    if (renderMode === 'violations' && invalidIds.size <= INDIVIDUAL_SELECTION_LIMIT) {
      for (const id of invalidIds) ids.add(id)
    }
    return ids
  }, [overlaySelection, selection, renderMode, invalidIds])

  const appearanceFor = useCallback(
    (partId: string): PartAppearance => {
      if (partId === placement?.movingPartId) return 'ghost'
      if (renderMode === 'violations' && invalidIds.has(partId)) return 'invalid'
      if (renderMode === 'silhouette') return 'silhouette'
      return selected.has(partId) ? 'selected' : 'solid'
    },
    [invalidIds, renderMode, selected, placement?.movingPartId],
  )

  // Framing follows what is drawn, so exploding the model reframes onto the
  // exploded extent rather than onto the assembled one it no longer shows.
  // One pass, and no spread. `Math.min(...array)` over the drawn set built six
  // intermediate arrays the length of the model on every commit, and — because
  // a spread becomes argument slots — throws outright somewhere past a hundred
  // thousand parts, which is a crash rather than a slow frame.
  const displayBounds = useMemo<Bounds>(() => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    let any = false
    for (const member of members) {
      const bounds = getPartBounds({ ...member.part, transform: member.transform })
      if (!bounds.measured) continue
      any = true
      for (let axis = 0; axis < 3; axis += 1) {
        if (bounds.min[axis] < min[axis]) min[axis] = bounds.min[axis]
        if (bounds.max[axis] > max[axis]) max[axis] = bounds.max[axis]
      }
    }
    if (!any) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
  }, [members])

  // Shadow frusta and the contact patch follow the model: a fixed 40-unit box
  // clipped a tower's shadow off at the third storey.
  const shadowExtent = useMemo(
    () =>
      Math.min(180, Math.max(14, Math.max(...displayBounds.size.map((amount) => amount * MODEL_ROOT_SCALE)) * 0.85)),
    [displayBounds],
  )

  const baseAppearance = useCallback((partId: string): PartAppearance => {
    if (partId === placement?.movingPartId) return 'ghost'
    if (renderMode === 'violations' && invalidIds.has(partId)) return 'invalid'
    return renderMode === 'silhouette' ? 'silhouette' : 'solid'
  }, [placement?.movingPartId, renderMode, invalidIds])
  const emptyExclusions = useMemo(() => new Set<string>(), [])
  const baseExclusions = overlaySelection && renderMode !== 'violations' ? emptyExclusions : excluded
  const planAppearance = overlaySelection ? baseAppearance : appearanceFor
  const plan = useMemo(
    () => planBatches(solidMembers, baseExclusions, planAppearance),
    [solidMembers, baseExclusions, planAppearance],
  )
  const selectionPlan = useMemo(() => {
    const highlighted = overlaySelection && renderMode !== 'silhouette'
      ? solidMembers.filter(member => selected.has(member.part.id) && !(renderMode === 'violations' && invalidIds.has(member.part.id))) : []
    return planBatches(highlighted, highlighted.length <= INDIVIDUAL_SELECTION_LIMIT ? selected : emptyExclusions, () => 'selected')
  }, [overlaySelection, renderMode, solidMembers, selected, emptyExclusions, invalidIds])
  const ghostPlan = useMemo(() => planBatches(ghostMembers, new Set<string>()), [ghostMembers])

  /**
   * Identity ranges for this frame's draws.
   *
   * Rebuilt with the plan, and *only* for what is solidly drawn: ghosted context
   * gets no range, which is what makes "what you cannot see, you cannot select" a
   * property of the pass rather than a filter over its output.
   */
  const idBases = useMemo(() => {
    registry.reset()
    const bases = new Map<string, number>()
    for (const descriptor of plan.batches) {
      bases.set(descriptor.key, registry.reserve(descriptor.members.map((member) => member.part.id)))
    }
    for (const member of plan.individual) {
      bases.set(`solo:${member.part.id}`, registry.reserve([member.part.id]))
    }
    return bases
  }, [plan, registry])

  const edgesEnabled = tier.edges
  const placing = Boolean(placement)

  /**
   * Everything that changes what the shadow passes must draw and is *not*
   * visible in the scene graph.
   *
   * `StaticShadows` recognises a moved brick, a hidden part or a rebuilt batch
   * on its own. It cannot see a reallocated shadow map, a clipping plane that
   * now cuts the model, or a capture asking for a settled frame, so those are
   * folded in here.
   */
  const shadowRevision = useMemo(() => {
    let value = Math.imul(captureFrameKey + 1, 0x01000193) + QUALITY_TIERS.indexOf(tier) + 1
    for (const plane of sectionPlanes) {
      value = Math.imul(value, 31) + (plane.enabled ? 1 : 0)
      for (const axis of plane.origin) value = Math.imul(value, 31) + Math.round(axis)
      for (const axis of plane.normal) value = Math.imul(value, 31) + Math.round(axis * 100)
    }
    return value | 0
  }, [captureFrameKey, sectionPlanes, tier])

  // True transmission renders the scene again per transmissive draw. It is worth
  // that on a handful of trans-clear elements and ruinous on a glazed facade, so
  // the count of transparent batches — not a guess about the machine — decides.
  const transparentBatches = useMemo(
    () => plan.batches.filter((descriptor) => catalog.color(descriptor.colorCode).alpha < 1).length,
    [plan.batches],
  )
  useEffect(() => {
    const withinBudget = transparentBatches > 0 && transparentBatches <= TRANSMISSION_DRAW_BUDGET
    // A caller may disable transmission for a cheaper diagnostic frame, but it
    // may not force a glazed facade past the draw budget the viewport owns.
    setTransmissionEnabled(transmissionOverride === false ? false : withinBudget)
  }, [transmissionOverride, transparentBatches])

  const manipulatedParts = useMemo(() => {
    if (!['beauty', 'orthographic'].includes(renderMode) || placing || (tool !== 'move' && tool !== 'rotate')) return []
    if (selection.length < 1 || selection.length > INDIVIDUAL_SELECTION_LIMIT) return []
    return selection.map((id) => document.parts[id]).filter((part): part is PartInstance => Boolean(part))
  }, [document.parts, placing, renderMode, selection, tool])

  const commitDrag = useCallback(
    (partId: string, transform: Transform) => {
      // The gizmo has already resolved its frame, locks, pivot and snap choice.
      // A second implicit snap at the controller would silently change that pose.
      if (onCommitTransforms) onCommitTransforms([{ type: 'part.transform', partId, transform }])
      else onTransform(partId, transform)
    },
    [onCommitTransforms, onTransform],
  )

  const commitGroupDrag = useCallback(
    (operations: CadOperation[]) => {
      if (onCommitTransforms) onCommitTransforms(operations)
      else if (operations.length === 1 && operations[0]?.type === 'part.transform') {
        onTransform(operations[0].partId, operations[0].transform)
      }
    },
    [onCommitTransforms, onTransform],
  )

  const placementDefinition = placement ? catalog.get(placement.definitionId) : undefined

  const pendingProposal = useMemo(() => proposals.find((proposal) => proposal.status === 'pending'), [proposals])
  // The same delta the ghost draws, so the reveal counter and the reveal cannot
  // disagree about how many parts there are to reveal.
  const proposalPartCount = useMemo(
    () => (pendingProposal ? proposalDelta(pendingProposal, document).added.length : 0),
    [document, pendingProposal],
  )

  const revealCount = animation?.proposalReveal === false ? proposalPartCount : revealed

  const handleJointPreview = useCallback((preview: Map<string, Transform> | null, edgeId: string | null) => {
    setJointPreview(preview)
    setActiveJointEdge(edgeId)
  }, [])

  const handleSweep = useCallback(
    (result: SweepResult | null) => {
      setSweep(result)
      onSweep?.(result)
    },
    [onSweep],
  )

  const handleJoints = useCallback(
    (next: readonly ArticulatedJoint[]) => {
      setJoints(next)
      onJoints?.(next)
    },
    [onJoints],
  )

  useEffect(() => {
    const surface = controlsHandle.current?.surface
    if (surface) onRendererReady?.(surface)
  }, [onRendererReady, revealed])

  const selectMany = onSelectMany ?? (() => {})

  return (
    <>
      <Canvas
        shadows="soft"
        dpr={[1, tier.maxDpr]}
        gl={{
          antialias: tier.antialias,
          alpha: false,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        }}
        onCreated={({ gl, scene }) => {
          gl.setClearColor('#0b1012')
          gl.outputColorSpace = THREE.SRGBColorSpace
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 0.92
          // Plastic is read from what it reflects, not from what shines on it.
          // The studio is generated rather than fetched, so the viewport stays
          // self-contained; `ViewportControls` replaces it when the environment
          // prop changes and owns its disposal.
          scene.environment = createStudioEnvironment(gl)
          scene.environmentIntensity = 0.55
          const canvas = gl.domElement
          canvas.tabIndex = 0
          canvas.setAttribute('role', 'application')
          canvas.setAttribute('aria-label', 'CAD viewport')
          canvas.setAttribute('aria-describedby', 'viewport-keys')
          canvas.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home')
          onCanvasReady?.(canvas)
          // Renderer counters are exposed so the browser acceptance run can assert
          // that draw calls track distinct part/colour combinations rather than
          // brick count.
          //
          // Auto-reset is turned off deliberately: the viewport draws the gizmo
          // helper in its own pass, and per-frame reset means whichever pass
          // finishes last is all a sampler would see. Accumulating and resetting
          // explicitly makes the counters cover every pass between two samples.
          gl.info.autoReset = false
          ;(window as unknown as { __brickwrightRenderStats?: () => unknown }).__brickwrightRenderStats = () => {
            const sample = {
              drawCalls: gl.info.render.calls,
              triangles: gl.info.render.triangles,
              geometries: gl.info.memory.geometries,
              programs: gl.info.programs?.length ?? 0,
            }
            gl.info.reset()
            return sample
          }
        }}
        onPointerMissed={() => {
          // Background clicks are resolved by the identity pass, which knows the
          // difference between "no part here" and "a part the raycaster missed".
        }}
      >
        {renderMode === 'orthographic' ? (
          <OrthographicCamera makeDefault near={0.1} far={2000} zoom={28} />
        ) : (
          <PerspectiveCamera makeDefault fov={34} near={0.1} far={2000} />
        )}
        <ViewportKeyboard
          document={document}
          selection={selection}
          tool={tool}
          gridLdu={gridLdu}
          visibility={visibility}
          sectionPlanes={sectionPlanes}
          placementPreview={placementPreview}
          placing={Boolean(placement)}
          onSelect={onSelect}
          onTransform={onTransform}
          onNudgeSelection={onNudgeSelection}
          onPlace={onPlace}
          onJointNudge={onJointNudge}
          onSectionPlanesChange={setSectionPlanes}
        />

        {/* The environment carries the ambient term, so the lights here only
          shape: a key that casts, a cool fill opposite it, and a rim that
          separates a dark model from a dark background. Their directions match
          the softbox baked into the environment, because shading and reflection
          disagreeing about where the light is makes plastic look painted. */}
        <hemisphereLight intensity={0.22} color="#c3d6db" groundColor="#0b0f11" />
        <directionalLight
          position={[-16, 24, 13]}
          intensity={1.7}
          color="#fff4e6"
          castShadow={tier.shadowMapSize > 0}
          shadow-mapSize={[tier.shadowMapSize || 1, tier.shadowMapSize || 1]}
          shadow-bias={-0.0006}
          shadow-normalBias={0.02}
          shadow-radius={3}
          shadow-camera-left={-shadowExtent}
          shadow-camera-right={shadowExtent}
          shadow-camera-top={shadowExtent}
          shadow-camera-bottom={-shadowExtent}
          shadow-camera-far={shadowExtent * 6}
        />
        <directionalLight position={[18, 9, -17]} intensity={0.42} color="#8cddeb" />
        <directionalLight position={[2, -8, -14]} intensity={0.22} color="#9fb6bd" />

        <EdgeLodProvider enabled={edgesEnabled && renderMode !== 'silhouette'} budget={edgeBudgetForTier(tier)}>
        <group ref={root} rotation={MODEL_ROOT_ROTATION} scale={MODEL_ROOT_SCALE}>
          {/* The bulk of the model renders as instanced batches; only parts that
            need individual treatment are drawn on their own. */}
          {plan.batches.map((descriptor) => (
            <PartBatch
              key={descriptor.key}
              descriptor={descriptor}
              showEdges={edgesEnabled}
              silhouette={renderMode === 'silhouette'}
              interactive={false}
              idBase={idBases.get(descriptor.key)}
              onSelect={onSelect}
            />
          ))}

          {/* Context outside an isolation, drawn faintly and left out of picking. */}
          {ghostPlan.batches.map((descriptor) => (
            <PartBatch
              key={`ghost:${descriptor.key}`}
              descriptor={descriptor}
              showEdges={false}
              silhouette={false}
              interactive={false}
              ghostOpacity={resolvedVisibility.ghostOpacity}
              onSelect={onSelect}
            />
          ))}

          {plan.individual.map((member) => (
            <PartObject
              key={member.part.id}
              part={member.part}
              appearance={appearanceFor(member.part.id)}
              displayTransform={dragPreview?.get(member.part.id) ?? member.transform}
              interactive={false}
              idBase={idBases.get(`solo:${member.part.id}`)}
              onSelect={onSelect}
            />
          ))}

          <group renderOrder={1}>
            {selectionPlan.batches.map(descriptor => <PartBatch key={`selection:${descriptor.key}`}
              descriptor={descriptor} showEdges={true} silhouette={false} interactive={false} onSelect={onSelect} />)}
            {selectionPlan.individual.map(member => <PartObject key={`selection:${member.part.id}`}
              part={member.part} displayTransform={member.transform} appearance="selected" interactive={false} onSelect={onSelect} />)}
          </group>

          {placement && placementDefinition && placementPreview && (
            <PlacementGhost definition={placementDefinition} color={placement.color} placement={placementPreview} motion={motion} />
          )}

          {pendingProposal && (
            <GhostProposal
              key={pendingProposal.id}
              proposal={pendingProposal}
              current={document}
              revealed={revealCount}
            />
          )}

          {renderMode === 'connections' &&
            Object.values(document.parts).flatMap((part) =>
              getWorldConnectors(part).map((feature) => (
                <mesh
                  key={`${feature.partId}_${feature.id}`}
                  position={feature.frame.position as unknown as [number, number, number]}
                >
                  <sphereGeometry args={[2.4, 10, 10]} />
                  <meshBasicMaterial
                    color={feature.gender === 'male' ? '#f4aa45' : '#7cefe7'}
                    depthTest={false}
                    transparent
                    opacity={0.9}
                  />
                </mesh>
              )),
            )}
        </group>
        </EdgeLodProvider>

        <ViewportControls
          document={document}
          selection={selection}
          registry={registry}
          visibility={visibility}
          onVisibilityChange={setVisibility}
          sectionPlanes={sectionPlanes}
          onSectionPlanesChange={setSectionPlanes}
          motion={motion}
          environment={environmentOverride ?? environment}
          quality={qualityOverride ?? quality}
          onQuality={handleQuality}
          onEnvironmentRequest={setEnvironmentOverride}
          onQualityRequest={setQualityOverride}
          onTransmissionRequest={setTransmissionOverride}
          onJointPreview={handleJointPreview}
          onOverlay={setOverlay}
          onSelect={onSelect}
          onSelectMany={selectMany}
          onClearSelection={onClearSelection}
          extent={Math.max(12, shadowExtent * 1.6)}
          enabled={!placing}
          handleRef={controlsHandle}
          onJointsChange={handleJoints}
          onSweepChange={handleSweep}
        />

        <AnimationDriver
          motion={motion}
          proposalPartCount={animation?.proposalReveal === false ? 0 : proposalPartCount}
          turntable={Boolean(animation?.turntable)}
          playback={Boolean(animation?.instructionPlayback)}
          stepCount={document.steps.length}
          onReveal={setRevealed}
          onPlayback={setPlaybackStep}
        />

        <SectionHandles planes={sectionPlanes} extent={Math.max(12, shadowExtent * 1.6)} controls={controlsHandle} />
        <JointHandles joints={joints} activeEdgeId={activeJointEdge} sweep={sweep} controls={controlsHandle} />
        <BlockingMarker pointLdu={sweep?.blocking?.pointLdu ?? null} />

        {manipulatedParts.length > 0 && !activeJointEdge && (
          <SelectionManipulator
            key={manipulatedParts.map((part) => part.id).join('|')}
            parts={manipulatedParts}
            preferences={transformPreferences}
            tool={tool === 'rotate' ? 'rotate' : 'move'}
            gridLdu={gridLdu}
            document={document}
            onPreview={setDragPreview}
            onCommitPart={commitDrag}
            onCommitGroup={commitGroupDrag}
          />
        )}

        {placement && onPlace && (
          <PlacementController
            request={placement}
            model={placementModel}
            gridLdu={gridLdu}
            root={root}
            dropAt={dropAt}
            onPreview={reportPlacement}
            onPlace={onPlace}
            onDropHandled={onDropHandled}
          />
        )}

        <Grid
          position={[0, -0.02, 0]}
          args={[240, 240]}
          cellSize={1}
          cellThickness={0.6}
          cellColor="#253135"
          sectionSize={4}
          sectionThickness={1.15}
          sectionColor="#3a4d51"
          fadeDistance={110}
          fadeStrength={1.6}
          infiniteGrid
        />
        {/* Contact shadow scaled to the model, so a city block is not sitting on
          a 70-unit patch that ends halfway across it. Both shadow passes are
          driven from the model's own content rather than from the frame clock:
          see `render/StaticShadows`. */}
        <StaticShadows
          position={[0, -0.014, 0]}
          scale={Math.max(24, shadowExtent * 2.4)}
          opacity={0.62}
          blur={1.9}
          far={Math.max(18, shadowExtent)}
          resolution={tier.contactShadowResolution}
          color="#000000"
          revision={shadowRevision}
        />
        <CameraRig
          bounds={displayBounds}
          documentId={document.id}
          hasParts={members.length > 0}
          exploded={renderMode === 'exploded'}
          view={cameraView}
          placing={placing}
          resetKey={cameraResetKey + captureFrameKey}
          motion={motion}
        />
        <CanvasMetadata renderMode={renderMode} cameraView={cameraView} />
        <fog attach="fog" args={['#0b1012', 90, 220]} />
      </Canvas>
      {overlay.marquee && (
        <div
          className="marquee-box"
          aria-hidden="true"
          style={{
            left: overlay.marquee.left,
            top: overlay.marquee.top,
            width: overlay.marquee.width,
            height: overlay.marquee.height,
          }}
        />
      )}
      {overlay.lasso && overlay.lasso.length > 1 && (
        <svg className="lasso-overlay" aria-hidden="true" style={LASSO_STYLE}>
          <polygon
            points={overlay.lasso.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="rgba(124, 239, 231, 0.08)"
            stroke="#7cefe7"
            strokeWidth={1.2}
            strokeDasharray="5 4"
          />
        </svg>
      )}
      {overlay.sweep && (
        <div
          className="sweep-readout"
          role="status"
          data-blocked={overlay.sweep.blocked ? 'true' : 'false'}
          style={SWEEP_STYLE}
        >
          {overlay.sweep.text}
        </div>
      )}
    </>
  )
}

/**
 * Inline styles for the two overlays this workstream adds.
 *
 * Deliberately inline: the stylesheet is owned by the workbench, and a renderer
 * feature that only works once somebody else's CSS lands is a feature that will
 * ship broken. Class names are still emitted so the styling can be taken over
 * without touching this file.
 */
const LASSO_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 6,
}

const SWEEP_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  padding: '6px 14px',
  borderRadius: 4,
  fontSize: 12,
  letterSpacing: '0.04em',
  pointerEvents: 'none',
  background: 'rgba(6, 12, 14, 0.86)',
  border: '1px solid rgba(124, 239, 231, 0.35)',
  color: '#cfeeea',
  zIndex: 7,
}

/** Records the current diagnostic state on the canvas, for capture metadata. */
function CanvasMetadata({ renderMode, cameraView }: { renderMode: RenderMode; cameraView: CameraView }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.domElement.dataset.renderMode = renderMode
    gl.domElement.dataset.cameraView = cameraView
  }, [cameraView, gl, renderMode])
  return null
}

/** Bridges the section manipulator's R3F events into the control surface. */
function SectionHandles({
  planes,
  extent,
  controls,
}: {
  planes: readonly SectionPlane[]
  extent: number
  controls: React.RefObject<ViewportControlsHandle | null>
}) {
  const { gl } = useThree()
  const onGrab = useCallback(
    (planeId: string, mode: 'offset' | 'rotate', event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0 || !pointerRouterFor(gl.domElement).accepts(event.nativeEvent)) return
      const point = canvasPointOf(event, gl.domElement)
      controls.current?.surface.beginSectionDrag(planeId, mode, point.x, point.y)
    },
    [controls, gl],
  )
  if (!planes.length) return null
  return <SectionManipulators planes={planes} extent={extent} onGrab={onGrab} />
}

/** Bridges the joint manipulator's R3F events into the control surface. */
function JointHandles({
  joints,
  activeEdgeId,
  sweep,
  controls,
}: {
  joints: readonly ArticulatedJoint[]
  activeEdgeId: string | null
  sweep: SweepResult | null
  controls: React.RefObject<ViewportControlsHandle | null>
}) {
  const { gl } = useThree()
  const onGrab = useCallback(
    (
      edgeId: string,
      handle: Parameters<RendererControlSurface['beginJointDrag']>[1],
      event: ThreeEvent<PointerEvent>,
    ) => {
      if (event.button !== 0 || !pointerRouterFor(gl.domElement).accepts(event.nativeEvent)) return
      const point = canvasPointOf(event, gl.domElement)
      controls.current?.surface.beginJointDrag(edgeId, handle, point.x, point.y)
    },
    [controls, gl],
  )
  if (!joints.length) return null
  return (
    <JointManipulators joints={joints} activeEdgeId={activeEdgeId} blocked={Boolean(sweep?.blocking)} onGrab={onGrab} />
  )
}

export { MOTION_DURATIONS }
