import { ContactShadows, GizmoHelper, GizmoViewport, Grid, OrbitControls, OrthographicCamera, PerspectiveCamera, TransformControls } from '@react-three/drei'
import { Canvas, useFrame, type ThreeEvent, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { ArticulatedJoint } from '../cad/articulation'
import { catalog } from '../cad/catalog'
import { getPartBounds, snapTransformPosition } from '../cad/geometry'
import { canonicalTransform } from '../cad/math'
import { resolvePlacement, type PlacementRequest } from '../cad/placement'
import { bestSnapTransform, getWorldConnectors } from '../cad/snapping'
import type { Bounds, ModelDocument, PartInstance, Proposal, Transform, Vec3 } from '../cad/types'
import { validateDocument } from '../cad/validation'
import { EDGE_RENDER_BUDGET, INDIVIDUAL_SELECTION_LIMIT, PartBatch, planBatches, type BatchMember } from './PartBatch'
import { createStudioEnvironment, type EnvironmentName } from './environment'
import { PartVisual, setTransmissionEnabled, TRANSMISSION_DRAW_BUDGET, type PartAppearance } from './PartVisual'
import { BlockingMarker, JointManipulators, SectionManipulators } from './render/Manipulators'
import { canvasPointOf, ViewportControls, type OverlayState, type ViewportControlsHandle } from './render/ViewportControls'
import type { RendererControlSurface } from './render/controlSurface'
import {
  documentTransformOf,
  lduToScene,
  MODEL_ROOT_ROTATION,
  MODEL_ROOT_SCALE,
  ROOT_MATRIX,
  ROOT_MATRIX_INVERSE,
  sceneMatrix,
  sceneToLdu,
} from './render/frame'
import { registerPickable, unregisterPickable } from './render/idPass'
import { PickRegistry } from './render/ids'
import { MotionController, MOTION_DURATIONS, playbackStepAt, staggeredProgress, turntableAngle } from './render/motion'
import { QUALITY_TIERS, type QualityTier } from './render/quality'
import type { SectionPlane } from './render/sectionPlanes'
import type { SweepResult } from './render/sweep'
import { DEFAULT_VISIBILITY, resolveVisibility, type VisibilityState } from './render/visibility'

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
      onPointerDown={(event: ThreeEvent<PointerEvent>) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(part.id, event.nativeEvent.shiftKey, event.nativeEvent.detail > 1)
      }}
      onDoubleClick={(event) => {
        if (!interactive) return
        event.stopPropagation()
        onSelect(part.id, false, true)
      }}
    >
      <PartVisual definition={definition} colorCode={part.color} appearance={appearance} fade={fade} />
    </group>
  )
}

/**
 * The translate/rotate gizmo, deliberately rendered outside the model root.
 *
 * `TransformControls` sizes its handles from the camera distance and then
 * inherits its parent's scale like any other object. Inside a root scaled to
 * 1/20 that made the gizmo twenty times too small to see or hit, so direct
 * manipulation looked simply absent. Here it attaches to a proxy that carries
 * the selected part's pose in *scene* space, and every pose read back out is
 * mapped through the root's inverse before it reaches the document.
 */
function SelectionManipulator({
  part,
  tool,
  gridLdu,
  document: model,
  onPreview,
  onCommit,
}: {
  part: PartInstance
  tool: 'move' | 'rotate'
  gridLdu: number
  document: ModelDocument
  onPreview: (transform: Transform | null) => void
  onCommit: (transform: Transform) => void
}) {
  const [proxy, setProxy] = useState<THREE.Object3D | null>(null)
  const controls = useRef<{ getHelper?: () => THREE.Object3D } & THREE.Object3D | null>(null)
  const dragging = useRef(false)
  const latest = useRef<Transform | null>(null)
  const lastSnapKey = useRef('')
  const { camera, size } = useThree()

  /**
   * Reports how many screen pixels the gizmo actually spans.
   *
   * This is the property that was silently broken: the handles were rendered,
   * but at a twentieth of their intended size, so "drag to move" was true in
   * the code and false on the screen. Measuring the drawn object rather than
   * asserting that a component mounted is what makes the browser acceptance run
   * able to catch that class of regression.
   */
  useEffect(() => {
    const probe = () => {
      const helper = controls.current?.getHelper?.() ?? controls.current
      if (!helper || !proxy) return { attached: false, screenPixels: 0 }
      // Only the drawn handles count. `TransformControls` also carries invisible
      // pickers and axis-length helper lines, and a bounding box over the whole
      // helper is dominated by those rather than by anything the operator sees.
      const box = new THREE.Box3()
      helper.traverseVisible((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        const material = mesh.material as THREE.Material | THREE.Material[]
        const opacity = Array.isArray(material) ? Math.max(...material.map((entry) => entry.opacity)) : material.opacity
        if (opacity < 0.2) return
        box.expandByObject(mesh)
      })
      if (box.isEmpty()) return { attached: true, screenPixels: 0 }
      const corners: THREE.Vector3[] = []
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        corners.push(new THREE.Vector3(x, y, z).project(camera))
      }
      const xs = corners.map((corner) => ((corner.x + 1) / 2) * size.width)
      const ys = corners.map((corner) => ((1 - corner.y) / 2) * size.height)
      const origin = proxy.getWorldPosition(new THREE.Vector3()).project(camera)
      return {
        attached: true,
        screenPixels: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
        // Canvas-relative centre, so an acceptance run can grab the handle
        // rather than guess where it is.
        centre: [((origin.x + 1) / 2) * size.width, ((1 - origin.y) / 2) * size.height],
      }
    }
    ;(window as unknown as { __brickwrightGizmo?: () => unknown }).__brickwrightGizmo = probe
    return () => { delete (window as unknown as { __brickwrightGizmo?: () => unknown }).__brickwrightGizmo }
  }, [camera, proxy, size.height, size.width])

  // Follow the document whenever the operator is not actively dragging, so an
  // undo, an agent edit or a numeric entry moves the gizmo with the part.
  useEffect(() => {
    if (!proxy || dragging.current) return
    ROOT_MATRIX.clone().multiply(sceneMatrix(part.transform)).decompose(proxy.position, proxy.quaternion, proxy.scale)
    proxy.updateMatrixWorld(true)
  }, [part.transform, proxy, tool])

  const readPose = useCallback((): Transform => {
    proxy!.updateMatrixWorld(true)
    return documentTransformOf(ROOT_MATRIX_INVERSE.clone().multiply(proxy!.matrixWorld))
  }, [proxy])

  /**
   * Resolves the dragged pose the way a drop would resolve it, so the ghost the
   * operator sees during the drag is the pose they will actually get. The
   * connector solver is only re-run when the quantized position changes, which
   * keeps a dense model's snap query off the per-frame path.
   */
  const resolve = useCallback(
    (raw: Transform): Transform => {
      if (tool === 'rotate') return raw
      const quantized: Transform = { position: snapTransformPosition(raw.position, gridLdu), basis: raw.basis }
      const key = `${quantized.position.join(',')}|${canonicalTransform({ position: [0, 0, 0], basis: quantized.basis })}`
      if (key === lastSnapKey.current && latest.current) return latest.current
      lastSnapKey.current = key
      const snapped = bestSnapTransform(part, model, quantized, { radiusLdu: Math.max(6, gridLdu * 0.8) })
      return snapped ?? quantized
    },
    [gridLdu, model, part, tool],
  )

  if (!proxy) return <object3D ref={setProxy} />

  return (
    <>
      <object3D ref={setProxy} />
      <TransformControls
        ref={controls as never}
        object={proxy}
        mode={tool === 'rotate' ? 'rotate' : 'translate'}
        space={tool === 'rotate' ? 'local' : 'world'}
        rotationSnap={Math.PI / 12}
        size={1.05}
        onMouseDown={() => {
          dragging.current = true
          lastSnapKey.current = ''
        }}
        onObjectChange={() => {
          const resolved = resolve(readPose())
          latest.current = resolved
          onPreview(resolved)
        }}
        onMouseUp={() => {
          dragging.current = false
          const resolved = latest.current ?? resolve(readPose())
          latest.current = null
          onPreview(null)
          onCommit(resolved)
        }}
      />
    </>
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
  onPreview,
  onPlace,
}: {
  request: PlacementRequest
  model: ModelDocument
  gridLdu: number
  root: React.RefObject<THREE.Group | null>
  onPreview: (transform: Transform | null) => void
  onPlace: (transform: Transform) => void
}) {
  const { camera, gl, raycaster, pointer } = useThree()
  const resolved = useRef<Transform | null>(null)
  const pressedAt = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const element = gl.domElement
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const scratch = new THREE.Vector3()

    const sample = () => {
      if (!root.current) return
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObject(root.current, true)
      const surface = hits.find((entry) => entry.object.visible && (entry.object as THREE.Mesh).isMesh)
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
        return
      }
      const placement = resolvePlacement(request, model, { point, partId }, gridLdu)
      resolved.current = placement?.transform ?? null
      onPreview(resolved.current)
    }

    const onMove = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      sample()
    }
    const onDown = (event: PointerEvent) => {
      pressedAt.current = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      const start = pressedAt.current
      pressedAt.current = null
      // An orbit drag is not a placement. Only a click that stayed put commits.
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return
      if (event.button !== 0) return
      if (resolved.current) onPlace(resolved.current)
    }

    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    element.style.cursor = 'crosshair'
    // Resolve once immediately: arming a part from the catalog and clicking
    // straight into the viewport without moving the mouse first is a normal
    // thing to do, and waiting for a move event made that click do nothing.
    sample()
    return () => {
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerup', onUp)
      element.style.cursor = ''
      onPreview(null)
    }
  }, [camera, gl, gridLdu, model, onPlace, onPreview, pointer, raycaster, request, root])

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
  const added = Object.values(proposal.previewDocument.parts).filter((part) => {
    const original = current.parts[part.id]
    return (
      !original ||
      original.color !== part.color ||
      canonicalTransform(original.transform) !== canonicalTransform(part.transform)
    )
  })
  const removed = Object.values(current.parts).filter((part) => !proposal.previewDocument.parts[part.id])

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
      const target = (controls as { target?: THREE.Vector3 } | null)?.target ?? new THREE.Vector3()
      const offset = camera.position.clone().sub(target)
      const radius = Math.hypot(offset.x, offset.z)
      const angle = turntableAngle(elapsed)
      camera.position.set(target.x + Math.cos(angle) * radius, camera.position.y, target.z + Math.sin(angle) * radius)
      camera.lookAt(target)
    }
  })

  return null
}

function CameraRig({
  bounds,
  documentId,
  hasParts,
  exploded,
  view,
  resetKey,
  motion,
}: {
  /** Bounds of what is actually drawn, which in exploded view is not the stored model. */
  bounds: Bounds
  documentId: string
  hasParts: boolean
  /** Exploding the model replaces what is on screen, so it earns a reframe. */
  exploded: boolean
  view: CameraView
  resetKey: number
  motion: MotionController
}) {
  const controls = useRef<OrbitControlsImpl>(null)
  // The camera comes from the R3F store rather than the controls ref: the ref is
  // not attached yet on the first commit, and this effect's dependencies would
  // not change again, so reading it there left the camera at its default
  // position inside the model.
  const { camera, size } = useThree()

  // Framing reads the current bounds but is not *triggered* by them. Reframing
  // on every bounds change meant that placing a brick past the model's edge
  // threw away the viewpoint the operator had just orbited to, which made the
  // viewport feel like it was fighting them.
  const latest = useRef({ bounds, width: size.width, height: size.height })
  latest.current = { bounds, width: size.width, height: size.height }
  const framed = useRef(false)

  /**
   * An in-flight camera flight, or null.
   *
   * A named view or a framing reset eases rather than cutting, because a cut
   * costs the operator the relationship between where they were and where they
   * are — on a large model that is genuinely disorienting. Under reduced motion
   * or during a capture the flight has zero duration, which lands on exactly the
   * same pose without any intermediate frame.
   */
  const flight = useRef<{
    from: THREE.Vector3
    to: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    startedAt: number
    durationMs: number
  } | null>(null)

  useFrame(() => {
    const current = flight.current
    if (!current) return
    const t = current.durationMs > 0 ? Math.min(1, (performance.now() - current.startedAt) / current.durationMs) : 1
    const eased = 1 - (1 - t) ** 3
    camera.position.lerpVectors(current.from, current.to, eased)
    const target = new THREE.Vector3().lerpVectors(current.fromTarget, current.toTarget, eased)
    camera.lookAt(target)
    if (controls.current) {
      controls.current.target.copy(target)
      controls.current.update()
    }
    if (t >= 1) flight.current = null
  })

  useEffect(() => {
    const { bounds: current, width, height } = latest.current
    const center = lduToScene([
      (current.min[0] + current.max[0]) / 2,
      (current.min[1] + current.max[1]) / 2,
      (current.min[2] + current.max[2]) / 2,
    ])
    const extent = Math.max(...current.size.map((amount) => amount * MODEL_ROOT_SCALE), 8)
    const distance = Math.max(24, extent * 2.05)
    const directions: Record<CameraView, THREE.Vector3> = {
      isometric: new THREE.Vector3(0.86, 0.64, 1),
      front: new THREE.Vector3(0, 0.25, 1),
      rear: new THREE.Vector3(0, 0.25, -1),
      left: new THREE.Vector3(-1, 0.25, 0),
      right: new THREE.Vector3(1, 0.25, 0),
      top: new THREE.Vector3(0, 1, 0.001),
    }
    const destination = center.clone().add(directions[view].normalize().multiplyScalar(distance))
    const duration = framed.current ? motion.duration('camera') : 0
    if (duration > 0) {
      flight.current = {
        from: camera.position.clone(),
        to: destination,
        fromTarget: controls.current?.target.clone() ?? center.clone(),
        toTarget: center.clone(),
        startedAt: performance.now(),
        durationMs: duration,
      }
    } else {
      flight.current = null
      camera.position.copy(destination)
      camera.lookAt(center)
      if (controls.current) {
        controls.current.target.copy(center)
        controls.current.update()
      }
    }
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      ;(camera as THREE.OrthographicCamera).zoom = Math.max(8, Math.min(width, height) / (extent * 1.9))
    }
    camera.updateProjectionMatrix()
    // An empty document has nothing to frame yet, so the opening frame is still
    // owed once its parts arrive.
    framed.current = hasParts
    // Opening a different document, or exploding the one that is open, both
    // replace what is on screen, so both are legitimate reasons to reframe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, documentId, exploded, resetKey, view])

  // A document that arrives empty and is then filled — a fresh project, an
  // import, a restored session — still needs its one opening frame.
  useEffect(() => {
    if (framed.current || !hasParts) return
    const raf = requestAnimationFrame(() => {
      if (!controls.current) return
      const { bounds: current } = latest.current
      const center = lduToScene([
        (current.min[0] + current.max[0]) / 2,
        (current.min[1] + current.max[1]) / 2,
        (current.min[2] + current.max[2]) / 2,
      ])
      const extent = Math.max(...current.size.map((amount) => amount * MODEL_ROOT_SCALE), 8)
      camera.position.copy(center.clone().add(new THREE.Vector3(0.86, 0.64, 1).normalize().multiplyScalar(Math.max(24, extent * 2.05))))
      camera.lookAt(center)
      camera.updateProjectionMatrix()
      controls.current.target.copy(center)
      controls.current.update()
      framed.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [camera, hasParts])

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={3} maxDistance={400} />
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
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onSelectMany?: (partIds: string[], additive: boolean) => void
  onClearSelection: () => void
  onTransform: (partId: string, transform: Transform) => void
  onPlace?: (transform: Transform) => void
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

export function CadViewport({
  document,
  selection,
  proposals,
  tool,
  gridLdu,
  cameraView,
  cameraResetKey,
  renderMode,
  placement,
  onSelect,
  onSelectMany,
  onClearSelection,
  onTransform,
  onPlace,
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
  const validation = useMemo(() => validateDocument(document), [document])
  const invalidIds = useMemo(
    () => new Set(validation.collisions.flatMap((issue) => [issue.partA, issue.partB])),
    [validation.collisions],
  )
  const subassemblyOrder = useMemo(() => Object.keys(document.subassemblies), [document.subassemblies])
  const selected = useMemo(() => new Set(selection), [selection])
  const root = useRef<THREE.Group>(null)

  /** Pose being dragged right now, shown live instead of waiting for the commit. */
  const [dragPreview, setDragPreview] = useState<Transform | null>(null)
  const [placementPreview, setPlacementPreview] = useState<Transform | null>(null)
  const [overlay, setOverlay] = useState<OverlayState>({ marquee: null, lasso: null, sweep: null })
  const [jointPreview, setJointPreview] = useState<Map<string, Transform> | null>(null)
  const [activeJointEdge, setActiveJointEdge] = useState<string | null>(null)
  const [joints, setJoints] = useState<readonly ArticulatedJoint[]>([])
  const [sweep, setSweep] = useState<SweepResult | null>(null)
  const [revealed, setRevealed] = useState(0)
  const [playbackStep, setPlaybackStep] = useState(0)
  const [tier, setTier] = useState<QualityTier>(QUALITY_TIERS[1])
  const controlsHandle = useRef<ViewportControlsHandle | null>(null)
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

  // Anything highlighted, flagged or under a gizmo leaves the batches so they
  // stay stable while the operator interacts.
  const excluded = useMemo(() => {
    // Only a small selection is worth pulling out of the batches; a large one
    // batches by appearance instead, which is what keeps a stamped city block
    // from costing one draw call per brick the moment it is selected.
    const ids = new Set(selection.length <= INDIVIDUAL_SELECTION_LIMIT ? selection : [])
    if (renderMode === 'violations' && invalidIds.size <= INDIVIDUAL_SELECTION_LIMIT) {
      for (const id of invalidIds) ids.add(id)
    }
    return ids
  }, [selection, renderMode, invalidIds])

  const appearanceFor = useCallback((partId: string): PartAppearance => {
    if (renderMode === 'violations' && invalidIds.has(partId)) return 'invalid'
    if (renderMode === 'silhouette') return 'silhouette'
    return selected.has(partId) ? 'selected' : 'solid'
  }, [invalidIds, renderMode, selected])

  // Framing follows what is drawn, so exploding the model reframes onto the
  // exploded extent rather than onto the assembled one it no longer shows.
  const displayBounds = useMemo<Bounds>(() => {
    const measured = members
      .map((member) => getPartBounds({ ...member.part, transform: member.transform }))
      .filter((item) => item.measured)
    if (!measured.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }
    const min: Vec3 = [
      Math.min(...measured.map((item) => item.min[0])),
      Math.min(...measured.map((item) => item.min[1])),
      Math.min(...measured.map((item) => item.min[2])),
    ]
    const max: Vec3 = [
      Math.max(...measured.map((item) => item.max[0])),
      Math.max(...measured.map((item) => item.max[1])),
      Math.max(...measured.map((item) => item.max[2])),
    ]
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
  }, [members])

  // Shadow frusta and the contact patch follow the model: a fixed 40-unit box
  // clipped a tower's shadow off at the third storey.
  const shadowExtent = useMemo(
    () => Math.min(180, Math.max(14, Math.max(...displayBounds.size.map((amount) => amount * MODEL_ROOT_SCALE)) * 0.85)),
    [displayBounds],
  )

  const plan = useMemo(() => planBatches(solidMembers, excluded, appearanceFor), [solidMembers, excluded, appearanceFor])
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

  const edgesEnabled = tier.edges && members.length <= EDGE_RENDER_BUDGET
  const placing = Boolean(placement)

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

  const manipulated =
    selection.length === 1 && renderMode === 'beauty' && !placing && (tool === 'move' || tool === 'rotate')
      ? document.parts[selection[0]]
      : undefined

  const commitDrag = useCallback(
    (transform: Transform) => {
      if (manipulated) onTransform(manipulated.id, transform)
    },
    [manipulated, onTransform],
  )

  const placementDefinition = placement ? catalog.get(placement.definitionId) : undefined

  const pendingProposal = useMemo(() => proposals.find((proposal) => proposal.status === 'pending'), [proposals])
  const proposalPartCount = useMemo(() => {
    if (!pendingProposal) return 0
    return Object.values(pendingProposal.previewDocument.parts).filter((part) => {
      const original = document.parts[part.id]
      return (
        !original ||
        original.color !== part.color ||
        canonicalTransform(original.transform) !== canonicalTransform(part.transform)
      )
    }).length
  }, [document.parts, pendingProposal])

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
      gl={{ antialias: tier.antialias, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
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
        onCanvasReady?.(gl.domElement)
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
      {renderMode === 'orthographic'
        ? <OrthographicCamera makeDefault near={0.1} far={2000} zoom={28} />
        : <PerspectiveCamera makeDefault fov={34} near={0.1} far={2000} />}

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
            displayTransform={
              dragPreview && manipulated?.id === member.part.id ? dragPreview : member.transform
            }
            interactive={false}
            idBase={idBases.get(`solo:${member.part.id}`)}
            onSelect={onSelect}
          />
        ))}

        {placement && placementDefinition && placementPreview && (
          <group matrixAutoUpdate={false} matrix={sceneMatrix(placementPreview)}>
            <PartVisual definition={placementDefinition} colorCode={placement.color} appearance="ghost" />
          </group>
        )}

        {pendingProposal && (
          <GhostProposal key={pendingProposal.id} proposal={pendingProposal} current={document} revealed={revealCount} />
        )}

        {renderMode === 'connections' &&
          Object.values(document.parts).flatMap((part) =>
            getWorldConnectors(part).map((feature) => (
              <mesh key={`${feature.partId}_${feature.id}`} position={feature.frame.position as unknown as [number, number, number]}>
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
        onQuality={setTier}
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

      {manipulated && !activeJointEdge && (
        <SelectionManipulator
          key={manipulated.id}
          part={manipulated}
          tool={tool === 'rotate' ? 'rotate' : 'move'}
          gridLdu={gridLdu}
          document={document}
          onPreview={setDragPreview}
          onCommit={commitDrag}
        />
      )}

      {placement && onPlace && (
        <PlacementController
          request={placement}
          model={document}
          gridLdu={gridLdu}
          root={root}
          onPreview={setPlacementPreview}
          onPlace={onPlace}
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
          a 70-unit patch that ends halfway across it. */}
      {tier.contactShadowResolution > 0 && (
        <ContactShadows
          position={[0, -0.014, 0]}
          scale={Math.max(24, shadowExtent * 2.4)}
          opacity={0.62}
          blur={1.9}
          far={Math.max(18, shadowExtent)}
          resolution={tier.contactShadowResolution}
          color="#000000"
        />
      )}
      <CameraRig
        bounds={displayBounds}
        documentId={document.id}
        hasParts={members.length > 0}
        exploded={renderMode === 'exploded'}
        view={cameraView}
        resetKey={cameraResetKey}
        motion={motion}
      />
      <CanvasMetadata renderMode={renderMode} cameraView={cameraView} />
      <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
        <GizmoViewport axisColors={['#ff6a55', '#8bcf65', '#6bbbd6']} labelColor="#0c1112" />
      </GizmoHelper>
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
      <div className="sweep-readout" role="status" data-blocked={overlay.sweep.blocked ? 'true' : 'false'} style={SWEEP_STYLE}>
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
    (edgeId: string, handle: Parameters<RendererControlSurface['beginJointDrag']>[1], event: ThreeEvent<PointerEvent>) => {
      const point = canvasPointOf(event, gl.domElement)
      controls.current?.surface.beginJointDrag(edgeId, handle, point.x, point.y)
    },
    [controls, gl],
  )
  if (!joints.length) return null
  return (
    <JointManipulators
      joints={joints}
      activeEdgeId={activeEdgeId}
      blocked={Boolean(sweep?.blocking)}
      onGrab={onGrab}
    />
  )
}

export { MOTION_DURATIONS }
