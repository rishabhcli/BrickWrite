import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { writeAuditEvent } from './audit'
import { authoriseProject, resolveBranch } from './auth'
import { canonicalJson, checksumOfText, utf8Bytes } from './checksum'
import { verifyHistoryRecord } from './history'
import { storageJsonProblem } from './storageJson'
import {
  cloudFailure,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  type AppendTransactionsArgs,
  type AppendTransactionsValue,
  type BatchTransaction,
  type CloudResult,
} from './protocol'

/** Same acceptance rules for the legacy single-edit API and batched sync. */
function validateTransaction(
  args: BatchTransaction,
  schemaVersion: number,
): CloudResult<{ bytes: number; digest: string }> {
  if (!args.clientTransactionId) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'A transaction must carry its client transaction id.',
      'Send Transaction.id as clientTransactionId.',
    )
  }
  if (args.resultRevision !== args.baseRevision + 1) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'A transaction must advance the revision by one.',
      'Re-derive the transaction from the engine rather than renumbering it.',
    )
  }
  if (args.schemaVersion !== schemaVersion) {
    return cloudFailure(
      'SCHEMA_MISMATCH',
      `This project uses schema ${schemaVersion}; the transaction uses ${args.schemaVersion}.`,
      'Reload the application so both sides agree on the document schema.',
      { expected: schemaVersion, actual: args.schemaVersion },
    )
  }
  const serialized = canonicalJson(args.transaction)
  const bytes = utf8Bytes(serialized)
  if (bytes > MAX_TRANSACTION_BYTES) {
    return cloudFailure(
      'PAYLOAD_TOO_LARGE',
      `That transaction exceeds the ${MAX_TRANSACTION_BYTES / 1024} KiB ceiling.`,
      'Split the edit into smaller commits; it stays in the local log either way.',
      { bytes, limit: MAX_TRANSACTION_BYTES },
    )
  }
  const digest = checksumOfText(serialized)
  if (digest !== args.checksum) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      'The transaction does not match the checksum sent with it.',
      'Re-queue the transaction from the local log.',
      { expected: args.checksum, actual: digest },
    )
  }
  const replayable = verifyHistoryRecord(args, args.baseRevision)
  if (!replayable.ok) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      replayable.error.message,
      'Re-derive the complete transaction from the engine; its id, revisions and patch must match the request.',
      replayable.error.details,
    )
  }
  return { ok: true, value: { bytes, digest } }
}

/**
 * Validate and plan every edit before the first write. Returning a typed refusal
 * from a Convex mutation commits earlier writes, so a loop over the old append
 * handler would NOT be atomic. Unexpected storage errors instead throw, letting
 * Convex roll back the entire mutation, including audit and head updates.
 */
export async function appendTransactionBatch(
  ctx: MutationCtx,
  args: AppendTransactionsArgs,
): Promise<CloudResult<AppendTransactionsValue>> {
  const authorised = await authoriseProject(ctx, args.projectId, 'transaction.write')
  if (!authorised.ok) return authorised
  const { project, identity } = authorised.value
  if (!args.transactions.length || args.transactions.length > MAX_TRANSACTION_BATCH_COUNT) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      `A batch must contain 1–${MAX_TRANSACTION_BATCH_COUNT} transactions.`,
      'Split the ordered history into bounded batches.',
      { limit: MAX_TRANSACTION_BATCH_COUNT },
    )
  }
  const problem = storageJsonProblem(args)
  if (problem)
    return cloudFailure(
      'INVALID_ARGUMENT',
      `The transaction batch contains ${problem}.`,
      'Send finite, bounded JSON data from the CAD engine; no edits were stored.',
    )
  const totalBytes = utf8Bytes(canonicalJson(args))
  if (totalBytes > MAX_TRANSACTION_BATCH_BYTES) {
    return cloudFailure(
      'PAYLOAD_TOO_LARGE',
      'The transaction batch exceeds its wire-byte budget.',
      'Send smaller batches without splitting an individual transaction.',
      { bytes: totalBytes, limit: MAX_TRANSACTION_BATCH_BYTES },
    )
  }
  const branchResult = await resolveBranch(ctx, project, args.branchId)
  if (!branchResult.ok) return branchResult
  const branch = branchResult.value
  const prepared: Array<{
    entry: BatchTransaction
    bytes: number
    digest: string
    existing: Doc<'transactions'> | null
  }> = []
  const ids = new Set<string>()
  let headRevision = branch.headRevision
  let hasNew = false
  for (const [index, entry] of args.transactions.entries()) {
    const details = {
      batchIndex: index,
      clientTransactionId: entry.clientTransactionId,
      resultRevision: entry.resultRevision,
    }
    const valid = validateTransaction(entry, project.schemaVersion)
    if (!valid.ok)
      return {
        ok: false,
        error: { ...valid.error, details: { ...((valid.error.details as object) ?? {}), ...details } },
      }
    if (
      ids.has(entry.clientTransactionId) ||
      (index > 0 && entry.baseRevision !== args.transactions[index - 1].resultRevision)
    ) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'A batch must be a contiguous history with unique transaction ids.',
        'Keep edits in their original revision order; do not reuse ids.',
        details,
      )
    }
    ids.add(entry.clientTransactionId)
    const existing = await ctx.db
      .query('transactions')
      .withIndex('by_client_txn', (q) =>
        q.eq('projectId', project._id).eq('branchId', branch._id).eq('clientTransactionId', entry.clientTransactionId),
      )
      .unique()
    if (existing) {
      if (
        existing.checksum !== valid.value.digest ||
        canonicalJson(existing.payload) !== canonicalJson(entry.transaction) ||
        existing.baseRevision !== entry.baseRevision ||
        existing.resultRevision !== entry.resultRevision ||
        existing.schemaVersion !== entry.schemaVersion ||
        existing.catalogVersion !== entry.catalogVersion
      ) {
        return cloudFailure(
          'INVALID_ARGUMENT',
          'That transaction id is already stored with different content or metadata.',
          'Mint a fresh transaction id; ids are not reusable.',
          details,
        )
      }
      if (hasNew || existing.resultRevision > branch.headRevision) {
        return cloudFailure(
          'INVALID_ARGUMENT',
          'Stored retries must form a prefix already included in the branch head.',
          'Reload the complete branch history before retrying.',
          details,
        )
      }
    } else {
      if (entry.baseRevision !== headRevision) {
        return cloudFailure(
          'STALE_DOCUMENT',
          `This edit was made against revision ${entry.baseRevision}; the branch is at ${headRevision}.`,
          'Rebase the local tail onto the cloud head, or keep both histories as a conflict fork.',
          { ...details, headRevision: branch.headRevision, branchId: branch._id },
        )
      }
      hasNew = true
      headRevision = entry.resultRevision
    }
    prepared.push({ entry, ...valid.value, existing })
  }

  const now = Date.now()
  const receipts: AppendTransactionsValue['transactions'] = []
  let appended = 0
  let appendedBytes = 0
  let firstRevision: number | null = null
  for (const { entry, bytes, digest, existing } of prepared) {
    const transactionId =
      existing?._id ??
      (await ctx.db.insert('transactions', {
        projectId: project._id,
        branchId: branch._id,
        clientTransactionId: entry.clientTransactionId,
        baseRevision: entry.baseRevision,
        resultRevision: entry.resultRevision,
        authorSubject: identity.subject,
        payload: entry.transaction,
        checksum: digest,
        bytes,
        schemaVersion: entry.schemaVersion,
        catalogVersion: entry.catalogVersion,
        createdAt: now,
      }))
    if (!existing) {
      appended += 1
      appendedBytes += bytes
      if (firstRevision === null) firstRevision = entry.resultRevision
    }
    receipts.push({
      clientTransactionId: entry.clientTransactionId,
      transactionId,
      resultRevision: entry.resultRevision,
      applied: !existing,
    })
  }
  if (hasNew) {
    // One event for the batch, not one per transaction.
    //
    // Per transaction, this was the loudest writer in the deployment by orders
    // of magnitude, and everything it recorded — who, when, which revision — is
    // already a row in `transactions`, in more detail. What it cost was the
    // audit trail itself: a bounded read of the newest events returned nothing
    // but edits, so the role changes and visibility changes an audit is read
    // for were never in it.
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'transaction.append',
      detail: {
        count: appended,
        fromRevision: firstRevision ?? headRevision,
        toRevision: headRevision,
        bytes: appendedBytes,
        branchId: branch._id,
      },
    })
    await ctx.db.patch(branch._id, { headRevision, updatedAt: now })
    await ctx.db.patch(project._id, { updatedAt: now })
  }
  return { ok: true, value: { branchId: branch._id, headRevision, transactions: receipts } }
}
