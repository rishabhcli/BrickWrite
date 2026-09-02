import { v } from 'convex/values'
import { listOverflow } from './model/discovery'
import type { Id } from './_generated/dataModel'
import { internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'
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
import {
  CHECKPOINT_PRUNE_CHUNKS,
  deleteSnapshotGroup,
  latestBranchCheckpoint,
  readSnapshot,
  recordCheckpointGroup,
  writeSnapshot,
} from './model/snapshots'
import { canonicalJson, checksumOfText, chunkText, utf8Bytes } from './model/checksum'
import { isRevision } from './model/history'
import { SNAPSHOT_CHUNK_BYTES } from './model/protocol'
import { collectionFull, COLLECTION_LIMITS } from './model/limits'

/** Log rows removed per pass; a transaction is up to half a megabyte. */
const BRANCH_PRUNE_TRANSACTIONS = 8
import { snapshotUpload } from './model/validators'
import { decodeSnapshotUpload } from './model/snapshotValidation'

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

    const saved = await ctx.db
      .query('versions')
      .withIndex('by_project_created', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.versionsPerProject)
    const versionsFull = collectionFull(
      saved.length,
      COLLECTION_LIMITS.versionsPerProject,
      'saved versions',
      'Delete a version you no longer need before saving another.',
    )
    if (versionsFull) return versionsFull

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
      .take(201)
    const overflow = listOverflow(rows.length, 200, 'discovery:versions')
    if (overflow) return overflow
    return { ok: true, value: rows.map(versionRecord) }
  },
})

/**
 * Deletes a named version, and the document it pinned.
 *
 * The per-project ceiling refused a two-hundred-and-first version and told the
 * caller to delete one, and there was no way to. It is also the only way to
 * reclaim a version's snapshot: automatic checkpoints are pruned to a window,
 * a named one is kept forever by design, and forever is a lot of eight-megabyte
 * documents on a project somebody has been saving into for a year.
 *
 * The creator may remove their own; removing somebody else's needs
 * `project.delete`, which only an owner holds. A version is how a collaborator
 * refers to a point in history, so taking one away is an owner's decision
 * rather than any editor's.
 *
 * The log is untouched. A version is a name for a revision, not the revision,
 * and the branch replays exactly as it did before.
 */
export const remove = mutation({
  args: { projectId: v.string(), versionId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ removed: boolean }>> => {
    const reader = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value

    const version = await ctx.db.get(args.versionId as Id<'versions'>)
    if (!version || version.projectId !== project._id) {
      return cloudFailure(
        'NOT_FOUND',
        'That version does not belong to this project.',
        'Reload the version list and choose again.',
      )
    }
    if (version.createdBySubject !== identity.subject) {
      const authorised = await authoriseProject(ctx, args.projectId, 'project.delete')
      if (!authorised.ok) return authorised
    }

    // The row goes first, so nothing can follow it to a group being emptied.
    await ctx.db.delete(version._id)
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'version.delete',
      detail: { versionId: version._id, revision: version.revision, labelLength: version.label.length },
    })
    // Scheduled for the same reason checkpoint pruning is: the chunks have to
    // be read to be deleted and a whole document does not fit alongside this.
    await ctx.scheduler.runAfter(0, internal.versions.pruneVersionSnapshot, {
      groupId: version.snapshotGroupId,
    })
    return { ok: true, value: { removed: true } }
  },
})

/** Empties a deleted version's snapshot group, a bounded pass at a time. */
export const pruneVersionSnapshot = internalMutation({
  args: { groupId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    if (await deleteSnapshotGroup(ctx, args.groupId, 'version')) {
      await ctx.scheduler.runAfter(0, internal.versions.pruneVersionSnapshot, { groupId: args.groupId })
    }
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
    recovery: v.optional(v.object({ key: v.string(), snapshot: snapshotUpload })),
  },
  handler: async (ctx, args): Promise<CloudResult<CloudBranchRecord>> => {
    const authorised = await authoriseProject(ctx, args.projectId, 'branch.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const name = args.name.trim()
    if (!name) {
      return cloudFailure('INVALID_ARGUMENT', 'A branch needs a name.', 'Name the branch and retry.')
    }
    const siblings = await ctx.db
      .query('branches')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.branchesPerProject)
    const branchesFull = collectionFull(
      siblings.length,
      COLLECTION_LIMITS.branchesPerProject,
      'branches',
      'Merge or delete a branch before opening another.',
    )
    if (branchesFull) return branchesFull

    const parentResult = await resolveBranch(ctx, project, args.fromBranchId)
    if (!parentResult.ok) return parentResult
    const parent = parentResult.value

    const recovery = args.recovery
    if (
      recovery &&
      (args.kind !== 'conflict' ||
        args.atRevision === undefined ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(recovery.key) ||
        recovery.snapshot.revision !== args.atRevision)
    ) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'Recovery needs a stable key and an exact conflict-fork checkpoint.',
        'Retry with the original divergence revision, key and checkpoint.',
      )
    }
    // Validate before any writes: typed refusals do not roll back mutations.
    const seed = recovery
      ? decodeSnapshotUpload(recovery.snapshot, {
          localProjectId: project.localProjectId,
          schemaVersion: project.schemaVersion,
        })
      : undefined
    if (seed && !seed.ok) return seed
    if (recovery && seed?.ok) {
      const existing = await ctx.db
        .query('branches')
        .withIndex('by_recovery', (q) =>
          q.eq('projectId', project._id).eq('createdBySubject', identity.subject).eq('recoveryKey', recovery.key),
        )
        .unique()
      if (existing) {
        if (
          existing.kind !== 'conflict' ||
          existing.name !== name ||
          existing.forkedFromBranchId !== parent._id ||
          existing.baseRevision !== args.atRevision ||
          !existing.recoverySnapshotGroupId
        ) {
          return cloudFailure(
            'INVALID_ARGUMENT',
            'This recovery key already identifies a different fork.',
            'Retry the original request; do not reuse recovery keys for different work.',
          )
        }
        const original = await readSnapshot(ctx, existing.recoverySnapshotGroupId, project._id)
        if (!original.ok) return original
        // Full content comparison, not a checksum or the latest mutable checkpoint.
        if (canonicalJson(original.value.document) !== canonicalJson(seed.value)) {
          return cloudFailure(
            'INVALID_ARGUMENT',
            'This recovery key was created with a different checkpoint.',
            'Keep both local copies and retry the original recovery request.',
          )
        }
        return { ok: true, value: branchRecord(existing) }
      }
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
    const source = recovery
      ? { ok: true as const, value: null }
      : await latestBranchCheckpoint(ctx, project._id, parent._id, at)
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
      recoveryKey: recovery?.key,
      createdAt: now,
      updatedAt: now,
    })
    if (recovery) {
      const seeded = await writeSnapshot(ctx, {
        projectId: project._id,
        branchId,
        kind: 'checkpoint',
        createdBySubject: identity.subject,
        upload: recovery.snapshot,
      })
      // Unexpected failures throw so branch, chunks and receipt roll back together.
      if (!seeded.ok) throw new Error(`Recovery checkpoint failed: ${seeded.error.code}`)
      await ctx.db.patch(branchId, { recoverySnapshotGroupId: seeded.value })
      await recordCheckpointGroup(ctx, branchId, seeded.value)
    } else if (source.value) {
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
      await recordCheckpointGroup(ctx, branchId, seeded.value)
    }
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'branch.create',
      detail: { branchId, fromBranchId: parent._id, atRevision: at, nameLength: name.length },
    })
    const row = await ctx.db.get(branchId)
    if (!row) throw new Error('The branch vanished during creation.')
    return { ok: true, value: branchRecord(row) }
  },
})

/**
 * Deletes a branch, its log and its checkpoints.
 *
 * The last ceiling with no way down from it: sixty-four branches refused a
 * sixty-fifth and nothing could remove one.
 *
 * Four things are refused rather than worked around, because each would break
 * something that is not this branch:
 *
 *   - The default branch. `resolveBranch` falls back to it, so a project
 *     without one cannot be opened at all.
 *   - A branch something forked from. `readBranchHistory` walks
 *     `forkedFromBranchId` to replay a child through its fork revision, so
 *     removing a parent makes its children unreplayable.
 *   - An open proposal. Deleting the branch under one would withdraw it
 *     silently; the decision belongs in the audit trail.
 *   - Named versions. Those are somebody's points in history and are governed
 *     by their own delete, which an owner or their creator can use first.
 *
 * Authorised as `versions.remove` is: the branch's creator, or an owner.
 */
export const removeBranch = mutation({
  args: { projectId: v.string(), branchId: v.string() },
  handler: async (ctx, args): Promise<CloudResult<{ removed: boolean }>> => {
    const reader = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value

    const resolved = await resolveBranch(ctx, project, args.branchId)
    if (!resolved.ok) return resolved
    const branch = resolved.value

    if (branch._id === project.defaultBranchId) {
      return cloudFailure(
        'FORBIDDEN',
        'The default branch cannot be deleted.',
        'Delete the project instead; every other branch forks from this one.',
      )
    }
    if (branch.proposal?.status === 'open') {
      return cloudFailure(
        'FORBIDDEN',
        'That branch has an open merge proposal.',
        'Withdraw or decide the proposal first, so the decision is recorded.',
      )
    }

    // Bounded by the branches-per-project ceiling, so a scan of small rows
    // rather than an index that exists only for this check.
    const siblings = await ctx.db
      .query('branches')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.branchesPerProject + 1)
    if (siblings.some((row) => row.forkedFromBranchId === branch._id)) {
      return cloudFailure(
        'FORBIDDEN',
        'Another branch was forked from this one.',
        'Delete the branches that fork from it first; their history replays through this one.',
      )
    }

    const pinned = await ctx.db
      .query('versions')
      .withIndex('by_project_created', (q) => q.eq('projectId', project._id))
      .take(COLLECTION_LIMITS.versionsPerProject)
    if (pinned.some((row) => row.branchId === branch._id)) {
      return cloudFailure(
        'FORBIDDEN',
        'That branch holds saved versions.',
        'Delete the versions saved on it first; a version is a point in history somebody named.',
      )
    }

    if (branch.createdBySubject !== identity.subject) {
      const authorised = await authoriseProject(ctx, args.projectId, 'project.delete')
      if (!authorised.ok) return authorised
    }

    // The row goes first, so nothing resolves a branch being emptied.
    await ctx.db.delete(branch._id)
    await writeAuditEvent(ctx, {
      projectId: project._id,
      actorSubject: identity.subject,
      action: 'branch.delete',
      detail: { branchId: branch._id, headRevision: branch.headRevision, nameLength: branch.name.length },
    })
    await ctx.scheduler.runAfter(0, internal.versions.pruneDeletedBranch, { branchId: branch._id })
    return { ok: true, value: { removed: true } }
  },
})

/**
 * Empties a deleted branch, a bounded pass at a time.
 *
 * A transaction is up to half a megabyte and a checkpoint is up to eight, and
 * both have to be read to be deleted — so the work is spread across
 * transactions rather than attempted in the one that removed the branch.
 */
export const pruneDeletedBranch = internalMutation({
  args: { branchId: v.id('branches') },
  handler: async (ctx, args): Promise<void> => {
    const edits = await ctx.db
      .query('transactions')
      .withIndex('by_branch_revision', (q) => q.eq('branchId', args.branchId))
      .take(BRANCH_PRUNE_TRANSACTIONS)
    for (const edit of edits) await ctx.db.delete(edit._id)
    if (edits.length === BRANCH_PRUNE_TRANSACTIONS) {
      await ctx.scheduler.runAfter(0, internal.versions.pruneDeletedBranch, { branchId: args.branchId })
      return
    }

    const chunks = await ctx.db
      .query('snapshots')
      .withIndex('by_branch_kind_revision', (q) => q.eq('branchId', args.branchId).eq('kind', 'checkpoint'))
      .take(CHECKPOINT_PRUNE_CHUNKS)
    for (const chunk of chunks) await ctx.db.delete(chunk._id)
    if (chunks.length === CHECKPOINT_PRUNE_CHUNKS) {
      await ctx.scheduler.runAfter(0, internal.versions.pruneDeletedBranch, { branchId: args.branchId })
    }
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
      detail: { branchId: sourceResult.value._id, intoBranchId: targetResult.value._id },
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
      detail: { branchId: branch._id, atRevision: branch.headRevision, decidedAt: iso(now) },
    })
    const row = await ctx.db.get(branch._id)
    if (!row) return cloudFailure('NOT_FOUND', 'That branch is gone.', 'Reload the branch list.')
    return { ok: true, value: branchRecord(row) }
  },
})
