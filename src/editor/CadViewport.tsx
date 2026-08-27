import { ContactShadows, GizmoHelper, GizmoViewport, Grid, OrbitControls, OrthographicCamera, PerspectiveCamera, TransformControls } from '@react-three/drei'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { catalog, STUD_LDU } from '../cad/catalog'
import { getPartBounds, snapTransformPosition } from '../cad/geometry'
import { canonicalTransform, orthonormalize } from '../cad/math'
import { resolvePlacement, type PlacementRequest } from '../cad/placement'
import { bestSnapTransform, getWorldConnectors } from '../cad/snapping'
import type { Bounds, ModelDocument, PartInstance, Proposal, Transform, Vec3 } from '../cad/types'
import { validateDocument } from '../cad/validation'
import { EDGE_RENDER_BUDGET, INDIVIDUAL_SELECTION_LIMIT, PartBatch, planBatches, type BatchMember } from './PartBatch'
import { createStudioEnvironment } from './environment'
import { PartVisual, type PartAppearance } from './PartVisual'

export type EditorTool = 'select' | 'move' | 'rotate' | 'connect'
export type CameraView = 'isometric' | 'front' | 'rear' | 'left' | 'right' | 'top'
export type RenderMode = 'beauty' | 'orthographic' | 'silhouette' | 'connections' | 'violations' | 'exploded'
export type { PlacementRequest }

/**
 * The CAD document is stored in LDraw's own frame: LDU units, Y increasing
 * downward. Rather than converting every value, the whole model hangs off one
 * root node that rotates 180° about X and scales LDU into scene units. Children
 * therefore use raw document coordinates.
 */
const MODEL_ROOT_ROTATION: [number, number, number] = [Math.PI, 0, 0]
const MODEL_ROOT_SCALE = 1 / STUD_LDU

/**
 * The model root's own matrix, and its inverse.
 *
 * Anything that has to live *outside* the root — the transform gizmo, most
 * importantly — needs both: the forward matrix to follow a document pose in
 * scene space, and the inverse to read a scene pose back as document truth.
 */
const ROOT_MATRIX = new THREE.Matrix4()
  .makeRotationX(MODEL_ROOT_ROTATION[0])
  .multiply(new THREE.Matrix4().makeScale(MODEL_ROOT_SCALE, MODEL_ROOT_SCALE, MODEL_ROOT_SCALE))
const ROOT_MATRIX_INVERSE = ROOT_MATRIX.clone().invert()

/** Maps a document-space point into scene space for cameras and overlays. */
const lduToScene = (point: Vec3): THREE.Vector3 =>
  new THREE.Vector3(point[0] * MODEL_ROOT_SCALE, -point[1] * MODEL_ROOT_SCALE, -point[2] * MODEL_ROOT_SCALE)

/** Maps a scene-space point back into document coordinates. */
const sceneToLdu = (point: THREE.Vector3): Vec3 => {
  const local = point.clone().applyMatrix4(ROOT_MATRIX_INVERSE)
  return [local.x, local.y, local.z]
}

/**
 * Builds the scene matrix for a document transform.
 *
 * The document holds a row-major LDraw basis; three.js wants column-major, and
 * `Matrix4.set` takes row-major arguments, so the basis columns are passed as
 * the matrix's rows' first three entries in the order three.js expects.
 */
function sceneMatrix(transform: Transform): THREE.Matrix4 {
  const b = transform.basis
  const [x, y, z] = transform.position
  return new THREE.Matrix4().set(
    b[0], b[1], b[2], x,
    b[3], b[4], b[5], y,
    b[6], b[7], b[8], z,
    0, 0, 0, 1,
  )
}

/** Reads a document transform out of a matrix already expressed in document space. */
function documentTransformOf(matrix: THREE.Matrix4): Transform {
  const m = matrix.elements
  // three.js stores column-major, so element (row, col) is elements[col * 4 + row].
  return {
    position: [m[12], m[13], m[14]],
    basis: orthonormalize([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]),
  }
}

interface PartObjectProps {
  part: PartInstance
  appearance: PartAppearance
  displayTransform?: Transform
  interactive: boolean
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
}

function PartObject({ part, appearance, displayTransform, interactive, onSelect }: PartObjectProps) {
  const definition = catalog.get(part.definitionId)
  if (!definition) return null

  const rendered = displayTransform ?? part.transform
  return (
    <group
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
      <PartVisual definition={definition} colorCode={part.color} appearance={appearance} />
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
 * Shift-drag box selection.
 *
 * Clicking one brick at a time is the only selection a large model does not
 * support, so the editor needed a region select. Shift is the modifier because
 * shift-click already means "add to the selection", and a shift-drag reads as
 * the same instruction over an area. `OrbitControls` claims shift-drag for
 * panning, so it is disabled for exactly the duration of the drag and restored
 * afterwards, including when the pointer is released outside the canvas.
 */
function MarqueeController({
  model,
  onRect,
  onSelect,
}: {
  model: ModelDocument
  onRect: (rect: MarqueeRect | null) => void
  onSelect: (partIds: string[], additive: boolean) => void
}) {
  const { camera, gl, size, controls } = useThree()

  useEffect(() => {
    const element = gl.domElement
    let start: { x: number; y: number } | null = null
    let restore: boolean | null = null

    const rectOf = (x: number, y: number): MarqueeRect => ({
      left: Math.min(start!.x, x),
      top: Math.min(start!.y, y),
      width: Math.abs(x - start!.x),
      height: Math.abs(y - start!.y),
    })

    const local = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect()
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    }

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.shiftKey) return
      start = local(event)
      const orbit = controls as { enabled?: boolean } | null
      if (orbit && typeof orbit.enabled === 'boolean') {
        restore = orbit.enabled
        orbit.enabled = false
      }
      onRect({ left: start.x, top: start.y, width: 0, height: 0 })
    }

    const onMove = (event: PointerEvent) => {
      if (!start) return
      const point = local(event)
      onRect(rectOf(point.x, point.y))
    }

    const finish = (event: PointerEvent) => {
      if (!start) return
      const point = local(event)
      const rect = rectOf(point.x, point.y)
      start = null
      onRect(null)
      const orbit = controls as { enabled?: boolean } | null
      if (orbit && restore !== null) orbit.enabled = restore
      restore = null

      // A shift-click that never became a drag is a click, and the part under
      // the cursor already handled it.
      if (rect.width < 4 && rect.height < 4) return

      const inside: string[] = []
      const centre = new THREE.Vector3()
      for (const part of Object.values(model.parts)) {
        const bounds = getPartBounds(part)
        centre.copy(
          lduToScene([
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2,
          ]),
        )
        const projected = centre.project(camera)
        // Behind the camera projects to a mirrored point that would otherwise
        // land inside the rectangle.
        if (projected.z > 1) continue
        const x = ((projected.x + 1) / 2) * size.width
        const y = ((1 - projected.y) / 2) * size.height
        if (x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height) {
          inside.push(part.id)
        }
      }
      onSelect(inside, true)
    }

    const onCancel = () => {
      if (!start) return
      start = null
      onRect(null)
      const orbit = controls as { enabled?: boolean } | null
      if (orbit && restore !== null) orbit.enabled = restore
      restore = null
    }

    element.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      element.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', onCancel)
      onCancel()
    }
  }, [camera, controls, gl, model, onRect, onSelect, size.height, size.width])

  return null
}

function GhostProposal({ proposal, current }: { proposal: Proposal; current: ModelDocument }) {
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
      {added.map((part) => {
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

function CameraRig({
  bounds,
  documentId,
  hasParts,
  exploded,
  view,
  resetKey,
}: {
  /** Bounds of what is actually drawn, which in exploded view is not the stored model. */
  bounds: Bounds
  documentId: string
  hasParts: boolean
  /** Exploding the model replaces what is on screen, so it earns a reframe. */
  exploded: boolean
  view: CameraView
  resetKey: number
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
    camera.position.copy(center.clone().add(directions[view].normalize().multiplyScalar(distance)))
    camera.lookAt(center)
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      ;(camera as THREE.OrthographicCamera).zoom = Math.max(8, Math.min(width, height) / (extent * 1.9))
    }
    camera.updateProjectionMatrix()
    if (controls.current) {
      controls.current.target.copy(center)
      controls.current.update()
    }
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
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null)

  const members = useMemo<BatchMember[]>(
    () =>
      Object.values(document.parts).map((part) => {
        if (renderMode !== 'exploded') return { part, transform: part.transform }
        const subassemblyIndex = Math.max(0, subassemblyOrder.indexOf(part.subassemblyId))
        const angle = (subassemblyIndex / Math.max(1, subassemblyOrder.length)) * Math.PI * 2
        return {
          part,
          transform: {
            ...part.transform,
            position: [
              part.transform.position[0] + Math.cos(angle) * 140,
              part.transform.position[1] - (subassemblyIndex % 3) * 40,
              part.transform.position[2] + Math.sin(angle) * 140,
            ] as Vec3,
          },
        }
      }),
    [document.parts, renderMode, subassemblyOrder],
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

  const plan = useMemo(() => planBatches(members, excluded, appearanceFor), [members, excluded, appearanceFor])
  const edgesEnabled = members.length <= EDGE_RENDER_BUDGET
  const placing = Boolean(placement)

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

  return (
    <>
    <Canvas
      shadows="soft"
      dpr={[1, 1.65]}
      gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor('#0b1012')
        gl.outputColorSpace = THREE.SRGBColorSpace
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 0.92
        // Plastic is read from what it reflects, not from what shines on it.
        // The studio is generated rather than fetched, so the viewport stays
        // self-contained; it is disposed with the scene below.
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
        if (!placing) onClearSelection()
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
        castShadow
        shadow-mapSize={[2048, 2048]}
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
            interactive={!placing}
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
            interactive={!placing}
            onSelect={onSelect}
          />
        ))}

        {placement && placementDefinition && placementPreview && (
          <group matrixAutoUpdate={false} matrix={sceneMatrix(placementPreview)}>
            <PartVisual definition={placementDefinition} colorCode={placement.color} appearance="ghost" />
          </group>
        )}

        {proposals
          .filter((proposal) => proposal.status === 'pending')
          .map((proposal) => (
            <GhostProposal key={proposal.id} proposal={proposal} current={document} />
          ))}

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

      {manipulated && (
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

      {onSelectMany && !placing && (
        <MarqueeController model={document} onRect={setMarquee} onSelect={onSelectMany} />
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
      <ContactShadows
        position={[0, -0.014, 0]}
        scale={Math.max(24, shadowExtent * 2.4)}
        opacity={0.62}
        blur={1.9}
        far={Math.max(18, shadowExtent)}
        resolution={1024}
        color="#000000"
      />
      <CameraRig
        bounds={displayBounds}
        documentId={document.id}
        hasParts={members.length > 0}
        exploded={renderMode === 'exploded'}
        view={cameraView}
        resetKey={cameraResetKey}
      />
      <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
        <GizmoViewport axisColors={['#ff6a55', '#8bcf65', '#6bbbd6']} labelColor="#0c1112" />
      </GizmoHelper>
      <fog attach="fog" args={['#0b1012', 90, 220]} />
    </Canvas>
    {marquee && (
      <div
        className="marquee-box"
        aria-hidden="true"
        style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
      />
    )}
    </>
  )
}
