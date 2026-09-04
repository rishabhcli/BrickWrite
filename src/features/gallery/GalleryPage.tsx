import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { REPORT_REASONS, type Collection, type GalleryEntry, type ReportReason } from '../share/types'
import { GALLERY_SORTS, forkAncestry, resolveCollection, searchGallery, type GallerySort } from './curation'
import { PlateAtmosphere } from '../landing/plate'
import { usePointerField } from '../landing/reveal'
import './gallery.css'
import { useFocusTrap } from '../../platform/a11y'

/**
 * The public gallery.
 *
 * The thing this surface gets right, and the reason it is short: **empty means
 * empty**. There is no seeded creator, no placeholder tile, no "1.2k views" and
 * no sample collection. A new deployment shows a gallery with nothing in it and
 * says so in a sentence that explains what would put something there.
 *
 * Everything a tile shows is measured: the part count and step count come from
 * the published snapshot, the validation dot from the verdict recorded at
 * publication, the fork line from real provenance. Where a number does not
 * exist, no number is shown.
 */

export interface GalleryPageProps {
  /** Fetches a page of the public feed. */
  loadFeed?: (cursor: string | null) => Promise<{ entries: GalleryEntry[]; cursor: string | null }>
  loadCollections?: () => Promise<Collection[]>
  onReport?: (entry: GalleryEntry, reason: ReportReason, detail: string) => Promise<void>
  /** Pre-selects a tag, so `/gallery?tag=rover` lands filtered. */
  initialTag?: string | null
}

type FeedPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: GalleryEntry[]; cursor: string | null }
  | { kind: 'error'; message: string }

const defaultLoadFeed = async (cursor: string | null) => {
  const response = await fetch(`/publications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`The gallery feed returned ${response.status}.`)
  return (await response.json()) as { entries: GalleryEntry[]; cursor: string | null }
}

export default function GalleryPage({
  loadFeed = defaultLoadFeed,
  loadCollections,
  onReport,
  initialTag = null,
}: GalleryPageProps = {}) {
  const [phase, setPhase] = useState<FeedPhase>({ kind: 'loading' })
  const [collections, setCollections] = useState<Collection[]>([])
  const [text, setText] = useState('')
  const [tags, setTags] = useState<string[]>(initialTag ? [initialTag] : [])
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [sort, setSort] = useState<GallerySort>('newest')
  const [healthyOnly, setHealthyOnly] = useState(false)
  const [reporting, setReporting] = useState<GalleryEntry | null>(null)
  const pointer = usePointerField<HTMLDivElement>()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const page = await loadFeed(null)
        if (!cancelled) setPhase({ kind: 'ready', entries: page.entries, cursor: page.cursor })
      } catch (cause) {
        if (!cancelled) {
          setPhase({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadFeed])

  useEffect(() => {
    if (!loadCollections) return
    let cancelled = false
    void loadCollections()
      .then((list) => {
        if (!cancelled) setCollections(list)
      })
      // A collections failure must not take the gallery down: the feed is the
      // primary content and curation is an addition to it.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [loadCollections])

  const entries = phase.kind === 'ready' ? phase.entries : []
  const result = useMemo(
    () => searchGallery(entries, { text, tags, collectionId, sort, healthyOnly, limit: 60 }, collections),
    [entries, text, tags, collectionId, sort, healthyOnly, collections],
  )

  const loadMore = useCallback(async () => {
    if (phase.kind !== 'ready' || !phase.cursor) return
    try {
      const page = await loadFeed(phase.cursor)
      setPhase({ kind: 'ready', entries: [...phase.entries, ...page.entries], cursor: page.cursor })
    } catch (cause) {
      setPhase({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [phase, loadFeed])

  const toggleTag = useCallback((tag: string) => {
    setTags((current) => (current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag]))
  }, [])

  const activeCollection = collectionId ? collections.find((entry) => entry.id === collectionId) : undefined
  const collectionState = activeCollection ? resolveCollection(activeCollection, entries) : null

  return (
    <div
      ref={pointer.ref}
      className="bw-surface bw-gallery"
      data-testid="gallery"
      data-pointer={pointer.live ? 'live' : 'off'}
    >
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <div className="bw-gallery-head">
        <h1 className="bw-display x2">Gallery</h1>
      </div>

      <div className="bw-gallery-controls">
        <label className="bw-gallery-search">
          <span>Search</span>
          <input
            type="search"
            value={text}
            placeholder="rover, technic, a builder’s name…"
            data-testid="gallery-search"
            onChange={(event) => setText(event.target.value)}
          />
        </label>

        <details className="bw-gallery-filter-menu">
          <summary>
            Filter &amp; sort
            {tags.length > 0 || collectionId || healthyOnly ? <em>active</em> : null}
          </summary>
          <div className="bw-gallery-filter-panel">
            <label className="bw-gallery-select">
              <span>Sort</span>
              <select
                value={sort}
                data-testid="gallery-sort"
                onChange={(event) => setSort(event.target.value as GallerySort)}
              >
                {GALLERY_SORTS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="bw-gallery-check">
              <input
                type="checkbox"
                checked={healthyOnly}
                data-testid="gallery-healthy"
                onChange={(event) => setHealthyOnly(event.target.checked)}
              />
              Validated only
            </label>

            {collections.length > 0 ? (
              <nav className="bw-gallery-collections" aria-label="Curated collections">
                <button
                  type="button"
                  aria-pressed={collectionId === null}
                  className={collectionId === null ? 'is-active' : ''}
                  onClick={() => setCollectionId(null)}
                >
                  Everything
                </button>
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    aria-pressed={collectionId === collection.id}
                    className={collectionId === collection.id ? 'is-active' : ''}
                    onClick={() => setCollectionId(collection.id)}
                    data-testid={`collection-${collection.id}`}
                  >
                    {collection.title}
                  </button>
                ))}
              </nav>
            ) : null}

            {result.facets.length > 0 ? (
              <ul className="bw-gallery-facets" aria-label="Tags">
                {result.facets.slice(0, 24).map((facet) => (
                  <li key={facet.tag}>
                    <button
                      type="button"
                      aria-pressed={tags.includes(facet.tag)}
                      className={tags.includes(facet.tag) ? 'is-active' : ''}
                      onClick={() => toggleTag(facet.tag)}
                      data-testid={`facet-${facet.tag}`}
                    >
                      #{facet.tag}
                      <em>{facet.count}</em>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>
      </div>

      {activeCollection ? (
        <p className="bw-gallery-collection-note">
          {activeCollection.description} Curated by {activeCollection.curatedBy}.
          {collectionState && collectionState.missing > 0
            ? ` ${collectionState.missing} entr${collectionState.missing === 1 ? 'y is' : 'ies are'} no longer available.`
            : ''}
        </p>
      ) : null}

      {phase.kind === 'loading' ? (
        <p className="bw-gallery-state" aria-busy="true">
          Loading the gallery…
        </p>
      ) : phase.kind === 'error' ? (
        <p className="bw-gallery-state bw-gallery-error" role="alert" data-testid="gallery-error">
          The gallery could not be loaded: {phase.message}
        </p>
      ) : result.sourceEmpty ? (
        <div className="bw-gallery-state bw-gallery-empty" data-testid="gallery-empty">
          <h2>Nothing has been published yet</h2>
          <p>
            The gallery lists every published build, and there are none yet. It is not seeded with examples: a build
            publishes itself automatically once it reaches 25 parts, and until one does this page is honest about
            being empty.
          </p>
          <p>
            <a className="bw-gallery-action" href="/editor">
              Build something
            </a>
          </p>
        </div>
      ) : result.entries.length === 0 ? (
        <div className="bw-gallery-state" data-testid="gallery-no-matches">
          <h2>No published model matches that</h2>
          {result.unmatchedTerms.length > 0 ? (
            <p>Nothing here mentions {result.unmatchedTerms.map((term) => `“${term}”`).join(', ')}.</p>
          ) : (
            <p>Try removing a tag or the validated-only filter.</p>
          )}
        </div>
      ) : (
        <>
          <p className="bw-gallery-count" data-testid="gallery-count">
            {result.total} published model{result.total === 1 ? '' : 's'}
          </p>
          <ul className="bw-gallery-grid">
            {result.entries.map((entry) => (
              <li key={entry.slug}>
                <GalleryTile
                  entry={entry}
                  ancestry={forkAncestry(entries, entry.slug)}
                  onReport={onReport ? () => setReporting(entry) : undefined}
                />
              </li>
            ))}
          </ul>
          {phase.cursor ? (
            <button
              type="button"
              className="bw-gallery-more"
              onClick={() => void loadMore()}
              data-testid="gallery-more"
            >
              Load more
            </button>
          ) : null}
        </>
      )}

      {reporting && onReport ? (
        <ReportDialog entry={reporting} onClose={() => setReporting(null)} onSubmit={onReport} />
      ) : null}
    </div>
  )
}

function GalleryTile({
  entry,
  ancestry,
  onReport,
}: {
  entry: GalleryEntry
  ancestry: GalleryEntry[]
  onReport?: () => void
}) {
  return (
    <article className="bw-gallery-tile" data-testid={`tile-${entry.slug}`}>
      <a className="bw-gallery-thumb" href={`/share/${entry.slug}`}>
        {entry.cardPreset ? (
          <img
            src={`/share/${entry.slug}/card/${entry.cardPreset}.png`}
            alt={`${entry.title}, rendered at publication`}
            loading="lazy"
            width={600}
            height={600}
          />
        ) : (
          <span className="bw-gallery-nothumb">No render was captured</span>
        )}
      </a>
      <div className="bw-gallery-meta">
        <h3>
          <a href={`/share/${entry.slug}`}>{entry.title}</a>
        </h3>
        <p className="bw-gallery-byline">
          {entry.author ? entry.author.displayName : <span className="bw-gallery-absent">Author not stated</span>}
          {' · '}
          <time dateTime={entry.publishedAt}>{entry.publishedAt.slice(0, 10)}</time>
        </p>
        <p className="bw-gallery-figures">
          <span>{entry.partCount} parts</span>
          {entry.stepCount > 0 ? <span>{entry.stepCount} steps</span> : null}
          <span className={entry.healthy ? 'bw-gallery-ok' : 'bw-gallery-warn'}>
            {entry.healthy ? 'validated' : 'not validated'}
          </span>
        </p>
        {entry.forkedFromSlug ? (
          <p className="bw-gallery-fork" data-testid={`fork-of-${entry.slug}`}>
            Forked from <a href={`/share/${entry.forkedFromSlug}`}>{ancestry[0]?.title ?? entry.forkedFromSlug}</a>
            {ancestry.length > 1 ? ` · ${ancestry.length} generations back` : ''}
          </p>
        ) : null}
        {entry.tags.length > 0 ? (
          <ul className="bw-gallery-tags">
            {entry.tags.map((tag) => (
              <li key={tag}>#{tag}</li>
            ))}
          </ul>
        ) : null}
        {onReport ? (
          <button type="button" className="bw-gallery-report" onClick={onReport} data-testid={`report-${entry.slug}`}>
            Report
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ReportDialog({
  entry,
  onClose,
  onSubmit,
}: {
  entry: GalleryEntry
  onClose: () => void
  onSubmit: (entry: GalleryEntry, reason: ReportReason, detail: string) => Promise<void>
}) {
  const [reason, setReason] = useState<ReportReason>('infringement')
  const [detail, setDetail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const dialog = useFocusTrap(true, { onEscape: onClose })

  return (
    <div className="bw-gallery-dialog" role="presentation">
      <div
        ref={dialog as RefObject<HTMLDivElement>}
        className="bw-gallery-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Report ${entry.title}`}
      >
        <h2>Report “{entry.title}”</h2>
        {state === 'sent' ? (
          <>
            <p>Thank you. A person reviews every report; nothing is hidden automatically.</p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <label>
              Reason
              <select value={reason} onChange={(event) => setReason(event.target.value as ReportReason)}>
                {REPORT_REASONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              What is wrong?
              <textarea rows={4} value={detail} maxLength={1000} onChange={(event) => setDetail(event.target.value)} />
            </label>
            {error ? (
              <p className="bw-gallery-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="bw-gallery-dialog-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={state === 'sending'}
                data-testid="report-submit"
                onClick={() => {
                  setState('sending')
                  setError(null)
                  void onSubmit(entry, reason, detail)
                    .then(() => setState('sent'))
                    .catch((cause: unknown) => {
                      setState('error')
                      setError(cause instanceof Error ? cause.message : String(cause))
                    })
                }}
              >
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
