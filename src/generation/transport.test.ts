import { describe, expect, it, vi } from 'vitest'
import { createGenerationProvider } from './provider'
import type { ModelRequest } from '../platform/contracts'

const request: ModelRequest<unknown> = {
  system: 'Build',
  prompt: 'A house',
  schema: { type: 'object' },
  parse: (raw) => raw,
}
const ndjson = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
const accepted = { type: 'accepted', requestId: 'gen_test' }
const result = { type: 'result', requestId: 'gen_test', value: { boxes: [] } }

describe('generation stream lifecycle', () => {
  it('accepts progress and heartbeats, then cancels at the result without waiting for EOF', async () => {
    const cancel = vi.fn()
    const onProgress = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('\n' + ndjson(accepted, { type: 'progress', stage: 'validating' }, result)))
      },
      cancel,
    })
    const provider = createGenerationProvider({ fetchImpl: async () => new Response(body), onProgress })
    expect((await provider.complete(request)).value).toEqual(result.value)
    expect(onProgress).toHaveBeenCalledExactlyOnceWith('validating')
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it.each([
    [accepted],
    [accepted, { type: 'result' }],
    [accepted, { ...result, requestId: 'another request' }],
    [accepted, accepted, result],
    [accepted, { type: 'progress', stage: 42 }, result],
    [accepted, { type: 'error', error: 42, detail: 'invalid' }],
    [accepted, { type: 'made-up' }, result],
  ])('rejects truncated or invalid events (%j)', async (...events) => {
    const provider = createGenerationProvider({ fetchImpl: async () => new Response(ndjson(...events)) })
    const parse = vi.fn()
    await expect(provider.complete({ ...request, parse })).rejects.toThrow()
    expect(parse).not.toHaveBeenCalled()
  })

  it('reports a terminal server timeout instead of parsing it as a result', async () => {
    const provider = createGenerationProvider({
      fetchImpl: async () =>
        new Response(ndjson(accepted, { type: 'error', error: 'timeout', detail: 'Request deadline exceeded.' })),
    })
    await expect(provider.complete(request)).rejects.toThrow('timeout')
  })

  it('does not send an already cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn()
    const authorizationHeader = vi.fn()
    const provider = createGenerationProvider({ fetchImpl, authorizationHeader })
    await expect(provider.complete({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(authorizationHeader).not.toHaveBeenCalled()
  })

  it.each(['credentials', 'fetch', 'stream'])(
    'times out a stalled %s with TimeoutError, not missing credentials',
    async (phase) => {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      let signal: AbortSignal | null | undefined
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return phase === 'fetch' ? new Promise<Response>(() => {}) : new Response(body)
      })
      const provider = createGenerationProvider({
        fetchImpl,
        timeoutMs: 30,
        authorizationHeader: async () => (phase === 'credentials' ? new Promise<null>(() => {}) : null),
      })
      await expect(provider.complete(request)).rejects.toMatchObject({ name: 'TimeoutError' })
      if (phase !== 'credentials') expect(signal?.aborted).toBe(true)
      else expect(fetchImpl).not.toHaveBeenCalled()
      if (phase === 'stream') {
        expect(cancel).toHaveBeenCalledOnce()
        expect(body.locked).toBe(false)
      }
    },
  )

  it('propagates operator cancellation to fetch and releases the stream reader', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    let signal: AbortSignal | null | undefined
    const provider = createGenerationProvider({
      fetchImpl: async (_input, init) => {
        signal = init?.signal
        return new Response(body)
      },
    })
    const pending = provider.complete({ ...request, signal: controller.signal })
    const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(body.locked).toBe(true))
    controller.abort()
    await outcome
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})
