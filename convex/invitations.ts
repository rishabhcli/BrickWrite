import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, readIdentity, UNAUTHENTICATED } from './model/auth'
import { cloudFailure, type CloudInvitationRecord, type CloudResult } from './model/protocol'
import { invitationRecord } from './model/records'
import { assignableRole } from './model/validators'

/**
 * Invitations — the only place an email address is stored, and the only place
 * one is used.
 *
 * The browser can create an invitation but cannot send it. Creation schedules
 * `deliver`, an internal action: internal functions have no public URL, so the
 * send path is reachable only from inside the deployment and the delivery
 * credential never leaves it. If that credential is not configured, the
 * invitation is recorded as `not-configured` with a reason rather than being
 * reported as sent — an unsent invitation that claims otherwise is how somebody
 * ends up waiting for an email that was never going to arrive.
 *
 * Acceptance is by token, not by matching the signed-in account's email. The
 * token is single-use, expires, and is only ever delivered to the invited
 * address by the server. Keying acceptance on an email claim instead would put
 * an email in the authorisation path, and every other decision in this
 * deployment is made on the Hexclave user id.
 */

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** Two UUIDs: guessing one is not a realistic attack on an invite link. */
const mintToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudInvitationRecord[]>> => {
    // Gated on `member.invite`, not on `member.list`: the invitee list is the
    // one view in this deployment that contains email addresses.
    const authorised = await authoriseProject(ctx, args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('invitations')
      .withIndex('by_project', (q) => q.eq('projectId', authorised.value.project._id))
      .take(100)
    return { ok: true, value: rows.map(invitationRecord) }
  },
})

export const create = mutation({
  args: { projectId: v.string(), email: v.string(), role: assignableRole },
  handler: async (ctx, args): Promise<CloudResult<CloudInvitationRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    const email = args.email.trim().toLowerCase()
    if (!EMAIL_SHAPE.test(email)) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'That does not look like an email address.',
        'Check the address and retry.',
      )
    }
    const pending = await ctx.db
      .query('invitations')
      .withIndex('by_email_status', (q) => q.eq('email', email).eq('status', 'pending'))
      .take(32)
    const duplicate = pending.find((row) => row.projectId === project._id)
    if (duplicate) {
      return cloudFailure(
        'NAME_TAKEN',
        'That address already has a pending invitation to this project.',
        'Revoke the existing invitation before sending another.',
        { invitationId: duplicate._id },
      )
    }

    const now = Date.now()
    const invitationId = await ctx.db.insert('invitations', {
      projectId: project._id,
      email,
      role: args.role,
      token: mintToken(),
      invitedBySubject: identity.subject,
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
      status: 'pending',
      deliveryStatus: 'pending',
    })
    await ctx.scheduler.runAfter(0, internal.invitations.deliver, { invitationId })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'invitation.create',
      // The address is content and is filtered out by the redactor. The audit
      // trail records that somebody was invited, never who.
      detail: { role: args.role },
    })
    const row = await ctx.db.get(invitationId)
    if (!row) return cloudFailure('NOT_FOUND', 'The invitation vanished.', 'Retry.')
    return { ok: true, value: invitationRecord(row) }
  },
})

export const revoke = mutation({
  args: { projectId: v.string(), invitationId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ revoked: boolean }>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const invitation = await ctx.db.get(args.invitationId as Id<'invitations'>)
    if (!invitation || invitation.projectId !== project._id) {
      return cloudFailure(
        'NOT_FOUND',
        'That invitation does not belong to this project.',
        'Reload the invitation list.',
      )
    }
    if (invitation.status !== 'pending') return { ok: true, value: { revoked: false } }
    await ctx.db.patch(invitation._id, { status: 'revoked' })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'invitation.revoke',
      detail: { role: invitation.role },
    })
    return { ok: true, value: { revoked: true } }
  },
})

/**
 * Redeems an invitation token.
 *
 * Authorised by possession of the token plus a signed-in identity — the caller
 * does not have to be a member yet, which is the whole point, so this is the
 * one mutation that does not go through `authoriseProject`.
 */
export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ projectId: string; role: string }>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }

    const invitation = await ctx.db
      .query('invitations')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique()
    if (!invitation || invitation.status !== 'pending') {
      return cloudFailure(
        'NOT_FOUND',
        'That invitation link is not valid any more.',
        'Ask the project owner to send a fresh invitation.',
      )
    }
    if (invitation.expiresAt < Date.now()) {
      await ctx.db.patch(invitation._id, { status: 'expired' })
      return cloudFailure(
        'NOT_FOUND',
        'That invitation has expired.',
        'Ask the project owner to send a fresh invitation.',
      )
    }
    const project = await ctx.db.get(invitation.projectId)
    if (!project || project.deletedAt !== undefined) {
      return cloudFailure(
        'NOT_FOUND',
        'The project this invitation points at is no longer available.',
        'Ask the owner whether it was deleted.',
      )
    }

    const existing = await ctx.db
      .query('members')
      .withIndex('by_project_subject', (q) =>
        q.eq('projectId', project._id).eq('subject', identity.subject),
      )
      .unique()
    const now = Date.now()
    if (existing) {
      // Already a member: consume the token but never lower an existing role,
      // which is how a stale viewer invitation could otherwise demote an editor.
      await ctx.db.patch(invitation._id, {
        status: 'accepted',
        acceptedBySubject: identity.subject,
        acceptedAt: now,
      })
      return { ok: true, value: { projectId: project._id, role: existing.role } }
    }
    await ctx.db.insert('members', {
      projectId: project._id,
      subject: identity.subject,
      role: invitation.role,
      displayName: identity.displayName,
      invitedBySubject: invitation.invitedBySubject,
      addedAt: now,
    })
    await ctx.db.patch(invitation._id, {
      status: 'accepted',
      acceptedBySubject: identity.subject,
      acceptedAt: now,
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'invitation.accept',
      detail: { role: invitation.role },
    })
    return { ok: true, value: { projectId: project._id, role: invitation.role } }
  },
})

export const markDelivery = internalMutation({
  args: {
    invitationId: v.id('invitations'),
    deliveryStatus: v.union(
      v.literal('sent'),
      v.literal('not-configured'),
      v.literal('failed'),
    ),
    deliveryReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const invitation = await ctx.db.get(args.invitationId)
    if (!invitation) return null
    await ctx.db.patch(args.invitationId, {
      deliveryStatus: args.deliveryStatus,
      deliveryReason: args.deliveryReason,
    })
    return null
  },
})

/**
 * The material `deliver` needs to compose the message.
 *
 * Internal only. It returns an email address and a live invitation token, so it
 * must never become reachable from a browser.
 */
export const deliveryContext = internalQuery({
  args: { invitationId: v.id('invitations') },
  handler: async (
    ctx,
    args,
  ): Promise<{ email: string; token: string; role: string; projectName: string } | null> => {
    const invitation = await ctx.db.get(args.invitationId)
    if (!invitation) return null
    const project = await ctx.db.get(invitation.projectId)
    return {
      email: invitation.email,
      token: invitation.token,
      role: invitation.role,
      projectName: project?.name ?? 'a Brickwright project',
    }
  },
})

/**
 * Sends the invitation email.
 *
 * Internal, so it has no public URL and the browser cannot reach it. Delivery
 * is an outbound POST to whatever transactional endpoint the deployment is
 * configured with:
 *
 *   INVITATION_EMAIL_ENDPOINT  absolute https URL
 *   INVITATION_EMAIL_TOKEN     bearer credential for that endpoint
 *   INVITATION_LINK_ORIGIN     origin the accept link is built against
 *
 * The body is `{ to, subject, invitationUrl, projectName, role }`. Wiring that
 * to the Hexclave emails app, or to any other provider, is a deployment step —
 * see `docs/integration/cloud-projects.md`. With the variables unset the
 * invitation is honestly marked `not-configured`; nothing here ever reports a
 * send it did not make.
 */
export const deliver = internalAction({
  args: { invitationId: v.id('invitations') },
  handler: async (ctx, args): Promise<null> => {
    const endpoint = process.env.INVITATION_EMAIL_ENDPOINT
    const token = process.env.INVITATION_EMAIL_TOKEN
    const origin = process.env.INVITATION_LINK_ORIGIN

    const context = await ctx.runQuery(internal.invitations.deliveryContext, {
      invitationId: args.invitationId,
    })
    if (!context) return null

    if (!endpoint || !token || !origin) {
      const missing = [
        endpoint ? null : 'INVITATION_EMAIL_ENDPOINT',
        token ? null : 'INVITATION_EMAIL_TOKEN',
        origin ? null : 'INVITATION_LINK_ORIGIN',
      ]
        .filter((name): name is string => name !== null)
        .join(', ')
      await ctx.runMutation(internal.invitations.markDelivery, {
        invitationId: args.invitationId,
        deliveryStatus: 'not-configured',
        deliveryReason: `Email delivery is not configured on this deployment: ${missing} unset.`,
      })
      return null
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to: context.email,
          subject: `You have been invited to a Brickwright project`,
          projectName: context.projectName,
          role: context.role,
          invitationUrl: `${origin.replace(/\/$/, '')}/invite/${context.token}`,
        }),
      })
      if (!response.ok) {
        await ctx.runMutation(internal.invitations.markDelivery, {
          invitationId: args.invitationId,
          deliveryStatus: 'failed',
          deliveryReason: `The delivery endpoint answered ${response.status}.`,
        })
        return null
      }
      await ctx.runMutation(internal.invitations.markDelivery, {
        invitationId: args.invitationId,
        deliveryStatus: 'sent',
      })
    } catch (cause: unknown) {
      await ctx.runMutation(internal.invitations.markDelivery, {
        invitationId: args.invitationId,
        deliveryStatus: 'failed',
        deliveryReason: cause instanceof Error ? cause.message : String(cause),
      })
    }
    return null
  },
})
