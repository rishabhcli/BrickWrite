import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ModelProviderUnavailableError, awaitWithAbort, type DesignBrief } from '../../src/platform/contracts.js'
import { boundedTimeout, ndjsonWriter, readRequestText, RequestBodyError, requestLifetime } from '../http/lifecycle.js'
import {
  AnthropicGenerationProvider,
  SchemaViolationError,
  configFromEnv,
  redact,
  type CompletionResult,
  type ProviderConfig,
} from './anthropic.js'
import { designBriefSchema } from './schema.js'

/**
 * `POST /api/generate` and `POST /api/brief`.
 *
 * Both answer with newline-delimited JSON rather than a single body. A
 * four-phase generation is a long request, and a client that cannot see progress
 * has to choose between an unexplained spinner and a timeout; one line per event
 * costs nothing and removes that choice. The last line is always terminal —
 * `result` or `error` — so a reader knows when it is done without counting.
 *
 * The route holds the credential and the browser does not. Everything that could
 * carry it outward is passed through `redact` first, error bodies included, and
 * a stack never leaves the process.
 */

export interface RouteModule {
  readonly prefix: string
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>
}

/** Ceiling on a request body. A design brief is prose, not an upload. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * The brief prompt.
 *
 * Deliberately the same instructions the browser-side compiler sends, so the two
 * routes cannot drift into disagreeing about what a brief means.
 */
const BRIEF_SYSTEM = [
  'You compile a natural-language LEGO build request into a structured design brief.',
  'Report only what the request supports. Leave a field null or empty when the request does not state it;',
  'do not fill a gap with a plausible default.',
  'For every field you populate, add an `evidence` entry naming the field and quoting the exact phrase',
  'from the request that produced it.',
  'If the request contradicts itself, record both readings in `conflicts` and do not choose between them.',
  'Colours are named in plain English; they are resolved against the LDraw colour table afterwards.',
  'The envelope is measured in studs, one stud being the horizontal brick pitch; leave all three axes null',
  'when the request states no size.',
].join(' ')

/**
 * Constrained to the subset the structured-output endpoint accepts: no array
 * length bounds, no numeric ranges, no open-ended `additionalProperties` map.
 * The value constraints live in `designBriefSchema` and are enforced after the
 * answer arrives.
 */
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'subject',
    'envelopeWidthStuds',
    'envelopeHeightStuds',
    'envelopeDepthStuds',
    'scale',
    'functions',
    'paletteColourNames',
    'symmetry',
    'partBudget',
    'style',
    'evidence',
    'conflicts',
  ],
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 120 },
    envelopeWidthStuds: { type: ['integer', 'null'] },
    envelopeHeightStuds: { type: ['integer', 'null'] },
    envelopeDepthStuds: { type: ['integer', 'null'] },
    scale: { type: 'string', enum: ['micro', 'minifig', 'midi', 'large', 'unspecified'] },
    functions: { type: 'array', items: { type: 'string', maxLength: 120 } },
    paletteColourNames: { type: 'array', items: { type: 'string', maxLength: 40 } },
    symmetry: { type: 'string', enum: ['none', 'mirror-x', 'mirror-z', 'radial'] },
    partBudget: { type: ['integer', 'null'] },
    style: { type: 'array', items: { type: 'string', maxLength: 40 } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'phrase'],
        properties: { field: { type: 'string', maxLength: 60 }, phrase: { type: 'string', maxLength: 200 } },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'detail'],
        properties: { field: { type: 'string', maxLength: 40 }, detail: { type: 'string', maxLength: 240 } },
      },
    },
  },
} as const

interface WireError {
  readonly status: number
  readonly code: string
  readonly detail: string
}

/**
 * Maps a thrown value to something a client can act on.
 *
 * Every branch produces a stable code and one sentence. Nothing here forwards a
 * stack, an SDK error body or a key, and the default branch deliberately says
 * very little: an unrecognised failure is exactly the case where the message is
 * most likely to contain something that should not leave the process.
 */
function toWireError(cause: unknown): WireError {
  if (cause instanceof ModelProviderUnavailableError) {
    return { status: 503, code: 'model_provider_unavailable', detail: redact(cause.message) }
  }
  if (cause instanceof SchemaViolationError) {
    return { status: 502, code: 'schema_violation', detail: redact(cause.message) }
  }
  const name = (cause as { name?: string } | null)?.name
  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError') {
    return { status: 504, code: 'timeout', detail: 'The model API did not respond in time.' }
  }
  if (name === 'AbortError' || (cause as { message?: string } | null)?.message === 'Request was aborted.') {
    return { status: 499, code: 'aborted', detail: 'The request was cancelled before it completed.' }
  }
  const status = (cause as { status?: number } | null)?.status
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return {
        status: 503,
        code: 'model_provider_unavailable',
        detail: 'The configured model credential was rejected.',
      }
    }
    if (status === 429) {
      return { status: 429, code: 'rate_limited', detail: 'The model API is rate limiting this key; retry shortly.' }
    }
    return { status: 502, code: 'model_error', detail: `The model API returned HTTP ${status}.` }
  }
  return { status: 500, code: 'internal_error', detail: 'Generation failed. The API process log has the detail.' }
}

class BadRequest extends Error {}

let cachedProvider: AnthropicGenerationProvider | null = null
let cachedProviderError: unknown = null

/**
 * The provider, built once.
 *
 * A missing key is cached as an *error* rather than retried per request: it is a
 * deployment fact, not a transient one, and rebuilding the client on every call
 * to rediscover it would only add latency to the failure.
 */
function provider(overrides?: ProviderConfig): AnthropicGenerationProvider {
  if (overrides) return new AnthropicGenerationProvider(overrides)
  if (cachedProvider) return cachedProvider
  if (cachedProviderError) throw cachedProviderError
  try {
    cachedProvider = new AnthropicGenerationProvider(configFromEnv())
    return cachedProvider
  } catch (cause) {
    cachedProviderError = cause
    throw cause
  }
}

/** Test seam: drops the memoised provider so the next request rebuilds it. */
export function resetProviderCache() {
  cachedProvider = null
  cachedProviderError = null
}

/**
 * LDraw colour codes for names the model used.
 *
 * Read from the compiled catalog on disk rather than from a table written here,
 * for the same reason the browser resolves against the loaded catalog: a name
 * this build cannot render is not a colour, and the honest answer is to drop it
 * and say so. When the catalog is absent the palette comes back empty with a
 * note, never guessed.
 */
async function resolvePalette(names: readonly string[]): Promise<{ palette: number[]; notes: string[] }> {
  if (!names.length) return { palette: [], notes: [] }
  const table = await colourTable()
  if (!table) {
    return {
      palette: [],
      notes: [
        `The compiled colour table is not present in this process, so ${names.length} colour name(s) were left unresolved.`,
      ],
    }
  }
  const palette: number[] = []
  const notes: string[] = []
  for (const name of names) {
    const key = normalise(name)
    const match = table.find((entry) => entry.key === key) ?? table.find((entry) => entry.key.includes(key))
    if (!match) {
      notes.push(`Colour name “${name}” is not in the LDraw colour table, so it was dropped from the palette.`)
      continue
    }
    if (!palette.includes(match.code)) palette.push(match.code)
  }
  return { palette: palette.sort((a, b) => a - b), notes }
}

const normalise = (name: string) =>
  name
    .toLowerCase()
    .replace(/gray/g, 'grey')
    .replace(/[^a-z]+/g, ' ')
    .trim()

let colourCache: Array<{ code: number; key: string }> | null | undefined

async function colourTable(): Promise<Array<{ code: number; key: string }> | null> {
  if (colourCache !== undefined) return colourCache
  try {
    const root = path.resolve(process.cwd(), 'public')
    const pointer = JSON.parse(await readFile(path.join(root, 'catalog/latest.json'), 'utf8')) as {
      manifest: { path: string }
    }
    const manifest = JSON.parse(await readFile(path.join(root, pointer.manifest.path), 'utf8')) as {
      files: { colors: { path: string } }
    }
    const colours = JSON.parse(await readFile(path.join(root, manifest.files.colors.path), 'utf8')) as Array<{
      code: number
      name: string
    }>
    colourCache = colours
      // 16 and 24 are LDraw's inherit meta-colours; a palette entry naming one
      // would tell the kernel to take its colour from a parent that does not exist.
      .filter((colour) => colour.code !== 16 && colour.code !== 24)
      .map((colour) => ({ code: colour.code, key: normalise(colour.name) }))
      .sort((a, b) => b.key.length - a.key.length || a.code - b.code)
  } catch {
    colourCache = null
  }
  return colourCache
}

export interface HandlerOptions {
  /** Injected by tests so the route can be exercised without a credential. */
  readonly providerConfig?: ProviderConfig
  readonly timeoutMs?: number
  readonly heartbeatMs?: number
}

async function handleGenerate(
  body: Record<string, unknown>,
  emit: (event: Record<string, unknown>) => void,
  signal: AbortSignal,
  options: HandlerOptions,
): Promise<CompletionResult> {
  const system = body.system
  const prompt = body.prompt
  if (typeof system !== 'string' || !system.trim() || typeof prompt !== 'string' || !prompt.trim()) {
    throw new BadRequest('Both "system" and "prompt" must be non-empty strings.')
  }
  if (!body.schema || typeof body.schema !== 'object') {
    throw new BadRequest('"schema" must be a JSON Schema object.')
  }
  const maxTokens = typeof body.maxTokens === 'number' ? Math.min(Math.max(256, body.maxTokens), 16_000) : undefined

  return provider(options.providerConfig).complete({
    system,
    prompt,
    schema: body.schema,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    signal,
    onProgress: (stage) => emit({ type: 'progress', stage }),
  })
}

async function handleBrief(
  body: Record<string, unknown>,
  emit: (event: Record<string, unknown>) => void,
  signal: AbortSignal,
  options: HandlerOptions,
): Promise<CompletionResult & { brief: DesignBrief; notes: string[] }> {
  const text = body.text
  if (typeof text !== 'string' || !text.trim()) throw new BadRequest('"text" must be a non-empty string.')

  const result = await provider(options.providerConfig).complete({
    system: BRIEF_SYSTEM,
    prompt: `Request:\n${text}`,
    schema: BRIEF_SCHEMA,
    maxTokens: 2000,
    signal,
    onProgress: (stage) => emit({ type: 'progress', stage }),
  })

  // Already validated by the provider; parsed again here to get the typed value
  // rather than casting one into existence.
  const parsed = designBriefSchema.parse(result.value)
  const { palette, notes } = await resolvePalette(parsed.paletteColourNames)
  const evidence: Record<string, string> = {}
  for (const entry of parsed.evidence) evidence[entry.field] = entry.phrase
  for (const code of palette) evidence[`palette.${code}`] = parsed.paletteColourNames.join(', ')

  // A partially-stated envelope bounds nothing, so it is reported as absent
  // rather than applied on two axes and guessed on the third.
  const envelopeStuds: [number, number, number] | null =
    parsed.envelopeWidthStuds !== null && parsed.envelopeHeightStuds !== null && parsed.envelopeDepthStuds !== null
      ? [parsed.envelopeWidthStuds, parsed.envelopeHeightStuds, parsed.envelopeDepthStuds]
      : null

  const brief: DesignBrief = {
    version: 1,
    subject: parsed.subject,
    envelopeStuds,
    scale: parsed.scale,
    functions: parsed.functions,
    palette,
    symmetry: parsed.symmetry,
    partBudget: parsed.partBudget,
    protectedPartIds: [],
    style: parsed.style,
    evidence,
    conflicts: parsed.conflicts,
  }
  return { ...result, brief, notes }
}

/**
 * Builds the route.
 *
 * Exported as a factory as well as a singleton so a test can inject a provider
 * config and drive the real handler — the alternative, testing a re-implementation
 * of the routing, proves nothing about what actually runs.
 */
export function createGenerationRoute(options: HandlerOptions = {}): RouteModule {
  const timeoutMs = boundedTimeout(
    options.timeoutMs ?? options.providerConfig?.timeoutMs ?? process.env.BRICKWRIGHT_GENERATION_TIMEOUT_MS,
    120_000,
  )
  return {
    prefix: '/api/',
    async handle(request, response, url) {
      const isGenerate = url.pathname === '/api/generate'
      const isBrief = url.pathname === '/api/brief'
      if (!isGenerate && !isBrief) return false

      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
        response.end(JSON.stringify({ error: 'method_not_allowed', detail: 'Use POST.' }))
        return true
      }

      // Do not accept a cross-origin "simple request" body. Requiring JSON
      // forces an untrusted browser origin through CORS preflight, and this
      // server grants no such origin access to the paid model route.
      const mediaType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        response.writeHead(415, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'unsupported_media_type', detail: 'Use Content-Type: application/json.' }))
        return true
      }

      const span = requestLifetime(request, response, timeoutMs)
      try {
        let body: Record<string, unknown>
        try {
          const text = await readRequestText(request, span.signal, MAX_BODY_BYTES)
          try {
            body = JSON.parse(text)
          } catch {
            throw new BadRequest('Request body was not valid JSON.')
          }
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new BadRequest('Request body must be a JSON object.')
        } catch (cause) {
          if (span.reason === 'client') return true
          const code =
            span.reason === 'timeout'
              ? 'timeout'
              : cause instanceof RequestBodyError && cause.code === 'PAYLOAD_TOO_LARGE'
                ? 'payload_too_large'
                : 'bad_request'
          response.writeHead(code === 'timeout' ? 408 : code === 'payload_too_large' ? 413 : 400, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            connection: 'close',
          })
          response.end(
            JSON.stringify({
              error: code,
              detail:
                code === 'timeout'
                  ? 'The request body did not arrive before its deadline.'
                  : cause instanceof BadRequest || cause instanceof RequestBodyError
                    ? cause.message
                    : 'Request body could not be read.',
            }),
          )
          return true
        }

        // The provider is resolved before the stream opens, so "no credential" is
        // an ordinary 503 the client can branch on rather than an error buried
        // inside a 200 response it has already started reading.
        try {
          provider(options.providerConfig)
        } catch (cause) {
          const wire = toWireError(cause)
          response.writeHead(wire.status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: wire.code, detail: wire.detail }))
          return true
        }

        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const writer = ndjsonWriter(response, span.signal, options.heartbeatMs)
        const emit = (event: Record<string, unknown>) => {
          if (!span.signal.aborted) writer.write(event)
        }
        const requestId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        writer.write({ type: 'accepted', requestId })

        try {
          span.signal.throwIfAborted()
          if (isBrief) {
            const result = await awaitWithAbort(handleBrief(body, emit, span.signal, options), span.signal)
            writer.write({
              type: 'result',
              requestId,
              value: result.brief,
              provenance: result.provenance,
              usage: result.usage,
              attempts: result.attempts,
              notes: result.notes,
            })
          } else {
            const result = await awaitWithAbort(handleGenerate(body, emit, span.signal, options), span.signal)
            writer.write({
              type: 'result',
              requestId,
              value: result.value,
              provenance: result.provenance,
              usage: result.usage,
              attempts: result.attempts,
            })
          }
        } catch (cause) {
          if (span.reason === 'client') return true
          const wire =
            span.reason === 'timeout'
              ? {
                  status: 504,
                  code: 'timeout',
                  detail: 'The generation exceeded its request deadline and was cancelled.',
                }
              : cause instanceof BadRequest
                ? { status: 400, code: 'bad_request', detail: cause.message }
                : toWireError(cause)
          process.stderr.write(`[api] /api generation ${requestId} failed: ${redact(String(cause))}\n`)
          writer.write({ type: 'error', requestId, error: wire.code, detail: wire.detail })
        } finally {
          writer.close()
          if (!response.destroyed && !response.writableEnded) response.end()
        }
        return true
      } finally {
        span.dispose()
      }
    },
  }
}

export const route: RouteModule = createGenerationRoute()

export default route
