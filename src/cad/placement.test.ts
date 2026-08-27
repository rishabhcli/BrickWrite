import { describe, expect, it } from 'vitest'
import { catalog, originForSurface, searchCatalog, STUD_LDU, surfaceAbove, underPlaneLdu } from './catalog'
import { getPartBounds } from './geometry'
import { IDENTITY_BASIS } from './math'
import { QUARTER_TURN_BASES, resolvePlacement, rotatedBasis } from './placement'
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
    const tileId = catalog.placeable().find((item) => surfaceAbove(item, 0) === null)?.canonicalId
    expect(tileId).toBeTruthy()
    const target = part('target', tileId!)
    const document = withParts(target)

    const resolved = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      document,
      { point: [0, 0, 0], partId: 'target' },
      STUD_LDU,
    )!

    expect(resolved.surfaceY).toBeCloseTo(getPartBounds(target).min[1], 6)
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
