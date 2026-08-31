import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect } from 'react'
import * as THREE from 'three'
import { findArticulatedJoints } from '../../cad/articulation'
import type { ModelDocument, Transform } from '../../cad/types'
import type { ResolvedPlacement } from '../../cad/placement'
import type { EditorTool } from '../CadViewport'
import { cameraControlsOf } from './cameraControl'
import { resolveVisibility, type VisibilityState } from './visibility'
import { createSectionPlane, offsetPlaneAlongNormal, type SectionPlane } from './sectionPlanes'
import {
  commandFromViewportKey,
  describeViewportCommand,
  nextInOrder,
  VIEWPORT_PITCH_LIMIT_DEG,
  viewportMode,
  walkPartOrder,
} from './viewportKeys'

interface ViewportKeyboardProps {
  document: ModelDocument
  selection: string[]
  tool: EditorTool
  gridLdu: number
  visibility: VisibilityState
  sectionPlanes: readonly SectionPlane[]
  placementPreview: ResolvedPlacement | null
  placing: boolean
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onTransform: (partId: string, transform: Transform) => void
  onNudgeSelection?: (dx: number, dz: number, dy?: number) => void
  onPlace?: (transform: Transform, legal?: boolean, reason?: string) => void
  onJointNudge?: (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => void
  onSectionPlanesChange: (next: readonly SectionPlane[]) => void
}

function announce(command: ReturnType<typeof commandFromViewportKey>, mode: ReturnType<typeof viewportMode>) {
  if (!command) return
  const live = document.getElementById('viewport-live')
  if (live) live.textContent = describeViewportCommand(command, mode)
}

/**
 * Focusable-canvas keyboard: orbit, dolly, frame, selection walking, nudge,
 * joints, section offset, occlusion cycling and keyboard placement.
 *
 * Lives inside the R3F tree so it can reach the live camera and CameraControls
 * without a third window-level listener.
 */
export function ViewportKeyboard({
  document: model,
  selection,
  tool,
  gridLdu,
  visibility,
  sectionPlanes,
  placementPreview,
  placing,
  onSelect,
  onTransform,
  onNudgeSelection,
  onPlace,
  onJointNudge,
  onSectionPlanesChange,
}: ViewportKeyboardProps) {
  const { camera, gl, controls, size } = useThree()

  useLayoutEffect(() => {
    const canvas = gl.domElement
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', 'CAD viewport')
    canvas.setAttribute('aria-describedby', 'viewport-keys')
    canvas.setAttribute(
      'aria-keyshortcuts',
      'ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home Equal Minus Digit0',
    )
  }, [gl])

  useEffect(() => {
    const canvas = gl.domElement
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return
      const mode = viewportMode(tool, selection.length)
      const command = commandFromViewportKey(event.key, {
        shift: event.shiftKey,
        mode,
        gridLdu,
        placing,
      })
      if (!command) return
      event.preventDefault()
      event.stopPropagation()
      const control = cameraControlsOf(controls)
      const animated = window.__brickwrightRenderer?.motionPolicy().animated ?? true

      /**
       * Applies a camera command's result now, when motion is off.
       *
       * `camera-controls` records a target and lets the next frame interpolate
       * towards it. With animation enabled that is the whole point. With it
       * disabled there is nothing to interpolate, yet `camera.zoom` still does
       * not move until something renders — so a keyboard zoom was a no-op for
       * one frame, and anything reading the camera in between saw the old pose.
       * `ViewportControls` already forces the update on the named-view path for
       * exactly this reason; the keyboard path is the same promise.
       */
      const settle = (control: ReturnType<typeof cameraControlsOf>) => {
        if (!control || animated) return
        control.update(0)
        control.camera.updateMatrixWorld(true)
      }

      if (command.kind === 'orbit') {
        if (control) {
          const limit = THREE.MathUtils.degToRad(VIEWPORT_PITCH_LIMIT_DEG)
          void control.rotateTo(control.azimuthAngle + THREE.MathUtils.degToRad(command.yawDeg),
            THREE.MathUtils.clamp(control.polarAngle - THREE.MathUtils.degToRad(command.pitchDeg), Math.PI / 2 - limit, Math.PI / 2 + limit), animated)
          settle(control)
        }
      } else if (command.kind === 'dolly') {
        if (control) {
          if (camera instanceof THREE.OrthographicCamera) void control.zoomTo(THREE.MathUtils.clamp(camera.zoom / command.factor, 0.1, 1000), animated)
          else void control.dollyTo(THREE.MathUtils.clamp(control.distance * command.factor, 1, 100000), animated)
          settle(control)
        }
      } else if (command.kind === 'frame') {
        const ids = Object.keys(model.parts)
        window.__brickwrightRenderer?.frameParts(ids.length ? ids : [])
      } else if (command.kind === 'walk') {
        const resolved = resolveVisibility(model, visibility)
        const order = walkPartOrder(
          model.steps.map((step) => step.partIds),
          Object.keys(model.parts),
          resolved.solid,
        )
        const next = nextInOrder(order, selection[selection.length - 1], command.direction)
        if (next) onSelect(next, command.extend, false)
      } else if (command.kind === 'nudge') {
        if (onNudgeSelection) {
          onNudgeSelection(command.dx, command.dz, command.dy)
        } else {
          for (const partId of selection) {
            const part = model.parts[partId]
            if (!part) continue
            const [x, y, z] = part.transform.position
            onTransform(partId, {
              ...part.transform,
              position: [x + command.dx, y + (command.dy ?? 0), z + command.dz],
            })
          }
        }
      } else if (command.kind === 'joint') {
        const joint = findArticulatedJoints(model, selection)[0]
        if (joint) {
          onJointNudge?.(joint.edgeId, {
            rotateDegrees: command.rotateDegrees || undefined,
            slideLdu: command.slideLdu || undefined,
          })
        }
      } else if (command.kind === 'section') {
        const existing = sectionPlanes[0]
        const plane = existing ?? createSectionPlane('y', [0, 0, 0])
        const next = offsetPlaneAlongNormal(plane, command.offsetLdu)
        onSectionPlanesChange(
          existing ? sectionPlanes.map((candidate) => (candidate.id === plane.id ? next : candidate)) : [next],
        )
      } else if (command.kind === 'occlude') {
        const surface = window.__brickwrightRenderer
        if (surface) {
          const report = surface.pick(size.width / 2, size.height / 2, { cycle: true })
          if (report.partId) onSelect(report.partId, false, false)
        }
      } else if (command.kind === 'place') {
        if (placementPreview && onPlace)
          onPlace(placementPreview.transform, placementPreview.legal, placementPreview.reason)
      } else if (command.kind === 'act') {
        const focused = selection[selection.length - 1]
        if (focused) onSelect(focused, false, false)
      }
      announce(command, mode)
    }
    canvas.addEventListener('keydown', onKeyDown)
    return () => canvas.removeEventListener('keydown', onKeyDown)
  }, [
    camera,
    controls,
    model,
    gl,
    gridLdu,
    onJointNudge,
    onPlace,
    onSectionPlanesChange,
    onSelect,
    onTransform,
    onNudgeSelection,
    placementPreview,
    placing,
    sectionPlanes,
    selection,
    size.height,
    size.width,
    tool,
    visibility,
  ])

  return null
}
