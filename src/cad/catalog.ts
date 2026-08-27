import type {
  CatalogSearchQuery,
  CatalogSearchRecord,
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

export interface CatalogManifest {
  catalogVersion: string
  generatedAt: string
  sources: Record<string, unknown>
  counts: { parts: number; packParts: number; connectors: number; colors: number }
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
  private searchEntries: RawSearchEntry[] = []
  private colorsByCode = new Map<number, ColorDefinition>()
  private aliases = new Map<string, string>()
  private searchById = new Map<string, RawSearchEntry>()
  private manifest: CatalogManifest | null = null

  install(payload: CatalogPayload) {
    this.manifest = payload.manifest
    this.definitions = new Map(payload.parts.map((part) => [part.canonicalId, part]))
    this.searchEntries = payload.search
    this.searchById = new Map(payload.search.map((entry) => [entry.id, entry]))
    this.colorsByCode = new Map(payload.colors.map((color) => [color.code, color]))
    this.aliases = new Map(Object.entries(payload.aliases ?? {}))
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
    const entry = this.searchById.get(id) ?? this.searchById.get(this.resolveId(id))
    return entry ? toRecord(entry) : undefined
  }

  get placeableCount(): number {
    return this.definitions.size
  }

  get identityCount(): number {
    return this.searchEntries.length
  }

  get categories(): string[] {
    return Array.from(new Set(this.searchEntries.map((entry) => entry.c))).sort()
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
   * Ranked catalog search over every identity.
   *
   * Results are ordered by textual precision first, then by how often the part
   * actually appears in official sets, so a query for "plate" surfaces the
   * everyday plate before an obscure decorated variant.
   */
  search(query: CatalogSearchQuery): CatalogSearchRecord[] {
    const text = query.text?.trim().toLowerCase()
    const words = text ? text.split(/\s+/).filter(Boolean) : []
    const limit = Math.max(1, Math.min(query.limit ?? 24, 200))
    const colorFilter = query.colors?.length ? query.colors : null

    const scored: Array<{ entry: RawSearchEntry; score: number }> = []
    for (const entry of this.searchEntries) {
      if (!query.includeHelpers && entry.h) continue
      if (query.requireGeometry && !entry.g) continue
      if (query.category && entry.c !== query.category) continue
      if (!envelopeMatches(entry.d, query.minStuds, query.maxStuds)) continue
      if (query.connectorTypes?.length && !query.connectorTypes.every((family) => entry.k.includes(family))) continue
      if (colorFilter) {
        const definition = this.definitions.get(entry.id)
        // Colour evidence lives on the full record; identities outside the pack
        // cannot satisfy a colour filter and are excluded rather than assumed.
        if (!definition || !colorFilter.every((code) => definition.availableColors.includes(code))) continue
      }

      let score = Math.log10(entry.f + 1) * 2
      if (words.length) {
        const haystack = `${entry.id} ${entry.n} ${entry.c}`.toLowerCase()
        // A query naming a retired number should surface its replacement.
        const aliasHit = text !== undefined && this.aliases.get(text) === entry.id
        if (!aliasHit && !words.every((word) => haystack.includes(word))) continue
        if (entry.id.toLowerCase() === text || aliasHit) score += 100
        else if (entry.n.toLowerCase().startsWith(text!)) score += 20
        else if (entry.n.toLowerCase().includes(text!)) score += 10
      }
      if (entry.g) score += 6
      if (entry.s) score += 2
      scored.push({ entry, score })
    }

    return scored
      .sort((a, b) => b.score - a.score || a.entry.n.localeCompare(b.entry.n))
      .slice(0, limit)
      .map((item) => toRecord(item.entry))
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

function toRecord(entry: RawSearchEntry): CatalogSearchRecord {
  return {
    id: entry.id,
    name: entry.n,
    category: entry.c,
    dimensions: entry.d,
    frequency: entry.f,
    connectorFamilies: entry.k,
    geometryAvailable: entry.g === 1,
    connectionsAvailable: entry.s === 1,
    helper: entry.h === 1,
  }
}

export const catalog = new CatalogRegistry()

export const getPartDefinition = (id: string): PartDefinition | undefined => catalog.get(id)
export const getColor = (code: number): ColorDefinition => catalog.color(code)
export const searchCatalog = (query: CatalogSearchQuery): CatalogSearchRecord[] => catalog.search(query)

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
