import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogManifest } from './catalog'
import { loadCompiledCatalog } from './catalog-loader'
import { sha256Hex, type IntegrityDescriptor } from './integrity'

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
