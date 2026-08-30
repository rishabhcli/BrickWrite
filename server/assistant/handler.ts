import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { ModelProviderUnavailableError, awaitWithAbort } from '../../src/platform/contracts.ts'
import {
  boundedTimeout,
  ndjsonWriter,
  readRequestText,
  RequestBodyError,
  requestLifetime,
  type RequestLifetime,
} from '../http/lifecycle.ts'
import {
  ASSISTANT_PROTOCOL,
  AssistantRequestSchema,
  DEFAULT_MAX_TOOL_TURNS,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  NDJSON_CONTENT_TYPE,
  RETRYABLE_CODES,
  type AssistantErrorCode,
  type AssistantEvent,
  type ChatRequest,
  type StructuredRequest,
  type WireMessage,
} from './protocol.ts'
import { AnthropicModelProvider, ProviderRequestError, classifyUpstream } from './provider.ts'
import { SYSTEM_PROMPT, groundingBlock } from './prompt.ts'
import { anthropicTools } from './tools.ts'
import { sanitizeMessage } from './sanitize.ts'

/**
 * The `/api/assistant` route.
 *
 * Three properties this file exists to guarantee:
 *
 *   1. The key never leaves the process. Every outbound string passes through
 *      `sanitizeMessage`, and upstream authentication failures are reported as
 *      a category rather than relayed.
 *   2. Nothing is unbounded. Request bytes, transcript length, tool turns,
 *      output tokens and wall-clock time all have ceilings, and each one is
 *      reported by name when it is hit.
 *   3. Cancellation is forwarded to the upstream SDK. Even if the provider
 *      ignores it, the handler stops waiting and starts no corrective calls.
 */

export interface AssistantRouteOptions {
  provider?: AnthropicModelProvider
  maxToolTurns?: number
  timeoutMs?: number
  maxOutputTokens?: number
  heartbeatMs?: number
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, jsonHeaders)
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, status: number, code: AssistantErrorCode, message: string) {
  sendJson(response, status, {
    ok: false,
    error: { code, message: sanitizeMessage(message), retryable: RETRYABLE_CODES.has(code) },
  })
}

/**
 * Translates the normalized transcript into API messages.
 *
 * The browser never learns the model vendor's block vocabulary — it sends text,
 * tool calls and tool results, and gets the same back. The one exception is the
 * opaque `raw` block list, which is replayed verbatim because an assistant turn
 * that produced thinking and tool use cannot be faithfully reconstructed from
 * its rendered text.
 */
export function toApiMessages(messages: readonly WireMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const content: Anthropic.ContentBlockParam[] = []
      for (const image of message.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 } })
      }
      if (message.text.trim()) content.push({ type: 'text', text: message.text })
      if (!content.length) continue
      out.push({ role: 'user', content })
      continue
    }

    if (message.role === 'assistant') {
      if (message.raw?.length) {
        out.push({ role: 'assistant', content: message.raw as Anthropic.ContentBlockParam[] })
        continue
      }
      const content: Anthropic.ContentBlockParam[] = []
      if (message.text.trim()) content.push({ type: 'text', text: message.text })
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      // An assistant turn with nothing in it is not a turn; replaying one would
      // be rejected by the API and tells the model nothing.
      if (!content.length) continue
      out.push({ role: 'assistant', content })
      continue
    }

    out.push({
      role: 'user',
      content: message.results.map((result): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.content,
        ...(result.ok ? {} : { is_error: true }),
      })),
    })
  }
  return out
}

/** Tool turns already spent in this conversation. */
export function toolTurnsUsed(messages: readonly WireMessage[]): number {
  return messages.filter((message) => message.role === 'tool').length
}

/**
 * A shallow check that a structured value has the shape the schema requires.
 *
 * The authoritative validation is the caller's Zod parse — the `ModelProvider`
 * contract puts it there deliberately, and this process has no JSON Schema
 * validator. What it can do without one is catch the common failure worth a
 * free retry: a response missing a required key or returning the wrong root
 * type. Anything subtler is caught by the caller and reported, not hidden.
 */
export function structuralCheck(value: unknown, schema: Record<string, unknown>): void {
  const expected = schema.type
  if (expected === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Expected a JSON object at the root of the response.')
    }
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const missing = required.filter((key) => !(key in (value as Record<string, unknown>)))
    if (missing.length) throw new Error(`Response is missing required field(s): ${missing.join(', ')}.`)
    return
  }
  if (expected === 'array' && !Array.isArray(value))
    throw new Error('Expected a JSON array at the root of the response.')
}

export function createAssistantRoute(options: AssistantRouteOptions = {}) {
  const provider = options.provider ?? new AnthropicModelProvider()
  const maxToolTurns =
    options.maxToolTurns ?? Number(process.env.BRICKWRIGHT_ASSISTANT_MAX_TOOL_TURNS ?? DEFAULT_MAX_TOOL_TURNS)
  const timeoutMs = boundedTimeout(
    options.timeoutMs ?? process.env.BRICKWRIGHT_ASSISTANT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  )
  const maxOutputTokens = options.maxOutputTokens ?? Number(process.env.BRICKWRIGHT_ASSISTANT_MAX_TOKENS ?? 8192)

  async function handleChat(response: ServerResponse, body: ChatRequest, span: RequestLifetime) {
    if (body.messages[0]?.role !== 'user') {
      sendError(response, 400, 'BAD_REQUEST', 'A conversation must open with a user message.')
      return
    }

    const used = toolTurnsUsed(body.messages)
    const budget = Math.min(body.maxToolTurns ?? maxToolTurns, maxToolTurns)
    if (used >= budget) {
      sendError(
        response,
        409,
        'TOOL_TURN_LIMIT',
        `This conversation has already used ${used} of ${budget} tool turns. Start a new request or accept the waves proposed so far.`,
      )
      return
    }

    if (!provider.configured) {
      sendError(
        response,
        503,
        'MODEL_PROVIDER_UNAVAILABLE',
        'No model provider is configured on the server. ANTHROPIC_API_KEY is not set in the API process.',
      )
      return
    }

    const requestId = randomUUID()
    response.writeHead(200, {
      'content-type': NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const writer = ndjsonWriter(response, span.signal, options.heartbeatMs)
    const emit = (event: AssistantEvent) => writer.write(event)

    emit({ type: 'start', requestId, model: provider.model, toolTurn: used, maxToolTurns: budget })

    try {
      span.signal.throwIfAborted()
      const stream = provider.streamChat({
        system: [
          // The long half is byte-identical every turn, so it stays cacheable;
          // the volatile grounding block sits after the breakpoint.
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: groundingBlock(body.grounding, body.mode) },
        ],
        messages: toApiMessages(body.messages),
        tools: anthropicTools(body.mode),
        maxTokens: maxOutputTokens,
        effort: body.effort,
        signal: span.signal,
      })

      const iterator = stream[Symbol.asyncIterator]()
      let exhausted = false
      try {
        for (;;) {
          const next = await awaitWithAbort(iterator.next(), span.signal)
          if (next.done) {
            exhausted = true
            break
          }
          const event = next.value
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            emit({ type: 'text', text: event.delta.text })
          }
        }
      } finally {
        // Preserve for-await's cleanup, but an uncooperative iterator must not
        // prevent us from reporting the deadline to the client.
        if (!exhausted) void iterator.return?.().catch(() => {})
      }

      const message = await awaitWithAbort(stream.finalMessage(), span.signal)

      emit({ type: 'turn', raw: message.content as unknown[] })
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        emit({
          type: 'tool_call',
          call: { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> },
        })
      }
      emit({
        type: 'usage',
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        ...(message.usage.cache_read_input_tokens
          ? { cacheReadInputTokens: message.usage.cache_read_input_tokens }
          : {}),
      })

      const stop =
        message.stop_reason === 'tool_use'
          ? 'tool_use'
          : message.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : message.stop_reason === 'refusal'
              ? 'refusal'
              : 'end_turn'

      if (stop === 'max_tokens') {
        emit({
          type: 'error',
          code: 'UPSTREAM_ERROR',
          message: `The reply hit the ${maxOutputTokens}-token ceiling and was cut off. Ask for a narrower change.`,
          retryable: true,
        })
      }
      if (stop === 'refusal') {
        emit({
          type: 'error',
          code: 'UPSTREAM_ERROR',
          message: 'The model declined this request.',
          retryable: false,
        })
      }
      emit({ type: 'done', stop })
    } catch (cause) {
      if (span.reason === 'client') {
        // The reader is gone; there is nobody to tell. Close quietly rather
        // than writing to a dead socket.
        response.end()
        return
      }
      const error =
        cause instanceof ProviderRequestError
          ? cause
          : cause instanceof ModelProviderUnavailableError
            ? new ProviderRequestError('UPSTREAM_ERROR', cause.message, false)
            : classifyUpstream(cause, process.env.ANTHROPIC_API_KEY)
      const code: AssistantErrorCode = span.reason === 'timeout' ? 'TIMEOUT' : error.code
      emit({
        type: 'error',
        code,
        message:
          code === 'TIMEOUT'
            ? `The model did not finish within ${Math.round(timeoutMs / 1000)}s and the request was cancelled.`
            : sanitizeMessage(error.message),
        retryable: code === 'TIMEOUT' ? true : error.retryable,
      })
      emit({ type: 'done', stop: 'error' })
    } finally {
      writer.close()
      if (!response.writableEnded) response.end()
    }
  }

  async function handleStructured(response: ServerResponse, body: StructuredRequest, span: RequestLifetime) {
    if (!provider.configured) {
      sendError(
        response,
        503,
        'MODEL_PROVIDER_UNAVAILABLE',
        'No model provider is configured on the server. ANTHROPIC_API_KEY is not set in the API process.',
      )
      return
    }
    try {
      span.signal.throwIfAborted()
      const result = await awaitWithAbort(
        provider.complete({
          system: body.system,
          prompt: body.prompt,
          schema: body.schema,
          parse: (raw) => {
            structuralCheck(raw, body.schema)
            return raw
          },
          signal: span.signal,
          maxTokens: body.maxTokens,
          temperature: body.temperature,
        }),
        span.signal,
      )
      sendJson(response, 200, { ok: true, value: result.value, provenance: result.provenance, usage: result.usage })
    } catch (cause) {
      if (span.reason === 'client') {
        response.end()
        return
      }
      if (cause instanceof ModelProviderUnavailableError) {
        sendError(response, 503, 'MODEL_PROVIDER_UNAVAILABLE', cause.message)
        return
      }
      const error =
        cause instanceof ProviderRequestError ? cause : classifyUpstream(cause, process.env.ANTHROPIC_API_KEY)
      const code: AssistantErrorCode = span.reason === 'timeout' ? 'TIMEOUT' : error.code
      const status = code === 'RATE_LIMITED' ? 429 : code === 'TIMEOUT' ? 504 : code === 'SCHEMA_VIOLATION' ? 422 : 502
      sendError(
        response,
        status,
        code,
        code === 'TIMEOUT' ? 'The assistant exceeded its request deadline and was cancelled.' : error.message,
      )
    }
  }

  return {
    prefix: '/api/assistant',
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === '/api/assistant/health') {
        sendJson(response, 200, {
          ok: true,
          protocol: ASSISTANT_PROTOCOL,
          model: provider.model,
          // Whether a key exists — never the key, never its length or prefix.
          configured: provider.configured,
          maxToolTurns,
          timeoutMs,
        })
        return true
      }

      if (url.pathname !== '/api/assistant') return false

      if (request.method !== 'POST') {
        response.writeHead(405, { ...jsonHeaders, allow: 'POST' })
        response.end(
          JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'Use POST.', retryable: false } }),
        )
        return true
      }

      // Requiring JSON also closes the browser's "simple request" path. A
      // hostile page can submit text/plain to localhost without a CORS
      // preflight; it cannot submit application/json unless this server opts in
      // to that origin, which it deliberately never does.
      const mediaType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        sendError(response, 415, 'BAD_REQUEST', 'Use Content-Type: application/json.')
        return true
      }

      const span = requestLifetime(request, response, timeoutMs)
      try {
        let text: string
        try {
          text = await readRequestText(request, span.signal, MAX_REQUEST_BYTES)
        } catch (cause) {
          if (span.reason !== 'client') {
            response.setHeader('connection', 'close')
            const code =
              span.reason === 'timeout' ? 'TIMEOUT' : cause instanceof RequestBodyError ? cause.code : 'BAD_REQUEST'
            sendError(
              response,
              code === 'TIMEOUT' ? 408 : code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
              code,
              code === 'TIMEOUT'
                ? 'The request body did not arrive before its deadline.'
                : code === 'PAYLOAD_TOO_LARGE'
                  ? `The request body exceeds the ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB ceiling.`
                  : 'The request body could not be read.',
            )
          }
          return true
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          sendError(response, 400, 'BAD_REQUEST', 'The request body is not valid JSON.')
          return true
        }

        const request_ = AssistantRequestSchema.safeParse(parsed)
        if (!request_.success) {
          const issues = request_.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
            .join('; ')
          sendError(response, 400, 'BAD_REQUEST', `The request did not match ${ASSISTANT_PROTOCOL}: ${issues}`)
          return true
        }

        if (request_.data.kind === 'chat') await handleChat(response, request_.data, span)
        else await handleStructured(response, request_.data, span)
        return true
      } finally {
        span.dispose()
      }
    },
  }
}
