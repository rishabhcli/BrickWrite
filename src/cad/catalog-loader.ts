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

export async function loadCompiledCatalog(baseUrl = ''): Promise<CatalogLoadResult> {
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

  const [parts, search, colors, aliases] = await Promise.all([
    fetchVerifiedJson<CatalogPayload['parts']>(assetUrl(manifest.files.parts.path), manifest.files.parts),
    fetchVerifiedJson<CatalogPayload['search']>(assetUrl(manifest.files.search.path), manifest.files.search),
    fetchVerifiedJson<CatalogPayload['colors']>(assetUrl(manifest.files.colors.path), manifest.files.colors),
    fetchVerifiedJson<Record<string, string>>(assetUrl(manifest.files.aliases.path), manifest.files.aliases),
  ])

  const thumbnailCount = parts.filter((part) => Boolean(part.thumbnail)).length
  if (
    parts.length !== manifest.counts.packParts
    || search.length !== manifest.counts.parts
    || colors.length !== manifest.counts.colors
    || Object.keys(aliases).length !== manifest.counts.aliases
    || (manifest.counts.thumbnails !== undefined && thumbnailCount !== manifest.counts.thumbnails)
  ) {
    throw new Error(`Catalog ${version} counts do not match its verified payloads.`)
  }

  catalog.install({ manifest, parts, search, colors, aliases })
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
