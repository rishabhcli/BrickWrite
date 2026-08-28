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
export type RouteId = 'landing' | 'explore' | 'editor' | 'projects' | 'account' | 'share' | 'gallery'

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
  /** 'none' — no kernel; 'catalog' — catalog only; 'editor' — catalog + kernel + renderer. */
  boot: 'none' | 'catalog' | 'editor'
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
  usage: { inputTokens: number; outputTokens: number }
}

/** Raised when a provider is asked to run without credentials configured. */
export class ModelProviderUnavailableError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'ModelProviderUnavailableError'
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
