import { v } from 'convex/values'
import { listOverflow } from './model/discovery'
import type { Doc } from './_generated/dataModel'
import { mutation, query, type QueryCtx } from './_generated/server'
import { authoriseProject, iso, readIdentity, resolveBranch, UNAUTHENTICATED } from './model/auth'
import { writeAuditEvent } from './model/audit'
import {
  cloudFailure,
  type CloudAuditRecord,
  type CloudBranchRecord,
  type CloudProjectSummary,
  type CloudResult,
  type CloudSnapshotRecord,
} from './model/protocol'
import { auditRecord, branchRecord } from './model/records'
import { latestBranchCheckpoint, readSnapshot, writeSnapshot } from './model/snapshots'
import { decodeSnapshotUpload } from './model/snapshotValidation'
import { canonicalJson } from './model/checksum'
import { isRevision } from './model/history'
import { snapshotUpload, visibility } from './model/validators'

/**
 * Project lifecycle in the cloud replica.
 *
 * A project is created together with its `main` branch and the owner's
 * membership row, in one mutation, because a project that exists without an
 * owner row is a project nobody can open — including the person who just made
 * it. Deletion is a soft delete: the transaction log is the operator's history
 * and a misclick in a project list is not a good enough reason to destroy it.
 */

const DEFAULT_BRANCH = 'main'

async function summarise(
  ctx: QueryCtx,
  project: Doc<'projects'>,
  role: CloudProjectSummary['role'],
): Promise<CloudProjectSummary> {
  const branch = project.defaultBranchId ? await ctx.db.get(project.defaultBranchId) : null
  return {
    projectId: project._id,
    localProjectId: project.localProjectId,
    name: project.name,
    ownerSubject: project.ownerSubject,
    visibility: project.visibility,
    role,
    defaultBranchId: branch?._id ?? '',
    headRevision: branch?.headRevision ?? 0,
    schemaVersion: project.schemaVersion,
    catalogVersion: project.catalogVersion,
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  }
}

/**
 * Projects this identity may open.
 *
 * Driven off the caller's own membership rows, never off a project scan with a
 * filter. A listing built by filtering every project is one missing predicate
 * away from publishing the whole deployment.
 */
export const list = query({
  args: {},
  handler: async (ctx): Promise<CloudResult<CloudProjectSummary[]>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }

    const memberships = await ctx.db
      .query('members')
      .withIndex('by_subject', (q) => q.eq('subject', identity.subject))
      .take(201)

    const overflow = listOverflow(memberships.length, 200, 'discovery:projects')
    if (overflow) return overflow

    const summaries: CloudProjectSummary[] = []
    for (const membership of memberships) {
      const project = await ctx.db.get(membership.projectId)
      if (!project || project.deletedAt !== undefined) continue
      summaries.push(await summarise(ctx, project, membership.role))
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { ok: true, value: summaries }
  },
})

export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudProjectSummary>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    return { ok: true, value: await summarise(ctx, authorised.value.project, authorised.value.role) }
  },
})

export const branches = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudBranchRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('branches')
      .withIndex('by_project', (q) => q.eq('projectId', authorised.value.project._id))
      .take(65)
    const overflow = listOverflow(rows.length, 64, 'discovery:branches')
    if (overflow) return overflow
    return { ok: true, value: rows.map(branchRecord) }
  },
})

export const create = mutation({
  args: {
    localProjectId: v.string(),
    name: v.string(),
    visibility: v.optional(visibility),
    schemaVersion: v.number(),
    catalogVersion: v.string(),
    snapshot: v.optional(snapshotUpload),
    resumeExisting: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudProjectSummary>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }

    const name = args.name.trim()
    if (!name) {
      return cloudFailure('INVALID_ARGUMENT', 'A project needs a name.', 'Type a name and retry.')
    }
    if (!args.localProjectId.trim() || !args.catalogVersion.trim() || args.schemaVersion !== 2) {
      return cloudFailure(
        args.schemaVersion !== 2 ? 'SCHEMA_MISMATCH' : 'INVALID_ARGUMENT',
        'A cloud project needs a document id, catalogue version and supported schema.',
        'Create the project from a complete schema-2 document.',
      )
    }
    // A typed error commits a Convex mutation. Validate before the first insert,
    // not after creating the project/branch/owner rows.
    const seed = args.snapshot ? decodeSnapshotUpload(args.snapshot, args) : undefined
    if (seed && !seed.ok) return seed
    // Claiming the same local project twice would give one browser two cloud
    // replicas racing to append to different logs.
    const existing = await ctx.db
      .query('projects')
      .withIndex('by_owner_local', (q) =>
        q.eq('ownerSubject', identity.subject).eq('localProjectId', args.localProjectId),
      )
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .first()
    if (existing) {
      if (
        args.resumeExisting &&
        seed?.ok &&
        existing.creation?.snapshotGroupId &&
        existing.creation.name === name &&
        existing.creation.visibility === (args.visibility ?? 'private')
      ) {
        const authorised = await authoriseProject(ctx, existing._id, 'transaction.write')
        if (!authorised.ok) return authorised
        const initial = await readSnapshot(ctx, existing.creation.snapshotGroupId, existing._id)
        if (!initial.ok) return initial
        // Compare actual documents, not just the non-cryptographic checksum.
        // Never replace a newer checkpoint or reset the head on a retry.
        if (canonicalJson(initial.value.document) === canonicalJson(seed.value)) {
          const branch = await resolveBranch(ctx, existing)
          if (!branch.ok) return branch
          return { ok: true, value: await summarise(ctx, existing, authorised.value.role) }
        }
      }
      return cloudFailure(
        'NAME_TAKEN',
        'This account already has a cloud copy of that local project.',
        'Open the existing cloud project instead of claiming it again.',
        { projectId: existing._id },
      )
    }

    const now = Date.now()
    const head = args.snapshot?.revision ?? 0
    const projectId = await ctx.db.insert('projects', {
      ownerSubject: identity.subject,
      name,
      visibility: args.visibility ?? 'private',
      localProjectId: args.localProjectId,
      schemaVersion: args.schemaVersion,
      catalogVersion: args.catalogVersion,
      createdAt: now,
      updatedAt: now,
    })
    const branchId = await ctx.db.insert('branches', {
      projectId,
      name: DEFAULT_BRANCH,
      headRevision: head,
      baseRevision: head,
      kind: 'main',
      createdBySubject: identity.subject,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(projectId, { defaultBranchId: branchId })
    await ctx.db.insert('members', {
      projectId,
      subject: identity.subject,
      role: 'owner',
      displayName: identity.displayName,
      addedAt: now,
    })

    let initialSnapshotGroupId: string | undefined
    if (args.snapshot) {
      const written = await writeSnapshot(ctx, {
        projectId,
        branchId,
        kind: 'checkpoint',
        upload: args.snapshot,
        createdBySubject: identity.subject,
      })
      // All expected refusals were handled before insertion. Unexpected failure
      // must throw so Convex rolls back every row, not commit a broken shell.
      if (!written.ok) throw new Error(`Initial checkpoint failed: ${written.error.code}`)
      initialSnapshotGroupId = written.value
    }
    await ctx.db.patch(projectId, {
      creation: {
        name,
        visibility: args.visibility ?? 'private',
        snapshotGroupId: initialSnapshotGroupId,
      },
    })

    await writeAuditEvent(ctx, {
      projectId,
      actorSubject: identity.subject,
      action: 'project.create',
      detail: { headRevision: head, seeded: Boolean(args.snapshot) },
    })

    const project = await ctx.db.get(projectId)
    if (!project) {
      throw new Error('The project vanished during creation.')
    }
    return { ok: true, value: await summarise(ctx, project, 'owner') }
  },
})

export const rename = mutation({
  args: { projectId: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudProjectSummary>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.rename')
    if (!authorised.ok) return authorised
    const name = args.name.trim()
    if (!name) {
      return cloudFailure('INVALID_ARGUMENT', 'A project needs a name.', 'Type a name and retry.')
    }
    const { project, identity, role } = authorised.value
    await ctx.db.patch(project._id, { name, updatedAt: Date.now() })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'project.rename',
      // The name itself is content and is filtered out by the redactor; the
      // audit trail records that a rename happened, not what it renamed to.
      detail: { nameLength: name.length },
    })
    const updated = await ctx.db.get(project._id)
    return { ok: true, value: await summarise(ctx, updated as Doc<'projects'>, role) }
  },
})

export const setVisibility = mutation({
  args: { projectId: v.string(), visibility },
  handler: async (ctx, args): Promise<CloudResult<CloudProjectSummary>> => {
    // Publishing is an ownership decision: `project.delete` is owner-only and
    // visibility is the same class of irreversible act.
    const authorised = await authoriseProject(ctx, args.projectId, 'project.delete')
    if (!authorised.ok) return authorised
    const { project, identity, role } = authorised.value
    await ctx.db.patch(project._id, { visibility: args.visibility, updatedAt: Date.now() })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'project.setVisibility',
      detail: { visibility: args.visibility },
    })
    const updated = await ctx.db.get(project._id)
    return { ok: true, value: await summarise(ctx, updated as Doc<'projects'>, role) }
  },
})

/**
 * Soft-deletes a project.
 *
 * The rows stay: an owner who deletes a shared project has removed everyone
 * else's access to work they contributed to, and that has to be recoverable by
 * a human on the deployment rather than being irreversible from a browser.
 */
export const remove = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ projectId: string; deletedAt: string }>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.delete')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const now = Date.now()
    await ctx.db.patch(project._id, { deletedAt: now, updatedAt: now })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'project.delete',
      detail: { soft: true },
    })
    return { ok: true, value: { projectId: project._id, deletedAt: iso(now) } }
  },
})

/** Writes a checkpoint for the branch head, mirroring `ProjectRepository.saveCheckpoint`. */
export const saveCheckpoint = mutation({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    snapshot: snapshotUpload,
  },
  handler: async (ctx, args): Promise<CloudResult<{ groupId: string; revision: number }>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'snapshot.write')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const resolved = await resolveBranch(ctx, project, args.branchId)
    if (!resolved.ok) return resolved
    const branch = resolved.value
    const valid = decodeSnapshotUpload(args.snapshot, {
      localProjectId: project.localProjectId,
      schemaVersion: project.schemaVersion,
    })
    if (!valid.ok) return valid
    if (args.snapshot.revision > branch.headRevision) {
      return cloudFailure(
        'STALE_DOCUMENT',
        'A checkpoint cannot precede the transactions that establish its revision.',
        'Sync the missing transactions before retrying this checkpoint; keep the local copy.',
        { headRevision: branch.headRevision, branchId: branch._id },
      )
    }
    const written = await writeSnapshot(ctx, {
      projectId: project._id,
      branchId: branch._id,
      kind: 'checkpoint',
      upload: args.snapshot,
      createdBySubject: identity.subject,
    })
    if (!written.ok) return written
    await ctx.db.patch(project._id, { updatedAt: Date.now() })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'project.checkpoint',
      detail: { revision: args.snapshot.revision, bytes: args.snapshot.bytes },
    })
    return { ok: true, value: { groupId: written.value, revision: args.snapshot.revision } }
  },
})

/** The newest checkpoint at or below `atRevision`, for opening a project. */
export const latestCheckpoint = query({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    atRevision: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudSnapshotRecord | null>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const project = authorised.value.project
    const branch = await resolveBranch(ctx, project, args.branchId)
    if (!branch.ok) return branch
    if (args.atRevision !== undefined && !isRevision(args.atRevision)) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'A checkpoint revision must be a non-negative safe integer.',
        'Choose a stored revision and retry.',
      )
    }
    const ceiling = Math.min(args.atRevision ?? branch.value.headRevision, branch.value.headRevision)
    return latestBranchCheckpoint(ctx, project._id, branch.value._id, ceiling)
  },
})

export const auditTrail = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<CloudResult<CloudAuditRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'audit.read')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('auditEvents')
      .withIndex('by_project_at', (q) => q.eq('projectId', authorised.value.project._id))
      .order('desc')
      .take(Math.min(Math.max(args.limit ?? 100, 1), 500))
    return { ok: true, value: rows.map(auditRecord) }
  },
})
