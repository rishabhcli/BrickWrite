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

/** Chunk rows stay well inside Convex's per-document limit even for wide characters. */
export const MAX_CHUNK_BYTES = SNAPSHOT_CHUNK_BYTES * 2

/**
 * Checks an upload and returns the reassembled text.
 *
 * The checksum is recomputed rather than trusted. A client that truncated a
 * document would otherwise store a truncated document with a matching digest,
 * and the loss would surface as a model that quietly lost parts.
 */
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
