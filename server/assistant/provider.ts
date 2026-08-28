import Anthropic from '@anthropic-ai/sdk'
import {
  ModelProviderUnavailableError,
  hash32,
  stableStringify,
} from '../../src/platform/contracts.ts'
import type { ModelProvider, ModelRequest, ModelResult } from '../../src/platform/contracts.ts'
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from './protocol.ts'
import { redactSecret, sanitizeMessage } from './sanitize.ts'

/**
 * The one place in the repository that holds the model API key.
 *
 * `src/platform/contracts.ts` is imported for the contract itself: it is the
 * cross-workstream types file and is deliberately dependency-free — types, an
 * error class and two pure hash helpers — so loading it here costs the API
 * process nothing and guarantees this implementation and the browser proxy in
 * `src/agent/provider.ts` satisfy the *same* interface rather than two
 * interfaces that happen to look alike.
 */

/**
 * Models that still accept sampling parameters.
 *
 * Sonnet 5 and the 4.6+ family reject `temperature`/`top_p` with a 400. The
 * `ModelRequest` contract carries an optional temperature, so rather than
 * dropping it silently the provider records that it was ignored — a request
 * that quietly loses a parameter is worse than one that says it did.
 */
const SAMPLING_REJECTING = /^claude-(?:opus-(?:4-6|4-7|4-8|5)|sonnet-(?:4-6|5)|fable-5|mythos-)/

export interface AnthropicProviderOptions {
  apiKey?: string
  model?: string
  timeoutMs?: number
  /** Injected in tests so the retry-once path can be exercised without network. */
  client?: Pick<Anthropic, 'messages'>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/**
 * JSON Schema keywords the structured-output validator rejects.
 *
 * Measured against the live API rather than assumed: `minLength`/`maxLength`,
 * `pattern` and `enum` are accepted; numeric bounds and array-length bounds are
 * refused with a 400 naming the keyword. A caller writing an ordinary Zod
 * schema — `z.array(...).max(12)`, `z.number().int().min(1)` — would otherwise
 * get an opaque upstream error for a schema that is perfectly valid.
 *
 * Pruning is safe because the advertised schema is not the enforcement point.
 * `ModelRequest.parse` is, it runs on every attempt, and a violation costs one
 * correction and then a rejection. Dropping a bound here loses nothing except a
 * hint the model would not have been given anyway.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
] as const

export function pruneToSupportedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(pruneToSupportedSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key)) continue
    out[key] = pruneToSupportedSchema(value)
  }
  return out
}

export type ProviderErrorCode = 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'SCHEMA_VIOLATION' | 'TIMEOUT' | 'ABORTED'

/**
 * Fields are declared and assigned rather than written as constructor
 * parameter properties: `server/index.ts` is run by Node's strip-only
 * TypeScript mode, which erases types without transforming syntax, and a
 * parameter property is a transform. The API process has no build step, and
 * that is worth keeping.
 */
export class ProviderRequestError extends Error {
  readonly code: ProviderErrorCode
  readonly retryable: boolean

  constructor(code: ProviderErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = 'ProviderRequestError'
    this.code = code
    this.retryable = retryable
  }
}

/** Turns an SDK or transport failure into a sanitised, classified error. */
export function classifyUpstream(cause: unknown, secret: string | undefined): ProviderRequestError {
  const message = redactSecret(sanitizeMessage(cause), secret)
  if (cause instanceof Anthropic.RateLimitError) {
    return new ProviderRequestError('RATE_LIMITED', 'The model API is rate limiting this key. Retry shortly.', true)
  }
  if (cause instanceof Anthropic.AuthenticationError) {
    // Never echo the upstream body here: it is the one response most likely to
    // contain a fragment of the credential that failed.
    return new ProviderRequestError('UPSTREAM_ERROR', 'The model API rejected this deployment’s credentials.', false)
  }
  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderRequestError('TIMEOUT', 'The model API did not respond in time.', true)
  }
  if (cause instanceof Anthropic.APIUserAbortError) {
    return new ProviderRequestError('ABORTED', 'The request was cancelled.', false)
  }
  if (cause instanceof Anthropic.APIError) {
    const status = cause.status ?? 0
    return new ProviderRequestError(
      'UPSTREAM_ERROR',
      `The model API returned ${status || 'an error'}: ${message}`,
      status >= 500,
    )
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new ProviderRequestError('ABORTED', 'The request was cancelled.', false)
  }
  return new ProviderRequestError('UPSTREAM_ERROR', message || 'The model call failed.', false)
}

export class AnthropicModelProvider implements ModelProvider {
  readonly id = 'anthropic'
  readonly model: string
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  private client: Pick<Anthropic, 'messages'> | undefined

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
    this.model = options.model ?? process.env.BRICKWRIGHT_ASSISTANT_MODEL ?? DEFAULT_MODEL
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BRICKWRIGHT_ASSISTANT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
    this.effort = options.effort ?? 'high'
    this.client = options.client
  }

  /** True when this process can actually call the model. */
  get configured(): boolean {
    return Boolean(this.client) || Boolean(this.apiKey)
  }

  /**
   * Lazily constructs the SDK client.
   *
   * Deferred so importing this module — which the route does at boot — never
   * fails on a machine without a key. A deployment missing its credential
   * should serve a clear error on the first assistant request, not refuse to
   * start and take the rest of the API down with it.
   */
  private sdk(): Pick<Anthropic, 'messages'> {
    if (this.client) return this.client
    if (!this.apiKey) {
      throw new ModelProviderUnavailableError(
        'ANTHROPIC_API_KEY is not set in the API process, so no model provider is configured. ' +
          'Set it in the environment that runs `server/index.ts`; the browser never receives it.',
      )
    }
    this.client = new Anthropic({ apiKey: this.apiKey, timeout: this.timeoutMs })
    return this.client
  }

  /**
   * One structured completion, validated against the caller's schema.
   *
   * A schema violation is retried exactly once, with the validation failure fed
   * back as a correction, and then rejected. Retrying forever would turn a
   * malformed generation into an unbounded bill, and accepting the malformed
   * value would push the problem into the caller as a shape it does not expect.
   */
  async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const client = this.sdk()
    const promptHash = `fnv1a:${hash32(stableStringify({ system: request.system, prompt: request.prompt, schema: request.schema })).toString(16)}`
    const usage = { inputTokens: 0, outputTokens: 0 }
    let correction: string | null = null
    let lastViolation = ''

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: correction ? `${request.prompt}\n\n${correction}` : request.prompt },
      ]

      let response: Anthropic.Message
      try {
        response = await client.messages.create(
          {
            model: this.model,
            max_tokens: request.maxTokens ?? 4096,
            system: request.system,
            messages,
            output_config: {
              effort: this.effort,
              format: { type: 'json_schema', schema: pruneToSupportedSchema(request.schema) as Record<string, unknown> },
            },
            ...(request.temperature !== undefined && !SAMPLING_REJECTING.test(this.model)
              ? { temperature: request.temperature }
              : {}),
          },
          { signal: request.signal },
        )
      } catch (cause) {
        throw classifyUpstream(cause, this.apiKey)
      }

      usage.inputTokens += response.usage.input_tokens
      usage.outputTokens += response.usage.output_tokens

      if (response.stop_reason === 'refusal') {
        throw new ProviderRequestError(
          'UPSTREAM_ERROR',
          `The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}.`,
          false,
        )
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      try {
        const value = request.parse(JSON.parse(text) as unknown)
        return {
          value,
          provenance: {
            provider: this.id,
            model: this.model,
            promptHash,
            seed: hash32(promptHash),
            createdAt: new Date().toISOString(),
          },
          usage,
        }
      } catch (cause) {
        lastViolation = sanitizeMessage(cause)
        correction =
          'Your previous reply did not satisfy the required JSON schema. ' +
          `The validator reported: ${lastViolation}. ` +
          'Reply again with JSON that satisfies the schema exactly. Output nothing but the JSON object.'
      }
    }

    throw new ProviderRequestError(
      'SCHEMA_VIOLATION',
      `The model produced output that did not satisfy the requested schema after one correction. Last validation failure: ${lastViolation}`,
      false,
    )
  }

  /**
   * One streaming conversational leg.
   *
   * Returns the SDK stream rather than consuming it, so the route can relay
   * deltas the moment they arrive instead of buffering a whole turn — which is
   * the entire point of streaming a design conversation.
   */
  streamChat(params: {
    system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
    messages: Anthropic.MessageParam[]
    tools: Anthropic.Tool[]
    maxTokens: number
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    signal?: AbortSignal
  }) {
    const client = this.sdk()
    return client.messages.stream(
      {
        model: this.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: params.messages,
        ...(params.tools.length ? { tools: params.tools } : {}),
        // Adaptive is the only on-mode for the Sonnet 5 / 4.6+ family, and the
        // raw chain of thought is never relayed to the browser: the workbench
        // shows what the model did, not a narration of how it decided.
        thinking: { type: 'adaptive' },
        output_config: { effort: params.effort ?? this.effort },
      },
      { signal: params.signal },
    )
  }
}
