import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  Search,
  SearchX,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { catalog, getColor, searchCatalogPage } from '../../cad/catalog'
import { geometryCache } from '../../cad/mesh'
import { externalCatalogueAvailable, loadExternalCatalogue } from '../../cad/catalog-loader'
import type { CatalogSearchPage, CatalogSearchRecord, CatalogTier, ConnectionFamily } from '../../cad/types'
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

/**
 * Two, not three.
 *
 * There used to be a `compact` between these, presented in a radiogroup as if
 * the three were a density ladder. They were not: cards lay out in two columns,
 * compact in *three* and list in one, so the middle rung of the ladder was the
 * widest of the three. Compact was also the only one that hid the part id —
 * the option you could not give a reason for choosing, doing the one thing none
 * of the others did. Grid for browsing, list for scanning; the key is bumped to
 * v2 so anyone holding the third lands back on the default. */
export type PaletteView = 'card' | 'list'

const TIERS: Array<{ id: CatalogTier | 'all'; label: string; hint: string }> = [
  { id: 'placeable', label: 'BUILDABLE', hint: 'Compiled geometry and connectors — these can be placed.' },
  {
    id: 'modelled',
    label: 'MODELLED',
    hint: 'LDraw models the shape and connections, but this build carries no mesh.',
  },
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
  if (!thumbnail)
    return (
      <div className="part-glyph empty" aria-hidden>
        <span />
      </div>
    )
  return (
    <div className="part-thumb" aria-hidden>
      <span
        className="thumb-tint"
        style={{ '--part-color': color, '--thumb': `url(${thumbnail.file})` } as React.CSSProperties}
      />
      <img
        className="thumb-shade"
        src={thumbnail.file}
        alt=""
        width={thumbnail.size}
        height={thumbnail.size}
        loading="lazy"
        /* An image is natively draggable. Pressing one and moving hands the
         * pointer to the browser's own drag-and-drop, which fires
         * pointercancel — and that killed the card's pointer drag on the very
         * first move, so dragging a part into the viewport did nothing at all
         * while clicking the card and then clicking the grid still worked. */
        draggable={false}
      />
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
  onDragPart?: (record: CatalogSearchRecord) => boolean
  onDropPart?: (record: CatalogSearchRecord, clientX: number, clientY: number) => boolean
  onDragEnd?: () => void
}

/**
 * Memoised, because this panel is the most expensive thing in the shell and
 * almost nothing it draws depends on the model.
 *
 * `useWorkbench` subscribes to the kernel with no selector, so every commit —
 * including a commit that only changed the selection — replaces the snapshot
 * and re-renders the whole shell. That re-rendered sixty part cards, each with
 * its own preview, plus the three-hundred-and-twenty-two-entry colour table,
 * on every click in the viewport, every camera move and every tool switch, to
 * produce identical output each time.
 *
 * The two props that matter are primitives, and the six callbacks below them
 * reduce — through `armPart` and `buildPartAt` — to `activeColor`, `gridLdu`
 * and two `useCallback`s over empty dependency arrays. None of them closes over
 * the snapshot, which is the whole reason the default shallow comparison is the
 * correct one here: a selection commit re-renders the shell and hands this
 * panel the identical eight props, so it stops.
 *
 * That is a contract, not a property of the code as written, and adding a
 * dependency to any of those callbacks would quietly dissolve it. `palette
 * re-rendering` in panels.test.tsx asserts both halves — that the shell really
 * does re-render on a selection-only commit, and that the props survive it.
 */
export const PalettePanel = memo(function PalettePanel({ activeColor, armedId, onColorChange, onAdd, onArm, onDragPart, onDropPart, onDragEnd }: PalettePanelProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All parts')
  const [tier, setTier] = useState<CatalogTier | 'all'>('placeable')
  const [offset, setOffset] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [facetsOpen, setFacetsOpen] = useState(false)
  const [connectorFacet, setConnectorFacet] = useState<ConnectionFamily | 'any'>('any')
  const [sizeFacet, setSizeFacet] = useState('any')
  const [colourFacet, setColourFacet] = useState(false)
  const [view, setView] = usePersistentState<PaletteView>('palette.view.v2', 'card')
  const [favourites, setFavourites] = usePersistentState<string[]>('palette.favourites.v1', [])
  const [recents, setRecents] = usePersistentState<string[]>('palette.recents.v1', [])
  const [colourFavourites, setColourFavourites] = usePersistentState<number[]>('palette.colours.v1', [])
  const [customPalettes, setCustomPalettes] = usePersistentState<CustomPalette[]>('palette.sets.v1', [])
  const [activeSet, setActiveSet] = useState<string | null>(null)
  const [cursor, setCursor] = useState(-1)
  const [catalogueState, setCatalogueState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(() =>
    catalog.catalogueLoaded ? 'ready' : 'idle',
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pointerDrag = useRef<{
    record: CatalogSearchRecord
    pointerId: number
    startX: number
    startY: number
    active: boolean
  } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const remember = useCallback(
    (record: CatalogSearchRecord) => {
      setRecents((current) => [record.id, ...current.filter((id) => id !== record.id)].slice(0, 24))
    },
    [setRecents],
  )

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = pointerDrag.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) {
        if (onDragPart?.(drag.record) === false) {
          pointerDrag.current = null
          return
        }
        drag.active = true
        setDraggingId(drag.record.id)
        document.body.classList.add('part-dragging')
        remember(drag.record)
      }
      if (!drag.active) return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('brickwright:part-drag', {
        detail: { clientX: event.clientX, clientY: event.clientY },
      }))
    }
    const end = (event: PointerEvent) => {
      const drag = pointerDrag.current
      if (!drag || drag.pointerId !== event.pointerId) return
      pointerDrag.current = null
      document.body.classList.remove('part-dragging')
      setDraggingId(null)
      if (!drag.active) return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      if (!target?.closest('.viewport-shell') || !onDropPart?.(drag.record, event.clientX, event.clientY)) onDragEnd?.()
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.body.classList.remove('part-dragging')
    }
  }, [onDragEnd, onDragPart, onDropPart, remember])

  const categories = useMemo(() => {
    // Categories that actually contain placeable parts, most populous first.
    const counts = new Map<string, number>()
    for (const part of catalog.placeable()) counts.set(part.category, (counts.get(part.category) ?? 0) + 1)
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([name]) => name)
  }, [])

  const allCategories = useMemo(() => catalog.categories, [])

  /**
   * Reaching past the modelled library pulls the wider catalogue in once.
   *
   * It is seven megabytes, so it is not fetched on boot; asking for a tier that
   * needs it is the signal that the session actually wants it. A failed fetch
   * must be retryable from the panel: the loader already drops a poisoned
   * promise, but without a control the operator has to leave the tier and come
   * back, which reads as the index being gone rather than briefly unreachable.
   */
  const catalogueRequest = useRef(0)
  const reloadCatalogue = useCallback(() => {
    if (catalog.catalogueLoaded || !externalCatalogueAvailable()) {
      setCatalogueState(catalog.catalogueLoaded ? 'ready' : 'idle')
      return
    }
    const request = ++catalogueRequest.current
    setCatalogueState('loading')
    loadExternalCatalogue()
      .then(() => {
        if (catalogueRequest.current === request) setCatalogueState('ready')
      })
      .catch(() => {
        if (catalogueRequest.current === request) setCatalogueState('failed')
      })
  }, [])

  useEffect(() => {
    if (tier !== 'catalogued' && tier !== 'all') return
    reloadCatalogue()
  }, [reloadCatalogue, tier])

  const sizeRange = SIZE_FACETS.find((entry) => entry.id === sizeFacet)

  const page = useMemo<CatalogSearchPage>(
    () =>
      searchCatalogPage({
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
  useEffect(() => {
    setOffset(0)
    setCursor(-1)
  }, [query, category, tier, connectorFacet, sizeFacet, colourFacet])

  const shownRecords = useMemo<CatalogSearchRecord[]>(() => {
    if (activeSet === 'favourites') {
      return favourites
        .map((id) => catalog.describe(id))
        .filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    if (activeSet === 'recents') {
      return recents.map((id) => catalog.describe(id)).filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    if (activeSet) {
      const set = customPalettes.find((entry) => entry.id === activeSet)
      return (set?.partIds ?? [])
        .map((id) => catalog.describe(id))
        .filter((entry): entry is CatalogSearchRecord => Boolean(entry))
    }
    return page.records
  }, [activeSet, customPalettes, favourites, page.records, recents])

  // Warm only visible cards, not the whole catalogue. The actual shape is ready
  // before pickup, including on a cold page and when scrolling to another row.
  useEffect(() => {
    if (!gridRef.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const id = (entry.target as HTMLElement).dataset.partId
        const definition = id ? catalog.get(id) : undefined
        if (definition) void geometryCache.load(definition)
        observer.unobserve(entry.target)
      }
    }, { root: gridRef.current, rootMargin: '100px' })
    gridRef.current.querySelectorAll('[data-part-id]').forEach((card) => observer.observe(card))
    return () => observer.disconnect()
  }, [shownRecords])



  const arm = useCallback(
    (record: CatalogSearchRecord) => {
      remember(record)
      onArm(record)
    },
    [onArm, remember],
  )

  const add = useCallback(
    (record: CatalogSearchRecord) => {
      remember(record)
      onAdd(record)
    },
    [onAdd, remember],
  )

  const toggleFavourite = useCallback(
    (id: string) => {
      setFavourites((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
    },
    [setFavourites],
  )

  const toggleColourFavourite = useCallback(
    (code: number) => {
      setColourFavourites((current) =>
        current.includes(code) ? current.filter((entry) => entry !== code) : [...current, code],
      )
    },
    [setColourFavourites],
  )

  /**
   * Keyboard-first search.
   *
   * The cursor lives in the search field and the arrow keys walk the results
   * without leaving it, so a part can be found and armed without the hand
   * moving to the pointer.
   */
  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
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
    },
    [activeSet, add, arm, cursor, page.total, query, shownRecords],
  )

  useEffect(() => {
    if (cursor < 0) return
    const card = gridRef.current?.querySelectorAll('.part-card')[cursor]
    // Guarded because keeping the cursor visible is a nicety, and an
    // environment without `scrollIntoView` must not take the palette down.
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const tierHint = TIERS.find((entry) => entry.id === tier)!.hint
  const facetCount = (connectorFacet === 'any' ? 0 : 1) + (sizeFacet === 'any' ? 0 : 1) + (colourFacet ? 1 : 0)
  const advancedCount = facetCount + (tier === 'placeable' ? 0 : 1) + (activeSet ? 1 : 0)
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
          <h2>Parts</h2>
        </div>
        <div className="palette-views" role="radiogroup" aria-label="Palette layout">
          {(
            [
              ['card', LayoutGrid, 'Cards'],
              ['list', List, 'List'],
            ] as const
          ).map(([id, Icon, label]) => (
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
          ))}
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
          placeholder="Search parts…"
          aria-label="Search parts"
          aria-keyshortcuts="Meta+K Control+K"
          aria-describedby="palette-keyboard-help"
          data-catalog-search
        />
        {query ? (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        ) : null}
      </label>
      <p id="palette-keyboard-help" className="visually-hidden">
        Arrow keys move through results, Enter arms the highlighted part for placement, Shift and Enter adds it
        immediately, Page Down and Page Up move between pages.
      </p>

      <div className="category-row" role="tablist" aria-label="Part categories">
        {['All parts', ...categories].map((item) => (
          <button
            key={item}
            type="button"
            className={category === item ? 'active' : ''}
            onClick={() => {
              setCategory(item)
              setActiveSet(null)
            }}
            role="tab"
            aria-selected={category === item}
          >
            {item.replace('Windscreens', 'Glass')}
          </button>
        ))}
        <button
          type="button"
          className={`facet-toggle ${facetsOpen ? 'active' : ''}`}
          onClick={() => setFacetsOpen((value) => !value)}
          aria-expanded={facetsOpen}
          aria-controls="palette-facets"
          title="Filter by category, size, connector family and colour availability"
          aria-label="FILTERS"
        >
          <SlidersHorizontal size={13} />{advancedCount ? ` ${advancedCount}` : ''}
        </button>
      </div>

      {facetsOpen && (
        <div className="palette-facets" id="palette-facets">
          <div className="tier-row" role="tablist" aria-label="Catalog knowledge tier">
            {TIERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tier === entry.id}
                className={tier === entry.id ? 'active' : ''}
                title={entry.hint}
                onClick={() => {
                  setTier(entry.id)
                  setActiveSet(null)
                }}
              >
                {entry.label}
                <em>{tierCount(page, entry.id, catalogueState)}</em>
              </button>
            ))}
          </div>
          <label>
            <span>Category</span>
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value)
                setActiveSet(null)
              }}
            >
              <option value="All parts">All parts</option>
              {allCategories.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Footprint</span>
            <select value={sizeFacet} onChange={(event) => setSizeFacet(event.target.value)}>
              {SIZE_FACETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Connector</span>
            <select
              value={connectorFacet}
              onChange={(event) => setConnectorFacet(event.target.value as ConnectionFamily | 'any')}
            >
              <option value="any">Any connector</option>
              {CONNECTOR_FACETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
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
              onClick={() => {
                setConnectorFacet('any')
                setSizeFacet('any')
                setColourFacet(false)
              }}
            >
              Clear {facetCount} filter{facetCount === 1 ? '' : 's'}
            </button>
          )}
          <div className="palette-sets" role="tablist" aria-label="Saved part sets">
            <button
              type="button"
              role="tab"
              aria-selected={activeSet === null}
              className={activeSet === null ? 'active' : ''}
              onClick={() => setActiveSet(null)}
            >
              <Search size={10} /> RESULTS
            </button>
            <button
              type="button"
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
              type="button"
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
                type="button"
                role="tab"
                aria-selected={activeSet === set.id}
                className={activeSet === set.id ? 'active' : ''}
                onClick={() => setActiveSet(set.id)}
              >
                {set.name} <em>{set.partIds.length}</em>
              </button>
            ))}
            <button
              type="button"
              className="palette-set-new"
              title="Save the current results as a named palette"
              aria-label="Save the current results as a named palette"
              disabled={!page.records.length}
              onClick={() => {
                const name = window.prompt('Name this palette', `Palette ${customPalettes.length + 1}`)
                if (!name) return
                setCustomPalettes((current) => [
                  ...current.filter((entry) => entry.name !== name),
                  {
                    id: `set_${Date.now().toString(36)}`,
                    name,
                    partIds: page.records.slice(0, 40).map((record) => record.id),
                  },
                ])
              }}
            >
              <Plus size={10} />
            </button>
          </div>
        </div>
      )}

      <div className="catalog-meta" title={tierHint}>
        {catalogueState === 'loading' && (
          <span className="catalog-loading">
            <LoaderCircle size={10} /> indexing the wider catalogue
          </span>
        )}
        {catalogueState === 'failed' && (
          <span className="catalog-failed" role="alert">
            <CircleAlert size={10} /> catalogue index unavailable
            <button type="button" className="catalog-retry" onClick={reloadCatalogue}>
              Retry
            </button>
          </span>
        )}
      </div>

      <div className={`parts-grid view-${view}`} data-testid="parts-grid" ref={gridRef}>
        {shownRecords.map((record, index) => (
          <article
            className={`part-card tier-${record.tier} ${record.geometryAvailable ? '' : 'unplaceable'} ${armedId === record.id ? 'armed' : ''} ${draggingId === record.id ? 'dragging' : ''} ${cursor === index ? 'cursor' : ''}`}
            key={record.id}
            data-part-id={record.id}
            title={describeRecord(record)}
            onPointerDown={(event) => {
              if (!record.geometryAvailable || event.button !== 0) return
              pointerDrag.current = {
                record,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
              }
            }}
            onPointerEnter={() => {
              const definition = catalog.get(record.id)
              if (definition) void geometryCache.load(definition)
            }}
          >
            <button
              type="button"
              className="part-card-main"
              disabled={!record.geometryAvailable}
              onClick={() => arm(record)}
              onFocus={() => setCursor(index)}
              aria-pressed={armedId === record.id}
              aria-label={
                record.geometryAvailable
                  ? `Pick up ${record.name} to place in the viewport`
                  : `${record.name}: ${TIER_LABEL[record.tier]}`
              }
            >
              <PartPreview record={record} color={getColor(activeColor).hex} />
              <div className="part-copy">
                <strong>{record.name.replace(/^(Brick|Plate|Tile|Slope) /, '')}</strong>
                <span>
                  {record.id}
                  {record.dimensions
                    ? ` · ${record.dimensions[0]}×${record.dimensions[2]}`
                    : ` · ${TIER_LABEL[record.tier]}`}
                </span>
              </div>
            </button>
            <button
              type="button"
              className={`part-favourite ${favourites.includes(record.id) ? 'on' : ''}`}
              aria-label={
                favourites.includes(record.id)
                  ? `Remove ${record.name} from favourites`
                  : `Add ${record.name} to favourites`
              }
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
            <strong>{activeSet ? 'This set is empty' : `Nothing matches “${query || category}”`}</strong>
            <p>
              {activeSet ? 'Star parts, or place some, and they collect here.' : emptyExplanation(tier, catalogueState)}
            </p>
            {!activeSet && tier !== 'all' && (
              <button type="button" onClick={() => setTier('all')}>
                Search every identity
              </button>
            )}
            {!activeSet && catalogueState === 'failed' && (
              <button type="button" onClick={reloadCatalogue}>
                Retry the catalogue
              </button>
            )}
            {!activeSet && !!query && (
              <button type="button" onClick={() => setQuery('')}>
                Clear search
              </button>
            )}
            {activeSet && (
              <button type="button" onClick={() => setActiveSet(null)}>
                Back to results
              </button>
            )}
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
            {' of '}
            {page.total.toLocaleString()}
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
          <span>{getColor(activeColor).name}</span>
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
          {paletteColours
            .map((code) => getColor(code))
            .map((color) => (
              <button
                key={color.code}
                type="button"
                className={`${activeColor === color.code ? 'selected' : ''} ${colourFavourites.includes(color.code) ? 'favourite' : ''}`}
                style={{ '--swatch': color.hex } as React.CSSProperties}
                onClick={() => onColorChange(color.code)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  toggleColourFavourite(color.code)
                }}
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
})

/** Facet count for one tier, or the total across all of them. */
function tierCount(page: CatalogSearchPage, tier: CatalogTier | 'all', state: string): string {
  // Not "zero" and not a bug: this tier's size is only known once a search has
  // run. An em dash is the ordinary way a table says "no value here"; the
  // interpunct that used to sit here read as a glyph that had failed to render.
  if (tier === 'catalogued' && state === 'idle') return '—'
  const value = tier === 'all' ? page.tiers.placeable + page.tiers.modelled + page.tiers.catalogued : page.tiers[tier]
  return value > 9999 ? `${Math.round(value / 1000)}k` : String(value)
}

export function describeRecord(record: CatalogSearchRecord): string {
  const appearances = record.frequency
    ? `${record.frequency.toLocaleString()} official set appearance${record.frequency === 1 ? '' : 's'}`
    : 'no recorded set appearances'
  if (record.tier === 'placeable')
    return `Pick up ${record.name} and click in the viewport to place it · ${appearances}`
  if (record.tier === 'modelled') {
    return `${record.name} is modelled by LDraw, but this build has no compiled geometry for it, so it cannot be placed · ${appearances}`
  }
  const variant = record.variantOf ? ` · a variant of design ${record.variantOf}` : ''
  const material = record.material ? ` · ${record.material}` : ''
  return `${record.name} is a real catalogued part with no LDraw model, so nothing about its shape is known here · ${appearances}${variant}${material}`
}

export function emptyExplanation(tier: CatalogTier | 'all', state: string): string {
  if (state === 'loading') return 'The wider catalogue index is still loading.'
  if (state === 'failed')
    return 'The wider catalogue index could not be fetched, so only modelled identities were searched.'
  if (tier === 'placeable') {
    return `${catalog.placeableCount} of ${catalog.identityCount.toLocaleString()} modelled identities have compiled geometry in this build. Widen the tier to search the rest.`
  }
  if (tier === 'modelled') return 'No LDraw-modelled identity matches. The wider catalogue may still list it.'
  return 'No identity in the catalogue matches this search. Try a part number, a size like “2 x 4”, or a shape word like “slope”.'
}
