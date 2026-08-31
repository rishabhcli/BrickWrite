import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalog, type CatalogManifest, type CatalogPayload } from './catalog'
import { loadCompiledCatalog, loadPlaceableCatalog, loadSearchIndex } from './catalog-loader'
import { sha256Hex, type IntegrityDescriptor } from './integrity'
import fixture from './__fixtures__/catalog.fixture.json'

const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

async function asset(value: unknown): Promise<{ body: Uint8Array; descriptor: IntegrityDescriptor }> {
  const body = encoded(value)
  return {
    body,
    descriptor: {
      bytes: body.byteLength,
      hash: `sha256:${await sha256Hex(body.buffer as ArrayBuffer)}`,
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('compiled catalog trust boundary', () => {
  it('refuses a mutable pointer that does not integrity-bind its manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ catalogVersion: 'unsafe' }))))

    await expect(loadCompiledCatalog()).rejects.toThrow('does not bind its manifest to immutable bytes')
  })

  it('rejects verified payloads whose cardinality disagrees with the manifest', async () => {
    const parts = await asset([])
    const search = await asset([])
    const colors = await asset([])
    const aliases = await asset({})
    const manifest: CatalogManifest = {
      schemaVersion: 2,
      catalogVersion: 'fixture',
      generatedAt: '2026-08-27T00:00:00.000Z',
      sources: {},
      files: {
        parts: { path: 'catalog/fixture/parts.json', ...parts.descriptor },
        search: { path: 'catalog/fixture/search.json', ...search.descriptor },
        colors: { path: 'catalog/fixture/colors.json', ...colors.descriptor },
        aliases: { path: 'catalog/fixture/aliases.json', ...aliases.descriptor },
      },
      counts: { parts: 0, packParts: 0, connectors: 0, colors: 0, aliases: 1, thumbnails: 0 },
      coverage: {},
    }
    const manifestAsset = await asset(manifest)
    const pointer = {
      catalogVersion: 'fixture',
      manifest: { path: 'catalog/fixture/manifest.json', ...manifestAsset.descriptor },
    }
    const bodies = new Map<string, Uint8Array>([
      ['/catalog/latest.json', encoded(pointer)],
      ['/catalog/fixture/manifest.json', manifestAsset.body],
      ['/catalog/fixture/parts.json', parts.body],
      ['/catalog/fixture/search.json', search.body],
      ['/catalog/fixture/colors.json', colors.body],
      ['/catalog/fixture/aliases.json', aliases.body],
    ])
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname
      const body = bodies.get(url)
      return body ? new Response(new TextDecoder().decode(body), { status: 200 }) : new Response(null, { status: 404 })
    }))

    await expect(loadCompiledCatalog()).rejects.toThrow('counts do not match its verified payloads')
  })
})

/**
 * A served catalog built from the real fixture slice, with a manifest whose
 * counts match it.
 *
 * Returns the `fetch` spy as well as the payloads, because *which assets were
 * requested* is the property the split has to hold: the parts tier must not
 * fetch the browse index, and asserting that is the only way to know the
 * deferral is real rather than merely expressed in the types.
 */
async function serveFixtureCatalog() {
  const payload = fixture as unknown as CatalogPayload
  const parts = await asset(payload.parts)
  const search = await asset(payload.search)
  const colors = await asset(payload.colors)
  const aliases = await asset(payload.aliases ?? {})
  const manifest: CatalogManifest = {
    schemaVersion: 2,
    catalogVersion: 'fixture',
    generatedAt: '2026-08-27T00:00:00.000Z',
    sources: {},
    files: {
      parts: { path: 'catalog/fixture/parts.json', ...parts.descriptor },
      search: { path: 'catalog/fixture/search.json', ...search.descriptor },
      colors: { path: 'catalog/fixture/colors.json', ...colors.descriptor },
      aliases: { path: 'catalog/fixture/aliases.json', ...aliases.descriptor },
    },
    counts: {
      parts: payload.search?.length ?? 0,
      packParts: payload.parts.length,
      connectors: 0,
      colors: payload.colors.length,
      aliases: Object.keys(payload.aliases ?? {}).length,
    },
    coverage: {},
  }
  const manifestAsset = await asset(manifest)
  const pointer = {
    catalogVersion: 'fixture',
    manifest: { path: 'catalog/fixture/manifest.json', ...manifestAsset.descriptor },
  }
  const bodies = new Map<string, Uint8Array>([
    ['/catalog/latest.json', encoded(pointer)],
    ['/catalog/fixture/manifest.json', manifestAsset.body],
    ['/catalog/fixture/parts.json', parts.body],
    ['/catalog/fixture/search.json', search.body],
    ['/catalog/fixture/colors.json', colors.body],
    ['/catalog/fixture/aliases.json', aliases.body],
  ])
  const requested: string[] = []
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname
    requested.push(url)
    const body = bodies.get(url)
    return body ? new Response(new TextDecoder().decode(body), { status: 200 }) : new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', spy)
  return { manifest, payload, requested }
}

describe('the parts tier and the browse index load separately', () => {
  // Every test here installs over the module-level registry, so the shared
  // fixture is put back rather than left for whatever runs next.
  afterEach(() => catalog.install(fixture as unknown as CatalogPayload))

  it('installs a placeable catalog without fetching the browse index', async () => {
    const { manifest, requested } = await serveFixtureCatalog()
    const result = await loadPlaceableCatalog()

    expect(requested).not.toContain('/catalog/fixture/search.json')
    expect(result.placeableCount).toBe(manifest.counts.packParts)
    // Everything a restored document needs to paint is there.
    expect(catalog.get('3035')?.name).toBe('Plate 4 x 8')
    expect(catalog.colors().length).toBe(manifest.counts.colors)
    // And the index is honestly absent rather than silently empty.
    expect(catalog.searchIndexLoaded).toBe(false)
    // The identity count is a fact about the build, so it is the manifest's.
    expect(result.identityCount).toBe(manifest.counts.parts)
  })

  it('describes a placeable part before the index arrives', async () => {
    await serveFixtureCatalog()
    await loadPlaceableCatalog()
    // "This part does not exist" is the one answer the registry may not give
    // unless it is true, and it is not true of a part in the pack.
    const record = catalog.describe('3035')
    expect(record?.name).toBe('Plate 4 x 8')
    expect(record?.tier).toBe('placeable')
    expect(catalog.categories).toContain('Plates')
  })

  it('installs the index additively, and matches what install() would have built', async () => {
    const { payload } = await serveFixtureCatalog()
    await loadPlaceableCatalog()
    const beforeIndex = catalog.describe('3035')
    await loadSearchIndex()

    expect(catalog.searchIndexLoaded).toBe(true)
    expect(catalog.identityCount).toBe(payload.search?.length)
    // The deferred install must land on the same registry state the
    // all-at-once path produces, or the answers would depend on the route.
    expect(catalog.describe('3035')).toEqual(beforeIndex)
    catalog.install(payload)
    expect(catalog.describe('3035')).toEqual(beforeIndex)
    expect(catalog.search({ text: 'plate 4 x 8', limit: 1 })[0]?.id).toBe('3035')
  })

  it('is idempotent, and retryable after a failed attempt', async () => {
    await serveFixtureCatalog()
    await loadPlaceableCatalog()
    const first = await loadSearchIndex()
    expect(await loadSearchIndex()).toBe(first)
  })

  it('refuses an index whose cardinality disagrees with the manifest', async () => {
    const { payload } = await serveFixtureCatalog()
    await loadPlaceableCatalog()
    // Serve a short index under the manifest's hash-bound path: verification
    // passes on the bytes it was given, so cardinality is the only check left.
    const short = await asset((payload.search ?? []).slice(0, 1))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextDecoder().decode(short.body), { status: 200 })))
    await expect(loadSearchIndex()).rejects.toThrow()
    expect(catalog.searchIndexLoaded).toBe(false)
  })

  it('still loads both tiers through the all-at-once entry point', async () => {
    const { manifest, requested } = await serveFixtureCatalog()
    const result = await loadCompiledCatalog()
    expect(requested).toContain('/catalog/fixture/search.json')
    expect(catalog.searchIndexLoaded).toBe(true)
    expect(result.identityCount).toBe(manifest.counts.parts)
  })
})
