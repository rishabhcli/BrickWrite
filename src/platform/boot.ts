import type { CatalogLoadResult } from '../cad/catalog-loader'
import type { RouteModule } from './contracts'

/**
 * Staged boot.
 *
 * The compiled catalog must be resident before any CAD module evaluates, so
 * everything below the kernel is loaded dynamically after the fetch resolves.
 * That constraint used to belong to the whole application: `main.tsx` fetched
 * the catalog, started the session and warmed geometry before anything painted.
 * With a marketing route, a gallery and an account page in the same bundle,
 * paying that cost to read a landing page is indefensible — so the cost is now
 * staged, and the stage is a property of the route, not of the application.
 *
 * There is still no procedural fallback catalog. If the compiled assets are
 * missing, a route that declared it needs them says so and refuses to start,
 * rather than rendering invented parts.
 *
 * A route cannot opt itself into a deeper stage. The shell derives the level
 * from the route registry and hands the surface a {@link BootStage} whose shape
 * *is* that level: a `boot: 'catalog'` surface is given an object with no engine
 * and no session on it, so reaching for the kernel is a type error rather than
 * a runtime surprise.
 */

export type BootLevel = 'none' | 'catalog' | 'editor'

type EngineModule = typeof import('../cad/engine')
type SessionModule = typeof import('../cad/session')

export interface BootStageNone {
  level: 'none'
}

export interface BootStageCatalog {
  level: 'catalog'
  catalog: CatalogLoadResult
}

export interface BootStageEditor {
  level: 'editor'
  catalog: CatalogLoadResult
  engine: EngineModule
  session: SessionModule
}

export type BootStage = BootStageNone | BootStageCatalog | BootStageEditor

const BOOT_RANK: Record<BootLevel, number> = { none: 0, catalog: 1, editor: 2 }

/** Ordering helper, so "at least catalog" is expressible without string maths. */
export function bootLevelRank(level: BootLevel): number {
  return BOOT_RANK[level]
}

/** Raised when a caller abandons a boot it was waiting on. */
export class BootCancelledError extends Error {
  constructor(readonly level: BootLevel) {
    super(`Boot to "${level}" was cancelled before it finished.`)
    this.name = 'BootCancelledError'
  }
}

/** Raised when a surface asks for a capability its route did not declare. */
export class BootLevelError extends Error {
  constructor(readonly required: BootLevel, readonly actual: BootLevel) {
    super(
      `This surface asked for the "${required}" boot stage but its route declares "${actual}". ` +
        'Raise the route\'s `boot` field in src/platform/routes.ts — a surface cannot widen its ' +
        'own stage, because that is what keeps the marketing routes free of the CAD kernel.',
    )
    this.name = 'BootLevelError'
  }
}

const NONE: BootStageNone = Object.freeze({ level: 'none' })

/**
 * In-flight and settled boots, keyed by level.
 *
 * Shared so a second route at the same level joins the first boot instead of
 * refetching, and re-entrant so React 19 StrictMode's double effect does not
 * start the kernel twice.
 */
const inFlight = new Map<BootLevel, Promise<BootStage>>()
const settled = new Map<BootLevel, BootStage>()

/** Held so the editor stage can warm geometry without importing the loader again. */
let catalogLoaderModule: typeof import('../cad/catalog-loader') | null = null

async function loadCatalogStage(): Promise<BootStageCatalog> {
  const loader = await import('../cad/catalog-loader')
  catalogLoaderModule = loader
  const catalog = await loader.loadCompiledCatalog()
  return { level: 'catalog', catalog }
}

/**
 * Strip one-shot editor query keys from the live address bar.
 *
 * `?doc=blank` and `?project=` take effect once at boot. Leaving them in the
 * URL would create another untitled project (or re-open the same one) on every
 * refresh. `?intent=describe` is consumed by the workbench after it reveals
 * the generate panel, so it is not stripped here.
 */
export function consumeSearchParams(keys: readonly string[]): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const key of keys) {
    if (!url.searchParams.has(key)) continue
    url.searchParams.delete(key)
    changed = true
  }
  if (!changed) return
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function normalisedSearch(search: string): string {
  if (!search) return ''
  return search.startsWith('?') ? search : `?${search}`
}

function appliedLiveQuery(appliedSearch: string): boolean {
  if (typeof window === 'undefined') return false
  return normalisedSearch(appliedSearch) === normalisedSearch(window.location.search)
}

export type EditorQueryApplication =
  | { applied: 'none' }
  | { applied: 'blank' | 'project'; ok: true }
  | { applied: 'blank' | 'project'; ok: false; message: string }

/**
 * Honours `/editor` query flags after restore, before the workbench paints.
 *
 * `?project=` opens that stored project. `?doc=blank` starts an empty document
 * instead of the showcase. Plain `/editor` still restores the newest project.
 * Applied here rather than in the React tree so the showcase cannot flash.
 * One-shot keys are then stripped from the live URL so a refresh cannot repeat
 * the action. A failed open keeps `?project=` so a refresh can retry, and still
 * drops `?doc=blank` so the two flags cannot combine into a later blank create.
 */
export async function applyEditorQuery(
  session: SessionModule,
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): Promise<EditorQueryApplication> {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const projectId = query.get('project')
  if (projectId) {
    const opened = await session.session.openProject(projectId)
    if (appliedLiveQuery(search)) {
      if (opened.ok) consumeSearchParams(['project', 'doc'])
      else consumeSearchParams(['doc'])
    }
    return opened.ok
      ? { applied: 'project', ok: true }
      : { applied: 'project', ok: false, message: opened.message ?? 'That project could not be opened.' }
  }
  if (query.get('doc') === 'blank') {
    const created = await session.session.createProject()
    if (!created.ok) {
      return { applied: 'blank', ok: false, message: created.message ?? 'A blank project could not be created.' }
    }
    if (appliedLiveQuery(search)) consumeSearchParams(['doc'])
    return { applied: 'blank', ok: true }
  }
  return { applied: 'none' }
}

async function loadEditorStage(): Promise<BootStageEditor> {
  // Reuses the cached catalog promise, so `/editor` after `/explore` pays the
  // fetch once even though the two routes declare different stages.
  const catalogStage = (await start('catalog')) as BootStageCatalog
  const [engine, session] = await Promise.all([import('../cad/engine'), import('../cad/session')])
  // Restore the operator's own project *before* the editor mounts, so their
  // work never flashes past behind an empty document.
  await session.session.start()
  await applyEditorQuery(session)
  // Warm the geometry that document needs so the first painted frame shows real
  // meshes instead of streaming placeholders.
  const loader = catalogLoaderModule ?? (await import('../cad/catalog-loader'))
  await loader.preloadDocumentGeometry(
    Object.values(engine.cadEngine.getDocument().parts).map((part) => part.definitionId),
  )
  return { level: 'editor', catalog: catalogStage.catalog, engine, session }
}

function start(level: BootLevel): Promise<BootStage> {
  if (level === 'none') return Promise.resolve(NONE)
  const done = settled.get(level)
  if (done) return Promise.resolve(done)
  const existing = inFlight.get(level)
  if (existing) return existing

  const work: Promise<BootStage> = level === 'catalog' ? loadCatalogStage() : loadEditorStage()
  const tracked = work.then(
    (stage) => {
      settled.set(level, stage)
      inFlight.delete(level)
      return stage
    },
    (cause: unknown) => {
      // A failed boot must be retryable: the error screen's recovery action
      // simply asks again, and a poisoned promise would make that a lie.
      inFlight.delete(level)
      throw cause
    },
  )
  inFlight.set(level, tracked)
  return tracked
}

export interface BootOptions {
  /**
   * Abandons *this caller's* wait.
   *
   * The underlying fetch and imports are shared and keep running — a half-loaded
   * catalog is worse than a finished one nobody looked at — so aborting rejects
   * the returned promise with {@link BootCancelledError} and leaves the shared
   * work to complete for whoever asks next.
   */
  signal?: AbortSignal
}

/** Boot to a level. Cached, shared, re-entrant and cancellable per caller. */
export function bootTo(level: BootLevel, options: BootOptions = {}): Promise<BootStage> {
  const { signal } = options
  const work = start(level)
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new BootCancelledError(level))
  return new Promise<BootStage>((resolve, reject) => {
    const onAbort = () => reject(new BootCancelledError(level))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Boot for a route.
 *
 * The only entry point the shell uses. The level comes from the registry entry,
 * never from the surface, which is the structural half of "a route cannot opt
 * itself into more than its declared level".
 */
export function bootForRoute(route: RouteModule, options: BootOptions = {}): Promise<BootStage> {
  return bootTo(route.boot, options)
}

/** The already-completed stage for a level, or null. Never starts work. */
export function peekBootStage(level: BootLevel): BootStage | null {
  if (level === 'none') return NONE
  return settled.get(level) ?? null
}

/** Whether a boot at this level is currently running. */
export function isBooting(level: BootLevel): boolean {
  return inFlight.has(level)
}

/**
 * Forget every cached stage.
 *
 * Used by tests and by the shell's recovery action after a boot failure that a
 * retry alone would not clear.
 */
export function resetBoot(): void {
  inFlight.clear()
  settled.clear()
  catalogLoaderModule = null
}

/** Narrow a stage to at least catalog, or explain the misdeclaration. */
export function requireCatalogStage(stage: BootStage): BootStageCatalog | BootStageEditor {
  if (stage.level === 'none') throw new BootLevelError('catalog', stage.level)
  return stage
}

/** Narrow a stage to the editor, or explain the misdeclaration. */
export function requireEditorStage(stage: BootStage): BootStageEditor {
  if (stage.level !== 'editor') throw new BootLevelError('editor', stage.level)
  return stage
}
