import {
  Box,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleDot,
  Clock3,
  ListOrdered,
  LoaderCircle,
  Lock,
  MessageSquareText,
  Play,
  Plus,
  Search,
  SearchX,
  Square,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { catalog, describeSize, getColor, searchCatalogPage, STUD_LDU } from '../cad/catalog'
import { externalCatalogueAvailable, loadExternalCatalogue } from '../cad/catalog-loader'
import { basisFromEulerDegrees, eulerDegreesFromBasis } from '../cad/math'
import {
  ABS_GRAMS_PER_LDU3,
  analyseStatics,
  DEFAULT_CLUTCH_GRAMS,
  describeMass,
  describeSupport,
  MASS_BASIS,
  type StaticsReport,
} from '../cad/statics'
import type {
  AutonomyMode,
  CatalogSearchPage,
  CatalogSearchRecord,
  CatalogTier,
  ColorDefinition,
  PartDefinition,
  EngineSnapshot,
  PartInstance,
  Transform,
  Transaction,
} from '../cad/types'

/**
 * Palette preview.
 *
 * Uses the offline-rendered thumbnail, tinted to the active colour: a coloured
 * layer masked by the thumbnail's alpha, with the same image multiplied over it
 * to restore shading. One asset therefore serves every LDraw colour, instead of
 * needing a render per part per colour.
 *
 * A part with no compiled geometry has no thumbnail either, and falls back to an
 * empty outline rather than a decorative stand-in — the card should not imply a
 * part is placeable when it is not.
 */
function PartPreview({ record, color }: { record: CatalogSearchRecord; color: string }) {
  const thumbnail = catalog.get(record.id)?.thumbnail
  if (!thumbnail) return <div className="part-glyph empty" aria-hidden><span /></div>
  return (
    <div className="part-thumb" aria-hidden>
      <span
        className="thumb-tint"
        style={{ '--part-color': color, '--thumb': `url(${thumbnail.file})` } as React.CSSProperties}
      />
      <img className="thumb-shade" src={thumbnail.file} alt="" width={thumbnail.size} height={thumbnail.size} loading="lazy" />
    </div>
  )
}

interface CatalogPanelProps {
  activeColor: number
  /** Definition currently armed for click-to-place, if any. */
  armedId: string | null
  onColorChange: (color: number) => void
  onAdd: (record: CatalogSearchRecord) => void
  onArm: (record: CatalogSearchRecord) => void
}

/**
 * Palette colours shown in the dock. The compiled table carries all 322 LDraw
 * colours; these are the everyday building codes, in LDraw code order.
 */
const DOCK_COLORS = [15, 71, 72, 0, 4, 14, 1, 2, 25, 320, 322, 191, 27, 70, 47, 36]

/** How many observed colours the inspector shows before offering the rest. */
const INSPECTOR_SWATCH_LIMIT = 18

/** Placeholder while the validate tab is closed, so nothing is computed for it. */
const EMPTY_STATICS: StaticsReport = {
  mass: { grams: 0, measuredParts: 0, unmeasuredParts: 0, centreLdu: [0, 0, 0] },
  support: null,
  overloaded: [],
  unsupportedPartIds: [],
  assumptions: { clutchGramsPerStud: DEFAULT_CLUTCH_GRAMS, densityGramsPerLdu3: ABS_GRAMS_PER_LDU3, massBasis: MASS_BASIS },
  coverage: 1,
}

const TIERS: Array<{ id: CatalogTier | 'all'; label: string; hint: string }> = [
  { id: 'placeable', label: 'BUILDABLE', hint: 'Compiled geometry and connectors — these can be placed.' },
  { id: 'modelled', label: 'MODELLED', hint: 'LDraw models the shape and connections, but this build carries no mesh.' },
  { id: 'catalogued', label: 'CATALOGUED', hint: 'The wider LEGO catalogue records that these exist. Identity only.' },
  { id: 'all', label: 'EVERYTHING', hint: 'Every identity this build knows about, across all three tiers.' },
]

const PAGE_SIZE = 60

export function CatalogPanel({ activeColor, armedId, onColorChange, onAdd, onArm }: CatalogPanelProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All parts')
  const [tier, setTier] = useState<CatalogTier | 'all'>('placeable')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [catalogueState, setCatalogueState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    () => (catalog.catalogueLoaded ? 'ready' : 'idle'),
  )

  const categories = useMemo(() => {
    // Categories that actually contain placeable parts, most populous first.
    const counts = new Map<string, number>()
    for (const part of catalog.placeable()) counts.set(part.category, (counts.get(part.category) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name]) => name)
  }, [])

  /**
   * Reaching past the modelled library pulls the wider catalogue in once.
   *
   * It is seven megabytes, so it is not fetched on boot; asking for a tier that
   * needs it is the signal that the session actually wants it.
   */
  useEffect(() => {
    if (tier !== 'catalogued' && tier !== 'all') return
    if (catalog.catalogueLoaded || !externalCatalogueAvailable()) return
    let cancelled = false
    setCatalogueState('loading')
    loadExternalCatalogue()
      .then(() => { if (!cancelled) setCatalogueState('ready') })
      .catch(() => { if (!cancelled) setCatalogueState('failed') })
    return () => { cancelled = true }
  }, [tier])

  const page = useMemo(
    () => searchCatalogPage({
      text: query,
      category: category === 'All parts' ? undefined : category,
      tier,
      limit: shown,
    }),
    [category, query, shown, tier, catalogueState],
  )

  // A new query starts at the top of its own result set.
  useEffect(() => setShown(PAGE_SIZE), [query, category, tier])

  const tierHint = TIERS.find((entry) => entry.id === tier)!.hint
  const indexTotal = catalog.totalIdentityCount

  return (
    <aside className="panel catalog-panel" aria-label="Parts catalog">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">BUILD LIBRARY</span>
          <h2>Parts catalog</h2>
        </div>
        <span className="count-badge" title={`${page.total.toLocaleString()} identities match`}>
          {page.total > 999 ? `${Math.round(page.total / 1000)}k` : page.total}
        </span>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="2 x 4, slope, 3001, minifig head…"
          aria-label="Search parts"
          aria-keyshortcuts="Meta+K Control+K"
          data-catalog-search
        />
        {query
          ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>
          : <kbd>⌘ K</kbd>}
      </label>

      {/* Tier is the honest axis of this catalogue: what can be built, what is
          modelled, and what is merely known to exist. Hiding it behind a single
          on/off toggle made two very different "no results" mean the same thing. */}
      <div className="tier-row" role="tablist" aria-label="Catalog knowledge tier">
        {TIERS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tier === entry.id}
            className={tier === entry.id ? 'active' : ''}
            title={entry.hint}
            onClick={() => setTier(entry.id)}
          >
            {entry.label}
            <em>{tierCount(page, entry.id, catalogueState)}</em>
          </button>
        ))}
      </div>

      <div className="category-row" role="tablist" aria-label="Part categories">
        {['All parts', ...categories].map((item) => (
          <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)} role="tab" aria-selected={category === item}>
            {item.replace('Windscreens', 'Glass')}
          </button>
        ))}
      </div>
      <div className="catalog-meta">
        <span title={tierHint}>
          {page.total.toLocaleString()} of {indexTotal.toLocaleString()} identities
        </span>
        {catalogueState === 'loading' && <span className="catalog-loading"><LoaderCircle size={10} /> indexing the wider catalogue</span>}
        {catalogueState === 'failed' && <span className="catalog-failed"><CircleAlert size={10} /> catalogue index unavailable</span>}
        {catalogueState !== 'loading' && catalogueState !== 'failed' && (
          <span className="status-ready"><CircleDot size={10} /> {catalog.placeableCount} placeable</span>
        )}
      </div>
      <div className="parts-grid" data-testid="parts-grid">
        {page.records.map((record) => (
          <article
            className={`part-card tier-${record.tier} ${record.geometryAvailable ? '' : 'unplaceable'} ${armedId === record.id ? 'armed' : ''}`}
            key={record.id}
            title={describeRecord(record)}
          >
            <button
              type="button"
              className="part-card-main"
              disabled={!record.geometryAvailable}
              onClick={() => onArm(record)}
              aria-pressed={armedId === record.id}
              aria-label={record.geometryAvailable ? `Pick up ${record.name} to place in the viewport` : `${record.name}: ${TIER_LABEL[record.tier]}`}
            >
              <PartPreview record={record} color={getColor(activeColor).hex} />
              <div className="part-copy">
                <strong>{record.name.replace(/^(Brick|Plate|Tile|Slope) /, '')}</strong>
                <span>{record.id}{record.dimensions ? ` · ${record.dimensions[0]}×${record.dimensions[2]}` : ` · ${TIER_LABEL[record.tier]}`}</span>
              </div>
            </button>
            <button
              type="button"
              className={`part-add ${record.geometryAvailable ? '' : 'disabled'}`}
              aria-label={record.geometryAvailable ? `Add ${record.name}` : 'No compiled geometry'}
              title={record.geometryAvailable ? `Add ${record.name} straight onto the build` : TIER_LABEL[record.tier]}
              disabled={!record.geometryAvailable}
              onClick={() => onAdd(record)}
            >
              {record.geometryAvailable ? <Plus size={13} /> : '—'}
            </button>
          </article>
        ))}
        {page.total > page.records.length && (
          <button className="parts-more" type="button" onClick={() => setShown((value) => value + PAGE_SIZE)}>
            Show more — {(page.total - page.records.length).toLocaleString()} still match
          </button>
        )}
        {page.total === 0 && (
          <div className="parts-empty">
            <SearchX size={20} strokeWidth={1.4} />
            <strong>Nothing matches “{query || category}”</strong>
            <p>{emptyExplanation(tier, catalogueState)}</p>
            {tier !== 'all' && (
              <button type="button" onClick={() => setTier('all')}>Search every identity</button>
            )}
            {!!query && <button type="button" onClick={() => setQuery('')}>Clear search</button>}
          </div>
        )}
      </div>
      <div className={`palette-dock ${paletteOpen ? 'expanded' : ''}`}>
        <div className="palette-label">
          <span>PROJECT PALETTE</span>
          <button
            type="button"
            aria-expanded={paletteOpen}
            aria-label={paletteOpen ? 'Show the everyday palette' : `Show all ${catalog.colors().length} LDraw colours`}
            title={paletteOpen ? 'Show the everyday palette' : `Show all ${catalog.colors().length} LDraw colours`}
            onClick={() => setPaletteOpen((value) => !value)}
          >
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="swatches compact">
          {(paletteOpen ? catalog.colors().map((color) => color.code) : DOCK_COLORS).map((code) => getColor(code)).map((color) => (
            <button
              key={color.code}
              className={activeColor === color.code ? 'selected' : ''}
              style={{ '--swatch': color.hex } as React.CSSProperties}
              onClick={() => onColorChange(color.code)}
              aria-label={color.name}
              title={`${color.name} · LDraw ${color.code}`}
            />
          ))}
        </div>
      </div>
    </aside>
  )
}

const TIER_LABEL: Record<CatalogTier, string> = {
  placeable: 'buildable',
  modelled: 'modelled, not compiled',
  catalogued: 'catalogued identity',
}

/** Facet count for one tier, or the total across all of them. */
function tierCount(page: CatalogSearchPage, tier: CatalogTier | 'all', state: string): string {
  if (tier === 'catalogued' && state === 'idle') return '·'
  const value = tier === 'all'
    ? page.tiers.placeable + page.tiers.modelled + page.tiers.catalogued
    : page.tiers[tier]
  return value > 9999 ? `${Math.round(value / 1000)}k` : String(value)
}

function describeRecord(record: CatalogSearchRecord): string {
  const appearances = record.frequency
    ? `${record.frequency.toLocaleString()} official set appearance${record.frequency === 1 ? '' : 's'}`
    : 'no recorded set appearances'
  if (record.tier === 'placeable') return `Pick up ${record.name} and click in the viewport to place it · ${appearances}`
  if (record.tier === 'modelled') {
    return `${record.name} is modelled by LDraw, but this build has no compiled geometry for it, so it cannot be placed · ${appearances}`
  }
  const variant = record.variantOf ? ` · a variant of design ${record.variantOf}` : ''
  const material = record.material ? ` · ${record.material}` : ''
  return `${record.name} is a real catalogued part with no LDraw model, so nothing about its shape is known here · ${appearances}${variant}${material}`
}

function emptyExplanation(tier: CatalogTier | 'all', state: string): string {
  if (state === 'loading') return 'The wider catalogue index is still loading.'
  if (state === 'failed') return 'The wider catalogue index could not be fetched, so only modelled identities were searched.'
  if (tier === 'placeable') {
    return `${catalog.placeableCount} of ${catalog.identityCount.toLocaleString()} modelled identities have compiled geometry in this build. Widen the tier to search the rest.`
  }
  if (tier === 'modelled') return 'No LDraw-modelled identity matches. The wider catalogue may still list it.'
  return 'No identity in the catalogue matches this search. Try a part number, a size like “2 x 4”, or a shape word like “slope”.'
}

function NumberField({ label, value, suffix, onCommit }: { label: string; value: number; suffix: string; onCommit: (value: number) => void }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <div><input key={value} type="number" defaultValue={value} onBlur={(event) => onCommit(Number(event.target.value))} /><em>{suffix}</em></div>
    </label>
  )
}

export interface ArticulationControl {
  edgeId: string
  label: string
  family: string
  canRotate: boolean
  canSlide: boolean
  rotateStep: number
  slideStep: number
  movingCount: number
}

interface InspectorPanelProps {
  state: EngineSnapshot
  selectedPart?: PartInstance
  definition?: PartDefinition
  /** Joints the current selection can drive; empty for a rigid assembly. */
  articulation: ArticulationControl[]
  onTransform: (partId: string, transform: Transform) => void
  onRecolor: (color: number) => void
  onProtect: (protect: boolean) => void
  onSelectIds: (ids: string[]) => void
  onArticulate: (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => void
}

export function InspectorPanel({
  state,
  selectedPart,
  definition,
  articulation,
  onTransform,
  onRecolor,
  onProtect,
  onSelectIds,
  onArticulate,
}: InspectorPanelProps) {
  const [tab, setTab] = useState<'object' | 'validate'>('object')
  const [allColors, setAllColors] = useState(false)
  const report = state.validation
  const displayRotation = useMemo(
    () => (selectedPart ? eulerDegreesFromBasis(selectedPart.transform.basis) : ([0, 0, 0] as const)),
    [selectedPart],
  )
  const shownColors = useMemo(() => {
    const observed = definition?.availableColors ?? []
    if (allColors || observed.length <= INSPECTOR_SWATCH_LIMIT) return observed
    const head = observed.slice(0, INSPECTOR_SWATCH_LIMIT)
    // The applied colour must stay visible even when the evidence order buries it.
    return selectedPart && observed.includes(selectedPart.color) && !head.includes(selectedPart.color)
      ? [...head.slice(0, INSPECTOR_SWATCH_LIMIT - 1), selectedPart.color]
      : head
  }, [allColors, definition, selectedPart])
  const dimensions = report.bounds.size.map((value) => value / STUD_LDU)
  // Only while the tab is open, and only then. Statics walks the whole
  // connection graph — 164 ms on a 1,464-part model — so computing it on every
  // commit put it on the edit path, which is exactly where it must not be.
  const showStatics = tab === 'validate'
  const statics = useMemo(
    () => (showStatics ? analyseStatics(state.document) : EMPTY_STATICS),
    [showStatics, state.document],
  )
  return (
    <aside className="panel inspector-panel" aria-label="Selection inspector">
      <div className="inspector-tabs" role="tablist">
        <button className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>OBJECT</button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>
          VALIDATE
          <span className={report.healthy ? 'healthy-dot' : 'warning-dot'} />
        </button>
      </div>
      {tab === 'object' ? (
        selectedPart && definition ? (
          <div className="inspector-scroll">
            <section className="selection-identity">
              <div className="selected-glyph"><Box size={24} strokeWidth={1.4} /></div>
              <div>
                <span className="eyebrow">{definition.category} / {definition.canonicalId}</span>
                <h3>{definition.name}</h3>
                <p>{selectedPart.id} · {describeSize(definition)}</p>
              </div>
            </section>
            <section className="property-section">
              <header><span>TRANSFORM</span><em>WORLD · LDU</em></header>
              <div className="fields-grid">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                  <NumberField
                    key={`p_${axis}`}
                    label={axis}
                    value={selectedPart.transform.position[index]}
                    suffix="LDU"
                    onCommit={(value) => {
                      const position = [...selectedPart.transform.position] as [number, number, number]
                      position[index] = value
                      onTransform(selectedPart.id, { ...selectedPart.transform, position })
                    }}
                  />
                ))}
              </div>
              {/* Euler degrees are a display affordance only. The document
                  stores an exact basis; these fields decompose it for editing
                  and recompose on commit. */}
              <div className="fields-grid rotation-fields">
                {(['RX', 'RY', 'RZ'] as const).map((axis, index) => (
                  <NumberField
                    key={`r_${axis}`}
                    label={axis}
                    value={displayRotation[index]}
                    suffix="°"
                    onCommit={(value) => {
                      const rotation = [...displayRotation] as [number, number, number]
                      rotation[index] = value
                      onTransform(selectedPart.id, {
                        position: selectedPart.transform.position,
                        basis: basisFromEulerDegrees(rotation),
                      })
                    }}
                  />
                ))}
              </div>
            </section>
            <section className="property-section">
              <header><span>COLOR</span><em>{getColor(selectedPart.color).name}</em></header>
              {/* A part observed in 61 official colours produced a wall of
                  unlabelled circles. The evidence order puts the common ones
                  first, so the list is capped and the rest are one click away —
                  with the colour actually applied always shown. */}
              <div className="swatches inspector-swatches">
                {shownColors.map((code) => {
                  const color = getColor(code)
                  return (
                    <button
                      key={code}
                      className={selectedPart.color === code ? 'selected' : ''}
                      style={{ '--swatch': color.hex } as React.CSSProperties}
                      onClick={() => onRecolor(code)}
                      aria-label={`${color.name}, LDraw colour ${code}`}
                      aria-pressed={selectedPart.color === code}
                      title={`${color.name} · LDraw ${code}`}
                    />
                  )
                })}
              </div>
              {definition.availableColors.length > INSPECTOR_SWATCH_LIMIT && (
                <button className="swatch-more" type="button" onClick={() => setAllColors((value) => !value)}>
                  {allColors
                    ? 'Show the common colours'
                    : `Show all ${definition.availableColors.length} observed colours`}
                </button>
              )}
              <div className={`legality-row ${definition.availableColors.includes(selectedPart.color) ? '' : 'virtual'}`}>
                <Check size={12} />
                {definition.availableColors.includes(selectedPart.color)
                  ? `Observed in official sets · ${definition.availableColors.length} known colours`
                  : definition.availableColors.length
                    ? 'Virtual colour — no observed official-set appearance'
                    : 'No colour production evidence for this part'}
              </div>
            </section>
            <section className="property-section">
              <header><span>CONNECTIONS</span><em>{definition.connectors.length} features</em></header>
              <div className="connector-summary">
                <div><span className="connector-icon male" /> <strong>{definition.connectors.filter((item) => item.gender === 'male').length}</strong><small>male</small></div>
                <div><span className="connector-icon female" /> <strong>{definition.connectors.filter((item) => item.gender === 'female').length}</strong><small>female</small></div>
                <div><ShieldCheck size={18} /> <strong>{definition.connectionStatus === 'ldcad-authoritative' ? 'LDCad' : 'none'}</strong><small>source</small></div>
              </div>
            </section>
            <section className="property-section">
              <header><span>OWNERSHIP</span><em>{selectedPart.provenance}</em></header>
              <button className={`lock-control ${selectedPart.protected ? 'locked' : ''}`} onClick={() => onProtect(!selectedPart.protected)}>
                {selectedPart.protected ? <Lock size={15} /> : <Unlock size={15} />}
                <span>{selectedPart.protected ? 'Protected from agent edits' : 'Unlocked for collaboration'}</span>
                <i>{selectedPart.protected ? 'LOCKED' : 'OPEN'}</i>
              </button>
            </section>
            {articulation.length > 0 && (
              <section className="property-section">
                <header><span>ARTICULATION</span><em>{articulation.length} joint{articulation.length === 1 ? '' : 's'}</em></header>
                {/* Only interfaces designed to move appear here. A stud
                    connection is rigid once built, so a brick wall offers
                    nothing to drive. */}
                {articulation.map((joint) => (
                  <div className="joint-row" key={joint.edgeId}>
                    <div className="joint-copy">
                      <strong>{joint.family}</strong>
                      <small>{joint.label.split(' · ').slice(2).join(' · ')} · moves {joint.movingCount}</small>
                    </div>
                    <div className="joint-controls">
                      {joint.canRotate && (
                        <>
                          <button onClick={() => onArticulate(joint.edgeId, { rotateDegrees: -joint.rotateStep })} title={`Rotate -${joint.rotateStep}°`}>
                            <RotateCcw size={12} />
                          </button>
                          <button onClick={() => onArticulate(joint.edgeId, { rotateDegrees: joint.rotateStep })} title={`Rotate +${joint.rotateStep}°`}>
                            <RotateCw size={12} />
                          </button>
                        </>
                      )}
                      {joint.canSlide && (
                        <>
                          <button onClick={() => onArticulate(joint.edgeId, { slideLdu: -joint.slideStep })} title={`Slide -${joint.slideStep} LDU`}>
                            <ChevronsLeft size={12} />
                          </button>
                          <button onClick={() => onArticulate(joint.edgeId, { slideLdu: joint.slideStep })} title={`Slide +${joint.slideStep} LDU`}>
                            <ChevronsRight size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            <section className="property-section">
              <header><span>DATA PROVENANCE</span><em>{definition.license}</em></header>
              <dl className="provenance-list">
                <div>
                  <dt>Geometry</dt>
                  <dd>{definition.ldrawId} · {definition.geometryAsset?.triangles.toLocaleString() ?? '—'} triangles</dd>
                </div>
                <div>
                  <dt>Connections</dt>
                  <dd>
                    {definition.connectionStatus === 'ldcad-authoritative'
                      ? `LDCad Shadow Library · ${definition.connectors.length} features`
                      : 'no snap metadata'}
                  </dd>
                </div>
                <div>
                  <dt>Identity</dt>
                  <dd>
                    {definition.identity.rebrickableId
                      ? `${definition.identity.rebrickableId} · exact match`
                      : definition.identity.baseRebrickableId
                        ? `${definition.identity.baseRebrickableId} · base-design match`
                        : 'no external identity'}
                  </dd>
                </div>
                <div>
                  <dt>Colours</dt>
                  <dd>
                    {definition.availableColors.length
                      ? `${definition.availableColors.length} observed in official sets`
                      : 'no production evidence'}
                  </dd>
                </div>
                {definition.frequency > 0 && (
                  <div>
                    <dt>Usage</dt>
                    <dd>{definition.frequency.toLocaleString()} set appearances</dd>
                  </div>
                )}
              </dl>
            </section>
          </div>
        ) : (
          <div className="empty-inspector">
            <div className="scanner-mark"><span /><span /><span /><span /></div>
            <span className="eyebrow">NO OBJECT SELECTED</span>
            <h3>Inspect the build</h3>
            <p>Select any physical part to inspect its exact transform, connectors, identity and ownership.</p>
            <div className="overview-metrics">
              <div><strong>{report.partCount}</strong><span>parts</span></div>
              <div><strong>{Object.keys(state.document.subassemblies).length}</strong><span>modules</span></div>
              <div><strong>r{state.document.revision}</strong><span>revision</span></div>
            </div>
          </div>
        )
      ) : (
        <div className="validation-view inspector-scroll">
          <div className={`validation-hero ${report.healthy ? 'pass' : 'warn'}`}>
            <div>{report.healthy ? <ShieldCheck size={25} /> : <CircleAlert size={25} />}</div>
            <span className="eyebrow">LIVE KERNEL REPORT</span>
            <h3>{report.healthy ? 'Geometry is clean' : 'Review build warnings'}</h3>
            <p>Deterministic checks at revision {report.revision}</p>
          </div>
          <section className="validation-list">
            {/* Certainty is surfaced, not folded away: a verdict reached from
                bounding boxes alone must not read the same as a triangle-exact
                one. */}
            <ValidationRow
              label="Collisions"
              value={
                report.collisions.length
                  ? `${report.collisions.length} found${report.unverifiedCollisions ? ` · ${report.unverifiedCollisions} unverified` : ''}`
                  : 'None'
              }
              status={report.collisions.length ? (report.unverifiedCollisions === report.collisions.length ? 'warn' : 'fail') : 'pass'}
              onClick={() => onSelectIds(report.collisions.flatMap((item) => [item.partA, item.partB]))}
            />
            <ValidationRow label="Connections" value={`${report.connectionCount} mated`} status="pass" />
            <ValidationRow label="Loose groups" value={report.componentCount <= 1 ? 'None' : String(report.componentCount - 1)} status={report.componentCount <= 1 ? 'pass' : 'warn'} onClick={() => onSelectIds(report.disconnectedPartIds)} />
            <ValidationRow label="Colour evidence" value={report.virtualColors.length ? `${report.virtualColors.length} virtual` : 'All observed'} status={report.virtualColors.length ? 'warn' : 'pass'} onClick={() => onSelectIds(report.virtualColors.map((item) => item.partId))} />
            <ValidationRow label="Dimensions" value={`${dimensions[0].toFixed(1)} × ${dimensions[2].toFixed(1)} studs`} status="pass" />
          </section>

          {/* Statics answers what collision cannot: does it stand up, and what
              is holding it together. Recomputed only while this tab is open,
              because it walks the connection graph. */}
          <section className="validation-list statics-list">
            <header className="statics-header">
              <span className="eyebrow">STATIC ANALYSIS</span>
              <em title={statics.assumptions.massBasis}>measured mass</em>
            </header>
            <ValidationRow
              label="Mass"
              value={statics.mass.measuredParts ? describeMass(statics.mass.grams) : 'nothing measured'}
              status={statics.coverage >= 0.999 ? 'pass' : 'warn'}
            />
            <ValidationRow
              label="Balance"
              value={statics.support
                ? statics.support.stable
                  ? `stable · ${(statics.support.marginLdu / STUD_LDU).toFixed(1)} studs of margin`
                  : 'centre of mass is outside the footprint'
                : 'nothing resting'}
              status={statics.support ? (statics.support.stable ? 'pass' : 'fail') : 'warn'}
            />
            <ValidationRow
              label="Footprint"
              value={describeSupport(statics.support)}
              status="pass"
            />
            <ValidationRow
              label="Reaches the ground"
              value={statics.unsupportedPartIds.length ? `${statics.unsupportedPartIds.length} part(s) do not` : 'every part'}
              status={statics.unsupportedPartIds.length ? 'warn' : 'pass'}
              onClick={statics.unsupportedPartIds.length ? () => onSelectIds(statics.unsupportedPartIds) : undefined}
            />
            <ValidationRow
              label="Clutch load"
              value={statics.overloaded.length ? `${statics.overloaded.length} over ${statics.assumptions.clutchGramsPerStud} g/stud` : 'within assumption'}
              status={statics.overloaded.length ? 'fail' : 'pass'}
              onClick={statics.overloaded.length ? () => onSelectIds(statics.overloaded.flatMap((item) => item.partIds)) : undefined}
            />
            {statics.coverage < 0.999 && (
              <p className="statics-note">
                {statics.mass.unmeasuredParts} part{statics.mass.unmeasuredParts === 1 ? '' : 's'} have no compiled volume, so they are
                excluded from the mass rather than estimated.
              </p>
            )}
          </section>
          <section className="constraint-list">
            <header><span>DESIGN CONSTRAINTS</span><em>{report.constraints.length}</em></header>
            {report.constraints.map((constraint) => (
              <div className="constraint-row" key={constraint.id}>
                <span className={`check-state ${constraint.status}`}>{constraint.status === 'pass' ? <Check size={11} /> : <CircleAlert size={11} />}</span>
                <div><strong>{constraint.label}</strong><small>{constraint.message}</small></div>
              </div>
            ))}
          </section>
        </div>
      )}
    </aside>
  )
}

function ValidationRow({ label, value, status, onClick }: { label: string; value: string; status: 'pass' | 'warn' | 'fail'; onClick?: () => void }) {
  return (
    <button className="validation-row" onClick={onClick} disabled={!onClick}>
      <span className={`check-state ${status}`}>{status === 'pass' ? <Check size={11} /> : <CircleAlert size={11} />}</span>
      <strong>{label}</strong>
      <em>{value}</em>
    </button>
  )
}

interface TimelineProps {
  state: EngineSnapshot
  /** Step index currently being played back, or null when the whole model shows. */
  playbackStep: number | null
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onSelectIds: (ids: string[]) => void
  onSequence: () => void
  onPlayStep: (index: number | null) => void
}

const transactionIcon = (transaction: Transaction) => transaction.author === 'agent' ? <Sparkles size={13} /> : <Box size={13} />

/**
 * The shared bottom band: edit history and build sequence.
 *
 * These are two different readings of the same model — what was done, and what
 * order it goes together in — so they get an explicit switch. Before, the band
 * silently swapped the sequence out for history the moment anything was edited,
 * which meant the build steps disappeared exactly when a builder started using
 * the tool.
 */
export function Timeline({ state, playbackStep, onAccept, onReject, onSelectIds, onSequence, onPlayStep }: TimelineProps) {
  const [view, setView] = useState<'history' | 'steps'>('steps')
  const latestTransactions = state.transactions.slice(-8).reverse()
  const showing = state.proposals.length ? 'history' : view

  return (
    <section className="timeline" aria-label="Build history and sequence">
      <div className="timeline-label">
        <span className="eyebrow">SHARED WORKSPACE</span>
        <h3>{showing === 'steps' ? 'Build sequence' : 'Edit history'}</h3>
        <div><Clock3 size={12} /> {state.document.steps.length} steps · {state.validation.partCount} pcs</div>
        <div className="timeline-switch" role="tablist" aria-label="Timeline view">
          <button role="tab" aria-selected={showing === 'steps'} className={showing === 'steps' ? 'active' : ''} onClick={() => setView('steps')}>
            <ListOrdered size={11} /> STEPS
          </button>
          <button role="tab" aria-selected={showing === 'history'} className={showing === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            <Clock3 size={11} /> HISTORY <em>{state.transactions.length}</em>
          </button>
        </div>
        {showing === 'steps' && (
          <div className="timeline-actions">
            {/* Sequencing is a precedence problem over the connection graph, so it is
                regenerated from the model rather than authored by hand. */}
            <button className="sequence-button" onClick={onSequence} title="Derive a build sequence in which every part attaches to earlier structure">
              <ListOrdered size={11} /> RESEQUENCE
            </button>
            <button
              className={`sequence-button ${playbackStep === null ? '' : 'active'}`}
              onClick={() => onPlayStep(playbackStep === null ? 0 : null)}
              title={playbackStep === null ? 'Play the build one step at a time' : 'Show the whole model again'}
            >
              {playbackStep === null ? <Play size={11} /> : <Square size={11} />} {playbackStep === null ? 'PLAY' : 'SHOW ALL'}
            </button>
          </div>
        )}
      </div>
      <div className="timeline-track">
        {showing === 'history' ? (
          <>
            {state.proposals.map((proposal) => (
              <article className="proposal-card" key={proposal.id}>
                <div className="proposal-glow" />
                <header><Sparkles size={13} /><span>CODEX PROPOSAL</span><em>r{proposal.baseRevision}</em></header>
                <strong>{proposal.label}</strong>
                <p>{proposal.operations.length} operations · {proposal.validation.collisions.length} collisions</p>
                <footer>
                  <button onClick={() => onAccept(proposal.id)}><Check size={12} /> Accept</button>
                  <button onClick={() => onReject(proposal.id)}><X size={12} /> Reject</button>
                </footer>
              </article>
            ))}
            {latestTransactions.length === 0 && (
              <div className="timeline-empty">Nothing has been edited yet. Every change you or the agent makes lands here as one atomic, reversible transaction.</div>
            )}
            {latestTransactions.map((transaction, index) => (
              <button
                className={`transaction-card ${transaction.author}`}
                key={transaction.id}
                title={`Select the ${transaction.affectedPartIds.length} part(s) this transaction touched`}
                onClick={() => onSelectIds(transaction.affectedPartIds)}
              >
                <span className="transaction-index">{String(state.transactions.length - index).padStart(2, '0')}</span>
                <div className="transaction-icon">{transactionIcon(transaction)}</div>
                <div><strong>{transaction.label}</strong><small>{transaction.operations.length} operation{transaction.operations.length === 1 ? '' : 's'} · {transaction.author}</small></div>
                <em>r{transaction.resultRevision}</em>
              </button>
            ))}
          </>
        ) : (
          <>
            {state.document.steps.length === 0 && (
              <div className="timeline-empty">No build sequence yet. Press RESEQUENCE to derive one from the connection graph.</div>
            )}
            {state.document.steps.map((step, index) => {
              // "Complete" means built at the point the operator is looking at:
              // during playback that is everything up to the current step, and
              // with playback off the whole sequence is built.
              const built = playbackStep === null || index <= playbackStep
              const current = playbackStep === index
              return (
                <button
                  className={`step-card ${built ? 'complete' : ''} ${current ? 'current' : ''}`}
                  key={step.id}
                  aria-current={current}
                  title={`Show the build through step ${step.index}: ${step.name}`}
                  onClick={() => {
                    onPlayStep(index)
                    onSelectIds(step.partIds)
                  }}
                >
                  <span>{String(step.index).padStart(2, '0')}</span>
                  <div className="step-node">{built ? <Check size={11} /> : <CircleDot size={10} />}</div>
                  <strong>{step.name}</strong>
                  <small>{step.partIds.length} parts</small>
                </button>
              )
            })}
          </>
        )}
      </div>
      <div className="timeline-note">
        <MessageSquareText size={14} />
        <div><span>OPEN NOTE</span><strong>{state.document.notes.find((note) => note.status === 'open')?.text ?? 'No unresolved builder notes'}</strong></div>
      </div>
    </section>
  )
}

export function AutonomySwitch({ value, onChange }: { value: AutonomyMode; onChange: (mode: AutonomyMode) => void }) {
  return (
    <div className="autonomy-switch" aria-label="Codex autonomy mode">
      {(['inspect', 'propose', 'build'] as AutonomyMode[]).map((mode) => (
        <button key={mode} className={value === mode ? `active ${mode}` : ''} onClick={() => onChange(mode)}>
          {mode === 'inspect' && <CircleDot size={11} />}
          {mode === 'propose' && <Sparkles size={11} />}
          {mode === 'build' && <ShieldCheck size={11} />}
          {mode}
        </button>
      ))}
    </div>
  )
}

export function ColorLabel({ color }: { color: ColorDefinition }) {
  return <span className="color-label"><i style={{ background: color.hex }} />{color.name}</span>
}
