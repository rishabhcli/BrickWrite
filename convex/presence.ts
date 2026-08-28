import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { authoriseProject } from './model/auth'
import { cloudFailure, PRESENCE_TTL_MS, type CloudPresenceRecord, type CloudResult } from './model/protocol'
import { presenceRecord } from './model/records'
import { vec3 } from './model/validators'

/**
 * Live presence and follow-mode.
 *
 * Every write in this file touches the `presence` table and nothing else. It
 * does not patch the project, it does not advance a branch head, and it writes
 * no audit event — a cursor moving is not a fact worth keeping, and a heartbeat
 * that bumped `project.updatedAt` would reorder somebody's project list every
 * few seconds.
 *
 * Presence is ephemeral by construction: rows carry an expiry, reads filter on
 * it, and a stale row is simply not returned. Nothing downstream may treat a
 * presence row as document truth, so a dropped heartbeat costs an avatar and
 * never an edit.
 */

const HEARTBEAT_SWATCHES = [
  '#f0a202',
  '#3aa6b9',
  '#c94f7c',
  '#7cb342',
  '#8a6fdf',
  '#d95d39',
  '#2e9e83',
  '#b07d62',
]

/** Stable per-subject colour, so a collaborator keeps their cursor colour. */
function swatchFor(subject: string): string {
  let hash = 0
  for (let index = 0; index < subject.length; index += 1) {
    hash = (hash * 31 + subject.charCodeAt(index)) >>> 0
  }
  return HEARTBEAT_SWATCHES[hash % HEARTBEAT_SWATCHES.length]
}

export const heartbeat = mutation({
  args: {
    projectId: v.string(),
    sessionId: v.string(),
    revision: v.number(),
    selection: v.array(v.string()),
    cursorLdu: v.optional(vec3),
    cameraTargetLdu: v.optional(vec3),
    followingSubject: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudPresenceRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'presence.publish')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    if (!args.sessionId) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'A presence heartbeat needs a session id.',
        'Mint one per tab and reuse it for the lifetime of the tab.',
      )
    }
    const now = Date.now()
    const fields = {
      projectId: project._id,
      subject: identity.subject,
      sessionId: args.sessionId,
      displayName: identity.displayName,
      color: swatchFor(identity.subject),
      revision: args.revision,
      // Capped: a selection is a hint for other people's viewports, and a
      // thousand-part selection does not need to cross the wire to be one.
      selection: args.selection.slice(0, 200),
      cursorLdu: args.cursorLdu,
      cameraTargetLdu: args.cameraTargetLdu,
      followingSubject: args.followingSubject,
      updatedAt: now,
      expiresAt: now + PRESENCE_TTL_MS,
    }

    const existing = await ctx.db
      .query('presence')
      .withIndex('by_project_session', (q) =>
        q.eq('projectId', project._id).eq('sessionId', args.sessionId),
      )
      .unique()
    if (existing && existing.subject !== identity.subject) {
      // A session id is not a capability. Two accounts must not share a row.
      return cloudFailure(
        'FORBIDDEN',
        'That session id belongs to another account.',
        'Mint a fresh session id for this tab.',
      )
    }
    const presenceId = existing ? existing._id : await ctx.db.insert('presence', fields)
    if (existing) await ctx.db.patch(existing._id, fields)

    const row = await ctx.db.get(presenceId)
    if (!row) return cloudFailure('NOT_FOUND', 'The presence row vanished.', 'Retry the heartbeat.')
    return { ok: true, value: presenceRecord(row) }
  },
})

export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudPresenceRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    // Bounded by the expiry rather than filtered afterwards, so a project that
    // has accumulated stale rows still answers in constant work.
    const rows = await ctx.db
      .query('presence')
      .withIndex('by_project_expiry', (q) =>
        q.eq('projectId', authorised.value.project._id).gt('expiresAt', Date.now()),
      )
      .collect()
    return { ok: true, value: rows.map(presenceRecord) }
  },
})

/** Drops a session's row on tab close, so other viewports lose the cursor at once. */
export const leave = mutation({
  args: { projectId: v.string(), sessionId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ left: boolean }>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'presence.publish')
    if (!authorised.ok) return authorised
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_project_session', (q) =>
        q.eq('projectId', authorised.value.project._id).eq('sessionId', args.sessionId),
      )
      .unique()
    if (!existing || existing.subject !== authorised.value.identity.subject) {
      return { ok: true, value: { left: false } }
    }
    await ctx.db.delete(existing._id)
    return { ok: true, value: { left: true } }
  },
})
