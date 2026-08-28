import { afterEach, describe, expect, it } from 'vitest'
import { ModelProviderUnavailableError } from '../../src/platform/contracts.ts'
import { AnthropicGenerationProvider, SchemaViolationError, configFromEnv, redact } from './anthropic.ts'
import { kindForSchema, validatePayload } from './schema.ts'
import { createGenerationServer, type StandaloneServer } from './serve.ts'

/**
 * The route is exercised over a real socket.
 *
 * A test that calls the handler function directly proves the handler works; it
 * says nothing about whether the stream framing, the status codes or the abort
 * path do. Binding a port costs milliseconds and makes the assertions about the
 * thing a browser will actually talk to.
 *
 * The Anthropic client is the one seam that is stubbed, because the alternative
 * is a suite whose result depends on a network. The live smoke test in
 * `live.test.ts` covers the real call.
 */

const MASSING_SCHEMA = {
  type: 'object',
  properties: { boxes: { type: 'array' } },
  required: ['boxes'],
} as const

const BRIEF_SCHEMA = { type: 'object', properties: { subject: { type: 'string' } } } as const

const goodBoxes = {
  boxes: [
    {
      id: 'hull',
      role: 'base',
      atXStuds: 0,
      atZStuds: 0,
      widthStuds: 12,
      depthStuds: 8,
      courses: 4,
      level: 0,
      fill: 'solid',
    },
  ],
}

const message = (payload: unknown, usage = { input_tokens: 100, output_tokens: 40 }) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  usage,
  stop_reason: 'end_turn',
})

/** A stub for the one SDK method the provider calls. */
function stubClient(responses: unknown[]) {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    client: {
      async create(body: unknown) {
        calls.push(body as Record<string, unknown>)
        const next = responses[Math.min(calls.length - 1, responses.length - 1)]
        if (next instanceof Error) throw next
        return next
      },
    },
  }
}

let running: StandaloneServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

type InjectedProviderConfig = NonNullable<Parameters<typeof createGenerationServer>[0]>['providerConfig']

async function start(providerConfig?: InjectedProviderConfig) {
  running = await createGenerationServer(providerConfig ? { providerConfig } : {})
  return running
}

/** Reads a newline-delimited response into its events. */
async function ndjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('the schema layer decides what the model is allowed to say', () => {
  it('routes a JSON Schema to the validator that matches it', () => {
    expect(kindForSchema(MASSING_SCHEMA)).toBe('massing')
    expect(kindForSchema(BRIEF_SCHEMA)).toBe('brief')
    expect(kindForSchema({ type: 'object', properties: { features: {} } })).toBe('detail')
    expect(kindForSchema({ type: 'object', properties: { wat: {} } })).toBeNull()
    expect(kindForSchema(null)).toBeNull()
  })

  it('names the field that was wrong rather than failing generically', () => {
    const outcome = validatePayload('massing', { boxes: [{ id: 'a', role: 'b', atXStuds: -4, widthStuds: 1 }] })
    expect(outcome.ok).toBe(false)
    expect(outcome.problems?.join(' ')).toMatch(/boxes\.0/)
  })

  it('accepts a well-formed decomposition', () => {
    expect(validatePayload('massing', goodBoxes).ok).toBe(true)
  })
})

describe('the provider validates, retries once, then refuses', () => {
  it('returns the value and the usage on a first-attempt success', async () => {
    const { client, calls } = stubClient([message(goodBoxes)])
    const provider = new AnthropicGenerationProvider({ client, model: 'claude-sonnet-5' })
    const result = await provider.complete({ system: 's', prompt: 'p', schema: MASSING_SCHEMA })
    expect(result.attempts).toBe(1)
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40 })
    expect(result.provenance.model).toBe('claude-sonnet-5')
    expect((result.value as typeof goodBoxes).boxes).toHaveLength(1)
    // Sampling parameters are rejected by this model family; sending one would
    // turn every request into a 400.
    expect(calls[0]).not.toHaveProperty('temperature')
    expect(calls[0].output_config).toMatchObject({ format: { type: 'json_schema' } })
  })

  it('feeds the validator complaints back and accepts the corrected answer', async () => {
    const { client, calls } = stubClient([message({ boxes: 'nope' }), message(goodBoxes)])
    const provider = new AnthropicGenerationProvider({ client })
    const result = await provider.complete({ system: 's', prompt: 'p', schema: MASSING_SCHEMA })
    expect(result.attempts).toBe(2)
    // Usage is the total across both calls, not just the successful one.
    expect(result.usage.inputTokens).toBe(200)
    const retry = calls[1].messages as Array<{ role: string; content: string }>
    expect(retry).toHaveLength(3)
    expect(retry[2].content).toMatch(/did not satisfy the schema/)
  })

  it('refuses after two violations rather than salvaging part of the answer', async () => {
    const { client, calls } = stubClient([message({ boxes: [] })])
    const provider = new AnthropicGenerationProvider({ client })
    await expect(provider.complete({ system: 's', prompt: 'p', schema: MASSING_SCHEMA })).rejects.toBeInstanceOf(
      SchemaViolationError,
    )
    expect(calls).toHaveLength(2)
  })

  it('refuses a schema it has no validator for instead of passing it through', async () => {
    const { client } = stubClient([message(goodBoxes)])
    const provider = new AnthropicGenerationProvider({ client })
    await expect(
      provider.complete({ system: 's', prompt: 'p', schema: { type: 'object', properties: { wat: {} } } }),
    ).rejects.toBeInstanceOf(SchemaViolationError)
  })

  it('raises ModelProviderUnavailableError when no key is configured', () => {
    expect(() => new AnthropicGenerationProvider({ apiKey: '   ' })).toThrow(ModelProviderUnavailableError)
    expect(() => new AnthropicGenerationProvider({ apiKey: undefined })).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('reads its model and timeout from the environment', () => {
    const config = configFromEnv({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      BRICKWRIGHT_GENERATION_MODEL: 'claude-opus-5',
      BRICKWRIGHT_GENERATION_TIMEOUT_MS: '9000',
    } as NodeJS.ProcessEnv)
    expect(config.model).toBe('claude-opus-5')
    expect(config.timeoutMs).toBe(9000)
    expect(configFromEnv({} as NodeJS.ProcessEnv).model).toBe('claude-sonnet-5')
  })

  it('redacts anything key-shaped before it can reach a client', () => {
    expect(redact('failed with sk-ant-api03-abcdefghijklmnop')).toBe('failed with sk-ant-***')
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***')
  })
})

describe('POST /api/generate', () => {
  it('streams accepted, progress and result as newline-delimited JSON', async () => {
    const { client } = stubClient([message(goodBoxes)])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 'decompose', prompt: 'a house', schema: MASSING_SCHEMA }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')

    const events = await ndjson(response)
    expect(events.map((event) => event.type)).toEqual(['accepted', 'progress', 'result'])
    expect(events[1].stage).toBe('calling model')
    const result = events.at(-1)!
    expect((result.value as typeof goodBoxes).boxes).toHaveLength(1)
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40 })
    expect((result.provenance as { provider: string }).provider).toBe('anthropic')
  })

  it('answers 503 with a stable code when no credential is configured', async () => {
    const server = await start({ apiKey: '' })
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 's', prompt: 'p', schema: MASSING_SCHEMA }),
    })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string; detail: string }
    expect(body.error).toBe('model_provider_unavailable')
    expect(body.detail).toMatch(/ANTHROPIC_API_KEY/)
    expect(body.detail).not.toMatch(/sk-ant-/)
  })

  it('rejects a malformed body without opening a stream', async () => {
    const { client } = stubClient([message(goodBoxes)])
    const server = await start({ client })
    const bad = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('bad_request')

    const missing = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'p', schema: MASSING_SCHEMA }),
    })
    const events = await ndjson(missing)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'bad_request' })
  })

  it('refuses a method other than POST', async () => {
    const { client } = stubClient([message(goodBoxes)])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/generate`)
    expect(response.status).toBe(405)
  })

  it('refuses a simple-request content type before it can spend model tokens', async () => {
    const { client, calls } = stubClient([message(goodBoxes)])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ system: 's', prompt: 'p', schema: MASSING_SCHEMA }),
    })
    expect(response.status).toBe(415)
    expect(((await response.json()) as { error: string }).error).toBe('unsupported_media_type')
    expect(calls).toHaveLength(0)
  })

  it('reports an upstream failure as a sanitised terminal error event', async () => {
    const upstream = Object.assign(new Error('boom: sk-ant-api03-secretsecret'), { status: 500 })
    const { client } = stubClient([upstream])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 's', prompt: 'p', schema: MASSING_SCHEMA }),
    })
    const events = await ndjson(response)
    const terminal = events.at(-1)!
    expect(terminal.type).toBe('error')
    expect(terminal.error).toBe('model_error')
    expect(JSON.stringify(terminal)).not.toMatch(/sk-ant-/)
    expect(JSON.stringify(terminal)).not.toMatch(/\bat \w+ \(/)
  })

  it('maps a rejected credential to unavailable rather than a generic failure', async () => {
    const upstream = Object.assign(new Error('unauthorized'), { status: 401 })
    const { client } = stubClient([upstream])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 's', prompt: 'p', schema: MASSING_SCHEMA }),
    })
    expect((await ndjson(response)).at(-1)).toMatchObject({ error: 'model_provider_unavailable' })
  })

  it('carries a client abort through to the model call', async () => {
    let sawAbort = false
    const client = {
      async create(_body: unknown, options?: unknown) {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        await new Promise<void>((resolve) => {
          if (!signal) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => {
            sawAbort = true
            resolve()
          })
          // Never resolves on its own: only the abort ends this call.
        })
        throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })
      },
    }
    const server = await start({ client })
    const controller = new AbortController()
    const pending = fetch(`${server.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 's', prompt: 'p', schema: MASSING_SCHEMA }),
      signal: controller.signal,
    })
    // Give the request time to reach the handler before pulling the plug. The
    // headers are already on the wire by then, so `fetch` resolves and it is the
    // *body* that fails — which is the shape a streaming client actually sees.
    const response = await pending
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 120))
    controller.abort()
    await expect(response.text()).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sawAbort, 'the model call must be cancelled when the client goes away').toBe(true)
  }, 15_000)
})

describe('POST /api/brief', () => {
  const modelBrief = {
    subject: 'red pickup truck',
    envelopeWidthStuds: 14,
    envelopeHeightStuds: 6,
    envelopeDepthStuds: 8,
    scale: 'minifig',
    functions: ['wheels turn'],
    paletteColourNames: ['red'],
    symmetry: 'mirror-x',
    partBudget: 200,
    style: ['chunky'],
    evidence: [{ field: 'subject', phrase: 'a red pickup truck' }],
    conflicts: [],
  }

  it('returns a version-1 design brief with the palette resolved to LDraw codes', async () => {
    const { client } = stubClient([message(modelBrief)])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/brief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Build a red pickup truck 14 x 8 studs' }),
    })
    const events = await ndjson(response)
    const result = events.at(-1)!
    expect(result.type).toBe('result')
    const brief = result.value as {
      version: number
      palette: number[]
      subject: string
      conflicts: unknown[]
      envelopeStuds: number[] | null
      evidence: Record<string, string>
    }
    expect(brief.version).toBe(1)
    expect(brief.subject).toBe('red pickup truck')
    expect(brief.conflicts).toEqual([])
    // The three wire scalars are folded back into the contract's triple.
    expect(brief.envelopeStuds).toEqual([14, 6, 8])
    expect(brief.evidence.subject).toBe('a red pickup truck')
    // The compiled colour table lives in `public/`; when it is present "red"
    // resolves to LDraw 4, and when it is not the route says so in `notes`
    // rather than guessing a code.
    if (brief.palette.length) expect(brief.palette).toEqual([4])
    else expect((result.notes as string[]).join(' ')).toMatch(/colour table/)
  })

  it('rejects a request with no text', async () => {
    const { client } = stubClient([message(modelBrief)])
    const server = await start({ client })
    const response = await fetch(`${server.url}/api/brief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    expect((await ndjson(response)).at(-1)).toMatchObject({ type: 'error', error: 'bad_request' })
  })
})

describe('the route claims only what it serves', () => {
  it('answers health and declines a path it does not own', async () => {
    const { client } = stubClient([message(goodBoxes)])
    const server = await start({ client })
    const health = await fetch(`${server.url}/api/health`)
    expect(await health.json()).toMatchObject({ ok: true, routes: ['/api/'] })

    const other = await fetch(`${server.url}/api/something-else`, { method: 'POST', body: '{}' })
    expect(other.status).toBe(404)
  })
})
