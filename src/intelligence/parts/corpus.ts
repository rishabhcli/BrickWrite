import { catalog } from '../../cad/catalog'
import { verifyAsset } from '../../cad/integrity'
import type {
  CatalogSearchRecord,
  CatalogTier,
  ConnectionFamily,
  ConnectionFeature,
  GeometryStatus,
  PartBoundsLdu,
  PartDefinition,
  Vec3,
} from '../../cad/types'

/**
 * The document set every part-intelligence signal is computed over.
 *
 * `CatalogRegistry` deliberately exposes ranked search rather than an
 * enumerator — the editor never needs to walk 82,000 identities — but BM25, a
 * latent-semantic projection and the derived relation tables all do. Rather
 * than paging the registry's ranked search 160 times, the corpus reads the same
 * immutable, hash-verified payloads the registry itself was installed from and
 * folds in the richer pack definitions on top.
 *
 * The payloads are content-addressed and were already fetched at boot, so a
 * warm HTTP cache serves them without a network round trip; the digest from the
 * registry's own manifest is re-checked regardless, because an index that
 * decides what a part *is* cannot accept unverified bytes.
 */

/** Raw wire shape of `catalog/<version>/search.json`. */
interface RawSearchEntry {
  id: string
  n: string
  c: string
  d: Vec3 | null
  f: number
  k: ConnectionFamily[]
  g: 0 | 1
  s: 0 | 1
  h?: 1
}

/** Raw wire shape of `catalog/<version>/search-external.json`. */
interface RawExternalEntry {
  id: string
  n: string
  c: string
  f: number
  p?: string
  m?: string
}

/** Counts of `${family}/${gender}` on a part, which is its mating interface. */
export type ConnectorProfile = ReadonlyMap<string, number>

/**
 * A connector's family together with the direction its axis points.
 *
 * By LDCad convention a connector's axis is its own frame's local +Y, so the
 * axis in the part's frame is the second column of the orientation matrix, or
 * straight up when no matrix was recorded. Keeping it is what lets "a hinge
 * whose axis points sideways" be answered by measurement instead of by hoping
 * the part name mentions it.
 */
export interface ConnectorAxis {
  family: ConnectionFamily
  axis: Vec3
}

/** The connector axis in the part's own LDraw frame. */
export function connectorAxis(feature: ConnectionFeature): Vec3 {
  const ori = feature.ori
  // Row-major 3x3: the local +Y image is the middle column, entries 1, 4 and 7.
  return ori ? [ori[1], ori[4], ori[7]] : [0, 1, 0]
}

/**
 * Alternate numbers, kept apart by where they came from.
 *
 * Flattening them into one list would be smaller but would lose the only thing
 * that makes a collision resolvable: an element number and a design number can
 * be the same digits, and the answer to "which part is 4497066" depends on
 * knowing which register the number belongs to.
 */
export interface DocumentIdentity {
  /** LDraw file name, e.g. "3001.dat". */
  ldraw: string | null
  rebrickable: string | null
  design: readonly string[]
  element: readonly string[]
  bricklink: readonly string[]
}

const EMPTY_IDENTITY: DocumentIdentity = { ldraw: null, rebrickable: null, design: [], element: [], bricklink: [] }

/** Every alternate number as flat text, for the BM25 identifier field. */
export function identityTokens(identity: DocumentIdentity): string[] {
  return Array.from(
    new Set(
      [identity.ldraw ?? '', identity.ldraw?.replace(/\.dat$/i, '') ?? '', identity.rebrickable ?? '']
        .concat(identity.design, identity.element, identity.bricklink)
        .filter(Boolean),
    ),
  )
}

export interface CorpusDocument {
  id: string
  name: string
  category: string
  tier: CatalogTier
  frequency: number
  /** Measured envelope in studs; null for the ~96% of identities with no compiled mesh. */
  studs: Vec3 | null
  /**
   * Sizes read out of the part name, e.g. "Windscreen 6 x 4 x 1 1/3".
   *
   * Almost every identity in the catalog lacks compiled geometry, so without
   * this a dimensional question could only be answered for 900 of 22,941 parts.
   * It is weaker evidence than a measurement and is scored that way.
   */
  nameStuds: number[] | null
  families: readonly ConnectionFamily[]
  geometryAvailable: boolean
  helper: boolean
  /** Base design this identity decorates, for a printed or moulded variant. */
  variantOf: string | null
  /** LDraw kind ("Part", "Shortcut"); known only for pack identities. */
  kind: string | null
  /** Every alternate number this identity answers to, kept typed by source. */
  identity: DocumentIdentity
  /** Mating interface; null when the part is outside the compiled pack. */
  connectors: ConnectorProfile | null
  /** Positions of the part's anti-studs in LDU, for gap-bridging analysis. */
  antiStudsLdu: readonly Vec3[] | null
  /** Axis direction per connector, for orientation questions. Pack identities only. */
  connectorAxes: readonly ConnectorAxis[] | null
  /**
   * Measured extent in the part's own LDraw frame.
   *
   * Handedness is decided against this rather than against the name alone: two
   * parts are genuine mirror counterparts when one box is the other reflected
   * through x, which a name comparison can only guess at.
   */
  boundsLdu: PartBoundsLdu | null
  /** LDraw colour codes with an observed official-set appearance. */
  colors: readonly number[] | null
  geometryStatus: GeometryStatus | null
  /** Text BM25 and the semantic analyzer both read. */
  text: string
}

export interface PartCorpus {
  catalogVersion: string
  documents: readonly CorpusDocument[]
  byId: ReadonlyMap<string, CorpusDocument>
  /**
   * Footprint key to document indices, so a stated size is a retrieval stage
   * rather than only a re-ranking one.
   *
   * Without it, "a 1 x 2 x 5 brick" can only be answered from whatever the
   * word "brick" happened to retrieve, and the part that actually measures
   * 1 x 2 x 5 never enters the candidate set to be scored.
   */
  byFootprint: ReadonlyMap<string, readonly number[]>
  /** True when the wider catalogued tier was folded in. */
  includesCatalogued: boolean
}

/** Order-insensitive footprint key: a 2 x 4 and a 4 x 2 are one shape. */
export function footprintKey(a: number, b: number): string {
  const low = Math.min(a, b)
  const high = Math.max(a, b)
  return `${Math.round(low * 2) / 2}x${Math.round(high * 2) / 2}`
}

export interface CorpusLoadOptions {
  /** Root the compiled catalog is served from; matches `loadCompiledCatalog`. */
  baseUrl?: string
  /**
   * Fold in the 58,833 catalogue-only identities. Off by default: they add
   * seven megabytes and no geometry, and an editing session that asks "what
   * should I place here" never wants them.
   */
  includeCatalogued?: boolean
  signal?: AbortSignal
}

export class CorpusUnavailableError extends Error {
  constructor(detail: string) {
    super(`The part-intelligence corpus cannot be built (${detail}).`)
    this.name = 'CorpusUnavailableError'
  }
}

/**
 * A mixed number as LDraw writes it: "1 1/3", "2/3", "1.667" or "4".
 *
 * Returns null rather than NaN so a caller cannot accidentally propagate a
 * non-number into a comparison that would silently succeed.
 */
export function parseMixedNumber(text: string): number | null {
  const trimmed = text.trim()
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(trimmed)
  if (mixed) {
    const denominator = Number(mixed[3])
    return denominator === 0 ? null : Number(mixed[1]) + Number(mixed[2]) / denominator
  }
  const fraction = /^(\d+)\/(\d+)$/.exec(trimmed)
  if (fraction) {
    const denominator = Number(fraction[2])
    return denominator === 0 ? null : Number(fraction[1]) / denominator
  }
  const plain = /^\d+(?:\.\d+)?$/.exec(trimmed)
  return plain ? Number(trimmed) : null
}

const NUMBER_PATTERN = String.raw`\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+`
const NAME_DIMENSION = new RegExp(
  String.raw`(?:^|[^\w/.])(${NUMBER_PATTERN})\s*[x×]\s*(${NUMBER_PATTERN})(?:\s*[x×]\s*(${NUMBER_PATTERN}))?`,
  'i',
)

/**
 * Reads the "6 x 4 x 1 1/3" a part name states about its own size.
 *
 * Bounded on both ends deliberately: a tyre named "10/130 x 17" is quoting a
 * rubber profile, not studs, and nothing in the LEGO catalogue is 64 studs
 * across, so values outside [0.25, 64] are rejected rather than indexed as if
 * they described a footprint.
 */
/**
 * Names whose numbers are millimetres, not studs.
 *
 * LDraw quotes wheel and tyre sizes as real-world diameters - "Tyre 30.4 x 14",
 * "Wheel 18 x 14" - so reading them as a footprint makes a road tyre look like
 * an eighteen-stud part and lets an impossible size request find a match.
 */
const MILLIMETRE_NAMES = /^(?:tyre|tire|wheel)\b/i

export function parseNameDimensions(name: string): number[] | null {
  if (MILLIMETRE_NAMES.test(name.trim())) return null
  const match = NAME_DIMENSION.exec(name)
  if (!match) return null
  const values: number[] = []
  for (const raw of match.slice(1)) {
    if (raw === undefined) continue
    const value = parseMixedNumber(raw)
    if (value === null || value < 0.25 || value > 64) return null
    values.push(value)
  }
  if (values.length < 2) return null
  // A footprint is counted in studs, so it lands on whole or half studs. A
  // decimal footprint is a measurement in some other unit that happens to be
  // written the same way, and is refused rather than indexed as a stud count.
  for (const value of values.slice(0, 2)) {
    if (Math.abs(value * 2 - Math.round(value * 2)) > 1e-6) return null
  }
  return values
}

function documentText(name: string, category: string, families: readonly string[], kind: string | null): string {
  return [name, category, families.join(' '), kind ?? ''].filter(Boolean).join(' ')
}

function connectorProfile(definition: PartDefinition): ConnectorProfile {
  const counts = new Map<string, number>()
  for (const feature of definition.connectors) {
    const key = `${feature.family}/${feature.gender}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function documentIdentity(definition: PartDefinition): DocumentIdentity {
  const { identity } = definition
  return {
    ldraw: definition.ldrawId,
    rebrickable: identity.rebrickableId,
    design: identity.legoDesignIds,
    element: identity.legoElementIds,
    bricklink: identity.bricklinkIds,
  }
}

async function fetchVerified(url: string, descriptor: { hash: string; bytes: number }, signal?: AbortSignal) {
  const response = await fetch(url, { cache: 'force-cache', signal })
  if (!response.ok) throw new CorpusUnavailableError(`${url} → ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  await verifyAsset(buffer, descriptor, url)
  return JSON.parse(new TextDecoder().decode(buffer)) as unknown
}

/**
 * Builds the corpus from the registry's own installed catalog.
 *
 * Pack definitions are merged over the compact search records rather than
 * replacing them, because the two carry different facts: the search record
 * knows every identity, the definition knows connectors, identity numbers and
 * colour evidence for the 900 that have compiled geometry.
 */
export async function loadPartCorpus(options: CorpusLoadOptions = {}): Promise<PartCorpus> {
  const manifest = catalog.info
  if (!manifest) throw new CorpusUnavailableError('the compiled catalog has not been installed')
  const root = (options.baseUrl ?? '').replace(/\/$/, '')
  const assetUrl = (assetPath: string) => `${root}/${assetPath.replace(/^\/+/, '')}`

  const search = (await fetchVerified(
    assetUrl(manifest.files.search.path),
    manifest.files.search,
    options.signal,
  )) as RawSearchEntry[]

  const external = manifest.files.searchExternal && options.includeCatalogued
    ? ((await fetchVerified(
        assetUrl(manifest.files.searchExternal.path),
        manifest.files.searchExternal,
        options.signal,
      )) as RawExternalEntry[])
    : []

  return buildPartCorpus(manifest.catalogVersion, search, external)
}

/**
 * The pure half of the loader, separated so the index can also be built from
 * payloads that are already in memory — which is what the test suite and the
 * offline evaluation harness do.
 */
export function buildPartCorpus(
  catalogVersion: string,
  search: readonly RawSearchEntry[],
  external: readonly RawExternalEntry[] = [],
): PartCorpus {
  const definitions = new Map(catalog.placeable().map((definition) => [definition.canonicalId, definition]))
  const documents: CorpusDocument[] = []
  const byId = new Map<string, CorpusDocument>()

  const push = (document: CorpusDocument) => {
    // The registry gives modelled identities precedence over catalogued ones of
    // the same number; the corpus has to agree or the two indexes would rank
    // different parts under the same id.
    if (byId.has(document.id)) return
    documents.push(document)
    byId.set(document.id, document)
  }

  for (const entry of search) {
    const definition = definitions.get(entry.id)
    const kind = definition?.kind ?? null
    const families = entry.k ?? []
    push({
      id: entry.id,
      name: entry.n,
      category: entry.c,
      tier: entry.g === 1 ? 'placeable' : 'modelled',
      frequency: entry.f,
      studs: definition?.dimensions?.studs ?? entry.d,
      nameStuds: parseNameDimensions(entry.n),
      families,
      geometryAvailable: entry.g === 1,
      helper: entry.h === 1,
      variantOf: definition?.identity.baseRebrickableId ?? null,
      kind,
      identity: definition ? documentIdentity(definition) : EMPTY_IDENTITY,
      connectors: definition ? connectorProfile(definition) : null,
      antiStudsLdu: definition
        ? definition.connectors.filter((feature) => feature.family === 'anti-stud').map((feature) => feature.pos)
        : null,
      connectorAxes: definition
        ? definition.connectors.map((feature) => ({ family: feature.family, axis: connectorAxis(feature) }))
        : null,
      boundsLdu: definition?.dimensions?.bounds ?? null,
      colors: definition?.availableColors ?? null,
      geometryStatus: definition?.geometryStatus ?? null,
      text: documentText(entry.n, entry.c, families, kind),
    })
  }

  for (const entry of external) {
    push({
      id: entry.id,
      name: entry.n,
      category: entry.c,
      tier: 'catalogued',
      frequency: entry.f,
      studs: null,
      nameStuds: parseNameDimensions(entry.n),
      families: [],
      geometryAvailable: false,
      helper: false,
      variantOf: entry.p ?? null,
      kind: null,
      identity: EMPTY_IDENTITY,
      connectors: null,
      antiStudsLdu: null,
      connectorAxes: null,
      boundsLdu: null,
      colors: null,
      geometryStatus: null,
      text: documentText(entry.n, entry.c, [], null),
    })
  }

  const byFootprint = new Map<string, number[]>()
  documents.forEach((document, index) => {
    const footprint = document.studs
      ? [document.studs[0], document.studs[2]]
      : document.nameStuds
        ? document.nameStuds.slice(0, 2)
        : null
    if (!footprint || footprint.length < 2) return
    const key = footprintKey(footprint[0], footprint[1])
    const bucket = byFootprint.get(key)
    if (bucket) bucket.push(index)
    else byFootprint.set(key, [index])
  })
  for (const bucket of byFootprint.values()) {
    bucket.sort((a, b) => documents[b].frequency - documents[a].frequency)
  }

  return { catalogVersion, documents, byId, byFootprint, includesCatalogued: external.length > 0 }
}

/**
 * One document built from a compact search record.
 *
 * The synchronous resolver runs before the corpus has been fetched - a UI calls
 * it on every keystroke - and the registry's own ranked search is the only
 * candidate source available at that point. Mapping its records into the same
 * document shape means the degraded path shares every scorer and every
 * explanation with the warm one, instead of being a second ranking
 * implementation that drifts.
 */
export function documentFromSearchRecord(record: CatalogSearchRecord): CorpusDocument {
  const definition = catalog.get(record.id)
  const families = record.connectorFamilies ?? []
  return {
    id: record.id,
    name: record.name,
    category: record.category,
    tier: record.tier,
    frequency: record.frequency,
    studs: definition?.dimensions?.studs ?? record.dimensions,
    nameStuds: parseNameDimensions(record.name),
    families,
    geometryAvailable: record.geometryAvailable,
    helper: record.helper,
    variantOf: record.variantOf ?? definition?.identity.baseRebrickableId ?? null,
    kind: definition?.kind ?? null,
    identity: definition ? documentIdentity(definition) : EMPTY_IDENTITY,
    connectors: definition ? connectorProfile(definition) : null,
    antiStudsLdu: definition
      ? definition.connectors.filter((feature) => feature.family === 'anti-stud').map((feature) => feature.pos)
      : null,
    connectorAxes: definition
      ? definition.connectors.map((feature) => ({ family: feature.family, axis: connectorAxis(feature) }))
      : null,
    boundsLdu: definition?.dimensions?.bounds ?? null,
    colors: definition?.availableColors ?? null,
    geometryStatus: definition?.geometryStatus ?? null,
    text: documentText(record.name, record.category, families, definition?.kind ?? null),
  }
}
