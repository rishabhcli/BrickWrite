import { describe, expect, it, vi } from 'vitest'
import { createAssistantTransport, HttpModelProvider } from './provider'
import type { ChatRequest } from './protocol'

const request: ChatRequest = {
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
  messages: [{ role: 'user', text: 'Inspect this build.' }],
}
const start = { type: 'start', requestId: 'test', model: 'test', toolTurn: 0, maxToolTurns: 8 }
const ndjson = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'
function setup(body: string) {
  const handlers = { onDone: vi.fn(), onError: vi.fn(), onText: vi.fn(), onToolCall: vi.fn(), onTurn: vi.fn() }
  const transport = createAssistantTransport({ fetchImpl: vi.fn(async () => new Response(body)) })
  return { handlers, transport }
}

describe('assistant stream integrity', () => {
  it('refuses a premature EOF instead of reporting an implicitly completed reply', async () => {
    const h = setup(ndjson(start, { type: 'text', text: 'A partial answer' }))
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError).toHaveBeenCalledOnce()
    expect(h.handlers.onDone).toHaveBeenCalledExactlyOnceWith('error')
  })

  it('rejects a malformed terminal event before invoking completion callbacks', async () => {
    const h = setup(ndjson(start, { type: 'done' }))
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError).toHaveBeenCalledOnce()
    expect(h.handlers.onDone).toHaveBeenCalledExactlyOnceWith('error')
  })
})

const tool = { type: 'tool_call', call: { id: 'call1', name: 'scene_overview', input: {} } }
const turn = { type: 'turn', raw: [{ type: 'tool_use', ...tool.call }] }

describe('assistant tool and completion safety', () => {
  it.each([
    [],
    [{ type: 'done', stop: 'error' }],
    [{ type: 'done', stop: 'max_tokens' }],
    [{ type: 'done', stop: 'refusal' }],
    [{ type: 'done', stop: 'end_turn' }],
    [
      { type: 'error', code: 'TIMEOUT', message: 'Deadline', retryable: true },
      { type: 'done', stop: 'tool_use' },
    ],
  ])('withholds executable calls and raw turns from a failed or truncated reply (%j)', async (...tail) => {
    const h = setup(ndjson(start, turn, tool, ...tail))
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onToolCall).not.toHaveBeenCalled()
    expect(h.handlers.onTurn).not.toHaveBeenCalled()
    expect(h.handlers.onError).toHaveBeenCalledOnce()
    expect(h.handlers.onDone).toHaveBeenCalledExactlyOnceWith('error')
  })

  it('delivers tools only after successful completion, without waiting for the connection to close', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel,
    })
    const { handlers } = setup('')
    const transport = createAssistantTransport({ fetchImpl: async () => new Response(body) })
    const sending = transport.stream(request, handlers)
    controller.enqueue(new TextEncoder().encode(ndjson(start, turn, tool, { type: 'text', text: 'Ready' })))
    await vi.waitFor(() => expect(handlers.onText).toHaveBeenCalledWith('Ready'))
    expect(handlers.onToolCall).not.toHaveBeenCalled()
    controller.enqueue(new TextEncoder().encode(ndjson({ type: 'done', stop: 'tool_use' })))
    await sending
    expect(handlers.onToolCall).toHaveBeenCalledExactlyOnceWith(tool.call)
    expect(handlers.onTurn).toHaveBeenCalledExactlyOnceWith(turn.raw)
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('tool_use')
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it.each([
    [start, start],
    [start, tool, tool],
    [start, turn, turn],
    [start, { type: 'done', stop: 'tool_use' }],
    [start, { type: 'usage', inputTokens: -1, outputTokens: 0 }],
    [start, { type: 'tool_call', call: { ...tool.call, input: [] } }],
    [start, { type: 'text', text: 5 }],
    [start, { type: 'unknown' }],
    [start, { type: 'done', stop: ['end_turn'] }],
    [start, { type: 'error', code: ['TIMEOUT'], message: 'Invalid', retryable: true }],
    [{ type: 'text', text: 'No start' }],
  ])('fails closed on invalid event ordering or fields (%j)', async (...events) => {
    const h = setup(ndjson(...events))
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError).toHaveBeenCalledOnce()
    expect(h.handlers.onDone).toHaveBeenCalledExactlyOnceWith('error')
    expect(h.handlers.onToolCall).not.toHaveBeenCalled()
  })

  it('accepts blank heartbeats and CRLF framing, then ignores data after the terminal event', async () => {
    const h = setup(
      '\n\r\n' +
        ndjson(start, { type: 'text', text: '🧱' }, { type: 'done', stop: 'end_turn' }).replaceAll('\n', '\r\n') +
        '{broken',
    )
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onText).toHaveBeenCalledExactlyOnceWith('🧱')
    expect(h.handlers.onDone).toHaveBeenCalledExactlyOnceWith('end_turn')
    expect(h.handlers.onError).not.toHaveBeenCalled()
  })
})

describe('whole assistant exchange deadlines', () => {
  it('does not fetch or resolve credentials for an already cancelled request', async () => {
    const abort = new AbortController()
    abort.abort()
    const fetchImpl = vi.fn()
    const authorizationHeader = vi.fn()
    const { handlers } = setup('')
    await createAssistantTransport({ fetchImpl, authorizationHeader }).stream(request, handlers, abort.signal)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(authorizationHeader).not.toHaveBeenCalled()
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('aborted')
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  it.each(['credentials', 'fetch', 'stream', 'error body'])(
    'ends a stalled %s phase and reports TIMEOUT once',
    async (phase) => {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ cancel })
      let signal: AbortSignal | null | undefined
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return phase === 'fetch'
          ? new Promise<Response>(() => {})
          : new Response(body, { status: phase === 'error body' ? 502 : 200 })
      })
      const authorizationHeader = async () => (phase === 'credentials' ? new Promise<null>(() => {}) : null)
      const { handlers } = setup('')
      await createAssistantTransport({ fetchImpl, authorizationHeader, timeoutMs: 30 }).stream(request, handlers)
      expect(handlers.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'TIMEOUT', retryable: true }),
      )
      expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('error')
      if (phase !== 'credentials') expect(signal?.aborted).toBe(true)
      else expect(fetchImpl).not.toHaveBeenCalled()
      if (phase === 'stream' || phase === 'error body') {
        expect(cancel).toHaveBeenCalledOnce()
        expect(body.locked).toBe(false)
      }
    },
  )

  it('cancels a stalled reader on operator abort, not a provider failure', async () => {
    const abort = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const { handlers } = setup('')
    const sending = createAssistantTransport({ fetchImpl: async () => new Response(body) }).stream(
      request,
      handlers,
      abort.signal,
    )
    await vi.waitFor(() => expect(body.locked).toBe(true))
    abort.abort()
    await sending
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('aborted')
    expect(handlers.onError).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
})

it('bounds structured assistant response reads and reports a stalled body as TIMEOUT', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const provider = new HttpModelProvider({ fetchImpl: async () => new Response(body), timeoutMs: 30 })
  await expect(
    provider.complete({ system: 'Build', prompt: 'House', schema: {}, parse: (raw) => raw }),
  ).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
})

/**
 * What the user is told when something refuses before the route runs.
 *
 * The edge proxy, the session check, the in-flight ceiling and the spend meter
 * all answer `{ error, detail }` rather than the route's own envelope, and each
 * writes the one sentence that says what to do. The transport understood only
 * the route's shape, so the most actionable refusal in the system — a spent
 * daily allowance, with the reset time in it — reached the user as a status
 * number.
 */
describe('a refusal from in front of the route', () => {
  const refuse = (status: number, body: unknown) => {
    const handlers = { onDone: vi.fn(), onError: vi.fn(), onText: vi.fn(), onToolCall: vi.fn(), onTurn: vi.fn() }
    const transport = createAssistantTransport({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
      ),
    })
    return { handlers, transport }
  }

  it('shows the sentence the server wrote, not the status code', async () => {
    const detail = 'This account has used its daily model allowance. It resets at 00:00 UTC.'
    const h = refuse(429, { error: 'budget_exhausted', detail })
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError).toHaveBeenCalledExactlyOnceWith({
      code: 'RATE_LIMITED',
      message: detail,
      // Today's allowance is gone; trying again now cannot help.
      retryable: false,
    })
  })

  it('offers a retry for a ceiling that clears on its own', async () => {
    const h = refuse(429, {
      error: 'too_many_in_flight',
      detail: 'This account already has 6 model requests in flight. Wait for one to finish.',
    })
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError.mock.calls[0][0]).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })

  it('does not read a deployment fault as a problem with the account', async () => {
    // `proxy_required` is a 403, and a 403 used to mean "complete your account
    // checks" — advice for a fault the visitor cannot do anything about.
    const h = refuse(403, { error: 'proxy_required', detail: 'Use the Brickwright application API origin.' })
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError.mock.calls[0][0]).toMatchObject({ code: 'UPSTREAM_ERROR' })
  })

  it('still reads the route’s own envelope', async () => {
    const h = refuse(409, {
      ok: false,
      error: { code: 'TOOL_TURN_LIMIT', message: 'This conversation has used its tool turns.', retryable: false },
    })
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError.mock.calls[0][0]).toMatchObject({ code: 'TOOL_TURN_LIMIT' })
  })

  it('falls back to the status when the code is one it has never seen', async () => {
    const h = refuse(418, { error: 'brand_new_code', detail: 'Something nobody has mapped yet.' })
    await h.transport.stream(request, h.handlers)
    expect(h.handlers.onError.mock.calls[0][0].message).toContain('418')
  })
})
