// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicModelProvider } from './provider.ts'
import { buildChatMessages, createAssistantRoute, structuralCheck, toApiMessages, toolTurnsUsed } from './handler.ts'
import { ASSISTANT_PROTOCOL, type AssistantEvent, type WireMessage } from './protocol.ts'
import type { RouteContext } from '../dispatch.ts'

/**
 * The route is exercised over real HTTP, on a real socket.
 *
 * Faking `IncomingMessage` would test the handler's shape and none of the
 * things that actually go wrong: chunked NDJSON framing, a client that hangs
 * up mid-stream, and a timeout that has to cancel an upstream generation.
 */

/** Just enough of the SDK's request to assert on prompt-cache layout. */
interface Block {
  type: string
  text?: string
  cache_control?: { type: string }
}

interface StreamParams {
  system: Block[]
  messages: Array<{ role: string; content: Block[] }>
}

interface StreamScript {
  deltas?: string[]
  final?: Record<string, unknown>
  /** Blocks until the request is aborted, for timeout and cancel tests. */
  hang?: boolean
}

function fakeAnthropic(script: StreamScript) {
  const seen: { signal?: AbortSignal; params?: StreamParams } = {}
  return {
    seen,
    messages: {
      create: async () => ({
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        stop_details: null,
        content: [{ type: 'text', text: JSON.stringify({ ok: true, subject: 'rover' }) }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      stream: (params: StreamParams, options: { signal?: AbortSignal }) => {
        seen.signal = options?.signal
        seen.params = params
        const final = script.final ?? {
          content: script.deltas?.length ? [{ type: 'text', text: script.deltas.join('') }] : [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 4 },
        }
        return {
          async *[Symbol.asyncIterator]() {
            for (const text of script.deltas ?? []) {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text } }
            }
            if (script.hang) {
              await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
              })
            }
          },
          async finalMessage() {
            return final
          },
        }
      },
    },
  }
}

let server: Server | null = null

async function listen(
  route: { handle: (request: never, response: never, url: URL, context?: RouteContext) => Promise<boolean> },
  context?: RouteContext,
) {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    void (async () => {
      const handled = await route.handle(request as never, response as never, url, context)
      if (!handled) {
        response.writeHead(404)
        response.end('unclaimed')
      }
    })()
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const chatBody = (overrides: Partial<{ messages: WireMessage[]; mode: string }> = {}) => ({
  protocol: ASSISTANT_PROTOCOL,
  kind: 'chat',
  mode: overrides.mode ?? 'propose',
  grounding: {
    documentRevision: 1,
    documentName: 'Survey rover',
    catalogVersion: '2026-07',
    autonomy: 'propose',
    partCount: 33,
    selection: [],
    subassemblies: [],
    constraints: [],
    openNotes: [],
    validation: { healthy: true, collisions: 0, components: 1 },
  },
  messages: overrides.messages ?? [{ role: 'user', text: 'What am I looking at?' }],
})

async function readEvents(response: Response): Promise<AssistantEvent[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AssistantEvent)
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('POST /api/assistant', () => {
  it('reports health without disclosing anything about the credential', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'test', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant/health`)
    const body = (await response.json()) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, protocol: ASSISTANT_PROTOCOL, model: 'claude-sonnet-5', configured: true })
    expect(JSON.stringify(body)).not.toContain('test')
  })

  it('leaves a path it does not own to the host', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    expect((await fetch(`${base}/api/other`)).status).toBe(404)
  })

  it('refuses anything but POST', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('rejects malformed JSON and a foreign protocol with an actionable message', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)

    const bad = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.code).toBe('BAD_REQUEST')

    const foreign = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...chatBody(), protocol: 'nope' }),
    })
    expect(foreign.status).toBe(400)
    expect((await foreign.json()).error.message).toContain(ASSISTANT_PROTOCOL)
  })

  it('refuses a simple-request content type before it can spend model tokens', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(chatBody()),
    })
    expect(response.status).toBe(415)
    expect((await response.json()).error.code).toBe('BAD_REQUEST')
  })

  it('says plainly when no provider is configured', async () => {
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: undefined }) })
      const base = await listen(route)
      const response = await fetch(`${base}/api/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chatBody()),
      })
      expect(response.status).toBe(503)
      const body = await response.json()
      expect(body.error.code).toBe('MODEL_PROVIDER_UNAVAILABLE')
      expect(body.error.message).toContain('ANTHROPIC_API_KEY')
    } finally {
      if (previous) process.env.ANTHROPIC_API_KEY = previous
    }
  })

  it('streams NDJSON deltas, the raw turn, tool calls, usage and a stop reason', async () => {
    const client = fakeAnthropic({
      deltas: ['The rover ', 'has 33 parts.'],
      final: {
        content: [
          { type: 'text', text: 'The rover has 33 parts.' },
          { type: 'tool_use', id: 'tu_1', name: 'scene_overview', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 800 },
      },
    })
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    })
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')

    const events = await readEvents(response)
    expect(events.map((event) => event.type)).toEqual(['start', 'text', 'text', 'turn', 'tool_call', 'usage', 'done'])
    expect(events[1]).toMatchObject({ text: 'The rover ' })
    expect(events.find((event) => event.type === 'tool_call')).toMatchObject({ call: { name: 'scene_overview' } })
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadInputTokens: 800,
    })
    expect(events.at(-1)).toEqual({ type: 'done', stop: 'tool_use' })
  })

  it('refuses a transcript that has already spent its tool budget', async () => {
    const route = createAssistantRoute({
      provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }),
      maxToolTurns: 2,
    })
    const base = await listen(route)
    const messages: WireMessage[] = [
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'scene_overview', input: {} }] },
      { role: 'tool', results: [{ id: 't1', name: 'scene_overview', ok: true, content: '{}' }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 't2', name: 'scene_overview', input: {} }] },
      { role: 'tool', results: [{ id: 't2', name: 'scene_overview', ok: true, content: '{}' }] },
    ]
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody({ messages })),
    })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('TOOL_TURN_LIMIT')
    expect(body.error.message).toContain('2 of 2')
  })

  it('cancels the upstream generation when the client hangs up', async () => {
    const client = fakeAnthropic({ deltas: ['starting'], hang: true })
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }) })
    const base = await listen(route)

    const controller = new AbortController()
    const request = fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
      signal: controller.signal,
    })
    // Wait until the upstream call has actually started before hanging up.
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    await request.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.seen.signal?.aborted).toBe(true)
  })

  it('gives up on a generation that outlives its timeout, and says so', async () => {
    const client = fakeAnthropic({ deltas: ['thinking about it'], hang: true })
    const route = createAssistantRoute({
      provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }),
      timeoutMs: 40,
    })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    })
    const events = await readEvents(response)
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({ code: 'TIMEOUT', retryable: true })
    expect(events.at(-1)).toEqual({ type: 'done', stop: 'error' })
  })

  it('reports a truncated reply rather than presenting it as complete', async () => {
    const client = fakeAnthropic({
      deltas: ['half a sentence'],
      final: { content: [{ type: 'text', text: 'half a sentence' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } },
    })
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    })
    const events = await readEvents(response)
    expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(events.at(-1)).toEqual({ type: 'done', stop: 'max_tokens' })
  })

  it('answers a structured request with a value, provenance and usage', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: ASSISTANT_PROTOCOL,
        kind: 'structured',
        system: 'be exact',
        prompt: 'describe it',
        schema: { type: 'object', required: ['ok'] },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.value).toEqual({ ok: true, subject: 'rover' })
    expect(body.provenance).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(body.usage).toEqual({ inputTokens: 5, outputTokens: 3, cacheWriteTokens: 0, cacheReadTokens: 0 })
  })

  it('rejects a conversation that does not open with a user message', async () => {
    const route = createAssistantRoute({ provider: new AnthropicModelProvider({ apiKey: 'k', client: fakeAnthropic({}) as never }) })
    const base = await listen(route)
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody({ messages: [{ role: 'assistant', text: 'hello' }] })),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('open with a user message')
  })
})

describe('transcript translation', () => {
  it('turns the normalized transcript into API messages', () => {
    const messages = toApiMessages([
      { role: 'user', text: 'What is this?', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
      { role: 'assistant', text: 'Reading.', toolCalls: [{ id: 't1', name: 'scene_overview', input: {} }] },
      { role: 'tool', results: [{ id: 't1', name: 'scene_overview', ok: false, content: '{"error":{}}' }] },
    ])
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'What is this?' },
    ])
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 't1', name: 'scene_overview', input: {} },
    ])
    expect(messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{"error":{}}', is_error: true }])
  })

  it('replays the model’s own blocks verbatim when it has them', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }]
    const [message] = toApiMessages([{ role: 'assistant', text: 'ignored', toolCalls: [], raw }])
    expect(message.content).toBe(raw)
  })

  it('drops an assistant turn with nothing in it rather than sending an empty message', () => {
    expect(toApiMessages([{ role: 'assistant', text: '   ' }])).toEqual([])
  })

  it('counts tool turns the way the budget does', () => {
    expect(
      toolTurnsUsed([
        { role: 'user', text: 'go' },
        { role: 'tool', results: [{ id: 'a', name: 'x', ok: true, content: '{}' }] },
        { role: 'tool', results: [{ id: 'b', name: 'x', ok: true, content: '{}' }] },
      ]),
    ).toBe(2)
  })
})

/**
 * Prompt-cache layout.
 *
 * These assert the property caching actually depends on — that the bytes ahead
 * of a breakpoint are identical on the next leg — rather than that a particular
 * field is present. A test that only checked for `cache_control` would still
 * pass with the marker in a position that never gets read back.
 */
describe('prompt cache layout', () => {
  /**
   * The prefix a breakpoint caches: every block up to and including the marked
   * one, markers stripped. The marker moves forward each leg by design, so it is
   * not part of what has to match.
   */
  const cachedPrefix = (messages: ReturnType<typeof buildChatMessages>) => {
    const out: Array<{ role: string; block: unknown }> = []
    for (const message of messages) {
      const blocks = message.content as Block[]
      for (const block of blocks) {
        const { cache_control: marker, ...rest } = block
        out.push({ role: message.role, block: rest })
        if (marker) return out
      }
    }
    return null
  }

  const grounding = (revision: number) => `Revision: ${revision}`

  it('appends the grounding after the transcript, not ahead of it', () => {
    const messages = buildChatMessages([{ role: 'user', text: 'What am I looking at?' }], grounding(1))
    const blocks = messages.at(-1)!.content as Block[]
    expect(blocks.at(-1)).toEqual({ type: 'text', text: 'Revision: 1' })
  })

  it('marks the block the grounding follows, so the transcript is the cached prefix', () => {
    const messages = buildChatMessages([{ role: 'user', text: 'What am I looking at?' }], grounding(1))
    const blocks = messages.at(-1)!.content as Block[]
    // Second to last: the grounding itself must stay outside the prefix, or its
    // per-leg churn would invalidate everything it is meant to sit behind.
    expect(blocks.at(-2)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks.at(-1)?.cache_control).toBeUndefined()
    expect(blocks.filter((block) => block.cache_control)).toHaveLength(1)
  })

  it('marks the tool results when the leg is a continuation', () => {
    const messages = buildChatMessages(
      [
        { role: 'user', text: 'Add a wall' },
        { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'scene_overview', input: {} }] },
        { role: 'tool', results: [{ id: 't1', name: 'scene_overview', ok: true, content: '{"parts":33}' }] },
      ],
      grounding(2),
    )
    const blocks = messages.at(-1)!.content as Block[]
    expect(blocks.at(-2)).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } })
    expect(blocks.at(-1)).toEqual({ type: 'text', text: 'Revision: 2' })
  })

  it('keeps the cached prefix byte-identical as the conversation grows', () => {
    // The whole point. A leg that cannot reproduce the previous leg's prefix
    // exactly reads nothing back and re-pays for the entire transcript.
    const first: WireMessage[] = [{ role: 'user', text: 'Add a wall' }]
    const second: WireMessage[] = [
      ...first,
      { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'scene_overview', input: {} }] },
      { role: 'tool', results: [{ id: 't1', name: 'scene_overview', ok: true, content: '{"parts":33}' }] },
    ]

    const legOne = cachedPrefix(buildChatMessages(first, grounding(1)))!
    const legTwo = cachedPrefix(buildChatMessages(second, grounding(2)))!
    expect(legOne).not.toBeNull()
    expect(legTwo.length).toBeGreaterThan(legOne.length)
    expect(legTwo.slice(0, legOne.length)).toEqual(legOne)
  })

  it('still produces a valid request when there is no user turn to append to', () => {
    // A last wire message carrying neither text nor an image is dropped by
    // `toApiMessages`, which would otherwise leave an assistant turn last. The
    // grounding gets its own user turn rather than the request being malformed.
    const messages = buildChatMessages(
      [
        { role: 'user', text: 'Add a wall' },
        { role: 'assistant', text: 'Proposed one.' },
        { role: 'user', text: '   ' },
      ],
      grounding(3),
    )
    expect(messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Revision: 3' }] })
  })

  it('sends one system block, so tools and the standing prompt cache together', async () => {
    const client = fakeAnthropic({ deltas: ['ok'] })
    const route = createAssistantRoute({
      provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }),
    })
    const base = await listen(route)
    await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    })

    const params = client.seen.params!
    expect(params.system).toHaveLength(1)
    expect(params.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    // The grounding used to be a second system block, ahead of every message.
    expect(params.system[0]?.text).not.toContain('Revision:')
    expect(JSON.stringify(params.messages.at(-1))).toContain('Revision: 1')
  })

  it('reports every token class to the meter, not just the uncached ones', async () => {
    const reported: unknown[] = []
    const client = fakeAnthropic({
      final: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 4, cache_creation_input_tokens: 900, cache_read_input_tokens: 7000 },
      },
    })
    const route = createAssistantRoute({
      provider: new AnthropicModelProvider({ apiKey: 'k', client: client as never }),
    })
    const base = await listen(route, { reportUsage: (usage) => reported.push(usage) })
    const response = await fetch(`${base}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
    })
    const events = await readEvents(response)

    expect(reported).toEqual([{ inputTokens: 11, outputTokens: 4, cacheWriteTokens: 900, cacheReadTokens: 7000 }])
    expect(events.find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 11,
      outputTokens: 4,
      cacheReadInputTokens: 7000,
      cacheCreationInputTokens: 900,
    })
  })
})

describe('structural check', () => {
  it('accepts a value that has the required keys', () => {
    expect(() => structuralCheck({ a: 1, b: 2 }, { type: 'object', required: ['a'] })).not.toThrow()
  })

  it('names the missing keys so the retry has something to fix', () => {
    expect(() => structuralCheck({ a: 1 }, { type: 'object', required: ['a', 'b', 'c'] })).toThrow(/missing required field\(s\): b, c/)
  })

  it('rejects the wrong root type', () => {
    expect(() => structuralCheck([1, 2], { type: 'object' })).toThrow(/JSON object/)
    expect(() => structuralCheck({}, { type: 'array' })).toThrow(/JSON array/)
  })
})
