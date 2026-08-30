import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { authoriseProject, resolveBranch } from './model/auth'
import { type AppendTransactionValue, type CloudResult, type CloudTransactionRecord } from './model/protocol'
import { branchRecord, transactionRecord } from './model/records'
import { readBranchHistory } from './model/history'
import { appendTransactionBatch } from './model/append'

const transactionInput = {
  clientTransactionId: v.string(),
  baseRevision: v.number(),
  resultRevision: v.number(),
  transaction: v.any(),
  checksum: v.string(),
  schemaVersion: v.number(),
  catalogVersion: v.string(),
}

/** Backwards-compatible single append uses the same atomic validation path. */
export const append = mutation({
  args: { projectId: v.string(), branchId: v.optional(v.string()), ...transactionInput },
  handler: async (ctx, { projectId, branchId, ...transaction }): Promise<CloudResult<AppendTransactionValue>> => {
    const result = await appendTransactionBatch(ctx, {
      projectId,
      ...(branchId ? { branchId } : {}),
      transactions: [transaction],
    })
    if (!result.ok) return result
    const receipt = result.value.transactions[0]
    return {
      ok: true,
      value: {
        transactionId: receipt.transactionId,
        branchId: result.value.branchId,
        headRevision: result.value.headRevision,
        applied: receipt.applied,
      },
    }
  },
})

/** All edits and audits land together; exact retries acknowledge original ids. */
export const appendBatch = mutation({
  args: { projectId: v.string(), branchId: v.optional(v.string()), transactions: v.array(v.object(transactionInput)) },
  handler: appendTransactionBatch,
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

/** Complete-history protocol: bounded pages, a pinned head, and inherited edits. */
export const history = query({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    sinceRevision: v.number(),
    throughRevision: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branch = await resolveBranch(ctx, authorised.value.project, args.branchId)
    if (!branch.ok) return branch
    return readBranchHistory(
      {
        async branch(id) {
          const row = await ctx.db.get(id as Id<'branches'>)
          return row ? branchRecord(row) : null
        },
        async *transactions(branchId, after, through) {
          const rows = ctx.db
            .query('transactions')
            .withIndex('by_branch_revision', (q) =>
              q
                .eq('branchId', branchId as Id<'branches'>)
                .gt('resultRevision', after)
                .lte('resultRevision', through),
            )
            .order('asc')
          for await (const row of rows) yield transactionRecord(row)
        },
      },
      branchRecord(branch.value),
      args,
    )
  },
})

/** Looks up one transaction by its client id, for reconciling an outbox entry. */
export const findByClientId = query({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    clientTransactionId: v.string(),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudTransactionRecord | null>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branchResult = await resolveBranch(ctx, authorised.value.project, args.branchId)
    if (!branchResult.ok) return branchResult
    const row = await ctx.db
      .query('transactions')
      .withIndex('by_client_txn', (q) =>
        q
          .eq('projectId', authorised.value.project._id)
          .eq('branchId', branchResult.value._id)
          .eq('clientTransactionId', args.clientTransactionId),
      )
      .unique()
    return { ok: true, value: row ? transactionRecord(row) : null }
  },
})
