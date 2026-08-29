import { type ThreeEvent, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { ArticulatedJoint } from '../../cad/articulation'
import type { Vec3 } from '../../cad/types'
import { lduDirectionToScene, lduToScene, MODEL_ROOT_SCALE } from './frame'
import { handlesFor, type JointHandle } from './jointDrag'
import type { SectionPlane } from './sectionPlanes'

/**
 * On-canvas manipulators for section planes and joints.
 *
 * A manipulator is not decoration for a numeric field — it *is* the interface.
 * The whole reason a section plane or a hinge is worth having is that the
 * operator can find the right value by moving it and watching, and a control
 * that only accepts typed numbers turns that into a search.
 *
 * These are drawn **outside** the model root, in scene units. Inside a root
 * scaled by 1/20, a handle sized for the screen would be twenty times too small
 * to see or hit — the same defect that once made the transform gizmo look
 * absent — so every handle's pose is converted from document space here and its
 * size is chosen in scene units.
 */

/** Handle sizing, in scene units (one unit is one stud). */
const RING_RADIUS = 2.6
const RING_TUBE = 0.16
const ARROW_LENGTH = 3.4
const ARROW_RADIUS = 0.32
const HIT_SCALE = 2.1

const HANDLE_COLOURS: Record<string, string> = {
  rotate: '#f4aa45',
  slide: '#7cefe7',
  ball: '#c58bf0',
  offset: '#7cefe7',
  plane: '#5ad1c4',
}

/** Orientation that carries local +Y onto a document-space axis, in scene space. */
function orientationFor(axis: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), lduDirectionToScene(axis))
}

export interface SectionManipulatorProps {
  planes: readonly SectionPlane[]
  /** Extent of the drawn cut face, in scene units, so it covers the model. */
  extent: number
  onGrab: (planeId: string, mode: 'offset' | 'rotate', event: ThreeEvent<PointerEvent>) => void
}

/**
 * Draws each section plane with a grab handle for its two freedoms.
 *
 * The cut face is drawn faintly rather than left invisible: a clipping plane the
 * operator cannot see is a clipping plane they will forget is on, and "half my
 * model disappeared" is the support question that follows.
 */
export function SectionManipulators({ planes, extent, onGrab }: SectionManipulatorProps) {
  return (
    <group name="section-manipulators">
      {planes.filter((plane) => plane.enabled).map((plane) => {
        const position = lduToScene(plane.origin)
        const quaternion = orientationFor(plane.normal)
        return (
          <group key={plane.id} position={position} quaternion={quaternion}>
            {/* The cut face. Rotated because a plane geometry faces +Z and the
                handle frame's up is +Y. */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
              <planeGeometry args={[extent * 2, extent * 2]} />
              <meshBasicMaterial
                color={HANDLE_COLOURS.plane}
                transparent
                opacity={0.07}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            <lineSegments renderOrder={3}>
              <edgesGeometry args={[new THREE.PlaneGeometry(extent * 2, extent * 2)]} />
              <lineBasicMaterial color={HANDLE_COLOURS.plane} transparent opacity={0.5} depthTest={false} />
            </lineSegments>

            {/* Offset handle: an arrow along the normal. */}
            <mesh
              position={[0, ARROW_LENGTH / 2, 0]}
              renderOrder={4}
              onPointerDown={(event) => {
                event.stopPropagation()
                onGrab(plane.id, 'offset', event)
              }}
            >
              <cylinderGeometry args={[ARROW_RADIUS * 0.35, ARROW_RADIUS * 0.35, ARROW_LENGTH, 12]} />
              <meshBasicMaterial color={HANDLE_COLOURS.offset} depthTest={false} transparent opacity={0.95} />
            </mesh>
            <mesh position={[0, ARROW_LENGTH, 0]} renderOrder={4}>
              <coneGeometry args={[ARROW_RADIUS, ARROW_RADIUS * 2.2, 14]} />
              <meshBasicMaterial color={HANDLE_COLOURS.offset} depthTest={false} transparent opacity={0.95} />
            </mesh>
            {/* An invisible, larger collider, because a 0.3-unit arrow is a
                three-pixel target at a normal working distance. */}
            <mesh
              position={[0, ARROW_LENGTH / 2, 0]}
              visible={false}
              onPointerDown={(event) => {
                event.stopPropagation()
                onGrab(plane.id, 'offset', event)
              }}
            >
              <cylinderGeometry args={[ARROW_RADIUS * HIT_SCALE, ARROW_RADIUS * HIT_SCALE, ARROW_LENGTH * 1.2, 8]} />
              <meshBasicMaterial />
            </mesh>

            {/* Rotation ring, lying in the plane. */}
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              renderOrder={4}
              onPointerDown={(event) => {
                event.stopPropagation()
                onGrab(plane.id, 'rotate', event)
              }}
            >
              <torusGeometry args={[RING_RADIUS, RING_TUBE, 8, 48]} />
              <meshBasicMaterial color={HANDLE_COLOURS.rotate} depthTest={false} transparent opacity={0.9} />
            </mesh>
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              visible={false}
              onPointerDown={(event) => {
                event.stopPropagation()
                onGrab(plane.id, 'rotate', event)
              }}
            >
              <torusGeometry args={[RING_RADIUS, RING_TUBE * HIT_SCALE * 1.6, 6, 24]} />
              <meshBasicMaterial />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

export interface JointManipulatorProps {
  joints: readonly ArticulatedJoint[]
  activeEdgeId: string | null
  /** Non-null while a sweep says the motion is blocked, which recolours the ring. */
  blocked: boolean
  onGrab: (edgeId: string, handle: JointHandle, event: ThreeEvent<PointerEvent>) => void
}

/**
 * Draws a handle per freedom the joint actually has.
 *
 * `handlesFor` refuses to draw anything for a `fixed` or `unknown` freedom. That
 * is the important case: a handle that appears and then will not move is a
 * promise the model cannot keep, and an operator who drags it concludes the tool
 * is broken rather than that the joint is rigid.
 */
export function JointManipulators({ joints, activeEdgeId, blocked, onGrab }: JointManipulatorProps) {
  const { camera } = useThree()
  // Handles are sized against camera distance so they stay usable whether the
  // operator is inspecting one hinge or looking at the whole model.
  const scaleFor = useMemo(() => {
    const eye = camera.position.clone()
    return (position: THREE.Vector3) => Math.max(0.45, Math.min(4, eye.distanceTo(position) * 0.045))
  }, [camera.position.x, camera.position.y, camera.position.z])  

  return (
    <group name="joint-manipulators">
      {joints.map((joint) => {
        const handles = handlesFor(joint)
        if (!handles.length) return null
        const position = lduToScene(joint.pivotLdu)
        const quaternion = orientationFor(joint.axis)
        const active = joint.edgeId === activeEdgeId
        const scale = scaleFor(position)
        const tint = blocked && active ? '#ff5c48' : active ? '#ffd27a' : HANDLE_COLOURS.rotate
        return (
          <group key={joint.edgeId} position={position} quaternion={quaternion} scale={scale}>
            {handles.includes('rotate') && (
              <>
                <mesh
                  rotation={[-Math.PI / 2, 0, 0]}
                  renderOrder={5}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onGrab(joint.edgeId, 'rotate', event)
                  }}
                >
                  <torusGeometry args={[RING_RADIUS, RING_TUBE, 8, 40]} />
                  <meshBasicMaterial color={tint} depthTest={false} transparent opacity={active ? 1 : 0.8} />
                </mesh>
                <mesh
                  rotation={[-Math.PI / 2, 0, 0]}
                  visible={false}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onGrab(joint.edgeId, 'rotate', event)
                  }}
                >
                  <torusGeometry args={[RING_RADIUS, RING_TUBE * HIT_SCALE * 1.6, 6, 20]} />
                  <meshBasicMaterial />
                </mesh>
              </>
            )}
            {handles.includes('slide') && (
              <>
                <mesh
                  position={[0, ARROW_LENGTH / 2, 0]}
                  renderOrder={5}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onGrab(joint.edgeId, 'slide', event)
                  }}
                >
                  <cylinderGeometry args={[ARROW_RADIUS * 0.3, ARROW_RADIUS * 0.3, ARROW_LENGTH, 10]} />
                  <meshBasicMaterial
                    color={blocked && active ? '#ff5c48' : HANDLE_COLOURS.slide}
                    depthTest={false}
                    transparent
                    opacity={0.95}
                  />
                </mesh>
                <mesh
                  position={[0, ARROW_LENGTH / 2, 0]}
                  visible={false}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onGrab(joint.edgeId, 'slide', event)
                  }}
                >
                  <cylinderGeometry args={[ARROW_RADIUS * HIT_SCALE, ARROW_RADIUS * HIT_SCALE, ARROW_LENGTH * 1.2, 8]} />
                  <meshBasicMaterial />
                </mesh>
              </>
            )}
            {handles.includes('ball') && (
              <mesh
                renderOrder={5}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  onGrab(joint.edgeId, 'ball', event)
                }}
              >
                <sphereGeometry args={[RING_RADIUS * 0.55, 20, 14]} />
                <meshBasicMaterial
                  color={blocked && active ? '#ff5c48' : HANDLE_COLOURS.ball}
                  depthTest={false}
                  transparent
                  opacity={0.6}
                  wireframe
                />
              </mesh>
            )}
          </group>
        )
      })}
    </group>
  )
}

/**
 * A marker at the point where a sweep says the motion is stopped.
 *
 * Drawn at the reported contact point in document space, so "blocked" is a
 * *place* on the model rather than a sentence in a panel. LDraw's +Y is down, so
 * the conversion goes through `lduToScene` like every other document point.
 */
export function BlockingMarker({ pointLdu }: { pointLdu: Vec3 | null }) {
  if (!pointLdu) return null
  const position = lduToScene(pointLdu)
  return (
    <group position={position} name="sweep-blocking-marker">
      <mesh renderOrder={6}>
        <sphereGeometry args={[Math.max(0.35, 6 * MODEL_ROOT_SCALE), 16, 12]} />
        <meshBasicMaterial color="#ff5c48" depthTest={false} transparent opacity={0.85} />
      </mesh>
      <mesh renderOrder={6}>
        <sphereGeometry args={[Math.max(0.7, 14 * MODEL_ROOT_SCALE), 16, 12]} />
        <meshBasicMaterial color="#ff5c48" depthTest={false} transparent opacity={0.18} />
      </mesh>
    </group>
  )
}
