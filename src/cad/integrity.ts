/** Metadata emitted beside every immutable catalog asset. */
export interface IntegrityDescriptor {
  readonly hash: string
  readonly bytes: number
}

export class AssetIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetIntegrityError'
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** SHA-256 using the browser's secure-context Web Crypto implementation. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new AssetIntegrityError('Web Crypto is unavailable; immutable catalog assets cannot be verified.')
  }
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer)))
}

/**
 * Verifies both the declared byte count and digest before a fetched asset is
 * parsed. Content-addressed filenames prevent stale caches only if the bytes
 * behind the filename are actually checked.
 */
export async function verifyAsset(
  buffer: ArrayBuffer,
  descriptor: IntegrityDescriptor,
  label = 'Catalog asset',
): Promise<void> {
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0) {
    throw new AssetIntegrityError(`${label} declares an invalid byte count.`)
  }
  if (buffer.byteLength !== descriptor.bytes) {
    throw new AssetIntegrityError(`${label} length mismatch: expected ${descriptor.bytes} bytes, received ${buffer.byteLength}.`)
  }

  const expected = descriptor.hash.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase()
  if (!expected) throw new AssetIntegrityError(`${label} declares an invalid SHA-256 digest.`)
  const actual = await sha256Hex(buffer)
  if (actual !== expected) {
    throw new AssetIntegrityError(`${label} failed SHA-256 verification.`)
  }
}

