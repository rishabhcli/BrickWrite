import { createContext, useContext, type ReactNode } from 'react'
import {
  BootLevelError,
  requireCatalogStage,
  requireEditorStage,
  type BootStage,
  type BootStageWithCatalog,
  type BootStageEditor,
  type SearchIndexHandle,
} from './boot'

/**
 * The completed boot stage, handed down to the mounted surface.
 *
 * This is the other half of "a route cannot opt itself into more than its
 * declared level". `boot.ts` decides *what* is loaded from the registry's
 * declaration; this context decides *what a surface can reach*. A surface on a
 * `boot: 'catalog'` route that calls `useEditorStage()` gets a
 * `BootLevelError` naming the route and the fix, rather than a `null`
 * dereference three frames deep in the kernel.
 */

const StageContext = createContext<BootStage>({ level: 'none' })

export function BootStageProvider({ stage, children }: { stage: BootStage; children: ReactNode }) {
  return <StageContext.Provider value={stage}>{children}</StageContext.Provider>
}

/** The raw stage. Prefer the narrowing hooks below. */
export function useBootStage(): BootStage {
  return useContext(StageContext)
}

/**
 * The compiled parts tier, for surfaces whose route declared at least `parts`.
 *
 * Part identity, geometry and colour — everything `catalog.get()` answers from.
 * Not the browse index: see {@link useSearchIndex}.
 */
export function useCatalogStage(): BootStageWithCatalog {
  return requireCatalogStage(useContext(StageContext))
}

/** Catalog, kernel and session, for surfaces whose route declared `boot: 'editor'`. */
export function useEditorStage(): BootStageEditor {
  return requireEditorStage(useContext(StageContext))
}

/**
 * The browse index's residency, for anything that searches or lists parts.
 *
 * `catalog.search()`, `catalog.describe()` and `catalog.categories` are only
 * authoritative once `ready` is true. A `boot: 'catalog'` route is handed a
 * stage that has already waited for it, so `ready` is true on first render
 * there. `/editor` is not: it paints a restored document's geometry without the
 * index, so a panel that reads the index must either render an honest loading
 * state from `ready`, or suspend:
 *
 * ```tsx
 * const index = useSearchIndex()
 * if (!index.ready) throw index.whenReady()   // Suspense fallback shows
 * ```
 *
 * Reading the index while `ready` is false is not a crash — it is worse. It is
 * an empty result set that looks like "this build has no such part", which is
 * the one answer Brickwright is not allowed to give unless it is true.
 */
export function useSearchIndex(): SearchIndexHandle {
  const stage = useContext(StageContext)
  if (stage.level === 'none') throw new BootLevelError('catalog', stage.level)
  return stage.searchIndex
}
