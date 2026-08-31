import { DEMO_SUMMARY_MANIFEST } from './summary.generated'
import type { DemoSummary } from './types'

export { loadPreview } from './assets'
export { DEMO_SUMMARY_MANIFEST } from './summary.generated'
export type { DemoSummary, DemoSummaryManifest } from './types'

/** Landing-safe metadata: no BOMs, provenance reports, or full validation records. */
export const DEMO_SUMMARIES: readonly DemoSummary[] = DEMO_SUMMARY_MANIFEST.demos

export const getDemoSummary = (id: string): DemoSummary | undefined => DEMO_SUMMARIES.find((demo) => demo.id === id)

export const heroDemoSummary = (): DemoSummary => DEMO_SUMMARIES.find((demo) => demo.hero) ?? DEMO_SUMMARIES[0]
