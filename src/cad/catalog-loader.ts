import { catalog, type CatalogPayload } from './catalog'
import { verifyAsset, type IntegrityDescriptor } from './integrity'
import { GeometryCache, geometryCache } from './mesh'

/**
 * Loads the compiled catalog produced by `tools/catalog-compiler.mjs`.
 *
 * Brickwright deliberately has no procedural fallback catalog. If the compiled
 * assets are absent the application refuses to start rather than silently
 * substituting invented parts, because "is this a real LEGO part?" must always
 * have a defensible answer.
 */

export interface CatalogLoadResult {
  version: string
  identityCount: number
  placeableCount: number
  colorCount: number
  connectorCount: number
  aliasCount: number
  /** Catalogued-only identities available behind the lazy index. */
  externalIdentityCount: number
}

export class CatalogUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Compiled catalog assets are unavailable (${cause}). Run the catalog compiler first:\n` +
        '  node tools/catalog-compiler.mjs --ldraw <library> --shadow <LDCadShadowLibrary> ' +
        '--rebrickable <csv-dir> --out public --version <id>',
    )
    this.name = 'CatalogUnavailableError'
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

async function fetchVerifiedJson<T>(url: string, descriptor: IntegrityDescriptor): Promise<T> {
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  await verifyAsset(buffer, descriptor, url)
  return JSON.parse(new TextDecoder().decode(buffer)) as T
}

/**
 * Pointer, manifest, and the checks that make the rest of the load trustworthy.
 *
 * Shared by both entry points so the trust boundary is asserted once: the
 * pointer must bind its manifest to immutable bytes, the schema must be one this
 * build understands, and the manifest must identify the version the pointer
 * asked for.
 */
async function loadManifest(baseUrl: string): Promise<{
  root: string
  version: string
  manifest: CatalogPayload['manifest']
  assetUrl: (path: string) => string
}> {
  const root = baseUrl.replace(/\/$/, '')
  let pointer: { catalogVersion: string; manifest?: IntegrityDescriptor & { path: string } }
  try {
    // The pointer is intentionally the only non-immutable request.
    pointer = await fetchJson<typeof pointer>(`${root}/catalog/latest.json`)
  } catch (cause) {
    throw new CatalogUnavailableError(cause instanceof Error ? cause.message : String(cause))
  }

  const version = pointer.catalogVersion
  const assetUrl = (path: string) => `${root}/${path.replace(/^\/+/, '')}`
  if (!pointer.manifest) {
    throw new Error(`Catalog pointer ${version} does not bind its manifest to immutable bytes.`)
  }
  const manifest = await fetchVerifiedJson<CatalogPayload['manifest']>(assetUrl(pointer.manifest.path), pointer.manifest)
  if (manifest.schemaVersion !== 2) throw new Error(`Catalog ${version} uses unsupported schema ${manifest.schemaVersion}.`)
  if (manifest.catalogVersion !== version) {
    throw new Error(`Catalog pointer requested ${version}, but its manifest identifies ${manifest.catalogVersion}.`)
  }
  return { root, version, manifest, assetUrl }
}

/**
 * Everything needed to place, paint and export — and nothing else.
 *
 * The compiled catalog is two things wearing one name. `parts.json` is what a
 * model is made of: geometry, connectors, colour evidence, mass. `search.json`
 * is what the *library* contains: an identity record for every part LDraw
 * models, whether this build can place it or not. Only the first is on the path
 * to a painted frame, and the second is the larger half: 423 KiB gzipped and
 * ~24 ms of main-thread work — hash, decode, parse, and building the
 * 22,941-entry index — against 349 KiB and ~10 ms for the parts tier. Those
 * figures are measured and tabulated per asset in `src/platform/boot.ts`.
 *
 * So they load separately. `/editor` restores a document and paints its geometry
 * without ever touching the browse index; `/explore` awaits it, because a
 * surface whose job is to say whether a part is real may not answer from an
 * index that has not arrived. `src/platform/boot.ts` owns that distinction and
 * this is the seam it asks for.
 *
 * The count checks stay here rather than moving to whichever caller happens to
 * be first: a payload whose cardinality disagrees with its verified manifest is
 * a corrupt build, not a slow one.
 */
export async function loadPlaceableCatalog(baseUrl = ''): Promise<CatalogLoadResult> {
  const { root, version, manifest, assetUrl } = await loadManifest(baseUrl)

  const [parts, colors, aliases] = await Promise.all([
    fetchVerifiedJson<CatalogPayload['parts']>(assetUrl(manifest.files.parts.path), manifest.files.parts),
    fetchVerifiedJson<CatalogPayload['colors']>(assetUrl(manifest.files.colors.path), manifest.files.colors),
    fetchVerifiedJson<Record<string, string>>(assetUrl(manifest.files.aliases.path), manifest.files.aliases),
  ])

  const thumbnailCount = parts.filter((part) => Boolean(part.thumbnail)).length
  if (
    parts.length !== manifest.counts.packParts
    || colors.length !== manifest.counts.colors
    || Object.keys(aliases).length !== manifest.counts.aliases
    || (manifest.counts.thumbnails !== undefined && thumbnailCount !== manifest.counts.thumbnails)
  ) {
    throw new Error(`Catalog ${version} counts do not match its verified payloads.`)
  }

  catalog.install({ manifest, parts, colors, aliases })
  searchDescriptor = { root, version, descriptor: manifest.files.search, expected: manifest.counts.parts }
  searchLoad = null
  externalDescriptor = manifest.files.searchExternal
    ? { root, descriptor: manifest.files.searchExternal, expected: manifest.counts.externalIdentities ?? 0 }
    : null
  externalLoad = null

  return {
    version,
    identityCount: catalog.identityCount,
    placeableCount: catalog.placeableCount,
    colorCount: colors.length,
    connectorCount: manifest.counts.connectors,
    aliasCount: Object.keys(aliases).length,
    externalIdentityCount: manifest.counts.externalIdentities ?? 0,
  }
}

/**
 * The browse index, fetched and installed on top of the parts tier.
 *
 * Idempotent, and retryable rather than poisoned: a dropped connection must not
 * mean search is unavailable for the rest of the session. Same contract as
 * `loadExternalCatalogue`, one tier down.
 */
let searchDescriptor:
  | { root: string; version: string; descriptor: IntegrityDescriptor & { path: string }; expected: number }
  | null = null
let searchLoad: Promise<number> | null = null

export function loadSearchIndex(): Promise<number> {
  if (catalog.searchIndexLoaded) return Promise.resolve(catalog.identityCount)
  const source = searchDescriptor
  if (!source) {
    return Promise.reject(new Error('The browse index cannot be loaded before the parts tier is installed.'))
  }
  searchLoad ??= (async () => {
    const url = `${source.root}/${source.descriptor.path.replace(/^\/+/, '')}`
    const entries = await fetchVerifiedJson<NonNullable<CatalogPayload['search']>>(url, source.descriptor)
    if (entries.length !== source.expected) {
      throw new Error(`Catalog ${source.version} counts do not match its verified payloads.`)
    }
    catalog.installSearchIndex(entries)
    return catalog.identityCount
  })().catch((cause) => {
    searchLoad = null
    throw cause
  })
  return searchLoad
}

/**
 * Both tiers at once, for callers with no frame to paint.
 *
 * A refinement worker, the render benchmark and the share-dev entry all want the
 * whole catalog before they do anything, and `boot.ts` falls back to this when a
 * build's loader has not adopted the split. They already await every byte, so
 * the index is fetched after the parts tier rather than alongside it: one extra
 * round trip for a force-cached asset, against keeping one code path.
 */
export async function loadCompiledCatalog(baseUrl = ''): Promise<CatalogLoadResult> {
  const result = await loadPlaceableCatalog(baseUrl)
  // `loadSearchIndex` checks the index against `manifest.counts.parts`, which is
  // where `result.identityCount` already came from, so the number the caller
  // gets is the verified one either way.
  await loadSearchIndex()
  return result
}

/**
 * The wider LEGO catalogue, fetched the first time anybody asks for it.
 *
 * Seven megabytes of identity records is not something an editing session
 * should pay for on boot, and most sessions never leave the modelled library.
 * It is verified against the same manifest hash as every other payload, because
 * an index that decides whether a part is real cannot be allowed to arrive
 * unverified.
 */
let externalDescriptor: { root: string; descriptor: IntegrityDescriptor & { path: string }; expected: number } | null = null
let externalLoad: Promise<number> | null = null

export function externalCatalogueAvailable(): boolean {
  return externalDescriptor !== null
}

export function loadExternalCatalogue(): Promise<number> {
  if (catalog.catalogueLoaded) return Promise.resolve(catalog.totalIdentityCount)
  const source = externalDescriptor
  if (!source) return Promise.resolve(catalog.totalIdentityCount)
  externalLoad ??= (async () => {
    const url = `${source.root}/${source.descriptor.path.replace(/^\/+/, '')}`
    const entries = await fetchVerifiedJson<Parameters<typeof catalog.installExternalIndex>[0]>(url, source.descriptor)
    if (source.expected && entries.length !== source.expected) {
      throw new Error(`The wider catalogue index holds ${entries.length} identities, but its manifest declares ${source.expected}.`)
    }
    catalog.installExternalIndex(entries)
    return catalog.totalIdentityCount
  })().catch((cause) => {
    // A failed fetch must be retryable, not a permanently poisoned promise.
    externalLoad = null
    throw cause
  })
  return externalLoad
}

/** Warms geometry for the parts a document already references. */
export async function preloadDocumentGeometry(definitionIds: Iterable<string>, cache: GeometryCache = geometryCache) {
  const definitions = Array.from(new Set(definitionIds))
    .map((id) => catalog.get(id))
    .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
  await cache.preload(definitions)
}
