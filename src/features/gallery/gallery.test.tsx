import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareError, type Collection, type GalleryEntry, type ReportReason } from '../share/types'
import { galleryEntryFrom } from '../share/gallery-projection'
import { createPublication } from '../share/publish'
import { privateDocument, healthyValidation } from '../share/__fixtures__/model'
import { forkAncestry, forkChildren, resolveCollection, searchGallery } from './curation'
import { applyModeration, moderationQueue, resolveReport, submitReport } from './moderation'
import GalleryPage from './GalleryPage'

afterEach(cleanup)

/**
 * The gallery's most important property is negative: it must never show a
 * model, a creator, a collection or a number that nobody published. Several of
 * these tests exist purely to fail if a future change seeds anything.
 */

const entry = (overrides: Partial<GalleryEntry> = {}): GalleryEntry => ({
  publicationId: `pub_${overrides.slug ?? 'a'}`,
  slug: 'rover-a',
  title: 'Survey Rover',
  description: 'A rover.',
  tags: ['rover', 'technic'],
  author: { displayName: 'Rishabh Bansal', handle: null, url: null },
  publishedAt: '2026-08-20T00:00:00.000Z',
  partCount: 33,
  stepCount: 6,
  healthy: true,
  cardPreset: 'square',
  forkedFromSlug: null,
  ...overrides,
})

describe('gallery projection', () => {
  it('carries only measured facts — no engagement numbers exist to carry', async () => {
    const publication = await createPublication({
      document: privateDocument(5),
      validation: healthyValidation(5),
      title: 'Rover',
      tags: ['rover'],
    })
    const projected = galleryEntryFrom(publication)

    expect(Object.keys(projected).sort()).toEqual([
      'author',
      'cardPreset',
      'description',
      'forkedFromSlug',
      'healthy',
      'partCount',
      'publicationId',
      'publishedAt',
      'slug',
      'stepCount',
      'tags',
      'title',
    ])
    const serialised = JSON.stringify(projected).toLowerCase()
    for (const forbidden of ['view', 'like', 'star', 'trending', 'popular', 'score', 'rank']) {
      expect(serialised, `the tile carries a "${forbidden}" field`).not.toContain(`"${forbidden}`)
    }
    expect(projected.author).toBeNull()
  })

  it('reports no card rather than pointing at one that was never rendered', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    expect(galleryEntryFrom(publication).cardPreset).toBeNull()
  })
})

describe('search and facets', () => {
  const source = [
    entry({ slug: 'rover-a', title: 'Survey Rover', tags: ['rover', 'technic'], publishedAt: '2026-08-20T00:00:00.000Z', partCount: 33 }),
    entry({ slug: 'castle-b', title: 'Gatehouse', description: 'A castle gate.', tags: ['castle'], publishedAt: '2026-08-22T00:00:00.000Z', partCount: 210, healthy: false, author: null }),
    entry({ slug: 'rover-c', title: 'Micro Rover', tags: ['rover', 'micro'], publishedAt: '2026-08-18T00:00:00.000Z', partCount: 12, forkedFromSlug: 'rover-a' }),
  ]

  it('matches title, tag, description and author', () => {
    expect(searchGallery(source, { text: 'rover' }).entries.map((e) => e.slug).sort()).toEqual(['rover-a', 'rover-c'])
    expect(searchGallery(source, { text: 'gatehouse' }).entries.map((e) => e.slug)).toEqual(['castle-b'])
    expect(searchGallery(source, { text: 'Rishabh' }).entries).toHaveLength(2)
  })

  it('requires every tag, not any', () => {
    expect(searchGallery(source, { tags: ['rover', 'micro'] }).entries.map((e) => e.slug)).toEqual(['rover-c'])
    expect(searchGallery(source, { tags: ['rover', 'castle'] }).entries).toHaveLength(0)
  })

  it('names the terms that matched nothing', () => {
    const result = searchGallery(source, { text: 'spaceship rover' })
    expect(result.entries).toHaveLength(0)
    expect(result.unmatchedTerms).toEqual(['spaceship'])
  })

  it('distinguishes an empty source from a narrow query', () => {
    expect(searchGallery([], {}).sourceEmpty).toBe(true)
    expect(searchGallery(source, { text: 'nothing' }).sourceEmpty).toBe(false)
  })

  it('sorts by every documented order', () => {
    expect(searchGallery(source, { sort: 'newest' }).entries[0].slug).toBe('castle-b')
    expect(searchGallery(source, { sort: 'oldest' }).entries[0].slug).toBe('rover-c')
    expect(searchGallery(source, { sort: 'largest' }).entries[0].slug).toBe('castle-b')
    expect(searchGallery(source, { sort: 'smallest' }).entries[0].slug).toBe('rover-c')
    expect(searchGallery(source, { sort: 'title' }).entries[0].slug).toBe('castle-b')
  })

  it('filters to validated publications only', () => {
    expect(searchGallery(source, { healthyOnly: true }).entries.map((e) => e.slug).sort()).toEqual([
      'rover-a',
      'rover-c',
    ])
  })

  it('counts facets over the matched set, not the whole gallery', () => {
    const facets = searchGallery(source, { text: 'rover' }).facets
    expect(facets.find((facet) => facet.tag === 'rover')?.count).toBe(2)
    expect(facets.some((facet) => facet.tag === 'castle')).toBe(false)
  })

  it('pages', () => {
    const page = searchGallery(source, { limit: 2, offset: 1, sort: 'newest' })
    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(3)
    expect(page.offset).toBe(1)
  })

  it('tracks fork lineage from real provenance only', () => {
    expect(forkChildren(source, 'rover-a').map((e) => e.slug)).toEqual(['rover-c'])
    expect(forkAncestry(source, 'rover-c').map((e) => e.slug)).toEqual(['rover-a'])
    // A fork of something the gallery cannot see ends the chain rather than
    // inventing a parent.
    expect(forkAncestry([entry({ slug: 'x', forkedFromSlug: 'unlisted-thing' })], 'x')).toEqual([])
  })

  it('reports collection entries that are no longer available', () => {
    const collection: Collection = {
      id: 'staff',
      title: 'Staff picks',
      description: 'Chosen by hand.',
      curatedBy: 'Rishabh Bansal',
      updatedAt: '2026-08-24T00:00:00.000Z',
      slugs: ['rover-a', 'gone-b', 'rover-c'],
    }
    const resolved = resolveCollection(collection, source)
    expect(resolved.entries.map((e) => e.slug)).toEqual(['rover-a', 'rover-c'])
    expect(resolved.missing).toBe(1)
    expect(searchGallery(source, { collectionId: 'staff' }, [collection]).total).toBe(2)
  })
})

describe('moderation', () => {
  it('records a report without recording the reporter', () => {
    const report = submitReport({
      publicationId: 'pub_1',
      slug: 'rover-a',
      reason: 'infringement',
      detail: 'This is a copy of a licensed set.',
      reporterRef: 'a1b2c3d4e5f6a7b8',
      now: new Date('2026-08-25T00:00:00.000Z'),
    })
    expect(report).toMatchObject({ reason: 'infringement', status: 'open', reporterRef: 'a1b2c3d4e5f6a7b8' })
    expect(report.id).toMatch(/^rep_/)
  })

  it('refuses an identity in the reporter field', () => {
    expect(() =>
      submitReport({ publicationId: 'p', slug: 's', reason: 'spam', detail: 'x', reporterRef: 'me@example.com' }),
    ).toThrow(/opaque hash/)
  })

  it('refuses an unknown reason and an unexplained "other"', () => {
    expect(() => submitReport({ publicationId: 'p', slug: 's', reason: 'because', detail: 'x' })).toThrow(ShareError)
    expect(() => submitReport({ publicationId: 'p', slug: 's', reason: 'other', detail: 'bad' })).toThrow(/at least a sentence/)
  })

  it('sanitises the detail', () => {
    const report = submitReport({
      publicationId: 'p',
      slug: 's',
      reason: 'spam',
      detail: '<script>alert(1)</script>',
    })
    expect(report.detail).not.toContain('<')
  })

  it('hides rather than deletes, and records who decided and why', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    const hidden = applyModeration(publication, {
      status: 'hidden',
      reason: 'Infringing a licensed set.',
      now: new Date('2026-08-26T00:00:00.000Z'),
    })
    expect(hidden.moderation).toEqual({
      status: 'hidden',
      reason: 'Infringing a licensed set.',
      decidedAt: '2026-08-26T00:00:00.000Z',
    })
    // The snapshot survives moderation, so a wrongly-hidden publication can be
    // restored rather than re-created.
    expect(hidden.document).toEqual(publication.document)
    expect(hidden.contentHash).toBe(publication.contentHash)
  })

  it('orders the queue by how many people reported the same thing', () => {
    const reports = [
      submitReport({ publicationId: 'p1', slug: 'a', reason: 'spam', detail: 'x' }),
      submitReport({ publicationId: 'p2', slug: 'b', reason: 'spam', detail: 'x' }),
      submitReport({ publicationId: 'p2', slug: 'b', reason: 'impersonation', detail: 'y' }),
    ]
    const queue = moderationQueue(reports)
    expect(queue[0].slug).toBe('b')
    expect(queue[0].reports).toHaveLength(2)
    expect(moderationQueue(reports.map((report) => resolveReport(report, 'dismissed')))).toEqual([])
  })
})

describe('gallery page', () => {
  it('says the gallery is empty rather than showing anything', async () => {
    render(<GalleryPage loadFeed={async () => ({ entries: [], cursor: null })} />)
    await waitFor(() => expect(screen.getByTestId('gallery-empty')).toBeInTheDocument())
    expect(screen.getByText(/Nothing has been published yet/)).toBeInTheDocument()
    expect(screen.getByText(/It is not seeded with examples/)).toBeInTheDocument()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('renders only what the feed returned', async () => {
    render(
      <GalleryPage
        loadFeed={async () => ({ entries: [entry(), entry({ slug: 'rover-c', title: 'Micro Rover' })], cursor: null })}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('gallery-count')).toHaveTextContent('2 published models'))
    expect(screen.getByTestId('tile-rover-a')).toBeInTheDocument()
    expect(screen.getByTestId('tile-rover-c')).toBeInTheDocument()
    expect(screen.queryByTestId('gallery-empty')).toBeNull()
  })

  it('filters by search and by facet, and explains an empty result', async () => {
    render(<GalleryPage loadFeed={async () => ({ entries: [entry(), entry({ slug: 'castle-b', title: 'Gatehouse', description: 'A castle gate.', tags: ['castle'] })], cursor: null })} />)
    await waitFor(() => expect(screen.getByTestId('gallery-count')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'gatehouse' } })
    expect(screen.getByTestId('tile-castle-b')).toBeInTheDocument()
    expect(screen.queryByTestId('tile-rover-a')).toBeNull()

    fireEvent.change(screen.getByTestId('gallery-search'), { target: { value: 'submarine' } })
    expect(screen.getByTestId('gallery-no-matches')).toHaveTextContent('submarine')
  })

  it('shows fork provenance on a tile', async () => {
    render(
      <GalleryPage
        loadFeed={async () => ({
          entries: [entry(), entry({ slug: 'rover-c', title: 'Micro Rover', forkedFromSlug: 'rover-a' })],
          cursor: null,
        })}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('fork-of-rover-c')).toBeInTheDocument())
    expect(screen.getByTestId('fork-of-rover-c')).toHaveTextContent('Survey Rover')
  })

  it('says "Author not stated" rather than filling in a creator', async () => {
    render(<GalleryPage loadFeed={async () => ({ entries: [entry({ author: null })], cursor: null })} />)
    await waitFor(() => expect(screen.getByText('Author not stated')).toBeInTheDocument())
  })

  it('surfaces a feed failure instead of pretending the gallery is empty', async () => {
    render(
      <GalleryPage
        loadFeed={async () => {
          throw new Error('the feed returned 503')
        }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('gallery-error')).toHaveTextContent('503'))
    expect(screen.queryByTestId('gallery-empty')).toBeNull()
  })

  it('shows no collection rail until a curator has made one', async () => {
    render(<GalleryPage loadFeed={async () => ({ entries: [entry()], cursor: null })} loadCollections={async () => []} />)
    await waitFor(() => expect(screen.getByTestId('gallery-count')).toBeInTheDocument())
    expect(screen.queryByRole('navigation', { name: 'Curated collections' })).toBeNull()
  })

  it('submits a report through the host', async () => {
    const onReport = vi.fn(async (_entry: GalleryEntry, _reason: ReportReason, _detail: string) => undefined)
    render(<GalleryPage loadFeed={async () => ({ entries: [entry()], cursor: null })} onReport={onReport} />)
    await waitFor(() => expect(screen.getByTestId('report-rover-a')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('report-rover-a'))
    expect(document.querySelector('.bw-gallery-dialog')).toHaveAttribute('role', 'presentation')
    expect(screen.getByRole('dialog', { name: /Report Survey Rover/ })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(onReport).toHaveBeenCalledTimes(1))
    expect(onReport.mock.calls[0][1]).toBe('infringement')
  })
})
