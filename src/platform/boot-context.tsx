import { createContext, useContext, type ReactNode } from 'react'
import {
  requireCatalogStage,
  requireEditorStage,
  type BootStage,
  type BootStageCatalog,
  type BootStageEditor,
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

/** The compiled catalog, for surfaces whose route declared `boot: 'catalog'`. */
export function useCatalogStage(): BootStageCatalog | BootStageEditor {
  return requireCatalogStage(useContext(StageContext))
}

/** Catalog, kernel and session, for surfaces whose route declared `boot: 'editor'`. */
export function useEditorStage(): BootStageEditor {
  return requireEditorStage(useContext(StageContext))
}
