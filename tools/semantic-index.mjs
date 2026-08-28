#!/usr/bin/env node
/**
 * Builds the latent-semantic index that `src/intelligence/parts/semantic.ts`
 * queries at runtime.
 *
 * Why an offline build at all: the resolver has to answer "a transparent
 * windscreen about six studs wide" without a network round trip and without a
 * model server, so the only affordable place to do the linear algebra is here,
 * once, against the compiled catalog. What ships is a truncated SVD of the
 * catalog's TF-IDF matrix — the term-side projection, so a query typed in the
 * browser is folded into exactly the same latent space the documents live in,
 * and the document side, quantised to int8.
 *
 * Why LSA rather than a neural embedding: a neural model would be a 20-90 MB
 * download plus a runtime, and its output could not be regenerated from this
 * repository. Every number below is derived from `public/catalog/<version>/`
 * by code in this file, so the artefact is auditable and reproducible.
 *
 * Determinism is a hard requirement, not a nicety: the artefact is fetched by
 * hash, so two builds of the same catalog that differ by one byte would
 * invalidate every cache and make the manifest a lie. The random projection is
 * seeded from the catalog identity, every reduction runs in a fixed order,
 * singular-vector signs are canonicalised, and `builtAt` records the catalog's
 * own build stamp rather than wall-clock time.
 *
 * Usage:
 *   node tools/semantic-index.mjs                       # public/, latest version
 *   node tools/semantic-index.mjs --catalog .catalog-fixture --out .catalog-fixture
 *   node tools/semantic-index.mjs --input src/intelligence/parts/__fixtures__/catalog.fixture.json --out /tmp/x
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

/** Bump when the on-disk layout changes; the runtime refuses other versions. */
export const FORMAT_VERSION = 1
const MAGIC = 0x31535742 // "BWS1" little-endian

/**
 * Analyzer parameters. These are duplicated in `src/intelligence/parts/
 * semantic.ts` because the query has to be analysed the same way the documents
 * were, and that file cannot import this one (it runs in a browser). The
 * duplication is guarded: the probe hash written into the header is recomputed
 * at load time and a mismatch is a hard error, so the two implementations
 * cannot drift apart silently.
 */
export const ANALYZER = {
  ngram: 3,
  /**
   * Character trigrams carry less evidence than whole words — "bri" appears in
   * brick, bridge and fabric — so they are down-weighted rather than dropped.
   * Keeping them is what lets "windscreen" reach "Windscreen" spelt with a
   * different suffix, and what makes a misspelling degrade instead of fail.
   */
  charGramWeight: 0.5,
  /** A term seen in fewer than this many parts is noise, not vocabulary. */
  minDocFrequency: 3,
  /** A term in more than half the catalog separates nothing. */
  maxDocFrequencyRatio: 0.5,
  probeText: 'brick 2 x 4 trans-clear windscreen hinge clip',
}

const DEFAULT_DIMS = 128
/**
 * Extra subspace dimensions carried through the iteration and discarded at the
 * end. Randomized SVD converges on the leading subspace much faster with a
 * margin above the rank actually wanted; 24 is the usual oversampling advice.
 */
const OVERSAMPLE = 24
/**
 * Power iterations. The catalog's spectrum decays slowly — thousands of parts
 * share the word "brick" — so one pass leaves the leading directions mixed.
 * Two extra passes were enough for the singular values to stop moving in the
 * fourth decimal place; more only costs build time.
 */
const POWER_ITERATIONS = 3

// ---------------------------------------------------------------------------
// deterministic randomness

/** Mirrors `mulberry32` in src/platform/contracts.ts; kept local so this tool stays plain ESM. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mirrors `hash32` in src/platform/contracts.ts. */
export function hash32(input) {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Box–Muller over a seeded uniform stream, so the projection is reproducible. */
function gaussianFill(target, seed) {
  const random = mulberry32(seed)
  for (let i = 0; i < target.length; i += 2) {
    // Clamp away from zero: Math.log(0) would poison the whole column.
    const u1 = Math.max(random(), Number.EPSILON)
    const u2 = random()
    const radius = Math.sqrt(-2 * Math.log(u1))
    const angle = 2 * Math.PI * u2
    target[i] = radius * Math.cos(angle)
    if (i + 1 < target.length) target[i + 1] = radius * Math.sin(angle)
  }
}

// ---------------------------------------------------------------------------
// analyzer

/**
 * Folds a part name to the alphabet the index is built over.
 *
 * LDraw names carry degree signs, slashes, brackets and doubled spaces
 * ("Windscreen  3 x  4 x  1.333"); none of that survives into the vocabulary,
 * so "1 x 2" and "1 x  2" produce the same features.
 */
export function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Weighted term frequencies for one piece of text.
 *
 * Returns a Map of term → raw weighted count. Word unigrams keep their full
 * weight; character trigrams are taken inside word boundaries only, so a
 * trigram never spans two unrelated words.
 */
export function analyze(text) {
  const counts = new Map()
  const add = (term, weight) => counts.set(term, (counts.get(term) ?? 0) + weight)
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
 * The hash the runtime analyzer must reproduce.
 *
 * It covers the vocabulary *and* the tokenizer: if either side changes its
 * normalisation, its n-gram size or its weighting, the probe's feature list
 * moves and the runtime refuses the index instead of silently returning
 * nonsense rankings.
 */
export function analyzerProbeHash(vocabularyIndex) {
  const parts = []
  for (const [term, weight] of analyze(ANALYZER.probeText)) {
    const index = vocabularyIndex.get(term)
    if (index === undefined) continue
    parts.push(`${index}:${weight.toFixed(6)}`)
  }
  parts.sort()
  return hash32(`${vocabularyIndex.size}|${parts.join(',')}`)
}

// ---------------------------------------------------------------------------
// sparse linear algebra

/** Compressed sparse row matrix; rows are documents, columns are vocabulary terms. */
function buildSparseMatrix(documents, vocabularyIndex, idf) {
  const rowStart = new Int32Array(documents.length + 1)
  const columns = []
  const values = []
  for (let row = 0; row < documents.length; row += 1) {
    rowStart[row] = columns.length
    const entries = []
    for (const [term, weight] of analyze(documents[row].text)) {
      const column = vocabularyIndex.get(term)
      if (column === undefined) continue
      // Sublinear term frequency: a name repeating "x" four times is not four
      // times as much evidence as saying it once.
      entries.push([column, (1 + Math.log(weight)) * idf[column]])
    }
    // Sorting by column keeps the traversal order — and therefore the
    // floating-point summation order — identical on every machine.
    entries.sort((a, b) => a[0] - b[0])
    let norm = 0
    for (const [, value] of entries) norm += value * value
    norm = Math.sqrt(norm)
    for (const [column, value] of entries) {
      columns.push(column)
      values.push(norm > 0 ? value / norm : 0)
    }
  }
  rowStart[documents.length] = columns.length
  return { rowStart, columns: Int32Array.from(columns), values: Float64Array.from(values) }
}

/** Y (rows × width) = X · Z, with Z stored row-major as (cols × width). */
function multiplyForward(matrix, z, width, rows) {
  const out = new Float64Array(rows * width)
  for (let row = 0; row < rows; row += 1) {
    const outBase = row * width
    for (let i = matrix.rowStart[row]; i < matrix.rowStart[row + 1]; i += 1) {
      const value = matrix.values[i]
      const zBase = matrix.columns[i] * width
      for (let k = 0; k < width; k += 1) out[outBase + k] += value * z[zBase + k]
    }
  }
  return out
}

/** Z (cols × width) = Xᵀ · Y, with Y stored row-major as (rows × width). */
function multiplyTranspose(matrix, y, width, rows, columnCount) {
  const out = new Float64Array(columnCount * width)
  for (let row = 0; row < rows; row += 1) {
    const yBase = row * width
    for (let i = matrix.rowStart[row]; i < matrix.rowStart[row + 1]; i += 1) {
      const value = matrix.values[i]
      const outBase = matrix.columns[i] * width
      for (let k = 0; k < width; k += 1) out[outBase + k] += value * y[yBase + k]
    }
  }
  return out
}

/**
 * Modified Gram–Schmidt, in place, on a (rows × width) column set.
 *
 * Classical Gram–Schmidt loses orthogonality badly at width 150 in double
 * precision, and a non-orthogonal basis silently degrades the subspace the
 * whole index is built from, so the modified form is not optional here.
 */
function orthonormalizeColumns(matrix, rows, width) {
  for (let column = 0; column < width; column += 1) {
    for (let prior = 0; prior < column; prior += 1) {
      let dot = 0
      for (let row = 0; row < rows; row += 1) dot += matrix[row * width + column] * matrix[row * width + prior]
      if (dot === 0) continue
      for (let row = 0; row < rows; row += 1) matrix[row * width + column] -= dot * matrix[row * width + prior]
    }
    let norm = 0
    for (let row = 0; row < rows; row += 1) norm += matrix[row * width + column] ** 2
    norm = Math.sqrt(norm)
    if (norm < 1e-12) {
      // A collapsed direction carries no information; zero it so it cannot
      // contribute noise to the projection.
      for (let row = 0; row < rows; row += 1) matrix[row * width + column] = 0
      continue
    }
    for (let row = 0; row < rows; row += 1) matrix[row * width + column] /= norm
  }
}

/**
 * Cyclic Jacobi eigendecomposition of a small symmetric matrix.
 *
 * The randomized method reduces the problem to an L×L Gram matrix, and Jacobi
 * is the shortest correct dense symmetric eigensolver to write from scratch —
 * which matters because this tool takes no dependencies.
 */
function jacobiEigen(input, size) {
  const a = Float64Array.from(input)
  const vectors = new Float64Array(size * size)
  for (let i = 0; i < size; i += 1) vectors[i * size + i] = 1

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0
    for (let p = 0; p < size; p += 1) {
      for (let q = p + 1; q < size; q += 1) off += a[p * size + q] ** 2
    }
    if (off < 1e-22) break
    for (let p = 0; p < size; p += 1) {
      for (let q = p + 1; q < size; q += 1) {
        const apq = a[p * size + q]
        if (Math.abs(apq) < 1e-18) continue
        const theta = (a[q * size + q] - a[p * size + p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < size; k += 1) {
          const akp = a[k * size + p]
          const akq = a[k * size + q]
          a[k * size + p] = c * akp - s * akq
          a[k * size + q] = s * akp + c * akq
        }
        for (let k = 0; k < size; k += 1) {
          const apk = a[p * size + k]
          const aqk = a[q * size + k]
          a[p * size + k] = c * apk - s * aqk
          a[q * size + k] = s * apk + c * aqk
        }
        for (let k = 0; k < size; k += 1) {
          const vkp = vectors[k * size + p]
          const vkq = vectors[k * size + q]
          vectors[k * size + p] = c * vkp - s * vkq
          vectors[k * size + q] = s * vkp + c * vkq
        }
      }
    }
  }

  const order = Array.from({ length: size }, (_, i) => i)
  // Ties broken by index so the ordering cannot depend on sort stability.
  order.sort((x, y) => a[y * size + y] - a[x * size + x] || x - y)
  return {
    values: Float64Array.from(order, (i) => a[i * size + i]),
    vectors: order.map((column) => Float64Array.from({ length: size }, (_, row) => vectors[row * size + column])),
  }
}

// ---------------------------------------------------------------------------
// quantisation and container

function quantiseRowDirections(values, rows, dims) {
  const out = new Int8Array(rows * dims)
  for (let row = 0; row < rows; row += 1) {
    const base = row * dims
    let peak = 0
    for (let k = 0; k < dims; k += 1) peak = Math.max(peak, Math.abs(values[base + k]))
    if (peak === 0) continue
    // Only the direction survives quantisation, which is all cosine needs, and
    // scaling each row by its own peak spends the full 8 bits on every row
    // instead of on whichever row happens to have the largest component.
    for (let k = 0; k < dims; k += 1) {
      out[base + k] = Math.max(-127, Math.min(127, Math.round((values[base + k] / peak) * 127)))
    }
  }
  return out
}

function quantiseWithRowScales(values, rows, dims) {
  const quantised = new Int8Array(rows * dims)
  const scales = new Float32Array(rows)
  for (let row = 0; row < rows; row += 1) {
    const base = row * dims
    let peak = 0
    for (let k = 0; k < dims; k += 1) peak = Math.max(peak, Math.abs(values[base + k]))
    if (peak === 0) continue
    // The projection is summed across terms, so relative magnitude between
    // terms has to survive: the per-term scale is stored rather than discarded.
    scales[row] = peak / 127
    for (let k = 0; k < dims; k += 1) {
      quantised[base + k] = Math.max(-127, Math.min(127, Math.round((values[base + k] / peak) * 127)))
    }
  }
  return { quantised, scales }
}

const HEADER_BYTES = 64
const pad4 = (value) => (value + 3) & ~3

/**
 * Container layout, little-endian throughout:
 *
 *   header    64 bytes (see field offsets below)
 *   vocab     UTF-8, newline separated, `vocabBytes` long, padded to 4
 *   idf       f32 × vocabSize
 *   projScale f32 × vocabSize
 *   proj      int8 × vocabSize × dims, padded to 4
 *   docIds    UTF-8, newline separated, `idBytes` long, padded to 4
 *   docs      int8 × docCount × dims, padded to 4
 */
function encodeIndex({ vocabulary, idf, projection, projectionScales, docIds, docs, dims, probeHash }) {
  const encoder = new TextEncoder()
  const vocabBlob = encoder.encode(vocabulary.join('\n'))
  const idBlob = encoder.encode(docIds.join('\n'))
  const vocabSize = vocabulary.length
  const docCount = docIds.length

  const offsets = {}
  let cursor = HEADER_BYTES
  offsets.vocab = cursor
  cursor += pad4(vocabBlob.byteLength)
  offsets.idf = cursor
  cursor += vocabSize * 4
  offsets.projScale = cursor
  cursor += vocabSize * 4
  offsets.projection = cursor
  cursor += pad4(vocabSize * dims)
  offsets.docIds = cursor
  cursor += pad4(idBlob.byteLength)
  offsets.docs = cursor
  cursor += pad4(docCount * dims)

  const buffer = new ArrayBuffer(cursor)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, FORMAT_VERSION, true)
  view.setUint32(8, dims, true)
  view.setUint32(12, vocabSize, true)
  view.setUint32(16, docCount, true)
  view.setUint32(20, vocabBlob.byteLength, true)
  view.setUint32(24, idBlob.byteLength, true)
  view.setUint32(28, ANALYZER.ngram, true)
  view.setFloat32(32, ANALYZER.charGramWeight, true)
  view.setUint32(36, probeHash, true)
  // Bit 0 records that word unigrams are present alongside the character
  // n-grams, so a future index built from n-grams alone stays readable.
  view.setUint32(40, 1, true)

  bytes.set(vocabBlob, offsets.vocab)
  for (let i = 0; i < vocabSize; i += 1) view.setFloat32(offsets.idf + i * 4, idf[i], true)
  for (let i = 0; i < vocabSize; i += 1) view.setFloat32(offsets.projScale + i * 4, projectionScales[i], true)
  bytes.set(new Uint8Array(projection.buffer, projection.byteOffset, projection.byteLength), offsets.projection)
  bytes.set(idBlob, offsets.docIds)
  bytes.set(new Uint8Array(docs.buffer, docs.byteOffset, docs.byteLength), offsets.docs)
  return bytes
}

// ---------------------------------------------------------------------------
// corpus

/**
 * The text one catalog identity is indexed by.
 *
 * Name and category are the human description; connector families are the
 * functional description, and including them is what lets "clip that holds a
 * bar" reach parts whose names never mention either word. Pack tags are added
 * where the compiler produced them.
 */
export function documentText(entry, tags) {
  const families = entry.k?.length ? entry.k.join(' ') : ''
  return [entry.n, entry.c, families, tags?.join(' ') ?? ''].filter(Boolean).join(' ')
}

async function readCorpus(options) {
  if (options.input) {
    const payload = JSON.parse(await readFile(options.input, 'utf8'))
    return {
      version: payload.manifest.catalogVersion,
      generatedAt: payload.manifest.generatedAt,
      search: payload.search,
      parts: payload.parts,
      sourceLabel: path.relative(process.cwd(), options.input),
    }
  }
  const root = options.catalog
  let version = options.version
  if (!version) {
    const pointer = JSON.parse(await readFile(path.join(root, 'catalog', 'latest.json'), 'utf8'))
    version = pointer.catalogVersion
  }
  const base = path.join(root, 'catalog', version)
  const manifest = JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8'))
  return {
    version: manifest.catalogVersion,
    generatedAt: manifest.generatedAt,
    search: JSON.parse(await readFile(path.join(base, 'search.json'), 'utf8')),
    parts: JSON.parse(await readFile(path.join(base, 'parts.json'), 'utf8')),
    sourceLabel: path.relative(process.cwd(), base),
  }
}

// ---------------------------------------------------------------------------

export async function buildSemanticIndex(options = {}) {
  const settings = {
    catalog: options.catalog ?? 'public',
    out: options.out ?? options.catalog ?? 'public',
    input: options.input ?? null,
    version: options.version ?? null,
    dims: options.dims ?? DEFAULT_DIMS,
    quiet: options.quiet ?? false,
  }
  const log = (message) => {
    if (!settings.quiet) console.log(message)
  }

  const corpus = await readCorpus(settings)
  const tagsById = new Map()
  for (const part of corpus.parts ?? []) {
    const tags = part.search?.tags
    if (Array.isArray(tags) && tags.length) tagsById.set(part.canonicalId, tags)
  }
  // Sorting by id makes the document order — and therefore every downstream
  // reduction — independent of how the catalog file happened to be written.
  const documents = corpus.search
    .map((entry) => ({ id: entry.id, text: documentText(entry, tagsById.get(entry.id)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!documents.length) throw new Error('The catalog contains no searchable identities to index.')
  log(`semantic-index: ${documents.length} identities from ${corpus.sourceLabel}`)

  const documentFrequency = new Map()
  for (const document of documents) {
    for (const term of analyze(document.text).keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const maximumDf = Math.max(ANALYZER.minDocFrequency, documents.length * ANALYZER.maxDocFrequencyRatio)
  const vocabulary = [...documentFrequency.entries()]
    .filter(([, df]) => df >= ANALYZER.minDocFrequency && df <= maximumDf)
    .map(([term]) => term)
    .sort()
  if (!vocabulary.length) throw new Error('No catalog term survived the document-frequency filter.')
  const vocabularyIndex = new Map(vocabulary.map((term, index) => [term, index]))
  const idf = new Float64Array(vocabulary.length)
  for (let i = 0; i < vocabulary.length; i += 1) {
    const df = documentFrequency.get(vocabulary[i])
    // BM25's IDF, floored above zero so a common-but-kept term still counts.
    idf[i] = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
  }
  log(`semantic-index: vocabulary ${vocabulary.length} terms (df >= ${ANALYZER.minDocFrequency})`)

  const matrix = buildSparseMatrix(documents, vocabularyIndex, idf)
  const rows = documents.length
  const columnCount = vocabulary.length
  const dims = Math.min(settings.dims, columnCount, rows)
  const width = Math.min(dims + OVERSAMPLE, columnCount, rows)

  // Randomized subspace iteration for the leading right-singular subspace. The
  // seed is the catalog's own identity, so a rebuild of the same catalog draws
  // the same projection and a different catalog gets a different one.
  const seed = hash32(`${corpus.version}|${rows}|${columnCount}|${dims}`)
  let subspace = new Float64Array(columnCount * width)
  gaussianFill(subspace, seed)
  orthonormalizeColumns(subspace, columnCount, width)
  for (let iteration = 0; iteration < POWER_ITERATIONS; iteration += 1) {
    const forward = multiplyForward(matrix, subspace, width, rows)
    subspace = multiplyTranspose(matrix, forward, width, rows, columnCount)
    orthonormalizeColumns(subspace, columnCount, width)
    log(`semantic-index: power iteration ${iteration + 1}/${POWER_ITERATIONS}`)
  }

  // With Z spanning the leading right-singular subspace, M = X·Z reduces the
  // problem to the width×width Gram matrix, whose eigenvectors rotate Z onto
  // the actual singular directions.
  const projected = multiplyForward(matrix, subspace, width, rows)
  const gram = new Float64Array(width * width)
  for (let row = 0; row < rows; row += 1) {
    const base = row * width
    for (let i = 0; i < width; i += 1) {
      const value = projected[base + i]
      if (value === 0) continue
      for (let j = i; j < width; j += 1) gram[i * width + j] += value * projected[base + j]
    }
  }
  for (let i = 0; i < width; i += 1) {
    for (let j = i + 1; j < width; j += 1) gram[j * width + i] = gram[i * width + j]
  }
  const { values: eigenvalues, vectors: eigenvectors } = jacobiEigen(gram, width)

  const projection = new Float64Array(columnCount * dims)
  for (let k = 0; k < dims; k += 1) {
    const rotation = eigenvectors[k]
    for (let term = 0; term < columnCount; term += 1) {
      let sum = 0
      const base = term * width
      for (let i = 0; i < width; i += 1) sum += subspace[base + i] * rotation[i]
      projection[term * dims + k] = sum
    }
  }
  // An eigenvector is only defined up to sign. Pinning the sign of the largest
  // component keeps the artefact stable against sign flips introduced by
  // rounding differences between machines.
  for (let k = 0; k < dims; k += 1) {
    let peak = 0
    let peakValue = 0
    for (let term = 0; term < columnCount; term += 1) {
      const value = projection[term * dims + k]
      if (Math.abs(value) > peak) {
        peak = Math.abs(value)
        peakValue = value
      }
    }
    if (peakValue >= 0) continue
    for (let term = 0; term < columnCount; term += 1) projection[term * dims + k] *= -1
  }

  // Documents live at X·V, the same linear map the query will be folded through.
  const documentVectors = new Float64Array(rows * dims)
  for (let row = 0; row < rows; row += 1) {
    const outBase = row * dims
    for (let i = matrix.rowStart[row]; i < matrix.rowStart[row + 1]; i += 1) {
      const value = matrix.values[i]
      const projBase = matrix.columns[i] * dims
      for (let k = 0; k < dims; k += 1) documentVectors[outBase + k] += value * projection[projBase + k]
    }
  }

  const singularValues = Array.from(eigenvalues.slice(0, dims), (value) => Math.sqrt(Math.max(value, 0)))
  const totalEnergy = Array.from(eigenvalues, (value) => Math.max(value, 0)).reduce((a, b) => a + b, 0)
  const keptEnergy = eigenvalues.slice(0, dims).reduce((a, b) => a + Math.max(b, 0), 0)
  const explained = totalEnergy > 0 ? keptEnergy / totalEnergy : 0

  const { quantised: projectionQ, scales: projectionScales } = quantiseWithRowScales(projection, columnCount, dims)
  const docsQ = quantiseRowDirections(documentVectors, rows, dims)
  const probeHash = analyzerProbeHash(vocabularyIndex)

  const bytes = encodeIndex({
    vocabulary,
    idf,
    projection: projectionQ,
    projectionScales,
    docIds: documents.map((document) => document.id),
    docs: docsQ,
    dims,
    probeHash,
  })

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    schemaVersion: FORMAT_VERSION,
    version: corpus.version,
    dims,
    vocabSize: vocabulary.length,
    docCount: rows,
    file: `semantic-index.${corpus.version}.bin`,
    bytes: bytes.byteLength,
    sha256: `sha256:${sha256}`,
    /**
     * The catalog build this index was derived from, not the moment the tool
     * ran. A wall clock here would make two builds of the same input differ,
     * which is exactly the property the determinism test forbids.
     */
    builtAt: corpus.generatedAt,
    analyzer: {
      ngram: ANALYZER.ngram,
      charGramWeight: ANALYZER.charGramWeight,
      minDocFrequency: ANALYZER.minDocFrequency,
      probeHash,
    },
    /** Diagnostics: how much of the catalog's variance the truncation kept. */
    spectrum: {
      explainedVarianceRatio: Number(explained.toFixed(6)),
      largestSingularValue: Number(singularValues[0].toFixed(6)),
      smallestKeptSingularValue: Number(singularValues[dims - 1].toFixed(6)),
    },
  }

  const outDirectory = path.resolve(settings.out)
  await mkdir(outDirectory, { recursive: true })
  const binaryPath = path.join(outDirectory, manifest.file)
  const manifestPath = path.join(outDirectory, `semantic-index.${corpus.version}.json`)
  await writeFile(binaryPath, bytes)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(
    `semantic-index: ${manifest.file} — ${(bytes.byteLength / 1e6).toFixed(2)} MB, ` +
      `${dims} dims, ${(explained * 100).toFixed(1)}% variance kept`,
  )
  return { manifest, manifestPath, binaryPath, bytes }
}

function parseArguments(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--catalog': options.catalog = value; i += 1; break
      case '--out': options.out = value; i += 1; break
      case '--input': options.input = value; i += 1; break
      case '--version': options.version = value; i += 1; break
      case '--dims': options.dims = Number(value); i += 1; break
      case '--quiet': options.quiet = true; break
      default:
        throw new Error(`Unknown option ${flag}. See the usage comment at the top of tools/semantic-index.mjs.`)
    }
  }
  return options
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await buildSemanticIndex(parseArguments(process.argv.slice(2)))
}
