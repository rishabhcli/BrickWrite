import { TransformControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { findSnapCandidates } from '../../cad/snapping'
import { poseRefusal } from '../../cad/validation'
import type { CadOperation, ModelDocument, PartInstance, Transform } from '../../cad/types'
import {
  gizmoAxisVisible,
  gizmoSpace,
  manipulationPose,
  planGizmoTransforms,
  type ManipulationOptions,
} from '../workbench/transform'
import { documentTransformOf, ROOT_MATRIX, ROOT_MATRIX_INVERSE, sceneMatrix } from './frame'
import { pointerRouterFor } from './pointerRouter'

/** Scene-space proxy outside the 1/20-scale model root keeps handles hittable.
 * Every result is converted back through ROOT_MATRIX_INVERSE. A single part
 * can snap to a mate; a multi-selection remains one rigid group. */
/** Projected extent the handles aim for, in canvas pixels. */
const HANDLE_TARGET_PX = 112

/**
 * Scratch for the per-frame size probe.
 *
 * The probe runs on every rendered frame a gizmo is mounted, and allocating a
 * box, eight vectors and two arrays each time is garbage the drag has to
 * collect while it is trying to be smooth.
 */
const probeBox = new THREE.Box3()
const probeCorner = new THREE.Vector3()
const probeOrigin = new THREE.Vector3()

/**
 * Snap solving is not free at every scale.
 *
 * The same duty cycle the joint sweep uses: when the last resolve cost more
 * than half a 60 Hz frame, wait at least that long again before the next one.
 * A skipped frame reuses the previous pose rather than falling back to an
 * unsnapped one — alternating between two poses is worse jitter than a preview
 * that updates at half rate, and the gizmo handle itself still tracks the
 * pointer at full rate. `onMouseUp` resolves unconditionally, so what commits
 * is always current.
 */
const SNAP_FRAME_BUDGET_MS = 8

export function SelectionManipulator({
  parts,
  tool,
  gridLdu,
  document: model,
  onPreview,
  onCommitPart,
  onCommitGroup,
  preferences,
}: {
  parts: readonly PartInstance[]
  tool: 'move' | 'rotate'
  preferences: ManipulationOptions
  gridLdu: number
  document: ModelDocument
  onPreview: (preview: ReadonlyMap<string, Transform> | null) => void
  onCommitPart: (partId: string, transform: Transform) => void
  onCommitGroup: (operations: CadOperation[]) => void
}) {
  const part = parts[0]
  const startPose = useMemo(() => manipulationPose(parts, preferences), [parts, preferences])
  const [proxy, setProxy] = useState<THREE.Object3D | null>(null)
  const controls = useRef<
    | ({
        getHelper?: () => THREE.Object3D
        reset?: () => void
        dragging: boolean
        axis: string | null
        size: number
        pointerHover: (pointer: { x: number; y: number; button: number }) => void
      } & THREE.Object3D)
    | null
  >(null)
  const dragging = useRef(false)
  const latest = useRef<CadOperation[]>([])
  const { camera, size, gl } = useThree()
  const router = pointerRouterFor(gl.domElement)
  const pending = useRef(false)
  const probeRef = useRef<(() => { screenPixels: number }) | null>(null)

  useEffect(() => {
    const probe = () => {
      const helper = controls.current?.getHelper?.() ?? controls.current
      if (!helper || !proxy) return { attached: false, screenPixels: 0 }
      const box = probeBox.makeEmpty()
      helper.traverseVisible((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        const material = mesh.material as THREE.Material | THREE.Material[]
        let opacity = 0
        if (Array.isArray(material)) for (const entry of material) opacity = Math.max(opacity, entry.opacity)
        else opacity = material.opacity
        if (opacity < 0.2) return
        box.expandByObject(mesh)
      })
      if (box.isEmpty()) return { attached: true, screenPixels: 0 }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const corner = probeCorner.set(x, y, z).project(camera)
            const px = ((corner.x + 1) / 2) * size.width
            const py = ((1 - corner.y) / 2) * size.height
            if (px < minX) minX = px
            if (px > maxX) maxX = px
            if (py < minY) minY = py
            if (py > maxY) maxY = py
          }
      const origin = proxy.getWorldPosition(probeOrigin).project(camera)
      return {
        attached: true,
        screenPixels: Math.max(maxX - minX, maxY - minY),
        centre: [((origin.x + 1) / 2) * size.width, ((1 - origin.y) / 2) * size.height],
      }
    }
    probeRef.current = probe
    ;(window as unknown as { __brickwrightGizmo?: () => unknown }).__brickwrightGizmo = probe
    return () => {
      probeRef.current = null
      delete (window as unknown as { __brickwrightGizmo?: () => unknown }).__brickwrightGizmo
    }
  }, [camera, proxy, size.height, size.width])

  useEffect(
    () =>
      router.hitTest((event) => {
        const control = controls.current
        if (!control || !proxy) return {}
        const rect = gl.domElement.getBoundingClientRect()
        // Native TransformControls exposes its hover classifier at runtime. Calling
        // it with coordinates avoids any synthetic DOM event and stale hover axis.
        control.pointerHover({
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          button: -1,
        })
        return { gizmo: Boolean(control.axis) }
      }),
    [router, gl, proxy],
  )

  const resetProxy = useCallback(() => {
    if (!proxy) return
    ROOT_MATRIX.clone().multiply(sceneMatrix(startPose)).decompose(proxy.position, proxy.quaternion, proxy.scale)
    proxy.updateMatrixWorld(true)
  }, [proxy, startPose])

  useEffect(() => {
    if (!dragging.current) resetProxy()
  }, [resetProxy, tool])

  useEffect(() => {
    const cancel = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (!dragging.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dragging.current = false
      pending.current = false
      try {
        controls.current?.reset?.()
        if (controls.current) {
          controls.current.dragging = false
          controls.current.axis = null
        }
      } finally {
        router.release('gizmo')
      }
      latest.current = []
      onPreview(null)
      resetProxy()
    }
    window.addEventListener('keydown', cancel, true)
    gl.domElement.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', cancel, true)
      gl.domElement.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      router.release('gizmo')
    }
  }, [gl, router, onPreview, resetProxy])

  const resolve = useCallback((): CadOperation[] => {
    if (!proxy) return []
    proxy.updateMatrixWorld(true)
    const raw = documentTransformOf(ROOT_MATRIX_INVERSE.clone().multiply(proxy.matrixWorld))
    const operations = planGizmoTransforms(parts, startPose, raw, {
      rotating: tool === 'rotate',
      gridLdu,
      locks: preferences.locks,
    })
    const operation = operations[0]
    // A disabled snap must stay disabled. Axis locks cannot be defeated by a mate.
    if (
      parts.length === 1 &&
      operation?.type === 'part.transform' &&
      tool === 'move' &&
      preferences.connectorSnap &&
      !Object.values(preferences.locks).some(Boolean)
    ) {
      const candidates = findSnapCandidates(part, model, operation.transform, { radiusLdu: Math.max(6, gridLdu * 0.8) })
      const candidate = candidates.find((entry) => !poseRefusal(model, part.id, entry.transform))
      if (candidate) return [{ ...operation, transform: candidate.transform }]
    }
    return operations
  }, [gridLdu, model, part, parts, preferences, proxy, startPose, tool])

  const resolveCostMs = useRef(0)
  const resolvedAt = useRef(0)

  useFrame(() => {
    const control = controls.current
    // Only worth measuring when the answer can be applied. During a drag the
    // handle keeps the size it started with, which is also what stops it
    // resizing under the pointer that is holding it.
    if (control && !dragging.current) {
      const pixels = probeRef.current?.().screenPixels ?? 0
      if (pixels > 0) control.size = adaptiveGizmoSize(control.size, pixels)
    }
    if (!pending.current || !dragging.current) return
    const now = performance.now()
    if (resolveCostMs.current > SNAP_FRAME_BUDGET_MS && now - resolvedAt.current < resolveCostMs.current) return
    pending.current = false
    const started = performance.now()
    const next = resolve()
    resolvedAt.current = performance.now()
    resolveCostMs.current = resolvedAt.current - started
    latest.current = next
    onPreview(new Map(next.flatMap((op) => (op.type === 'part.transform' ? [[op.partId, op.transform] as const] : []))))
  })

  if (!proxy || !part) return <object3D ref={setProxy} />

  return (
    <>
      <object3D ref={setProxy} />
      <TransformControls
        ref={controls as never}
        object={proxy}
        mode={tool === 'rotate' ? 'rotate' : 'translate'}
        space={gizmoSpace(preferences.frame)}
        showX={gizmoAxisVisible(preferences.locks).showX}
        showY={gizmoAxisVisible(preferences.locks).showY}
        showZ={gizmoAxisVisible(preferences.locks).showZ}
        rotationSnap={(preferences.rotationStep * Math.PI) / 180}
        size={1.05}
        onMouseDown={() => {
          router.claim('gizmo')
          dragging.current = true
          latest.current = []
        }}
        onObjectChange={() => {
          // Pointer moves only change the proxy; connector solving runs at most once per frame.
          if (dragging.current) pending.current = true
        }}
        onMouseUp={() => {
          if (!dragging.current) return
          dragging.current = false
          const next = pending.current ? resolve() : latest.current
          pending.current = false
          router.release('gizmo')
          latest.current = []
          onPreview(null)
          // Also restores the handle after a refused or zero-length drag.
          resetProxy()
          if (!next.length) return
          if (parts.length === 1 && next[0]?.type === 'part.transform') onCommitPart(next[0].partId, next[0].transform)
          else onCommitGroup(next)
        }}
      />
    </>
  )
}

/** Screen-sized handles with bounded growth even in very small viewports. */
export const HANDLE_DEAD_BAND = 0.08

export function adaptiveGizmoSize(size: number, projectedPixels: number): number {
  if (projectedPixels <= 0 || !Number.isFinite(projectedPixels)) return size
  // Correcting a measurement that is already within a few percent of the target
  // changes the size, which changes the measurement, which asks for another
  // correction: the handle hunts instead of settling. The band is wide enough to
  // absorb that loop and narrow enough to stay above the 96 px the acceptance
  // run requires.
  if (Math.abs(projectedPixels - HANDLE_TARGET_PX) <= HANDLE_TARGET_PX * HANDLE_DEAD_BAND) return size
  return THREE.MathUtils.clamp((size * HANDLE_TARGET_PX) / projectedPixels, 0.6, 2.4)
}
