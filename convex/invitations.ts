import { v } from 'convex/values'
import { listOverflow } from './model/discovery'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, readIdentity, UNAUTHENTICATED } from './model/auth'
import { cloudFailure, type CloudInvitationRecord, type CloudResult } from './model/protocol'
import { collectionFull, COLLECTION_LIMITS } from './model/limits'
import { invitationRecord } from './model/records'
import { assignableRole } from './model/validators'
import { sendInvitationEmail } from './model/invitationDelivery'
import { invitationRetryAt } from './model/invitationLifecycle'

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
 *
 * That reasoning governs what *authorises* an acceptance. It does not extend to
 * ignoring a contradiction: if the presented token carries a **verified**
 * address and it is not the one invited, the two facts disagree, and a
 * forwarded invite is the ordinary explanation. `accept` refuses that case and
 * only that case — an absent or unverified claim accepts exactly as before, so
 * the guard can never lock out a provider that does not assert addresses.
 */

/**
 * How long an invitation link stays live.
 *
 * Three days rather than fourteen. This is a bearer credential that sits in an
 * inbox, a shared mailbox or a mail archive for its whole lifetime, and the
 * window in which a leaked one is useful is exactly this number.
 */
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000

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
      .order('desc')
      .take(101)
    const overflow = listOverflow(rows.length, 100, 'discovery:invitations')
    if (overflow) return overflow
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
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'That does not look like an email address.',
        'Check the address and retry.',
      )
    }
    const now = Date.now()
    // Scope before limiting; an address invited to many other projects must
    // not bypass duplicate detection. Expired rows never block a replacement.
    const duplicate = await ctx.db
      .query('invitations')
      .withIndex('by_project_email_status_expiry', (q) =>
        q.eq('projectId', project._id).eq('email', email).eq('status', 'pending').gt('expiresAt', now),
      )
      .first()
    if (duplicate) {
      return cloudFailure(
        'NAME_TAKEN',
        'That address already has a pending invitation to this project.',
        'Retry delivery for the existing invitation, or revoke it before creating another.',
        { invitationId: duplicate._id },
      )
    }

    const onProject = await ctx.db
      .query('invitations')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.invitationsPerProject)
    const invitationsFull = collectionFull(
      onProject.length,
      COLLECTION_LIMITS.invitationsPerProject,
      'invitations',
      'Revoke an invitation that was never accepted before sending another.',
    )
    if (invitationsFull) return invitationsFull

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
      deliveryGeneration: 0,
      deliveryAttempts: 0,
      deliveryRequestedAt: now,
    })
    await ctx.scheduler.runAfter(0, internal.invitations.deliver, { invitationId, generation: 0 })
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
    await ctx.db.patch(invitation._id, {
      status: 'revoked',
      ...(['pending', 'sending'].includes(invitation.deliveryStatus)
        ? {
            deliveryStatus: 'cancelled' as const,
            deliveryReason: 'The invitation was revoked before delivery completed.',
          }
        : {}),
    })
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
 * The address on the caller's token, if it carries one it has verified.
 *
 * Read here and nowhere else. `readIdentity` deliberately does not load `email`
 * — a value that is never loaded cannot be leaked by a later careless spread —
 * and that stays true: this reads the claim inside one comparison and never
 * returns, stores or logs it.
 */
async function verifiedEmail(ctx: MutationCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity || identity.emailVerified !== true) return null
  const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : ''
  return email || null
}

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
    // A dropped acceptance response must be retryable by the same identity,
    // but never restore a removed member or their previous (higher) role.
    if (invitation?.status === 'accepted' && invitation.acceptedBySubject === identity.subject) {
      const project = await ctx.db.get(invitation.projectId)
      const member = await ctx.db
        .query('members')
        .withIndex('by_project_subject', (q) => q.eq('projectId', invitation.projectId).eq('subject', identity.subject))
        .unique()
      if (project && project.deletedAt === undefined && member)
        return { ok: true, value: { projectId: project._id, role: member.role } }
    }
    if (!invitation || invitation.status !== 'pending') {
      return cloudFailure(
        'NOT_FOUND',
        'That invitation link is not valid any more.',
        'Ask the project owner to send a fresh invitation.',
      )
    }
    if (invitation.expiresAt <= Date.now()) {
      await ctx.db.patch(invitation._id, {
        status: 'expired',
        ...(['pending', 'sending'].includes(invitation.deliveryStatus)
          ? { deliveryStatus: 'cancelled' as const, deliveryReason: 'The invitation expired.' }
          : {}),
      })
      return cloudFailure(
        'NOT_FOUND',
        'That invitation has expired.',
        'Ask the project owner to send a fresh invitation.',
      )
    }
    const claimed = await verifiedEmail(ctx)
    if (claimed && claimed !== invitation.email) {
      // Neither address appears in the message. The person holding a forwarded
      // link is not entitled to learn who it was addressed to, and the owner's
      // audit trail is not the place to publish the accepter's address either.
      return cloudFailure(
        'FORBIDDEN',
        'This invitation was sent to a different address than the one on this account.',
        'Sign in with the invited address, or ask the project owner to invite this one.',
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
      .withIndex('by_project_subject', (q) => q.eq('projectId', project._id).eq('subject', identity.subject))
      .unique()
    const now = Date.now()
    if (existing) {
      // Already a member: consume the token but never lower an existing role,
      // which is how a stale viewer invitation could otherwise demote an editor.
      await ctx.db.patch(invitation._id, {
        status: 'accepted',
        ...(['pending', 'sending'].includes(invitation.deliveryStatus)
          ? {
              deliveryStatus: 'cancelled' as const,
              deliveryReason: 'The invitation was accepted before delivery completed.',
            }
          : {}),
        acceptedBySubject: identity.subject,
        acceptedAt: now,
      })
      return { ok: true, value: { projectId: project._id, role: existing.role } }
    }
    // Both sides of the new membership have a window: the project's roster and
    // the accepter's own project list. Neither may be pushed past what it can
    // return by someone accepting a link.
    const roster = await ctx.db
      .query('members')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.membersPerProject)
    const rosterFull = collectionFull(
      roster.length,
      COLLECTION_LIMITS.membersPerProject,
      'members',
      'Ask an owner to remove a member before accepting.',
    )
    if (rosterFull) return rosterFull

    const memberships = await ctx.db
      .query('members')
      .withIndex('by_subject', (q) => q.eq('subject', identity.subject))
      .take(COLLECTION_LIMITS.membershipsPerAccount)
    const membershipsFull = collectionFull(
      memberships.length,
      COLLECTION_LIMITS.membershipsPerAccount,
      'cloud projects',
      'Leave or delete a cloud project before joining another.',
    )
    if (membershipsFull) return membershipsFull

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
      ...(['pending', 'sending'].includes(invitation.deliveryStatus)
        ? {
            deliveryStatus: 'cancelled' as const,
            deliveryReason: 'The invitation was accepted before delivery completed.',
          }
        : {}),
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

/** Explicit, owner-authorized retry. A queued/sending retry is idempotent while
 * its lease is fresh; failed attempts and expired leases get a new generation. */
export const retryDelivery = mutation({
  args: { projectId: v.string(), invitationId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudInvitationRecord>> => {
    const auth = await authoriseProject(ctx, args.projectId, 'member.invite')
    if (!auth.ok) return auth
    const invitation = await ctx.db.get(args.invitationId as Id<'invitations'>)
    if (!invitation || invitation.projectId !== auth.value.project._id)
      return cloudFailure('NOT_FOUND', 'That invitation is not available in this project.', 'Reload the invitations.')
    const now = Date.now()
    if (invitation.status !== 'pending' || invitation.expiresAt <= now)
      return cloudFailure(
        'INVALID_ARGUMENT',
        'Only an unexpired, pending invitation can be retried.',
        'Create a fresh invitation if access is still needed.',
      )
    if (['queued', 'sent'].includes(invitation.deliveryStatus))
      return cloudFailure(
        'INVALID_ARGUMENT',
        'The email endpoint already accepted this invitation.',
        'Check delivery before creating a replacement invitation.',
      )
    const retryAt = invitationRetryAt(invitation)
    if (now < retryAt) {
      if (['pending', 'sending'].includes(invitation.deliveryStatus))
        return { ok: true, value: invitationRecord(invitation) }
      return cloudFailure(
        'INVALID_ARGUMENT',
        'Wait briefly before retrying invitation delivery.',
        'Retry after the cooldown shown for this invitation.',
        { retryAt: new Date(retryAt).toISOString() },
      )
    }
    const generation = (invitation.deliveryGeneration ?? 0) + 1
    await ctx.db.patch(invitation._id, {
      deliveryGeneration: generation,
      deliveryStatus: 'pending',
      deliveryRequestedAt: now,
      deliveryStartedAt: undefined,
      deliveryCompletedAt: undefined,
      deliveryReason: 'Delivery retry is queued. A previous unconfirmed request may already have sent an email.',
    })
    await ctx.scheduler.runAfter(0, internal.invitations.deliver, { invitationId: invitation._id, generation })
    await writeAuditEvent(ctx, {
      projectId: invitation.projectId,
      actorSubject: auth.value.identity.subject,
      action: 'invitation.retryDelivery',
      detail: { generation, role: invitation.role },
    })
    const updated = await ctx.db.get(invitation._id)
    if (!updated) throw new Error('Invitation vanished during retry.')
    return { ok: true, value: invitationRecord(updated) }
  },
})

type DeliveryContext = { email: string; token: string; role: string; projectName: string }

/** Retired unleased read. Keep the old function signature during rollout, but
 * do not release any more tokens to workers that cannot claim atomically.
 * Previously scheduled deliver actions can still claim legacy rows below. */
export const deliveryContext = internalQuery({
  args: { invitationId: v.id('invitations') },
  handler: async (): Promise<null> => null,
})

/** Only one action can claim a scheduled generation. Duplicate scheduler runs,
 * stale actions, expired invites and deleted projects do not reach the provider. */
export const claimDelivery = internalMutation({
  args: { invitationId: v.id('invitations'), generation: v.optional(v.number()) },
  handler: async (ctx, args): Promise<(DeliveryContext & { generation: number }) | null> => {
    const row = await ctx.db.get(args.invitationId)
    if (
      !row ||
      row.status !== 'pending' ||
      row.deliveryStatus !== 'pending' ||
      (row.deliveryGeneration ?? 0) !== (args.generation ?? 0)
    )
      return null
    const project = await ctx.db.get(row.projectId)
    if (!project || project.deletedAt !== undefined || row.expiresAt <= Date.now()) {
      await ctx.db.patch(row._id, {
        deliveryStatus: 'cancelled',
        deliveryReason: 'The invitation or project is no longer available.',
        ...(row.expiresAt <= Date.now() ? { status: 'expired' as const } : {}),
      })
      return null
    }
    const generation = row.deliveryGeneration ?? 0
    await ctx.db.patch(row._id, {
      deliveryGeneration: generation,
      deliveryStatus: 'sending',
      deliveryStartedAt: Date.now(),
      deliveryAttempts: (row.deliveryAttempts ?? 0) + 1,
      deliveryReason: 'Submitting the invitation to the email endpoint.',
    })
    return { generation, email: row.email, token: row.token, role: row.role, projectName: project.name }
  },
})

/** Guard completion with the generation and current lifecycle. An old worker
 * cannot overwrite a retry, revocation or acceptance. Legacy unleased replies
 * are ignored rather than claiming delivery for another worker. */
export const markDelivery = internalMutation({
  args: {
    invitationId: v.id('invitations'),
    generation: v.optional(v.number()),
    deliveryStatus: v.union(v.literal('queued'), v.literal('sent'), v.literal('not-configured'), v.literal('failed')),
    deliveryReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.invitationId)
    if (
      !row ||
      args.generation === undefined ||
      row.deliveryGeneration !== args.generation ||
      row.status !== 'pending' ||
      row.deliveryStatus !== 'sending'
    )
      return null
    const project = await ctx.db.get(row.projectId)
    if (!project || project.deletedAt !== undefined || row.expiresAt <= Date.now()) {
      await ctx.db.patch(row._id, {
        deliveryStatus: 'cancelled',
        deliveryReason: 'The invitation or project is no longer available.',
        ...(row.expiresAt <= Date.now() ? { status: 'expired' as const } : {}),
      })
      return null
    }
    await ctx.db.patch(row._id, {
      deliveryStatus: args.deliveryStatus,
      deliveryReason: args.deliveryReason,
      deliveryCompletedAt: Date.now(),
    })
    return null
  },
})

/** Hexclave transactional email by default, with the existing custom endpoint
 * as an explicit override. No user account is manufactured to send mail, and
 * HTTP acceptance is explicitly not an inbox-delivery guarantee. */
export const deliver = internalAction({
  args: { invitationId: v.id('invitations'), generation: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const context = await ctx.runMutation(internal.invitations.claimDelivery, args)
    if (!context) return null
    const result = await sendInvitationEmail({
      ...context,
      invitationId: args.invitationId,
      endpoint: process.env.INVITATION_EMAIL_ENDPOINT,
      credential: process.env.INVITATION_EMAIL_TOKEN,
      origin: process.env.INVITATION_LINK_ORIGIN,
      hexclaveProjectId: process.env.HEXCLAVE_PROJECT_ID,
      hexclaveSecretServerKey: process.env.HEXCLAVE_SECRET_SERVER_KEY,
      hexclaveApiOrigin: process.env.HEXCLAVE_API_URL_SERVER || process.env.HEXCLAVE_API_URL || undefined,
    })
    await ctx.runMutation(internal.invitations.markDelivery, {
      invitationId: args.invitationId,
      generation: context.generation,
      deliveryStatus: result.status,
      deliveryReason: result.reason,
    })
    return null
  },
})
