/**
 * Canonical bytes and content hashing.
 *
 * A publication's immutability claim is only as good as its serialisation. If
 * `JSON.stringify` is allowed to emit keys in insertion order, the same
 * revision hashes differently depending on how the document happened to be
 * built, and "the bytes did not change" stops being checkable.
 *
 * So: keys sorted, `undefined` dropped, numbers emitted through a fixed
 * normaliser, and the result encoded as UTF-8 exactly once. Everything that
 * needs an identity — the content hash, the card cache key, the ETag — comes
 * from these bytes.
 */

/**
 * Numbers with a single textual form.
 *
 * `JSON.stringify` already produces the shortest round-tripping decimal for a
 * double, which is deterministic across engines. The two cases it gets wrong
 * for our purposes are `-0`, which must not differ from `0`, and non-finite
 * values, which must be rejected rather than silently become `null` — a NaN in
 * a transform is a corrupt document, not a publishable one.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot canonicalise the non-finite number ${String(value)}.`)
  return Object.is(value, -0) ? '0' : JSON.stringify(value)
}

/** Deterministic JSON text: sorted keys, no `undefined`, normalised numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'number') return canonicalNumber(value as number)
  if (kind === 'string') return JSON.stringify(value)
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'undefined') return 'null'
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new Error(`Cannot canonicalise a ${kind}.`)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (ArrayBuffer.isView(value)) {
    // Typed arrays reach here from transforms and index buffers. Emitting them
    // as plain arrays keeps the canonical form independent of the container.
    return `[${Array.from(value as unknown as ArrayLike<number>, canonicalNumber).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

const encoder = new TextEncoder()

/** UTF-8 bytes of the canonical form. This is what gets hashed and stored. */
export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value))
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) out += HEX[bytes[index]]
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('Not a hex string.')
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * The one crypto surface.
 *
 * WebCrypto is present in browsers, in Node 24 and in the Cloudflare Workers
 * runtime, so the same code hashes a publication in all three. There is no
 * JavaScript SHA-256 fallback on purpose: a hand-rolled digest in the security
 * path is a liability, and an environment without WebCrypto should fail loudly.
 */
function subtle(): SubtleCrypto {
  const available = globalThis.crypto?.subtle
  if (!available) {
    throw new Error(
      'WebCrypto is unavailable in this runtime, so publication hashes and share tokens cannot be computed.',
    )
  }
  return available
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // `slice()` hands `digest` a standalone ArrayBuffer; a typed-array view over
  // a larger pooled buffer would otherwise hash the wrong range in Node.
  const digest = await subtle().digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return new Uint8Array(digest)
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  return toHex(await sha256(typeof input === 'string' ? encoder.encode(input) : input))
}

/** SHA-256 over the canonical form of a value. */
export async function contentHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalBytes(value))
}

/**
 * Cryptographically strong random bytes.
 *
 * `Math.random` is never acceptable here — an unlisted link is only unguessable
 * because these bytes are.
 */
export function randomBytes(length: number): Uint8Array {
  const source = globalThis.crypto
  if (!source?.getRandomValues) {
    throw new Error('No cryptographic random source is available, so share tokens cannot be minted.')
  }
  return source.getRandomValues(new Uint8Array(length))
}

const BASE32 = 'abcdefghijkmnpqrstuvwxyz23456789'

/**
 * Lowercase base32 without the characters people mistype.
 *
 * `l`, `o`, `0` and `1` are omitted so a slug read aloud or copied off a screen
 * survives. Five bits per character, so the entropy is exactly
 * `5 * length` bits.
 */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(buffer >> bits) & 31]
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

/** URL-safe base64 without padding, for token secrets. */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const standard =
    typeof btoa === 'function'
      ? btoa(binary)
      : // Node before a global `btoa` would land here; Buffer is the only other
        // encoder guaranteed present in the runtimes this ships to.
        (globalThis as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } })
          .Buffer!.from(binary, 'binary')
          .toString('base64')
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Constant-time byte comparison.
 *
 * Returns after examining every byte of the longer input, so neither the
 * position of the first difference nor the length of the presented value is
 * observable through timing. Length inequality is folded into the accumulator
 * rather than short-circuiting, which is the mistake that makes most
 * hand-written comparisons leak.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

/** Constant-time comparison of two lowercase hex digests. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b))
}
