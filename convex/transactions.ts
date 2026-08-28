import { v } from 'convex/values'
import type { Transaction } from '../src/cad/types'
import { mutation, query } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, resolveBranch } from './model/auth'
import { canonicalJson, checksumOfText, utf8Bytes } from './model/checksum'
import {
  cloudFailure,
  MAX_TRANSACTION_BYTES,
  type AppendTransactionValue,
  type CloudResult,
  type CloudTransactionRecord,
  type StaleDocumentDetails,
} from './model/protocol'
import { transactionRecord } from './model/records'

/**
 * The transaction log — the one mutation the whole design rests on.
 *
 * `append` is optimistic concurrency control, not last-write-wins. Everything it
 * does happens inside a single Convex mutation, which Convex runs
 * serializably, so the read of the branch head and the write that advances it
 * cannot interleave with another writer's:
 *
 *   1. authorise the caller against the `members` table;
 *   2. if this `clientTransactionId` is already stored, return the original
 *      outcome — a retry after a dropped response must not create a second
 *      revision;
 *   3. compare `baseRevision` against the branch head and refuse with
 *      `STALE_DOCUMENT` if they differ, handing back the head to rebase onto;
 *   4. insert the transaction and advance the head.
 *
 * Two writers at the same base therefore produce exactly one success. The loser
 * is told what it must rebase onto and never has its work overwritten — see
 * `src/cloud/rebase.ts` for what it does with that answer.
 */

export const append = mutation({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    clientTransactionId: v.string(),
    baseRevision: v.number(),
    resultRevision: v.number(),
    transaction: v.any(),
    checksum: v.string(),
    schemaVersion: v.number(),
    catalogVersion: v.string(),
  },
  handler: async (ctx, args): Promise<CloudResult<AppendTransactionValue>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'transaction.write')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    if (!args.clientTransactionId) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'A transaction must carry the client transaction id that makes it idempotent.',
        'Send `Transaction.id` as `clientTransactionId`.',
      )
    }
    if (args.resultRevision !== args.baseRevision + 1) {
      // The kernel advances by exactly one. A gap would leave a revision that no
      // replay can ever produce, so the log would stop replaying at that point.
      return cloudFailure(
        'INVALID_ARGUMENT',
        `A transaction must advance the revision by one; this one went ${args.baseRevision} → ${args.resultRevision}.`,
        'Re-derive the transaction from the engine rather than renumbering it by hand.',
      )
    }
    if (args.schemaVersion !== project.schemaVersion) {
      return cloudFailure(
        'SCHEMA_MISMATCH',
        `This project is stored at document schema ${project.schemaVersion}; the transaction is schema ${args.schemaVersion}.`,
        'Reload the application so both sides agree on the document schema.',
        { expected: project.schemaVersion, actual: args.schemaVersion },
      )
    }

    const serialized = canonicalJson(args.transaction)
    const bytes = utf8Bytes(serialized)
    if (bytes > MAX_TRANSACTION_BYTES) {
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        `That transaction is ${Math.round(bytes / 1024)} KiB; the ceiling is ${Math.round(
          MAX_TRANSACTION_BYTES / 1024,
        )} KiB.`,
        'Split the edit into smaller commits; it stays in the local log either way.',
        { bytes, limit: MAX_TRANSACTION_BYTES },
      )
    }
    const digest = checksumOfText(serialized)
    if (digest !== args.checksum) {
      return cloudFailure(
        'CHECKSUM_MISMATCH',
        'The transaction does not match the checksum sent with it.',
        'Re-queue the transaction from the local log; the payload was altered in flight.',
        { expected: args.checksum, actual: digest },
      )
    }

    const branchResult = await resolveBranch(ctx, project, args.branchId)
    if (!branchResult.ok) return branchResult
    const branch = branchResult.value

    // Idempotency comes before the head comparison on purpose. A retry of an
    // already-applied transaction is stale by definition — the head has moved
    // past it — and answering `STALE_DOCUMENT` would send the client rebasing
    // work the server already has.
    const existing = await ctx.db
      .query('transactions')
      .withIndex('by_client_txn', (q) =>
        q.eq('projectId', project._id).eq('clientTransactionId', args.clientTransactionId),
      )
      .unique()
    if (existing) {
      if (existing.checksum !== digest) {
        // Same id, different content: this is not a retry, it is two different
        // edits claiming one identity. Accepting either would corrupt the log.
        return cloudFailure(
          'INVALID_ARGUMENT',
          'That transaction id is already stored with different content.',
          'Mint a fresh transaction id; ids are not reusable.',
          { clientTransactionId: args.clientTransactionId },
        )
      }
      const currentBranch = await ctx.db.get(existing.branchId)
      return {
        ok: true,
        value: {
          transactionId: existing._id,
          branchId: existing.branchId,
          headRevision: currentBranch?.headRevision ?? existing.resultRevision,
          applied: false,
        },
      }
    }

    if (branch.headRevision !== args.baseRevision) {
      const details: StaleDocumentDetails = {
        headRevision: branch.headRevision,
        branchId: branch._id,
      }
      return cloudFailure(
        'STALE_DOCUMENT',
        `This edit was made against revision ${args.baseRevision}; the branch is at ${branch.headRevision}.`,
        'Rebase the local tail onto the cloud head, or keep both histories as a conflict fork.',
        details,
      )
    }

    const now = Date.now()
    const transactionId = await ctx.db.insert('transactions', {
      projectId: project._id,
      branchId: branch._id,
      clientTransactionId: args.clientTransactionId,
      baseRevision: args.baseRevision,
      resultRevision: args.resultRevision,
      authorSubject: identity.subject,
      payload: args.transaction as Transaction,
      checksum: digest,
      bytes,
      schemaVersion: args.schemaVersion,
      catalogVersion: args.catalogVersion,
      createdAt: now,
    })
    await ctx.db.patch(branch._id, { headRevision: args.resultRevision, updatedAt: now })
    await ctx.db.patch(project._id, { updatedAt: now })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'transaction.append',
      // The label and the operations are model content and stay out of the log;
      // the revision and the size are enough to reconstruct what happened when.
      detail: { revision: args.resultRevision, bytes, branch: branch.name },
    })

    return {
      ok: true,
      value: {
        transactionId,
        branchId: branch._id,
        headRevision: args.resultRevision,
        applied: true,
      },
    }
  },
})

/**
 * The log after `sinceRevision`, oldest first.
 *
 * This is what a client replays onto its checkpoint, so the order is the
 * contract: `by_branch_revision` is a compound index on the branch and the
 * result revision, which yields exactly that order without a sort.
 */
export const listSince = query({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    sinceRevision: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudTransactionRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branchResult = await resolveBranch(ctx, authorised.value.project, args.branchId)
    if (!branchResult.ok) return branchResult

    const rows = await ctx.db
      .query('transactions')
      .withIndex('by_branch_revision', (q) =>
        q.eq('branchId', branchResult.value._id).gt('resultRevision', args.sinceRevision),
      )
      .order('asc')
      .take(Math.min(Math.max(args.limit ?? 500, 1), 2000))
    return { ok: true, value: rows.map(transactionRecord) }
  },
})

/** Looks up one transaction by its client id, for reconciling an outbox entry. */
export const findByClientId = query({
  args: { projectId: v.string(), clientTransactionId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudTransactionRecord | null>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const row = await ctx.db
      .query('transactions')
      .withIndex('by_client_txn', (q) =>
        q
          .eq('projectId', authorised.value.project._id)
          .eq('clientTransactionId', args.clientTransactionId),
      )
      .unique()
    return { ok: true, value: row ? transactionRecord(row) : null }
  },
})
