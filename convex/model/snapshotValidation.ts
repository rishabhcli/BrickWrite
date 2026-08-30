import { documentShape } from './cadSchema'
import type { ModelDocument } from '../../src/cad/types'
import { validateSnapshotUpload } from './limits'
import { cloudFailure, type CloudResult, type SnapshotUpload } from './protocol'

export interface SnapshotIdentity {
  localProjectId: string
  schemaVersion: number
  /** Required on initial claim; existing replicas can be opened with a newer catalogue. */
  catalogVersion?: string
}

/** Validate, never normalize: retain all bytes and extension fields on a round trip. */
export function decodeSnapshotUpload(upload: SnapshotUpload, expected?: SnapshotIdentity): CloudResult<ModelDocument> {
  const validated = validateSnapshotUpload(upload)
  if (!validated.ok) return validated
  let raw: unknown
  try {
    raw = JSON.parse(validated.value)
  } catch {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'The snapshot is not valid JSON.',
      'Re-serialize the complete document and retry.',
    )
  }
  // Bound traversal and reject dangerous dictionary keys, including in extension
  // fields. JSON permits overflowing numbers (1e400); saved data must be finite.
  const pending = [{ value: raw, depth: 0 }]
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (depth > 128 || (typeof value === 'number' && !Number.isFinite(value))) {
      return cloudFailure(
        'INVALID_ARGUMENT',
        'The snapshot contains excessive nesting or non-finite numbers.',
        'Re-export a finite document without deeply nested extension data.',
      )
    }
    if (!value || typeof value !== 'object') continue
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) {
        return cloudFailure(
          'INVALID_ARGUMENT',
          'The snapshot contains an unsafe object key.',
          'Use ordinary entity ids and extension field names.',
        )
      }
      pending.push({ value: entry, depth: depth + 1 })
    }
  }
  if (upload.schemaVersion !== 2 || (expected && upload.schemaVersion !== expected.schemaVersion)) {
    return cloudFailure(
      'SCHEMA_MISMATCH',
      'The snapshot uses an unsupported or different document schema.',
      'Reload the application so the document and cloud replica use the same schema.',
    )
  }
  const parsed = documentShape.safeParse(raw)
  if (!parsed.success) {
    // No model values in errors or audit logs: report a bounded field path only.
    const path = parsed.error.issues[0]?.path.map(String).join('.').slice(0, 160) || 'document'
    return cloudFailure(
      'INVALID_ARGUMENT',
      `The snapshot has an invalid document shape at ${path}.`,
      'Re-export the complete schema-2 document; no part of this upload was saved.',
      { path },
    )
  }
  const document = raw as ModelDocument
  if (
    document.revision !== upload.revision ||
    document.schemaVersion !== upload.schemaVersion ||
    document.catalogVersion !== upload.catalogVersion
  ) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'The snapshot document disagrees with its revision, schema or catalogue envelope.',
      'Build the upload and its metadata from the same document.',
    )
  }
  if (
    expected &&
    (document.id !== expected.localProjectId ||
      (expected.catalogVersion !== undefined && document.catalogVersion !== expected.catalogVersion))
  ) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'The snapshot belongs to a different document or initial catalogue.',
      'Upload the document belonging to this project; do not substitute another project checkpoint.',
    )
  }
  return { ok: true, value: document }
}
