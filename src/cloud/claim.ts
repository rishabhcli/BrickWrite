import type { ModelDocument, Transaction } from '../cad/types'
import type { LocalProjectStore, StoredLoadedProject } from './projectStore'
import { cloudFailure, type CloudBackend, type CloudResult, type ProjectVisibility } from './protocol'
import { canonicalJson, snapshotUploadFor, transactionChecksum } from './serialize'
import { verifyHistoryRecord } from '../../convex/model/history'
import { sendTransactionBatch, transactionBatch } from './batches'
import { decodeSnapshotUpload } from '../../convex/model/snapshotValidation'

/**
 * Claiming a local project into the cloud.
 *
 * The requirement is losslessness, and the only way to get it is to upload the
 * same two things the local store holds: the checkpoint document, and every
 * transaction logged after it, in order. Notes, constraints, modules, subassembly
 * membership, connection edges and per-part provenance all live inside those
 * two, so none of them needs special handling and none of them can be forgotten
 * by a mapper that did not know about them.
 *
 * The checkpoint is uploaded as stored, not as replayed. Replaying and then
 * uploading the result would produce a document that is *equivalent* but has
 * already collapsed the history, and the operator would lose the ability to see
 * what happened after their last checkpoint.
 */

export interface ClaimOutcome {
  projectId: string
  localProjectId: string
  branchId: string
  checkpointRevision: number
  headRevision: number
  /** Newly applied this attempt; retry acknowledgements are not counted again. */
  transactionsUploaded: number
}

export interface ClaimArgs {
  local: LocalProjectStore
  backend: CloudBackend
  localProjectId: string
  /** Defaults to the stored document's own name. */
  name?: string
  visibility?: ProjectVisibility
}

export async function claimLocalProject(args: ClaimArgs): Promise<CloudResult<ClaimOutcome>> {
  const checkpoint = await args.local.readCheckpoint(args.localProjectId)
  if (!checkpoint) {
    return cloudFailure(
      'NOT_FOUND',
      'That project has no checkpoint in this browser, so there is nothing to upload.',
      'Open the project once so a checkpoint is written, then claim it.',
    )
  }
  const document = checkpoint.document
  const log = (await args.local.readLog(args.localProjectId))
    .filter((entry) => entry.resultRevision > checkpoint.revision)
    .sort((a, b) => a.resultRevision - b.resultRevision)

  const snapshot = snapshotUploadFor(document)
  const valid = decodeSnapshotUpload(snapshot, {
    localProjectId: args.localProjectId,
    schemaVersion: document.schemaVersion,
  })
  if (!valid.ok) return valid
  if (checkpoint.revision !== document.revision) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      'The local checkpoint revision does not match its document.',
      'Keep the local copy and re-save a complete checkpoint before claiming it.',
    )
  }
  let expectedHead = checkpoint.revision
  for (const entry of log) {
    const transaction = entry.transaction
    const validEntry = verifyHistoryRecord(
      {
        transaction,
        clientTransactionId: transaction.id,
        baseRevision: transaction.baseRevision,
        resultRevision: entry.resultRevision,
        checksum: transactionChecksum(transaction),
      },
      expectedHead,
    )
    if (!validEntry.ok) return validEntry
    expectedHead = transaction.resultRevision
  }

  const created = await args.backend.createProject({
    localProjectId: args.localProjectId,
    name: args.name?.trim() || document.name,
    visibility: args.visibility ?? 'private',
    schemaVersion: document.schemaVersion,
    catalogVersion: document.catalogVersion,
    snapshot,
    resumeExisting: true,
  })
  if (!created.ok) return created

  const transactions = log.map(({ transaction }) => ({
    clientTransactionId: transaction.id,
    baseRevision: transaction.baseRevision,
    resultRevision: transaction.resultRevision,
    transaction,
    checksum: transactionChecksum(transaction),
    schemaVersion: document.schemaVersion,
    catalogVersion: document.catalogVersion,
  }))
  let uploaded = 0
  for (let cursor = 0; cursor < transactions.length;) {
    const batch = transactionBatch(
      { projectId: created.value.projectId, branchId: created.value.defaultBranchId },
      transactions.slice(cursor),
      Boolean(args.backend.appendTransactions),
    )
    const appended = await sendTransactionBatch(args.backend, batch)
    if (!appended.ok) {
      const details = appended.error.details as { resultRevision?: number } | undefined
      const stoppedAtRevision = details?.resultRevision ?? batch.transactions[0].resultRevision
      return cloudFailure(
        appended.error.code,
        `The claim stopped at revision ${stoppedAtRevision}: ${appended.error.message}`,
        appended.error.repair,
        { projectId: created.value.projectId, uploaded, stoppedAtRevision, cause: appended.error },
      )
    }
    uploaded += appended.value.transactions.filter((receipt) => receipt.applied).length
    cursor += batch.transactions.length
  }

  const head = await args.backend.getProject({ projectId: created.value.projectId })
  if (!head.ok) return head
  if (head.value.headRevision !== expectedHead) {
    return cloudFailure(
      'STALE_DOCUMENT',
      'The cloud copy changed while this project was being claimed.',
      'Open the existing cloud project and reconcile it with the local copy; neither history was overwritten.',
      { projectId: created.value.projectId, headRevision: head.value.headRevision, localRevision: expectedHead },
    )
  }

  return {
    ok: true,
    value: {
      projectId: created.value.projectId,
      localProjectId: args.localProjectId,
      branchId: created.value.defaultBranchId,
      checkpointRevision: checkpoint.revision,
      headRevision: head.value.headRevision,
      transactionsUploaded: uploaded,
    },
  }
}

export interface ClaimIntegrityReport {
  lossless: boolean
  /** Human-readable differences, empty when the round trip was exact. */
  differences: string[]
  localRevision: number
  cloudRevision: number
  localTransactionCount: number
  cloudTransactionCount: number
}

/**
 * Compares what went up with what comes back down.
 *
 * Compares the canonical serialization rather than walking fields, so a field
 * added to `ModelDocument` next month is covered by this check on the day it is
 * added instead of the day somebody remembers to extend the comparison.
 */
export function claimIntegrityReport(local: StoredLoadedProject, cloud: StoredLoadedProject): ClaimIntegrityReport {
  const differences: string[] = []

  if (canonicalJson(local.document) !== canonicalJson(cloud.document)) {
    for (const field of describeDocumentDifferences(local.document, cloud.document)) {
      differences.push(field)
    }
    if (differences.length === 0) differences.push('The documents differ in an unlisted field.')
  }
  if (local.replayed.length !== cloud.replayed.length) {
    differences.push(`Transaction count differs: ${local.replayed.length} local, ${cloud.replayed.length} cloud.`)
  } else {
    for (let index = 0; index < local.replayed.length; index += 1) {
      if (transactionChecksum(local.replayed[index]) !== transactionChecksum(cloud.replayed[index])) {
        differences.push(`Transaction ${local.replayed[index].id} differs after the round trip.`)
      }
    }
  }

  return {
    lossless: differences.length === 0,
    differences,
    localRevision: local.document.revision,
    cloudRevision: cloud.document.revision,
    localTransactionCount: local.replayed.length,
    cloudTransactionCount: cloud.replayed.length,
  }
}

function describeDocumentDifferences(local: ModelDocument, cloud: ModelDocument): string[] {
  const differences: string[] = []
  const compare = (label: string, a: unknown, b: unknown) => {
    if (canonicalJson(a) !== canonicalJson(b)) differences.push(`${label} differs.`)
  }
  compare('name', local.name, cloud.name)
  compare('revision', local.revision, cloud.revision)
  compare('parts', local.parts, cloud.parts)
  compare('connections', local.connections, cloud.connections)
  compare('subassemblies', local.subassemblies, cloud.subassemblies)
  compare('steps', local.steps, cloud.steps)
  compare('notes', local.notes, cloud.notes)
  compare('constraints', local.constraints, cloud.constraints)
  compare('modules', local.modules ?? [], cloud.modules ?? [])
  compare('catalogVersion', local.catalogVersion, cloud.catalogVersion)
  return differences
}

/** Provenance of every part, for a spot check that authorship survived. */
export function provenanceOf(document: ModelDocument): Record<string, string> {
  const provenance: Record<string, string> = {}
  for (const part of Object.values(document.parts)) {
    provenance[part.id] = `${part.provenance}:${part.createdByTransaction ?? 'none'}`
  }
  return provenance
}

/** Transaction ids in order, for asserting the log survived a round trip. */
export const transactionIds = (transactions: readonly Transaction[]): string[] =>
  transactions.map((transaction) => transaction.id)
