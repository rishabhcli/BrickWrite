import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock3,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  Rows3,
  Search,
  SearchX,
  Star,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { catalog, getColor, searchCatalogPage } from '../../cad/catalog'
import { externalCatalogueAvailable, loadExternalCatalogue } from '../../cad/catalog-loader'
import type {
  CatalogSearchPage,
  CatalogSearchRecord,
  CatalogTier,
  ConnectionFamily,
} from '../../cad/types'
import { usePersistentState } from './persistence'

/**
 * The parts palette.
 *
 * Three things separate this from a search box over a list. It pages a
 * ninety-thousand-identity index without ever holding more than one page in the
 * DOM. It faces that index honestly — a result says whether it can be built
 * with, is merely modelled, or is only catalogued. And it is a place an operator
 * accumulates a working set: favourites, recents and named palettes, because a
 * real build reaches for the same forty parts over and over.
 */

/** Cards materialised at once. Everything past this is reached by paging. */
const PAGE_SIZE = 60

export type PaletteView = 'card' | 'compact' | 'list'

const TIERS: Array<{ id: CatalogTier | 'all'; label: string; hint: string }> = [
  { id: 'placeable', label: 'BUILDABLE', hint: 'Compiled geometry and connectors — these can be placed.' },
  { id: 'modelled', label: 'MODELLED', hint: 'LDraw models the shape and connections, but this build carries no mesh.' },
  { id: 'catalogued', label: 'CATALOGUED', hint: 'The wider LEGO catalogue records that these exist. Identity only.' },
  { id: 'all', label: 'EVERYTHING', hint: 'Every identity this build knows about, across all three tiers.' },
]

const TIER_LABEL: Record<CatalogTier, string> = {
  placeable: 'buildable',
  modelled: 'modelled, not compiled',
  catalogued: 'catalogued identity',
}

/**
 * Palette colours shown in the dock. The compiled table carries all 322 LDraw
 * colours; these are the everyday building codes, in LDraw code order.
 */
const DOCK_COLORS = [15, 71, 72, 0, 4, 14, 1, 2, 25, 320, 322, 191, 27, 70, 47, 36]

const CONNECTOR_FACETS: Array<{ id: ConnectionFamily; label: string }> = [
  { id: 'stud', label: 'Studs' },
  { id: 'anti-stud', label: 'Anti-studs' },
  { id: 'pin', label: 'Pins' },
  { id: 'pin-hole', label: 'Pin holes' },
  { id: 'axle', label: 'Axles' },
  { id: 'axle-hole', label: 'Axle holes' },
  { id: 'clip', label: 'Clips' },
  { id: 'bar', label: 'Bars' },
  { id: 'hinge', label: 'Hinges' },
  { id: 'ball', label: 'Balls' },
  { id: 'socket', label: 'Sockets' },
]

const SIZE_FACETS: Array<{ id: string; label: string; min?: number; max?: number }> = [
  { id: 'any', label: 'Any size' },
  { id: 'small', label: '1–2 studs', max: 2 },
  { id: 'medium', label: '3–6 studs', min: 3, max: 6 },
  { id: 'large', label: '7+ studs', min: 7 },
]

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
export function PartPreview({ record, color }: { record: CatalogSearchRecord; color: string }) {
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

export interface CustomPalette {
  id: string
  name: string
  partIds: string[]
}

export interface PalettePanelProps {
  activeColor: number
  /** Definition currently armed for click-to-place, if any. */
  armedId: string | null
  onColorChange: (color: number) => void
  onAdd: (record: CatalogSearchRecord) => void
  onArm: (record: CatalogSearchRecord) => void
  /** Drag-and-drop drop into the viewport. Returns true when it was consumed. */
  onDropPart?: (record: CatalogSearchRecord, clientX: number, clientY: number) => void
}

export function PalettePanel({ activeColor, armedId, onColorChange, onAdd, onArm }: PalettePanelProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All parts')
  const [tier, setTier] = useState<CatalogTier | 'all'>('placeable')
  const [offset, setOffset] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [facetsOpen, setFacetsOpen] = useState(false)
  const [connectorFacet, setConnectorFacet] = useState<ConnectionFamily | 'any'>('any')
  const [sizeFacet, setSizeFacet] = useState('any')
  const [colourFacet, setColourFacet] = useState(false)
  const [view, setView] = usePersistentState<PaletteView>('palette.view.v1', 'card')
  const [favourites, setFavourites] = usePersistentState<string[]>('palette.favourites.v1', [])
  const [recents, setRecents] = usePersistentState<string[]>('palette.recents.v1', [])
  const [colourFavourites, setColourFavourites] = usePersistentState<number[]>('palette.colours.v1', [])
  const [customPalettes, setCustomPalettes] = usePersistentState<CustomPalette[]>('palette.sets.v1', [])
  const [activeSet, setActiveSet] = useState<string | null>(null)
  const [cursor, setCursor] = useState(-1)
  const [catalogueState, setCatalogueState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(
    () => (catalog.catalogueLoaded ? 'ready' : 'idle'),
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const categories = useMemo(() => {
    // Categories that actually contain placeable parts, most populous first.
    const counts = new Map<string, number>()
    for (const part of catalog.placeable()) counts.set(part.category, (counts.get(part.category) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name]) => name)
  }, [])

  const allCategories = useMemo(() => catalog.categories, [])

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

  const sizeRange = SIZE_FACETS.find((entry) => entry.id === sizeFacet)

  const page = useMemo<CatalogSearchPage>(
    () => searchCatalogPage({
      text: query,
      category: category === 'All parts' ? undefined : category,
      tier,
      limit: PAGE_SIZE,
      offset,
      ...(connectorFacet === 'any' ? {} : { connectorTypes: [connectorFacet] }),
      ...(sizeRange?.min === undefined ? {} : { minStuds: { width: sizeRange.min } }),
      ...(sizeRange?.max === undefined ? {} : { maxStuds: { width: sizeRange.max } }),
      ...(colourFacet ? { colors: [activeColor] } : {}),
    }),
    [activeColor, category, colourFacet, connectorFacet, offset, query, sizeRange, tier, catalogueState],
  )

  // A new query starts at the top of its own result set.
  useEffect(() => { setOffset(0); setCursor(-1) }, [query, category, tier, connectorFacet, sizeFacet, colourFacet])

  const shownRecords = useMemo<CatalogSearchRecord[]>(() => {
    if (activeSet === 'favourites') {
      return favourites.map((id) => catalog.describe(id)).filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    if (activeSet === 'recents') {
      return recents.map((id) => catalog.describe(id)).filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    if (activeSet) {
      const set = customPalettes.find((entry) => entry.id === activeSet)
      return (set?.partIds ?? []).map((id) => catalog.describe(id)).filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    return page.records
  }, [activeSet, customPalettes, favourites, page.records, recents])

  const remember = useCallback((record: CatalogSearchRecord) => {
    setRecents((current) => [record.id, ...current.filter((id) => id !== record.id)].slice(0, 24))
  }, [setRecents])

  const arm = useCallback((record: CatalogSearchRecord) => {
    remember(record)
    onArm(record)
  }, [onArm, remember])

  const add = useCallback((record: CatalogSearchRecord) => {
    remember(record)
    onAdd(record)
  }, [onAdd, remember])

  const toggleFavourite = useCallback((id: string) => {
    setFavourites((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
  }, [setFavourites])

  const toggleColourFavourite = useCallback((code: number) => {
    setColourFavourites((current) => (current.includes(code) ? current.filter((entry) => entry !== code) : [...current, code]))
  }, [setColourFavourites])

  /**
   * Keyboard-first search.
   *
   * The cursor lives in the search field and the arrow keys walk the results
   * without leaving it, so a part can be found and armed without the hand
   * moving to the pointer.
   */
  const onSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((value) => Math.min(shownRecords.length - 1, value + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((value) => Math.max(-1, value - 1))
    } else if (event.key === 'Enter') {
      const record = shownRecords[cursor] ?? shownRecords[0]
      if (!record) return
      event.preventDefault()
      if (event.shiftKey) add(record)
      else arm(record)
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      setQuery('')
    } else if (event.key === 'PageDown' && !activeSet) {
      event.preventDefault()
      setOffset((value) => (value + PAGE_SIZE < page.total ? value + PAGE_SIZE : value))
    } else if (event.key === 'PageUp' && !activeSet) {
      event.preventDefault()
      setOffset((value) => Math.max(0, value - PAGE_SIZE))
    }
  }, [activeSet, add, arm, cursor, page.total, query, shownRecords])

  useEffect(() => {
    if (cursor < 0) return
    const card = gridRef.current?.querySelectorAll('.part-card')[cursor]
    // Guarded because keeping the cursor visible is a nicety, and an
    // environment without `scrollIntoView` must not take the palette down.
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const tierHint = TIERS.find((entry) => entry.id === tier)!.hint
  const indexTotal = catalog.totalIdentityCount
  const facetCount = (connectorFacet === 'any' ? 0 : 1) + (sizeFacet === 'any' ? 0 : 1) + (colourFacet ? 1 : 0)
  const paletteColours = paletteOpen
    ? catalog.colors().map((color) => color.code)
    : [...new Set([...colourFavourites, ...DOCK_COLORS])]

  return (
    <aside className="panel catalog-panel" aria-label="Parts catalog">
      <div className="panel-heading">
        <div>
          {/* No eyebrow here. This panel already sits inside a dock labelled
              "Library" and a section labelled "Parts"; a third "BUILD LIBRARY"
              above "Parts catalog" named the same thing a fourth time. */}
          <h2>Parts catalog</h2>
        </div>
        <div className="palette-views" role="radiogroup" aria-label="Palette layout">
          {([['card', LayoutGrid, 'Cards'], ['compact', Rows3, 'Compact'], ['list', List, 'List']] as const).map(
            ([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={view === id}
                aria-label={`${label} view`}
                title={`${label} view`}
                className={view === id ? 'active' : ''}
                onClick={() => setView(id)}
              >
                <Icon size={12} />
              </button>
            ),
          )}
        </div>
        <span className="count-badge" title={`${page.total.toLocaleString()} identities match`}>
          {page.total > 999 ? `${Math.round(page.total / 1000)}k` : page.total}
        </span>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="2 x 4, slope, 3001, minifig head…"
          aria-label="Search parts"
          aria-keyshortcuts="Meta+K Control+K"
          aria-describedby="palette-keyboard-help"
          data-catalog-search
        />
        {query
          ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>
          : <kbd>⌘ K</kbd>}
      </label>
      <p id="palette-keyboard-help" className="visually-hidden">
        Arrow keys move through results, Enter arms the highlighted part for placement, Shift and Enter adds it
        immediately, Page Down and Page Up move between pages.
      </p>

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
            onClick={() => { setTier(entry.id); setActiveSet(null) }}
          >
            {entry.label}
            <em>{tierCount(page, entry.id, catalogueState)}</em>
          </button>
        ))}
      </div>

      <div className="category-row" role="tablist" aria-label="Part categories">
        {['All parts', ...categories].map((item) => (
          <button key={item} className={category === item ? 'active' : ''} onClick={() => { setCategory(item); setActiveSet(null) }} role="tab" aria-selected={category === item}>
            {item.replace('Windscreens', 'Glass')}
          </button>
        ))}
        <button
          className={`facet-toggle ${facetsOpen ? 'active' : ''}`}
          onClick={() => setFacetsOpen((value) => !value)}
          aria-expanded={facetsOpen}
          aria-controls="palette-facets"
          title="Filter by category, size, connector family and colour availability"
        >
          FILTERS{facetCount ? ` · ${facetCount}` : ''}
        </button>
      </div>

      {facetsOpen && (
        <div className="palette-facets" id="palette-facets">
          <label>
            <span>Category</span>
            <select value={category} onChange={(event) => { setCategory(event.target.value); setActiveSet(null) }}>
              <option value="All parts">All parts</option>
              {allCategories.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            <span>Footprint</span>
            <select value={sizeFacet} onChange={(event) => setSizeFacet(event.target.value)}>
              {SIZE_FACETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>
            <span>Connector</span>
            <select value={connectorFacet} onChange={(event) => setConnectorFacet(event.target.value as ConnectionFamily | 'any')}>
              <option value="any">Any connector</option>
              {CONNECTOR_FACETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <div className="facet-toggle-row">
            <button
              type="button"
              role="switch"
              aria-checked={colourFacet}
              className={colourFacet ? 'on' : ''}
              onClick={() => setColourFacet((value) => !value)}
            >
              <i />
            </button>
            <span>Only parts observed in {getColor(activeColor).name}</span>
          </div>
          {facetCount > 0 && (
            <button
              type="button"
              className="facet-clear"
              onClick={() => { setConnectorFacet('any'); setSizeFacet('any'); setColourFacet(false) }}
            >
              Clear {facetCount} filter{facetCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      <div className="palette-sets" role="tablist" aria-label="Saved part sets">
        <button role="tab" aria-selected={activeSet === null} className={activeSet === null ? 'active' : ''} onClick={() => setActiveSet(null)}>
          <Search size={10} /> RESULTS
        </button>
        <button
          role="tab"
          aria-selected={activeSet === 'favourites'}
          className={activeSet === 'favourites' ? 'active' : ''}
          onClick={() => setActiveSet('favourites')}
          disabled={!favourites.length}
          title={favourites.length ? `${favourites.length} favourites` : 'Star a part to add it here'}
        >
          <Star size={10} /> FAVOURITES <em>{favourites.length}</em>
        </button>
        <button
          role="tab"
          aria-selected={activeSet === 'recents'}
          className={activeSet === 'recents' ? 'active' : ''}
          onClick={() => setActiveSet('recents')}
          disabled={!recents.length}
          title={recents.length ? `${recents.length} recently placed` : 'Parts you place appear here'}
        >
          <Clock3 size={10} /> RECENT <em>{recents.length}</em>
        </button>
        {customPalettes.map((set) => (
          <button
            key={set.id}
            role="tab"
            aria-selected={activeSet === set.id}
            className={activeSet === set.id ? 'active' : ''}
            onClick={() => setActiveSet(set.id)}
          >
            {set.name} <em>{set.partIds.length}</em>
          </button>
        ))}
        <button
          className="palette-set-new"
          title="Save the current results as a named palette"
          aria-label="Save the current results as a named palette"
          disabled={!page.records.length}
          onClick={() => {
            const name = window.prompt('Name this palette', `Palette ${customPalettes.length + 1}`)
            if (!name) return
            setCustomPalettes((current) => [
              ...current.filter((entry) => entry.name !== name),
              { id: `set_${Date.now().toString(36)}`, name, partIds: page.records.slice(0, 40).map((record) => record.id) },
            ])
          }}
        >
          <Plus size={10} />
        </button>
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

      <div className={`parts-grid view-${view}`} data-testid="parts-grid" ref={gridRef}>
        {shownRecords.map((record, index) => (
          <article
            className={`part-card tier-${record.tier} ${record.geometryAvailable ? '' : 'unplaceable'} ${armedId === record.id ? 'armed' : ''} ${cursor === index ? 'cursor' : ''}`}
            key={record.id}
            title={describeRecord(record)}
            draggable={record.geometryAvailable}
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-brickwright-part', record.id)
              event.dataTransfer.setData('text/plain', record.id)
              event.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <button
              type="button"
              className="part-card-main"
              disabled={!record.geometryAvailable}
              onClick={() => arm(record)}
              onFocus={() => setCursor(index)}
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
              className={`part-favourite ${favourites.includes(record.id) ? 'on' : ''}`}
              aria-label={favourites.includes(record.id) ? `Remove ${record.name} from favourites` : `Add ${record.name} to favourites`}
              aria-pressed={favourites.includes(record.id)}
              onClick={() => toggleFavourite(record.id)}
            >
              <Star size={11} />
            </button>
            <button
              type="button"
              className={`part-add ${record.geometryAvailable ? '' : 'disabled'}`}
              aria-label={record.geometryAvailable ? `Add ${record.name}` : 'No compiled geometry'}
              title={record.geometryAvailable ? `Add ${record.name} straight onto the build` : TIER_LABEL[record.tier]}
              disabled={!record.geometryAvailable}
              onClick={() => add(record)}
            >
              {record.geometryAvailable ? <Plus size={13} /> : '—'}
            </button>
          </article>
        ))}

        {!shownRecords.length && (
          <div className="parts-empty">
            <SearchX size={20} strokeWidth={1.4} />
            <strong>
              {activeSet ? 'This set is empty' : `Nothing matches “${query || category}”`}
            </strong>
            <p>{activeSet ? 'Star parts, or place some, and they collect here.' : emptyExplanation(tier, catalogueState)}</p>
            {!activeSet && tier !== 'all' && (
              <button type="button" onClick={() => setTier('all')}>Search every identity</button>
            )}
            {!activeSet && !!query && <button type="button" onClick={() => setQuery('')}>Clear search</button>}
            {activeSet && <button type="button" onClick={() => setActiveSet(null)}>Back to results</button>}
          </div>
        )}
      </div>

      {!activeSet && page.total > PAGE_SIZE && (
        <nav className="parts-pager" aria-label="Catalogue pages">
          <button
            type="button"
            className="parts-more"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            aria-label="Previous page of results"
          >
            <ChevronLeft size={12} />
          </button>
          <span>
            {(offset + 1).toLocaleString()}–{Math.min(offset + page.records.length, page.total).toLocaleString()}
            {' of '}{page.total.toLocaleString()}
          </span>
          <button
            type="button"
            className="parts-more"
            disabled={offset + PAGE_SIZE >= page.total}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
            aria-label="Next page of results"
          >
            <ChevronRight size={12} />
          </button>
        </nav>
      )}

      <div className={`palette-dock ${paletteOpen ? 'expanded' : ''}`}>
        <div className="palette-label">
          <span>PROJECT PALETTE · {getColor(activeColor).name}</span>
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
          {paletteColours.map((code) => getColor(code)).map((color) => (
            <button
              key={color.code}
              className={`${activeColor === color.code ? 'selected' : ''} ${colourFavourites.includes(color.code) ? 'favourite' : ''}`}
              style={{ '--swatch': color.hex } as React.CSSProperties}
              onClick={() => onColorChange(color.code)}
              onContextMenu={(event) => { event.preventDefault(); toggleColourFavourite(color.code) }}
              aria-label={color.name}
              aria-pressed={activeColor === color.code}
              title={`${color.name} · LDraw ${color.code} · right-click to ${colourFavourites.includes(color.code) ? 'unpin' : 'pin'}`}
            >
              {colourFavourites.includes(color.code) ? <Check size={8} /> : null}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

/** Facet count for one tier, or the total across all of them. */
function tierCount(page: CatalogSearchPage, tier: CatalogTier | 'all', state: string): string {
  if (tier === 'catalogued' && state === 'idle') return '·'
  const value = tier === 'all'
    ? page.tiers.placeable + page.tiers.modelled + page.tiers.catalogued
    : page.tiers[tier]
  return value > 9999 ? `${Math.round(value / 1000)}k` : String(value)
}

export function describeRecord(record: CatalogSearchRecord): string {
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

export function emptyExplanation(tier: CatalogTier | 'all', state: string): string {
  if (state === 'loading') return 'The wider catalogue index is still loading.'
  if (state === 'failed') return 'The wider catalogue index could not be fetched, so only modelled identities were searched.'
  if (tier === 'placeable') {
    return `${catalog.placeableCount} of ${catalog.identityCount.toLocaleString()} modelled identities have compiled geometry in this build. Widen the tier to search the rest.`
  }
  if (tier === 'modelled') return 'No LDraw-modelled identity matches. The wider catalogue may still list it.'
  return 'No identity in the catalogue matches this search. Try a part number, a size like “2 x 4”, or a shape word like “slope”.'
}
