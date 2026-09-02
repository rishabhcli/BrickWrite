import { hexclaveAuthorizationHeader, readNdjsonLines, type AuthorizationHeaderSource } from '../platform'
import {
  ModelProviderUnavailableError,
  hash32,
  awaitWithAbort,
  deadlineSignal,
  readResponseJson,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from '../platform/contracts'
import {
  ASSISTANT_ENDPOINT,
  ASSISTANT_PROTOCOL,
  GATE_REFUSALS,
  isAssistantEvent,
  type AssistantErrorCode,
  type AssistantEvent,
  type ChatRequest,
  type StructuredResponseBody,
} from './protocol'

/**
 * The browser's client for the assistant API.
 *
 * It holds no credential and cannot be made to. Everything it knows about the
 * model is a URL and a protocol version; the key, the system prompt, the tool
 * budget and the vendor SDK all live in the API process. That separation is the
 * only durable guarantee that a key never reaches a bundle — a rule enforced by
 * convention would survive exactly until someone imported the wrong module.
 */

export interface AssistantClientOptions {
  endpoint?: string
  /** Injected in tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch
  /** Injected in tests; production asks the configured Hexclave client. */
  authorizationHeader?: AuthorizationHeaderSource
  /** Complete HTTP exchange, including credential lookup and stream consumption. */
  timeoutMs?: number
}

export class AssistantTransportError extends Error {
  constructor(
    readonly code: AssistantErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'AssistantTransportError'
  }
}

export interface StreamHandlers {
  onStart?: (event: Extract<AssistantEvent, { type: 'start' }>) => void
  onText?: (text: string) => void
  onToolCall?: (call: Extract<AssistantEvent, { type: 'tool_call' }>['call']) => void
  onTurn?: (raw: unknown[]) => void
  onUsage?: (usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }) => void
  onDone?: (stop: Extract<AssistantEvent, { type: 'done' }>['stop']) => void
  onError?: (error: { code: AssistantErrorCode; message: string; retryable: boolean }) => void
}

export interface AgentModelTransport {
  readonly id: string
  stream(request: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<void>
}

/** Reads an NDJSON body, dispatching each complete line as an event. */
async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let started = false
  let complete = false
  let failed = false
  let hasTurn = false
  const calls = new Set<string>()
  const pending: AssistantEvent[] = []
  await readNdjsonLines(
    body,
    (rawLine) => {
      const line = rawLine.trim()
      if (!line) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('The assistant stream produced a malformed JSON frame.')
      }
      if (!isAssistantEvent(parsed)) throw new Error('The assistant stream produced an invalid event.')
      if (parsed.type === 'start') {
        if (started) throw new Error('The assistant stream restarted mid-turn.')
        started = true
      } else if (!started) throw new Error('The assistant stream omitted its start event.')
      if (parsed.type === 'tool_call') {
        if (calls.has(parsed.call.id) || calls.size >= 16)
          throw new Error('The assistant stream contains duplicate or excessive tool calls.')
        calls.add(parsed.call.id)
      }
      if (parsed.type === 'turn') {
        if (hasTurn) throw new Error('The assistant stream contains multiple turn payloads.')
        hasTurn = true
      }
      if (parsed.type === 'error') failed = true
      if (parsed.type === 'done') {
        if (parsed.stop === 'tool_use' && calls.size === 0)
          throw new Error('The assistant requested tools but supplied no complete tool call.')
        if (parsed.stop === 'end_turn' && calls.size > 0)
          throw new Error('The assistant supplied tools without a tool-use completion.')
        complete = true
        // Partial text is displayable. Executable calls and the raw transcript
        // are released only after a valid, successful completion frame.
        if (!failed && (parsed.stop === 'tool_use' || parsed.stop === 'end_turn')) {
          for (const event of pending) onEvent(event)
        }
      }
      if (parsed.type === 'tool_call' || parsed.type === 'turn') pending.push(parsed)
      else onEvent(parsed)
    },
    { signal, stopWhen: () => complete },
  )
  if (!complete)
    throw new Error('The assistant stream closed before its completion event. The partial reply was not accepted.')
}

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ code: AssistantErrorCode; message: string; retryable: boolean }> {
  try {
    const body = (await readResponseJson(response, signal)) as StructuredResponseBody & {
      error?: StructuredResponseBody['error'] | string
      detail?: string
    }
    if (body?.error && typeof body.error === 'object') return body.error
    // A refusal from in front of the route: the edge, the session check, the
    // in-flight ceiling or the spend meter. Its `detail` is the only place the
    // reason exists, so it becomes the message rather than being discarded for
    // a status code.
    if (typeof body?.error === 'string') {
      const known = GATE_REFUSALS[body.error]
      if (known) {
        return {
          code: known.code,
          message: body.detail ?? `The assistant API refused this request (${body.error}).`,
          retryable: known.retryable,
        }
      }
    }
    if (response.status === 401) {
      return { code: 'AUTH_REQUIRED', message: body.detail ?? 'Sign in to use model-backed tools.', retryable: false }
    }
    if (response.status === 403) {
      return {
        code: 'ACCOUNT_RESTRICTED',
        message: body.detail ?? 'Complete the required account checks first.',
        retryable: false,
      }
    }
  } catch {
    // fall through to a status-derived message
  }
  return {
    code: response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'UPSTREAM_ERROR' : 'BAD_REQUEST',
    message: `The assistant API returned ${response.status}.`,
    retryable: response.status === 429 || response.status >= 500,
  }
}

export function createAssistantTransport(options: AssistantClientOptions = {}): AgentModelTransport {
  const endpoint = options.endpoint ?? ASSISTANT_ENDPOINT
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  // A supplied fetch is a test/host seam and must not unexpectedly reach the
  // ambient account service. Hosts that need both provide both explicitly.
  const authorizationHeader =
    options.authorizationHeader ?? (options.fetchImpl ? async () => null : hexclaveAuthorizationHeader)

  return {
    id: 'http',
    async stream(request, handlers, signal) {
      const lifetime = deadlineSignal(options.timeoutMs ?? 180_000, signal)
      let terminal = false
      let failed = false
      const finish = (stop: Extract<AssistantEvent, { type: 'done' }>['stop']) => {
        if (terminal) return
        terminal = true
        handlers.onDone?.(stop)
      }
      const fail = (error: { code: AssistantErrorCode; message: string; retryable: boolean }) => {
        if (failed) return
        failed = true
        handlers.onError?.(error)
      }
      try {
        let response: Response
        try {
          lifetime.signal.throwIfAborted()
          const authorization = await awaitWithAbort(authorizationHeader(), lifetime.signal)
          lifetime.signal.throwIfAborted()
          response = await awaitWithAbort(
            doFetch(endpoint, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(authorization ? { authorization } : {}),
              },
              body: JSON.stringify(request),
              signal: lifetime.signal,
            }),
            lifetime.signal,
          )
        } catch (cause) {
          if (signal?.aborted) {
            finish('aborted')
            return
          }
          if (lifetime.signal.aborted) {
            fail({ code: 'TIMEOUT', message: 'The assistant request timed out.', retryable: true })
            finish('error')
            return
          }
          throw new AssistantTransportError(
            'UPSTREAM_ERROR',
            `The assistant API is unreachable: ${String((cause as Error).message ?? cause)}`,
            true,
          )
        }

        if (!response.ok || !response.body) {
          const error = await awaitWithAbort(readErrorBody(response, lifetime.signal), lifetime.signal)
          fail(error)
          finish('error')
          return
        }

        try {
          await readNdjson(
            response.body,
            (event) => {
              switch (event.type) {
                case 'start':
                  handlers.onStart?.(event)
                  break
                case 'text':
                  handlers.onText?.(event.text)
                  break
                case 'tool_call':
                  handlers.onToolCall?.(event.call)
                  break
                case 'turn':
                  handlers.onTurn?.(event.raw)
                  break
                case 'usage':
                  handlers.onUsage?.(event)
                  break
                case 'error':
                  fail(event)
                  break
                case 'done':
                  if (['error', 'max_tokens', 'refusal'].includes(event.stop) && !failed) {
                    fail({
                      code: 'UPSTREAM_ERROR',
                      message: `The assistant ended with ${event.stop}.`,
                      retryable: event.stop !== 'refusal',
                    })
                  }
                  finish(failed ? 'error' : event.stop)
                  break
              }
            },
            lifetime.signal,
          )
        } catch (cause) {
          if (signal?.aborted) {
            finish('aborted')
            return
          }
          fail({
            code: lifetime.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR',
            message: lifetime.signal.aborted
              ? 'The assistant request timed out.'
              : `The assistant stream failed: ${String((cause as Error).message ?? cause)}`,
            retryable: true,
          })
          finish('error')
        }
      } catch (cause) {
        if (signal?.aborted) finish('aborted')
        else {
          fail({
            code: lifetime.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR',
            message: lifetime.signal.aborted
              ? 'The assistant request timed out.'
              : `The assistant request failed: ${String((cause as Error).message ?? cause)}`,
            retryable: true,
          })
          finish('error')
        }
      } finally {
        lifetime.dispose()
      }
    },
  }
}

/**
 * `ModelProvider` over the assistant API.
 *
 * The interface is satisfied end to end rather than approximated: the caller
 * still supplies the JSON Schema and the parse function, the parse still runs
 * here, and a violation still throws. What crosses the wire is the request; the
 * contract does not change shape because there is a process boundary in it.
 */
export class HttpModelProvider implements ModelProvider {
  readonly id = 'anthropic'
  readonly model: string
  private readonly endpoint: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AssistantClientOptions & { model?: string } = {}) {
    this.endpoint = options.endpoint ?? ASSISTANT_ENDPOINT
    this.doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    this.authorizationHeader =
      options.authorizationHeader ?? (options.fetchImpl ? async () => null : hexclaveAuthorizationHeader)
    this.timeoutMs = options.timeoutMs ?? 180_000
    // The authoritative model id comes back on every response; this is only the
    // label shown before the first call completes.
    this.model = options.model ?? 'claude-sonnet-5'
  }

  private readonly authorizationHeader: AuthorizationHeaderSource

  async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
    const lifetime = deadlineSignal(this.timeoutMs, request.signal)
    try {
      lifetime.signal.throwIfAborted()
      const authorization = await awaitWithAbort(this.authorizationHeader(), lifetime.signal)
      lifetime.signal.throwIfAborted()
      const response = await awaitWithAbort(
        this.doFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization ? { authorization } : {}),
          },
          signal: lifetime.signal,
          body: JSON.stringify({
            protocol: ASSISTANT_PROTOCOL,
            kind: 'structured',
            system: request.system,
            prompt: request.prompt,
            schema: request.schema as Record<string, unknown>,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
          }),
        }),
        lifetime.signal,
      )

      if (!response.ok) {
        const error = await awaitWithAbort(readErrorBody(response, lifetime.signal), lifetime.signal)
        if (error.code === 'MODEL_PROVIDER_UNAVAILABLE') {
          throw new ModelProviderUnavailableError(error.message)
        }
        throw new AssistantTransportError(error.code, error.message, error.retryable)
      }

      const body = (await readResponseJson(response, lifetime.signal)) as StructuredResponseBody
      if (!body.ok || body.value === undefined) {
        const error = body.error ?? {
          code: 'UPSTREAM_ERROR' as const,
          message: 'The assistant API returned no value.',
          retryable: false,
        }
        throw new AssistantTransportError(error.code, error.message, error.retryable)
      }

      // The caller's parse is the authority. The API process runs a shallow shape
      // check so it can spend a free retry on an obviously wrong reply; this is
      // where a subtle violation is caught, and it throws rather than coercing.
      const value = request.parse(body.value)
      return {
        value,
        provenance: body.provenance ?? {
          provider: 'anthropic',
          model: this.model,
          promptHash: `fnv1a:${hash32(request.prompt).toString(16)}`,
          seed: hash32(request.prompt),
          createdAt: new Date().toISOString(),
        },
        usage: body.usage ?? { inputTokens: 0, outputTokens: 0 },
      }
    } catch (cause) {
      if (!request.signal?.aborted && lifetime.signal.aborted) {
        throw new AssistantTransportError('TIMEOUT', 'The assistant request timed out.', true)
      }
      throw cause
    } finally {
      lifetime.dispose()
    }
  }
}

export interface AssistantHealth {
  ok: boolean
  protocol: string
  model: string
  /** Whether the API process has a credential. Never the credential itself. */
  configured: boolean
  maxToolTurns: number
}

/** Asks the API process whether it can actually reach a model. */
export async function assistantHealth(options: AssistantClientOptions = {}): Promise<AssistantHealth | null> {
  const endpoint = `${options.endpoint ?? ASSISTANT_ENDPOINT}/health`
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  try {
    const response = await doFetch(endpoint, { method: 'GET' })
    if (!response.ok) return null
    return (await response.json()) as AssistantHealth
  } catch {
    return null
  }
}
