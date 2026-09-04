/**
 * Cross-workstream contracts.
 *
 * Ten feature areas are built independently against this file, so everything
 * here is deliberately dependency-free: types, small pure helpers and registry
 * shapes only. A module that imports the CAD kernel, React or Three.js does not
 * belong here — it belongs in the workstream that owns it.
 *
 * The rule that makes parallel work safe: a feature module never reaches into
 * another feature module. It imports from `src/cad/*` (the kernel), from this
 * file, and from its own directory. Anything that has to cross a boundary
 * crosses it as one of the contracts below.
 */

/** Where a surface is mounted in the application shell. */
export type RouteId = 'landing' | 'explore' | 'editor' | 'projects' | 'account' | 'share' | 'gallery' | 'terms' | 'privacy'

/**
 * A lazily-loaded top-level surface.
 *
 * `boot` states what the route is allowed to pull in before it paints, which is
 * what keeps the marketing routes from downloading the compiled catalog and the
 * Three.js renderer. The shell enforces it; a route cannot opt itself in.
 */
export interface RouteModule {
  id: RouteId
  path: string
  /**
   * 'none' — no kernel; 'parts' — compiled geometry, colour and identity, not
   * searchable; 'catalog' — 'parts' plus a resident browse index; 'editor' —
   * 'parts' plus the kernel, the session and warmed geometry.
   *
   * `parts` and `catalog` differ by `search.json`: 423 KiB gzip and ~24 ms of
   * main-thread work that only searching and browsing need. A surface that
   * names parts it was already given (a published model, a project card) wants
   * `parts`; a surface that has to answer "does this part exist?" wants
   * `catalog`. See the table in `src/platform/boot.ts`.
   */
  boot: 'none' | 'parts' | 'catalog' | 'editor'
  /** Rendered inside the shell's suspense boundary. */
  load: () => Promise<{ default: React.ComponentType }>
  /** Requires a signed-in Hexclave user; the shell redirects when absent. */
  requiresAuth?: boolean
}

/** Result of resolving free-form language to a catalog identity. */
export interface PartIntentMatch {
  canonicalId: string
  /** 0..1, calibrated against the evaluation set — not a rank placeholder. */
  confidence: number
  /** Why this identity matched, in terms a builder recognises. */
  explanation: string
  tier: 'placeable' | 'modelled' | 'catalogued'
  /** Whether this build can actually place it. `tier === 'placeable'`. */
  placeable: boolean
  /** Which signals fired, for debugging and for the agent's own reasoning. */
  signals: {
    exactId: boolean
    lexical: number
    semantic: number
    dimensional: number
    connector: number
    frequency: number
  }
}

export interface PartIntentResult {
  query: string
  matches: PartIntentMatch[]
  /** Interpretation the resolver committed to, surfaced so a user can correct it. */
  interpretation: {
    dimensions: [number, number, number] | null
    category: string | null
    colorName: string | null
    connectorFamilies: string[]
    /** Terms that matched nothing, so an impossible request says so. */
    unmatchedTerms: string[]
  }
  /** Milliseconds spent, for the performance gate. */
  elapsedMs: number
}

/**
 * A design brief: the structured, editable form of a natural-language request.
 *
 * Every generator and refiner consumes this rather than raw prose, so an
 * ambiguous request becomes a visible, correctable field instead of a silent
 * assumption buried in a prompt.
 */
export interface DesignBrief {
  version: 1
  subject: string
  /** Target bounding box in studs [x, y, z]; null when the user did not say. */
  envelopeStuds: [number, number, number] | null
  scale: 'micro' | 'minifig' | 'midi' | 'large' | 'unspecified'
  /** Named functional requirements, e.g. "wheels turn", "roof lifts off". */
  functions: string[]
  /** LDraw colour codes the build should prefer. */
  palette: number[]
  symmetry: 'none' | 'mirror-x' | 'mirror-z' | 'radial'
  /** Hard ceiling on part count; null means unconstrained. */
  partBudget: number | null
  /** Part ids the generator must not move or remove. */
  protectedPartIds: string[]
  style: string[]
  /** Phrases from the source request that produced each field, for review. */
  evidence: Record<string, string>
  /** Contradictions the compiler could not resolve; the UI must surface these. */
  conflicts: { field: string; detail: string }[]
}

/**
 * How a brief is compiled: the instructions, and the shape of the answer.
 *
 * Both here rather than beside either caller, because there are two callers and
 * they have to mean the same thing. `POST /api/brief` compiles a brief in the
 * API process; `src/generation/brief.ts` compiles one in the browser through
 * whatever `ModelProvider` it was given. Each held its own copy, and both had a
 * comment saying they must not drift with nothing checking that they had not.
 *
 * The schema is worse than the prompt to duplicate: `src/generation/brief.ts`
 * hashes it into a brief's provenance, so two copies that disagree do not merely
 * ask for different things, they change what a brief is identified as.
 *
 * This file is the dependency-free contract module — the API process can load it
 * without pulling the catalogue or the kernel into Node, which is what stopped
 * the definition living next to the browser compiler.
 */
/**
 *
 * Deliberately the same instructions the browser-side compiler sends, so the two
 * routes cannot drift into disagreeing about what a brief means.
 */
export const BRIEF_SYSTEM = [
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
export const BRIEF_SCHEMA = {
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

/** Deterministic provenance for anything a model produced. */
export interface Provenance {
  /** Provider identifier, e.g. 'anthropic'. 'deterministic' when no model ran. */
  provider: string
  /** Exact model id, e.g. 'claude-sonnet-5'. Null for deterministic paths. */
  model: string | null
  promptHash: string
  seed: number
  createdAt: string
}

/**
 * Model provider seam.
 *
 * Implemented once against a real API and injected everywhere else. Test
 * doubles implement this interface; runtime code never constructs one.
 */
export interface ModelProvider {
  readonly id: string
  readonly model: string
  /** Structured completion validated against a caller-supplied schema. */
  complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>>
}

export interface ModelRequest<T> {
  system: string
  prompt: string
  /** JSON Schema the response must satisfy; the provider retries on violation. */
  schema: unknown
  parse: (raw: unknown) => T
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
}

export interface ModelResult<T> {
  value: T
  provenance: Provenance
  /**
   * What the call cost, by token class.
   *
   * `inputTokens` excludes both cache classes — that is the provider's
   * convention, not a summary — so a caller that meters spend has to add all
   * four. The cache fields are optional because a provider that does not cache
   * has nothing to report, and a browser-side proxy may not be told.
   */
  usage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }
}

/** Raised when a provider is asked to run without credentials configured. */
export class ModelProviderUnavailableError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ModelProviderUnavailableError'
  }
}

/** Stop awaiting abandoned work even if an SDK ignores its cancellation signal. */
export function awaitWithAbort<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(work)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Attach both handlers even when already aborted: a late rejection must not
    // become an unhandled promise after the caller has stopped waiting.
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (cause) => {
        signal.removeEventListener('abort', onAbort)
        reject(cause)
      },
    )
    if (signal.aborted) onAbort()
  })
}

/** Abort a whole HTTP exchange, including credential lookup and response reads. */
export function deadlineSignal(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new DOMException('Aborted', 'AbortError'))
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 600_000) : 180_000
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), duration)
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  }
}

export interface NdjsonReadOptions {
  signal?: AbortSignal
  maxLineBytes?: number
  maxTotalBytes?: number
  /** Stop and cancel the reader after a protocol terminal event, not after EOF. */
  stopWhen?: () => boolean
}

/**
 * Consume a byte stream as newline-delimited text without corrupting UTF-8
 * characters split across chunks.
 *
 * Framing belongs to the shared HTTP contract; interpreting a line belongs to
 * each protocol. Limits include actual wire bytes, not decoded character counts.
 * Readers are always released; parse failures and early completion cancel the
 * upstream body rather than leaving an unread, potentially paid request alive.
 */
export async function readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void | Promise<void>,
  options: NdjsonReadOptions = {},
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let lineBytes = 0
  let totalBytes = 0
  let ended = false
  const maxLine = options.maxLineBytes ?? 2 * 1024 * 1024
  const maxTotal = options.maxTotalBytes ?? 16 * 1024 * 1024
  try {
    options.signal?.throwIfAborted()
    for (;;) {
      const { done, value } = await awaitWithAbort(reader.read(), options.signal)
      options.signal?.throwIfAborted()
      if (done) {
        ended = true
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > maxTotal) throw new Error('The event stream exceeded its total byte limit.')
      let start = 0
      while (start < value.length) {
        const newline = value.indexOf(10, start)
        const end = newline < 0 ? value.length : newline
        lineBytes += end - start
        if (lineBytes > maxLine) throw new Error('An event stream frame exceeded its byte limit.')
        buffer += decoder.decode(value.subarray(start, end), { stream: true })
        if (newline < 0) break
        buffer += decoder.decode()
        await awaitWithAbort(Promise.resolve(onLine(buffer)), options.signal)
        buffer = ''
        lineBytes = 0
        if (options.stopWhen?.()) return
        start = newline + 1
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) await awaitWithAbort(Promise.resolve(onLine(buffer)), options.signal)
  } finally {
    if (!ended) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Bound non-streaming success/error bodies too, with the same cancellation cleanup. */
export async function readResponseJson(
  response: Response,
  signal?: AbortSignal,
  maxBytes = 2 * 1024 * 1024,
): Promise<unknown> {
  // Hosts may supply a minimal Response seam without a readable body.
  if (!response.body?.getReader) return awaitWithAbort(response.json(), signal)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  let ended = false
  try {
    signal?.throwIfAborted()
    for (;;) {
      const { done, value } = await awaitWithAbort(reader.read(), signal)
      signal?.throwIfAborted()
      if (done) {
        ended = true
        break
      }
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('The response exceeded its byte limit.')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    if (!ended) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Stable, sorted JSON so a prompt hash is reproducible across processes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * A small, fast, dependency-free 32-bit hash.
 *
 * Used for seeds and cache keys, never for security. Anything that gates access
 * uses SHA-256 through WebCrypto instead.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Deterministic PRNG so a seed reproduces a candidate exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
