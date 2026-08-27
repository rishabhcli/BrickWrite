import { catalog, PLATE_LDU, STUD_LDU } from './catalog'
import { transformBounds } from './math'
import type { Bounds, ModelDocument, PartInstance, Vec3 } from './types'

export interface PartBounds extends Bounds {
  partId: string
  /** False when the part has no compiled geometry, so its extent is unknown. */
  measured: boolean
}

const EMPTY: Bounds = { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] }

/**
 * World-space bounds of a placed part, derived from its compiled LDraw
 * geometry rather than a nominal stud count. Slopes, wheels, windscreens and
 * Technic parts therefore measure what they actually occupy.
 */
export function getPartBounds(part: PartInstance): PartBounds {
  const local = catalog.get(part.definitionId)?.dimensions?.bounds
  if (!local) {
    const [x, y, z] = part.transform.position
    return { partId: part.id, min: [x, y, z], max: [x, y, z], size: [0, 0, 0], measured: false }
  }
  const { min, max } = transformBounds(local, part.transform)
  return {
    partId: part.id,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    measured: true,
  }
}

export function getDocumentBounds(document: ModelDocument): Bounds {
  const bounds = Object.values(document.parts).map(getPartBounds).filter((item) => item.measured)
  if (!bounds.length) return EMPTY
  const min: Vec3 = [
    Math.min(...bounds.map((item) => item.min[0])),
    Math.min(...bounds.map((item) => item.min[1])),
    Math.min(...bounds.map((item) => item.min[2])),
  ]
  const max: Vec3 = [
    Math.max(...bounds.map((item) => item.max[0])),
    Math.max(...bounds.map((item) => item.max[1])),
    Math.max(...bounds.map((item) => item.max[2])),
  ]
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

export function snapLdu(value: number, increment = STUD_LDU): number {
  return Math.round(value / increment) * increment
}

/**
 * Quantizes a position to the active build grid. Horizontal spacing follows the
 * stud pitch; vertical spacing follows plate height, which is the finest
 * increment ordinary stacking produces.
 */
export function snapTransformPosition(position: Vec3, increment = STUD_LDU): Vec3 {
  return [snapLdu(position[0], increment), snapLdu(position[1], PLATE_LDU), snapLdu(position[2], increment)]
}
