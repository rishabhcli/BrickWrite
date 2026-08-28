/**
 * Canonical serialization and content checksums.
 *
 * Shared by the browser and the Convex functions so that "the bytes I sent" and
 * "the bytes you stored" are comparable at all. `JSON.stringify` orders keys by
 * insertion, so two structurally identical documents built by different code
 * paths serialize differently; canonicalising the key order first is what makes
 * a checksum mean something.
 *
 * The digest is a 128-bit FNV-1a variant, not a cryptographic MAC. It exists to
 * catch truncation, chunk reassembly mistakes and storage corruption. It is not
 * a signature and nothing may treat it as authentication.
 */

/** Deterministic JSON: object keys sorted, `undefined` dropped, arrays kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    // Dropped rather than encoded as null: an absent optional field and a field
    // explicitly set to null are different documents, and only one of them
    // survives a JSON round trip.
    if (entry === undefined) continue
    result[key] = canonicalize(entry)
  }
  return result
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff
    hash = Math.imul(hash, FNV_PRIME) >>> 0
    // Mix the high byte of the code unit too, so a document that differs only
    // in non-ASCII characters is not silently identical.
    hash ^= (text.charCodeAt(index) >>> 8) & 0xff
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

const hex8 = (value: number) => value.toString(16).padStart(8, '0')

/** 32 hex characters over the canonical form of `value`. */
export function checksumOf(value: unknown): string {
  const text = canonicalJson(value)
  return checksumOfText(text)
}

/** 32 hex characters over an already-serialized string. */
export function checksumOfText(text: string): string {
  // Four independently seeded lanes, plus the length, so that neither a
  // truncation nor a transposition survives as an equal digest.
  const a = fnv1a(text, FNV_OFFSET)
  const b = fnv1a(text, a ^ 0x9e3779b9)
  const c = fnv1a(text, b ^ 0x85ebca6b)
  const d = fnv1a(`${text.length}:${text}`, c ^ 0xc2b2ae35)
  return `${hex8(a)}${hex8(b)}${hex8(c)}${hex8(d)}`
}

/** Byte length of a UTF-8 encoding, without allocating the encoded buffer. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) as number
    if (code > 0xffff) {
      bytes += 4
      index += 1
    } else if (code > 0x7ff) bytes += 3
    else if (code > 0x7f) bytes += 2
    else bytes += 1
  }
  return bytes
}

/**
 * Splits a serialized document into storage chunks.
 *
 * Chunk boundaries respect surrogate pairs: splitting an emoji in half would
 * produce two chunks that reassemble into different text than went in, and the
 * checksum would then report corruption that the writer caused.
 */
export function chunkText(text: string, chunkSize: number): string[] {
  if (chunkSize <= 0) throw new Error('A chunk size must be positive.')
  const chunks: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + chunkSize, text.length)
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    chunks.push(text.slice(cursor, end))
    cursor = end
  }
  // An empty input still has to produce one chunk, or `chunkCount` is zero and
  // a reader cannot tell "empty" from "nothing was written".
  return chunks.length > 0 ? chunks : ['']
}
