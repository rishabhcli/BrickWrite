import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate: the browse index is not in front of the editor's first frame.
 *
 * `search.json` is 433,579 B gzip and ~24 ms of main-thread sha256 + parse +
 * index-build on the shipped `2026-07` catalog. Nothing on the path to painting
 * a restored document reads it — `catalog.get()`, the colour table and LDraw
 * rename resolution all come from the parts tier — so `/editor` must reach
 * `ready` while it is still in flight, and `/explore` must not.
 *
 * Asserted by starvation rather than by timing: the index load here never
 * settles until the test releases it. A boot that awaited it would hang, and a
 * hang is a failure that cannot pass by accident on a fast machine.
 */

const loader = vi.hoisted(() => ({
  placeableLoads: 0,
  fullLoads: 0,
  searchLoads: 0,
  releaseSearch: null as null | (() => void),
  failSearch: null as null | ((cause: Error) => void),
}))

const RESULT = {
  version: 'test',
  identityCount: 22941,
  placeableCount: 900,
  colorCount: 322,
  connectorCount: 324331,
  aliasCount: 1150,
  externalIdentityCount: 58833,
}

vi.mock('../cad/catalog-loader', () => ({
  loadPlaceableCatalog: vi.fn(async () => {
    loader.placeableLoads += 1
    return RESULT
  }),
  loadSearchIndex: vi.fn(() => {
    loader.searchLoads += 1
    return new Promise<number>((resolve, reject) => {
      loader.releaseSearch = () => resolve(22941)
      loader.failSearch = (cause: Error) => reject(cause)
    })
  }),
  loadCompiledCatalog: vi.fn(async () => {
    loader.fullLoads += 1
    return RESULT
  }),
  preloadDocumentGeometry: vi.fn(async () => {}),
}))

vi.mock('../cad/engine', () => ({
  cadEngine: { getDocument: () => ({ parts: { a: { definitionId: '3001' } } }) },
}))

vi.mock('../cad/session', () => ({
  session: { start: vi.fn(async () => {}), openProject: vi.fn(), createProject: vi.fn() },
}))

const {
  bootPhaseMs,
  bootTimeline,
  bootTo,
  catalogLoaderSupportsNarrowedLoad,
  isBooting,
  resetBoot,
  searchIndexHandle,
} = await import('./boot')

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Turn until the index load has actually been reached, or give up loudly.
 *
 * A fixed number of turns would make these assertions depend on how loaded the
 * machine is, and "the boot got further than expected because the box was busy"
 * is not a defect worth reporting as one. The deadline exists to produce a
 * readable failure, never to measure anything.
 */
const untilIndexRequested = async () => {
  const deadline = Date.now() + 10_000
  while (!loader.releaseSearch && Date.now() < deadline) await turn()
  if (!loader.releaseSearch) throw new Error('the browse index was never requested')
}

describe('parts tier and browse index are separate rungs', () => {
  beforeEach(() => {
    resetBoot()
    loader.placeableLoads = 0
    loader.fullLoads = 0
    loader.searchLoads = 0
    loader.releaseSearch = null
    loader.failSearch = null
    window.history.replaceState(null, '', '/')
  })

  it('uses the narrowed load when the loader offers it', async () => {
    expect(catalogLoaderSupportsNarrowedLoad()).toBeNull()
    await bootTo('parts')
    expect(catalogLoaderSupportsNarrowedLoad()).toBe(true)
    expect(loader.placeableLoads).toBe(1)
    expect(loader.fullLoads).toBe(0)
  })

  it('reaches the editor stage while the browse index is still in flight', async () => {
    const stage = await bootTo('editor')
    expect(stage.level).toBe('editor')
    // Started, so the index is on its way and not waiting for a first search…
    expect(loader.searchLoads).toBe(1)
    // …and not awaited, so it is genuinely not resident at the moment the
    // surface is handed the stage.
    expect(stage.level !== 'none' && stage.searchIndex.ready).toBe(false)
    expect(searchIndexHandle().ready).toBe(false)

    loader.releaseSearch!()
    await searchIndexHandle().whenReady()
    expect(searchIndexHandle().ready).toBe(true)
  })

  it('holds the catalog stage until the browse index is resident', async () => {
    let resolved = false
    const boot = bootTo('catalog').then((stage) => {
      resolved = true
      return stage
    })
    await untilIndexRequested()
    expect(resolved, 'a catalog-level surface may not be handed an index that has not arrived').toBe(false)
    expect(isBooting('catalog')).toBe(true)

    loader.releaseSearch!()
    const stage = await boot
    expect(stage.level).toBe('catalog')
    expect(stage.level !== 'none' && stage.searchIndex.ready).toBe(true)
  })

  it('shares one parts load and one index load across both levels', async () => {
    const editor = bootTo('editor')
    const catalog = bootTo('catalog')
    await editor
    loader.releaseSearch!()
    await catalog
    expect(loader.placeableLoads).toBe(1)
    expect(loader.searchLoads).toBe(1)
  })

  it('keeps a failed index retryable and does not fail the editor with it', async () => {
    const stage = await bootTo('editor')
    expect(stage.level).toBe('editor')

    loader.failSearch!(new Error('search.json → 503 Service Unavailable'))
    await expect(searchIndexHandle().whenReady()).rejects.toThrow('503')
    expect(searchIndexHandle().ready).toBe(false)
    expect(searchIndexHandle().error?.message).toContain('503')

    // A second ask is a fresh attempt, not a replay of the failure.
    loader.releaseSearch = null
    const retry = searchIndexHandle().whenReady()
    await untilIndexRequested()
    loader.releaseSearch!()
    await retry
    expect(searchIndexHandle().ready).toBe(true)
    expect(searchIndexHandle().error).toBeNull()
    expect(loader.searchLoads).toBe(2)
  })

  it('records a timeline that names what the gate spent its time on', async () => {
    await bootTo('editor')
    const names = bootTimeline().map((entry) => entry.name)
    expect(names).toContain('loader.module')
    expect(names).toContain('catalog.parts')
    expect(names).toContain('kernel.module')
    expect(names).toContain('session.restore')
    expect(names).toContain('geometry.preload')
    expect(names).toContain('stage.editor')
    // The index is in flight, so its phase has not closed yet — which is the
    // timeline saying the same thing the assertions above say.
    expect(names).not.toContain('catalog.search')
    expect(bootPhaseMs('catalog.parts')).toBeGreaterThanOrEqual(0)

    loader.releaseSearch!()
    await searchIndexHandle().whenReady()
    expect(bootTimeline().map((entry) => entry.name)).toContain('catalog.search')
  })
})
