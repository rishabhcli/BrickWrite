import { catalog, type CatalogPayload } from './catalog'
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

export async function loadCompiledCatalog(baseUrl = ''): Promise<CatalogLoadResult> {
  const root = baseUrl.replace(/\/$/, '')
  let version: string
  try {
    // The pointer is intentionally the only non-immutable request.
    const pointer = await fetchJson<{ catalogVersion: string }>(`${root}/catalog/latest.json`)
    version = pointer.catalogVersion
  } catch (cause) {
    throw new CatalogUnavailableError(cause instanceof Error ? cause.message : String(cause))
  }

  const prefix = `${root}/catalog/${version}`
  const [manifest, parts, search, colors, aliases] = await Promise.all([
    fetchJson<CatalogPayload['manifest']>(`${prefix}/manifest.json`),
    fetchJson<CatalogPayload['parts']>(`${prefix}/parts.json`),
    fetchJson<CatalogPayload['search']>(`${prefix}/search.json`),
    fetchJson<CatalogPayload['colors']>(`${prefix}/colors.json`),
    fetchJson<Record<string, string>>(`${prefix}/aliases.json`),
  ])

  catalog.install({ manifest, parts, search, colors, aliases })

  return {
    version,
    identityCount: catalog.identityCount,
    placeableCount: catalog.placeableCount,
    colorCount: colors.length,
    connectorCount: manifest.counts.connectors,
    aliasCount: Object.keys(aliases).length,
  }
}

/** Warms geometry for the parts a document already references. */
export async function preloadDocumentGeometry(definitionIds: Iterable<string>, cache: GeometryCache = geometryCache) {
  const definitions = Array.from(new Set(definitionIds))
    .map((id) => catalog.get(id))
    .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
  await cache.preload(definitions)
}
