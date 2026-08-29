import { beforeEach, describe, expect, it, vi } from 'vitest'

const cad = vi.hoisted(() => ({
  loads: 0,
  sessionStarts: 0,
  preloads: [] as string[][],
  failNext: false,
  opened: [] as string[],
  created: 0,
  openFails: false,
}))

vi.mock('../cad/catalog-loader', () => ({
  loadCompiledCatalog: vi.fn(async () => {
    cad.loads += 1
    if (cad.failNext) throw new Error('catalog/latest.json → 404 Not Found')
    return {
      version: 'test',
      identityCount: 3,
      placeableCount: 2,
      colorCount: 1,
      connectorCount: 4,
      aliasCount: 0,
      externalIdentityCount: 0,
    }
  }),
  preloadDocumentGeometry: vi.fn(async (ids: Iterable<string>) => {
    cad.preloads.push([...ids])
  }),
}))

vi.mock('../cad/engine', () => ({
  cadEngine: { getDocument: () => ({ parts: { a: { definitionId: '3001' }, b: { definitionId: '3020' } } }) },
}))

vi.mock('../cad/session', () => ({
  session: {
    start: vi.fn(async () => {
      cad.sessionStarts += 1
    }),
    openProject: vi.fn(async (projectId: string) => {
      cad.opened.push(projectId)
      if (cad.openFails) return { ok: false, message: 'That project is no longer in local storage.' }
      return { ok: true }
    }),
    createProject: vi.fn(async () => {
      cad.created += 1
      return { ok: true }
    }),
  },
}))

const {
  BootCancelledError,
  BootLevelError,
  applyEditorQuery,
  bootForRoute,
  bootLevelRank,
  bootTo,
  consumeSearchParams,
  isBooting,
  peekBootStage,
  requireCatalogStage,
  requireEditorStage,
  resetBoot,
} = await import('./boot')

describe('staged boot', () => {
  beforeEach(() => {
    resetBoot()
    cad.loads = 0
    cad.sessionStarts = 0
    cad.preloads = []
    cad.failNext = false
    cad.opened = []
    cad.created = 0
    cad.openFails = false
    window.history.replaceState(null, '', '/')
  })

  it('honours ?doc=blank and ?project= after restore, before paint', async () => {
    const session = await import('../cad/session')
    await applyEditorQuery(session, '?doc=blank')
    expect(cad.created).toBe(1)
    expect(cad.opened).toEqual([])
    await applyEditorQuery(session, '?project=doc_rover')
    expect(cad.opened).toEqual(['doc_rover'])
  })

  it('strips one-shot editor query keys from the live address bar', async () => {
    const session = await import('../cad/session')
    window.history.replaceState(null, '', '/editor?doc=blank&intent=describe')
    await applyEditorQuery(session)
    expect(cad.created).toBe(1)
    expect(window.location.pathname).toBe('/editor')
    expect(window.location.search).toBe('?intent=describe')
    consumeSearchParams(['intent'])
    expect(window.location.search).toBe('')
  })

  it('keeps ?project= when open fails so a refresh can retry', async () => {
    const session = await import('../cad/session')
    cad.openFails = true
    window.history.replaceState(null, '', '/editor?project=doc_missing&doc=blank')
    const result = await applyEditorQuery(session)
    expect(result).toEqual({
      applied: 'project',
      ok: false,
      message: 'That project is no longer in local storage.',
    })
    expect(cad.opened).toEqual(['doc_missing'])
    expect(cad.created).toBe(0)
    expect(window.location.search).toBe('?project=doc_missing')
  })

  it('strips leftover ?doc=blank when opening a project succeeds', async () => {
    const session = await import('../cad/session')
    window.history.replaceState(null, '', '/editor?project=doc_rover&doc=blank')
    const result = await applyEditorQuery(session)
    expect(result).toEqual({ applied: 'project', ok: true })
    expect(window.location.search).toBe('')
  })

  it('boots "none" without touching the CAD kernel at all', async () => {
    const stage = await bootTo('none')
    expect(stage).toEqual({ level: 'none' })
    expect(cad.loads).toBe(0)
    expect(cad.sessionStarts).toBe(0)
  })

  it('boots "catalog" to the compiled catalog only', async () => {
    const stage = await bootTo('catalog')
    expect(stage.level).toBe('catalog')
    expect(stage).toMatchObject({ catalog: { version: 'test', placeableCount: 2 } })
    expect(cad.loads).toBe(1)
    expect(cad.sessionStarts).toBe(0)
  })

  it('boots "editor" to catalog, kernel, session and warmed geometry', async () => {
    const stage = await bootTo('editor')
    expect(stage.level).toBe('editor')
    expect(cad.loads).toBe(1)
    expect(cad.sessionStarts).toBe(1)
    expect(cad.preloads).toEqual([['3001', '3020']])
  })

  it('shares one catalog fetch across levels and repeated calls', async () => {
    const [a, b] = await Promise.all([bootTo('catalog'), bootTo('catalog')])
    expect(a).toBe(b)
    await bootTo('editor')
    await bootTo('editor')
    expect(cad.loads).toBe(1)
    expect(cad.sessionStarts).toBe(1)
  })

  it('is re-entrant: a settled level resolves without restarting work', async () => {
    await bootTo('catalog')
    expect(isBooting('catalog')).toBe(false)
    expect(peekBootStage('catalog')).toMatchObject({ level: 'catalog' })
    await bootTo('catalog')
    expect(cad.loads).toBe(1)
  })

  it('never reports a stage it has not reached', () => {
    expect(peekBootStage('catalog')).toBeNull()
    expect(peekBootStage('none')).toEqual({ level: 'none' })
  })

  it('cancels the caller without cancelling the shared work', async () => {
    const controller = new AbortController()
    const cancelled = bootTo('catalog', { signal: controller.signal })
    controller.abort()
    await expect(cancelled).rejects.toBeInstanceOf(BootCancelledError)
    // The shared boot still completes, so the next caller pays nothing.
    const stage = await bootTo('catalog')
    expect(stage.level).toBe('catalog')
    expect(cad.loads).toBe(1)
  })

  it('rejects immediately when handed an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(bootTo('catalog', { signal: controller.signal })).rejects.toBeInstanceOf(BootCancelledError)
  })

  it('lets a failed boot be retried', async () => {
    cad.failNext = true
    await expect(bootTo('catalog')).rejects.toThrow('404 Not Found')
    cad.failNext = false
    const stage = await bootTo('catalog')
    expect(stage.level).toBe('catalog')
    expect(cad.loads).toBe(2)
  })

  it('derives the level from the route declaration, not from the surface', async () => {
    const stage = await bootForRoute({
      id: 'landing',
      path: '/',
      boot: 'none',
      load: async () => ({ default: () => null }),
    })
    expect(stage.level).toBe('none')
    expect(cad.loads).toBe(0)
  })

  it('refuses to hand a surface capabilities its route did not declare', async () => {
    const none = await bootTo('none')
    expect(() => requireCatalogStage(none)).toThrow(BootLevelError)
    expect(() => requireEditorStage(none)).toThrow(BootLevelError)

    const catalog = await bootTo('catalog')
    expect(requireCatalogStage(catalog)).toBe(catalog)
    expect(() => requireEditorStage(catalog)).toThrow(/route declares "catalog"/)
  })

  it('orders levels so "at least" comparisons are expressible', () => {
    expect(bootLevelRank('none')).toBeLessThan(bootLevelRank('catalog'))
    expect(bootLevelRank('catalog')).toBeLessThan(bootLevelRank('editor'))
  })
})
