import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, memberRole, readIdentity, UNAUTHENTICATED } from './model/auth'
import { CAPABILITY_MATRIX, type Capability, type CloudRole } from './model/capabilities'
import { cloudFailure, type CloudMemberRecord, type CloudResult } from './model/protocol'
import { memberRecord } from './model/records'
import { assignableRole } from './model/validators'

/**
 * Membership: who may open a project, and with what role.
 *
 * Keyed on the Hexclave user id throughout. Nothing here accepts an email —
 * `invitations.ts` is where an address turns into a membership, and only after
 * the invited person signs in and presents their own token, so a membership row
 * can never be created for somebody who has not authenticated.
 */

/** The capability matrix, so a client can render an accurate role picker. */
export const capabilities = query({
  args: {},
  handler: async (): Promise<Readonly<Record<CloudRole, readonly Capability[]>>> => CAPABILITY_MATRIX,
})

export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudMemberRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'member.list')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('members')
      .withIndex('by_project', (q) => q.eq('projectId', authorised.value.project._id))
      .collect()
    return { ok: true, value: rows.map(memberRecord) }
  },
})

export const setRole = mutation({
  args: { projectId: v.string(), subject: v.string(), role: assignableRole },
  handler: async (ctx, args): Promise<CloudResult<CloudMemberRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'member.setRole')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    if (args.subject === project.ownerSubject) {
      // Demoting the owner is how a project ends up with nobody who can invite,
      // change roles or delete it.
      return cloudFailure(
        'FORBIDDEN',
        "The owner's role cannot be changed.",
        'Transfer ownership first if the owner should step back.',
      )
    }
    const membership = await ctx.db
      .query('members')
      .withIndex('by_project_subject', (q) =>
        q.eq('projectId', project._id).eq('subject', args.subject),
      )
      .unique()
    if (!membership) {
      return cloudFailure(
        'NOT_FOUND',
        'That account is not a member of this project.',
        'Invite them first.',
      )
    }
    await ctx.db.patch(membership._id, { role: args.role })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'member.setRole',
      detail: { subject: args.subject, role: args.role },
    })
    const row = await ctx.db.get(membership._id)
    if (!row) return cloudFailure('NOT_FOUND', 'That membership is gone.', 'Reload the member list.')
    return { ok: true, value: memberRecord(row) }
  },
})

/**
 * Removes a member.
 *
 * Leaving is always permitted — a collaborator does not need an owner's consent
 * to stop collaborating — so a caller removing themselves is authorised as a
 * plain read rather than against `member.remove`.
 */
export const remove = mutation({
  args: { projectId: v.string(), subject: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ removed: boolean }>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }
    const leaving = identity.subject === args.subject
    const authorised = await authoriseProject(
      ctx,
      args.projectId,
      leaving ? 'project.read' : 'member.remove',
    )
    if (!authorised.ok) return authorised
    const { project } = authorised.value

    if (args.subject === project.ownerSubject) {
      return cloudFailure(
        'FORBIDDEN',
        'The owner cannot be removed from their own project.',
        'Transfer ownership first, or delete the project.',
      )
    }
    const membership = await ctx.db
      .query('members')
      .withIndex('by_project_subject', (q) =>
        q.eq('projectId', project._id).eq('subject', args.subject),
      )
      .unique()
    if (!membership) return { ok: true, value: { removed: false } }

    await ctx.db.delete(membership._id)
    // Presence is per-membership: a removed collaborator must stop appearing on
    // other people's cursors immediately, not when their heartbeat expires.
    const sessions = await ctx.db
      .query('presence')
      .withIndex('by_project_subject', (q) =>
        q.eq('projectId', project._id).eq('subject', args.subject),
      )
      .collect()
    for (const session of sessions) await ctx.db.delete(session._id)

    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: leaving ? 'member.leave' : 'member.remove',
      detail: { subject: args.subject },
    })
    return { ok: true, value: { removed: true } }
  },
})

/** The caller's own role, for a client that wants to mirror the matrix locally. */
export const myRole = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudRole | null>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }
    const project = await ctx.db.get(args.projectId as Id<'projects'>)
    if (!project || project.deletedAt !== undefined) return { ok: true, value: null }
    const explicit = await memberRole(ctx, project._id, identity.subject)
    if (explicit) return { ok: true, value: explicit }
    return { ok: true, value: project.visibility === 'public' ? 'viewer' : null }
  },
})
