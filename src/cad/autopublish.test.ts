import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autoPublishIfEligible, autoPublishedSlug, MIN_PUBLISHABLE_PARTS } from './autopublish'
import { IDENTITY_BASIS } from './math'
import type { ModelDocument } from './types'

/**
 * Auto-publishing: the only place a build crosses from "local IndexedDB blob"
 * to "public gallery entry", for a signed-in operator and a signed-out one
 * alike. The Hexclave client app is mocked here the same way
 * `platform/auth/account.test.tsx` mocks it — this suite is about the publish
 * trigger's own logic (the threshold, the once-only guard, the in-flight
 * race), not about Hexclave or the real `/publications` endpoint.
 */

const hex = vi.hoisted(() => ({
  configured: true,
  authorization: 'Bearer test-token' as string | null,
  getUser: vi.fn(async () => ({ id: 'anon_1', isAnonymous: true })),
}))

vi.mock('../hexclave/client', () => ({
  getHexclaveClientApp: () =>
    hex.configured
      ? {
          status: 'ok' as const,
          data: {
            getUser: hex.getUser,
            getAuthorizationHeader: async () => hex.authorization,
          },
        }
      : { status: 'error' as const, error: new Error('Hexclave is not configured for this process.') },
}))

let nextId = 0

function makeDocument(partCount: number): ModelDocument {
  nextId += 1
  const parts: ModelDocument['parts'] = {}
  for (let index = 0; index < partCount; index += 1) {
    parts[`part_${index}`] = {
      id: `part_${index}`,
      definitionId: '3024',
      color: 72,
      transform: { position: [index, 0, 0], basis: IDENTITY_BASIS },
      subassemblyId: 'hull',
      stepId: 'step_1',
      provenance: 'human',
      protected: false,
    }
  }
  return {
    schemaVersion: 2,
    id: `doc_${nextId}`,
    name: 'Test build',
    revision: 1,
    catalogVersion: 'fixture-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    parts,
    connections: {},
    subassemblies: {},
    steps: [],
    notes: [],
    constraints: [],
  } as unknown as ModelDocument
}

beforeEach(() => {
  localStorage.clear()
  hex.configured = true
  hex.authorization = 'Bearer test-token'
  hex.getUser.mockClear()
})

describe('the 25-part threshold', () => {
  it('does not publish a build below the minimum', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS - 1)

    await autoPublishIfEligible(document, null)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(autoPublishedSlug(document.id)).toBeNull()
  })

  it('publishes the moment a build reaches the minimum', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ slug: 'test-build-abc123' }), { status: 201 })) as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    await autoPublishIfEligible(document, null)

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/publications')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(JSON.parse(init.body).publication.document.parts).toHaveLength(MIN_PUBLISHABLE_PARTS)
    expect(autoPublishedSlug(document.id)).toBe('test-build-abc123')
  })

  it('never publishes the same project twice', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ slug: 'once-only' }), { status: 201 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    await autoPublishIfEligible(document, null)
    await autoPublishIfEligible({ ...document, revision: document.revision + 1 }, null)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not mark a failed publish as done, so the next commit retries it', async () => {
    globalThis.fetch = vi.fn(async () => new Response('refused', { status: 500 })) as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    await autoPublishIfEligible(document, null)

    expect(autoPublishedSlug(document.id)).toBeNull()
  })

  it('leaves a build unpublished, without throwing, when there is no account layer to authorise it', async () => {
    hex.configured = false
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    await expect(autoPublishIfEligible(document, null)).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(autoPublishedSlug(document.id)).toBeNull()
  })

  it('silently gives a signed-out builder an anonymous session rather than blocking on one', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ slug: 'guest-build' }), { status: 201 })) as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    await autoPublishIfEligible(document, null)

    expect(hex.getUser).toHaveBeenCalledWith({ or: 'anonymous' })
    expect(autoPublishedSlug(document.id)).toBe('guest-build')
  })

  it('does not mint two gallery entries for a burst of commits crossing the threshold at once', async () => {
    let resolveResponse!: (value: Response) => void
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => (resolveResponse = resolve)))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const document = makeDocument(MIN_PUBLISHABLE_PARTS)

    const first = autoPublishIfEligible(document, null)
    const second = autoPublishIfEligible({ ...document, revision: 2 }, null)

    // Both calls do real async work (hashing the snapshot, etc.) before they
    // ever reach fetch, so the mock isn't installed as `resolveResponse` yet
    // the instant they're fired — wait until it actually is.
    while (fetchSpy.mock.calls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    resolveResponse(new Response(JSON.stringify({ slug: 'burst-build' }), { status: 201 }))
    await Promise.all([first, second])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(autoPublishedSlug(document.id)).toBe('burst-build')
  })
})
