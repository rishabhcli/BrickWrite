import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { checksumOfText, utf8Bytes } from './checksum'
import { MAX_SNAPSHOT_CHUNKS } from './limits'
import { decodeSnapshotUpload } from './snapshotValidation'
import { cloudFailure, type CloudResult, type CloudSnapshotRecord, type SnapshotUpload } from './protocol'
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
  const project = await ctx.db.get(args.projectId)
  if (!project) return cloudFailure('NOT_FOUND', 'The snapshot project is missing.', 'Reload the project list.')
  const validated = decodeSnapshotUpload(args.upload, {
    localProjectId: project.localProjectId,
    schemaVersion: project.schemaVersion,
  })
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
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_SNAPSHOT_CHUNKS) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      'The stored checkpoint has an invalid chunk count.',
      'Restore a complete saved version; this checkpoint cannot safely be read.',
    )
  }
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
  if (
    ordered.some(
      (chunk, index) =>
        chunk.chunkIndex !== index ||
        chunk.projectId !== first.projectId ||
        chunk.branchId !== first.branchId ||
        chunk.kind !== first.kind ||
        chunk.revision !== first.revision ||
        chunk.chunkCount !== first.chunkCount ||
        chunk.checksum !== first.checksum ||
        chunk.bytes !== first.bytes ||
        chunk.schemaVersion !== first.schemaVersion ||
        chunk.catalogVersion !== first.catalogVersion,
    )
  ) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      'The checkpoint chunks have inconsistent metadata.',
      'Restore a complete saved version; this checkpoint cannot safely be reassembled.',
    )
  }
  const text = ordered.map((chunk) => chunk.data).join('')
  if (utf8Bytes(text) !== first.bytes || checksumOfText(text) !== first.checksum) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      'The stored checkpoint failed its checksum.',
      'Restore an earlier version; this one is corrupt.',
    )
  }
  const project = await ctx.db.get(projectId)
  if (!project) return cloudFailure('NOT_FOUND', 'The snapshot project is missing.', 'Reload the project list.')
  const decoded = decodeSnapshotUpload(
    { ...first, chunks: ordered.map((chunk) => chunk.data) },
    {
      localProjectId: project.localProjectId,
      schemaVersion: project.schemaVersion,
    },
  )
  if (!decoded.ok) {
    return cloudFailure(
      'INCOMPLETE_SNAPSHOT',
      'The stored checkpoint is not a complete document matching its project and metadata.',
      'Restore a complete saved version; this checkpoint cannot safely be replayed.',
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
      document: decoded.value,
    },
  }
}

/** Index the selected branch before limiting, so busy siblings cannot hide it. */
export async function latestBranchCheckpoint(
  ctx: QueryCtx,
  projectId: Id<'projects'>,
  branchId: Id<'branches'>,
  atRevision: number,
): Promise<CloudResult<CloudSnapshotRecord | null>> {
  const newest = await ctx.db
    .query('snapshots')
    .withIndex('by_branch_kind_revision', (q) =>
      q.eq('branchId', branchId).eq('kind', 'checkpoint').lte('revision', atRevision),
    )
    .order('desc')
    .filter((q) => q.eq(q.field('chunkIndex'), 0))
    .first()
  if (!newest) return { ok: true, value: null }
  return readSnapshot(ctx, newest.groupId, projectId)
}
