import Anthropic from '@anthropic-ai/sdk'
import { boundedTimeout } from '../http/lifecycle.js'
import { ModelProviderUnavailableError, hash32, awaitWithAbort, type Provenance } from '../../src/platform/contracts.js'
import { kindForSchema, validatePayload, type PayloadKind } from './schema.js'

/**
 * The only place in the repository that reads the model credential.
 *
 * It runs in the API process, never in Vite's module graph, because a key that
 * reaches a browser bundle is a published key and no amount of care at the call
 * site changes that. Nothing under `src/` imports this file; the browser talks
 * to the route in `index.ts` over HTTP.
 *
 * Three behaviours here are load-bearing rather than incidental:
 *
 *   - **No credential is a distinct outcome.** Absent `ANTHROPIC_API_KEY` this
 *     raises `ModelProviderUnavailableError` and the route answers 503 with a
 *     stable code, so the client can say "generation is not configured" instead
 *     of showing a generic failure or, worse, inventing a result.
 *   - **The answer is validated, then retried once, then refused.** A response
 *     that does not satisfy the schema is never partially salvaged.
 *   - **Errors are sanitised on the way out.** The client gets a code and a
 *     sentence; the process log keeps the rest. Any string that looks like a key
 *     is redacted on the way through, which costs nothing and removes a whole
 *     class of accident.
 */

/**
 * Default model.
 *
 * Sonnet 5 is the right tier for this workload: the task is a bounded,
 * schema-constrained decomposition rather than open-ended reasoning, and it sits
 * on the request path of an interactive editor where latency is part of the
 * product. Override with `BRICKWRIGHT_GENERATION_MODEL`.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5'

const DEFAULT_MAX_TOKENS = 4000
const DEFAULT_TIMEOUT_MS = 120_000

/** Redacts anything shaped like an Anthropic key from a string bound for a client. */
export const redact = (text: string): string =>
  text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***').replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')

export interface CompletionRequest {
  readonly system: string
  readonly prompt: string
  readonly schema: unknown
  readonly maxTokens?: number
  readonly signal?: AbortSignal
  /** Called with each stage so the route can stream progress. */
  readonly onProgress?: (stage: string) => void
}

export interface CompletionResult {
  readonly value: unknown
  readonly provenance: Provenance
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    /** `cache_creation_input_tokens`; excluded from `inputTokens` by the provider. */
    readonly cacheWriteTokens: number
    /** `cache_read_input_tokens`; excluded from `inputTokens` by the provider. */
    readonly cacheReadTokens: number
  }
  /** Model calls made. 2 means the first answer failed validation. */
  readonly attempts: number
}

export class SchemaViolationError extends Error {
  // Declared and assigned rather than written as a constructor parameter
  // property: this file is executed by Node's strip-only TypeScript loader,
  // which rejects parameter properties outright because erasing one changes
  // runtime behaviour rather than just removing a type.
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`The model's answer did not satisfy the schema: ${problems.join('; ')}`)
    this.name = 'SchemaViolationError'
    this.problems = problems
  }
}

export interface ProviderConfig {
  readonly apiKey?: string | undefined
  readonly model?: string
  readonly timeoutMs?: number
  /** Injected by tests. Real callers leave it out and get the SDK. */
  readonly client?: MessagesLike
}

/** The one SDK method this provider uses, narrowed so a test can supply it. */
export interface MessagesLike {
  create(body: unknown, options?: unknown): Promise<unknown>
}

/**
 * Reads configuration from the environment.
 *
 * Kept separate from the client so a test can construct a provider without the
 * process environment deciding whether the suite passes.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.BRICKWRIGHT_GENERATION_MODEL ?? DEFAULT_MODEL,
    timeoutMs: boundedTimeout(env.BRICKWRIGHT_GENERATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  }
}

export class AnthropicGenerationProvider {
  readonly id = 'anthropic'
  readonly model: string
  private readonly messages: MessagesLike
  private readonly timeoutMs: number

  constructor(config: ProviderConfig) {
    this.model = config.model ?? DEFAULT_MODEL
    this.timeoutMs = boundedTimeout(config.timeoutMs, DEFAULT_TIMEOUT_MS)
    if (config.client) {
      this.messages = config.client
      return
    }
    const apiKey = config.apiKey?.trim()
    if (!apiKey) {
      throw new ModelProviderUnavailableError(
        'ANTHROPIC_API_KEY is not set in the API process, so generation cannot reach a model. ' +
          'Set it in the environment that runs `npm run serve:api`.',
      )
    }
    this.messages = new Anthropic({ apiKey, timeout: this.timeoutMs, maxRetries: 1 }).messages as MessagesLike
  }

  /**
   * One structured completion, validated, with one corrective retry.
   *
   * The retry is *corrective* rather than a blind repeat: the failing answer and
   * the validator's complaints go back as another turn, which is the difference
   * between asking again and asking better. Two attempts is the ceiling — a
   * model that has failed a schema twice will not be talked into it, and an
   * unbounded loop on the request path of an editor is a denial of service with
   * extra steps.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const kind = kindForSchema(request.schema)
    if (!kind) {
      throw new SchemaViolationError([
        'the supplied JSON Schema names none of boxes, features or subject, so the server has no validator for it',
      ])
    }

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: request.prompt }]
    let inputTokens = 0
    let outputTokens = 0
    let cacheWriteTokens = 0
    let cacheReadTokens = 0
    let problems: string[] = []

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      request.signal?.throwIfAborted()
      request.onProgress?.(attempt === 1 ? 'calling model' : 'retrying after a schema violation')
      const message = await this.call(request, history)
      // All four classes. The system block carries a cache breakpoint, so the
      // corrective second attempt reads its prefix back instead of re-sending
      // it, and `input_tokens` alone would report that attempt as nearly free.
      inputTokens += message.usage?.input_tokens ?? 0
      outputTokens += message.usage?.output_tokens ?? 0
      cacheWriteTokens += message.usage?.cache_creation_input_tokens ?? 0
      cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0

      if (message.stop_reason === 'refusal') {
        throw new SchemaViolationError([
          `the model declined this request (${message.stop_details?.category ?? 'unspecified'})`,
        ])
      }

      const text = (message.content ?? [])
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('')

      const outcome = parseAndValidate(kind, text)
      if (outcome.ok) {
        return {
          value: outcome.value,
          provenance: {
            provider: this.id,
            model: this.model,
            promptHash: hash32(`${request.system} ${request.prompt}`).toString(16).padStart(8, '0'),
            seed: 0,
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens },
          attempts: attempt,
        }
      }

      problems = outcome.problems ?? ['the answer was not valid JSON']
      history.push({ role: 'assistant', content: text || '(empty)' })
      history.push({
        role: 'user',
        content: [
          'That response did not satisfy the schema:',
          ...problems.map((problem) => `- ${problem}`),
          'Reply again with JSON that satisfies the schema exactly. Do not add commentary.',
        ].join('\n'),
      })
    }

    throw new SchemaViolationError(problems)
  }

  private async call(
    request: CompletionRequest,
    history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<AnthropicMessageShape> {
    request.signal?.throwIfAborted()
    const body = {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' as const } }],
      messages: history,
      // The schema is enforced by the API as well as validated here. `effort:
      // low` suits a bounded decomposition and keeps an interactive request
      // interactive. There is deliberately no `temperature`: sampling parameters
      // are rejected outright by this model family, and reproducibility in this
      // pipeline comes from the seeded kernel rather than from asking a model to
      // repeat itself.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: request.schema as Record<string, unknown> },
      },
    }
    const options = {
      ...(request.signal ? { signal: request.signal } : {}),
      timeout: this.timeoutMs,
    }
    return (await awaitWithAbort(this.messages.create(body, options), request.signal)) as AnthropicMessageShape
  }
}

/** The response fields this provider reads. */
interface AnthropicMessageShape {
  readonly content?: ReadonlyArray<{ type: string; text?: string }>
  readonly usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  readonly stop_reason?: string | null
  readonly stop_details?: { category?: string | null } | null
}

function parseAndValidate(kind: PayloadKind, text: string): { ok: boolean; value?: unknown; problems?: string[] } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, problems: ['the model returned no text'] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Structured output should make this impossible; it is checked because
    // "should" is not a guarantee anyone can act on.
    return { ok: false, problems: [`the answer was not JSON: ${trimmed.slice(0, 120)}`] }
  }
  return validatePayload(kind, parsed)
}
