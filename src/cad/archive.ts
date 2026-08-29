import { catalog } from './catalog'
import {
  ProjectRepository,
  type StoredCheckpoint,
  type StoredTransaction,
} from './persistence'
import type { ModelDocument, ValidationReport } from './types'
import { validateDocument } from './validation'

/**
 * A portable project archive.
 *
 * LDraw and MPD serialise parts and steps. The rest of `ModelDocument` —
 * connections, notes, constraints, modules — and the transaction log that
 * proves how the model got here are written here so a verified design can
 * move between browsers without being re-inferred.
 */

export const ARCHIVE_VERSION = 1

export interface ArchiveAttestation {
  readonly asOfRevision: number
  readonly healthy: boolean
  readonly collisionCount: number
  readonly unverifiedCollisions: number
  readonly componentCount: number
}

export interface BrickwrightArchive {
  readonly brickwrightArchive: typeof ARCHIVE_VERSION
  readonly exportedAt: string
  readonly catalogVersion: string
  readonly checkpoint: StoredCheckpoint
  readonly transactions: StoredTransaction[]
  readonly lastValidation: ArchiveAttestation
}

export interface ArchiveImportReport {
  readonly importedRevision: number
  readonly transactionsAvailable: number
  readonly transactionsImported: number
  readonly catalogVersionMatch: boolean
  readonly unplaceableParts: string[]
  /** What the exporting browser last claimed. Never used as a substitute for recompute. */
  readonly storedHealthy: boolean
  /** Fresh validation of the imported checkpoint document. */
  readonly recomputedHealthy: boolean
}

export type ArchiveParseResult =
  | { ok: true; archive: BrickwrightArchive }
  | { ok: false; message: string }

export function attestationOf(report: ValidationReport): ArchiveAttestation {
  return {
    asOfRevision: report.revision,
    healthy: report.healthy,
    collisionCount: report.collisions.length,
    unverifiedCollisions: report.unverifiedCollisions,
    componentCount: report.componentCount,
  }
}

export function serializeArchive(input: {
  checkpoint: StoredCheckpoint
  transactions: StoredTransaction[]
  catalogVersion: string
  lastValidation: ArchiveAttestation
  exportedAt?: string
}): string {
  const archive: BrickwrightArchive = {
    brickwrightArchive: ARCHIVE_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    catalogVersion: input.catalogVersion,
    checkpoint: input.checkpoint,
    transactions: [...input.transactions].sort((a, b) => a.resultRevision - b.resultRevision),
    lastValidation: input.lastValidation,
  }
  return `${JSON.stringify(archive, null, 2)}\n`
}

function isAttestation(value: unknown): value is ArchiveAttestation {
  if (!value || typeof value !== 'object') return false
  const row = value as ArchiveAttestation
  return (
    typeof row.asOfRevision === 'number' &&
    typeof row.healthy === 'boolean' &&
    typeof row.collisionCount === 'number' &&
    typeof row.unverifiedCollisions === 'number' &&
    typeof row.componentCount === 'number'
  )
}

function isStoredTransaction(value: unknown): value is StoredTransaction {
  if (!value || typeof value !== 'object') return false
  const row = value as StoredTransaction
  return (
    typeof row.key === 'string' &&
    typeof row.projectId === 'string' &&
    typeof row.resultRevision === 'number' &&
    row.transaction !== null &&
    typeof row.transaction === 'object' &&
    typeof row.transaction.resultRevision === 'number'
  )
}

export function parseArchive(json: string): ArchiveParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, message: 'That file is not JSON, so it is not a Brickwright archive.' }
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'That file is not a Brickwright archive envelope.' }
  }
  const candidate = raw as Partial<BrickwrightArchive>
  if (candidate.brickwrightArchive !== ARCHIVE_VERSION) {
    return {
      ok: false,
      message: `This archive uses envelope ${String(candidate.brickwrightArchive)}, which this build cannot read.`,
    }
  }
  const checkpoint = candidate.checkpoint
  if (
    !checkpoint?.document ||
    checkpoint.document.schemaVersion !== 2 ||
    typeof checkpoint.projectId !== 'string' ||
    typeof checkpoint.revision !== 'number' ||
    typeof checkpoint.document.id !== 'string'
  ) {
    return {
      ok: false,
      message: 'The archive checkpoint is missing, or its document is not schema version 2.',
    }
  }
  if (typeof candidate.catalogVersion !== 'string') {
    return { ok: false, message: 'The archive is missing its catalog version.' }
  }
  if (!isAttestation(candidate.lastValidation)) {
    return { ok: false, message: 'The archive attestation is missing or malformed.' }
  }
  if (!Array.isArray(candidate.transactions)) {
    return { ok: false, message: 'The archive is missing its transaction annex.' }
  }
  if (!candidate.transactions.every(isStoredTransaction)) {
    return { ok: false, message: 'The archive transaction annex is malformed.' }
  }
  return { ok: true, archive: candidate as BrickwrightArchive }
}

function replayCount(checkpointRevision: number, transactions: StoredTransaction[]): number {
  const ordered = [...transactions].sort((a, b) => a.resultRevision - b.resultRevision)
  let revision = checkpointRevision
  let imported = 0
  for (const entry of ordered) {
    const transaction = entry.transaction
    if (transaction.resultRevision <= revision) continue
    if (!transaction.patch || transaction.patch.baseRevision !== revision) break
    revision = transaction.resultRevision
    imported += 1
  }
  return imported
}

export function unplaceablePartIds(document: ModelDocument): string[] {
  return Object.values(document.parts)
    .filter((part) => !catalog.get(part.definitionId))
    .map((part) => part.definitionId)
}

export async function persistArchive(
  repository: ProjectRepository,
  archive: BrickwrightArchive,
  projectId: string,
): Promise<ArchiveImportReport> {
  const document: ModelDocument = {
    ...archive.checkpoint.document,
    id: projectId,
  }
  await repository.saveCheckpoint(document)

  const remapped: StoredTransaction[] = archive.transactions.map((entry) => ({
    ...entry,
    projectId,
    key: `${projectId}:${String(entry.resultRevision).padStart(12, '0')}`,
    transaction: entry.transaction,
  }))
  const written: StoredTransaction[] = []
  for (const entry of remapped) {
    try {
      await repository.appendTransaction(projectId, entry.transaction)
      written.push(entry)
    } catch {
      // Stop the annex at the first write failure so later entries cannot claim
      // a chain that was never stored.
      break
    }
  }

  const recomputed = validateDocument(document)
  return {
    importedRevision: document.revision,
    transactionsAvailable: archive.transactions.length,
    transactionsImported: replayCount(document.revision, written),
    catalogVersionMatch: archive.catalogVersion === catalog.version,
    unplaceableParts: unplaceablePartIds(document),
    storedHealthy: archive.lastValidation.healthy,
    recomputedHealthy: recomputed.healthy,
  }
}

export async function exportProjectArchive(
  repository: ProjectRepository,
  document: ModelDocument,
  validation: ValidationReport,
): Promise<string> {
  const stored = await repository.readCheckpoint(document.id)
  const liveIsStored = stored !== null && stored.revision === document.revision
  const checkpoint: StoredCheckpoint = liveIsStored
    ? stored
    : {
        projectId: document.id,
        revision: document.revision,
        savedAt: new Date().toISOString(),
        document,
      }
  const transactions = await repository.listTransactions(document.id, checkpoint.revision)
  return serializeArchive({
    checkpoint,
    transactions,
    catalogVersion: catalog.version,
    lastValidation: attestationOf(validation),
  })
}

export function describeArchiveImport(report: ArchiveImportReport): { title: string; detail: string } {
  const history =
    report.transactionsImported === report.transactionsAvailable
      ? `${report.transactionsImported} history entries imported.`
      : `History partially available: ${report.transactionsImported} of ${report.transactionsAvailable} entries chain from the checkpoint.`
  const catalogNote = report.catalogVersionMatch
    ? 'Catalog version matches this build.'
    : 'Catalog version differs from this build; unplaceable parts are listed rather than discarded.'
  const place = report.unplaceableParts.length
    ? ` Unplaceable parts: ${[...new Set(report.unplaceableParts)].join(', ')}.`
    : ''
  const attest =
    report.storedHealthy === report.recomputedHealthy
      ? ''
      : ' The exporting browser marked the model healthy; this build recomputed validation and disagrees.'
  return {
    title: `Imported revision ${report.importedRevision}`,
    detail: `${history} ${catalogNote}${place}${attest}`,
  }
}
