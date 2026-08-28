import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import {
  analyze,
  loadSemanticIndex,
  normalizeText,
  resetSemanticIndex,
  residentSemanticManifest,
  SemanticIndex,
  SemanticIndexError,
} from './semantic'

/**
 * The latent index is a real vector index, and these are the properties that
 * make that claim checkable: the container decodes to the shape its manifest
 * declares, the analyzer here agrees with the analyzer that built it, and a
 * query lands nearer to parts that mean the same thing than to parts that
 * merely share letters.
 */

let disk: DiskFetch
let index: SemanticIndex

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetSemanticIndex()
  index = await loadSemanticIndex()
}, 120_000)

afterAll(() => disk.restore())

describe('analyzer', () => {
  it('folds LDraw punctuation away before producing features', () => {
    expect(normalizeText('Windscreen  3 x  4 x  1.333')).toBe('windscreen 3 x 4 x 1 333')
    expect(normalizeText('Brick Sloped 45° 2 x 2')).toBe('brick sloped 45 2 x 2')
  })

  it('produces word unigrams and in-word trigrams, and nothing across words', () => {
    const features = analyze('clip bar')
    expect(features.get('w:clip')).toBe(1)
    expect(features.get('w:bar')).toBe(1)
    expect(features.get('c:cli')).toBe(0.5)
    expect(features.get('c:lip')).toBe(0.5)
    // "pba" would span the space between the two words.
    expect(features.has('c:pba')).toBe(false)
  })
})

describe('container', () => {
  it('decodes to the shape its manifest declares', () => {
    const manifest = residentSemanticManifest()!
    expect(manifest.schemaVersion).toBe(1)
    expect(index.dims).toBe(manifest.dims)
    expect(index.vocabSize).toBe(manifest.vocabSize)
    expect(index.docCount).toBe(manifest.docCount)
    expect(index.docCount).toBeGreaterThan(20000)
  })

  it('refuses bytes that are not a semantic index', () => {
    const buffer = new ArrayBuffer(128)
    new DataView(buffer).setUint32(0, 0xdeadbeef, true)
    expect(() => SemanticIndex.decode(buffer)).toThrow(SemanticIndexError)
  })

  it('refuses a truncated container', () => {
    expect(() => SemanticIndex.decode(new ArrayBuffer(16))).toThrow(/Truncated/)
  })

  it('refuses an index whose analyzer disagrees with this build', async () => {
    const response = await fetch(`/${residentSemanticManifest()!.file}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    // Flip the recorded probe hash: the decoder must treat a disagreement about
    // how text becomes features as fatal, not as a ranking quirk.
    new DataView(bytes.buffer).setUint32(36, 12345, true)
    expect(() => SemanticIndex.decode(bytes.buffer)).toThrow(/analyzer mismatch/)
  })
})

describe('retrieval', () => {
  it('places a query nearer to parts that mean the same thing', () => {
    const query = index.query('sloped roof piece')!
    expect(query).not.toBeNull()
    const top = query.top(10).map((hit) => hit.id)
    // Every one of these is a Brick Sloped in the compiled catalog.
    expect(top.length).toBe(10)
    expect(query.similarity('3037')).toBeGreaterThan(0.6)
    // A tile has nothing to do with a roof slope.
    expect(query.similarity('3037')).toBeGreaterThan(query.similarity('3069b'))
  })

  it('reaches a part whose name shares no whole word with the request', () => {
    const query = index.query('windscreens')!
    // Character trigrams carry "windscreens" to "Windscreen" without an exact
    // word match, which is the point of keeping them in the vocabulary.
    expect(query.similarity('2437')).toBeGreaterThan(0.4)
  })

  it('returns similarities in descending order', () => {
    const hits = index.query('technic axle')!.top(20)
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1].similarity).toBeGreaterThanOrEqual(hits[i].similarity)
    }
  })

  it('says nothing rather than zero when the request has no known features', () => {
    expect(index.query('')).toBeNull()
    expect(index.query('zzzzq')).toBeNull()
  })

  it('reports how much of the request the vocabulary recognised', () => {
    expect(index.query('brick')!.coverage).toBeGreaterThan(0.8)
    expect(index.query('brick zzzzq')!.coverage).toBeLessThan(1)
  })
})

describe('loading', () => {
  it('decodes once and serves the resident index afterwards', async () => {
    const before = disk.requests.filter((request) => request.includes('semantic-index')).length
    const again = await loadSemanticIndex()
    expect(again).toBe(index)
    expect(disk.requests.filter((request) => request.includes('semantic-index'))).toHaveLength(before)
  })

  it('explains how to build the index when it is missing', async () => {
    resetSemanticIndex()
    try {
      await expect(loadSemanticIndex({ version: 'no-such-version' })).rejects.toThrow(/tools\/semantic-index\.mjs/)
    } finally {
      resetSemanticIndex()
      index = await loadSemanticIndex()
    }
  })
})
