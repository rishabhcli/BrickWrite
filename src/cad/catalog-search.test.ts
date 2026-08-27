import { beforeEach, describe, expect, it } from 'vitest'
import fixture from './__fixtures__/catalog.fixture.json'
import { catalog, parseDimensionToken, searchCatalogPage, tokenize, type CatalogPayload } from './catalog'

/**
 * The catalogue is the product's factual base: a question about whether a part
 * exists has to be answered from an index, not from what this build happens to
 * be able to draw. These tests cover the three things that makes true —
 * ranking, tiering and paging — against the real compiled fixture slice.
 */

/** Reinstalls the fixture so an external index added by one test cannot leak. */
beforeEach(() => catalog.install(fixture as unknown as CatalogPayload))

const ids = (text: string, extra: Parameters<typeof searchCatalogPage>[0] = {}) =>
  searchCatalogPage({ text, limit: 8, ...extra }).records.map((record) => record.id)

describe('query parsing', () => {
  it('folds a spaced dimension into the single token a person means by it', () => {
    // "2 x 4" used to tokenize into a bare `x` that matched most of the library.
    expect(tokenize('2 x 4 brick')).toEqual(['2x4', 'brick'])
    expect(tokenize('brick 2x4')).toEqual(['brick', '2x4'])
    expect(tokenize('1 x 2 x 5')).toEqual(['1x2x5'])
    expect(tokenize('   ')).toEqual([])
  })

  it('reads two- and three-number dimension tokens, and nothing else', () => {
    expect(parseDimensionToken('2x4')).toEqual([2, 4])
    expect(parseDimensionToken('1x2x5')).toEqual([1, 2, 5])
    expect(parseDimensionToken('3001')).toBeNull()
    expect(parseDimensionToken('brick')).toBeNull()
  })
})

describe('ranking', () => {
  it('puts an exact part number first', () => {
    expect(ids('3001')[0]).toBe('3001')
    expect(ids('3005')[0]).toBe('3005')
  })

  it('follows a retired number to its replacement', () => {
    // LDraw leaves the old number behind as an alias; a person who types it
    // means the part it became.
    const retired = Object.keys((fixture as unknown as CatalogPayload).aliases ?? {})[0]
    expect(retired).toBeTruthy()
    const replacement = catalog.resolveId(retired)
    expect(replacement).not.toBe(retired)
    expect(ids(retired)).toContain(replacement)
  })

  it('matches a measured envelope in either orientation', () => {
    // A 2 x 4 and a 4 x 2 are the same brick held differently.
    expect(ids('2x4 brick')).toContain('3001')
    expect(ids('4x2 brick')).toContain('3001')
  })

  it('ranks the measured part above one that merely mentions the numbers', () => {
    const results = searchCatalogPage({ text: '1x2', limit: 20 }).records
    const measured = results.findIndex((record) => record.dimensions?.[0] === 2 && record.dimensions?.[2] === 1)
    expect(measured).toBe(0)
  })

  it('narrows rather than widens as tokens are added', () => {
    const broad = searchCatalogPage({ text: 'brick', limit: 200 }).total
    const narrow = searchCatalogPage({ text: 'brick 2x4', limit: 200 }).total
    expect(narrow).toBeGreaterThan(0)
    expect(narrow).toBeLessThan(broad)
  })

  it('prefers the part that actually turns up in sets among equal matches', () => {
    const results = searchCatalogPage({ text: 'brick', limit: 30 }).records
    const frequencies = results.map((record) => record.frequency)
    // Not a strict ordering — text precision outranks popularity — but the most
    // common brick must not be buried behind an obscure one.
    expect(Math.max(...frequencies)).toBe(frequencies[0])
  })

  it('reports no match rather than a guess', () => {
    expect(searchCatalogPage({ text: 'zzzznotathing' }).total).toBe(0)
  })
})

describe('tiers', () => {
  const EXTERNAL = [
    { id: '973pr0001', n: 'Torso Space Classic with Logo Print', c: 'Minifig Upper Body', f: 412, p: '973' },
    { id: '3626cpr0002', n: 'Minifig Head with Standard Grin Print', c: 'Minifig Heads', f: 980, p: '3626c' },
    { id: 'stickerX', n: 'Sticker Sheet for Set 928-1', c: 'Stickers', f: 1, m: 'Paper' },
  ]

  it('reports every identity with the tier that says what is known about it', () => {
    catalog.installExternalIndex(EXTERNAL)
    const page = searchCatalogPage({ text: 'minifig head', tier: 'all', limit: 10 })
    const head = page.records.find((record) => record.id === '3626cpr0002')
    expect(head).toBeDefined()
    expect(head!.tier).toBe('catalogued')
    expect(head!.geometryAvailable).toBe(false)
    expect(head!.variantOf).toBe('3626c')

    const brick = searchCatalogPage({ text: '3001', tier: 'all' }).records[0]
    expect(brick.tier).toBe('placeable')
  })

  it('keeps a tier filter from hiding the counts in the other tiers', () => {
    catalog.installExternalIndex(EXTERNAL)
    const page = searchCatalogPage({ text: 'sticker', tier: 'placeable', limit: 10 })
    expect(page.records).toHaveLength(0)
    // The facet still says the identity exists — which is the difference
    // between "not buildable here" and "not a real part".
    expect(page.tiers.catalogued).toBe(1)
  })

  it('defaults to every loaded tier, so existence questions are not answered from the pack', () => {
    catalog.installExternalIndex(EXTERNAL)
    expect(ids('sticker sheet')).toContain('stickerX')
    expect(ids('sticker sheet', { tier: 'placeable' })).not.toContain('stickerX')
  })

  it('says the wider catalogue is pending rather than reporting zero as a fact', () => {
    expect(searchCatalogPage({ text: 'sticker' }).cataloguePending).toBe(
      catalog.externalIdentityCount > 0,
    )
    catalog.installExternalIndex(EXTERNAL)
    expect(searchCatalogPage({ text: 'sticker' }).cataloguePending).toBe(false)
  })

  it('is idempotent, so a repeated install cannot duplicate an identity', () => {
    catalog.installExternalIndex(EXTERNAL)
    const once = catalog.totalIdentityCount
    catalog.installExternalIndex(EXTERNAL)
    expect(catalog.totalIdentityCount).toBe(once)
    expect(searchCatalogPage({ text: 'stickerX', tier: 'all' }).total).toBe(1)
  })

  it('never lets the wider catalogue shadow a modelled identity', () => {
    catalog.installExternalIndex([{ id: '3001', n: 'Impostor 2 x 4', c: 'Bricks', f: 999999 }])
    const page = searchCatalogPage({ text: '3001', tier: 'all' })
    expect(page.total).toBe(1)
    expect(page.records[0].name).toBe('Brick 2 x 4')
    expect(page.records[0].tier).toBe('placeable')
  })
})

describe('paging', () => {
  it('reports the whole match set, not the size of the page', () => {
    const page = searchCatalogPage({ text: 'brick', limit: 3 })
    expect(page.records).toHaveLength(3)
    expect(page.total).toBeGreaterThan(3)
  })

  it('walks a stable, non-overlapping sequence of pages', () => {
    const first = searchCatalogPage({ text: 'brick', limit: 4, offset: 0 }).records.map((r) => r.id)
    const second = searchCatalogPage({ text: 'brick', limit: 4, offset: 4 }).records.map((r) => r.id)
    expect(first).toHaveLength(4)
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length)
    // Re-reading the first page gives the same rows: ordering is deterministic.
    expect(searchCatalogPage({ text: 'brick', limit: 4, offset: 0 }).records.map((r) => r.id)).toEqual(first)
  })

  it('returns an empty page past the end rather than wrapping', () => {
    const total = searchCatalogPage({ text: 'brick', limit: 200 }).total
    expect(searchCatalogPage({ text: 'brick', limit: 4, offset: total + 10 }).records).toHaveLength(0)
  })
})

describe('index accounting', () => {
  it('counts modelled and catalogued identities separately', () => {
    const modelled = catalog.identityCount
    catalog.installExternalIndex([{ id: 'novel-1', n: 'Novel part', c: 'Other', f: 0 }])
    expect(catalog.identityCount).toBe(modelled)
    expect(catalog.totalIdentityCount).toBe(modelled + 1)
  })
})
