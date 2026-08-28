import {
  ModelProviderUnavailableError,
  type DesignBrief,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type Provenance,
} from '../platform/contracts'

/**
 * The browser side of the model seam.
 *
 * There is exactly one reason this file exists rather than the SDK being called
 * from the app: an API key that reaches the client bundle is a published key,
 * and no amount of care in the calling code changes that. So the client speaks
 * HTTP to `server/generation`, which holds the credential in a different
 * process, and nothing under `src/` imports anything under `server/`.
 *
 * The wire format is newline-delimited JSON rather than a single response body,
 * because a four-phase generation is a long request and a caller that cannot see
 * progress has to choose between a spinner and a timeout. Each line is one event;
 * the terminal `result` line carries the value, its provenance and the usage.
 */

export type GenerationEventName = 'accepted' | 'progress' | 'result' | 'error'

export interface GenerationWireEvent {
  readonly type: GenerationEventName
  readonly requestId?: string
  /** `progress` only: what the server is doing. */
  readonly stage?: string
  /** `result` only. */
  readonly value?: unknown
  readonly provenance?: Provenance
  readonly usage?: { inputTokens: number; outputTokens: number }
  /** `error` only: a stable machine code. */
  readonly error?: string
  readonly detail?: string
}

export interface GenerationClientOptions {
  /** Defaults to the same origin, which is what the dev proxy and the deployed function both serve. */
  readonly baseUrl?: string
  /** Injected in tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch
  /** Reported as the provider's model id until the server says otherwise. */
  readonly model?: string
  readonly onProgress?: (stage: string) => void
  /** Per-request ceiling in milliseconds. */
  readonly timeoutMs?: number
}

const DEFAULT_MODEL = 'claude-sonnet-5'
const DEFAULT_TIMEOUT_MS = 120_000

/** Server error codes that mean "no credential", not "something went wrong". */
const UNAVAILABLE_CODES = new Set(['model_provider_unavailable', 'no_api_key'])

class HttpModelProvider implements ModelProvider {
  readonly id = 'anthropic'
  model: string

  constructor(private readonly options: GenerationClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL
  }

  async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const event = await postStream(
      this.options,
      '/api/generate',
      {
        system: request.system,
        prompt: request.prompt,
        schema: request.schema,
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      request.signal,
    )

    // The schema constrains the server's request; `parse` is this side's own
    // check. Both run: a structured-output guarantee is a property of the API
    // call, and trusting it without validating locally would make a change of
    // provider a silent change of contract.
    const value = request.parse(event.value)
    if (event.provenance) this.model = event.provenance.model ?? this.model
    return {
      value,
      provenance: event.provenance ?? {
        provider: this.id,
        model: this.model,
        promptHash: '',
        seed: 0,
        createdAt: new Date().toISOString(),
      },
      usage: event.usage ?? { inputTokens: 0, outputTokens: 0 },
    }
  }
}

/** A `ModelProvider` backed by the generation route. Holds no credential. */
export const createGenerationProvider = (options: GenerationClientOptions = {}): ModelProvider =>
  new HttpModelProvider(options)

/**
 * Compiles a brief server-side.
 *
 * The same work `brief.ts` does with a provider, but in one round trip: the
 * prompt, the schema and the colour resolution all live on the server, so a
 * browser that only wants a brief does not have to ship the schema to get one.
 */
export async function compileBriefViaServer(
  text: string,
  options: GenerationClientOptions & { signal?: AbortSignal } = {},
): Promise<{ brief: DesignBrief; provenance: Provenance; usage: { inputTokens: number; outputTokens: number } }> {
  const event = await postStream(options, '/api/brief', { text }, options.signal)
  const brief = event.value as DesignBrief | undefined
  if (!brief || typeof brief !== 'object' || brief.version !== 1) {
    throw new Error('The brief route returned a payload that is not a version-1 design brief.')
  }
  return {
    brief,
    provenance: event.provenance ?? {
      provider: 'anthropic',
      model: options.model ?? DEFAULT_MODEL,
      promptHash: '',
      seed: 0,
      createdAt: new Date().toISOString(),
    },
    usage: event.usage ?? { inputTokens: 0, outputTokens: 0 },
  }
}

/**
 * Posts a request and reads the newline-delimited event stream to its terminal
 * event.
 *
 * A client abort has to reach the server, or a cancelled generation keeps
 * burning tokens after the user has moved on, so the caller's signal is passed
 * straight through to `fetch` and the request's own timeout is merged into it.
 */
async function postStream(
  options: GenerationClientOptions,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<GenerationWireEvent> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ModelProviderUnavailableError(
      'No fetch implementation is available, so the generation route cannot be reached.',
    )
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetchImpl(`${options.baseUrl ?? ''}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (cause) {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    if (signal?.aborted) throw cause
    throw new ModelProviderUnavailableError(
      `The generation route at ${options.baseUrl ?? ''}${path} could not be reached: ${describe(cause)}`,
    )
  }

  try {
    if (!response.ok && response.status !== 200) {
      const payload = await safeJson(response)
      const code = typeof payload?.error === 'string' ? payload.error : `http_${response.status}`
      const detail = typeof payload?.detail === 'string' ? payload.detail : `HTTP ${response.status}`
      if (UNAVAILABLE_CODES.has(code)) throw new ModelProviderUnavailableError(detail)
      throw new Error(`Generation request failed (${code}): ${detail}`)
    }

    const events = await readNdjson(response, options.onProgress)
    const terminal = events.at(-1)
    if (!terminal) throw new Error('The generation route closed the stream without sending a result.')
    if (terminal.type === 'error') {
      const code = terminal.error ?? 'unknown_error'
      const detail = terminal.detail ?? 'The server reported an error with no detail.'
      if (UNAVAILABLE_CODES.has(code)) throw new ModelProviderUnavailableError(detail)
      throw new Error(`Generation failed (${code}): ${detail}`)
    }
    if (terminal.type !== 'result') {
      throw new Error(`The generation route ended on a “${terminal.type}” event rather than a result.`)
    }
    return terminal
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function readNdjson(
  response: Response,
  onProgress: ((stage: string) => void) | undefined,
): Promise<GenerationWireEvent[]> {
  const events: GenerationWireEvent[] = []
  const consume = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: GenerationWireEvent
    try {
      parsed = JSON.parse(trimmed) as GenerationWireEvent
    } catch {
      // A malformed line is a protocol failure, not something to guess at.
      throw new Error(`The generation route emitted a line that is not JSON: ${trimmed.slice(0, 120)}`)
    }
    events.push(parsed)
    if (parsed.type === 'progress' && parsed.stage) onProgress?.(parsed.stage)
  }

  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    for (const line of (await response.text()).split('\n')) consume(line)
    return events
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      consume(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split('\n')) consume(line)
  return events
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error'
