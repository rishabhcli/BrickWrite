/// <reference types="node" />
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { catalog, type CatalogPayload } from '../../../cad/catalog'

/**
 * Test support: installs the real compiled catalog and serves `public/` over a
 * stubbed `fetch`.
 *
 * The part resolver is a ranking system, and a ranking system tested against a
 * 59-part stub proves nothing about ranking - every query would have one
 * plausible answer. These tests therefore run against the same 22,941
 * identities, 900 compiled meshes, 322 colours and 1,150 renames the
 * application ships, read from `public/` on disk and handed to the production
 * code paths through the network seam they normally use.
 *
 * There is deliberately no synthetic fallback. If the compiled catalog is
 * absent the suite fails with the command that produces it, which is the same
 * stance `src/cad/catalog-loader.ts` takes at runtime.
 */

const PUBLIC_ROOT = path.resolve('public')

export interface RealCatalog {
  version: string
  payload: CatalogPayload
  externalCount: number
}

let cached: RealCatalog | null = null

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

/** Reads and installs `public/catalog/<latest>` into the registry singleton. */
export async function installRealCatalog(options: { includeCatalogued?: boolean } = {}): Promise<RealCatalog> {
  if (!existsSync(path.join(PUBLIC_ROOT, 'catalog', 'latest.json'))) {
    throw new Error(
      'public/catalog/latest.json is missing. Build the catalog first:\n' +
        '  npm run catalog:build   (or: node tools/catalog-compiler.mjs --ldraw <library> --out public --version <id>)',
    )
  }
  if (!cached) {
    const pointer = await readJson<{ catalogVersion: string }>(path.join(PUBLIC_ROOT, 'catalog', 'latest.json'))
    const base = path.join(PUBLIC_ROOT, 'catalog', pointer.catalogVersion)
    const [manifest, parts, search, colors, aliases] = await Promise.all([
      readJson<CatalogPayload['manifest']>(path.join(base, 'manifest.json')),
      readJson<CatalogPayload['parts']>(path.join(base, 'parts.json')),
      readJson<CatalogPayload['search']>(path.join(base, 'search.json')),
      readJson<CatalogPayload['colors']>(path.join(base, 'colors.json')),
      readJson<Record<string, string>>(path.join(base, 'aliases.json')),
    ])
    cached = {
      version: pointer.catalogVersion,
      payload: { manifest, parts, search, colors, aliases },
      externalCount: manifest.counts.externalIdentities ?? 0,
    }
  }

  catalog.install(cached.payload)
  if (options.includeCatalogued) {
    const base = path.join(PUBLIC_ROOT, 'catalog', cached.version)
    const external = await readJson<Parameters<typeof catalog.installExternalIndex>[0]>(
      path.join(base, 'search-external.json'),
    )
    catalog.installExternalIndex(external)
  }
  return cached
}

export interface DiskFetch {
  /** Every path requested since the stub was installed, in order. */
  readonly requests: string[]
  restore(): void
}

/**
 * Points `fetch` at `public/` on disk.
 *
 * The resolver reaches its assets through `fetch` with integrity descriptors
 * from the catalog manifest, and that is the path worth testing: a stub that
 * handed the parsed objects straight to the index would skip the digest checks
 * that make the index trustworthy in the first place.
 */
export function installDiskFetch(): DiskFetch {
  const original = globalThis.fetch
  const requests: string[] = []

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL((input as Request).url).pathname
    const pathname = raw.startsWith('http') ? new URL(raw).pathname : raw
    requests.push(pathname)
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    const file = path.join(PUBLIC_ROOT, pathname.replace(/^\/+/, ''))
    if (!existsSync(file)) return new Response(null, { status: 404, statusText: 'Not Found' })
    const bytes = await readFile(file)
    // Copied into a fresh ArrayBuffer: Node's file reads share one pooled
    // buffer, and handing that straight to a typed-array view would let one
    // asset alias another.
    const body = new Uint8Array(bytes.byteLength)
    body.set(bytes)
    return new Response(body, { status: 200 })
  }

  globalThis.fetch = stub as unknown as typeof fetch
  return {
    requests,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** True when the semantic index has been built for the installed catalog. */
export function semanticIndexBuilt(version: string): boolean {
  return existsSync(path.join(PUBLIC_ROOT, `semantic-index.${version}.bin`))
}

export const publicRoot = PUBLIC_ROOT
