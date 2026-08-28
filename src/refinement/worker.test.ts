import { describe, expect, it, vi } from 'vitest'
import {
  handleRefinementWorkerMessage,
  inWorkerScope,
  refinementWorkerAvailable,
  runRefinementJob,
  type RefinementWorkerResponse,
} from './worker'
import { refinementFixture } from './__fixtures__'

/**
 * The protocol, driven directly.
 *
 * `handleRefinementWorkerMessage` is the worker's entire body, so exercising it
 * with a collecting `post` is exercising the worker — including cancellation,
 * which a spawned worker would make hard to observe deterministically.
 */

const searchMessage = (jobId: string, fixtureId = 'seam-wall') => {
  const fixture = refinementFixture(fixtureId)
  return {
    kind: 'search' as const,
    jobId,
    document: fixture.document,
    catalogBaseUrl: null,
    request: {
      version: 1 as const,
      id: `req_${fixtureId}`,
      scopePartIds: fixture.scopePartIds,
      baseRevision: fixture.document.revision,
      instruction: fixture.instruction,
      seed: 1,
      budget: { maxIterations: 120, wallClockMs: 8_000 },
    },
  }
}

describe('worker protocol', () => {
  it('answers a search with ranked proposals and a report', { timeout: 60_000 }, async () => {
    const posted: RefinementWorkerResponse[] = []
    await handleRefinementWorkerMessage(searchMessage('job-1'), (response) => posted.push(response))

    expect(posted).toHaveLength(1)
    const [response] = posted
    expect(response.kind).toBe('result')
    if (response.kind !== 'result') return
    expect(response.jobId).toBe('job-1')
    expect(response.proposals.some((proposal) => proposal.status === 'ranked')).toBe(true)
    expect(response.report.evaluated).toBeGreaterThan(0)
    // Everything that crosses the boundary has to survive structured cloning.
    expect(() => structuredClone(response)).not.toThrow()
  })

  it('cancels a job in flight rather than delivering its result', { timeout: 60_000 }, async () => {
    const posted: RefinementWorkerResponse[] = []
    const post = (response: RefinementWorkerResponse) => posted.push(response)
    const running = handleRefinementWorkerMessage(searchMessage('job-2', 'roof-steps'), post)
    // Same tick: the handler yields once before starting precisely so this lands.
    await handleRefinementWorkerMessage({ kind: 'cancel', jobId: 'job-2' }, post)
    await running

    expect(posted.map((response) => response.kind)).toEqual(['cancelled', 'cancelled'])
    expect(posted.every((response) => response.jobId === 'job-2')).toBe(true)
  })

  it('acknowledges a cancel for a job it has never seen', async () => {
    const posted: RefinementWorkerResponse[] = []
    await handleRefinementWorkerMessage({ kind: 'cancel', jobId: 'ghost' }, (response) => posted.push(response))
    expect(posted).toEqual([{ kind: 'cancelled', jobId: 'ghost' }])
  })

  it('reports a malformed request as an error, not as an empty result', async () => {
    const fixture = refinementFixture('seam-wall')
    const posted: RefinementWorkerResponse[] = []
    await handleRefinementWorkerMessage(
      {
        kind: 'search',
        jobId: 'job-3',
        document: fixture.document,
        catalogBaseUrl: null,
        request: { version: 1, id: '', scopePartIds: [], baseRevision: -3 } as never,
      },
      (response) => posted.push(response),
    )
    expect(posted).toHaveLength(1)
    expect(posted[0].kind).toBe('error')
    if (posted[0].kind === 'error') expect(posted[0].message).toMatch(/not valid/)
  })
})

describe('worker client', () => {
  it('knows this environment has no worker and says which path it took', { timeout: 60_000 }, async () => {
    // jsdom implements no `Worker`, which is exactly the case the synchronous
    // fallback exists for.
    expect(refinementWorkerAvailable()).toBe(false)
    expect(inWorkerScope()).toBe(false)

    const fixture = refinementFixture('seam-wall')
    const result = await runRefinementJob(
      {
        version: 1,
        id: 'req_inline',
        scopePartIds: fixture.scopePartIds,
        baseRevision: fixture.document.revision,
        instruction: fixture.instruction,
        seed: 1,
        budget: { maxIterations: 120, wallClockMs: 8_000 },
      },
      fixture.document,
    )
    expect(result.ranOn).toBe('inline')
    expect(result.proposals.some((proposal) => proposal.status === 'ranked')).toBe(true)
  })

  it('honours an abort signal on the inline path', { timeout: 60_000 }, async () => {
    const fixture = refinementFixture('roof-steps')
    const controller = new AbortController()
    controller.abort()
    const result = await runRefinementJob(
      {
        version: 1,
        id: 'req_abort',
        scopePartIds: fixture.scopePartIds,
        baseRevision: fixture.document.revision,
        instruction: fixture.instruction,
        seed: 1,
      },
      fixture.document,
      { signal: controller.signal, forceInline: true },
    )
    expect(result.report.aborted).toBe(true)
    expect(result.proposals.filter((proposal) => proposal.status === 'ranked')).toHaveLength(0)
  })

  it('terminates a worker immediately when the caller has already cancelled', async () => {
    let terminated = 0
    let posted = 0
    class FakeWorker {
      addEventListener() {}
      postMessage() { posted += 1 }
      terminate() { terminated += 1 }
    }
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const fixture = refinementFixture('roof-steps')
      const controller = new AbortController()
      controller.abort()
      await expect(
        runRefinementJob(
          {
            version: 1,
            id: 'req_worker_abort',
            scopePartIds: fixture.scopePartIds,
            baseRevision: fixture.document.revision,
            instruction: fixture.instruction,
            seed: 1,
          },
          fixture.document,
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(terminated).toBe(1)
      expect(posted).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
