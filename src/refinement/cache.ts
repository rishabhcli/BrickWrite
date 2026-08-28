import { analyseStatics, type StaticsReport } from '../cad/statics'
import { findWeakAttachments } from '../cad/validation'
import type { ModelDocument, Vec3 } from '../cad/types'
import { captureSilhouette } from './silhouette'
import { extractRows, findStackedSeams, type Row, type StackedSeam } from './topology'
import type { SilhouetteV1 } from './types'

/**
 * Derived state, memoized on document identity.
 *
 * A local search scores a few hundred candidate documents, and every objective
 * wants the same four expensive derivations from each of them. The kernel
 * already establishes that a document is immutable per revision — every mutation
 * returns a new object — so keying a WeakMap on the object is correct reuse with
 * no invalidation path to get wrong, exactly as `deriveConnections` does.
 *
 * Nothing here computes anything new. It only stops the same derivation from
 * running eleven times per candidate.
 */

interface Entry {
  rows?: Row[]
  stacked?: StackedSeam[]
  statics?: StaticsReport
  weak?: Array<{ partId: string; connections: number }>
  silhouettes?: Map<string, SilhouetteV1>
}

const cache = new WeakMap<ModelDocument, Entry>()

const entryFor = (document: ModelDocument): Entry => {
  const existing = cache.get(document)
  if (existing) return existing
  const created: Entry = {}
  cache.set(document, created)
  return created
}

export function rowsOf(document: ModelDocument): Row[] {
  const entry = entryFor(document)
  entry.rows ??= extractRows(document)
  return entry.rows
}

export function stackedSeamsOf(document: ModelDocument): StackedSeam[] {
  const entry = entryFor(document)
  entry.stacked ??= findStackedSeams(rowsOf(document))
  return entry.stacked
}

export function staticsOf(document: ModelDocument): StaticsReport {
  const entry = entryFor(document)
  entry.statics ??= analyseStatics(document)
  return entry.statics
}

export function weakAttachmentsOf(document: ModelDocument): Array<{ partId: string; connections: number }> {
  const entry = entryFor(document)
  entry.weak ??= findWeakAttachments(document)
  return entry.weak
}

export function silhouetteOf(document: ModelDocument, frame: { min: Vec3; max: Vec3 }): SilhouetteV1 {
  const entry = entryFor(document)
  entry.silhouettes ??= new Map()
  const key = `${frame.min.join(',')}|${frame.max.join(',')}`
  const cached = entry.silhouettes.get(key)
  if (cached) return cached
  const captured = captureSilhouette(document, frame)
  entry.silhouettes.set(key, captured)
  return captured
}
