import type {
  CatalogSearchPage,
  CatalogSearchQuery,
  CatalogSearchRecord,
  CatalogTier,
  ColorDefinition,
  ConnectionFamily,
  PartDefinition,
  StudEnvelope,
  Vec3,
} from './types'

/**
 * LDraw's exact discrete unit system. Every kernel measurement is in LDU, so
 * export needs no unit conversion and off-grid SNOT placement stays expressible.
 */
export const STUD_LDU = 20
export const PLATE_LDU = 8
export const BRICK_LDU = 24

/** Raw shape of `catalog/<version>/search.json`, kept compact on the wire. */
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

/**
 * Raw shape of `catalog/<version>/search-external.json`.
 *
 * Identity only: these are catalogued LEGO parts that LDraw does not model, so
 * there is no geometry, no measured envelope and no connector list to publish.
 * The absence is the record — an entry here is the catalogue saying the part is
 * real and that this build knows nothing else about it.
 */
interface RawExternalEntry {
  id: string
  n: string
  c: string
  f: number
  /** Base design a printed or mould variant decorates. */
  p?: string
  /** Material, when the catalogue records something other than plastic. */
  m?: string
}

export interface CatalogManifest {
  schemaVersion: number
  catalogVersion: string
  generatedAt: string
  sources: Record<string, unknown>
  files: Record<'parts' | 'search' | 'colors' | 'aliases', {
    path: string
    hash: string
    bytes: number
  }> & {
    /** Fetched on demand: most sessions never ask past the modelled library. */
    searchExternal?: { path: string; hash: string; bytes: number; lazy?: boolean }
  }
  counts: {
    parts: number
    packParts: number
    connectors: number
    colors: number
    aliases: number
    thumbnails?: number
    externalIdentities?: number
  }
  coverage: Record<string, unknown>
}

export interface CatalogPayload {
  manifest: CatalogManifest
  parts: PartDefinition[]
  search: RawSearchEntry[]
  colors: ColorDefinition[]
  /** Retired LDraw part number → its current replacement, e.g. 3023 → 3023b. */
  aliases?: Record<string, string>
}

/** An entry with everything the ranker needs precomputed once at install. */
interface IndexedEntry {
  id: string
  lowerId: string
  name: string
  lowerName: string
  category: string
  tier: CatalogTier
  /** `id name category`, lowercased, for token containment. */
  hay: string
  studs: Vec3 | null
  frequency: number
  families: ConnectionFamily[]
  geometry: boolean
  connections: boolean
  helper: boolean
  variantOf?: string
  material?: string
}

const UNKNOWN_COLOR = (code: number): ColorDefinition => ({
  code,
  name: `LDraw ${code}`,
  hex: '#d5d8d8',
  edge: '#6d7474',
  alpha: 1,
  finish: 'solid',
})

const envelopeMatches = (studs: Vec3 | null, minimum?: StudEnvelope, maximum?: StudEnvelope) => {
  if (!minimum && !maximum) return true
  if (!studs) return false
  const [width, height, depth] = studs
  const actual = { width, height, depth }
  for (const key of ['width', 'height', 'depth'] as const) {
    if (minimum?.[key] !== undefined && actual[key] < minimum[key]!) return false
    if (maximum?.[key] !== undefined && actual[key] > maximum[key]!) return false
  }
  return true
}

/**
 * The compiled catalog, loaded once per session.
 *
 * Two tiers are deliberately distinct:
 *
 *   search tier  every catalog identity, including parts with no compiled
 *                geometry. Searchable, inspectable, *not* placeable.
 *   pack tier    parts with compiled geometry and connectors. Placeable.
 *
 * Keeping them separate is what lets Brickwright answer "this part exists but I
 * cannot build with it yet" instead of pretending the library is uniform.
 */
export class CatalogRegistry {
  private definitions = new Map<string, PartDefinition>()
  private modelled: IndexedEntry[] = []
  private catalogued: IndexedEntry[] = []
  private colorsByCode = new Map<number, ColorDefinition>()
  private aliases = new Map<string, string>()
  private entriesById = new Map<string, IndexedEntry>()
  private manifest: CatalogManifest | null = null

  install(payload: CatalogPayload) {
    this.manifest = payload.manifest
    this.definitions = new Map(payload.parts.map((part) => [part.canonicalId, part]))
    this.modelled = payload.search.map(indexModelled)
    this.catalogued = []
    this.entriesById = new Map(this.modelled.map((entry) => [entry.id, entry]))
    this.colorsByCode = new Map(payload.colors.map((color) => [color.code, color]))
    this.aliases = new Map(Object.entries(payload.aliases ?? {}))
  }

  /**
   * Adds the wider LEGO catalogue to the index.
   *
   * Fetched separately because it is seven megabytes that an editing session
   * does not need: what you build with is the modelled library, and the rest of
   * the catalogue only matters the moment somebody asks whether a part exists.
   * An identity the modelled index already claims is skipped rather than
   * duplicated, so installing twice is harmless.
   */
  installExternalIndex(entries: RawExternalEntry[]) {
    const added: IndexedEntry[] = []
    for (const raw of entries) {
      if (this.entriesById.has(raw.id)) continue
      const entry = indexCatalogued(raw)
      this.entriesById.set(entry.id, entry)
      added.push(entry)
    }
    this.catalogued = this.catalogued.concat(added)
  }

  /** True once the wider catalogue is resident and `catalogued` results exist. */
  get catalogueLoaded(): boolean {
    return this.catalogued.length > 0
  }

  /** How many catalogued-only identities the manifest says exist, resident or not. */
  get externalIdentityCount(): number {
    return this.manifest?.counts.externalIdentities ?? 0
  }

  /**
   * Resolves a retired LDraw part number to its current replacement.
   *
   * LDraw renames parts across updates and leaves the old number behind as an
   * alias file. Those old numbers stay in circulation for years, so a lookup for
   * `3023` has to reach `3023b` instead of reporting that the part is unknown.
   */
  resolveId(id: string): string {
    return this.aliases.get(id) ?? id
  }

  /** True when `id` is a retired number that was renamed. */
  isAlias(id: string): boolean {
    return this.aliases.has(id)
  }

  get loaded(): boolean {
    return this.manifest !== null
  }

  get version(): string {
    return this.manifest?.catalogVersion ?? 'unloaded'
  }

  get info(): CatalogManifest | null {
    return this.manifest
  }

  /** Full record, following LDraw renames. Only pack parts have one. */
  get(id: string): PartDefinition | undefined {
    return this.definitions.get(id) ?? this.definitions.get(this.resolveId(id))
  }

  /** Compact record, following LDraw renames. Covers every catalog identity. */
  describe(id: string): CatalogSearchRecord | undefined {
    const entry = this.entriesById.get(id) ?? this.entriesById.get(this.resolveId(id))
    return entry ? toRecord(entry) : undefined
  }

  get placeableCount(): number {
    return this.definitions.size
  }

  /** Identities this build models: shape and connections are known. */
  get identityCount(): number {
    return this.modelled.length
  }

  /** Every identity the index can answer for, modelled or merely catalogued. */
  get totalIdentityCount(): number {
    return this.modelled.length + (this.catalogued.length || this.externalIdentityCount)
  }

  get categories(): string[] {
    const names = new Set<string>()
    for (const entry of this.modelled) names.add(entry.category)
    for (const entry of this.catalogued) names.add(entry.category)
    return Array.from(names).sort()
  }

  color(code: number): ColorDefinition {
    return this.colorsByCode.get(code) ?? UNKNOWN_COLOR(code)
  }

  /** True when the LDraw colour table defines this code at all. */
  hasColor(code: number): boolean {
    return this.colorsByCode.has(code)
  }

  colors(): ColorDefinition[] {
    return Array.from(this.colorsByCode.values())
  }

  /**
   * Ranked search over every identity this build knows about.
   *
   * Ordering is deliberate: an exact part number beats a name match, a name
   * match beats a word buried mid-string, a measured envelope beats a number
   * that merely appears in a name, and among equals the part that actually
   * turns up in official sets comes first. Tier is a tiebreaker rather than a
   * filter, so asking for "2 x 4 brick" surfaces the one you can build with
   * without hiding the fifty printed variants you cannot.
   */
  search(query: CatalogSearchQuery): CatalogSearchRecord[] {
    return this.searchPage(query).records
  }

  /**
   * The same search, with the counts a caller needs to page and to build facets.
   *
   * A capped list with no total is what made the catalogue feel small: sixty
   * results out of eighty thousand looked identical to sixty results out of
   * sixty.
   */
  searchPage(query: CatalogSearchQuery): CatalogSearchPage {
    const text = query.text?.trim().toLowerCase() ?? ''
    const tokens = tokenize(text)
    const limit = Math.max(1, Math.min(query.limit ?? 24, 500))
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const colorFilter = query.colors?.length ? query.colors : null
    const tier = query.tier ?? (query.requireGeometry ? 'placeable' : 'all')
    const aliasTarget = text ? this.aliases.get(text) : undefined

    const tiers: Record<CatalogTier, number> = { placeable: 0, modelled: 0, catalogued: 0 }
    const scored: Array<{ entry: IndexedEntry; score: number }> = []

    const consider = (entry: IndexedEntry) => {
      if (!query.includeHelpers && entry.helper) return
      if (query.category && entry.category !== query.category) return
      if (query.minStuds || query.maxStuds) {
        if (!envelopeMatches(entry.studs, query.minStuds, query.maxStuds)) return
      }
      if (query.connectorTypes?.length) {
        if (!query.connectorTypes.every((family) => entry.families.includes(family))) return
      }
      if (colorFilter) {
        const definition = this.definitions.get(entry.id)
        // Colour evidence lives on the full record; identities outside the pack
        // cannot satisfy a colour filter and are excluded rather than assumed.
        if (!definition || !colorFilter.every((code) => definition.availableColors.includes(code))) return
      }

      const relevance = tokens.length ? scoreText(entry, text, tokens, aliasTarget === entry.id) : 0
      if (relevance === null) return

      tiers[entry.tier] += 1
      if (tier !== 'all' && entry.tier !== tier) return

      let score = relevance + Math.log10(entry.frequency + 1) * 3
      if (entry.geometry) score += 14
      else if (entry.tier === 'modelled') score += 5
      if (entry.connections) score += 2
      scored.push({ entry, score })
    }

    for (const entry of this.modelled) consider(entry)
    for (const entry of this.catalogued) consider(entry)

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.frequency - a.entry.frequency ||
        a.entry.name.localeCompare(b.entry.name) ||
        a.entry.id.localeCompare(b.entry.id),
    )

    return {
      records: scored.slice(offset, offset + limit).map((item) => toRecord(item.entry)),
      total: scored.length,
      offset,
      tiers,
      cataloguePending: this.catalogued.length === 0 && this.externalIdentityCount > 0,
    }
  }

  /** Connector families present anywhere in the pack, for UI facets. */
  connectorFamilies(): ConnectionFamily[] {
    const families = new Set<ConnectionFamily>()
    for (const definition of this.definitions.values()) {
      for (const feature of definition.connectors) families.add(feature.family)
    }
    return Array.from(families).sort()
  }

  /** Every placeable definition, ordered by real-world usage. */
  placeable(): PartDefinition[] {
    return Array.from(this.definitions.values()).sort((a, b) => b.frequency - a.frequency)
  }
}

function toRecord(entry: IndexedEntry): CatalogSearchRecord {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    dimensions: entry.studs,
    frequency: entry.frequency,
    connectorFamilies: entry.families,
    geometryAvailable: entry.geometry,
    connectionsAvailable: entry.connections,
    helper: entry.helper,
    tier: entry.tier,
    ...(entry.variantOf ? { variantOf: entry.variantOf } : {}),
    ...(entry.material ? { material: entry.material } : {}),
  }
}

const NO_FAMILIES: ConnectionFamily[] = []

function indexModelled(raw: RawSearchEntry): IndexedEntry {
  return {
    id: raw.id,
    lowerId: raw.id.toLowerCase(),
    name: raw.n,
    lowerName: raw.n.toLowerCase(),
    category: raw.c,
    tier: raw.g === 1 ? 'placeable' : 'modelled',
    hay: `${raw.id} ${raw.n} ${raw.c}`.toLowerCase(),
    studs: raw.d,
    frequency: raw.f,
    families: raw.k,
    geometry: raw.g === 1,
    connections: raw.s === 1,
    helper: raw.h === 1,
  }
}

function indexCatalogued(raw: RawExternalEntry): IndexedEntry {
  return {
    id: raw.id,
    lowerId: raw.id.toLowerCase(),
    name: raw.n,
    lowerName: raw.n.toLowerCase(),
    category: raw.c,
    tier: 'catalogued',
    hay: `${raw.id} ${raw.n} ${raw.c}`.toLowerCase(),
    studs: null,
    frequency: raw.f,
    families: NO_FAMILIES,
    geometry: false,
    connections: false,
    helper: false,
    ...(raw.p ? { variantOf: raw.p } : {}),
    ...(raw.m ? { material: raw.m } : {}),
  }
}

/**
 * Splits a query into tokens, folding "2 x 4" into the single dimension token
 * a person means by it.
 *
 * Without this, "2 x 4 brick" tokenizes into a bare `x` that matches most of
 * the library and two numbers that match nothing useful, which is why the old
 * search returned worse results the more precisely you described the part.
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const joined = text.replace(/(\d)\s*[x×]\s*(?=\d)/g, '$1x')
  return joined.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean)
}

const DIMENSION = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?$/

/** Parses "2x4" or "1x2x5" into its numbers, or null when the token is not one. */
export function parseDimensionToken(token: string): number[] | null {
  const match = DIMENSION.exec(token)
  if (!match) return null
  return match.slice(1).filter((value) => value !== undefined).map(Number)
}

/** True when `token` occurs in `hay` at the start of a word. */
function atWordStart(hay: string, token: string): boolean {
  let at = hay.indexOf(token)
  while (at >= 0) {
    const before = at === 0 ? '' : hay[at - 1]
    if (!before || !/[a-z0-9]/.test(before)) return true
    at = hay.indexOf(token, at + 1)
  }
  return false
}

/**
 * True when a dimension token matches a part's measured envelope.
 *
 * Two numbers describe a footprint, and a 2 x 4 and a 4 x 2 are the same brick
 * held differently, so the comparison is order-insensitive. Three numbers pin
 * the height as well.
 */
function envelopeMatchesToken(studs: Vec3 | null, wanted: number[]): boolean {
  if (!studs) return false
  const [width, height, depth] = studs
  const close = (a: number, b: number) => Math.abs(a - b) < 0.051
  if (wanted.length === 2) {
    const footprint = [width, depth].sort((a, b) => a - b)
    const query = [...wanted].sort((a, b) => a - b)
    return close(footprint[0], query[0]) && close(footprint[1], query[1])
  }
  const actual = [width, height, depth].sort((a, b) => a - b)
  const query = [...wanted].sort((a, b) => a - b)
  return actual.every((value, index) => close(value, query[index]))
}

/**
 * Relevance for one entry, or null when it does not match at all.
 *
 * Every token has to land somewhere — narrowing a search must never widen the
 * result set — but *where* it lands is what decides the order.
 */
function scoreText(entry: IndexedEntry, text: string, tokens: string[], aliasHit: boolean): number | null {
  if (aliasHit) return 200

  let score = 0
  for (const token of tokens) {
    const dimension = parseDimensionToken(token)
    if (dimension) {
      if (envelopeMatchesToken(entry.studs, dimension)) {
        // A measured envelope is stronger evidence than a number in a name.
        score += 26
        continue
      }
      // LDraw writes dimensions spaced out, so "2x4" has to find "2 x 4".
      const spaced = dimension.join(' x ')
      if (entry.hay.includes(spaced)) {
        score += 16
        continue
      }
    }
    if (!entry.hay.includes(token)) return null
    score += atWordStart(entry.hay, token) ? 12 : 4
  }

  if (entry.lowerId === text) score += 200
  else if (entry.lowerId.startsWith(text)) score += 55
  if (entry.lowerName === text) score += 90
  else if (entry.lowerName.startsWith(text)) score += 45
  else if (entry.lowerName.includes(text)) score += 18
  return score
}

export const catalog = new CatalogRegistry()

export const getPartDefinition = (id: string): PartDefinition | undefined => catalog.get(id)
export const getColor = (code: number): ColorDefinition => catalog.color(code)
export const searchCatalog = (query: CatalogSearchQuery): CatalogSearchRecord[] => catalog.search(query)
export const searchCatalogPage = (query: CatalogSearchQuery): CatalogSearchPage => catalog.searchPage(query)

/** Bounding size in LDU, or a zero box when the part has no compiled geometry. */
export const partSizeLdu = (definition: PartDefinition | undefined): Vec3 =>
  definition?.dimensions?.ldu ?? [0, 0, 0]

/**
 * Local y of the part's underside mating plane.
 *
 * LDraw part origins are not uniformly at the top or bottom of the shape — a
 * 2×4 brick has its origin at the stud plane with the underside 24 LDU below,
 * while a curved 2/3-height brick has its origin *at* the underside. Reading
 * the plane off the compiled anti-stud connectors is what makes stacking work
 * for every part instead of only for rectangular bricks.
 */
export function underPlaneLdu(definition: PartDefinition | undefined): number {
  if (!definition) return 0
  let plane: number | null = null
  for (const feature of definition.connectors) {
    if (feature.family !== 'anti-stud') continue
    if (plane === null || feature.pos[1] > plane) plane = feature.pos[1]
  }
  return plane ?? definition.dimensions?.bounds.max[1] ?? 0
}

/**
 * Local y of the part's stud plane, or null when nothing can stack on it —
 * a tile, a slope's sloped face, or a smooth curved element.
 */
export function studPlaneLdu(definition: PartDefinition | undefined): number | null {
  if (!definition) return null
  let plane: number | null = null
  for (const feature of definition.connectors) {
    if (feature.family !== 'stud') continue
    if (plane === null || feature.pos[1] < plane) plane = feature.pos[1]
  }
  return plane
}

/** Origin that makes `definition` rest with its underside on `surfaceY`. */
export const originForSurface = (definition: PartDefinition | undefined, surfaceY: number): number =>
  surfaceY - underPlaneLdu(definition)

/** Surface exposed on top of a part placed at `originY`, or null if it has no studs. */
export function surfaceAbove(definition: PartDefinition | undefined, originY: number): number | null {
  const plane = studPlaneLdu(definition)
  return plane === null ? null : originY + plane
}

/** Human-facing size label, e.g. "4 × 2 studs · 3.5 plates". */
export function describeSize(definition: PartDefinition | undefined): string {
  const studs = definition?.dimensions?.studs
  if (!studs) return 'uncompiled geometry'
  return `${studs[0]} × ${studs[2]} studs · ${studs[1]} plates`
}
