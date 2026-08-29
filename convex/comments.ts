import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, resolveBranch } from './model/auth'
import { utf8Bytes } from './model/checksum'
import {
  cloudFailure,
  MAX_COMMENT_BYTES,
  type CloudCommentRecord,
  type CloudResult,
} from './model/protocol'
import { commentRecord } from './model/records'
import { commentAnchor } from './model/validators'

/**
 * Revision-anchored spatial comments.
 *
 * A comment records the part it is about, the revision at which it was pinned
 * and a checksum of that part's pose at the time. The server stores those three
 * facts and never re-points them: retargeting an anchor because the model moved
 * would silently change what a review comment refers to.
 *
 * Deciding whether an anchor is still where it was is the client's job — only
 * the client holds the document — and `src/cloud/comments.ts` does it by
 * comparing the stored pose checksum against the live part. So a comment
 * survives later edits and can say that its anchor moved, rather than pointing
 * confidently at the wrong brick.
 */

export const list = query({
  args: { projectId: v.string(), status: v.optional(v.union(v.literal('open'), v.literal('resolved'))) },
  handler: async (ctx, args): Promise<CloudResult<CloudCommentRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'comment.read')
    if (!authorised.ok) return authorised
    const projectId = authorised.value.project._id
    const rows = args.status
      ? await ctx.db
          .query('comments')
          .withIndex('by_project_status', (q) =>
            q.eq('projectId', projectId).eq('status', args.status as 'open' | 'resolved'),
          )
          .take(500)
      : await ctx.db
          .query('comments')
          .withIndex('by_project_created', (q) => q.eq('projectId', projectId))
          .take(500)
    return {
      ok: true,
      value: rows.sort((a, b) => a.createdAt - b.createdAt).map(commentRecord),
    }
  },
})

/** Comments pinned to one part, for the inspector panel of a selected brick. */
export const forPart = query({
  args: { projectId: v.string(), partId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudCommentRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'comment.read')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('comments')
      .withIndex('by_project_anchor', (q) =>
        q.eq('projectId', authorised.value.project._id).eq('anchor.partId', args.partId),
      )
      .take(200)
    return { ok: true, value: rows.sort((a, b) => a.createdAt - b.createdAt).map(commentRecord) }
  },
})

export const add = mutation({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    body: v.string(),
    anchor: commentAnchor,
    replyToId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudCommentRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'comment.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    const body = args.body.trim()
    if (!body) {
      return cloudFailure('INVALID_ARGUMENT', 'A comment needs a body.', 'Type something and retry.')
    }
    if (utf8Bytes(body) > MAX_COMMENT_BYTES) {
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        `That comment is longer than the ${MAX_COMMENT_BYTES} byte limit.`,
        'Shorten it, or attach the detail to a build note in the document instead.',
        { limit: MAX_COMMENT_BYTES },
      )
    }
    const branchResult = await resolveBranch(ctx, project, args.branchId)
    if (!branchResult.ok) return branchResult

    let replyToId: Id<'comments'> | undefined
    if (args.replyToId) {
      const parent = await ctx.db.get(args.replyToId as Id<'comments'>)
      if (!parent || parent.projectId !== project._id) {
        return cloudFailure(
          'NOT_FOUND',
          'The comment being replied to is not in this project.',
          'Reload the comment thread.',
        )
      }
      replyToId = parent._id
    }

    const now = Date.now()
    const commentId = await ctx.db.insert('comments', {
      projectId: project._id,
      branchId: branchResult.value._id,
      authorSubject: identity.subject,
      authorDisplayName: identity.displayName,
      body,
      anchor: args.anchor,
      status: 'open',
      replyToId,
      createdAt: now,
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'comment.create',
      // The body is content. The anchor is not: a part id and a revision are
      // exactly the coordinates an auditor needs and nothing more.
      detail: { partId: args.anchor.partId, atRevision: args.anchor.revision },
    })
    const row = await ctx.db.get(commentId)
    if (!row) return cloudFailure('NOT_FOUND', 'The comment vanished.', 'Retry.')
    return { ok: true, value: commentRecord(row) }
  },
})

/**
 * Resolves or reopens a comment.
 *
 * A commenter may resolve their own thread — closing a note you opened is not
 * an editorial act — but resolving somebody else's needs `comment.resolve`.
 */
export const setStatus = mutation({
  args: {
    projectId: v.string(),
    commentId: v.string(),
    status: v.union(v.literal('open'), v.literal('resolved')),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudCommentRecord>> => {
    const reader = await authoriseProject(ctx, args.projectId, 'comment.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value

    const comment = await ctx.db.get(args.commentId as Id<'comments'>)
    if (!comment || comment.projectId !== project._id) {
      return cloudFailure(
        'NOT_FOUND',
        'That comment is not in this project.',
        'Reload the comment list.',
      )
    }
    if (comment.authorSubject !== identity.subject) {
      const authorised = await authoriseProject(ctx, args.projectId, 'comment.resolve')
      if (!authorised.ok) return authorised
    }

    const now = Date.now()
    await ctx.db.patch(comment._id, {
      status: args.status,
      resolvedBySubject: args.status === 'resolved' ? identity.subject : undefined,
      resolvedAt: args.status === 'resolved' ? now : undefined,
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: `comment.${args.status}`,
      detail: { partId: comment.anchor.partId },
    })
    const row = await ctx.db.get(comment._id)
    if (!row) return cloudFailure('NOT_FOUND', 'That comment is gone.', 'Reload the comment list.')
    return { ok: true, value: commentRecord(row) }
  },
})
