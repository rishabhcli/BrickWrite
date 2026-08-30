import { describe, expect, it } from 'vitest'
import { decodeSnapshotUpload } from '../../../convex/model/snapshotValidation'
import { MAX_SNAPSHOT_CHUNKS, validateSnapshotUpload } from '../../../convex/model/limits'
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_CHUNK_BYTES } from '../protocol'
import { checksumOfText, chunkText, snapshotUploadFor, utf8Bytes } from '../serialize'
import { blankProject, placements } from './harness'

const base = blankProject('validation')
const upload = snapshotUploadFor(base)
const encoded = (raw: unknown) => {
  const text = JSON.stringify(raw)
  return {
    ...upload,
    chunks: chunkText(text, SNAPSHOT_CHUNK_BYTES),
    bytes: utf8Bytes(text),
    checksum: checksumOfText(text),
  }
}

describe('snapshot shape validation shared by client and deployment', () => {
  it.each([
    { parts: [] },
    { parts: null },
    { connections: undefined },
    { subassemblies: [] },
    { steps: {} },
    { notes: null },
    { constraints: 'none' },
    { modules: {} },
    { createdAt: 'yesterday' },
    { updatedAt: 123 },
    { id: '' },
    { parts: { p: { id: 'p' } } },
    { notes: [{ id: 'n', text: 'A note', author: 'agent', status: 'unknown', anchorPartIds: [], revisionCreated: 0 }] },
  ])('refuses a checksum-valid malformed document: %j', (changes) => {
    expect(decodeSnapshotUpload(encoded({ ...base, ...changes }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('validates part transforms, entity-key consistency and provenance', () => {
    const document = placements(base, ['p']).final
    const p = document.parts.p
    for (const invalid of [
      { ...p, id: 'mismatched' },
      { ...p, provenance: 'robot' },
      { ...p, transform: { ...p.transform, position: [1, 2] } },
      { ...p, transform: { ...p.transform, basis: [1, 0, 0] } },
    ]) {
      expect(decodeSnapshotUpload(encoded({ ...document, parts: { p: invalid } }))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_ARGUMENT' },
      })
    }
  })

  it('rejects duplicate collection ids instead of allowing ambiguous edits', () => {
    expect(decodeSnapshotUpload(encoded({ ...base, steps: [base.steps[0], base.steps[0]] }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('keeps old documents without modules and unrecognized extension fields unchanged', () => {
    const raw = { ...base, modules: undefined, extensions: { authoredBy: 'agent', feedback: ['human review'] } }
    const saved = decodeSnapshotUpload(encoded(raw))
    expect(saved).toEqual({ ok: true, value: JSON.parse(JSON.stringify(raw)) })
    if (saved.ok) expect(Object.hasOwn(saved.value, 'modules')).toBe(false)
  })

  it.each(['__proto__', 'constructor', 'prototype'])('refuses unsafe key %s in extension data', (key) => {
    // Do not use the canonical serializer here: test the raw network boundary.
    const text = JSON.stringify(base).slice(0, -1) + `,"extension":{"${key}":{}}}`
    expect(
      decodeSnapshotUpload({ ...upload, chunks: [text], bytes: utf8Bytes(text), checksum: checksumOfText(text) }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })

  it('rejects overflowing JSON numbers even in unknown extension fields', () => {
    const text = JSON.stringify(base).slice(0, -1) + ',"extension":1e400}'
    expect(
      decodeSnapshotUpload({ ...upload, chunks: [text], bytes: utf8Bytes(text), checksum: checksumOfText(text) }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })

  it('bounds nesting before schema parsing or canonicalization', () => {
    const text = JSON.stringify(base).slice(0, -1) + ',"extension":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}'
    expect(
      decodeSnapshotUpload({ ...upload, chunks: [text], bytes: utf8Bytes(text), checksum: checksumOfText(text) }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })

  it('caps chunk count independently of declared bytes', () => {
    expect(
      validateSnapshotUpload({ ...upload, chunks: [...upload.chunks, ...Array(MAX_SNAPSHOT_CHUNKS).fill('')] }),
    ).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  it('measures total bytes even when a caller lies about its size', () => {
    const chunks = chunkText('x'.repeat(MAX_SNAPSHOT_BYTES + 1), SNAPSHOT_CHUNK_BYTES)
    expect(validateSnapshotUpload({ ...upload, chunks, bytes: 1 })).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })
  })
})
