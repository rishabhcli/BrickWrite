import { checksumOfText, utf8Bytes } from './checksum'
import {
  cloudFailure,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_CHUNK_BYTES,
  type CloudResult,
  type SnapshotUpload,
} from './protocol'

/**
 * Payload validation, with no database in sight.
 *
 * Pure so that the deployment, the browser and the in-process test double all
 * apply the identical rule. A ceiling that only the server enforces is a
 * ceiling the client discovers by failing at the worst possible moment; a
 * ceiling only the client enforces is not a ceiling at all.
 */

/**
 * How large each collection may get, matching what its list query can return.
 *
 * The list endpoints bound their reads with `.take(n)` and refuse the whole
 * list past `n` (`listOverflow`). Bounding only the read turns an expensive
 * query into a permanently broken one: nothing a client can do shrinks the
 * collection back, and the roles that can grow these are editor and commenter,
 * not owner. So the write side refuses first.
 *
 * Each number is the read ceiling, and the guard refuses at it rather than past
 * it, so a collection can reach the limit but never exceed it.
 */
export const COLLECTION_LIMITS = {
  /** `projects.list` reads the caller's membership rows. */
  membershipsPerAccount: 200,
  /** `projects.branches`. */
  branchesPerProject: 64,
  /** `members.list`. */
  membersPerProject: 200,
  /** `versions.list`. */
  versionsPerProject: 200,
  /** `comments.list`. */
  commentsPerProject: 500,
  /** `comments.forPart`, which is indexed by anchor part. */
  commentsPerPart: 200,
  /** `invitations.list`. */
  invitationsPerProject: 100,
} as const

/**
 * Refuses a write that would make a list unreadable, or null to proceed.
 *
 * `count` comes from a `.take(limit)` on the same index the list query uses, so
 * it costs the collection's actual size and only approaches the limit on the
 * write that is about to be refused.
 */
export function collectionFull(count: number, limit: number, what: string, repair: string) {
  return count >= limit
    ? cloudFailure('COLLECTION_FULL', `This project is at its limit of ${limit} ${what}.`, repair, { limit })
    : null
}

/** Chunk rows stay well inside Convex's per-document limit even for wide characters. */
export const MAX_CHUNK_BYTES = SNAPSHOT_CHUNK_BYTES * 2
/** Bounds row writes even when a caller sends thousands of tiny/empty chunks. */
export const MAX_SNAPSHOT_CHUNKS = 64

/**
 * Checks an upload and returns the reassembled text.
 *
 * The checksum is recomputed rather than trusted. A client that truncated a
 * document would otherwise store a truncated document with a matching digest,
 * and the loss would surface as a model that quietly lost parts.
 */
export function validateSnapshotUpload(upload: SnapshotUpload): CloudResult<string> {
  if (
    !Number.isSafeInteger(upload.bytes) ||
    upload.bytes < 0 ||
    !Number.isSafeInteger(upload.revision) ||
    upload.revision < 0
  ) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'Snapshot bytes and revision must be non-negative safe integers.',
      'Re-serialize the document without changing its revision metadata.',
    )
  }
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
  if (upload.chunks.length > MAX_SNAPSHOT_CHUNKS) {
    return cloudFailure(
      'PAYLOAD_TOO_LARGE',
      'The checkpoint has too many chunks.',
      `Re-chunk at ${SNAPSHOT_CHUNK_BYTES} UTF-8 bytes per chunk.`,
      { limit: MAX_SNAPSHOT_CHUNKS },
    )
  }
  let total = 0
  for (const chunk of upload.chunks) {
    const bytes = utf8Bytes(chunk)
    total += bytes
    if (bytes > MAX_CHUNK_BYTES) {
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        'One checkpoint chunk exceeded the per-row ceiling.',
        `Re-chunk the document at ${SNAPSHOT_CHUNK_BYTES} UTF-8 bytes per chunk.`,
        { limit: MAX_CHUNK_BYTES },
      )
    }
    if (total > MAX_SNAPSHOT_BYTES) {
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        'The actual snapshot bytes exceed the document ceiling.',
        'Split the model into linked subassemblies, or keep this project local-only.',
        { limit: MAX_SNAPSHOT_BYTES },
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
