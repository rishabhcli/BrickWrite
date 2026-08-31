import { DEMO_MANIFEST } from './manifest.generated'
import type { DemoEntry } from './types'

export type {
  DemoAsset,
  DemoAssets,
  DemoBillLine,
  DemoBrief,
  DemoCamera,
  DemoCategory,
  DemoEntry,
  DemoManifest,
  DemoPreview,
  DemoPreviewColor,
  DemoPreviewDefinition,
  DemoPreviewPart,
  DemoPreviewStep,
  DemoPreviewSubassembly,
  DemoProvenance,
  DemoRefinementDelta,
  DemoShowcase,
  DemoStaticsSummary,
  DemoValidationSummary,
} from './types'
export { DEMO_MANIFEST } from './manifest.generated'
export { loadDocumentText, loadPreview, previewWeightBytes } from './assets'

/**
 * The published demos.
 *
 * Metadata only: a few kilobytes of counts, copy and asset descriptors. The
 * documents and the preview geometry are fetched on demand, because a visitor
 * who never opens a demo should not pay for six of them, and the landing route
 * is not allowed to download the catalog at all.
 */
export const DEMOS: readonly DemoEntry[] = DEMO_MANIFEST.demos

export const getDemo = (id: string): DemoEntry | undefined => DEMOS.find((demo) => demo.id === id)

/** The demo the landing hero is built from. */
export const heroDemo = (): DemoEntry => DEMOS.find((demo) => demo.hero) ?? DEMOS[0]
