import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalog } from '../../cad/catalog'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { resetPartIntelligence, resolvePartIntent, resolvePartIntentSync, warmPartIntelligence } from './resolve'
import { resetSemanticIndex, residentSemanticIndex } from './semantic'

/**
 * The behaviour a caller is entitled to rely on: an identifier resolves to the
 * part it names, a size claim is checked rather than repeated, and the tier a
 * match reports is the truth about what this build can do with it.
 */

let disk: DiskFetch

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetPartIntelligence()
  resetSemanticIndex()
  await warmPartIntelligence()
}, 120_000)

afterAll(() => disk.restore())

const first = async (query: string) => (await resolvePartIntent(query, { limit: 5 })).matches[0]

describe('exact identifiers', () => {
  it('ranks every register of part number first', async () => {
    // One part, six ways of naming it. Each of these is a real number from the
    // compiled catalog rather than an invented one.
    const brick = catalog.get('3001')!
    expect(brick.identity.legoDesignIds).toContain('54534')
    expect(brick.identity.legoElementIds).toContain('4497066')

    expect((await first('3001'))?.canonicalId).toBe('3001')
    expect((await first('3001.dat'))?.canonicalId).toBe('3001')
    expect((await first('54534'))?.canonicalId).toBe('3001')
    expect((await first('4497066'))?.canonicalId).toBe('3001')
    expect((await first('the brick numbered 3001'))?.canonicalId).toBe('3001')
  })

  it('follows a retired LDraw number to the part it became', async () => {
    expect(catalog.isAlias('3023')).toBe(true)
    expect(catalog.resolveId('3023')).toBe('3023b')
    const match = await first('3023')
    expect(match?.canonicalId).toBe('3023b')
    expect(match?.explanation).toContain('Retired part number, now 3023b')
  })

  it('resolves a BrickLink number when the catalog carries one', async () => {
    // The 2026-07 compiler leaves `identity.bricklinkIds` empty for every part,
    // so this installs the real BrickLink numbers for two parts to exercise the
    // register. The limitation is recorded in docs/integration/part-intelligence.md.
    const payload = await installRealCatalog()
    const patched = payload.payload.parts.map((part) =>
      part.canonicalId === '3068b' || part.canonicalId === '3001'
        ? { ...part, identity: { ...part.identity, bricklinkIds: [part.canonicalId.toUpperCase()] } }
        : part,
    )
    catalog.install({ ...payload.payload, parts: patched })
    resetPartIntelligence()
    await warmPartIntelligence()
    try {
      const match = await first('3068B')
      expect(match?.canonicalId).toBe('3068b')
      expect(match?.signals.exactId).toBe(true)
    } finally {
      catalog.install(payload.payload)
      resetPartIntelligence()
      await warmPartIntelligence()
    }
  })

  it('reports the signal that fired, not a blanket score', async () => {
    const match = await first('3001')
    expect(match?.signals.exactId).toBe(true)
    expect(match?.confidence).toBeGreaterThan(0.5)
    expect(match?.explanation).toContain('3001')
  })
})

describe('honesty', () => {
  it('marks an identity this build cannot place as not placeable', async () => {
    // 41767 is modelled by LDraw and carries no compiled mesh in this pack.
    expect(catalog.describe('41767')?.geometryAvailable).toBe(false)
    const match = await first('41767')
    expect(match?.canonicalId).toBe('41767')
    expect(match?.tier).toBe('modelled')
    expect(match?.placeable).toBe(false)
    expect(match?.explanation).toContain('cannot be placed')
  })

  it('returns a catalogued-only identity as findable but not placeable', async () => {
    await installRealCatalog({ includeCatalogued: true })
    resetPartIntelligence()
    try {
      const result = await resolvePartIntent('sticker sheet', { limit: 8, includeCatalogued: true })
      const catalogued = result.matches.find((match) => match.tier === 'catalogued')
      expect(catalogued, 'no catalogued identity surfaced').toBeDefined()
      expect(catalogued!.placeable).toBe(false)
      expect(catalogued!.explanation).toContain('catalogued only')
    } finally {
      await installRealCatalog()
      resetPartIntelligence()
      await warmPartIntelligence()
    }
  }, 120_000)

  it('never promises placeability without compiled geometry', async () => {
    const result = await resolvePartIntent('brick', { limit: 25 })
    for (const match of result.matches) {
      const record = catalog.describe(match.canonicalId)!
      expect(match.placeable).toBe(record.geometryAvailable)
      expect(match.tier).toBe(record.tier)
    }
  })

  it('answers an unsatisfiable size with low confidence and names the condition', async () => {
    const result = await resolvePartIntent('a 40-stud transparent gear', { limit: 5 })
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches[0].confidence).toBeLessThan(0.35)
    expect(result.interpretation.unmatchedTerms).toContain('40 studs')
    expect(result.interpretation.dimensions).toEqual([40, 0, 0])
  })

  it('surfaces the interpretation it committed to', async () => {
    const result = await resolvePartIntent('a transparent hinge 2 x 4', { limit: 5 })
    expect(result.interpretation.dimensions).toEqual([2, 0, 4])
    expect(result.interpretation.colorName).toBe('transparent')
    expect(result.interpretation.connectorFamilies).toContain('hinge')
  })

  it('reports a word the catalog has never used', async () => {
    const result = await resolvePartIntent('a flurbulator bracket', { limit: 5 })
    expect(result.interpretation.unmatchedTerms).toContain('flurbulator')
  })
})

describe('synchronous resolution', () => {
  it('answers from the resident indexes without awaiting anything', () => {
    const result = resolvePartIntentSync('3001', { limit: 3 })
    expect(result.matches[0].canonicalId).toBe('3001')
    expect(result.elapsedMs).toBeLessThan(500)
  })

  it('degrades to the registry when nothing is resident, and says so', () => {
    resetPartIntelligence()
    resetSemanticIndex()
    try {
      const result = resolvePartIntentSync('brick 2 x 4', { limit: 3 })
      expect(result.matches[0].canonicalId).toBe('3001')
      expect(result.matches.some((match) => match.explanation.includes('semantic index not resident'))).toBe(true)
      expect(residentSemanticIndex()).toBeNull()
    } finally {
      resetPartIntelligence()
    }
  })
})

describe('performance', () => {
  it('answers a warm semantic query well inside the interaction budget', async () => {
    await warmPartIntelligence()
    await resolvePartIntent('warm up', { limit: 5 })

    const vocabulary = [
      'brick', 'plate', 'tile', 'slope', 'wedge', 'hinge', 'clip', 'bar', 'axle',
      'windscreen', 'panel', 'bracket', 'round', 'curved', 'technic', 'minifig',
      'door', 'window', 'wheel', 'cone',
    ]
    const shapes = ['1 x 2', '2 x 4', '1 x 4', '2 x 2', '6 studs wide', 'transparent', 'inverted', 'with a stud on the side']
    const queries: string[] = []
    for (const word of vocabulary) {
      for (const shape of shapes) queries.push(`${word} ${shape}`)
      queries.push(`something like a ${word} that clips onto a bar`)
      queries.push(`a ${word} in trans clear`)
    }
    expect(queries.length).toBeGreaterThanOrEqual(200)

    const timings: number[] = []
    for (const query of queries) {
      const started = performance.now()
      await resolvePartIntent(query, { limit: 8 })
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    const percentile = (p: number) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))]
    console.log(
      `\nwarm semantic query over ${queries.length} requests: ` +
        `p50 ${percentile(0.5).toFixed(1)} ms, p95 ${percentile(0.95).toFixed(1)} ms, ` +
        `max ${timings[timings.length - 1].toFixed(1)} ms`,
    )
    expect(percentile(0.95)).toBeLessThan(150)
  }, 300_000)
})
