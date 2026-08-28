import { catalog } from '../cad/catalog'
import { applyMat3, multiplyMat3, transposeMat3, type Mat3, type RigidTransform, type Vec3 } from '../cad/math'
import type { ModelDocument } from '../cad/types'

/**
 * Reflection, and the question of when it is a lie.
 *
 * Mirroring a *placement* is arithmetic. Mirroring a *part* is not: LDraw does
 * allow a negative-determinant basis, and it does produce the mirrored shape,
 * but only for parts that are actually manufactured in both hands. A slope
 * reflected across its own ramp is not a part anybody can buy.
 *
 * So this module mirrors poses and refuses to mirror a part whose compiled
 * connector layout is not symmetric about the plane the reflection would use.
 * The determinant of every basis it emits stays positive: a refined model must
 * be buildable, and the reflected copy is placed with a real rotation of a real
 * part or it is not placed at all.
 */

export type MirrorAxis = 0 | 2

const MIRROR_BASIS: Record<MirrorAxis, Mat3> = {
  0: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
  2: [1, 0, 0, 0, 1, 0, 0, 0, -1],
}

/**
 * Pose reflected through the plane `axis = planeLdu`.
 *
 * `M · B · M` conjugates the orientation through the same reflection, which
 * keeps the determinant positive — the reflected pose is a rotation of the part,
 * not an inside-out copy of it.
 */
export function mirrorTransform(transform: RigidTransform, axis: MirrorAxis, planeLdu: number): RigidTransform {
  const m = MIRROR_BASIS[axis]
  const position: [number, number, number] = [transform.position[0], transform.position[1], transform.position[2]]
  position[axis] = 2 * planeLdu - position[axis]
  return { position, basis: multiplyMat3(multiplyMat3(m, transform.basis), m) }
}

const safetyCache = new Map<string, [boolean, boolean, boolean]>()

/**
 * Whether a definition's compiled connectors are symmetric about each of its own
 * local mid-planes.
 *
 * Connectors, not geometry: two parts that connect identically are
 * interchangeable to everything downstream of this module, and connectors are
 * the only thing the catalog publishes at a resolution fine enough to answer the
 * question without a mesh.
 */
function localMirrorSafety(definitionId: string): [boolean, boolean, boolean] {
  const cached = safetyCache.get(definitionId)
  if (cached) return cached
  const definition = catalog.get(definitionId)
  const bounds = definition?.dimensions?.bounds
  if (!definition || !bounds) {
    const unknown: [boolean, boolean, boolean] = [false, false, false]
    safetyCache.set(definitionId, unknown)
    return unknown
  }
  const key = (family: string, gender: string, position: readonly number[]) =>
    `${family}:${gender}:${Math.round(position[0] * 4)}:${Math.round(position[1] * 4)}:${Math.round(position[2] * 4)}`
  const present = new Set(definition.connectors.map((feature) => key(feature.family, feature.gender, feature.pos)))

  const safeOn = (axis: 0 | 1 | 2): boolean => {
    const centre = (bounds.min[axis] + bounds.max[axis]) / 2
    for (const feature of definition.connectors) {
      const reflected = [feature.pos[0], feature.pos[1], feature.pos[2]]
      reflected[axis] = 2 * centre - reflected[axis]
      if (!present.has(key(feature.family, feature.gender, reflected))) return false
    }
    return true
  }

  const safety: [boolean, boolean, boolean] = [safeOn(0), safeOn(1), safeOn(2)]
  safetyCache.set(definitionId, safety)
  return safety
}

/**
 * Whether this placed part can be reflected through a world-space plane.
 *
 * The world mirror axis is pulled back into the part's own frame first: a brick
 * turned a quarter turn is asked about its local Z, not its local X, which is
 * what lets a slope be mirrored along the wall it runs down and refused across
 * its own ramp.
 */
export function canMirror(document: ModelDocument, partId: string, axis: MirrorAxis): boolean {
  const part = document.parts[partId]
  if (!part) return false
  const worldAxis: Vec3 = axis === 0 ? [1, 0, 0] : [0, 0, 1]
  const local = applyMat3(transposeMat3(part.transform.basis), worldAxis)
  let dominant = 0
  for (let index = 1; index < 3; index += 1) {
    if (Math.abs(local[index]) > Math.abs(local[dominant])) dominant = index
  }
  // An off-lattice orientation maps the world plane onto no single local plane,
  // so the compiled symmetry test does not apply and the answer is "no".
  if (Math.abs(local[dominant]) < 0.999) return false
  return localMirrorSafety(part.definitionId)[dominant as 0 | 1 | 2]
}

/** Mirror plane of a set of parts: the centre of their combined extent. */
export function mirrorPlaneFor(bounds: { min: Vec3; max: Vec3 }, axis: MirrorAxis): number {
  return (bounds.min[axis] + bounds.max[axis]) / 2
}
