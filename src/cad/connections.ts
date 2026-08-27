import {
  basisFromAxisAngle,
  degreesToRadians,
  dotVec,
  IDENTITY_BASIS,
  IDENTITY_TRANSFORM,
  multiplyMat3,
  orthonormalize,
  radiansToDegrees,
  subVec,
  transposeMat3,
  type Mat3,
  type RigidTransform,
  type Vec3,
} from './math'
import type { ConnectionFamily, ConnectionFeature, JointFreedom } from './types'

/**
 * Connection semantics: which connectors can mate, how their frames align, and
 * what relative motion the joint still permits.
 *
 * The central convention, verified against the LDCad Shadow Library, is that a
 * connector's axis is its frame's local **+Y**, and that a mated pair brings the
 * two frames into coincidence. `p/stud.dat` declares a male Y-axis cylinder at
 * the stud primitive's origin; `parts/s/3001s01.dat` declares the matching
 * female tubes at `pos=0 24 0` with the same orientation. A brick stacked on
 * another therefore has its anti-stud frame exactly on the lower brick's stud
 * frame — which is why the mating transform is the identity plus whatever
 * freedom the joint retains.
 *
 * Because the frames carry orientation, solving a pair yields the moving part's
 * full pose, including rotation. That is what makes studs-not-on-top placement
 * fall out of the same solver as ordinary stacking rather than needing a
 * special case.
 */

/** Local axis of every connector frame, by LDCad convention. */
export const CONNECTOR_AXIS: Vec3 = [0, 1, 0]

const COMPATIBLE_PAIRS = new Set([
  'anti-stud:stud',
  'axle:axle-hole',
  'ball:socket',
  'bar:clip',
  'hinge:hinge',
  'pin:pin-hole',
  'generic:generic',
])

/** Connectors that accept exactly one mate; a stud cannot carry two parts. */
const EXCLUSIVE_FAMILIES: ReadonlySet<ConnectionFamily> = new Set<ConnectionFamily>([
  'stud',
  'anti-stud',
  'pin',
  'pin-hole',
  'axle-hole',
  'clip',
  'ball',
  'socket',
])

export const isExclusiveFamily = (family: ConnectionFamily) => EXCLUSIVE_FAMILIES.has(family)

type CompatKey = Pick<ConnectionFeature, 'family' | 'gender'> & { group?: string }

export function connectorsCompatible(a: CompatKey, b: CompatKey): boolean {
  if (a.gender === b.gender && a.gender !== 'neutral') return false
  const key = [a.family, b.family].sort().join(':')
  if (!COMPATIBLE_PAIRS.has(key)) return false
  // A generic connector's LDCad group is the only thing distinguishing, say, a
  // turntable interface from a door hinge of similar dimensions.
  if (a.family === 'generic' || b.family === 'generic') return Boolean(a.group) && a.group === b.group
  return true
}

/**
 * Whether the pair can be assembled from either side along its axis.
 *
 * A pin, axle or bar is symmetric and can be inserted from either end. A stud
 * is not: it only enters an underside, so allowing the flip would happily place
 * bricks upside down.
 */
function allowsAxialFlip(a: ConnectionFamily, b: ConnectionFamily): boolean {
  const pair = [a, b].sort().join(':')
  return pair === 'axle:axle-hole' || pair === 'bar:clip' || pair === 'pin:pin-hole'
}

/**
 * Relative motion a mated pair retains.
 *
 * Freedoms come from the connector families plus the slide/rotate flags the
 * compiler carried across from LDCad. A pair whose behaviour is not modelled
 * reports `unknown` rather than being assumed rigid.
 */
export function jointFor(a: ConnectionFeature, b: ConnectionFeature): JointFreedom {
  const pair = [a.family, b.family].sort().join(':')
  const slides = Boolean(a.slide || b.slide)
  const axialRange = Math.max(a.axial ?? 0, b.axial ?? 0)

  switch (pair) {
    case 'anti-stud:stud':
      // Geometrically a round stud is free to spin, but System building is a
      // quarter-turn lattice and multi-stud parts are pinned by their other
      // studs. Quarter turns are the useful candidate set.
      return { kind: 'revolute', axis: CONNECTOR_AXIS, continuous: false, stepDegrees: 90 }

    case 'pin:pin-hole':
      return slides
        ? { kind: 'cylindrical', axis: CONNECTOR_AXIS, minLdu: -axialRange / 2, maxLdu: axialRange / 2, continuousRotation: true }
        : { kind: 'revolute', axis: CONNECTOR_AXIS, continuous: true }

    case 'axle:axle-hole':
      // A cross axle is keyed: it can slide freely but only seats at quarter
      // turns.
      return { kind: 'cylindrical', axis: CONNECTOR_AXIS, minLdu: -axialRange / 2, maxLdu: axialRange / 2, continuousRotation: false }

    case 'bar:clip':
      return { kind: 'cylindrical', axis: CONNECTOR_AXIS, minLdu: -axialRange / 2, maxLdu: axialRange / 2, continuousRotation: true }

    case 'hinge:hinge':
      return { kind: 'revolute', axis: CONNECTOR_AXIS, continuous: true }

    case 'ball:socket':
      return { kind: 'spherical' }

    case 'generic:generic':
      // Group-gated special interfaces: mating is known, freedom is not.
      return { kind: 'unknown' }

    default:
      return { kind: 'unknown' }
  }
}

/** The connector's frame expressed as a rigid transform in part-local space. */
export function featureFrame(feature: ConnectionFeature): RigidTransform {
  return { position: feature.pos, basis: (feature.ori ?? IDENTITY_BASIS) as Mat3 }
}

export interface MatingSolution {
  /** Transform applied between the target and moving connector frames. */
  readonly mating: RigidTransform
  readonly joint: JointFreedom
  readonly angleDegrees: number
  readonly offsetLdu: number
  readonly flipped: boolean
  /**
   * `exact` when the frames fully determine the pose, `chosen` when a free
   * parameter was resolved from operator intent, `unknown` when the pair's
   * freedom is not modelled.
   */
  readonly certainty: 'exact' | 'chosen' | 'unknown'
}

const AXIAL_FLIP: Mat3 = basisFromAxisAngle([1, 0, 0], Math.PI)

/**
 * Closest rotation about the connector axis to a desired relative rotation.
 *
 * For a rotation about local +Y the trace of `Rᵀ·M` is maximized at
 * `atan2(M₀₂ − M₂₀, M₀₀ + M₂₂)`, which is the exact least-squares angle rather
 * than a sampled search.
 */
function bestAngleAboutAxis(desiredRelative: Mat3): number {
  return Math.atan2(desiredRelative[2] - desiredRelative[6], desiredRelative[0] + desiredRelative[8])
}

export interface MatingHint {
  /**
   * Rotation the moving connector frame would need relative to the target
   * frame to best match operator intent. Used to resolve free parameters.
   */
  readonly desiredRelativeBasis?: Mat3
  /** Desired axial offset in LDU along the connector axis. */
  readonly desiredOffsetLdu?: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function matingTransform(angleRad: number, offsetLdu: number, flipped: boolean): RigidTransform {
  let basis = basisFromAxisAngle(CONNECTOR_AXIS, angleRad)
  if (flipped) basis = multiplyMat3(AXIAL_FLIP, basis)
  return {
    basis: orthonormalize(basis),
    position: [
      CONNECTOR_AXIS[0] * offsetLdu,
      CONNECTOR_AXIS[1] * offsetLdu,
      CONNECTOR_AXIS[2] * offsetLdu,
    ],
  }
}

/**
 * Enumerates the mating transforms a compatible connector pair admits.
 *
 * The result is deliberately small and deterministic: quarter turns for keyed
 * and System interfaces, plus the exact best-fit parameter when the joint is
 * continuous, plus the axial flip where insertion is two-sided. Candidates are
 * deduplicated so a symmetric joint does not produce the same pose twice.
 */
export function enumerateMatings(
  moving: ConnectionFeature,
  target: ConnectionFeature,
  hint: MatingHint = {},
): MatingSolution[] {
  const joint = jointFor(moving, target)
  const flips = allowsAxialFlip(moving.family, target.family) ? [false, true] : [false]

  const angles: Array<{ radians: number; certainty: MatingSolution['certainty'] }> = []
  const offsets: number[] = []

  const pushAngle = (radians: number, certainty: MatingSolution['certainty']) => {
    const normalized = ((radians % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    if (angles.some((entry) => Math.abs(entry.radians - normalized) < 1e-6)) return
    angles.push({ radians: normalized, certainty })
  }

  switch (joint.kind) {
    case 'revolute': {
      if (joint.continuous && hint.desiredRelativeBasis) {
        pushAngle(bestAngleAboutAxis(hint.desiredRelativeBasis), 'chosen')
      }
      const step = joint.continuous ? 90 : (joint.stepDegrees ?? 90)
      for (let degrees = 0; degrees < 360; degrees += step) pushAngle(degreesToRadians(degrees), 'exact')
      offsets.push(0)
      break
    }
    case 'cylindrical': {
      if (joint.continuousRotation && hint.desiredRelativeBasis) {
        pushAngle(bestAngleAboutAxis(hint.desiredRelativeBasis), 'chosen')
      }
      for (let degrees = 0; degrees < 360; degrees += 90) pushAngle(degreesToRadians(degrees), 'exact')
      offsets.push(0)
      if (joint.maxLdu > joint.minLdu && hint.desiredOffsetLdu !== undefined) {
        const chosen = clamp(hint.desiredOffsetLdu, joint.minLdu, joint.maxLdu)
        if (Math.abs(chosen) > 1e-6) offsets.push(chosen)
      }
      break
    }
    case 'spherical': {
      // A ball joint's rotation is entirely free, so the best-fit rotation *is*
      // the desired relative rotation.
      offsets.push(0)
      if (hint.desiredRelativeBasis) {
        return dedupe(
          flips.map((flipped) => ({
            mating: {
              basis: orthonormalize(flipped ? multiplyMat3(AXIAL_FLIP, hint.desiredRelativeBasis!) : hint.desiredRelativeBasis!),
              position: [0, 0, 0] as Vec3,
            },
            joint,
            angleDegrees: 0,
            offsetLdu: 0,
            flipped,
            certainty: 'chosen' as const,
          })),
        )
      }
      pushAngle(0, 'exact')
      break
    }
    default: {
      pushAngle(0, joint.kind === 'unknown' ? 'unknown' : 'exact')
      offsets.push(0)
      break
    }
  }

  const solutions: MatingSolution[] = []
  for (const flipped of flips) {
    for (const angle of angles) {
      for (const offset of offsets) {
        solutions.push({
          mating: matingTransform(angle.radians, offset, flipped),
          joint,
          angleDegrees: Number(radiansToDegrees(angle.radians).toFixed(4)),
          offsetLdu: offset,
          flipped,
          certainty: angle.certainty,
        })
      }
    }
  }
  return dedupe(solutions)
}

function dedupe(solutions: MatingSolution[]): MatingSolution[] {
  const seen = new Set<string>()
  const out: MatingSolution[] = []
  for (const solution of solutions) {
    const key = [
      ...solution.mating.basis.map((value) => Math.round(value * 1e6)),
      ...solution.mating.position.map((value) => Math.round(value * 1e6)),
    ].join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(solution)
  }
  return out
}

/**
 * Relative pose two mated connector frames currently hold.
 *
 * Stored on a committed edge so validation can later detect that a raw
 * transform edit broke the joint, and so an articulated move can re-derive the
 * joint parameter.
 */
export function relativeFrame(
  targetWorldFrame: RigidTransform,
  movingWorldFrame: RigidTransform,
): RigidTransform {
  const inverse = transposeMat3(targetWorldFrame.basis)
  const delta = subVec(movingWorldFrame.position, targetWorldFrame.position)
  return {
    basis: multiplyMat3(inverse, movingWorldFrame.basis),
    position: [
      inverse[0] * delta[0] + inverse[1] * delta[1] + inverse[2] * delta[2],
      inverse[3] * delta[0] + inverse[4] * delta[1] + inverse[5] * delta[2],
      inverse[6] * delta[0] + inverse[7] * delta[1] + inverse[8] * delta[2],
    ],
  }
}

/** Axial separation of two coaxial connector frames, in LDU. */
export function axialSeparation(a: RigidTransform, b: RigidTransform): number {
  const axis: Vec3 = [a.basis[1], a.basis[4], a.basis[7]]
  return dotVec(subVec(b.position, a.position), axis)
}

export const IDENTITY_MATING: RigidTransform = IDENTITY_TRANSFORM
