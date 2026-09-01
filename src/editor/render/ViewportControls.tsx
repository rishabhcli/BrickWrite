import { type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { findArticulatedJoints, type ArticulatedJoint } from '../../cad/articulation'
import { commandBus } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { canonicalTransform } from '../../cad/math'
import type { ModelDocument, Transform, Vec3 } from '../../cad/types'
import { createEnvironment, ENVIRONMENT_INTENSITY, type EnvironmentName } from '../environment'
import { hashPixels, type CaptureMetadata } from './capture'
import {
  installControlSurface,
  summariseJoint,
  type JointDragReport,
  type PickReport,
  type RegionReport,
  type RendererControlSurface,
  type RendererStats,
  type VisibilityPatch,
  type VisibilityReport,
} from './controlSurface'
import { DerivedRunner, graphOf } from './derived'
import { documentRayFromCanvas, lduDirectionToScene, lduToScene, projectLdu } from './frame'
import { cameraControlsOf, cameraTarget, frameCamera } from './cameraControl'
import { CLICK_SLOP_PX, pointerRouterFor } from './pointerRouter'
import { IdPass, OcclusionCycle } from './idPass'
import { PickRegistry } from './ids'
import {
  beginJointDrag as beginJointDragMath,
  handlesFor,
  jointCommitLabel,
  jointOperations,
  previewTransforms,
  updateJointDrag as updateJointDragMath,
  type JointDragGrab,
  type JointDragRequest,
  type JointHandle,
} from './jointDrag'
import { MotionController } from './motion'
import { QualityController, type QualityTier } from './quality'
import { centresInRegion, type RegionOptions, type RegionShape } from './regionSelect'
import { rendererResources, type ResourceCounts } from './resources'
import {
  bearingInPlane,
  intersectPlane,
  offsetPlaneFromDrag,
  projectRayOntoAxis,
  rotatePlaneFromDrag,
  createSectionPlane,
  type SectionPlane,
} from './sectionPlanes'
import { describeSweep, sweepJoint, type SweepResult } from './sweep'
import { NamedViewStore, resolveVisibility, type NamedView, type VisibilityState } from './visibility'

/**
 * The renderer's control layer.
 *
 * Everything that is *not* "draw the model" lives here: GPU picking, region
 * selection, visibility, section planes, joint dragging, adaptive quality,
 * capture settling and context-loss recovery. It sits inside the R3F canvas
 * because it needs the live renderer, scene and camera, and it publishes an
 * imperative surface because the things it does are triggered by pointers,
 * agents and tests rather than by rendering.
 *
 * Two rules shape the whole file:
 *
 *   - **Nothing here writes the document except a committed drag.** A preview is
 *     a transform map handed back to the viewport for drawing. The only call
 *     into `commandBus` is in `commitJointDrag`, and it happens once.
 *   - **Every capability is reachable without the UI.** The workbench can draw
 *     whatever controls it likes on top; the behaviour is here, and the
 *     acceptance run exercises the same entry points an operator does.
 */


export interface ViewportControlsHandle {
  readonly surface: RendererControlSurface
}

export interface OverlayState {
  readonly marquee: { left: number; top: number; width: number; height: number } | null
  readonly lasso: ReadonlyArray<readonly [number, number]> | null
  readonly sweep: { text: string; blocked: boolean } | null
}

export interface ViewportControlsProps {
  document: ModelDocument
  selection: readonly string[]
  /** Shared with the batch plan, so drawn identities and resolved ones agree. */
  registry: PickRegistry
  visibility: VisibilityState
  onVisibilityChange: (next: VisibilityState) => void
  sectionPlanes: readonly SectionPlane[]
  onSectionPlanesChange: (next: readonly SectionPlane[]) => void
  motion: MotionController
  environment: EnvironmentName
  quality: number | 'auto'
  onQuality: (tier: QualityTier, index: number) => void
  /** Lets the imperative surface change what are otherwise props. */
  onEnvironmentRequest?: (name: EnvironmentName) => void
  onQualityRequest?: (index: number | 'auto') => void
  onTransmissionRequest?: (enabled: boolean) => void
  /** Live joint-drag preview, drawn instead of the stored pose. */
  onJointPreview: (preview: Map<string, Transform> | null, edgeId: string | null) => void
  onOverlay: (overlay: OverlayState) => void
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onSelectMany: (partIds: string[], additive: boolean) => void
  onClearSelection: () => void
  /**
   * Dragging a part that is *already selected* reseats it.
   *
   * Scoped to the current selection on purpose: a bare left-drag orbits the
   * camera, including when it starts over the model, and making any drag move
   * whatever it landed on would cost the ability to orbit from anywhere. Click
   * the part first, then drag it.
   *
   * `onBeginPartDrag` returns false when the pick-up is refused, in which case
   * the gesture stays an orbit.
   */
  onBeginPartDrag?: (partId: string) => boolean
  onEndPartDrag?: (clientX: number, clientY: number) => void
  /** Extent of the drawn model in scene units, for sizing section handles. */
  extent: number
  /** Suppressed while a placement ghost owns the pointer. */
  enabled: boolean
  handleRef?: RefObject<ViewportControlsHandle | null>
  onJointsChange?: (joints: readonly ArticulatedJoint[]) => void
  onSweepChange?: (result: SweepResult | null) => void
}

/**
 * How long a swept-collision check may take before the drag starts rationing it.
 *
 * Half a 60 Hz frame. Above this the sweep is competing with the render for the
 * same 16 ms, and the render has to win — a stale legality readout is a smaller
 * lie than a drag that stutters.
 */
const SWEEP_FRAME_BUDGET_MS = 8

export function ViewportControls(props: ViewportControlsProps) {
  const {
    document: model,
    selection,
    registry,
    visibility,
    onVisibilityChange,
    sectionPlanes,
    onSectionPlanesChange,
    motion,
    environment,
    quality,
    onQuality,
    onEnvironmentRequest,
    onQualityRequest,
    onTransmissionRequest,
    onJointPreview,
    onOverlay,
    onSelect,
    onSelectMany,
    onClearSelection,
    onBeginPartDrag,
    onEndPartDrag,
    extent,
    enabled,
    handleRef,
    onJointsChange,
    onSweepChange,
  } = props

  const { gl, scene, camera, size, controls } = useThree()
  const router = pointerRouterFor(gl.domElement)

  // -- long-lived machinery -------------------------------------------------
  const idPass = useMemo(() => new IdPass(gl, scene, { registry }), [gl, scene, registry])
  const cycle = useMemo(() => new OcclusionCycle(), [])
  const views = useMemo(() => new NamedViewStore(), [])
  const derived = useMemo(() => new DerivedRunner(), [])
  const qualityController = useMemo(() => new QualityController(), [])
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

  useEffect(
    () => () => {
      idPass.dispose()
      derived.dispose()
    },
    [derived, idPass],
  )

  const warmState = useRef({ scheduled: false, complete: false, idle: 0, raf: 0 })
  useEffect(() => {
    const state = warmState.current
    state.complete = false
    return () => {
      cancelAnimationFrame(state.raf)
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(state.idle)
      else clearTimeout(state.idle)
      state.scheduled = false
    }
  }, [camera, idPass, model.id, size.width, size.height])
  useFrame(() => {
    const state = warmState.current
    if (state.scheduled || state.complete) return
    let drawable = false
    scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && object.userData.pickIdBase !== undefined) drawable = true
    })
    if (!drawable) return
    state.scheduled = true
    // The next RAF is after this beauty frame. Idle warm-up compiles actual
    // geometry, not the empty off-canvas pixel used by the old warm path.
    state.raf = requestAnimationFrame(() => {
      const warm = () => { idPass.warm(camera); state.complete = true; state.scheduled = false }
      state.idle = typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(warm, { timeout: 1500 }) : window.setTimeout(warm, 0)
    })
  })

  // Props read from callbacks that outlive a render. Refs rather than
  // dependencies, because rebuilding the pointer listeners on every document
  // revision would drop an in-flight drag.
  const latest = useRef({
    model,
    selection,
    visibility,
    sectionPlanes,
    enabled,
    extent,
    camera,
    size,
    joints: [] as readonly ArticulatedJoint[],
  })
  latest.current = { ...latest.current, model, selection, visibility, sectionPlanes, enabled, extent, camera, size }

  const stats = useRef({ contextLosses: 0, contextRestores: 0, fps: 0, tier: 'high', tierIndex: 1 })

  // -- clipping ------------------------------------------------------------
  // Section planes are global renderer clipping planes rather than per-material
  // ones, so a plane also clips the identity pass — which is what makes
  // "clipped geometry cannot be picked" true rather than merely intended.
  useEffect(() => {
    const active = sectionPlanes.filter((plane) => plane.enabled)
    gl.localClippingEnabled = true
    gl.clippingPlanes = active.map((plane) => {
      const normal = lduDirectionToScene(plane.normal)
      return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, lduToScene(plane.origin))
    })
    return () => {
      gl.clippingPlanes = []
    }
  }, [gl, sectionPlanes])

  // -- environment ---------------------------------------------------------
  useEffect(() => {
    const texture = rendererResources.track('environment', 'texture', createEnvironment(gl, environment), environment)
    const previous = scene.environment
    scene.environment = texture
    scene.environmentIntensity = ENVIRONMENT_INTENSITY[environment]
    return () => {
      if (scene.environment === texture) scene.environment = previous
      rendererResources.release(texture)
    }
  }, [environment, gl, scene])

  // -- adaptive quality ----------------------------------------------------
  const lastFrameAt = useRef(0)
  useFrame(() => {
    const now = performance.now()
    const delta = lastFrameAt.current ? now - lastFrameAt.current : 0
    lastFrameAt.current = now
    if (!delta) return
    if (quality !== 'auto') return
    const decision = qualityController.sample(delta, now)
    stats.current.fps = decision.fps
    if (decision.changed) {
      stats.current.tier = decision.tier.name
      stats.current.tierIndex = decision.index
      onQuality(decision.tier, decision.index)
    }
  })
  useEffect(() => {
    if (quality === 'auto') return
    qualityController.pin(quality)
    const decision = qualityController.current
    stats.current.tier = decision.tier.name
    stats.current.tierIndex = decision.index
    onQuality(decision.tier, decision.index)
  }, [onQuality, quality, qualityController])

  // -- context loss --------------------------------------------------------
  // A lost context is not an error path: switching GPUs, waking from sleep and
  // a driver reset all produce one, and a viewport that comes back blank has
  // lost the operator's model as far as they can tell.
  useEffect(() => {
    const canvas = gl.domElement
    const onLost = (event: Event) => {
      // Without this the browser will not attempt a restore at all.
      event.preventDefault()
      stats.current.contextLosses += 1
    }
    const onRestored = () => {
      stats.current.contextRestores += 1
      // The prefiltered environment and the identity target lived in the lost
      // context and are gone; both are rebuilt from their own sources rather
      // than from anything that had to survive.
      idPass.restore()
      const texture = rendererResources.track('environment', 'texture', createEnvironment(gl, environment), environment)
      scene.environment = texture
      scene.environmentIntensity = ENVIRONMENT_INTENSITY[environment]
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) for (const entry of material) entry.needsUpdate = true
        else if (material) material.needsUpdate = true
      })
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [environment, gl, idPass, scene])

  // -- joints --------------------------------------------------------------
  const joints = useMemo(
    () => (selection.length ? findArticulatedJoints(model, [...selection]) : []),
    [model, selection],
  )
  // The published surface is a *stable* object: an agent, a panel or a test
  // that holds a reference to it must not find itself calling a snapshot from
  // three selections ago. Everything volatile is therefore read through this
  // ref rather than closed over.
  latest.current.joints = joints
  useEffect(() => onJointsChange?.(joints), [joints, onJointsChange])

  const jointDrag = useRef<{
    joint: ArticulatedJoint
    grab: JointDragGrab
    request: JointDragRequest
    startPoses: Map<string, string>
    sweep: SweepResult | null
    /** When the last sweep finished, so the next one can be timed against it. */
    sweptAt: number
    commits: number
  } | null>(null)

  const sectionDrag = useRef<{
    id: string
    mode: 'offset' | 'rotate'
    grabOffset: number
    grabBearing: number
    reference: Vec3
    start: SectionPlane
  } | null>(null)

  /**
   * Set when a manipulator handle takes the pointer, cleared when it lets go.
   *
   * A grab and a selection click are the same gesture as far as the canvas
   * listener is concerned, so the grab has to claim it. Clearing on *release*
   * rather than on the next click is the part that matters: leaving it set made
   * the click after an `Escape`-cancelled drag, or after a programmatic
   * `endSectionDrag`, disappear — the operator clicked a brick and nothing
   * happened, once, with no way to tell why.
   */
  const suppressClick = useRef(false)

  const rayAt = useCallback(
    (canvasX: number, canvasY: number) =>
      documentRayFromCanvas(
        latest.current.camera,
        canvasX,
        canvasY,
        latest.current.size.width,
        latest.current.size.height,
        raycaster,
      ),
    [raycaster],
  )

  const publishJointDrag = useCallback((): JointDragReport => {
    const drag = jointDrag.current
    if (!drag) {
      return {
        active: false,
        edgeId: null,
        handle: null,
        rotateDegrees: 0,
        slideLdu: 0,
        previewCount: 0,
        sweep: null,
        commits: 0,
      }
    }
    const preview = previewTransforms(latest.current.model, drag.joint, drag.request)
    return {
      active: true,
      edgeId: drag.joint.edgeId,
      handle: drag.grab.handle,
      rotateDegrees: drag.request.rotateDegrees,
      slideLdu: drag.request.slideLdu,
      previewCount: preview.size,
      sweep: drag.sweep,
      commits: drag.commits,
    }
  }, [])

  const beginJoint = useCallback(
    (edgeId: string, handle: JointHandle, canvasX: number, canvasY: number): boolean => {
      if (router.placementArmed || ['gizmo', 'section', 'marquee'].includes(router.owner) || jointDrag.current || sectionDrag.current) return false
      const joint = latest.current.joints.find((candidate) => candidate.edgeId === edgeId)
      if (!joint || !handlesFor(joint).includes(handle)) return false
      const grab = beginJointDragMath(joint, handle, rayAt(canvasX, canvasY))
      if (!grab) return false
      // The starting poses are recorded as canonical strings, which is what lets
      // `Escape` be *proved* to restore exactly rather than approximately.
      const startPoses = new Map<string, string>()
      for (const partId of joint.movingPartIds) {
        const part = latest.current.model.parts[partId]
        if (part) startPoses.set(partId, canonicalTransform(part.transform))
      }
      jointDrag.current = {
        joint,
        grab,
        request: { rotateDegrees: 0, slideLdu: 0 },
        startPoses,
        sweep: null,
        sweptAt: 0,
        commits: 0,
      }
      suppressClick.current = true
      router.claim('joint')
      return true
    },
    [router, rayAt],
  )

  const updateJoint = useCallback(
    (canvasX: number, canvasY: number): JointDragReport => {
      const drag = jointDrag.current
      if (!drag) return publishJointDrag()
      drag.request = updateJointDragMath(drag.joint, drag.grab, rayAt(canvasX, canvasY))

      // The visual moves every sample, unconditionally. It is `articulate` over
      // the island — a few dozen matrix multiplies — and it is what the hand
      // feels, so it is never the thing that gets skipped.
      const preview = previewTransforms(latest.current.model, drag.joint, drag.request)
      onJointPreview(preview.size ? preview : null, drag.joint.edgeId)

      // The legality oracle is not free at every scale. On a small model the
      // swept-envelope neighbourhood is tens of parts and this runs every
      // rendered sample; dragged through a dense region of an 11k-part model
      // the same call can cost more than a frame, and paying it every sample
      // would make the drag hitch precisely when the operator is threading a
      // part through a tight space and needs the motion smooth.
      //
      // So the sweep runs when the last one says it fits, and otherwise waits
      // until at least its own measured cost has passed — a duty cycle of about
      // half, which keeps the readout live without owning the frame. Nothing is
      // lost by skipping: `endJoint` re-sweeps unconditionally before it
      // commits, so what lands in the document is always fully checked.
      const now = performance.now()
      const affordable = !drag.sweep || drag.sweep.elapsedMs <= SWEEP_FRAME_BUDGET_MS
      if (affordable || now - drag.sweptAt >= drag.sweep!.elapsedMs) {
        drag.sweep = sweepJoint(latest.current.model, drag.joint, drag.request)
        drag.sweptAt = performance.now()
        onSweepChange?.(drag.sweep)
      }
      if (drag.sweep) {
        onOverlay({ marquee: null, lasso: null,
          sweep: { text: describeSweep(drag.sweep, drag.request), blocked: Boolean(drag.sweep.blocking) } })
      }
      return publishJointDrag()
    },
    [onJointPreview, onOverlay, onSweepChange, publishJointDrag, rayAt],
  )

  const endJoint = useCallback(
    (commit: boolean): JointDragReport => {
      const drag = jointDrag.current
      if (!drag) return publishJointDrag()
      router.release('joint')

      suppressClick.current = false
      let commits = 0
      if (commit) {
        drag.sweep = sweepJoint(latest.current.model, drag.joint, drag.request)
        // Commit the *permissible* motion when a sweep found a block, not the
        // pose the cursor reached. Committing through a collision and letting
        // validation flag it afterwards would make the tool complicit in a build
        // that cannot exist.
        const request = drag.sweep?.blocking ? drag.sweep.permissible : drag.request
        const operations = jointOperations(latest.current.model, drag.joint, request)
        if (operations.length) {
          const result = commandBus.dispatch(jointCommitLabel(drag.joint, request), operations, 'human', undefined, 'joint-drag')
          commits = result.ok ? 1 : 0
        }
      }
      drag.commits = commits
      const report: JointDragReport = { ...publishJointDrag(), commits, active: false, previewCount: 0 }
      jointDrag.current = null
      onJointPreview(null, null)
      onSweepChange?.(null)
      onOverlay({ marquee: null, lasso: null, sweep: null })
      return report
    },
    [router, onJointPreview, onOverlay, onSweepChange, publishJointDrag],
  )

  // Escape restores the starting transforms, which costs nothing because they
  // were never written: the drag only ever produced a preview map.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!jointDrag.current && !sectionDrag.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (jointDrag.current) endJoint(false)
      if (sectionDrag.current) {
        const start = sectionDrag.current.start
        sectionDrag.current = null
        router.release('section')
        suppressClick.current = false
        onSectionPlanesChange(latest.current.sectionPlanes.map((plane) => (plane.id === start.id ? start : plane)))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [endJoint, onSectionPlanesChange, router])

  // -- section plane drags -------------------------------------------------
  const beginSection = useCallback(
    (id: string, mode: 'offset' | 'rotate', canvasX: number, canvasY: number): boolean => {
      if (router.placementArmed || ['gizmo', 'joint', 'marquee'].includes(router.owner) || jointDrag.current || sectionDrag.current) return false
      const plane = latest.current.sectionPlanes.find((candidate) => candidate.id === id)
      if (!plane) return false
      const ray = rayAt(canvasX, canvasY)
      if (mode === 'offset') {
        const grabOffset = projectRayOntoAxis(plane.origin, plane.normal, ray)
        if (grabOffset === null) return false
        sectionDrag.current = { id, mode, grabOffset, grabBearing: 0, reference: [1, 0, 0], start: plane }
      } else {
        const hit = intersectPlane(plane, ray)
        if (!hit) return false
        const reference: Vec3 = [hit[0] - plane.origin[0], hit[1] - plane.origin[1], hit[2] - plane.origin[2]]
        sectionDrag.current = {
          id,
          mode,
          grabOffset: 0,
          grabBearing: bearingInPlane(plane, reference, hit),
          reference,
          start: plane,
        }
      }
      suppressClick.current = true
      router.claim('section')
      return true
    },
    [router, rayAt],
  )

  const updateSection = useCallback(
    (canvasX: number, canvasY: number): SectionPlane | null => {
      const drag = sectionDrag.current
      if (!drag) return null
      const planes = latest.current.sectionPlanes
      const plane = planes.find((candidate) => candidate.id === drag.id)
      if (!plane) return null
      const ray = rayAt(canvasX, canvasY)
      let next: SectionPlane
      if (drag.mode === 'offset') {
        next = offsetPlaneFromDrag(plane, ray, drag.grabOffset)
        // The grab parameter is measured against the plane's own origin, which
        // has just moved; re-reading it keeps the handle under the cursor rather
        // than accelerating away from it.
        const regrab = projectRayOntoAxis(next.origin, next.normal, ray)
        if (regrab !== null) drag.grabOffset = regrab
      } else {
        const hit = intersectPlane(plane, ray)
        if (!hit) return plane
        const bearing = bearingInPlane(plane, drag.reference, hit)
        // The ring lies in the plane, so it turns about an axis in the plane:
        // the reference direction itself.
        next = rotatePlaneFromDrag(plane, drag.reference, bearing - drag.grabBearing)
        drag.grabBearing = bearing
      }
      onSectionPlanesChange(planes.map((candidate) => (candidate.id === drag.id ? next : candidate)))
      return next
    },
    [onSectionPlanesChange, rayAt],
  )

  const endSection = useCallback((): SectionPlane | null => {
    const drag = sectionDrag.current
    sectionDrag.current = null
    suppressClick.current = false
    router.release('section')
    if (!drag) return null
    return latest.current.sectionPlanes.find((plane) => plane.id === drag.id) ?? null
  }, [router])

  // -- picking -------------------------------------------------------------
  const pick = useCallback(
    (canvasX: number, canvasY: number, options: { radius?: number; cycle?: boolean } = {}): PickReport => {
      const hidden = options.cycle ? cycle.hiddenFor(canvasX, canvasY, performance.now()) : []
      if (!options.cycle) cycle.reset()
      const result = idPass.pick(latest.current.camera, canvasX, canvasY, { radius: options.radius, hidden })
      if (options.cycle) cycle.record(result.id)
      return { partId: result.partId, id: result.id, latencyMs: result.latencyMs, cycleDepth: hidden.length }
    },
    [cycle, idPass],
  )

  const pickRegion = useCallback(
    (shape: RegionShape, options: RegionOptions = {}): RegionReport => {
      const { camera: activeCamera, size: activeSize } = latest.current
      const result = idPass.pickRegion(activeCamera, shape, options)
      // The projected-centre answer is computed alongside so the difference
      // between the two rules is observable rather than argued.
      const centres = Object.values(latest.current.model.parts).map((part) => {
        const projected = projectLdu(activeCamera, part.transform.position, activeSize.width, activeSize.height)
        return { id: part.id, x: projected.x, y: projected.y, behindCamera: projected.behindCamera }
      })
      return {
        partIds: result.partIds,
        pixels: result.pixels,
        latencyMs: result.latencyMs,
        centreRuleWouldSelect: centresInRegion(centres, shape),
      }
    },
    [idPass],
  )

  // -- pointer wiring ------------------------------------------------------
  /**
   * The pointer handlers' dependencies, held in a ref.
   *
   * The listeners are installed once and read the current callbacks from here,
   * rather than being torn down and reinstalled whenever one of them changes
   * identity. That is not a micro-optimisation: the drag's own state lives in
   * the effect's closure, so re-running the effect *drops an in-flight drag*.
   * A parent that re-renders mid-drag — which the workbench does on every
   * selection change, because it passes inline arrow props — would silently
   * cancel a box selection between the operator pressing and releasing. It
   * presented as a marquee that drew correctly and then selected nothing.
   */
  const handlers = useRef({
    pick,
    pickRegion,
    updateJoint,
    updateSection,
    endJoint,
    endSection,
    onSelect,
    onSelectMany,
    onClearSelection,
    onOverlay,
    onBeginPartDrag,
    onEndPartDrag,
  })
  handlers.current = {
    pick,
    pickRegion,
    updateJoint,
    updateSection,
    endJoint,
    endSection,
    onSelect,
    onSelectMany,
    onClearSelection,
    onOverlay,
    onBeginPartDrag,
    onEndPartDrag,
  }

  const pendingJointPoint = useRef<{x: number; y: number} | null>(null)
  useFrame(() => {
    const point = pendingJointPoint.current
    pendingJointPoint.current = null
    if (point && jointDrag.current) handlers.current.updateJoint(point.x, point.y)
  })

  useEffect(() => {
    const element = gl.domElement
    let pressed: { x: number; y: number; button: number; shift: boolean; alt: boolean } | null = null
    let lasso: Array<readonly [number, number]> | null = null
    /** Set on press when the pointer landed on a part that is already selected. */
    let grabbed: { partId: string; x: number; y: number } | null = null
    let reseating = false

    const local = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }

    const onDown = (event: PointerEvent) => {
      if (!router.accepts(event) || !latest.current.enabled || !['select', 'orbit', 'marquee'].includes(router.owner)) return
      const point = local(event)
      pressed = { x: point.x, y: point.y, button: event.button, shift: event.shiftKey, alt: event.altKey }
      if (event.button !== 0) return
      // Only worth an identity read when something is selected to grab, so an
      // ordinary orbit press does not pay for a pick it will not use.
      grabbed = null
      reseating = false
      if (!event.shiftKey && !event.altKey && latest.current.selection.length > 0 && handlers.current.onBeginPartDrag) {
        const hit = handlers.current.pick(point.x, point.y, { cycle: false })
        if (hit.partId && latest.current.selection.includes(hit.partId)) {
          grabbed = { partId: hit.partId, x: point.x, y: point.y }
        }
      }
      if (event.altKey) {
        lasso = [[point.x, point.y]]
        router.claim('marquee')
        handlers.current.onOverlay({ marquee: null, lasso, sweep: null })
      } else if (event.shiftKey) {
        router.claim('marquee')
        handlers.current.onOverlay({
          marquee: { left: point.x, top: point.y, width: 0, height: 0 },
          lasso: null,
          sweep: null,
        })
      }
    }

    const onMove = (event: PointerEvent) => {
      if (!router.accepts(event)) return
      const point = local(event)
      if (jointDrag.current) {
        pendingJointPoint.current = point
        return
      }
      if (sectionDrag.current) {
        handlers.current.updateSection(point.x, point.y)
        return
      }
      if (!pressed) return
      if (grabbed && !reseating && Math.hypot(point.x - grabbed.x, point.y - grabbed.y) > CLICK_SLOP_PX) {
        // Take the pointer away from the camera before the orbit accumulates,
        // then hand the part to the same placement pipeline a palette drop
        // uses. A refusal leaves the gesture as an orbit.
        reseating = handlers.current.onBeginPartDrag?.(grabbed.partId) ?? false
        if (reseating) router.claim('gizmo')
        else grabbed = null
      }
      if (reseating) return
      if (lasso) {
        const last = lasso[lasso.length - 1]
        // Points closer than two pixels add cost to the point-in-polygon test
        // without adding shape, and a hand-drawn lasso produces a great many of
        // them.
        if (Math.hypot(point.x - last[0], point.y - last[1]) >= 2) {
          lasso = [...lasso, [point.x, point.y]]
          handlers.current.onOverlay({ marquee: null, lasso, sweep: null })
        }
        return
      }
      if (pressed.shift) {
        handlers.current.onOverlay({
          marquee: {
            left: Math.min(pressed.x, point.x),
            top: Math.min(pressed.y, point.y),
            width: Math.abs(point.x - pressed.x),
            height: Math.abs(point.y - pressed.y),
          },
          lasso: null,
          sweep: null,
        })
      }
    }

    const restoreOrbit = () => router.release('marquee')

    const onUp = (event: PointerEvent) => {
      if (!router.accepts(event)) return
      const point = local(event)
      if (jointDrag.current) {
        pendingJointPoint.current = null
        handlers.current.updateJoint(point.x, point.y)
        handlers.current.endJoint(true)
        pressed = null
        return
      }
      if (sectionDrag.current) {
        handlers.current.endSection()
        pressed = null
        return
      }
      if (reseating) {
        const held = grabbed
        grabbed = null
        reseating = false
        pressed = null
        router.release('gizmo')
        if (held) handlers.current.onEndPartDrag?.(event.clientX, event.clientY)
        return
      }
      grabbed = null
      const start = pressed
      pressed = null
      if (!start || !latest.current.enabled) {
        lasso = null
        return
      }

      if (lasso) {
        const points = lasso.length >= 3 ? lasso : null
        lasso = null
        restoreOrbit()
        handlers.current.onOverlay({ marquee: null, lasso: null, sweep: null })
        if (points) {
          const region = handlers.current.pickRegion({ kind: 'lasso', points })
          handlers.current.onSelectMany([...region.partIds], true)
        }
        return
      }

      if (start.shift) {
        restoreOrbit()
        handlers.current.onOverlay({ marquee: null, lasso: null, sweep: null })
        const width = Math.abs(point.x - start.x)
        const height = Math.abs(point.y - start.y)
        // A shift-click that never became a drag is a click, handled below.
        if (width >= CLICK_SLOP_PX || height >= CLICK_SLOP_PX) {
          const region = handlers.current.pickRegion({
            kind: 'box',
            x0: start.x,
            y0: start.y,
            x1: point.x,
            y1: point.y,
          })
          handlers.current.onSelectMany([...region.partIds], true)
          return
        }
      }

      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      if (event.button !== 0) return
      // Anything that moved is an orbit, a pan or a gizmo drag, none of which
      // are a selection.
      if (Math.hypot(point.x - start.x, point.y - start.y) > CLICK_SLOP_PX) return

      const result = handlers.current.pick(point.x, point.y, { cycle: true })
      if (!result.partId) {
        handlers.current.onClearSelection()
        return
      }
      handlers.current.onSelect(result.partId, event.shiftKey, event.detail > 1)
    }

    const onCancel = (event?: Event) => {
      if (event && 'pointerId' in event && !router.accepts(event as PointerEvent)) return
      pendingJointPoint.current = null
      if (reseating) router.release('gizmo')
      grabbed = null
      reseating = false
      if (jointDrag.current) handlers.current.endJoint(false)
      if (sectionDrag.current) {
        const start = sectionDrag.current.start
        onSectionPlanesChange(latest.current.sectionPlanes.map((plane) => plane.id === start.id ? start : plane))
        handlers.current.endSection()
      }
      pressed = null
      lasso = null
      restoreOrbit()
      handlers.current.onOverlay({ marquee: null, lasso: null, sweep: null })
    }

    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onEscape)
    window.addEventListener('blur', onCancel)
    element.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      onCancel()
      window.removeEventListener('keydown', onEscape)
      window.removeEventListener('blur', onCancel)
      element.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // Only the renderer and the orbit controls; everything else is read from
    // the ref above, so a re-render cannot interrupt a drag.
  }, [router, gl, onSectionPlanesChange])

  // -- capture -------------------------------------------------------------
  const capture = useCallback(async (): Promise<CaptureMetadata & { dataUrl: string }> => {
    const release = motion.beginCapture()
    try {
      // Two frames: the first renders with animation suppressed, the second
      // guarantees the compositor has the settled image in the drawing buffer
      // before it is read.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const canvas = gl.domElement
      const context = gl.getContext()
      gl.setRenderTarget(null)
      const width = canvas.width
      const height = canvas.height
      const pixels = new Uint8Array(Math.max(4, width * height * 4))
      if (width && height) {
        context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels)
      }
      const resolved = resolveVisibility(latest.current.model, latest.current.visibility)
      return {
        documentRevision: latest.current.model.revision,
        renderMode: (canvas.dataset.renderMode as string) ?? 'beauty',
        cameraView: (canvas.dataset.cameraView as string) ?? 'isometric',
        width,
        height,
        // Sampled every seventh byte: coprime with the four-byte stride, so the
        // walk visits all channels, and fast enough that hashing does not become
        // the slowest part of a capture.
        pixelHash: hashPixels(pixels, 7),
        settled: !motion.policy.animated,
        visiblePartCount: resolved.solid.size,
        dataUrl: canvas.toDataURL('image/png'),
      }
    } finally {
      release()
    }
  }, [gl, motion])

  // A capture request arriving from the agent surface settles the renderer
  // before the frame the adapter is about to read. The adapter waits two frames
  // after dispatching, so entering capture here lands ahead of the read.
  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string }>).detail
      if (!detail?.requestId) return
      const release = motion.beginCapture()
      window.setTimeout(release, 400)
    }
    window.addEventListener('brickwright:set-camera-view', onRequest)
    return () => window.removeEventListener('brickwright:set-camera-view', onRequest)
  }, [motion])

  // -- visibility ----------------------------------------------------------
  const visibilityReport = useCallback(
    (state: VisibilityState): VisibilityReport => {
      const resolved = resolveVisibility(latest.current.model, state)
      return {
        solid: resolved.solid.size,
        ghosted: resolved.ghosted.size,
        hidden: resolved.hidden.size,
        ghostOpacity: resolved.ghostOpacity,
        isolating: Boolean(state.isolation),
        hops: state.isolation?.hops ?? 0,
        derivedOn: derived.mode,
      }
    },
    [derived],
  )

  // -- the published surface ----------------------------------------------
  const surface = useMemo<RendererControlSurface>(() => {
    const measureStats = (): RendererStats => {
      let edgeVertices = 0
      let batchEdgeVertices = 0
      const instanceBuffers: {objectId: number; count: number; capacity: number}[] = []
      scene.traverseVisible(object => {
        if (object instanceof THREE.LineSegments) {
          const drawn = Math.min(object.geometry.drawRange.count, object.geometry.getAttribute('position')?.count ?? 0)
          edgeVertices += drawn
          if (object.userData.partBatchEdges) batchEdgeVertices += drawn
        }
        if (object instanceof THREE.InstancedMesh && object.userData.pickIdBase !== undefined) {
          instanceBuffers.push({objectId: object.id, count: object.count, capacity: object.instanceMatrix.count})
        }
      })
      return ({
      edgeVertices, batchEdgeVertices, instanceBuffers, identityWarmupComplete: warmState.current.complete,
      drawCalls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      programs: gl.info.programs?.length ?? 0,
      fps: stats.current.fps,
      qualityTier: stats.current.tier,
      qualityIndex: stats.current.tierIndex,
      idPass: idPass.diagnostics,
      contextLosses: stats.current.contextLosses,
      contextRestores: stats.current.contextRestores,
    })
    }

    return {
      version: 1,
      pick: (x, y, options = {}) => pick(x, y, options),
      pickRegion: (shape, options) => pickRegion(shape, options),
      resetCycle: () => cycle.reset(),

      screenPositionOf: (partId) => {
        const target = latest.current.model.parts[partId]
        if (!target) return null
        const bounds = getPartBounds(target)
        const centre: Vec3 = bounds.measured
          ? [
              (bounds.min[0] + bounds.max[0]) / 2,
              (bounds.min[1] + bounds.max[1]) / 2,
              (bounds.min[2] + bounds.max[2]) / 2,
            ]
          : target.transform.position
        return projectLdu(latest.current.camera, centre, latest.current.size.width, latest.current.size.height)
      },
      projectPoint: (pointLdu) =>
        projectLdu(latest.current.camera, pointLdu as Vec3, latest.current.size.width, latest.current.size.height),
      frameParts: (partIds) => {
        const measured = partIds
          .map((partId) => latest.current.model.parts[partId])
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .map((entry) => getPartBounds(entry))
          .filter((entry) => entry.measured)
        if (!measured.length) return false
        const min: Vec3 = [
          Math.min(...measured.map((entry) => entry.min[0])),
          Math.min(...measured.map((entry) => entry.min[1])),
          Math.min(...measured.map((entry) => entry.min[2])),
        ]
        const max: Vec3 = [
          Math.max(...measured.map((entry) => entry.max[0])),
          Math.max(...measured.map((entry) => entry.max[1])),
          Math.max(...measured.map((entry) => entry.max[2])),
        ]
        const control = cameraControlsOf(controls)
        if (!control) return false
        frameCamera(control, { min, max }, latest.current.size, motion.policy.animated)
        return true
      },
      cameraPose: () => {
        const active = latest.current.camera
        const aim = cameraTarget(controls)
        const offset = active.position.clone().sub(aim)
        const spherical = new THREE.Spherical().setFromVector3(offset)
        return {
          yawDeg: THREE.MathUtils.radToDeg(spherical.theta),
          pitchDeg: 90 - THREE.MathUtils.radToDeg(spherical.phi),
          distance: spherical.radius,
          target: aim.toArray(), zoom: (active as THREE.PerspectiveCamera).zoom,
          enabled: cameraControlsOf(controls)?.enabled ?? false, pointerOwner: router.owner,
        }
      },

      setVisibility: async (patch: VisibilityPatch) => {
        const current = latest.current.visibility
        const seeds =
          patch.isolateSeedIds === undefined ? (current.isolation?.seedPartIds ?? null) : patch.isolateSeedIds
        const hops = patch.hops ?? current.isolation?.hops ?? 1
        // The hop walk runs on the worker when one exists. Its answer is not
        // needed to build the next state — `resolveVisibility` recomputes it —
        // but awaiting it is what keeps the reported `derivedOn` honest about
        // where the work actually happened.
        if (seeds && seeds.length) {
          await derived.run(graphOf(latest.current.model), seeds, hops)
        }
        const next: VisibilityState = {
          isolation: seeds && seeds.length ? { seedPartIds: [...seeds], hops } : null,
          outside: patch.outside ?? current.outside,
          ghostOpacity: patch.ghostOpacity ?? current.ghostOpacity,
          hiddenPartIds: patch.hiddenPartIds ? new Set(patch.hiddenPartIds) : current.hiddenPartIds,
        }
        onVisibilityChange(next)
        latest.current.visibility = next
        return visibilityReport(next)
      },
      getVisibility: () => visibilityReport(latest.current.visibility),

      saveView: (name) => {
        const active = latest.current.camera
        const target = cameraTarget(controls)
        const view: NamedView = {
          name,
          position: [active.position.x, active.position.y, active.position.z],
          target: [target.x, target.y, target.z],
          zoom: (active as THREE.OrthographicCamera).zoom ?? 1,
          orthographic: Boolean((active as THREE.OrthographicCamera).isOrthographicCamera),
          savedAt: new Date().toISOString(),
        }
        return views.save(view)
      },
      restoreView: (name) => {
        const view = views.get(name)
        if (!view) return false
        const control = cameraControlsOf(controls)
        if (!control) return false
        void control.setLookAt(...view.position, ...view.target, motion.policy.animated)
        if (control.camera instanceof THREE.OrthographicCamera) void control.zoomTo(view.zoom, motion.policy.animated)
        if (!motion.policy.animated) { control.update(0); control.camera.updateMatrixWorld(true) }
        return true
      },
      listViews: () => views.list(),
      removeView: (name) => views.remove(name),

      addSectionPlane: (axis) => {
        const bounds = Object.values(latest.current.model.parts).map((part) => part.transform.position)
        const centre: Vec3 = bounds.length
          ? [
              bounds.reduce((sum, position) => sum + position[0], 0) / bounds.length,
              bounds.reduce((sum, position) => sum + position[1], 0) / bounds.length,
              bounds.reduce((sum, position) => sum + position[2], 0) / bounds.length,
            ]
          : [0, 0, 0]
        const plane = createSectionPlane(axis, centre, `section_${axis}_${latest.current.sectionPlanes.length}`)
        onSectionPlanesChange([...latest.current.sectionPlanes, plane])
        latest.current.sectionPlanes = [...latest.current.sectionPlanes, plane]
        return plane
      },
      listSectionPlanes: () => latest.current.sectionPlanes,
      removeSectionPlane: (id) => {
        const next = latest.current.sectionPlanes.filter((plane) => plane.id !== id)
        const removed = next.length !== latest.current.sectionPlanes.length
        if (removed) {
          onSectionPlanesChange(next)
          latest.current.sectionPlanes = next
        }
        return removed
      },
      beginSectionDrag: (id, mode, x, y) => beginSection(id, mode, x, y),
      updateSectionDrag: (x, y) => updateSection(x, y),
      endSectionDrag: () => endSection(),

      listJoints: () =>
        latest.current.joints.map((joint) =>
          summariseJoint(
            joint,
            handlesFor(joint),
            projectLdu(latest.current.camera, joint.pivotLdu, latest.current.size.width, latest.current.size.height),
          ),
        ),
      beginJointDrag: (edgeId, handle, x, y) => beginJoint(edgeId, handle, x, y),
      updateJointDrag: (x, y) => updateJoint(x, y),
      cancelJointDrag: () => endJoint(false),
      commitJointDrag: () => endJoint(true),
      jointDragState: () => publishJointDrag(),

      setReducedMotion: (value) => motion.forceReducedMotion(value),
      motionPolicy: () => motion.policy,
      settle: () => window.dispatchEvent(new CustomEvent('brickwright:renderer-settle')),
      // Environment, quality and transmission are viewport state so that the
      // workbench and the surface cannot disagree about them; the surface asks
      // and the viewport decides, which is the same path a panel control takes.
      setEnvironment: (name) => onEnvironmentRequest?.(name),
      setQuality: (index) => onQualityRequest?.(index),
      setTransmission: (enabled) => onTransmissionRequest?.(enabled),

      capture,

      stats: measureStats,
      resources: (): ResourceCounts => rendererResources.counts(),
      loseContext: () => {
        gl.forceContextLoss()
        return true
      },
      restoreContext: () => {
        // Through the renderer's own cached extension object. Asking a *lost*
        // context for `WEBGL_lose_context` again does not reliably return the
        // instance that lost it, and the restore is silently ignored — the
        // context stays gone and the viewport stays blank.
        const renderer = gl as THREE.WebGLRenderer & { forceContextRestore?: () => void }
        if (typeof renderer.forceContextRestore === 'function') {
          renderer.forceContextRestore()
          return true
        }
        const extension = gl.getContext().getExtension('WEBGL_lose_context')
        if (!extension) return false
        extension.restoreContext()
        return true
      },
    }
    // Deliberately free of `camera`, `size`, `joints` and the request
    // callbacks: all of them are read through the ref, which is what keeps the
    // published object identical for the viewport's lifetime.
  }, [
    router,
    beginJoint,
    beginSection,
    capture,
    controls,
    cycle,
    derived,
    endJoint,
    endSection,
    gl,
    idPass,
    motion,
    onEnvironmentRequest,
    onQualityRequest,
    onSectionPlanesChange,
    onTransmissionRequest,
    onVisibilityChange,
    pick,
    pickRegion,
    publishJointDrag,
    updateJoint,
    updateSection,
    views,
    visibilityReport,
  ])

  useImperativeHandle(handleRef, () => ({ surface }), [surface])
  useEffect(() => installControlSurface(surface), [surface])

  return null
}

/**
 * Grab adapters for the manipulator components.
 *
 * The manipulators fire R3F pointer events; the drag machinery wants canvas
 * coordinates. Converting here keeps both sides ignorant of the other's frame.
 */
export function canvasPointOf(event: ThreeEvent<PointerEvent>, canvas: HTMLCanvasElement): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect()
  return { x: event.nativeEvent.clientX - bounds.left, y: event.nativeEvent.clientY - bounds.top }
}
