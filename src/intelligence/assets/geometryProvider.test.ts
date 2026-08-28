import { describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../../cad/integrity'
import { GeometryAssetProvider, type GeometryDescriptor } from './geometryProvider'

/**
 * The provider's contract is mostly about what it refuses to do.
 *
 * Every failure path below has to end in `unavailable`. Nothing here may ever
 * hand back bytes that did not verify, and nothing may substitute a generated
 * shape for a mesh this build does not have - a model containing a part that
 * was never a real LEGO element is worse than a model with a hole in it,
 * because the hole is visible.
 */

const payload = (fill: number, length = 256) => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) bytes[i] = (fill + i) & 0xff
  return bytes
}

async function descriptorFor(bytes: Uint8Array): Promise<GeometryDescriptor> {
  const copy = new Uint8Array(bytes)
  return {
    hash: `sha256:${await sha256Hex(copy.buffer)}`,
    bytes: bytes.byteLength,
    file: `assets/geometry/${await sha256Hex(copy.buffer)}.bwmesh`,
  }
}

const ok = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200 })

/** No real delay: backoff is asserted by the call count, not by the clock. */
const instantSleep = () => Promise.resolve()

describe('geometry asset provider', () => {
  it('serves bytes that verify, and caches them', async () => {
    const bytes = payload(1)
    const descriptor = await descriptorFor(bytes)
    const fetchImpl = vi.fn(async () => ok(bytes))
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    })

    const first = await provider.fetchGeometry('3001')
    expect(first.status).toBe('ready')
    if (first.status !== 'ready') return
    expect(first.fromCache).toBe(false)
    expect(new Uint8Array(first.bytes)).toEqual(bytes)

    const second = await provider.fetchGeometry('3001')
    expect(second.status === 'ready' && second.fromCache).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects bytes whose digest does not match, and never caches them', async () => {
    const descriptor = await descriptorFor(payload(1))
    const tampered = payload(9)
    const fetchImpl = vi.fn(async () => ok(tampered))
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxAttempts: 2,
    })

    const result = await provider.fetchGeometry('3001')
    expect(result.status).toBe('unavailable')
    expect(result.status === 'unavailable' && result.cause).toBe('corrupt')
    expect(result.status === 'unavailable' && result.reason).toContain('integrity')
    expect(provider.residentCount).toBe(0)
    // The retry bypasses the HTTP cache, because a content-addressed URL that
    // serves the wrong bytes is usually a poisoned intermediary.
    const retry = fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>
    expect(retry[1]?.[1]).toMatchObject({ cache: 'reload' })
  })

  it('rejects a truncated payload on its declared length', async () => {
    const bytes = payload(2)
    const descriptor = await descriptorFor(bytes)
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      fetchImpl: (async () => ok(bytes.slice(0, 100))) as unknown as typeof fetch,
      sleep: instantSleep,
      maxAttempts: 1,
    })

    const result = await provider.fetchGeometry('3001')
    expect(result.status).toBe('unavailable')
    expect(result.status === 'unavailable' && result.reason).toContain('length mismatch')
  })

  it('cancels a transfer in flight and reports the cancellation', async () => {
    const bytes = payload(3)
    const descriptor = await descriptorFor(bytes)
    const controller = new AbortController()
    let sawAbort = false

    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      sleep: instantSleep,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            sawAbort = true
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })) as unknown as typeof fetch,
    })

    const pending = provider.fetchGeometry('3001', controller.signal)
    // Let the descriptor lookup and the request start before cancelling, so the
    // abort really is mid-flight rather than before the socket opened.
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await pending
    expect(result.status).toBe('unavailable')
    expect(result.status === 'unavailable' && result.cause).toBe('aborted')
    // The abort has to reach the socket, not merely the caller's promise.
    expect(sawAbort).toBe(true)
  })

  it('serves a resident asset while offline, and refuses a cold one', async () => {
    const resident = payload(4)
    const cold = payload(5, 128)
    const residentDescriptor = await descriptorFor(resident)
    const coldDescriptor = await descriptorFor(cold)
    let online = true
    const provider = new GeometryAssetProvider({
      descriptors: (id) => (id === 'resident' ? residentDescriptor : coldDescriptor),
      fetchImpl: (async (url: string) =>
        ok(url.includes(residentDescriptor.hash.slice(7)) ? resident : cold)) as unknown as typeof fetch,
      isOnline: () => online,
      sleep: instantSleep,
    })

    expect((await provider.fetchGeometry('resident')).status).toBe('ready')
    online = false

    const hit = await provider.fetchGeometry('resident')
    expect(hit.status === 'ready' && hit.fromCache).toBe(true)

    const miss = await provider.fetchGeometry('cold')
    expect(miss.status).toBe('unavailable')
    expect(miss.status === 'unavailable' && miss.cause).toBe('offline')
  })

  it('evicts the least recently used asset once the budget is spent', async () => {
    const assets = await Promise.all([payload(10), payload(20), payload(30)].map(async (bytes) => ({
      bytes,
      descriptor: await descriptorFor(bytes),
    })))
    const byId = new Map(assets.map((asset, index) => [`part-${index}`, asset]))
    const provider = new GeometryAssetProvider({
      // Room for two 256-byte assets, so admitting a third must evict one.
      cacheBytes: 600,
      descriptors: (id) => byId.get(id)!.descriptor,
      fetchImpl: (async (url: string) =>
        ok(assets.find((asset) => url.includes(asset.descriptor.hash.slice(7)))!.bytes)) as unknown as typeof fetch,
      sleep: instantSleep,
    })

    await provider.fetchGeometry('part-0')
    await provider.fetchGeometry('part-1')
    // Touching part-0 makes part-1 the least recently used.
    await provider.fetchGeometry('part-0')
    await provider.fetchGeometry('part-2')

    expect(provider.residentCount).toBe(2)
    expect(provider.hasResident(assets[0].descriptor.hash)).toBe(true)
    expect(provider.hasResident(assets[1].descriptor.hash)).toBe(false)
    expect(provider.hasResident(assets[2].descriptor.hash)).toBe(true)
    expect(provider.residentByteCount).toBeLessThanOrEqual(600)
  })

  it('retries a failing origin with backoff and succeeds', async () => {
    const bytes = payload(6)
    const descriptor = await descriptorFor(bytes)
    const delays: number[] = []
    let attempts = 0
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      retryDelayMs: 40,
      maxAttempts: 4,
      sleep: async (ms) => {
        delays.push(ms)
      },
      fetchImpl: (async () => {
        attempts += 1
        if (attempts === 1) throw new TypeError('Failed to fetch')
        if (attempts === 2) return new Response(null, { status: 503, statusText: 'Service Unavailable' })
        return ok(bytes)
      }) as unknown as typeof fetch,
    })

    const result = await provider.fetchGeometry('3001')
    expect(result.status).toBe('ready')
    expect(attempts).toBe(3)
    // Exponential, not constant: a struggling origin is not helped by a storm.
    expect(delays).toEqual([40, 80])
  })

  it('says a part is unpublished rather than inventing geometry for it', async () => {
    const provider = new GeometryAssetProvider({
      descriptors: () => null,
      fetchImpl: (() => {
        throw new Error('the provider must not reach the network for an unpublished asset')
      }) as unknown as typeof fetch,
      sleep: instantSleep,
    })

    const result = await provider.fetchGeometry('41767')
    expect(result.status).toBe('unavailable')
    expect(result.status === 'unavailable' && result.cause).toBe('unpublished')
    expect(result).not.toHaveProperty('bytes')
  })

  it('gives up on a 404 without retrying, and yields no bytes', async () => {
    const descriptor = await descriptorFor(payload(7))
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404, statusText: 'Not Found' }))
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
      maxAttempts: 3,
    })

    const result = await provider.fetchGeometry('3001')
    expect(result.status).toBe('unavailable')
    expect(result.status === 'unavailable' && result.cause).toBe('unpublished')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('shares one transfer between concurrent callers', async () => {
    const bytes = payload(8)
    const descriptor = await descriptorFor(bytes)
    const fetchImpl = vi.fn(async () => ok(bytes))
    const provider = new GeometryAssetProvider({
      descriptors: () => descriptor,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: instantSleep,
    })

    const results = await Promise.all([
      provider.fetchGeometry('3001'),
      provider.fetchGeometry('3001'),
      provider.fetchGeometry('3001'),
    ])
    expect(results.every((result) => result.status === 'ready')).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('accepts a descriptor for an identity outside the compiled pack', async () => {
    const bytes = payload(11)
    const descriptor = await descriptorFor(bytes)
    const provider = new GeometryAssetProvider({
      descriptors: () => null,
      fetchImpl: (async () => ok(bytes)) as unknown as typeof fetch,
      sleep: instantSleep,
    })

    expect((await provider.fetchGeometry('41767')).status).toBe('unavailable')
    provider.register('41767', descriptor)
    const result = await provider.fetchGeometry('41767')
    expect(result.status).toBe('ready')
  })
})
