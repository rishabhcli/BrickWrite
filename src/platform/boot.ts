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
 * *is* that level: a `boot: 'parts'` surface is given an object with no engine
 * and no session on it, so reaching for the kernel is a type error rather than
 * a runtime surprise.
 *
 * ## Why there are four levels and not three
 *
 * The compiled catalog is two separable things, and only one of them can paint
 * a document. Measured on an M3 Max against the shipped `2026-07` catalog, with
 * the bytes already in the HTTP cache — the "every boot, not just the first"
 * case:
 *
 * | asset          | on the wire (gzip) | sha256 + decode + `JSON.parse` |
 * |----------------|--------------------|--------------------------------|
 * | `parts.json`   |          349,280 B |                         9.5 ms |
 * | `colors.json`  |            4,204 B |                         0.4 ms |
 * | `aliases.json` |            6,449 B |                         0.5 ms |
 * | `search.json`  |      **433,579 B** |                    **11.4 ms** |
 *
 * plus `catalog.install()`, which is 0.3 ms for the parts tier alone and
 * 12.7 ms once the 22,941-entry browse index has to be built.
 *
 * `parts`/`colors`/`aliases` are what `catalog.get()`, the renderer's colour
 * table and LDraw rename resolution read, so they are what geometry needs.
 * `search.json` backs *searching and browsing*. Nothing on the path to the
 * first painted frame of a restored document touches it, yet awaiting it put
 * 423 KiB and ~24 ms of main-thread work in front of that frame on every
 * `/editor` boot. So it is its own level, and `editor` sits on `parts`.
 *
 * ## The honesty rule this preserves
 *
 * A surface is never handed a catalog it cannot rely on. That is why the browse
 * index is not simply dropped from the `editor` stage and left implicit: the
 * stage carries a {@link SearchIndexHandle} that says, in the type, that the
 * index is a promise rather than a fact. `boot: 'catalog'` still means the index
 * is resident *before* the surface mounts, because `/explore`, `/share` and
 * `/projects` exist to answer "is this a real part?" and may not answer it from
 * an index that has not arrived.
 */

export type BootLevel = 'none' | 'parts' | 'catalog' | 'editor'

type EngineModule = typeof import('../cad/engine')
type SessionModule = typeof import('../cad/session')
type CatalogLoaderModule = typeof import('../cad/catalog-loader')

/**
 * The browse index's residency, handed to every surface above `none`.
 *
 * Read `ready` to render an honest intermediate state; `throw whenReady()` to
 * suspend until the index can be trusted. A rejected load is retryable: calling
 * `whenReady()` again starts a fresh attempt rather than replaying the failure,
 * so a dropped connection does not make search permanently unavailable for the
 * rest of the session.
 */
export interface SearchIndexHandle {
  /** True once `catalog.search`, `catalog.describe` and `catalog.categories` are authoritative. */
  readonly ready: boolean
  /** Why the last attempt failed, or null. */
  readonly error: Error | null
  /** Resolves when the index is resident. Rejects if the attempt failed. */
  whenReady(): Promise<void>
}

export interface BootStageNone {
  level: 'none'
}

/**
 * Part identity, geometry and colour — everything needed to place and paint.
 *
 * Deliberately *not* searchable: `searchIndex.ready` may be false here.
 */
export interface BootStageParts {
  level: 'parts'
  catalog: CatalogLoadResult
  searchIndex: SearchIndexHandle
}

/** The parts tier plus a resident browse index: `searchIndex.ready` is true. */
export interface BootStageCatalog {
  level: 'catalog'
  catalog: CatalogLoadResult
  searchIndex: SearchIndexHandle
}

/**
 * The parts tier, the kernel, the session and warmed geometry.
 *
 * The browse index is *in flight*, not awaited. Anything that reads it must go
 * through `searchIndex` rather than assuming it is there.
 */
export interface BootStageEditor {
  level: 'editor'
  catalog: CatalogLoadResult
  searchIndex: SearchIndexHandle
  engine: EngineModule
  session: SessionModule
}

export type BootStage = BootStageNone | BootStageParts | BootStageCatalog | BootStageEditor

/** Any stage that has the compiled parts tier resident. */
export type BootStageWithCatalog = BootStageParts | BootStageCatalog | BootStageEditor

const BOOT_RANK: Record<BootLevel, number> = { none: 0, parts: 1, catalog: 2, editor: 3 }

/**
 * Ordering helper, so "at least parts" is expressible without string maths.
 *
 * The rank orders *machinery*, not capability: `editor` outranks `catalog`
 * because it additionally loads the kernel, the session and warmed geometry —
 * it does not imply a resident browse index. That one fact is carried by
 * {@link SearchIndexHandle} precisely because it is not monotonic in the rank.
 */
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

/* --- Timeline ------------------------------------------------------------ */

/**
 * Every phase the boot can spend time in, named so a timeline reads as prose.
 *
 * These are also emitted as `performance.measure` entries under the
 * {@link BOOT_MEASURE_PREFIX} namespace, so a devtools performance recording
 * shows the same breakdown as {@link bootTimeline} without any extra wiring.
 */
export type BootPhaseName =
  | 'loader.module'
  | 'catalog.parts'
  | 'catalog.search'
  | 'kernel.module'
  | 'session.restore'
  | 'session.query'
  | 'geometry.preload'
  | 'stage.parts'
  | 'stage.catalog'
  | 'stage.editor'

export interface BootPhase {
  name: BootPhaseName
  /** `performance.now()` when the phase began. */
  startedAt: number
  durationMs: number
  ok: boolean
}

export const BOOT_MEASURE_PREFIX = 'brickwright:boot'

const timeline: BootPhase[] = []

const clock = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

function mark(name: string): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(name)
  } catch {
    // User Timing is a diagnostic, never a dependency: a browser that refuses
    // a mark must not be able to fail a boot.
  }
}

function measure(name: string, start: string, end: string): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    performance.measure(name, start, end)
  } catch {
    // As above.
  }
}

/**
 * Time one phase, recording it whether it succeeds or throws.
 *
 * A failed phase is kept in the timeline with `ok: false`, because "the boot
 * spent 4 s in `catalog.parts` and then failed" is the most useful thing the
 * timeline can say and dropping it would leave a gap that reads as speed.
 */
async function phase<T>(name: BootPhaseName, work: () => Promise<T>): Promise<T> {
  const startedAt = clock()
  const startMark = `${BOOT_MEASURE_PREFIX}:${name}:start`
  mark(startMark)
  let ok = false
  try {
    const value = await work()
    ok = true
    return value
  } finally {
    const endMark = `${BOOT_MEASURE_PREFIX}:${name}:end`
    mark(endMark)
    measure(`${BOOT_MEASURE_PREFIX}:${name}`, startMark, endMark)
    timeline.push({ name, startedAt, durationMs: clock() - startedAt, ok })
  }
}

/**
 * What the boot actually spent its time on, in completion order.
 *
 * Exposed rather than logged so the shell can report it as telemetry and a
 * developer can read it from the console without a rebuild. Phases that ran
 * concurrently overlap in `startedAt`; that overlap is the point — it is how you
 * see that the browse index is no longer in front of the first frame.
 */
export function bootTimeline(): readonly BootPhase[] {
  return timeline
}

/** Total time in one phase across every boot so far, or 0 if it never ran. */
export function bootPhaseMs(name: BootPhaseName): number {
  return timeline.reduce((total, entry) => (entry.name === name ? total + entry.durationMs : total), 0)
}

/* --- The loader seam ----------------------------------------------------- */

/**
 * The narrowed loader entry points this contract wants.
 *
 * `src/cad/catalog-loader.ts` is owned by the CAD workstream, and the split
 * between "the parts tier" and "the browse index" is its call to make. This
 * module therefore *asks* for the narrowed pair and falls back to the single
 * all-or-nothing `loadCompiledCatalog()` when the loader has not adopted it —
 * so the boot contract below is correct either way, and the day the loader
 * lands the split, `/editor` stops waiting for 423 KiB it does not need without
 * a second commit here.
 *
 * The fallback is not a silent degradation: with one call there is nothing to
 * defer, `searchIndex.ready` is true the moment the stage resolves, and every
 * guarantee still holds. It is just slower, which is exactly what it was
 * before.
 */
interface NarrowedCatalogLoader {
  /** Parts, colours and aliases only. Installs the parts tier. */
  loadPlaceableCatalog(baseUrl?: string): Promise<CatalogLoadResult>
  /** The browse index, installed additively on top of the parts tier. */
  loadSearchIndex(): Promise<number>
}

const NARROWED_EXPORTS = ['loadPlaceableCatalog', 'loadSearchIndex'] as const

/**
 * `in` rather than `typeof loader.x`, deliberately.
 *
 * Presence is the question, and `in` is the operator that asks it about a
 * module namespace. Reading a missing export off one is also not universally
 * benign: Vitest's module mocker throws on the read to catch a partial mock,
 * so probing by property access would make this function's answer depend on
 * whether it is under test.
 */
function narrowedLoader(loader: CatalogLoaderModule): NarrowedCatalogLoader | null {
  if (!NARROWED_EXPORTS.every((name) => name in loader)) return null
  const candidate = loader as CatalogLoaderModule & Partial<NarrowedCatalogLoader>
  if (typeof candidate.loadPlaceableCatalog !== 'function') return null
  if (typeof candidate.loadSearchIndex !== 'function') return null
  return candidate as NarrowedCatalogLoader
}

/**
 * Whether the loader in this build can separate the parts tier from the index.
 *
 * Null until the loader chunk has been imported. Exposed for the test that
 * proves both paths are exercised rather than one of them being dead code.
 */
export function catalogLoaderSupportsNarrowedLoad(): boolean | null {
  return catalogLoaderModule === null ? null : narrowedLoader(catalogLoaderModule) !== null
}

/* --- Search index residency --------------------------------------------- */

class SearchIndex implements SearchIndexHandle {
  private resident = false
  private failure: Error | null = null
  private attempt: Promise<void> | null = null

  constructor(private readonly load: (() => Promise<unknown>) | null) {
    // No load function means the loader installed the index as part of the
    // parts tier, so it is already resident and there is nothing to await.
    this.resident = load === null
  }

  get ready(): boolean {
    return this.resident
  }

  get error(): Error | null {
    return this.failure
  }

  whenReady(): Promise<void> {
    if (this.resident) return Promise.resolve()
    const load = this.load
    if (!load) return Promise.resolve()
    this.attempt ??= phase('catalog.search', load).then(
      () => {
        this.resident = true
        this.failure = null
      },
      (cause: unknown) => {
        // Retryable, not poisoned: search going missing for one flaky fetch
        // must not mean search is gone for the session.
        this.attempt = null
        this.failure = cause instanceof Error ? cause : new Error(String(cause))
        throw this.failure
      },
    )
    return this.attempt
  }

  /** Start the fetch without joining the wait. Used by the `editor` stage. */
  warm(): void {
    // The rejection is observed here so an unawaited failure cannot surface as
    // an unhandled rejection; `whenReady()` still sees it through `failure`.
    void this.whenReady().catch(() => {})
  }
}

const RESIDENT = new SearchIndex(null)

/* --- Stages -------------------------------------------------------------- */

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
let catalogLoaderModule: CatalogLoaderModule | null = null

/** The one handle every stage above `none` shares, so residency is one fact. */
let searchIndex: SearchIndex = RESIDENT

async function loadPartsStage(): Promise<BootStageParts> {
  const loader = await phase('loader.module', async () => import('../cad/catalog-loader'))
  catalogLoaderModule = loader
  const narrowed = narrowedLoader(loader)
  if (!narrowed) {
    // One indivisible load: the index arrives with the parts tier whether the
    // gate wants it or not, so it is resident and nothing is deferred.
    const catalog = await phase('catalog.parts', () => loader.loadCompiledCatalog())
    searchIndex = RESIDENT
    return { level: 'parts', catalog, searchIndex }
  }
  const index = new SearchIndex(() => narrowed.loadSearchIndex())
  searchIndex = index
  const catalog = await phase('catalog.parts', () => narrowed.loadPlaceableCatalog())
  return { level: 'parts', catalog, searchIndex: index }
}

async function loadCatalogStage(): Promise<BootStageCatalog> {
  const parts = (await start('parts')) as BootStageParts
  // The only level that awaits the browse index. `/explore`, `/share` and
  // `/projects` exist to say whether a part is real; they may not answer from
  // an index that has not arrived.
  await parts.searchIndex.whenReady()
  return { level: 'catalog', catalog: parts.catalog, searchIndex: parts.searchIndex }
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
  | { applied: 'blank' | 'project' | 'showcase'; ok: true }
  | { applied: 'blank' | 'project' | 'showcase'; ok: false; message: string }

/**
 * Honours `/editor` query flags after restore, before the workbench paints.
 *
 * `?project=` opens that stored project. `?doc=blank` starts an empty document
 * instead of the showcase. `?doc=showcase` opens a fresh copy of the showcase
 * as its own project, which is the only way to reach it once this profile has
 * projects of its own — restore prefers the operator's work, as it should.
 * Plain `/editor` still restores the newest project.
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
  if (query.get('doc') === 'showcase') {
    const { createShowcaseDocument } = await import('../cad/sample')
    const opened = await session.session.importDocument(createShowcaseDocument())
    if (!opened.ok) {
      return { applied: 'showcase', ok: false, message: opened.message ?? 'The showcase could not be opened.' }
    }
    if (appliedLiveQuery(search)) consumeSearchParams(['doc'])
    return { applied: 'showcase', ok: true }
  }
  return { applied: 'none' }
}

async function loadEditorStage(): Promise<BootStageEditor> {
  // Reuses the cached parts promise, so `/editor` after `/explore` pays the
  // fetch once even though the two routes declare different stages.
  const partsStage = (await start('parts')) as BootStageParts
  // The browse index is *started* here and awaited by nobody on this path. A
  // surface that needs it reaches for `searchIndex`, which is the whole reason
  // that handle exists rather than a bare boolean.
  searchIndex.warm()
  const [engine, session] = await phase('kernel.module', () =>
    Promise.all([import('../cad/engine'), import('../cad/session')]),
  )
  // Restore the operator's own project *before* the editor mounts, so their
  // work never flashes past behind an empty document.
  await phase('session.restore', () => session.session.start())
  await phase('session.query', () => applyEditorQuery(session))
  // Warm the geometry that document needs so the first painted frame shows real
  // meshes instead of streaming placeholders.
  const loader = catalogLoaderModule ?? (await import('../cad/catalog-loader'))
  await phase('geometry.preload', () =>
    loader.preloadDocumentGeometry(
      Object.values(engine.cadEngine.getDocument().parts).map((part) => part.definitionId),
    ),
  )
  return {
    level: 'editor',
    catalog: partsStage.catalog,
    searchIndex: partsStage.searchIndex,
    engine,
    session,
  }
}

const STAGE_PHASE: Record<Exclude<BootLevel, 'none'>, BootPhaseName> = {
  parts: 'stage.parts',
  catalog: 'stage.catalog',
  editor: 'stage.editor',
}

function start(level: BootLevel): Promise<BootStage> {
  if (level === 'none') return Promise.resolve(NONE)
  const done = settled.get(level)
  if (done) return Promise.resolve(done)
  const existing = inFlight.get(level)
  if (existing) return existing

  const work = phase<BootStage>(STAGE_PHASE[level], () =>
    level === 'parts' ? loadPartsStage() : level === 'catalog' ? loadCatalogStage() : loadEditorStage(),
  )
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
 * The shared browse-index handle, whatever stage the caller is at.
 *
 * Resident by construction before any boot has run, because a build whose
 * loader cannot split the catalog installs the index with the parts tier. The
 * handle is replaced once, when the parts stage discovers which loader it has.
 */
export function searchIndexHandle(): SearchIndexHandle {
  return searchIndex
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
  searchIndex = RESIDENT
  timeline.length = 0
}

/**
 * Narrow a stage to one that has the compiled parts tier, or explain.
 *
 * "Catalog" here means part identity, geometry and colour — what `catalog.get()`
 * answers from. It deliberately does *not* promise a resident browse index; ask
 * `stage.searchIndex` for that, because an `editor` stage has the parts tier
 * long before the index lands.
 */
export function requireCatalogStage(stage: BootStage): BootStageWithCatalog {
  if (stage.level === 'none') throw new BootLevelError('catalog', stage.level)
  return stage
}

/** Narrow a stage to the editor, or explain the misdeclaration. */
export function requireEditorStage(stage: BootStage): BootStageEditor {
  if (stage.level !== 'editor') throw new BootLevelError('editor', stage.level)
  return stage
}
