import { z } from 'zod'
import type { ModelDocument } from '../../src/cad/types'
import { validateSnapshotUpload } from './limits'
import { cloudFailure, type CloudResult, type SnapshotUpload } from './protocol'

// Storage-shape validation only: no catalogue, renderer or geometry engine in
// the backend bundle. A physically unfinished model is still valid saved work.
const id = z
  .string()
  .min(1)
  .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key))
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const actor = z.enum(['human', 'agent'])
const vec3 = z.tuple([z.number(), z.number(), z.number()])
const transform = z.object({
  position: vec3,
  basis: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
})
const modulePart = z.object({ definitionId: id, color: z.number().int(), transform })
const part = modulePart.extend({
  id,
  subassemblyId: id,
  stepId: id,
  provenance: actor,
  protected: z.boolean(),
  createdByTransaction: id.optional(),
})
const subassembly = z.object({ id, name: z.string(), partIds: z.array(id), locked: z.boolean(), accent: z.string() })
const endpoint = z.object({ partId: id, featureId: id })
const joint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed') }),
  z.object({ kind: z.literal('revolute'), axis: vec3, continuous: z.boolean(), stepDegrees: z.number().optional() }),
  z.object({ kind: z.literal('prismatic'), axis: vec3, minLdu: z.number(), maxLdu: z.number() }),
  z.object({
    kind: z.literal('cylindrical'),
    axis: vec3,
    minLdu: z.number(),
    maxLdu: z.number(),
    continuousRotation: z.boolean(),
  }),
  z.object({ kind: z.literal('spherical') }),
  z.object({ kind: z.literal('unknown') }),
])
const connection = z.object({
  id,
  a: endpoint,
  b: endpoint,
  family: z.enum([
    'stud',
    'anti-stud',
    'pin',
    'pin-hole',
    'axle',
    'axle-hole',
    'bar',
    'clip',
    'hinge',
    'ball',
    'socket',
    'generic',
  ]),
  joint,
  createdAtRevision: revision,
  source: z.enum(['snap', 'explicit-connect', 'import-inferred']),
})
const dictionary = <T extends { id: string }>(entry: z.ZodType<T>) =>
  z
    .record(id, entry)
    .refine((rows) => Object.entries(rows).every(([key, row]) => key === row.id), 'An entity key must equal its id.')
const unique = <T extends { id: string }>(entry: z.ZodType<T>) =>
  z.array(entry).refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, 'Entity ids must be unique.')
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Expected a timestamp.')
const documentShape: z.ZodType<ModelDocument> = z.object({
  schemaVersion: z.literal(2),
  id,
  name: z.string(),
  revision,
  catalogVersion: z.string().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
  parts: dictionary(part),
  connections: dictionary(connection),
  subassemblies: dictionary(subassembly),
  steps: unique(z.object({ id, index: revision, name: z.string(), partIds: z.array(id) })),
  notes: unique(
    z.object({
      id,
      anchorPartIds: z.array(id),
      text: z.string(),
      status: z.enum(['open', 'resolved']),
      author: actor,
      revisionCreated: revision,
      response: z.string().optional(),
    }),
  ),
  constraints: unique(
    z.object({
      id,
      kind: z.enum(['dimensions', 'palette', 'piece-count', 'symmetry', 'locked-region']),
      label: z.string(),
      value: z.unknown(),
      hard: z.boolean(),
    }),
  ),
  modules: unique(
    z.object({
      id,
      name: z.string(),
      parts: z.array(modulePart),
      sizeLdu: vec3,
      createdAtRevision: revision,
      author: actor,
    }),
  ).optional(),
})

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
