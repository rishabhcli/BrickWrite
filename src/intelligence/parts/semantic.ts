import { catalog } from '../../cad/catalog'
import { verifyAsset } from '../../cad/integrity'
import { hash32 } from '../../platform/contracts'

/**
 * The runtime half of the latent-semantic index built by
 * `tools/semantic-index.mjs`.
 *
 * What ships is a truncated SVD of the catalog's TF-IDF matrix: the term-side
 * projection, so a query typed here folds into the same latent space the
 * documents were placed in, and the document side quantised to int8. Nothing is
 * fetched from a model server and nothing is approximated with string
 * similarity - a query is a real vector and ranking is a real cosine over
 * 23,000 real vectors.
 *
 * The one hazard in splitting a vector index across two languages is analyzer
 * drift: if the tool tokenised differently from this file, every ranking would
 * be quietly wrong rather than loudly broken. The container carries the hash of
 * a fixed probe string's feature list, recomputed here at load time, so drift is
 * a hard error instead of a silent regression.
 */

/** Must match `ANALYZER` in tools/semantic-index.mjs. Guarded by the probe hash. */
const ANALYZER = {
  ngram: 3,
  charGramWeight: 0.5,
  probeText: 'brick 2 x 4 trans-clear windscreen hinge clip',
} as const

const MAGIC = 0x31535742
const SUPPORTED_FORMAT = 1
const HEADER_BYTES = 64
const pad4 = (value: number) => (value + 3) & ~3

export class SemanticIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SemanticIndexError'
  }
}

export interface SemanticIndexManifest {
  schemaVersion: number
  version: string
  dims: number
  vocabSize: number
  docCount: number
  file: string
  bytes: number
  sha256: string
  builtAt: string
  analyzer: { ngram: number; charGramWeight: number; minDocFrequency: number; probeHash: number }
}

export interface SemanticHit {
  id: string
  /** Cosine similarity in [-1, 1]; in practice [0, 1] for TF-IDF documents. */
  similarity: number
}

/** Mirrors `normalizeText` in tools/semantic-index.mjs. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Mirrors `analyze` in tools/semantic-index.mjs: word unigrams plus in-word trigrams. */
export function analyze(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (term: string, weight: number) => counts.set(term, (counts.get(term) ?? 0) + weight)
  const normalized = normalizeText(text)
  if (!normalized) return counts
  for (const word of normalized.split(' ')) {
    if (!word) continue
    add(`w:${word}`, 1)
    for (let i = 0; i + ANALYZER.ngram <= word.length; i += 1) {
      add(`c:${word.slice(i, i + ANALYZER.ngram)}`, ANALYZER.charGramWeight)
    }
  }
  return counts
}

/**
 * One query, folded into the latent space once and then reused.
 *
 * Fusion needs the similarity of documents the lexical stage found as well as
 * the semantic stage's own top list, and re-embedding for each would be pure
 * waste, so the embedding is the object.
 */
export class SemanticQuery {
  constructor(
    private readonly index: SemanticIndex,
    private readonly vector: Float64Array,
    private readonly norm: number,
    /** How many of the query's features the shipped vocabulary actually knew. */
    readonly coverage: number,
  ) {}

  /** Cosine similarity with one identity, or 0 when it is not in the index. */
  similarity(id: string): number {
    const doc = this.index.documentIndex(id)
    return doc === undefined ? 0 : this.similarityAt(doc)
  }

  similarityAt(doc: number): number {
    const { dims, documents, documentNorms } = this.index.internals
    const documentNorm = documentNorms[doc]
    if (documentNorm === 0 || this.norm === 0) return 0
    let dot = 0
    const base = doc * dims
    for (let k = 0; k < dims; k += 1) dot += this.vector[k] * documents[base + k]
    return dot / (this.norm * documentNorm)
  }

  /** The `limit` nearest identities, by full scan over the quantised matrix. */
  top(limit: number): SemanticHit[] {
    if (this.norm === 0) return []
    const { dims, docCount, documents, documentNorms, ids } = this.index.internals
    // A fixed-size insertion heap beats sorting 23,000 candidates: the scan is
    // the whole query cost, and a full sort would double it for a top-50 list.
    const bestScores = new Float64Array(limit)
    const bestDocs = new Int32Array(limit).fill(-1)
    let filled = 0
    let worst = -Infinity

    for (let doc = 0; doc < docCount; doc += 1) {
      const documentNorm = documentNorms[doc]
      if (documentNorm === 0) continue
      let dot = 0
      const base = doc * dims
      for (let k = 0; k < dims; k += 1) dot += this.vector[k] * documents[base + k]
      const similarity = dot / (this.norm * documentNorm)
      if (filled === limit && similarity <= worst) continue

      let position = filled < limit ? filled : limit - 1
      while (position > 0 && bestScores[position - 1] < similarity) {
        bestScores[position] = bestScores[position - 1]
        bestDocs[position] = bestDocs[position - 1]
        position -= 1
      }
      bestScores[position] = similarity
      bestDocs[position] = doc
      if (filled < limit) filled += 1
      worst = bestScores[filled - 1]
    }

    const hits: SemanticHit[] = []
    for (let i = 0; i < filled; i += 1) hits.push({ id: ids[bestDocs[i]], similarity: bestScores[i] })
    return hits
  }
}

export class SemanticIndex {
  private readonly idIndex: Map<string, number>

  private constructor(
    readonly dims: number,
    readonly vocabSize: number,
    readonly docCount: number,
    private readonly vocabulary: Map<string, number>,
    private readonly idf: Float32Array,
    private readonly projectionScales: Float32Array,
    private readonly projection: Int8Array,
    private readonly ids: string[],
    private readonly documents: Int8Array,
    private readonly documentNorms: Float32Array,
  ) {
    this.idIndex = new Map(ids.map((id, index) => [id, index]))
  }

  /** Read-only view for `SemanticQuery`, which needs the raw matrices in its inner loop. */
  get internals() {
    return {
      dims: this.dims,
      docCount: this.docCount,
      documents: this.documents,
      documentNorms: this.documentNorms,
      ids: this.ids,
    }
  }

  documentIndex(id: string): number | undefined {
    return this.idIndex.get(id)
  }

  /**
   * Folds a query into the latent space.
   *
   * Returns null when nothing in the request is in the shipped vocabulary,
   * which is a real answer - "this build has never seen any of these words" -
   * and must not be confused with a zero-similarity match.
   */
  query(text: string): SemanticQuery | null {
    const features = analyze(text)
    if (!features.size) return null
    const entries: Array<[number, number]> = []
    for (const [term, weight] of features) {
      const term_index = this.vocabulary.get(term)
      if (term_index === undefined) continue
      // Sublinear term frequency, matching how the documents were weighted.
      entries.push([term_index, (1 + Math.log(weight)) * this.idf[term_index]])
    }
    if (!entries.length) return null
    // Summing in vocabulary order keeps the result identical across engines.
    entries.sort((a, b) => a[0] - b[0])

    let magnitude = 0
    for (const [, value] of entries) magnitude += value * value
    magnitude = Math.sqrt(magnitude)
    if (magnitude === 0) return null

    const vector = new Float64Array(this.dims)
    for (const [term_index, value] of entries) {
      const weight = (value / magnitude) * this.projectionScales[term_index]
      const base = term_index * this.dims
      for (let k = 0; k < this.dims; k += 1) vector[k] += weight * this.projection[base + k]
    }
    let norm = 0
    for (let k = 0; k < this.dims; k += 1) norm += vector[k] * vector[k]
    return new SemanticQuery(this, vector, Math.sqrt(norm), entries.length / features.size)
  }

  static decode(buffer: ArrayBuffer): SemanticIndex {
    if (buffer.byteLength < HEADER_BYTES) {
      throw new SemanticIndexError(`Truncated semantic index header (${buffer.byteLength} bytes).`)
    }
    const view = new DataView(buffer)
    if (view.getUint32(0, true) !== MAGIC) throw new SemanticIndexError('Not a Brickwright semantic index.')
    const format = view.getUint32(4, true)
    if (format !== SUPPORTED_FORMAT) {
      throw new SemanticIndexError(`Semantic index format ${format} is not supported by this build.`)
    }
    const dims = view.getUint32(8, true)
    const vocabSize = view.getUint32(12, true)
    const docCount = view.getUint32(16, true)
    const vocabBytes = view.getUint32(20, true)
    const idBytes = view.getUint32(24, true)
    const ngram = view.getUint32(28, true)
    const charGramWeight = view.getFloat32(32, true)
    const probeHash = view.getUint32(36, true)

    if (ngram !== ANALYZER.ngram || Math.abs(charGramWeight - ANALYZER.charGramWeight) > 1e-6) {
      throw new SemanticIndexError(
        `Semantic index was built with a different analyzer (n-gram ${ngram}, weight ${charGramWeight}).`,
      )
    }

    let cursor = HEADER_BYTES
    const decoder = new TextDecoder()
    const vocabularyTerms = decoder.decode(new Uint8Array(buffer, cursor, vocabBytes)).split('\n')
    cursor += pad4(vocabBytes)
    const idf = new Float32Array(buffer, cursor, vocabSize)
    cursor += vocabSize * 4
    const projectionScales = new Float32Array(buffer, cursor, vocabSize)
    cursor += vocabSize * 4
    const projection = new Int8Array(buffer, cursor, vocabSize * dims)
    cursor += pad4(vocabSize * dims)
    const ids = decoder.decode(new Uint8Array(buffer, cursor, idBytes)).split('\n')
    cursor += pad4(idBytes)
    const documents = new Int8Array(buffer, cursor, docCount * dims)
    cursor += pad4(docCount * dims)

    if (cursor !== buffer.byteLength) {
      throw new SemanticIndexError(
        `Semantic index layout mismatch: header requires ${cursor} bytes, received ${buffer.byteLength}.`,
      )
    }
    if (vocabularyTerms.length !== vocabSize || ids.length !== docCount) {
      throw new SemanticIndexError('Semantic index vocabulary or identity list does not match its declared counts.')
    }

    const vocabulary = new Map(vocabularyTerms.map((term, index) => [term, index]))
    const expectedProbe = analyzerProbeHash(vocabulary)
    if (expectedProbe !== probeHash) {
      // The builder and this decoder disagree about how text becomes features.
      // Ranking would still produce numbers, which is exactly why this has to
      // be fatal rather than a warning.
      throw new SemanticIndexError(
        `Semantic index analyzer mismatch: index declares ${probeHash}, this build computes ${expectedProbe}. ` +
          'Rebuild with tools/semantic-index.mjs.',
      )
    }

    // Document rows carry direction only; their norms are what cosine needs and
    // computing them once at load keeps the query loop to a single dot product.
    const documentNorms = new Float32Array(docCount)
    for (let doc = 0; doc < docCount; doc += 1) {
      let total = 0
      const base = doc * dims
      for (let k = 0; k < dims; k += 1) total += documents[base + k] * documents[base + k]
      documentNorms[doc] = Math.sqrt(total)
    }

    return new SemanticIndex(
      dims,
      vocabSize,
      docCount,
      vocabulary,
      idf,
      projectionScales,
      projection,
      ids,
      documents,
      documentNorms,
    )
  }
}

/** Mirrors `analyzerProbeHash` in tools/semantic-index.mjs. */
function analyzerProbeHash(vocabulary: ReadonlyMap<string, number>): number {
  const parts: string[] = []
  for (const [term, weight] of analyze(ANALYZER.probeText)) {
    const index = vocabulary.get(term)
    if (index === undefined) continue
    parts.push(`${index}:${weight.toFixed(6)}`)
  }
  parts.sort()
  return hash32(`${vocabulary.size}|${parts.join(',')}`)
}

export interface SemanticLoadOptions {
  /** Root the compiled assets are served from; matches `loadCompiledCatalog`. */
  baseUrl?: string
  /** Defaults to the installed catalog's version. */
  version?: string
  signal?: AbortSignal
}

let resident: { key: string; index: SemanticIndex; manifest: SemanticIndexManifest } | null = null
let pending: { key: string; promise: Promise<SemanticIndex> } | null = null

/** The index if it is already decoded, without triggering a fetch. */
export function residentSemanticIndex(): SemanticIndex | null {
  return resident?.index ?? null
}

export function residentSemanticManifest(): SemanticIndexManifest | null {
  return resident?.manifest ?? null
}

/** Drops the resident index. Tests use it; the application has no reason to. */
export function resetSemanticIndex(): void {
  resident = null
  pending = null
}

/**
 * Fetches and decodes the index, once.
 *
 * Nothing here runs at import time. Four megabytes is not something a landing
 * page should pay for, and the first semantic question is the earliest moment
 * the cost is justified.
 */
export function loadSemanticIndex(options: SemanticLoadOptions = {}): Promise<SemanticIndex> {
  const root = (options.baseUrl ?? '').replace(/\/$/, '')
  const version = options.version ?? catalog.version
  const key = `${root}|${version}`
  if (resident?.key === key) return Promise.resolve(resident.index)
  if (pending?.key === key) return pending.promise

  const promise = (async () => {
    const manifestUrl = `${root}/semantic-index.${version}.json`
    const manifestResponse = await fetch(manifestUrl, { cache: 'force-cache', signal: options.signal })
    if (!manifestResponse.ok) {
      throw new SemanticIndexError(
        `${manifestUrl} -> ${manifestResponse.status} ${manifestResponse.statusText}. ` +
          'Run `node tools/semantic-index.mjs` to build the semantic index for this catalog.',
      )
    }
    const manifest = (await manifestResponse.json()) as SemanticIndexManifest
    if (manifest.schemaVersion !== SUPPORTED_FORMAT) {
      throw new SemanticIndexError(`Semantic index manifest declares unsupported schema ${manifest.schemaVersion}.`)
    }
    if (manifest.version !== version) {
      throw new SemanticIndexError(
        `Semantic index manifest is for catalog ${manifest.version}, but ${version} is installed.`,
      )
    }

    const binaryUrl = `${root}/${manifest.file.replace(/^\/+/, '')}`
    const response = await fetch(binaryUrl, { cache: 'force-cache', signal: options.signal })
    if (!response.ok) {
      throw new SemanticIndexError(`${binaryUrl} -> ${response.status} ${response.statusText}`)
    }
    const buffer = await response.arrayBuffer()
    await verifyAsset(buffer, { hash: manifest.sha256, bytes: manifest.bytes }, `Semantic index ${version}`)
    const index = SemanticIndex.decode(buffer)
    if (index.dims !== manifest.dims || index.vocabSize !== manifest.vocabSize || index.docCount !== manifest.docCount) {
      throw new SemanticIndexError(`Semantic index ${version} does not match the shape its manifest declares.`)
    }
    resident = { key, index, manifest }
    return index
  })().catch((cause: unknown) => {
    // A failed load must stay retryable rather than poisoning the module.
    if (pending?.key === key) pending = null
    throw cause
  })

  pending = { key, promise }
  return promise
}
