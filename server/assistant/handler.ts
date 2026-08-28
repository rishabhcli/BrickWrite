import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { ModelProviderUnavailableError } from '../../src/platform/contracts.ts'
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
 *   3. A cancelled request cancels the upstream call. A browser that navigates
 *      away must not leave a paid generation running.
 */

export interface AssistantRouteOptions {
  provider?: AnthropicModelProvider
  maxToolTurns?: number
  timeoutMs?: number
  maxOutputTokens?: number
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(response: ServerResponse, status: number, body: unknown) {
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

/** Reads the body with a hard byte ceiling, destroying the socket past it. */
async function readBody(request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'BAD_REQUEST' }> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return { ok: false, code: 'PAYLOAD_TOO_LARGE' }

  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      total += buffer.length
      if (total > MAX_REQUEST_BYTES) {
        request.destroy()
        return { ok: false, code: 'PAYLOAD_TOO_LARGE' }
      }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, code: 'BAD_REQUEST' }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
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
      content: message.results.map(
        (result): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          ...(result.ok ? {} : { is_error: true }),
        }),
      ),
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
  if (expected === 'array' && !Array.isArray(value)) throw new Error('Expected a JSON array at the root of the response.')
}

export function createAssistantRoute(options: AssistantRouteOptions = {}) {
  const provider = options.provider ?? new AnthropicModelProvider()
  const maxToolTurns = options.maxToolTurns ?? Number(process.env.BRICKWRIGHT_ASSISTANT_MAX_TOOL_TURNS ?? DEFAULT_MAX_TOOL_TURNS)
  const timeoutMs = options.timeoutMs ?? Number(process.env.BRICKWRIGHT_ASSISTANT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const maxOutputTokens = options.maxOutputTokens ?? Number(process.env.BRICKWRIGHT_ASSISTANT_MAX_TOKENS ?? 8192)

  /**
   * Binds a request's lifetime to an AbortController.
   *
   * Both halves matter: the timeout stops a generation that has stopped making
   * progress, and the close listener stops one whose reader has gone away.
   */
  function lifetime(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController()
    let reason: 'timeout' | 'client' | null = null
    const timer = setTimeout(() => {
      reason = 'timeout'
      controller.abort()
    }, timeoutMs)
    const onClose = () => {
      if (controller.signal.aborted) return
      reason = 'client'
      controller.abort()
    }
    request.on('aborted', onClose)
    response.on('close', onClose)
    return {
      signal: controller.signal,
      get reason() {
        return reason
      },
      dispose() {
        clearTimeout(timer)
        request.off('aborted', onClose)
        response.off('close', onClose)
      },
    }
  }

  async function handleChat(request: IncomingMessage, response: ServerResponse, body: ChatRequest) {
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

    const span = lifetime(request, response)
    const requestId = randomUUID()
    response.writeHead(200, {
      'content-type': NDJSON_CONTENT_TYPE,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const emit = (event: AssistantEvent) => {
      if (response.writableEnded) return
      response.write(`${JSON.stringify(event)}\n`)
    }

    emit({ type: 'start', requestId, model: provider.model, toolTurn: used, maxToolTurns: budget })

    try {
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

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
          emit({ type: 'text', text: event.delta.text })
        }
      }

      const message = await stream.finalMessage()

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
        ...(message.usage.cache_read_input_tokens ? { cacheReadInputTokens: message.usage.cache_read_input_tokens } : {}),
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
        span.dispose()
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
      span.dispose()
      if (!response.writableEnded) response.end()
    }
  }

  async function handleStructured(request: IncomingMessage, response: ServerResponse, body: StructuredRequest) {
    if (!provider.configured) {
      sendError(
        response,
        503,
        'MODEL_PROVIDER_UNAVAILABLE',
        'No model provider is configured on the server. ANTHROPIC_API_KEY is not set in the API process.',
      )
      return
    }
    const span = lifetime(request, response)
    try {
      const result = await provider.complete({
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
      })
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
      const error = cause instanceof ProviderRequestError ? cause : classifyUpstream(cause, process.env.ANTHROPIC_API_KEY)
      const code: AssistantErrorCode = span.reason === 'timeout' ? 'TIMEOUT' : error.code
      const status = code === 'RATE_LIMITED' ? 429 : code === 'TIMEOUT' ? 504 : code === 'SCHEMA_VIOLATION' ? 422 : 502
      sendError(response, status, code, error.message)
    } finally {
      span.dispose()
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
        response.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'Use POST.', retryable: false } }))
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

      const body = await readBody(request)
      if (!body.ok) {
        sendError(
          response,
          body.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
          body.code,
          body.code === 'PAYLOAD_TOO_LARGE'
            ? `The request body exceeds the ${Math.round(MAX_REQUEST_BYTES / 1024 / 1024)} MB ceiling.`
            : 'The request body could not be read.',
        )
        return true
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(body.text)
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

      if (request_.data.kind === 'chat') await handleChat(request, response, request_.data)
      else await handleStructured(request, response, request_.data)
      return true
    },
  }
}
