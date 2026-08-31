import { beforeAll, describe, expect, it } from 'vitest'
import { installRealCatalog } from '../intelligence/parts/__fixtures__/real-catalog'
import { catalog } from './catalog'
import { familyLibrary, planBrickField, planEnclosure, planWall } from './assembly'
import { findCollisions } from './collision'
import { createBlankDocument } from './sample'
import { airbornePartIds, floatingPartIds } from './validation'
import type { BrickFamily, CadOperation, ModelDocument, PartInstance } from './types'

/**
 * The planners, against the catalog the application actually ships.
 *
 * Every other assembly test runs on `__fixtures__/catalog.fixture.json`, which
 * holds 59 curated identities. That is the right stub for geometry and
 * connector behaviour — the records are real — but it is the wrong stub for
 * anything that *chooses between* identities, because with 59 parts there is
 * usually only one plausible candidate per size.
 *
 * The shipped catalog has 900. That difference is not academic: it hid a defect
 * where `familyLibrary` selected `Plate Special 1 x 1 with Tooth` as a deck
 * filler, `Brick Sloped 45°` as the one-stud brick, and `Technic Brick 1 x 16
 * with Holes` as the sixteen-stud wall brick. All measure correctly; none
 * stack. The fixture never offered those parts, so the fixture-based tests
 * passed while the demo compiler rejected the results as collisions and
 * unsupported islands.
 *
 * This file exists so selection is judged against the real field of candidates.
 * It follows the stance `__fixtures__/real-catalog.ts` already takes for the
 * part ranker, for the same reason.
 */

/** Categories whose members are not plain rectangular blocks. */
const SHAPED = /Special|Sloped|Curved|Wedged|Round|Technic|Windows|Windscreens|Bars|Hinges|Minifig|Animals|Plants/

const FAMILIES: ReadonlyArray<readonly [BrickFamily, number]> = [
  ['brick', 1],
  ['brick', 2],
  ['plate', 1],
  ['plate', 2],
  ['tile', 1],
]

const materialise = (...plans: ReadonlyArray<{ operations: readonly CadOperation[] }>): ModelDocument => {
  const base = createBlankDocument('Production planner')
  const parts: Record<string, PartInstance> = { ...base.parts }
  let n = 0
  for (const plan of plans) {
    for (const operation of plan.operations) {
      if (operation.type !== 'part.add') continue
      n += 1
      parts[`p_${n}`] = { ...operation.part, id: `p_${n}` }
    }
  }
  return { ...base, parts }
}

const spec = (extra: Record<string, unknown>) =>
  ({ origin: [0, 0, 0], color: 71, subassemblyId: 'main', stepId: 'step_1', actor: 'human', ...extra }) as never

describe('structural identity selection, against the shipped catalog', () => {
  beforeAll(async () => {
    await installRealCatalog()
  })

  it('installs a catalog materially larger than the unit-test fixture', () => {
    // If this ever stops being true the file is not testing what it claims to.
    expect(catalog.placeable().length).toBeGreaterThan(400)
  })

  it.each(FAMILIES)('picks only plain %s identities at depth %i', (family, depth) => {
    const library = familyLibrary(family, depth)
    expect(library, `${family} depth ${depth} has no library at all`).not.toBeNull()
    for (const length of library!.lengths) {
      const definition = library!.definitionFor(length)!
      expect(definition.category, `${family} ${length}x${depth} chose ${definition.canonicalId} (${definition.name})`)
        .not.toMatch(SHAPED)
    }
  })

  it.each(FAMILIES)('offers a usable range of lengths for %s at depth %i', (family, depth) => {
    // A library that collapsed to one length would tile every run identically
    // and lose the staggered bond the planners exist to produce.
    expect(familyLibrary(family, depth)!.lengths.length).toBeGreaterThan(2)
  })
})

describe('what the planners build from the shipped catalog', () => {
  beforeAll(async () => {
    await installRealCatalog()
  })

  it.each([
    [16, 16],
    [17, 17],
    [21, 13],
  ])('stacks a %i x %i deck on another without collisions or floating parts', (widthStuds, depthStuds) => {
    const lower = planBrickField(spec({ family: 'plate', widthStuds, footprintDepthStuds: depthStuds, layers: 2 }))
    const upper = planBrickField(
      spec({ origin: [0, -16, 0], family: 'plate', widthStuds, footprintDepthStuds: depthStuds, layers: 2 }),
    )
    const document = materialise(lower, upper)

    expect(findCollisions(document)).toEqual([])
    expect(floatingPartIds(document)).toEqual([])
    expect(airbornePartIds(document)).toEqual([])
  })

  it.each([
    [16, 12, 4],
    [17, 13, 5],
  ])('raises a %i x %i x %i enclosure that stands on itself', (widthStuds, depthStuds, courses) => {
    const plan = planEnclosure(
      spec({
        family: 'brick',
        depthStuds: 1,
        widthStuds,
        footprintDepthStuds: depthStuds,
        courses,
        floor: true,
        floorLayers: 2,
      }),
    )
    const document = materialise(plan)

    expect(findCollisions(document)).toEqual([])
    expect(floatingPartIds(document)).toEqual([])
  })

  it('lays a wall of every length without reaching for a shaped part', () => {
    for (const lengthStuds of [3, 5, 8, 13, 16, 17, 24]) {
      const plan = planWall(spec({ family: 'brick', axis: 'x', depthStuds: 1, lengthStuds, courses: 3 }))
      for (const operation of plan.operations) {
        if (operation.type !== 'part.add') continue
        const definition = catalog.get(operation.part.definitionId)!
        expect(definition.category, `wall of ${lengthStuds} used ${definition.canonicalId} (${definition.name})`)
          .not.toMatch(SHAPED)
      }
    }
  })
})
