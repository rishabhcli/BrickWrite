import * as THREE from 'three'
import { STUD_LDU } from '../../cad/catalog'
import { orthonormalize } from '../../cad/math'
import type { Transform, Vec3 } from '../../cad/types'
import type { Ray } from './sectionPlanes'

/**
 * The one conversion between the document's frame and the scene's.
 *
 * The CAD document is stored in LDraw's own frame: LDU units, **+Y downward**.
 * Rather than converting every value, the whole model hangs off one root node
 * that rotates 180° about X and scales LDU into scene units, so children use raw
 * document coordinates. Anything that has to live *outside* that root — a gizmo,
 * a section-plane handle, a pointer ray — needs the matrix and its inverse, and
 * they live here so there is exactly one definition of them.
 */

export const MODEL_ROOT_ROTATION: [number, number, number] = [Math.PI, 0, 0]
export const MODEL_ROOT_SCALE = 1 / STUD_LDU

export const ROOT_MATRIX = new THREE.Matrix4()
  .makeRotationX(MODEL_ROOT_ROTATION[0])
  .multiply(new THREE.Matrix4().makeScale(MODEL_ROOT_SCALE, MODEL_ROOT_SCALE, MODEL_ROOT_SCALE))
export const ROOT_MATRIX_INVERSE = ROOT_MATRIX.clone().invert()

/** Maps a document-space point into scene space for cameras and overlays. */
export const lduToScene = (point: Vec3): THREE.Vector3 =>
  new THREE.Vector3(point[0] * MODEL_ROOT_SCALE, -point[1] * MODEL_ROOT_SCALE, -point[2] * MODEL_ROOT_SCALE)

/** Maps a scene-space point back into document coordinates. */
export const sceneToLdu = (point: THREE.Vector3): Vec3 => {
  const local = point.clone().applyMatrix4(ROOT_MATRIX_INVERSE)
  return [local.x, local.y, local.z]
}

/**
 * Maps a scene-space *direction* into document space.
 *
 * A direction is not a point: the root's translation must not apply, and its
 * uniform scale must be divided out rather than carried, or a ray direction
 * would come back twenty times too long and every closest-approach solve that
 * uses it would return a parameter in the wrong units.
 */
export const sceneDirectionToLdu = (direction: THREE.Vector3): Vec3 => {
  const local = direction.clone().transformDirection(ROOT_MATRIX_INVERSE).normalize()
  return [local.x, local.y, local.z]
}

/** Maps a document-space direction into scene space. */
export const lduDirectionToScene = (direction: Vec3): THREE.Vector3 =>
  new THREE.Vector3(direction[0], -direction[1], -direction[2]).normalize()

/**
 * Builds the scene matrix for a document transform.
 *
 * The document holds a row-major LDraw basis; three.js wants column-major, and
 * `Matrix4.set` takes row-major arguments, so the basis columns are passed as
 * the matrix's rows' first three entries in the order three.js expects.
 */
export function sceneMatrix(transform: Transform): THREE.Matrix4 {
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
export function documentTransformOf(matrix: THREE.Matrix4): Transform {
  const m = matrix.elements
  // three.js stores column-major, so element (row, col) is elements[col * 4 + row].
  return {
    position: [m[12], m[13], m[14]],
    basis: orthonormalize([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]),
  }
}

/**
 * A pointer ray in **document space**, from a canvas point.
 *
 * Every manipulator solve — plane offsets, joint bearings, trackballs — is
 * expressed in document units, because that is where the joint axes and pivots
 * the kernel publishes already live. Converting once, here, is what keeps a
 * factor of twenty out of the drag maths.
 */
export function documentRayFromCanvas(
  camera: THREE.Camera,
  canvasX: number,
  canvasY: number,
  width: number,
  height: number,
  raycaster = new THREE.Raycaster(),
): Ray {
  raycaster.setFromCamera(
    new THREE.Vector2((canvasX / width) * 2 - 1, -(canvasY / height) * 2 + 1),
    camera,
  )
  return {
    origin: sceneToLdu(raycaster.ray.origin),
    direction: sceneDirectionToLdu(raycaster.ray.direction),
  }
}

/** Projects a document-space point to canvas pixels. */
export function projectLdu(
  camera: THREE.Camera,
  point: Vec3,
  width: number,
  height: number,
): { x: number; y: number; behindCamera: boolean } {
  const projected = lduToScene(point).project(camera)
  return {
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height,
    behindCamera: projected.z > 1,
  }
}
