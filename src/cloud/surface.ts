import type { ModelDocument } from '../cad/types'
import type { CloudErrorShape } from './protocol'

/**
 * The slice of the workbench this workstream's surfaces actually use.
 *
 * Structurally a subset of `WorkbenchApi` from `src/editor/workbench`, restated
 * here so the panels can be rendered — and tested — without importing the whole
 * editor shell, and so a change to a part of that API these surfaces never
 * touch cannot break them. `contributions.tsx` passes the real object straight
 * in; TypeScript checks the two agree at that seam.
 */
export interface CloudWorkbenchApi {
  readonly snapshot: { readonly document: ModelDocument }
  /** False when the browser reports the network is unreachable. */
  readonly online: boolean
  readonly activeModal: string | null
  notify(notice: { kind: 'success' | 'error' | 'info'; title: string; detail: string }): void
  openModal(contributionId: string | null): void
  /** The shared planner every writer goes through. Used only for `rename_document`. */
  runCapability(capability: 'rename_document', args?: Record<string, unknown>): boolean
}

/** The id the version-history dialog registers under, and `openModal` opens. */
export const VERSION_HISTORY_MODAL_ID = 'cloud.version-history'

export interface SurfaceNotice {
  tone: 'neutral' | 'active' | 'warn' | 'error'
  title: string
  detail: string
}

/** A cloud failure as something a person can act on. */
export const noticeFor = (error: CloudErrorShape, title: string): SurfaceNotice => ({
  tone: error.code === 'UNCONFIGURED' ? 'neutral' : 'error',
  title,
  detail: `${error.message} ${error.repair}`.trim(),
})

export const formatWhen = (iso: string | null | undefined): string => {
  if (!iso) return 'never'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}

export const formatCount = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`
