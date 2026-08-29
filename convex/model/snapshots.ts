import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { checksumOfText } from './checksum'
import { validateSnapshotUpload } from './limits'
import {
  cloudFailure,
  type CloudResult,
  type CloudSnapshotRecord,
  type SnapshotUpload,
} from './protocol'
import { iso } from './auth'

/**
 * Chunked checkpoint storage.
 *
 * A Convex document is capped at 1 MiB and a large model's checkpoint is not,
 * so a snapshot is written as several rows sharing a `groupId` inside one
 * mutation — which makes the whole group atomic. Every chunk carries the count
 * and the checksum of the *whole* document, so a read can tell the difference
 * between "this is all of it" and "some of it is missing" without consulting
 * another table.
 *
 * The server recomputes the checksum on write rather than trusting the one it
 * was handed. A client that truncated a document would otherwise store a
 * truncated document with a matching digest and discover it much later.
 */

export async function writeSnapshot(
  ctx: MutationCtx,
  args: {
    projectId: Id<'projects'>
    branchId?: Id<'branches'>
    kind: 'checkpoint' | 'version'
    upload: SnapshotUpload
    createdBySubject: string
  },
): Promise<CloudResult<string>> {
  const validated = validateSnapshotUpload(args.upload)
  if (!validated.ok) return validated

  const groupId = crypto.randomUUID()
  const chunkCount = args.upload.chunks.length
  const createdAt = Date.now()
  for (let index = 0; index < chunkCount; index += 1) {
    await ctx.db.insert('snapshots', {
      projectId: args.projectId,
      branchId: args.branchId,
      groupId,
      kind: args.kind,
      revision: args.upload.revision,
      chunkIndex: index,
      chunkCount,
      data: args.upload.chunks[index],
      checksum: args.upload.checksum,
      bytes: args.upload.bytes,
      schemaVersion: args.upload.schemaVersion,
      catalogVersion: args.upload.catalogVersion,
      createdBySubject: args.createdBySubject,
      createdAt,
    })
  }
  return { ok: true, value: groupId }
}

/**
 * Reassembles a snapshot group.
 *
 * Refuses on a short read instead of returning what it found: a checkpoint with
 * chunks missing parses into a document that is missing parts, and handing that
 * back would look exactly like a model somebody deleted half of.
 */
export async function readSnapshot(
  ctx: QueryCtx,
  groupId: string,
  projectId: Id<'projects'>,
): Promise<CloudResult<CloudSnapshotRecord>> {
  const peek = await ctx.db
    .query('snapshots')
    .withIndex('by_group', (q) => q.eq('groupId', groupId))
    .take(1)

  if (peek.length === 0) {
    return cloudFailure(
      'NOT_FOUND',
      'That checkpoint is not stored in this deployment.',
      'Pick another version, or re-upload a checkpoint from the open document.',
    )
  }
  const expected = peek[0].chunkCount
  const chunks = await ctx.db
    .query('snapshots')
    .withIndex('by_group', (q) => q.eq('groupId', groupId))
    .take(expected + 1)

  if (chunks.length === 0) {
    return cloudFailure(
      'NOT_FOUND',
      'That checkpoint is not stored in this deployment.',
      'Pick another version, or re-upload a checkpoint from the open document.',
    )
  }
  const first = chunks[0] as Doc<'snapshots'>
  if (first.projectId !== projectId) {
    return cloudFailure(
      'NOT_FOUND',
      'That checkpoint belongs to a different project.',
      'Reload the version list and choose again.',
    )
  }
  if (chunks.length !== first.chunkCount) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      `That checkpoint stored ${first.chunkCount} chunks but only ${chunks.length} are present.`,
      'Restore an earlier version; this one cannot be reassembled.',
      { expected: first.chunkCount, actual: chunks.length },
    )
  }
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  const text = ordered.map((chunk) => chunk.data).join('')
  if (checksumOfText(text) !== first.checksum) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      'The stored checkpoint failed its checksum.',
      'Restore an earlier version; this one is corrupt.',
    )
  }
  let document: CloudSnapshotRecord['document']
  try {
    document = JSON.parse(text) as CloudSnapshotRecord['document']
  } catch {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      'The stored checkpoint is not valid JSON.',
      'Restore an earlier version; this one is corrupt.',
    )
  }
  return {
    ok: true,
    value: {
      projectId: first.projectId,
      branchId: first.branchId,
      groupId: first.groupId,
      kind: first.kind,
      revision: first.revision,
      checksum: first.checksum,
      bytes: first.bytes,
      schemaVersion: first.schemaVersion,
      catalogVersion: first.catalogVersion,
      createdBySubject: first.createdBySubject,
      createdAt: iso(first.createdAt),
      document,
    },
  }
}

/**
 * Copies the newest parent-branch checkpoint at or below `atRevision` onto a
 * newly created branch. Named branches created from the UI used to have no
 * checkpoint, so `loadProject` could not open them.
 */
export async function copyLatestCheckpointToBranch(
  ctx: MutationCtx,
  args: {
    projectId: Id<'projects'>
    fromBranchId: Id<'branches'>
    toBranchId: Id<'branches'>
    atRevision: number
    createdBySubject: string
  },
): Promise<CloudResult<string | null>> {
  const rows = await ctx.db
    .query('snapshots')
    .withIndex('by_project_kind_revision', (q) =>
      q.eq('projectId', args.projectId).eq('kind', 'checkpoint').lte('revision', args.atRevision),
    )
    .order('desc')
    .take(256)
  const newest = rows.find((row) => row.chunkIndex === 0 && row.branchId === args.fromBranchId)
  // Named-branch create treats a missing checkpoint as failure so the branch
  // cannot be opened as an empty shell. Conflict forks are allowed to continue
  // unseeded: they write their own checkpoint immediately after create.
  if (!newest) return { ok: true, value: null }

  const source = await ctx.db
    .query('snapshots')
    .withIndex('by_group', (q) => q.eq('groupId', newest.groupId))
    .take(newest.chunkCount + 1)
  if (source.length !== newest.chunkCount) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      'The parent branch checkpoint cannot be copied because it is incomplete.',
      'Save a checkpoint on the source branch and create the branch again.',
    )
  }

  const groupId = crypto.randomUUID()
  const createdAt = Date.now()
  for (const chunk of source) {
    await ctx.db.insert('snapshots', {
      projectId: args.projectId,
      branchId: args.toBranchId,
      groupId,
      kind: 'checkpoint',
      revision: newest.revision,
      chunkIndex: chunk.chunkIndex,
      chunkCount: newest.chunkCount,
      data: chunk.data,
      checksum: chunk.checksum,
      bytes: chunk.bytes,
      schemaVersion: chunk.schemaVersion,
      catalogVersion: chunk.catalogVersion,
      createdBySubject: args.createdBySubject,
      createdAt,
    })
  }
  return { ok: true, value: groupId }
}
