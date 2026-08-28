import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalog } from '../../cad/catalog'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { antiStudSeparation, connectorSimilarity, footprintSpan, RelationIndex } from './relations'
import { loadPartCorpus, type PartCorpus } from './corpus'

/**
 * The relations are derived, so the tests are about the derivation being sound
 * rather than about a table being loaded: a mirror pairing has to be confirmed
 * by reflected geometry where geometry exists, an interface match has to be a
 * multiset comparison rather than a set one, and a bridging part has to be long
 * enough to actually land on both sides.
 */

let disk: DiskFetch
let corpus: PartCorpus
let relations: RelationIndex

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  corpus = await loadPartCorpus()
  relations = RelationIndex.build(corpus)
}, 120_000)

afterAll(() => disk.restore())

describe('handedness', () => {
  it('pairs the two hands of a wedge and proves it against the geometry', () => {
    const mirror = relations.mirrorOf('41747')
    expect(mirror?.id).toBe('41748')
    expect(mirror?.evidence).toBe('geometry')
    expect(mirror?.consecutiveIds).toBe(true)
    // The relation is symmetric: 41748's counterpart is 41747.
    expect(relations.mirrorOf('41748')?.id).toBe('41747')
  })

  it('reflects the measured box through x, rather than trusting the name', () => {
    const left = corpus.byId.get('41748')!
    const right = corpus.byId.get('41747')!
    expect(left.boundsLdu).not.toBeNull()
    expect(left.boundsLdu!.min[0]).toBeCloseTo(-right.boundsLdu!.max[0], 3)
    expect(left.boundsLdu!.min[1]).toBeCloseTo(right.boundsLdu!.min[1], 3)
  })

  it('still pairs parts LDraw never compiled, and says the evidence is weaker', () => {
    // 41767 and 41768 are modelled but carry no mesh, so there is no box to
    // reflect and the pairing rests on the name and the numbering.
    expect(catalog.describe('41767')?.geometryAvailable).toBe(false)
    const mirror = relations.mirrorOf('41767')
    expect(mirror?.id).toBe('41768')
    expect(mirror?.evidence).toBe('name')
  })

  it('records no counterpart for a part that has none', () => {
    expect(relations.mirrorOf('3001')).toBeNull()
    expect(relations.mirrorCount).toBeGreaterThan(500)
  })
})

describe('printed variants', () => {
  it('reads the LDraw decoration suffix back to its base design', () => {
    expect(relations.baseOf('3069bp73')).toBe('3069b')
    expect(relations.baseOf('3068bd09')).toBe('3068b')
    expect(relations.baseOf('3069b')).toBeNull()
  })

  it('lists the decorations of a base design, most used first', () => {
    const variants = relations.variantsOf('3069b')
    expect(variants.length).toBeGreaterThan(10)
    expect(variants.every((id) => relations.baseOf(id) === '3069b')).toBe(true)
    const frequencies = variants.map((id) => corpus.byId.get(id)?.frequency ?? 0)
    expect(frequencies).toEqual([...frequencies].sort((a, b) => b - a))
  })

  it('refuses a base the catalog does not actually contain', () => {
    // A suffix that decodes to nothing real is not a relation.
    expect(relations.baseOf('u9180')).toBeNull()
  })
})

describe('connector interfaces', () => {
  it('compares multisets, so count differences matter', () => {
    const plate2x4 = corpus.byId.get('3020')!.connectors!
    const plate2x2 = corpus.byId.get('3022')!.connectors!
    expect(connectorSimilarity(plate2x4, plate2x4)).toBe(1)
    // Same families, half the studs: alike but not interchangeable.
    const similarity = connectorSimilarity(plate2x4, plate2x2)
    expect(similarity).toBeGreaterThan(0)
    expect(similarity).toBeLessThan(1)
  })

  it('finds parts that mate with the same things as a tile', () => {
    const matches = relations.interfaceCompatible('3068b')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.75)
    for (const match of matches) {
      expect(match.id).not.toBe('3068b')
      expect(corpus.byId.get(match.id)?.connectors).toBeTruthy()
    }
  })

  it('answers nothing for an identity whose connectors were never compiled', () => {
    expect(corpus.byId.get('41767')?.connectors).toBeNull()
    expect(relations.interfaceCompatible('41767')).toEqual([])
  })
})

describe('gap bridging', () => {
  it('requires a landing stud on each side of the gap', () => {
    const candidates = relations.gapBridging(3)
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.spanStuds).toBeGreaterThanOrEqual(5)
      if (candidate.antiStudSeparation !== null) expect(candidate.antiStudSeparation).toBeGreaterThanOrEqual(4)
    }
    // Plate 1 x 6 is the everyday answer and has to be in reach.
    expect(candidates.map((candidate) => candidate.id)).toContain('3666')
  })

  it('measures the separation from the compiled anti-studs', () => {
    const plate = corpus.byId.get('3666')!
    expect(footprintSpan(plate)).toBe(6)
    expect(antiStudSeparation(plate)).toBe(5)
  })

  it('excludes parts that cannot reach', () => {
    const ids = relations.gapBridging(6).map((candidate) => candidate.id)
    expect(ids).not.toContain('3023b')
    expect(ids).not.toContain('3020')
    expect(relations.gapBridging(0)).toEqual([])
  })
})
