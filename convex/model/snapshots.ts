import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { checksumOfText, utf8Bytes } from './checksum'
import {
  cloudFailure,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_CHUNK_BYTES,
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

/** Chunk rows stay well inside the per-document limit even for wide characters. */
const MAX_CHUNK_BYTES = SNAPSHOT_CHUNK_BYTES * 2

export function validateSnapshotUpload(upload: SnapshotUpload): CloudResult<string> {
  if (upload.bytes > MAX_SNAPSHOT_BYTES) {
    return cloudFailure(
      'PAYLOAD_TOO_LARGE',
      `That checkpoint is ${Math.round(upload.bytes / 1024)} KiB; the ceiling is ${Math.round(
        MAX_SNAPSHOT_BYTES / 1024,
      )} KiB.`,
      'Split the model into linked subassemblies, or keep this project local-only.',
      { bytes: upload.bytes, limit: MAX_SNAPSHOT_BYTES },
    )
  }
  if (upload.chunks.length === 0) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'A checkpoint upload carried no chunks.',
      'Re-serialize the document before uploading.',
    )
  }
  for (const chunk of upload.chunks) {
    if (utf8Bytes(chunk) > MAX_CHUNK_BYTES) {
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        'One checkpoint chunk exceeded the per-row ceiling.',
        `Re-chunk the document at ${SNAPSHOT_CHUNK_BYTES} characters per chunk.`,
        { limit: MAX_CHUNK_BYTES },
      )
    }
  }
  const text = upload.chunks.join('')
  const measured = utf8Bytes(text)
  if (measured !== upload.bytes) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      `The upload declared ${upload.bytes} bytes but carried ${measured}.`,
      'Re-serialize and retry; the chunks were assembled from a stale document.',
    )
  }
  const digest = checksumOfText(text)
  if (digest !== upload.checksum) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      'The uploaded checkpoint does not match its own checksum.',
      'Re-serialize and retry.',
      { expected: upload.checksum, actual: digest },
    )
  }
  return { ok: true, value: text }
}

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
  const chunks = await ctx.db
    .query('snapshots')
    .withIndex('by_group', (q) => q.eq('groupId', groupId))
    .collect()

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
