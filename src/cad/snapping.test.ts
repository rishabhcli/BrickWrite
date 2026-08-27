import { describe, expect, it } from 'vitest'
import { enumerateMatings, jointFor } from './connections'
import { applyMat3, basisFromAxisAngle, basisFromEulerDegrees, IDENTITY_BASIS, type Vec3 } from './math'
import { createEmptyDocument } from './sample'
import { bestSnapTransform, computeOccupancy, findSnapCandidates } from './snapping'
import { catalog } from './catalog'
import type { ConnectionFamily, ConnectionFeature, ModelDocument, PartInstance, Transform } from './types'

const part = (id: string, definitionId: string, transform: Partial<Transform> = {}): PartInstance => ({
  id,
  definitionId,
  color: 72,
  transform: { position: transform.position ?? [0, 0, 0], basis: transform.basis ?? IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/**
 * Builds a fresh document object rather than mutating one.
 *
 * Derived connection state is memoized on document identity, which is sound
 * because the kernel treats a document as immutable per revision. A helper that
 * injected parts into an already-constructed document would read a cached
 * derivation from before the injection.
 */
const withParts = (...parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

const feature = (family: ConnectionFamily, gender: 'male' | 'female', extra: Partial<ConnectionFeature> = {}): ConnectionFeature => ({
  id: `${family}_${gender}`,
  family,
  gender,
  pos: [0, 0, 0],
  src: 'ldcad',
  ...extra,
})

describe('snap solver', () => {
  it('settles a 2 x 4 brick onto all eight studs', () => {
    // LDraw is Y-down, so a brick resting on another sits 24 LDU lower.
    const moving = part('moving', '3001', { position: [0, -25, 0] })
    const document = withParts(part('base', '3001'), moving)
    const candidates = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 10 })

    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].simultaneousMatches).toBe(8)
    expect(candidates[0].transform.position).toEqual([0, -24, 0])
    expect(candidates[0].transform.basis).toEqual(IDENTITY_BASIS)
  })

  it('solves a rotated pose for a stud that does not point up', () => {
    // 87087 carries a side stud at (0, 10, -10) whose axis is +Z. Placing a
    // brick on it requires deriving orientation, not just translation — the
    // case a translation-only solver cannot express at all.
    const sideStud = catalog.get('87087')!.connectors.find((item) => item.family === 'stud' && item.ori)
    expect(sideStud?.pos).toEqual([0, 10, -10])

    // The operator has dragged the brick roughly into place but has not rotated
    // it: the cursor basis is still upright.
    const moving = part('moving', '3005', { position: [0, 10, -32] })
    const document = withParts(part('bracket', '87087'), moving)
    const candidates = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 14 })
    const solved = candidates[0]

    expect(solved).toBeDefined()
    // The brick's own up axis must now point along the stud's axis.
    const movedUp = applyMat3(solved.transform.basis, [0, 1, 0] as Vec3)
    expect(movedUp[0]).toBeCloseTo(0, 6)
    expect(movedUp[1]).toBeCloseTo(0, 6)
    expect(movedUp[2]).toBeCloseTo(1, 6)
    // Underside 24 LDU along that axis from the stud puts it at z = -34.
    expect(solved.transform.position[0]).toBeCloseTo(0, 6)
    expect(solved.transform.position[1]).toBeCloseTo(10, 6)
    expect(solved.transform.position[2]).toBeCloseTo(-34, 6)
    expect(solved.simultaneousMatches).toBeGreaterThanOrEqual(1)
  })

  it('recovers the upright placement from an arbitrary cursor orientation', () => {
    // Dragging with a nonsense rotation must still produce a legal pose rather
    // than preserving the operator's arbitrary basis.
    const moving = part('moving', '3001', {
      position: [3, -26, 2],
      basis: basisFromAxisAngle([0.3, 0.9, 0.2], 0.4),
    })
    const document = withParts(part('base', '3001'), moving)
    const solved = bestSnapTransform(moving, document, moving.transform, { radiusLdu: 14 })
    expect(solved?.position).toEqual([0, -24, 0])
    expect(solved?.basis).toEqual(IDENTITY_BASIS)
  })

  it('will not reuse a stud that already carries a part', () => {
    const moving = part('moving', '3001', { position: [0, -26, 0] })
    const document = withParts(part('base', '3001'), part('stacked', '3001', { position: [0, -24, 0] }), moving)

    expect(computeOccupancy(document).size).toBeGreaterThan(0)
    const candidates = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 12 })
    expect(candidates.every((candidate) => candidate.transform.position[1] !== -24)).toBe(true)
  })

  it('restricts candidates to one connector pair for the Connect tool', () => {
    const moving = part('moving', '3001', { position: [0, -25, 0] })
    const document = withParts(part('base', '3001'), moving)
    const all = findSnapCandidates(moving, document, moving.transform, { radiusLdu: 30 })
    const pinned = findSnapCandidates(moving, document, moving.transform, {
      radiusLdu: 30,
      movingFeatureId: all[0].movingFeatureId,
      targetFeatureId: all[0].targetFeatureId,
    })
    expect(pinned.length).toBeGreaterThan(0)
    expect(pinned.every((candidate) => candidate.movingFeatureId === all[0].movingFeatureId)).toBe(true)
    expect(pinned.every((candidate) => candidate.targetFeatureId === all[0].targetFeatureId)).toBe(true)
  })

  it('rejects an axis-misaligned coincidence as a connection', () => {
    // A brick rotated onto its side puts an anti-stud at the right point but
    // with the wrong axis; that is not a connection.
    const moving = part('moving', '3005', {
      position: [0, -24, 0],
      basis: basisFromEulerDegrees([90, 0, 0]),
    })
    const document = withParts(part('base', '3005'), moving)
    const occupancy = computeOccupancy(document)
    expect(occupancy.size).toBe(0)
  })
})

describe('joint freedoms', () => {
  it('gives the System stud interface quarter-turn candidates', () => {
    const joint = jointFor(feature('stud', 'male'), feature('anti-stud', 'female'))
    expect(joint).toEqual({ kind: 'revolute', axis: [0, 1, 0], continuous: false, stepDegrees: 90 })
    const matings = enumerateMatings(feature('stud', 'male'), feature('anti-stud', 'female'))
    expect(matings.map((entry) => entry.angleDegrees).sort((a, b) => a - b)).toEqual([0, 90, 180, 270])
    // A stud only enters an underside, so no flipped insertion is offered.
    expect(matings.some((entry) => entry.flipped)).toBe(false)
  })

  it('keys a cross axle to quarter turns but lets it slide', () => {
    const joint = jointFor(feature('axle', 'male', { axial: 120 }), feature('axle-hole', 'female'))
    expect(joint.kind).toBe('cylindrical')
    if (joint.kind !== 'cylindrical') return
    expect(joint.continuousRotation).toBe(false)
    expect(joint.maxLdu).toBeGreaterThan(0)
  })

  it('lets a round pin choose any angle, and insert from either end', () => {
    const joint = jointFor(feature('pin', 'male'), feature('pin-hole', 'female'))
    expect(joint).toMatchObject({ kind: 'revolute', continuous: true })
    const matings = enumerateMatings(feature('pin', 'male'), feature('pin-hole', 'female'), {
      desiredRelativeBasis: basisFromAxisAngle([0, 1, 0], 0.7),
    })
    expect(matings.some((entry) => entry.flipped)).toBe(true)
    // The continuous parameter is solved exactly, not sampled.
    const chosen = matings.find((entry) => entry.certainty === 'chosen')
    expect(chosen).toBeDefined()
    expect((chosen!.angleDegrees * Math.PI) / 180).toBeCloseTo(0.7, 5)
  })

  it('reports an unmodelled grouped interface as unknown rather than rigid', () => {
    const joint = jointFor(
      feature('generic', 'male', { group: 'craneArmW20' }),
      feature('generic', 'female', { group: 'craneArmW20' }),
    )
    expect(joint).toEqual({ kind: 'unknown' })
    expect(enumerateMatings(
      feature('generic', 'male', { group: 'craneArmW20' }),
      feature('generic', 'female', { group: 'craneArmW20' }),
    )[0].certainty).toBe('unknown')
  })
})
