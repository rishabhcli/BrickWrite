import { describe, expect, it } from 'vitest'
import { familyLibrary, planBrickField } from './assembly'
import { catalog } from './catalog'
import { findCollisions } from './collision'
import { createBlankDocument } from './sample'
import { floatingPartIds, airbornePartIds } from './validation'
import { PLATE_LDU } from './catalog'
import type { CadOperation, ModelDocument, PartInstance } from './types'

const field = (widthStuds: number, footprintDepthStuds: number, y: number, family?: 'plate' | 'brick' | 'tile') =>
  planBrickField({
    origin: [0, y, 0],
    color: 71,
    subassemblyId: 'main',
    stepId: 'step_1',
    actor: 'human',
    ...(family ? { family } : {}),
    widthStuds,
    footprintDepthStuds,
    layers: 2,
  } as Parameters<typeof planBrickField>[0])

const materialise = (...ops: CadOperation[][]): ModelDocument => {
  const base = createBlankDocument('Field')
  const parts: Record<string, PartInstance> = { ...base.parts }
  let n = 0
  for (const list of ops) {
    for (const op of list) {
      if (op.type !== 'part.add') continue
      n += 1
      parts[`p_${n}`] = { ...op.part, id: `p_${n}` }
    }
  }
  return { ...base, parts }
}

/**
 * A deck laid on another deck, which is what every storey, lattice tier and
 * hull deck in the product actually is. Laid on the ground instead, a bad
 * filler part has nothing to collide with and nothing to fall off, so the
 * defect only appears once something is underneath.
 */
describe('a field laid on another field', () => {
  it.each([
    [16, 16],
    [17, 17],
    [21, 16],
    [5, 5],
  ])('stacks a %i x %i deck cleanly', (widthStuds, depthStuds) => {
    const lower = field(widthStuds, depthStuds, 0)
    const upper = field(widthStuds, depthStuds, -2 * PLATE_LDU)
    const document = materialise(lower.operations, upper.operations)

    expect(findCollisions(document)).toEqual([])
    expect(floatingPartIds(document)).toEqual([])
    expect(airbornePartIds(document)).toEqual([])
  })

  it.each([[17, 17], [5, 5]])('picks only stackable identities for a %i x %i deck', (widthStuds, depthStuds) => {
    const plan = field(widthStuds, depthStuds, 0, 'plate')
    const used = new Set(plan.operations.flatMap((op) => (op.type === 'part.add' ? [op.part.definitionId] : [])))
    // A tooth plate has a protrusion and a round plate with a solid stud has no
    // anti-stud underneath. Neither can carry or be carried by a deck, so
    // neither belongs in one.
    expect([...used]).not.toContain('49668')
    expect([...used]).not.toContain('6141')
  })
})

/**
 * `planLattice` and the other mechanism planners build their `base` from
 * `mechanismBase`, which carries no `family` — so every deck they lay reaches
 * `planBrickField` with the family unset.
 */
describe('a field laid with no family stated', () => {
  it.each([
    [16, 16],
    [17, 17],
  ])('stacks a %i x %i deck cleanly', (widthStuds, depthStuds) => {
    const lower = field(widthStuds, depthStuds, 0)
    const upper = field(widthStuds, depthStuds, -2 * PLATE_LDU)
    const document = materialise(lower.operations, upper.operations)

    expect(findCollisions(document)).toEqual([])
    expect(floatingPartIds(document)).toEqual([])
    expect(airbornePartIds(document)).toEqual([])
  })

  it('picks only stackable identities', () => {
    const plan = field(17, 17, 0)
    const used = new Set(plan.operations.flatMap((op) => (op.type === 'part.add' ? [op.part.definitionId] : [])))
    expect([...used]).not.toContain('49668')
    expect([...used]).not.toContain('6141')
  })
})

/**
 * Structural runs are built from plain blocks.
 *
 * Height, depth and connector families do not identify a rectangular brick. A
 * `Plate Special 1 x 1 with Tooth` measures 1 x 1 and carries a stud and an
 * anti-stud, so it satisfied every other test the selector applied — and then
 * its tooth intersected the plate beside it. Against the production catalog the
 * selector also chose a 45° slope as the one-stud brick and a Technic brick
 * with holes as the sixteen-stud one.
 *
 * This is asserted as a *rule* rather than by looking for those specific parts,
 * because the test fixture holds 59 identities and the shipped catalog holds
 * 900: the parts that broke the demos are not in the fixture to be picked, so
 * an outcome-based test here would pass while the product failed.
 */
describe('the identities a structural run may use', () => {
  const SHAPED = /Special|Sloped|Curved|Wedged|Round|Technic|Windows|Windscreens|Bars|Hinges|Minifig/

  it.each([
    ['brick', 1],
    ['brick', 2],
    ['plate', 1],
    ['plate', 2],
    ['tile', 1],
  ] as const)('picks only plain %s identities at depth %i', (family, depth) => {
    const library = familyLibrary(family, depth)
    if (!library) return
    for (const length of library.lengths) {
      const definition = library.definitionFor(length)
      expect(definition, `${family} depth ${depth} length ${length}`).toBeDefined()
      expect(definition!.category, `${definition!.canonicalId} (${definition!.name})`).not.toMatch(SHAPED)
    }
  })

  it('leaves the shaped categories out entirely, even though they measure correctly', () => {
    // The fixture does carry shaped parts — slopes, a special plate, a round
    // plate — so this asserts they were considered and rejected, not merely
    // absent.
    const shaped = catalog.placeable().filter((part) => SHAPED.test(part.category))
    expect(shaped.length).toBeGreaterThan(0)

    const chosen = new Set<string>()
    for (const family of ['brick', 'plate', 'tile'] as const) {
      for (const depth of [1, 2]) {
        const library = familyLibrary(family, depth)
        if (!library) continue
        for (const length of library.lengths) chosen.add(library.definitionFor(length)!.canonicalId)
      }
    }
    for (const part of shaped) expect(chosen.has(part.canonicalId), `${part.canonicalId} ${part.name}`).toBe(false)
  })
})
