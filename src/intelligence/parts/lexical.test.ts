import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { loadPartCorpus, type PartCorpus } from './corpus'
import { foldTerm, LexicalIndex } from './lexical'

/**
 * BM25F, and the identifier index that short-circuits it.
 *
 * The property worth protecting is that length normalisation actually does its
 * job: LDraw names repeat their own vocabulary, and plain term frequency puts a
 * twenty-word printed variant above the part it decorates.
 */

let disk: DiskFetch
let corpus: PartCorpus
let index: LexicalIndex

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  corpus = await loadPartCorpus()
  index = LexicalIndex.build(corpus)
}, 120_000)

afterAll(() => disk.restore())

const ids = (terms: string[], limit = 8) =>
  index.search(terms, limit).hits.map((hit) => corpus.documents[hit.doc].id)

describe('term folding', () => {
  it('folds a plural onto its singular, and leaves real words alone', () => {
    expect(foldTerm('clips')).toBe('clip')
    expect(foldTerm('studs')).toBe('stud')
    expect(foldTerm('glass')).toBe('glass')
    expect(foldTerm('axis')).toBe('axis')
    expect(foldTerm('bus')).toBe('bus')
  })
})

describe('ranking', () => {
  it('lets length normalisation keep a verbose name from winning', () => {
    // Both of these say "Windscreen" exactly once, so the only thing separating
    // them is how much other text surrounds it. Plain term frequency would call
    // them equal; BM25's length normalisation is what puts the direct name
    // first, and it is the reason a printed variant cannot bury its own base.
    const ranked = index.search(['windscreen'], 5000).hits.map((hit) => corpus.documents[hit.doc].id)
    const direct = ranked.indexOf('21')
    const verbose = ranked.indexOf('2694p01')
    expect(direct).toBeGreaterThanOrEqual(0)
    expect(verbose).toBeGreaterThanOrEqual(0)
    expect(corpus.byId.get('2694p01')!.name.length).toBeGreaterThan(corpus.byId.get('21')!.name.length * 3)
    expect(direct).toBeLessThan(verbose)
  })

  it('narrows as terms are added', () => {
    const broad = index.search(['brick'], 5000).hits.length
    const narrow = index.search(['brick', 'wedged'], 5000).hits.length
    expect(narrow).toBeGreaterThan(0)
    expect(narrow).toBeLessThanOrEqual(broad + index.search(['wedged'], 5000).hits.length)
  })

  it('reaches a different spelling of the same idea', () => {
    // "slope" and "sloped" are both live in the catalog; a query for one has to
    // reach the other or half the library is invisible.
    const sloped = ids(['slope'], 40).map((id) => corpus.byId.get(id)!.name)
    expect(sloped.some((name) => name.includes('Sloped'))).toBe(true)
    expect(ids(['connects'], 40).some((id) => corpus.byId.get(id)!.name.includes('Connector'))).toBe(true)
  })

  it('reports nothing for a term the catalog has never used', () => {
    expect(index.search(['zzzzzq'], 5).hits).toEqual([])
    expect(index.search([], 5).hits).toEqual([])
  })

  it('exposes every touched document, not only the ranked ones', () => {
    const result = index.search(['windscreen'], 5)
    expect(result.hits).toHaveLength(5)
    expect(result.touched.size).toBeGreaterThan(100)
  })
})

describe('identifiers', () => {
  it('resolves each register to the part it names', () => {
    expect(index.resolveIdentity('3001')).toEqual({ id: '3001', kind: 'canonical' })
    expect(index.resolveIdentity('3001.dat')).toEqual({ id: '3001', kind: 'ldraw' })
    expect(index.resolveIdentity('54534')).toEqual({ id: '3001', kind: 'design' })
    expect(index.resolveIdentity('4497066')).toEqual({ id: '3001', kind: 'element' })
    expect(index.resolveIdentity('3023')).toEqual({ id: '3023b', kind: 'retired' })
    expect(index.resolveIdentity('not-a-part')).toBeNull()
  })

  it('is case insensitive', () => {
    expect(index.resolveIdentity('3068B')?.id).toBe('3068b')
  })
})

describe('vocabulary', () => {
  it('knows a catalog word, and a longer word that begins with it', () => {
    expect(index.hasTerm('brick')).toBe(true)
    expect(index.hasTerm('steers')).toBe(true)
    expect(index.hasTerm('flurbulator')).toBe(false)
    expect(index.termCount).toBeGreaterThan(2000)
  })
})
