// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ModelProviderUnavailableError } from '../../src/platform/contracts'
import { AnthropicModelProvider, ProviderRequestError, classifyUpstream, pruneToSupportedSchema } from './provider.ts'

const Schema = z.object({ subject: z.string().min(1), parts: z.number().int() })

const message = (text: string, usage = { input_tokens: 12, output_tokens: 7 }) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  stop_details: null,
  content: [{ type: 'text', text }],
  usage,
})

function fakeClient(replies: string[]) {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params)
        return message(replies[calls.length - 1] ?? replies.at(-1) ?? '{}')
      },
      stream: () => {
        throw new Error('not used in this test')
      },
    },
  }
}

describe('AnthropicModelProvider', () => {
  it('reports itself unconfigured, and throws a clear error, when no key is set', async () => {
    const provider = new AnthropicModelProvider({ apiKey: undefined })
    // Guard against a key leaking in from the developer's own environment.
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const bare = new AnthropicModelProvider()
      expect(bare.configured).toBe(false)
      await expect(
        bare.complete({ system: 's', prompt: 'p', schema: { type: 'object' }, parse: (raw) => raw }),
      ).rejects.toBeInstanceOf(ModelProviderUnavailableError)
      await expect(
        bare.complete({ system: 's', prompt: 'p', schema: { type: 'object' }, parse: (raw) => raw }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/)
    } finally {
      if (previous) process.env.ANTHROPIC_API_KEY = previous
    }
    expect(provider.model).toBe('claude-sonnet-5')
  })

  it('validates structured output with the caller’s parser and returns provenance', async () => {
    const client = fakeClient([JSON.stringify({ subject: 'rover', parts: 33 })])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never })
    const result = await provider.complete({
      system: 'be exact',
      prompt: 'describe it',
      schema: z.toJSONSchema(Schema, { io: 'output' }) as Record<string, unknown>,
      parse: (raw) => Schema.parse(raw),
    })
    expect(result.value).toEqual({ subject: 'rover', parts: 33 })
    expect(result.provenance.provider).toBe('anthropic')
    expect(result.provenance.model).toBe('claude-sonnet-5')
    expect(result.provenance.promptHash).toMatch(/^fnv1a:/)
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 })
    expect(client.calls[0].output_config).toMatchObject({ format: { type: 'json_schema' } })
  })

  it('retries a schema violation exactly once, then succeeds', async () => {
    const client = fakeClient([JSON.stringify({ subject: '', parts: 'lots' }), JSON.stringify({ subject: 'rover', parts: 33 })])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never })
    const result = await provider.complete({
      system: 'be exact',
      prompt: 'describe it',
      schema: {},
      parse: (raw) => Schema.parse(raw),
    })
    expect(result.value).toEqual({ subject: 'rover', parts: 33 })
    expect(client.calls.length).toBe(2)
    // The correction carries the validator's own complaint back to the model.
    expect(String((client.calls[1].messages as Array<{ content: string }>)[0].content)).toContain('did not satisfy')
    // Both attempts are billed, so both are reported.
    expect(result.usage.inputTokens).toBe(24)
  })

  it('rejects after one correction rather than retrying forever', async () => {
    const client = fakeClient([JSON.stringify({ nope: true })])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never })
    await expect(
      provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => Schema.parse(raw) }),
    ).rejects.toThrow(ProviderRequestError)
    expect(client.calls.length).toBe(2)
  })

  it('reports a schema violation with the validator’s reason, not a generic failure', async () => {
    const client = fakeClient(['not json at all'])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never })
    try {
      await provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => Schema.parse(raw) })
      expect.unreachable('should have thrown')
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProviderRequestError)
      expect((cause as ProviderRequestError).code).toBe('SCHEMA_VIOLATION')
      expect((cause as ProviderRequestError).retryable).toBe(false)
    }
  })

  it('does not send sampling parameters to a model that rejects them', async () => {
    const client = fakeClient([JSON.stringify({ subject: 'rover', parts: 1 })])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never, model: 'claude-sonnet-5' })
    await provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => Schema.parse(raw), temperature: 0.2 })
    expect(client.calls[0]).not.toHaveProperty('temperature')

    const older = fakeClient([JSON.stringify({ subject: 'rover', parts: 1 })])
    const legacy = new AnthropicModelProvider({ apiKey: 'test', client: older as never, model: 'claude-haiku-4-5' })
    await legacy.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => Schema.parse(raw), temperature: 0.2 })
    expect(older.calls[0]).toHaveProperty('temperature', 0.2)
  })

  it('reports a refusal as a refusal instead of a parse failure', async () => {
    const provider = new AnthropicModelProvider({
      apiKey: 'test',
      client: {
        messages: {
          create: async () => ({ ...message('{}'), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }),
          stream: () => {
            throw new Error('unused')
          },
        },
      } as never,
    })
    await expect(provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => raw })).rejects.toThrow(/declined this request/)
  })

  it('never lets a credential reach the caller through an upstream error', () => {
    const secret = 'sk-ant-api03-SUPERSECRETVALUE'
    const error = classifyUpstream(new Error(`x-api-key: ${secret} was rejected`), secret)
    expect(error.message).not.toContain('SUPERSECRETVALUE')
    expect(error.code).toBe('UPSTREAM_ERROR')
  })

  it('classifies an abort as an abort rather than an upstream failure', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(classifyUpstream(abort, undefined).code).toBe('ABORTED')
  })

  it('passes the caller’s abort signal through to the SDK', async () => {
    const seen: Array<{ signal?: AbortSignal }> = []
    const provider = new AnthropicModelProvider({
      apiKey: 'test',
      client: {
        messages: {
          create: async (_params: unknown, options: { signal?: AbortSignal }) => {
            seen.push(options)
            return message(JSON.stringify({ subject: 'rover', parts: 1 }))
          },
          stream: vi.fn(),
        },
      } as never,
    })
    const controller = new AbortController()
    await provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => Schema.parse(raw), signal: controller.signal })
    expect(seen[0].signal).toBe(controller.signal)
  })
})

describe('structured-output schema compatibility', () => {
  it('drops the keywords the structured-output validator rejects, and keeps the rest', () => {
    const pruned = pruneToSupportedSchema({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z]+$' },
        count: { type: 'integer', minimum: 1, maximum: 16, multipleOf: 2 },
        tags: { type: 'array', items: { type: 'string', maxLength: 8 }, minItems: 1, maxItems: 12 },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['name', 'count'],
      additionalProperties: false,
    })
    expect(pruned).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z]+$' },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string', maxLength: 8 } },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['name', 'count'],
      additionalProperties: false,
    })
  })

  it('sends the pruned schema but still enforces the original bound', async () => {
    const Bounded = z.object({ count: z.number().int().min(1).max(4) })
    const client = fakeClient([JSON.stringify({ count: 99 }), JSON.stringify({ count: 3 })])
    const provider = new AnthropicModelProvider({ apiKey: 'test', client: client as never })
    const result = await provider.complete({
      system: 's',
      prompt: 'p',
      schema: z.toJSONSchema(Bounded, { io: 'output' }) as Record<string, unknown>,
      parse: (raw) => Bounded.parse(raw),
    })
    const sent = (client.calls[0].output_config as { format: { schema: Record<string, unknown> } }).format.schema
    expect(JSON.stringify(sent)).not.toContain('maximum')
    // The bound the model was not told about is still the bound that holds.
    expect(result.value).toEqual({ count: 3 })
    expect(client.calls.length).toBe(2)
  })
})
