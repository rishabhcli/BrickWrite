import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import { writeAuditEvent } from './model/audit'
import { authoriseProject, iso, resolveBranch } from './model/auth'
import {
  cloudFailure,
  type CloudBranchRecord,
  type CloudResult,
  type CloudSnapshotRecord,
  type CloudVersionRecord,
} from './model/protocol'
import { branchRecord, versionRecord } from './model/records'
import { latestBranchCheckpoint, readSnapshot, writeSnapshot } from './model/snapshots'
import { canonicalJson, checksumOfText, chunkText, utf8Bytes } from './model/checksum'
import { isRevision } from './model/history'
import { SNAPSHOT_CHUNK_BYTES } from './model/protocol'
import { snapshotUpload } from './model/validators'

/**
 * Versions, branches and merge proposals.
 *
 * A version is a label pinned to a snapshot group, and neither the version row
 * nor the snapshot rows are ever patched. That is the whole guarantee: once a
 * version exists, the only way its content can change is if somebody adds a
 * `ctx.db.patch` to this file, which is why the restore path below writes a new
 * version instead of moving an old one.
 *
 * A merge is proposed by an editor and landed by an owner. Both transitions
 * write to `auditEvents`, so "who put this in main" is answerable later.
 */

export const create = mutation({
  args: {
    projectId: v.string(),
    branchId: v.optional(v.string()),
    label: v.string(),
    notes: v.optional(v.string()),
    snapshot: snapshotUpload,
  },
  handler: async (ctx, args): Promise<CloudResult<CloudVersionRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'version.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    const label = args.label.trim()
    if (!label) {
      return cloudFailure('INVALID_ARGUMENT', 'A version needs a label.', 'Name the version and retry.')
    }
    const branchResult = await resolveBranch(ctx, project, args.branchId)
    if (!branchResult.ok) return branchResult
    const branch = branchResult.value

    // Labels are how a human refers to a version, so two versions may not share
    // one: "restore v2" has to be unambiguous.
    const clash = await ctx.db
      .query('versions')
      .withIndex('by_project_label', (q) => q.eq('projectId', project._id).eq('label', label))
      .first()
    if (clash) {
      return cloudFailure(
        'NAME_TAKEN',
        'This project already has a version with that label.',
        'Choose a different label; versions are never overwritten.',
        { versionId: clash._id },
      )
    }

    const written = await writeSnapshot(ctx, {
      projectId: project._id,
      branchId: branch._id,
      kind: 'version',
      upload: args.snapshot,
      createdBySubject: identity.subject,
    })
    if (!written.ok) return written

    const versionId = await ctx.db.insert('versions', {
      projectId: project._id,
      branchId: branch._id,
      revision: args.snapshot.revision,
      label,
      notes: args.notes,
      snapshotGroupId: written.value,
      documentChecksum: args.snapshot.checksum,
      createdBySubject: identity.subject,
      createdAt: Date.now(),
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'version.create',
      detail: { revision: args.snapshot.revision, bytes: args.snapshot.bytes, branch: branch.name },
    })
    const row = await ctx.db.get(versionId)
    if (!row) throw new Error('The version vanished during creation.')
    return { ok: true, value: versionRecord(row) }
  },
})

export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudVersionRecord[]>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const rows = await ctx.db
      .query('versions')
      .withIndex('by_project_created', (q) => q.eq('projectId', authorised.value.project._id))
      .order('desc')
      .take(200)
    return { ok: true, value: rows.map(versionRecord) }
  },
})

/** Reassembles the document a version pinned. Byte-identical to what was stored. */
export const document = query({
  args: { projectId: v.string(), versionId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<CloudSnapshotRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const project = authorised.value.project
    const version = await ctx.db.get(args.versionId as Id<'versions'>)
    if (!version || version.projectId !== project._id) {
      return cloudFailure(
        'NOT_FOUND',
        'That version does not belong to this project.',
        'Reload the version list and choose again.',
      )
    }
    return readSnapshot(ctx, version.snapshotGroupId, project._id)
  },
})

export const createBranch = mutation({
  args: {
    projectId: v.string(),
    name: v.string(),
    kind: v.optional(v.union(v.literal('named'), v.literal('conflict'))),
    fromBranchId: v.optional(v.string()),
    atRevision: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudBranchRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'branch.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const name = args.name.trim()
    if (!name) {
      return cloudFailure('INVALID_ARGUMENT', 'A branch needs a name.', 'Name the branch and retry.')
    }
    const clash = await ctx.db
      .query('branches')
      .withIndex('by_project_name', (q) => q.eq('projectId', project._id).eq('name', name))
      .first()
    if (clash) {
      return cloudFailure('NAME_TAKEN', 'This project already has a branch with that name.', 'Choose another name.', {
        branchId: clash._id,
      })
    }
    const parentResult = await resolveBranch(ctx, project, args.fromBranchId)
    if (!parentResult.ok) return parentResult
    const parent = parentResult.value

    // A fork defaults to the parent's head. A conflict fork names an earlier
    // revision — where the two histories diverged — so the tail that lost the
    // race replays onto it exactly as it was authored. Forking past the head
    // would invent history the parent never had.
    const at = args.atRevision ?? parent.headRevision
    if (!isRevision(at) || at > parent.headRevision) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        `A branch cannot fork at revision ${at}; ${parent.name} runs to ${parent.headRevision}.`,
        'Fork at the divergence revision or at the branch head.',
      )
    }

    // Validate before inserting anything: returning a typed error from a
    // Convex mutation commits earlier writes; it does not roll them back.
    const source = await latestBranchCheckpoint(ctx, project._id, parent._id, at)
    if (!source.ok) return source
    if (!source.value && (args.kind ?? 'named') !== 'conflict') {
      return cloudFailure(
        'NOT_FOUND',
        'The source branch has no checkpoint to copy, so the new branch would not open.',
        'Save the source branch once, then create the named branch.',
      )
    }

    const now = Date.now()
    const branchId = await ctx.db.insert('branches', {
      projectId: project._id,
      name,
      headRevision: at,
      baseRevision: at,
      forkedFromBranchId: parent._id,
      kind: args.kind ?? 'named',
      createdBySubject: identity.subject,
      createdAt: now,
      updatedAt: now,
    })
    if (source.value) {
      const snapshot = source.value
      const text = canonicalJson(snapshot.document)
      const seeded = await writeSnapshot(ctx, {
        projectId: project._id,
        branchId,
        kind: 'checkpoint',
        createdBySubject: identity.subject,
        upload: {
          revision: snapshot.revision,
          schemaVersion: snapshot.schemaVersion,
          catalogVersion: snapshot.catalogVersion,
          bytes: utf8Bytes(text),
          checksum: checksumOfText(text),
          chunks: chunkText(text, SNAPSHOT_CHUNK_BYTES),
        },
      })
      // Unexpected write failure must roll back the new branch, not commit an
      // unopenable shell. Expected source errors were returned above, pre-write.
      if (!seeded.ok) throw new Error(`Branch checkpoint failed: ${seeded.error.code}`)
    }
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'branch.create',
      detail: { branch: name, from: parent.name, atRevision: at },
    })
    const row = await ctx.db.get(branchId)
    if (!row) throw new Error('The branch vanished during creation.')
    return { ok: true, value: branchRecord(row) }
  },
})

export const proposeMerge = mutation({
  args: {
    projectId: v.string(),
    branchId: v.string(),
    intoBranchId: v.optional(v.string()),
    summary: v.string(),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudBranchRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'branch.propose')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    const sourceResult = await resolveBranch(ctx, project, args.branchId)
    if (!sourceResult.ok) return sourceResult
    const targetResult = await resolveBranch(ctx, project, args.intoBranchId)
    if (!targetResult.ok) return targetResult
    if (sourceResult.value._id === targetResult.value._id) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'A branch cannot be merged into itself.',
        'Pick a different target branch.',
      )
    }
    if (sourceResult.value.proposal?.status === 'open') {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'That branch already has an open merge proposal.',
        'Withdraw the open proposal before opening another.',
      )
    }

    const now = Date.now()
    await ctx.db.patch(sourceResult.value._id, {
      proposal: {
        intoBranchId: targetResult.value._id,
        status: 'open',
        proposedBySubject: identity.subject,
        proposedAt: now,
        summary: args.summary.slice(0, 500),
      },
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'branch.propose',
      detail: { branch: sourceResult.value.name, into: targetResult.value.name },
    })
    const row = await ctx.db.get(sourceResult.value._id)
    if (!row) return cloudFailure('NOT_FOUND', 'That branch is gone.', 'Reload the branch list.')
    return { ok: true, value: branchRecord(row) }
  },
})

/**
 * Records the decision on a merge proposal.
 *
 * Deliberately does not move any transaction. Replaying a branch's log onto
 * another head is a rebase, and a rebase that is not provably safe has to be
 * shown to a human first — `src/cloud/rebase.ts` decides that, and lands the
 * result through `transactions.append` like any other edit. This mutation only
 * records who decided what, so the audit trail is complete either way.
 */
export const decideMerge = mutation({
  args: {
    projectId: v.string(),
    branchId: v.string(),
    decision: v.union(v.literal('merged'), v.literal('rejected'), v.literal('withdrawn')),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudBranchRecord>> => {
    const capability = args.decision === 'withdrawn' ? 'branch.propose' : 'branch.merge'
    const authorised = await authoriseProject(ctx, args.projectId, capability)
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    const sourceResult = await resolveBranch(ctx, project, args.branchId)
    if (!sourceResult.ok) return sourceResult
    const branch = sourceResult.value
    if (!branch.proposal || branch.proposal.status !== 'open') {
      return cloudFailure(
        'NOT_FOUND',
        'That branch has no open merge proposal.',
        'Open a proposal before deciding on one.',
      )
    }
    if (args.decision === 'withdrawn' && branch.proposal.proposedBySubject !== identity.subject) {
      return cloudFailure(
        'FORBIDDEN',
        'Only the author of a proposal may withdraw it.',
        'Ask an owner to reject it instead.',
      )
    }

    const now = Date.now()
    await ctx.db.patch(branch._id, {
      proposal: {
        ...branch.proposal,
        status: args.decision,
        decidedBySubject: identity.subject,
        decidedAt: now,
      },
      updatedAt: now,
    })
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: `branch.${args.decision}`,
      detail: { branch: branch.name, atRevision: branch.headRevision, decidedAt: iso(now) },
    })
    const row = await ctx.db.get(branch._id)
    if (!row) return cloudFailure('NOT_FOUND', 'That branch is gone.', 'Reload the branch list.')
    return { ok: true, value: branchRecord(row) }
  },
})
