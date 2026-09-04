import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_BASIS } from './math'
import type { ModelDocument } from './types'

const cloud = vi.hoisted(() => ({
  configuration: { status: 'ready' as const, reason: null, url: 'https://example.convex.cloud' },
  identity: { status: 'signed-in' as const, reason: null, userId: 'user_1', label: 'Rishabh' },
  linked: null as Record<string, unknown> | null,
  claim: vi.fn(async () => ({ ok: true as const, value: { projectId: 'prj_1' } })),
  notifyLinksChanged: vi.fn(),
}))

vi.mock('../cloud/browserRuntime', () => ({
  browserCloudRuntime: () => ({
    getSnapshot: () => ({
      configuration: cloud.configuration,
      identity: cloud.identity,
      store: { claim: cloud.claim },
      links: { get: async () => cloud.linked },
    }),
    notifyLinksChanged: cloud.notifyLinksChanged,
  }),
}))

const { autoClaimIfEligible, MIN_CLOUD_SAVED_PARTS } = await import('./autoclaim')

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
  return { schemaVersion: 2, id: `doc_${nextId}`, name: 'Test build', revision: 1, parts } as unknown as ModelDocument
}

beforeEach(() => {
  cloud.configuration = { status: 'ready', reason: null, url: 'https://example.convex.cloud' }
  cloud.identity = { status: 'signed-in', reason: null, userId: 'user_1', label: 'Rishabh' }
  cloud.linked = null
  cloud.claim.mockClear()
  cloud.claim.mockImplementation(async () => ({ ok: true as const, value: { projectId: 'prj_1' } }))
  cloud.notifyLinksChanged.mockClear()
})

describe('auto-claiming a build into the cloud at 25 parts', () => {
  it('does not claim a build below the minimum', async () => {
    await autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS - 1))
    expect(cloud.claim).not.toHaveBeenCalled()
  })

  it('claims the moment a build reaches the minimum, for a signed-in account', async () => {
    const document = makeDocument(MIN_CLOUD_SAVED_PARTS)
    await autoClaimIfEligible(document)
    expect(cloud.claim).toHaveBeenCalledWith(document.id)
    expect(cloud.notifyLinksChanged).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a signed-out operator — there is no other browser to sync to', async () => {
    cloud.identity = { status: 'signed-out', reason: 'not signed in' }
    await autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS))
    expect(cloud.claim).not.toHaveBeenCalled()
  })

  it('does nothing for an anonymous or restricted guest session', async () => {
    cloud.identity = { status: 'restricted', reason: 'anonymous', userId: 'guest_1', label: 'Guest' }
    await autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS))
    expect(cloud.claim).not.toHaveBeenCalled()
  })

  it('does nothing when no cloud deployment is configured', async () => {
    cloud.configuration = { status: 'unconfigured', reason: 'no VITE_CONVEX_URL', url: null }
    await autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS))
    expect(cloud.claim).not.toHaveBeenCalled()
  })

  it('does not attempt a second claim once the project already has a cloud link', async () => {
    cloud.linked = { localProjectId: 'doc_x', cloudProjectId: 'prj_1', branchId: 'branch_1' }
    await autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS))
    expect(cloud.claim).not.toHaveBeenCalled()
  })

  it('does not throw and does not notify when the claim itself fails', async () => {
    cloud.claim.mockImplementation(async () => ({
      ok: false as const,
      error: { code: 'OFFLINE', message: 'offline', repair: 'retry' },
    }))
    await expect(autoClaimIfEligible(makeDocument(MIN_CLOUD_SAVED_PARTS))).resolves.toBeUndefined()
    expect(cloud.notifyLinksChanged).not.toHaveBeenCalled()
  })

  it('does not fire two concurrent claims for the same project', async () => {
    let resolveClaim!: (value: { ok: true; value: { projectId: string } }) => void
    cloud.claim.mockImplementation(() => new Promise((resolve) => (resolveClaim = resolve)))
    const document = makeDocument(MIN_CLOUD_SAVED_PARTS)

    const first = autoClaimIfEligible(document)
    const second = autoClaimIfEligible({ ...document, revision: 2 })

    while (cloud.claim.mock.calls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    resolveClaim({ ok: true, value: { projectId: 'prj_1' } })
    await Promise.all([first, second])

    expect(cloud.claim).toHaveBeenCalledTimes(1)
  })
})
