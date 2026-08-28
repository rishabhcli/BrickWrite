import type { ModelDocument, PartInstance, Transaction } from '../cad/types'
import {
  canonicalJson,
  checksumOf,
  checksumOfText,
  chunkText,
  utf8Bytes,
} from '../../convex/model/checksum'
import { SNAPSHOT_CHUNK_BYTES, type SnapshotUpload } from './protocol'

/**
 * Turning kernel values into wire payloads.
 *
 * One serializer, used by the outbox, the claim path and the version writer, so
 * a checksum computed at enqueue time still matches when the entry is drained
 * an hour and one page reload later. `canonicalJson` sorts keys, which is what
 * makes that true across two different code paths building the same document.
 */

export {
  canonicalJson,
  checksumOf,
  checksumOfText,
  chunkText,
  utf8Bytes,
} from '../../convex/model/checksum'

/** Chunked upload for a document, ready for `saveCheckpoint` or `createVersion`. */
export function snapshotUploadFor(document: ModelDocument): SnapshotUpload {
  const text = canonicalJson(document)
  return {
    revision: document.revision,
    chunks: chunkText(text, SNAPSHOT_CHUNK_BYTES),
    checksum: checksumOfText(text),
    bytes: utf8Bytes(text),
    schemaVersion: document.schemaVersion,
    catalogVersion: document.catalogVersion,
  }
}

export const documentChecksum = (document: ModelDocument): string => checksumOf(document)

export const transactionChecksum = (transaction: Transaction): string => checksumOf(transaction)

/**
 * Checksum of a part's pose and appearance.
 *
 * This is what a comment anchor pins. Deliberately narrow: it covers where the
 * part is, what it is and how it looks, and not which step or subassembly it
 * belongs to — re-ordering the build sequence does not move a brick, so it
 * should not make every comment report a moved anchor.
 */
export function poseChecksumOf(part: PartInstance): string {
  return checksumOf({
    definitionId: part.definitionId,
    color: part.color,
    position: part.transform.position,
    basis: part.transform.basis,
  })
}
