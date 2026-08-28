import { catalog } from '../../cad/catalog'
import { verifyAsset } from '../../cad/integrity'

/**
 * Lazily fetches individually content-addressed geometry, and refuses to
 * pretend when it cannot.
 *
 * The compiled pack carries 900 meshes out of 22,941 modelled identities. The
 * rest are parts LDraw genuinely models but this build ships no mesh for, and
 * the single most damaging thing this module could do is paper over that with a
 * generated box: a builder would place it, export it, and discover much later
 * that the model contains a part shaped like nothing LEGO ever made. So there
 * is no procedural fallback anywhere in this file. An asset that is missing,
 * unpublished, corrupt, unreachable or cancelled produces
 * `{ status: 'unavailable', reason }` and the caller decides what to show.
 *
 * Everything else here exists to make the *available* case trustworthy: bytes
 * are checked against their declared length and SHA-256 before anybody is
 * allowed to decode them, a poisoned HTTP cache is recovered from rather than
 * retried into, and going offline degrades to whatever is genuinely resident
 * instead of to a spinner that never resolves.
 */

export interface GeometryDescriptor {
  /** "sha256:<64 hex>" over the asset's own bytes. */
  hash: string
  bytes: number
  /** Path relative to the asset root, e.g. "assets/geometry/<hash>.bwmesh". */
  file: string
}

export type GeometryUnavailableCause =
  | 'unpublished'
  | 'offline'
  | 'network'
  | 'corrupt'
  | 'aborted'

export type GeometryAssetResult =
  | {
      status: 'ready'
      canonicalId: string
      hash: string
      /** Verified bytes. Decoding is the renderer's job; this module never interprets them. */
      bytes: ArrayBuffer
      fromCache: boolean
    }
  | {
      status: 'unavailable'
      canonicalId: string
      reason: string
      cause: GeometryUnavailableCause
    }

/** Resolves an identity to the asset that holds its mesh, or null when none is published. */
export type GeometryDescriptorSource = (
  canonicalId: string,
) => GeometryDescriptor | null | Promise<GeometryDescriptor | null>

export interface GeometryAssetProviderOptions {
  /** Root the assets are served from; matches `loadCompiledCatalog`. */
  baseUrl?: string
  /** Resident byte budget. Twelve megabytes is roughly 300 average part meshes. */
  cacheBytes?: number
  /** Total attempts per asset, including the first. */
  maxAttempts?: number
  /** First backoff delay; each further attempt doubles it. */
  retryDelayMs?: number
  descriptors?: GeometryDescriptorSource
  fetchImpl?: typeof fetch
  /** Overridable so tests can simulate a dropped connection deterministically. */
  isOnline?: () => boolean
  /** Overridable so the retry test does not have to spend real seconds asleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const DEFAULT_CACHE_BYTES = 12 * 1024 * 1024
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 150

/**
 * The descriptor source this build actually has.
 *
 * The compiled catalog records a geometry asset only for pack parts, so this
 * returns null for the other 22,041 identities. That null is the honest answer:
 * no index of out-of-pack geometry is published, and inventing a URL for one
 * would turn a known limitation into a 404 storm.
 */
export const catalogGeometryDescriptors: GeometryDescriptorSource = (canonicalId) => {
  const asset = catalog.get(canonicalId)?.geometryAsset
  return asset ? { hash: asset.hash, bytes: asset.bytes, file: asset.file } : null
}

class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortedError'
  }
}

const isAbortError = (cause: unknown) =>
  cause instanceof AbortedError ||
  (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'AbortedError'))

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface CacheEntry {
  bytes: ArrayBuffer
  hash: string
}

/**
 * A network request shared by every caller waiting on the same asset.
 *
 * Reference counted rather than fire-and-forget: two panels asking for the same
 * mesh must not open two sockets, but one panel unmounting must still cancel
 * the transfer when it was the only thing waiting on it.
 */
interface InFlight {
  controller: AbortController
  waiters: number
  promise: Promise<GeometryAssetResult>
}

export class GeometryAssetProvider {
  private readonly baseUrl: string
  private readonly cacheBytes: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly descriptors: GeometryDescriptorSource
  private readonly fetchImpl: typeof fetch
  private readonly isOnline: () => boolean
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  /** Insertion order is the LRU order; a hit re-inserts to move to the back. */
  private readonly cache = new Map<string, CacheEntry>()
  private residentBytes = 0
  private readonly inFlight = new Map<string, InFlight>()
  /** Descriptors supplied by a caller that has an out-of-pack index this build lacks. */
  private readonly registered = new Map<string, GeometryDescriptor>()

  constructor(options: GeometryAssetProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
    this.cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.descriptors = options.descriptors ?? catalogGeometryDescriptors
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine !== false)
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * Supplies a descriptor for an identity outside the compiled pack.
   *
   * This build publishes no out-of-pack geometry index, so the only way such an
   * asset can be fetched is for the holder of that index to say where it is and
   * what it should hash to. The provider still verifies both.
   */
  register(canonicalId: string, descriptor: GeometryDescriptor): void {
    this.registered.set(canonicalId, descriptor)
  }

  get residentCount(): number {
    return this.cache.size
  }

  get residentByteCount(): number {
    return this.residentBytes
  }

  /** True when the asset is resident and can be served without a network. */
  hasResident(hash: string): boolean {
    return this.cache.has(hash)
  }

  clear(): void {
    this.cache.clear()
    this.residentBytes = 0
  }

  async fetchGeometry(canonicalId: string, signal?: AbortSignal): Promise<GeometryAssetResult> {
    if (signal?.aborted) return aborted(canonicalId)

    let descriptor: GeometryDescriptor | null = this.registered.get(canonicalId) ?? null
    if (!descriptor) {
      try {
        descriptor = await this.descriptors(canonicalId)
      } catch (cause) {
        return {
          status: 'unavailable',
          canonicalId,
          cause: 'network',
          reason: `The geometry index could not be consulted for ${canonicalId}: ${message(cause)}.`,
        }
      }
    }
    if (!descriptor) {
      return {
        status: 'unavailable',
        canonicalId,
        cause: 'unpublished',
        reason:
          `This build publishes no compiled mesh for ${canonicalId}. ` +
          'LDraw may model the part, but nothing can be placed from it here.',
      }
    }

    const cached = this.cache.get(descriptor.hash)
    if (cached) {
      // Re-insert so the most recently used entry is the last to be evicted.
      this.cache.delete(descriptor.hash)
      this.cache.set(descriptor.hash, cached)
      return { status: 'ready', canonicalId, hash: cached.hash, bytes: cached.bytes, fromCache: true }
    }

    if (!this.isOnline()) {
      return {
        status: 'unavailable',
        canonicalId,
        cause: 'offline',
        reason: `${canonicalId} is not resident and this device is offline.`,
      }
    }

    return this.share(canonicalId, descriptor, signal)
  }

  private share(canonicalId: string, descriptor: GeometryDescriptor, signal?: AbortSignal): Promise<GeometryAssetResult> {
    let entry = this.inFlight.get(descriptor.hash)
    if (!entry) {
      const controller = new AbortController()
      const created: InFlight = {
        controller,
        waiters: 0,
        promise: this.load(canonicalId, descriptor, controller.signal).finally(() => {
          this.inFlight.delete(descriptor.hash)
        }),
      }
      this.inFlight.set(descriptor.hash, created)
      entry = created
    }
    entry.waiters += 1

    if (!signal) return entry.promise.finally(() => release(entry))

    return new Promise<GeometryAssetResult>((resolve) => {
      const onAbort = () => {
        release(entry)
        // The shared transfer is only cancelled once nothing is still waiting
        // on it; another caller's abort must not truncate this caller's load.
        if (entry.waiters === 0) entry.controller.abort()
        resolve(aborted(canonicalId))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.promise.then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          release(entry)
          resolve(signal.aborted ? aborted(canonicalId) : withIdentity(result, canonicalId))
        },
        (cause: unknown) => {
          signal.removeEventListener('abort', onAbort)
          release(entry)
          resolve(
            isAbortError(cause)
              ? aborted(canonicalId)
              : {
                  status: 'unavailable',
                  canonicalId,
                  cause: 'network',
                  reason: `${canonicalId} geometry could not be fetched: ${message(cause)}.`,
                },
          )
        },
      )
    })
  }

  /**
   * One asset, with retry, integrity verification and corruption recovery.
   *
   * The second attempt after a digest mismatch deliberately bypasses the HTTP
   * cache. A content-addressed URL that returns the wrong bytes is almost
   * always a poisoned intermediary rather than a corrupt origin, and retrying
   * through the same cache would return the same wrong bytes forever.
   */
  private async load(
    canonicalId: string,
    descriptor: GeometryDescriptor,
    signal: AbortSignal,
  ): Promise<GeometryAssetResult> {
    const url = `${this.baseUrl}/${descriptor.file.replace(/^\/+/, '')}`
    let corrupted = false
    let lastReason = 'no attempt was made'
    let lastCause: GeometryUnavailableCause = 'network'

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (signal.aborted) return aborted(canonicalId)
      if (attempt > 0) {
        if (!this.isOnline()) {
          return {
            status: 'unavailable',
            canonicalId,
            cause: 'offline',
            reason: `${canonicalId} geometry could not be fetched and this device went offline.`,
          }
        }
        try {
          // Exponential backoff: a struggling origin is not helped by a retry
          // storm, and the delay is where an abort most usefully lands.
          await this.sleep(this.retryDelayMs * 2 ** (attempt - 1), signal)
        } catch (cause) {
          if (isAbortError(cause)) return aborted(canonicalId)
          throw cause
        }
      }

      try {
        const response = await this.fetchImpl(url, {
          signal,
          cache: corrupted ? 'reload' : 'force-cache',
        })
        if (!response.ok) {
          lastReason = `${response.status} ${response.statusText}`
          // A 404 will not become a 200 by asking again; the asset is simply
          // not published at that address.
          if (response.status === 404 || response.status === 410) {
            return {
              status: 'unavailable',
              canonicalId,
              cause: 'unpublished',
              reason: `${canonicalId} geometry is not published at ${descriptor.file} (${lastReason}).`,
            }
          }
          continue
        }

        const bytes = await response.arrayBuffer()
        try {
          await verifyAsset(bytes, descriptor, `Geometry ${canonicalId}`)
        } catch (cause) {
          // Truncated or tampered bytes are never cached and never decoded.
          corrupted = true
          lastCause = 'corrupt'
          lastReason = message(cause)
          this.evict(descriptor.hash)
          continue
        }

        this.store(descriptor.hash, bytes)
        return { status: 'ready', canonicalId, hash: descriptor.hash, bytes, fromCache: false }
      } catch (cause) {
        if (isAbortError(cause)) return aborted(canonicalId)
        lastCause = 'network'
        lastReason = message(cause)
      }
    }

    return {
      status: 'unavailable',
      canonicalId,
      cause: lastCause,
      reason:
        lastCause === 'corrupt'
          ? `${canonicalId} geometry failed integrity verification after ${this.maxAttempts} attempts: ${lastReason}.`
          : `${canonicalId} geometry could not be fetched after ${this.maxAttempts} attempts: ${lastReason}.`,
    }
  }

  private store(hash: string, bytes: ArrayBuffer): void {
    if (bytes.byteLength > this.cacheBytes) {
      // A single asset larger than the whole budget would evict everything and
      // then be evicted itself, so it is served without being retained.
      return
    }
    this.cache.set(hash, { bytes, hash })
    this.residentBytes += bytes.byteLength
    for (const [key, entry] of this.cache) {
      if (this.residentBytes <= this.cacheBytes) break
      if (key === hash) continue
      this.cache.delete(key)
      this.residentBytes -= entry.bytes.byteLength
    }
  }

  private evict(hash: string): void {
    const entry = this.cache.get(hash)
    if (!entry) return
    this.cache.delete(hash)
    this.residentBytes -= entry.bytes.byteLength
  }
}

function release(entry: InFlight): void {
  entry.waiters = Math.max(0, entry.waiters - 1)
}

function withIdentity(result: GeometryAssetResult, canonicalId: string): GeometryAssetResult {
  return result.canonicalId === canonicalId ? result : { ...result, canonicalId }
}

function aborted(canonicalId: string): GeometryAssetResult {
  return {
    status: 'unavailable',
    canonicalId,
    cause: 'aborted',
    reason: `The request for ${canonicalId} geometry was cancelled.`,
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
