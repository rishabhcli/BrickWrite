import { describe, expect, it } from 'vitest'
import { catalog, originForSurface, searchCatalog, STUD_LDU, surfaceAbove, underPlaneLdu } from './catalog'
import { getPartBounds, nearbyParts } from './geometry'
import { IDENTITY_BASIS } from './math'
import { QUARTER_TURN_BASES, hitApproach, legalConnectCandidates, resolvePlacement, resolveQuickAdd, rotatedBasis, searchMateOnTarget } from './placement'
import { partPoseCollides } from './collisionGate'
import { bestSnapTransform } from './snapping'
import { createBlankDocument, createEmptyDocument } from './sample'
import type { ModelDocument, PartInstance, Transform } from './types'

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

/** A one-plate tile with no studs. Tall no-stud-plane parts are not tiles. */
function plateTileId(): string {
  if (catalog.get('3070b')) return '3070b'
  const found = catalog.placeable().find((item) => {
    if (item.connectors.some((feature) => feature.family === 'stud')) return false
    const bounds = item.dimensions?.bounds
    return Boolean(bounds) && bounds!.max[1] - bounds!.min[1] <= 10
  })
  if (!found) throw new Error('compiled catalog has no plate-height tile')
  return found.canonicalId
}

/** A fresh document per call: derived connection state is memoized on identity. */
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

describe('placement resolution', () => {
  it('rests a part on the exposed stud plane of the part under the cursor', () => {
    const base = part('base', '3001')
    const document = withParts(base)
    const definition = catalog.get('3001')!
    const studPlane = surfaceAbove(definition, base.transform.position[1])!

    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [0, studPlane, 0], partId: 'base' },
      STUD_LDU,
    )!

    // The new part's own underside plane must coincide with the stud plane it
    // was dropped onto, which is what "sits on top" means for a part whose
    // origin is not at its underside.
    const underside = resolved.transform.position[1] + underPlaneLdu(definition)
    expect(underside).toBeCloseTo(studPlane, 6)
    expect(resolved.mated).toBe(true)
  })

  it('rests on the ground plane when the ray reaches no part', () => {
    const document = withParts()
    const definition = catalog.get('3001')!
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [37, 0, -14], partId: null },
      STUD_LDU,
    )!

    expect(resolved.surfaceY).toBe(0)
    expect(resolved.transform.position[1]).toBeCloseTo(originForSurface(definition, 0), 6)
    // Nothing to mate with, so the pose is the quantized cursor.
    expect(resolved.mated).toBe(false)
    expect(resolved.transform.position[0]).toBe(40)
    expect(resolved.transform.position[2]).toBe(-20)
  })

  it('falls back to the measured top face for a part with no exposed studs', () => {
    // A tile has no stud connectors, so nothing can report a stud plane; the
    // placement must still land on the surface rather than inside it.
    const tileId = plateTileId()
    const target = part('target', tileId)
    const document = withParts(target)

    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [0, 0, 0], partId: 'target' },
      STUD_LDU,
    )!

    expect(resolved.surfaceY).toBeCloseTo(getPartBounds(target).min[1], 6)
    expect(resolved.mated).toBe(false)
    expect(resolved.legal).toBe(false)
    expect(resolved.reason).toBe('absent')
  })

  it('marks a mated stack as a legal commit', () => {
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(part('base', '3001')),
      { point: [0, 0, 0], partId: 'base' },
      STUD_LDU,
    )!
    expect(resolved.mated).toBe(true)
    expect(resolved.legal).toBe(true)
    expect(resolved.reason).toBe('mated')
  })

  it('marks a click on a fully occupied stud plane as illegal', () => {
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(part('base', '3001'), part('upper', '3001', { position: [0, -24, 0] })),
      { point: [0, 0, 0], partId: 'base' },
      STUD_LDU,
    )!
    expect(resolved.mated).toBe(false)
    expect(resolved.legal).toBe(false)
    expect(resolved.reason).toBe('occupied')
  })

  it('slides onto remaining free studs of the part under the cursor', () => {
    const plate = catalog.get('3024')
    expect(plate).toBeTruthy()
    const base = part('base', '3001')
    const coarseY = originForSurface(plate!, surfaceAbove(catalog.get('3001'), 0)!)
    const probe = part('cap', '3024', { position: [30, coarseY, 30] })
    const capPose = bestSnapTransform(probe, withParts(base, probe), probe.transform, {
      radiusLdu: 40,
      targetPartIds: ['base'],
    })
    expect(capPose).toBeTruthy()
    const cap = { ...probe, transform: capPose! }
    const document = withParts(base, cap)
    const resolved = resolvePlacement(
      { definitionId: '3024', color: 4, quarterTurns: 0 },
      document,
      { point: [capPose!.position[0], 0, capPose!.position[2]], partId: 'base' },
      8,
    )!
    expect(resolved.legal).toBe(true)
    expect(resolved.mated).toBe(true)
    expect(resolved.reason).toBe('mated')
    expect(
      Math.hypot(resolved.transform.position[0] - capPose!.position[0], resolved.transform.position[2] - capPose!.position[2]),
    ).toBeGreaterThan(8)
  })

  it('slides past a colliding brick onto remaining free studs of a longer plate', () => {
    const plateId = catalog.get('3034') ? '3034' : catalog.get('3795') ? '3795' : catalog.get('3031') ? '3031' : null
    expect(plateId).toBeTruthy()
    const plate = part('plate', plateId!)
    const coarseY = originForSurface(catalog.get('3001')!, surfaceAbove(catalog.get(plateId!), 0)!)
    const probe = part('left', '3001', { position: [-40, coarseY, 0] })
    const mate = searchMateOnTarget(probe, withParts(plate), plate, probe.transform, 'on-top', 60)
    expect(mate.transform).toBeTruthy()
    const left = { ...probe, transform: mate.transform! }
    const document = withParts(plate, left)
    expect(partPoseCollides(document, { ...part('ghost', '3001'), transform: left.transform })).toBe(true)
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [left.transform.position[0], 0, left.transform.position[2]], partId: 'plate' },
      8,
    )!
    expect(resolved.legal).toBe(true)
    expect(resolved.mated).toBe(true)
    expect(resolved.reason).toBe('mated')
    expect(partPoseCollides(document, { ...part('ghost', '3001'), transform: resolved.transform })).toBe(false)
    expect(Math.abs(resolved.transform.position[1] - left.transform.position[1])).toBeLessThan(2)
    expect(
      Math.hypot(resolved.transform.position[0] - left.transform.position[0], resolved.transform.position[2] - left.transform.position[2]),
    ).toBeGreaterThan(8)
  })

  it('does not steal a neighbour’s studs when the click lands on a tile', () => {
    const tileId = plateTileId()
    const document = withParts(part('brick', '3001'), part('tile', tileId, { position: [60, 0, 0] }))
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [60, 0, 0], partId: 'tile' },
      STUD_LDU,
    )!
    expect(resolved.mated).toBe(false)
    expect(resolved.legal).toBe(false)
    expect(resolved.reason).toBe('absent')
  })

  it('marks a ground rest as legal even without a mate', () => {
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(),
      { point: [0, 0, 0], partId: null },
      STUD_LDU,
    )!
    expect(resolved.mated).toBe(false)
    expect(resolved.legal).toBe(true)
    expect(resolved.reason).toBe('ground')
  })

  it('reports nothing for an identity this build cannot place', () => {
    // Searchable identities outnumber placeable ones, and the resolver must not
    // invent a pose for one of them; the kernel's refusal is what the operator
    // should see instead.
    const unplaceable = searchCatalog({ requireGeometry: false, limit: 400 }).find((record) => !record.geometryAvailable)?.id
      ?? '__no_such_identity__'
    expect(
      resolvePlacement({ definitionId: unplaceable, color: 4, quarterTurns: 0 }, withParts(), { point: [0, 0, 0], partId: null }, STUD_LDU),
    ).toBeNull()
  })

  it('turns the cursor pose in exact quarter turns that wrap in both directions', () => {
    expect(rotatedBasis(0)).toEqual(QUARTER_TURN_BASES[0])
    expect(rotatedBasis(4)).toEqual(QUARTER_TURN_BASES[0])
    expect(rotatedBasis(-1)).toEqual(QUARTER_TURN_BASES[3])
    expect(rotatedBasis(7)).toEqual(QUARTER_TURN_BASES[3])
    // Every basis is exact, so repeated turns cannot drift.
    for (const basis of QUARTER_TURN_BASES) {
      for (const value of basis) expect(Math.abs(value) === 0 || Math.abs(value) === 1).toBe(true)
    }
  })

  it('applies the operator’s turn to the resolved pose', () => {
    const document = withParts()
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 1 },
      document,
      { point: [0, 0, 0], partId: null },
      STUD_LDU,
    )!
    expect(resolved.transform.basis).toEqual(QUARTER_TURN_BASES[1])
  })

  it('classifies a hit on the +X face as beside-x and still stacks on top when there is no SNOT mate', () => {
    const base = part('base', '3001')
    const box = getPartBounds(base)
    expect(hitApproach([box.max[0], (box.min[1] + box.max[1]) / 2, 0], box)).toBe('beside-x')
    expect(hitApproach([0, box.min[1], 0], box)).toBe('on-top')
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(base),
      { point: [box.max[0], (box.min[1] + box.max[1]) / 2, 0], partId: 'base' },
      STUD_LDU,
    )!
    expect(resolved.legal).toBe(true)
    expect(resolved.mated).toBe(true)
    expect(resolved.reason).toBe('mated')
  })

  it('quick-adds onto the selection with the same occupancy gate as click-to-place', () => {
    const tileId = plateTileId()
    const onBrick = resolveQuickAdd(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(part('base', '3001')),
      'base',
      STUD_LDU,
    )!
    expect(onBrick.legal).toBe(true)
    expect(onBrick.mated).toBe(true)

    const onTile = resolveQuickAdd(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(part('tile', tileId)),
      'tile',
      STUD_LDU,
    )!
    expect(onTile.legal).toBe(false)
    expect(onTile.reason).toBe('absent')
  })

  it('quick-adds a second building on the table when nothing is selected', () => {
    const resolved = resolveQuickAdd(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      withParts(part('base', '3001')),
      null,
      STUD_LDU,
    )!
    expect(resolved.legal).toBe(true)
    expect(resolved.reason).toBe('ground')
    expect(resolved.transform.position[0]).toBeGreaterThan(20)
  })

  it('lists only connect poses the kernel would commit', () => {
    const source = part('moving', '3001', { position: [3, -27, 2] })
    const target = part('base', '3001')
    const legal = legalConnectCandidates(source, target, withParts(target, source))
    expect(legal.length).toBeGreaterThan(0)
  })
})

describe('nearby parts', () => {
  it('orders other parts by AABB distance, including hovering bricks with no graph edges', () => {
    const document = withParts(
      part('anchor', '3001'),
      part('ghost', '3001', { position: [0, -200, 0] }),
      part('far', '3001', { position: [400, 0, 0] }),
    )
    const near = nearbyParts(document, 'ghost', 8)
    expect(near[0]?.id).toBe('anchor')
    expect(near.map((entry) => entry.id)).toContain('far')
    expect(near.find((entry) => entry.id === 'anchor')!.distanceLdu).toBeLessThan(
      near.find((entry) => entry.id === 'far')!.distanceLdu,
    )
  })
})

describe('a blank project', () => {
  it('carries one unlocked assembly and one step, not the showcase structure', () => {
    const document = createBlankDocument('Cargo hauler')

    expect(document.name).toBe('Cargo hauler')
    expect(Object.keys(document.parts)).toHaveLength(0)
    expect(Object.values(document.subassemblies)).toHaveLength(1)
    expect(Object.values(document.subassemblies)[0].locked).toBe(false)
    expect(document.steps).toHaveLength(1)
    // No rover names, no rover constraints, no rover note.
    expect(document.subassemblies.cockpit).toBeUndefined()
    expect(document.constraints).toHaveLength(0)
    expect(document.notes).toHaveLength(0)
  })

  it('leaves a placeable part somewhere the first placement can reach', () => {
    const document = createBlankDocument()
    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [0, 0, 0], partId: null },
      STUD_LDU,
    )!
    expect(resolved.transform.position).toEqual([0, originForSurface(catalog.get('3001'), 0), 0])
  })
})
