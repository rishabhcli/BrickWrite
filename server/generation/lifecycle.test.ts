// @vitest-environment node
import { createServer, request as httpRequest, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGenerationRoute } from './index.ts'
import { createAssistantRoute } from '../assistant/handler.ts'
import { AnthropicModelProvider } from '../assistant/provider.ts'
import { MAX_REQUEST_BYTES } from '../assistant/protocol.ts'
import { boundedTimeout } from '../http/lifecycle.ts'
import { createAssistantTransport } from '../../src/agent/provider.ts'
import { createGenerationProvider } from '../../src/generation/provider.ts'
import type { ChatRequest } from '../../src/agent/protocol.ts'
import type { RouteModule } from '../dispatch.ts'

const servers: Server[] = []
async function listen(route: RouteModule) {
  const server = createServer((request, response) => {
    void route.handle(request, response, new URL(request.url!, 'http://localhost'))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})
// A generous test guard is separate from the short, real request deadline. A
// regression must fail with evidence instead of hanging the entire suite.
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('HTTP request outlived its deadline')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const post = (base: string, route: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
const generationBody = { system: 'Build', prompt: 'A house', schema: { type: 'object', properties: { features: {} } } }
const structuredBody = {
  protocol: 'brickwright.assistant/1',
  kind: 'structured',
  system: 'Build',
  prompt: 'A house',
  schema: { type: 'object' },
}
const chatBody = {
  protocol: 'brickwright.assistant/1',
  kind: 'chat',
  mode: 'inspect',
  grounding: {
    documentRevision: 0,
    documentName: 'Build',
    catalogVersion: 'test',
    autonomy: 'inspect',
    partCount: 0,
    selection: [],
    subassemblies: [],
    constraints: [],
    openNotes: [],
    validation: { healthy: true, collisions: 0, components: 0 },
  },
  messages: [{ role: 'user', text: 'Inspect' }],
}
/*
 * The default payload has to satisfy detailSchema, not merely parse.
 *
 * `features` gained a `.min(1)` so the server validator stays in lockstep with
 * `parseDetail`, which turns an empty answer into the existing corrective retry
 * instead of a client-side failure after the request has already completed. An
 * empty `features` array is therefore no longer a valid generation, and a
 * fixture that sends one is testing a contract the product no longer has.
 */
const message = (
  text = '{"features":[{"id":"f1","role":"window","query":"1x2 plate","atXStuds":0,"atZStuds":0,"quarterTurns":0}]}',
) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 2, output_tokens: 3 },
})
const events = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))

describe('hard AI request deadlines over real HTTP', () => {
  it.each(['/api/generate', '/api/brief'])(
    'ends %s even when the upstream provider ignores cancellation',
    async (path) => {
      let signal: AbortSignal | undefined
      const route = createGenerationRoute({
        timeoutMs: 100,
        providerConfig: {
          client: {
            create: async (_body: unknown, options: unknown) => {
              signal = (options as { signal: AbortSignal }).signal
              return new Promise(() => {})
            },
          },
        },
      })
      const base = await listen(route)
      const response = await bounded(post(base, path, path === '/api/brief' ? { text: 'A house' } : generationBody))
      const output = events(await bounded(response.text()))
      expect(output.at(-1)).toMatchObject({ type: 'error', error: 'timeout' })
      expect(output.filter((event) => event.type === 'result')).toEqual([])
      expect(signal?.aborted).toBe(true)
    },
  )

  it('ends structured assistant work even when the provider ignores its abort signal', async () => {
    let signal: AbortSignal | undefined
    const provider = new AnthropicModelProvider({
      client: {
        messages: {
          create: async (_body: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal
            return new Promise(() => {})
          },
        },
      } as never,
    })
    const base = await listen(createAssistantRoute({ timeoutMs: 100, provider }))
    const response = await bounded(post(base, '/api/assistant', structuredBody))
    expect(response.status).toBe(504)
    expect(await response.json()).toMatchObject({ error: { code: 'TIMEOUT' } })
    expect(signal?.aborted).toBe(true)
  })

  it.each(['iterator', 'finalMessage'])(
    'ends chat stalled at %s, with heartbeat and exactly one error/done',
    async (phase) => {
      let signal: AbortSignal | undefined
      const stream = (_body: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal
        return {
          [Symbol.asyncIterator]() {
            return { next: () => (phase === 'iterator' ? new Promise(() => {}) : Promise.resolve({ done: true })) }
          },
          finalMessage: () => new Promise(() => {}),
        }
      }
      const provider = new AnthropicModelProvider({ client: { messages: { stream } } as never })
      const base = await listen(createAssistantRoute({ timeoutMs: 150, heartbeatMs: 15, provider }))
      const response = await bounded(post(base, '/api/assistant', chatBody))
      const text = await bounded(response.text())
      const output = events(text)
      expect(text).toContain('\n\n')
      expect(output.map((event) => event.type)).toEqual(['start', 'error', 'done'])
      expect(output[1]).toMatchObject({ code: 'TIMEOUT', retryable: true })
      expect(output[2]).toEqual({ type: 'done', stop: 'error' })
      expect(signal?.aborted).toBe(true)
    },
  )

  it('spends one total deadline across corrective attempts, not a fresh deadline per attempt', async () => {
    const signals: AbortSignal[] = []
    const create = vi.fn(async (_body: unknown, options: unknown) => {
      signals.push((options as { signal: AbortSignal }).signal)
      if (signals.length === 1) {
        await delay(80)
        return message('{invalid')
      }
      return new Promise(() => {})
    })
    const base = await listen(createGenerationRoute({ timeoutMs: 180, providerConfig: { client: { create } } }))
    const response = await bounded(post(base, '/api/generate', generationBody))
    expect(events(await bounded(response.text())).at(-1)).toMatchObject({ error: 'timeout' })
    expect(create).toHaveBeenCalledTimes(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[1].aborted).toBe(true)
  })

  it.each(['generation', 'structured'])(
    'does not issue corrective calls for late %s responses after timeout',
    async (kind) => {
      let resolve!: (value: unknown) => void
      const create = vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      const route =
        kind === 'generation'
          ? createGenerationRoute({ timeoutMs: 100, providerConfig: { client: { create } } })
          : createAssistantRoute({
              timeoutMs: 100,
              provider: new AnthropicModelProvider({ client: { messages: { create } } as never }),
            })
      const base = await listen(route)
      const response = await bounded(
        post(
          base,
          kind === 'generation' ? '/api/generate' : '/api/assistant',
          kind === 'generation' ? generationBody : structuredBody,
        ),
      )
      expect(await bounded(response.text())).toMatch(/timeout/i)
      resolve(message('{invalid'))
      await delay(20)
      expect(create).toHaveBeenCalledOnce()
    },
  )
})

const bodyRoutes = [
  {
    name: 'generation',
    path: '/api/generate',
    max: 256 * 1024,
    create: () =>
      createGenerationRoute({
        timeoutMs: 100,
        providerConfig: {
          client: {
            create: async () => {
              throw new Error('Must not reach model')
            },
          },
        },
      }),
  },
  {
    name: 'assistant',
    path: '/api/assistant',
    max: MAX_REQUEST_BYTES,
    create: () =>
      createAssistantRoute({
        timeoutMs: 100,
        provider: new AnthropicModelProvider({
          client: {
            messages: {
              create: async () => {
                throw new Error('Must not reach model')
              },
            },
          } as never,
        }),
      }),
  },
]

describe.each(bodyRoutes)('$name upload boundaries', ({ path, max, create }) => {
  it('returns actionable 408 for an unfinished chunked upload', async () => {
    const base = await listen(create())
    const response = await bounded(
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = httpRequest(
          `${base}${path}`,
          { method: 'POST', headers: { 'content-type': 'application/json' } },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () => {
              resolve({ status: res.statusCode, body })
              req.destroy()
            })
          },
        )
        req.on('error', reject)
        req.write('{') // Never finish sending this body.
      }),
    )
    expect(response.status).toBe(408)
    expect(response.body).toMatch(/timeout/i)
  })

  it.each(['declared', 'chunked'])(
    'returns 413 for %s oversize bodies instead of resetting the socket',
    async (mode) => {
      const base = await listen(create())
      const status = await bounded(
        new Promise<number | undefined>((resolve, reject) => {
          const req = httpRequest(
            `${base}${path}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(mode === 'declared' ? { 'content-length': max + 1 } : { 'transfer-encoding': 'chunked' }),
              },
            },
            (res) => {
              res.resume()
              res.on('end', () => {
                resolve(res.statusCode)
                req.destroy()
              })
            },
          )
          req.on('error', reject)
          if (mode === 'declared') {
            req.flushHeaders()
          } else req.end(Buffer.alloc(max + 1, 32))
        }),
      )
      expect(status).toBe(413)
    },
  )

  it('handles a disconnect during upload without an unhandled socket error', async () => {
    const base = await listen(create())
    const req = httpRequest(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } })
    req.on('error', () => {})
    req.write('{')
    await delay(20)
    req.destroy()
    await delay(20)
    expect((await fetch(`${base}${path}`)).status).toBe(405)
  })
})

it('aborts model work when the browser cancels a live generation stream', async () => {
  let signal: AbortSignal | undefined
  const create = vi.fn(async (_body: unknown, options: unknown) => {
    signal = (options as { signal: AbortSignal }).signal
    return new Promise(() => {})
  })
  const base = await listen(createGenerationRoute({ timeoutMs: 5000, providerConfig: { client: { create } } }))
  const abort = new AbortController()
  const response = await bounded(post(base, '/api/generate', generationBody, abort.signal))
  const reader = response.body!.getReader()
  await reader.read()
  abort.abort()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  await reader.cancel().catch(() => {})
  reader.releaseLock()
  expect(create).toHaveBeenCalledOnce()
})

it.each(['garbage', '', '0', '-20', 'Infinity', undefined])(
  'invalid deadline config %s uses a safe fallback',
  (value) => {
    expect(boundedTimeout(value, 120_000)).toBe(120_000)
  },
)
it('caps excessively large timeouts without overflowing Node timers', () => {
  expect(boundedTimeout(2 ** 40, 120_000)).toBe(600_000)
})

describe('browser transports through the real Node HTTP handler', () => {
  it('reports one completed tool turn and no error from a real assistant socket', async () => {
    let signal: AbortSignal | undefined
    const provider = new AnthropicModelProvider({
      client: {
        messages: {
          stream: (_body: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Inspecting 🧱' } }
              },
              async finalMessage() {
                return {
                  ...message(),
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'call1', name: 'scene_overview', input: {} }],
                }
              },
            }
          },
        },
      } as never,
    })
    const base = await listen(createAssistantRoute({ timeoutMs: 100, provider }))
    const handlers = { onText: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await bounded(
      createAssistantTransport({ endpoint: `${base}/api/assistant`, fetchImpl: fetch }).stream(
        chatBody as ChatRequest,
        handlers,
      ),
    )
    expect(handlers.onText).toHaveBeenCalledExactlyOnceWith('Inspecting 🧱')
    expect(handlers.onToolCall).toHaveBeenCalledExactlyOnceWith({ id: 'call1', name: 'scene_overview', input: {} })
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('tool_use')
    expect(handlers.onError).not.toHaveBeenCalled()
    await delay(120)
    expect(signal?.aborted).toBe(false) // A finished request releases its deadline.
  })

  it('streams a validated generation through the same client used by the application', async () => {
    const create = vi.fn(async () => message())
    const base = await listen(createGenerationRoute({ providerConfig: { client: { create } } }))
    const onProgress = vi.fn()
    const provider = createGenerationProvider({ baseUrl: base, fetchImpl: fetch, onProgress })
    const result = await bounded(provider.complete({ ...generationBody, parse: (raw) => raw }))
    expect(result.value).toEqual({
      features: [{ id: 'f1', role: 'window', query: '1x2 plate', atXStuds: 0, atZStuds: 0, quarterTurns: 0 }],
    })
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
    expect(onProgress).toHaveBeenCalledWith('calling model')
    expect(create).toHaveBeenCalledOnce()
  })
})
