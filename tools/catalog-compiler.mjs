#!/usr/bin/env node
/**
 * Brickwright catalog compiler.
 *
 * Joins three independently licensed datasets into immutable runtime assets:
 *
 *   LDraw Parts Library    geometry truth  (meshes, bounds, colour table)
 *   LDCad Shadow Library   connection truth (snap metadata)
 *   Rebrickable bulk CSV   identity truth  (names, categories, colour evidence)
 *
 * No network requests occur here. Each compiled field carries provenance so the
 * running application can state what it actually knows rather than implying
 * uniform coverage.
 *
 * Outputs (see `--out`):
 *   catalog/<version>/manifest.json   counts, hashes, coverage, source pins
 *   catalog/<version>/search.json     compact record for every catalog identity
 *   catalog/<version>/parts.json      full records for the geometry runtime pack
 *   catalog/<version>/colors.json     LDraw colour table from LDConfig.ldr
 *   catalog/<version>/licenses.json   per-dataset attribution requirements
 *   catalog/<version>/coverage.json   honest per-field coverage measurements
 *   assets/geometry/<sha256>.bwmesh   packed geometry for pack parts
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileMesh } from './ldraw-mesh.mjs'
import { compileThumbnail } from './thumbnail.mjs'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const DEFAULT_PACK_SIZE = 420

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      result[token.slice(2)] = true
    } else {
      result[token.slice(2)] = next
      index += 1
    }
  }
  return result
}

async function walk(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else files.push(absolute)
    }
  }
  await visit(root)
  return files
}

const normalize = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '').trim().toLowerCase()
const numbers = (value = '') => value.trim().split(/\s+/).filter(Boolean).map(Number)
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// LDraw source access
// ---------------------------------------------------------------------------

/**
 * Indexes every `.dat` by its library-relative path. LDraw references are
 * resolved against `p/`, `parts/`, the library root and `models/` in that
 * order, which covers primitives, hi-res primitives, subparts and parts without
 * the trial-and-error directory probing the three.js loader warns about.
 */
function createSourceIndex(root, files) {
  const byPath = new Map()
  for (const absolute of files) byPath.set(normalize(path.relative(root, absolute)), absolute)
  const searchOrder = ['p/', 'parts/', '', 'models/']
  const resolved = new Map()
  return {
    byPath,
    locate(reference) {
      const key = normalize(reference)
      if (resolved.has(key)) return resolved.get(key)
      let found = null
      for (const prefix of searchOrder) {
        const absolute = byPath.get(`${prefix}${key}`)
        if (absolute) { found = absolute; break }
      }
      resolved.set(key, found)
      return found
    },
  }
}

function createTextReader(limit = 40_000) {
  const cache = new Map()
  return async (absolute) => {
    const cached = cache.get(absolute)
    if (cached !== undefined) return cached
    const text = await readFile(absolute, 'utf8')
    if (cache.size >= limit) cache.clear()
    cache.set(absolute, text)
    return text
  }
}

// ---------------------------------------------------------------------------
// LDraw colour table
// ---------------------------------------------------------------------------

/** Parses `LDConfig.ldr`, the authoritative LDraw colour definition file. */
function parseColourTable(source) {
  const colours = []
  for (const raw of source.split(/\r?\n/)) {
    const match = raw.match(/^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[0-9A-Fa-f]{6})\s+EDGE\s+(#[0-9A-Fa-f]{6})(.*)$/)
    if (!match) continue
    const trailing = match[5] ?? ''
    const alpha = trailing.match(/ALPHA\s+(\d+)/i)
    const material = trailing.match(/MATERIAL\s+(\S+)/i)
    colours.push({
      code: Number(match[2]),
      name: match[1].replaceAll('_', ' '),
      hex: match[3].toLowerCase(),
      edge: match[4].toLowerCase(),
      alpha: alpha ? Number(alpha[1]) / 255 : 1,
      finish: material ? material[1].toLowerCase() : /CHROME|PEARLESCENT|METAL|RUBBER/i.exec(trailing)?.[0]?.toLowerCase() ?? 'solid',
    })
  }
  return colours.sort((a, b) => a.code - b.code)
}

/**
 * Crosswalks Rebrickable colour ids onto LDraw colour codes. Names are matched
 * first because both catalogs derive them from the same LEGO nomenclature; RGB
 * equality is the fallback. Unmatched ids are reported, never guessed.
 */
function crosswalkColours(ldrawColours, rebrickableColours) {
  // LDraw spells the greys the British way and Rebrickable the American way, so
  // the comparison key folds the two together. Without this the two most common
  // structural colours in the entire system fail to cross-reference.
  const key = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/grey/g, 'gray')
  const byName = new Map(ldrawColours.map((colour) => [key(colour.name), colour.code]))
  const byHex = new Map()
  for (const colour of ldrawColours) if (!byHex.has(colour.hex)) byHex.set(colour.hex, colour.code)

  const mapping = new Map()
  const unmatched = []
  for (const row of rebrickableColours) {
    const id = Number(row.id)
    if (!Number.isFinite(id) || id < 0) continue
    const code = byName.get(key(row.name)) ?? byHex.get(`#${String(row.rgb).toLowerCase()}`)
    if (code === undefined) unmatched.push({ id, name: row.name })
    else mapping.set(id, code)
  }
  return { mapping, unmatched }
}

// ---------------------------------------------------------------------------
// LDCad Shadow Library connection metadata
// ---------------------------------------------------------------------------

function multiplyMatrix(a, b) {
  const output = new Array(9).fill(0)
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let index = 0; index < 3; index += 1) output[row * 3 + column] += a[row * 3 + index] * b[index * 3 + column]
    }
  }
  return output
}

function transformPoint(point, matrix = IDENTITY, position = [0, 0, 0]) {
  return [
    position[0] + matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2],
    position[1] + matrix[3] * point[0] + matrix[4] * point[1] + matrix[5] * point[2],
    position[2] + matrix[6] * point[0] + matrix[7] * point[1] + matrix[8] * point[2],
  ]
}

function parseType1(line) {
  const tokens = line.trim().split(/\s+/)
  if (tokens[0] !== '1' || tokens.length < 15) return null
  return {
    position: tokens.slice(2, 5).map(Number),
    matrix: tokens.slice(5, 14).map(Number),
    reference: normalize(tokens.slice(14).join(' ')),
  }
}

function parseOptions(line) {
  const options = {}
  for (const match of line.matchAll(/\[([^=\]]+)=([^\]]*)\]/g)) options[match[1].trim().toLowerCase()] = match[2].trim()
  return options
}

/** Expands an LDCad `grid` option into individual connector offsets. */
function parseGrid(value) {
  if (!value) return [{ x: 0, z: 0 }]
  const tokens = value.trim().split(/\s+/)
  const readCount = (index) => {
    const centered = String(tokens[index]).toUpperCase() === 'C'
    return { centered, count: Number(tokens[index + (centered ? 1 : 0)]), next: index + (centered ? 2 : 1) }
  }
  const x = readCount(0)
  const z = readCount(x.next)
  if (!Number.isFinite(x.count) || !Number.isFinite(z.count) || x.count <= 0 || z.count <= 0) return [{ x: 0, z: 0 }]
  const xStep = Number(tokens[z.next] ?? 0)
  const zStep = Number(tokens[z.next + 1] ?? 0)
  const result = []
  for (let xi = 0; xi < x.count; xi += 1) {
    for (let zi = 0; zi < z.count; zi += 1) {
      result.push({
        x: (xi - (x.centered ? (x.count - 1) / 2 : 0)) * xStep,
        z: (zi - (z.centered ? (z.count - 1) / 2 : 0)) * zStep,
      })
    }
  }
  return result.length ? result : [{ x: 0, z: 0 }]
}

const gender = (value = 'M') => (value.toUpperCase().startsWith('F') ? 'female' : 'male')

/**
 * Parses an LDCad `secs` cross-section descriptor.
 *
 * Sections are `<shape> <radius> <length>` triples, repeated to describe a
 * profile: `R 8 2   R 6 16   R 8 2` is a chamfered round bore. Shapes observed
 * across the Shadow Library are `R` round, `S` square, `A` cross-axle and
 * `L_`/`_L` lip markers on a male shaft.
 */
function parseSections(value = '') {
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  const sections = []
  for (let index = 0; index + 2 < tokens.length + 1; index += 3) {
    const shape = tokens[index]
    if (!shape || /^[-0-9.]/.test(shape)) break
    sections.push({ shape: shape.toUpperCase(), radius: Number(tokens[index + 1]), length: Number(tokens[index + 2]) })
  }
  return sections
}

/**
 * Maps an LDCad snap meta onto Brickwright's normalized connector families.
 *
 * The rules below follow conventions measured across the Shadow Library rather
 * than guessed:
 *
 *   `R 6 4` / `S 6 4`            System stud interface (1,637 + 722 uses)
 *   `R 6 20`                     brick underside tube, still a stud interface
 *   `R 8 2 . R 6 16 . R 8 2`     Technic pin bore (128 uses), id `connhole`
 *   `L_ ... R 6 16 ... _L`       Technic pin shaft
 *   `A <r> <l>`                  cross axle (236 uses), id `axle` / `axlehole`
 *   `R 4 <l>`                    bar shaft; the mating clip declares `SNAP_CLP`
 *
 * A connector carrying a `group` that is not part of the System stud family
 * stays `generic`, so only a connector naming the same group can mate with it.
 * That is what keeps a turntable, a door hinge and a crane arm from being
 * treated as interchangeable just because their dimensions are similar.
 */
function classify(meta, options) {
  const type = meta.replace('SNAP_', '')
  const connectorGender = gender(options.gender ?? options.genderofs)
  const male = connectorGender === 'male'

  if (type === 'CLP') return { family: 'clip', gender: 'female' }
  if (type === 'FGR') return { family: 'hinge', gender: connectorGender }
  if (type === 'SPH') return { family: male ? 'ball' : 'socket', gender: connectorGender }
  if (type === 'GEN') {
    const signature = `${options.group ?? ''} ${options.bounding ?? ''}`.toLowerCase()
    if (signature.includes('ball') || signature.includes('sph')) return { family: male ? 'ball' : 'socket', gender: connectorGender }
    return { family: 'generic', gender: connectorGender, group: options.group }
  }

  const key = String(options.id ?? options.group ?? '').toLowerCase()
  const sections = parseSections(options.secs)

  if (key.startsWith('axlehole')) return { family: male ? 'axle' : 'axle-hole', gender: connectorGender }
  if (key === 'axle' || sections.some((section) => section.shape === 'A')) {
    return { family: male ? 'axle' : 'axle-hole', gender: connectorGender }
  }
  if (key.startsWith('connhol')) return { family: male ? 'pin' : 'pin-hole', gender: connectorGender }

  // A multi-section profile whose core is the 6-LDU Technic shaft is the pin /
  // pin-hole interface. Without this, a chamfered bore falls through to
  // anti-stud and a System stud would appear to mate with a Technic hole.
  if (sections.length >= 3 && sections.some((section) => Math.abs(section.radius - 6) < 0.5)) {
    return { family: male ? 'pin' : 'pin-hole', gender: connectorGender }
  }

  const primary = sections[0]
  if (key.includes('bar') || (primary && Number.isFinite(primary.radius) && primary.radius <= 4.5)) {
    return { family: male ? 'bar' : 'clip', gender: connectorGender }
  }

  // Named non-System interfaces stay group-gated.
  if (options.group && !/stud/.test(key)) {
    return { family: 'generic', gender: connectorGender, group: options.group }
  }

  return { family: male ? 'stud' : 'anti-stud', gender: connectorGender }
}

function directSnapFeatures(source, sourceName) {
  const features = []
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const match = raw.match(/^\s*0\s+!LDCAD\s+(SNAP_(?:CYL|CLP|FGR|GEN|SPH))\b/i)
    if (!match) continue
    const options = parseOptions(raw)
    const basePosition = numbers(options.pos)
    const orientation = numbers(options.ori)
    const classified = classify(match[1].toUpperCase(), options)
    for (const [gridIndex, offset] of parseGrid(options.grid).entries()) {
      features.push({
        id: options.id ? `${options.id}_${gridIndex}` : `${sourceName}_${lineIndex}_${gridIndex}`,
        family: classified.family,
        gender: classified.gender,
        frame: {
          position: [(basePosition[0] ?? 0) + offset.x, basePosition[1] ?? 0, (basePosition[2] ?? 0) + offset.z],
          matrix: orientation.length === 9 ? orientation : IDENTITY,
        },
        profile: options.secs ?? options.bounding ?? `${options.radius ?? ''} ${options.length ?? ''}`.trim(),
        group: classified.group || options.group || undefined,
        axialRange: options.length ? Number(options.length) : undefined,
        allowsSlide: options.slide === 'true',
        allowsRotation:
          classified.family === 'pin' ||
          classified.family === 'bar' ||
          classified.family === 'hinge' ||
          options.placement === 'free',
        confidence: 1,
        source: 'ldcad-authoritative',
        inheritanceId: options.id || undefined,
      })
    }
  }
  return features
}

function transformFeature(feature, placement, idPrefix = '') {
  return {
    ...feature,
    id: idPrefix ? `${idPrefix}_${feature.id}` : feature.id,
    frame: {
      position: transformPoint(feature.frame.position, placement.matrix, placement.position),
      matrix: multiplyMatrix(placement.matrix, feature.frame.matrix),
    },
  }
}

/**
 * Resolves a part's full connector set: features inherited through its LDraw
 * sub-file tree, plus the shadow file's own `SNAP_*` metas, with `SNAP_INCL`
 * expansion and `SNAP_CLEAR` suppression applied in declaration order.
 */
function createConnectionResolver(ldrawSources, shadowSources, readText) {
  const cache = new Map()

  const resolveShadow = async (reference, stack) => {
    const absolute = shadowSources.locate(reference)
    if (!absolute || stack.has(`shadow:${absolute}`)) return []
    stack.add(`shadow:${absolute}`)
    const source = await readText(absolute)
    let features = []
    for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
      if (/^\s*0\s+!LDCAD\s+SNAP_CLEAR\b/i.test(raw)) {
        const id = parseOptions(raw).id
        features = id ? features.filter((feature) => feature.inheritanceId !== id) : []
      }
      if (/^\s*0\s+!LDCAD\s+SNAP_(?:CYL|CLP|FGR|GEN|SPH)\b/i.test(raw)) {
        features.push(...directSnapFeatures(raw, path.basename(reference, '.dat')))
      }
      if (/^\s*0\s+!LDCAD\s+SNAP_INCL\b/i.test(raw)) {
        const options = parseOptions(raw)
        const child = await resolveShadow(options.ref, stack)
        const position = numbers(options.pos)
        const matrix = numbers(options.ori)
        for (const [gridIndex, offset] of parseGrid(options.grid).entries()) {
          const placement = {
            position: [(position[0] ?? 0) + offset.x, position[1] ?? 0, (position[2] ?? 0) + offset.z],
            matrix: matrix.length === 9 ? matrix : IDENTITY,
          }
          features.push(...child.map((feature) => transformFeature(feature, placement, `incl${lineIndex}_${gridIndex}`)))
        }
      }
    }
    stack.delete(`shadow:${absolute}`)
    return features
  }

  const resolve = async (reference, stack = new Set()) => {
    const normalized = normalize(reference)
    if (cache.has(normalized)) return cache.get(normalized)
    const absolute = ldrawSources.locate(normalized)
    if (!absolute || stack.has(absolute)) return []
    stack.add(absolute)
    let inherited = []
    for (const [lineIndex, raw] of (await readText(absolute)).split(/\r?\n/).entries()) {
      const childRef = parseType1(raw)
      if (!childRef) continue
      const childFeatures = await resolve(childRef.reference, stack)
      inherited.push(...childFeatures.map((feature) => transformFeature(feature, childRef, `ref${lineIndex}`)))
    }
    if (shadowSources.locate(normalized)) {
      for (const raw of (await readText(shadowSources.locate(normalized))).split(/\r?\n/)) {
        if (!/^\s*0\s+!LDCAD\s+SNAP_CLEAR\b/i.test(raw)) continue
        const id = parseOptions(raw).id
        inherited = id ? inherited.filter((feature) => feature.inheritanceId !== id) : []
      }
      inherited.push(...(await resolveShadow(normalized, new Set())))
    }
    stack.delete(absolute)
    const unique = Array.from(
      new Map(
        inherited.map((feature) => [
          JSON.stringify([feature.family, feature.gender, feature.frame.position.map((v) => Math.round(v * 100)), feature.group]),
          feature,
        ]),
      ).values(),
    )
    // Ids must be unique within a part: the runtime keys connector occupancy by
    // `partId/featureId`, so a collision would silently merge two joints.
    const used = new Set()
    for (const feature of unique) {
      let id = feature.id
      let suffix = 1
      while (used.has(id)) id = `${feature.id}#${suffix++}`
      used.add(id)
      feature.id = id
    }
    cache.set(normalized, unique)
    return unique
  }

  return resolve
}

// ---------------------------------------------------------------------------
// Rebrickable bulk CSV
// ---------------------------------------------------------------------------

function parseCsv(source) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] ?? '\n'
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1 } else quoted = !quoted
    } else if (character === ',' && !quoted) { row.push(field); field = '' }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(field); field = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else field += character
  }
  if (!rows.length) return []
  const headers = rows.shift().map((header) => header.trim())
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

/**
 * Streams `inventory_parts.csv` (over a million rows) rather than loading it,
 * accumulating per-part colour evidence and set-appearance frequency. Frequency
 * is what makes runtime pack selection principled instead of hand-picked.
 */
async function streamInventory(file, colourCrosswalk) {
  const coloursByPart = new Map()
  const frequency = new Map()
  const stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  let headers = null
  for await (const line of stream) {
    if (!headers) { headers = line.split(','); continue }
    // `part_num,color_id,quantity` are the leading unquoted columns; the trailing
    // img_url may contain commas, so index from the left only.
    const first = line.indexOf(',')
    const second = line.indexOf(',', first + 1)
    const third = line.indexOf(',', second + 1)
    if (first < 0 || second < 0 || third < 0) continue
    const partNum = normalize(line.slice(first + 1, second))
    const colourId = Number(line.slice(second + 1, third))
    const ldrawCode = colourCrosswalk.get(colourId)
    if (ldrawCode !== undefined) {
      const set = coloursByPart.get(partNum)
      if (set) set.add(ldrawCode)
      else coloursByPart.set(partNum, new Set([ldrawCode]))
    }
    frequency.set(partNum, (frequency.get(partNum) ?? 0) + 1)
  }
  return { coloursByPart, frequency }
}

async function loadRebrickable(root, ldrawColours) {
  const empty = {
    parts: new Map(),
    categories: new Map(),
    relationships: new Map(),
    coloursByPart: new Map(),
    frequency: new Map(),
    elementsByPart: new Map(),
    colourCrosswalk: new Map(),
    unmatchedColours: [],
    available: false,
  }
  if (!root) return empty
  const readCsv = async (name) => {
    try { return parseCsv(await readFile(path.join(root, name), 'utf8')) } catch { return [] }
  }
  const [partRows, categoryRows, elementRows, colourRows, relationshipRows] = await Promise.all([
    readCsv('parts.csv'), readCsv('part_categories.csv'), readCsv('elements.csv'), readCsv('colors.csv'), readCsv('part_relationships.csv'),
  ])
  if (!partRows.length) return empty

  const { mapping: colourCrosswalk, unmatched: unmatchedColours } = crosswalkColours(ldrawColours, colourRows)
  const elementsByPart = new Map()
  for (const row of elementRows) {
    const key = normalize(row.part_num)
    const entries = elementsByPart.get(key) ?? []
    entries.push({ elementId: row.element_id, colourId: Number(row.color_id), designId: row.design_id || row.part_num })
    elementsByPart.set(key, entries)
  }

  let inventory = { coloursByPart: new Map(), frequency: new Map() }
  try {
    inventory = await streamInventory(path.join(root, 'inventory_parts.csv'), colourCrosswalk)
  } catch {
    // Colour evidence stays empty rather than being inferred.
  }

  return {
    parts: new Map(partRows.map((row) => [normalize(row.part_num), row])),
    categories: new Map(categoryRows.map((row) => [row.id, row.name])),
    relationships: new Map(relationshipRows.map((row) => [normalize(row.child_part_num), normalize(row.parent_part_num)])),
    coloursByPart: inventory.coloursByPart,
    frequency: inventory.frequency,
    elementsByPart,
    colourCrosswalk,
    unmatchedColours,
    available: true,
  }
}

/** LDraw appends decoration and mould-variant suffixes to a base design number. */
const BASE_SUFFIX = /(?:p[0-9a-z]{1,4}|pr[0-9]+|pat[0-9a-z]*|c[0-9]{2}|d[0-9]{2})$/

/**
 * Resolves an LDraw part id onto a Rebrickable identity.
 *
 * Exact id equality is the only match treated as authoritative. A decoration
 * suffix can be stripped to reach the undecorated base design, but that only
 * licenses inheriting the *category* — never colour production evidence, since
 * a printed variant exists in its own, much narrower set of colours.
 */
function crosswalkIdentity(canonicalId, rb) {
  const exact = rb.parts.get(canonicalId)
  if (exact) return { row: exact, confidence: 'exact', baseId: null }

  const related = rb.relationships.get(canonicalId)
  if (related && rb.parts.get(related)) return { row: rb.parts.get(related), confidence: 'heuristic', baseId: related }

  const base = canonicalId.replace(BASE_SUFFIX, '')
  if (base !== canonicalId && rb.parts.get(base)) return { row: rb.parts.get(base), confidence: 'heuristic', baseId: base }

  return { row: null, confidence: 'none', baseId: null }
}

// ---------------------------------------------------------------------------
// Part identity
// ---------------------------------------------------------------------------

function ldrawHeader(source) {
  const lines = source.split(/\r?\n/, 40)
  const title = lines.find((line) => /^0\s+[^!]/.test(line))?.replace(/^0\s+/, '').trim() ?? 'Unnamed LDraw part'
  const orgLine = lines.find((line) => /!LDRAW_ORG/.test(line)) ?? ''
  const licenseLine = lines.find((line) => /!LICENSE/.test(line)) ?? ''
  const kind = /!LDRAW_ORG\s+(?:Unofficial_)?(\w+)/.exec(orgLine)?.[1] ?? ''
  return {
    title,
    kind,
    license: /CC BY 4\.0/i.test(licenseLine) ? 'CC-BY-4.0' : /CC BY 2\.0/i.test(licenseLine) ? 'CC-BY-2.0' : /CC0/i.test(licenseLine) ? 'CC0-1.0' : 'unspecified',
    // Shortcuts are assembled real parts (hinges, doors) and belong in the
    // catalog; subparts and primitives are construction detail and do not.
    isPart: /^(Part|Shortcut)$/i.test(kind),
    isAlias: /^~?Moved to/i.test(title) || /^=/.test(title),
    // LDraw renames parts across updates and leaves an alias file behind. The
    // old number stays in circulation for decades, so the rename target is
    // captured rather than discarded.
    movedTo: /^~?Moved to\s+(\S+)/i.exec(title)?.[1]?.toLowerCase() ?? null,
    // LDraw marks parts that exist only to be referenced by other parts with a
    // leading tilde. They stay in the catalog for traceability but are hidden
    // from default search so neither operator builds with them by accident.
    isHelper: title.startsWith('~'),
  }
}

const STUDS = (ldu) => Number((ldu / 20).toFixed(3))

const isIdentity = (matrix) => matrix.every((value, index) => Math.abs(value - IDENTITY[index]) < 1e-6)

/**
 * Shrinks a compiled connector for shipping. LDCad authors snap positions on a
 * quarter-LDU grid, so four decimals is lossless in practice, and the identity
 * orientation — by far the most common — is omitted entirely.
 */
function trimConnector(feature) {
  const matrix = feature.frame.matrix.map((value) => Number(value.toFixed(4)))
  return {
    id: feature.id,
    family: feature.family,
    gender: feature.gender,
    pos: feature.frame.position.map((value) => Number(value.toFixed(4))),
    ...(isIdentity(matrix) ? {} : { ori: matrix }),
    ...(feature.group ? { group: feature.group } : {}),
    ...(feature.axialRange ? { axial: feature.axialRange } : {}),
    ...(feature.allowsSlide ? { slide: true } : {}),
    ...(feature.allowsRotation ? { rotate: true } : {}),
    src: feature.source === 'ldcad-authoritative' ? 'ldcad' : feature.source,
  }
}

/** Derives search facets a language model can filter on without part-number recall. */
function searchFeatures(record) {
  const tags = new Set()
  const name = record.name.toLowerCase()
  for (const word of name.split(/[^a-z0-9]+/).filter((token) => token.length > 2)) tags.add(word)
  const families = new Set(record.connectors.map((feature) => feature.family))
  for (const family of families) tags.add(family)
  if (record.dimensions) {
    const [w, h, d] = record.dimensions.studs
    if (Math.abs(w - d) < 0.01) tags.add('square')
    if (h <= 0.5) tags.add('flat')
  }
  return { tags: Array.from(tags), connectorFamilies: Array.from(families) }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export async function compileCatalog(options) {
  const {
    ldraw,
    shadow,
    rebrickable,
    out,
    version = 'local',
    packSize = DEFAULT_PACK_SIZE,
    packExtra = [],
    quiet = false,
  } = options
  if (!ldraw || !out) {
    throw new Error(
      'Usage: catalog-compiler --ldraw <library> [--shadow <LDCadShadowLibrary>] [--rebrickable <csv-dir>] --out <dir> [--version <id>] [--pack-size <n>]',
    )
  }

  const log = (message) => { if (!quiet) process.stderr.write(`${message}\n`) }
  const ldrawRoot = path.resolve(ldraw)
  const allFiles = await walk(ldrawRoot)
  const datFiles = allFiles.filter((file) => file.toLowerCase().endsWith('.dat'))
  const ldrawSources = createSourceIndex(ldrawRoot, datFiles)
  const readText = createTextReader()

  const shadowRoot = shadow ? path.resolve(shadow) : null
  const shadowFiles = shadowRoot ? (await walk(shadowRoot)).filter((file) => file.toLowerCase().endsWith('.dat')) : []
  const shadowSources = createSourceIndex(shadowRoot ?? ldrawRoot, shadowFiles)
  const resolveConnections = createConnectionResolver(ldrawSources, shadowSources, readText)

  const colourSource = allFiles.find((file) => path.basename(file).toLowerCase() === 'ldconfig.ldr')
  const ldrawColours = colourSource ? parseColourTable(await readFile(colourSource, 'utf8')) : []
  log(`colours: ${ldrawColours.length} LDraw definitions`)

  const rb = await loadRebrickable(rebrickable ? path.resolve(rebrickable) : null, ldrawColours)
  log(`rebrickable: ${rb.available ? `${rb.parts.size} identities, ${rb.colourCrosswalk.size} colour mappings` : 'not supplied'}`)

  // -- Pass 1: identity + connectors for every official LDraw part -----------
  const partFiles = datFiles.filter((file) => {
    const relative = normalize(path.relative(ldrawRoot, file))
    return relative.startsWith('parts/') && !relative.startsWith('parts/s/')
  })

  const records = []
  const aliases = {}
  const licenseCounts = new Map()
  let processed = 0
  for (const absolute of partFiles) {
    const relative = normalize(path.relative(ldrawRoot, absolute))
    const source = await readText(absolute)
    const header = ldrawHeader(source)
    processed += 1
    if (processed % 4000 === 0) log(`identity pass: ${processed}/${partFiles.length}`)
    if (!header.isPart || header.isAlias) {
      if (header.movedTo) aliases[relative.replace(/^parts\//, '').replace(/\.dat$/, '')] = header.movedTo.replace(/\.dat$/, '')
      continue
    }

    const ldrawId = relative.replace(/^parts\//, '')
    const canonicalId = ldrawId.replace(/\.dat$/, '')
    const identity = crosswalkIdentity(canonicalId, rb)
    const connectors = await resolveConnections(relative)
    const elements = rb.elementsByPart.get(canonicalId) ?? []
    licenseCounts.set(header.license, (licenseCounts.get(header.license) ?? 0) + 1)

    records.push({
      canonicalId,
      ldrawId,
      // An exact identity match supplies the catalog's own product name; a
      // heuristic base match must not rename a decorated variant.
      name: (identity.confidence === 'exact' ? identity.row?.name : null) || header.title,
      category: rb.categories.get(identity.row?.part_cat_id) || 'Unclassified',
      kind: header.kind,
      helper: header.isHelper,
      identity: {
        rebrickableId: identity.confidence === 'exact' ? identity.row.part_num : null,
        baseRebrickableId: identity.baseId,
        identityConfidence: identity.confidence,
        legoDesignIds: Array.from(new Set(elements.map((entry) => entry.designId).filter(Boolean))).slice(0, 8),
        legoElementIds: Array.from(new Set(elements.map((entry) => entry.elementId).filter(Boolean))).slice(0, 12),
        bricklinkIds: [],
      },
      availableColors: Array.from(rb.coloursByPart.get(canonicalId) ?? []).sort((a, b) => a - b),
      frequency: rb.frequency.get(canonicalId) ?? 0,
      dimensions: null,
      geometryStatus: 'uncompiled',
      geometryAsset: null,
      thumbnail: null,
      connectionStatus: connectors.length ? 'ldcad-authoritative' : 'missing',
      connectors: connectors.map(trimConnector),
      license: header.license,
      provenance: {
        geometry: `LDraw:${version}:${ldrawId}`,
        connections: connectors.length ? `LDCadShadowLibrary:${ldrawId}` : null,
        catalog: identity.row ? `Rebrickable:${identity.row.part_num}:${identity.confidence}` : null,
        colors: rb.coloursByPart.has(canonicalId) ? 'Rebrickable:inventory_parts' : null,
      },
    })
  }
  records.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId, undefined, { numeric: true }))

  // Collapse chained renames (a → b → c) and discard aliases whose target is
  // not itself a live catalog identity.
  const liveIds = new Set(records.map((record) => record.canonicalId))
  const resolvedAliases = {}
  for (const from of Object.keys(aliases)) {
    let to = aliases[from]
    for (let hop = 0; hop < 8 && aliases[to]; hop += 1) to = aliases[to]
    if (liveIds.has(to) && !liveIds.has(from)) resolvedAliases[from] = to
  }
  log(`identity pass complete: ${records.length} catalog parts, ${Object.keys(resolvedAliases).length} renamed aliases`)

  // An LDraw rename is an authoritative statement that two part numbers denote
  // the same physical element. External catalogs often still list the retired
  // number, so a live record with no identity of its own adopts the retired
  // number's identity, colour evidence and usage frequency at exact confidence.
  const retiredByTarget = new Map()
  for (const [from, to] of Object.entries(resolvedAliases)) {
    const bucket = retiredByTarget.get(to)
    if (bucket) bucket.push(from)
    else retiredByTarget.set(to, [from])
  }
  let adoptedFromRenames = 0
  for (const record of records) {
    if (record.identity.identityConfidence !== 'none') continue
    for (const retired of retiredByTarget.get(record.canonicalId) ?? []) {
      const row = rb.parts.get(retired)
      if (!row) continue
      record.name = row.name || record.name
      record.category = rb.categories.get(row.part_cat_id) || record.category
      record.identity.rebrickableId = row.part_num
      record.identity.identityConfidence = 'exact'
      record.availableColors = Array.from(rb.coloursByPart.get(retired) ?? []).sort((a, b) => a - b)
      record.frequency = rb.frequency.get(retired) ?? record.frequency
      record.provenance.catalog = `Rebrickable:${row.part_num}:ldraw-rename:${retired}`
      if (record.availableColors.length) record.provenance.colors = 'Rebrickable:inventory_parts'
      adoptedFromRenames += 1
      break
    }
  }
  log(`rename crosswalk: ${adoptedFromRenames} records adopted identity from a retired number`)

  // -- Pass 2: geometry for the runtime pack --------------------------------
  const byId = new Map(records.map((record) => [record.canonicalId, record]))
  const forced = new Set(packExtra.map((id) => String(id).toLowerCase()))
  // The runtime pack is the most-used parts Brickwright can actually verify:
  // authoritative connection metadata is required, so every packed part can be
  // snapped, validated and reasoned about rather than merely displayed.
  const ranked = records
    .filter((record) => !forced.has(record.canonicalId) && !record.helper && record.connectionStatus === 'ldcad-authoritative')
    .sort((a, b) => b.frequency - a.frequency || a.canonicalId.localeCompare(b.canonicalId))
  const pack = [
    ...Array.from(forced).map((id) => byId.get(id)).filter(Boolean),
    ...ranked.slice(0, Math.max(0, packSize - forced.size)),
  ]
  log(`geometry pass: compiling ${pack.length} parts`)

  const outputRoot = path.resolve(out)
  const geometryDirectory = path.join(outputRoot, 'assets', 'geometry')
  const thumbnailDirectory = path.join(outputRoot, 'assets', 'thumb')
  await mkdir(geometryDirectory, { recursive: true })
  await mkdir(thumbnailDirectory, { recursive: true })

  const parseCache = new Map()
  const syncResolve = (reference) => {
    const absolute = ldrawSources.locate(reference)
    if (!absolute) return null
    const text = syncResolve.cache.get(absolute)
    return text === undefined ? null : { text, key: absolute }
  }
  syncResolve.cache = new Map()

  const missingReferences = new Set()
  let geometryBytes = 0
  let thumbnailBytes = 0
  let triangleTotal = 0
  let compiled = 0
  let thumbnails = 0

  for (const record of pack) {
    // Warm every file the part can reach so the mesh compiler stays synchronous.
    await warmDependencies(`parts/${record.ldrawId}`, ldrawSources, readText, syncResolve.cache)
    const mesh = compileMesh(`parts/${record.ldrawId}`, syncResolve, { parseCache })
    if (!mesh) {
      record.geometryStatus = 'missing'
      continue
    }
    for (const reference of mesh.missing) missingReferences.add(reference)
    const assetName = `${mesh.hash}.bwmesh`
    await writeFile(path.join(geometryDirectory, assetName), mesh.buffer)
    record.geometryStatus = mesh.missing.length ? 'partial' : 'certified'
    record.geometryAsset = { hash: `sha256:${mesh.hash}`, file: `assets/geometry/${assetName}`, bytes: mesh.buffer.length, ...mesh.stats }
    record.dimensions = {
      ldu: [mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[1] - mesh.bounds.min[1], mesh.bounds.max[2] - mesh.bounds.min[2]],
      studs: [
        STUDS(mesh.bounds.max[0] - mesh.bounds.min[0]),
        Number(((mesh.bounds.max[1] - mesh.bounds.min[1]) / 8).toFixed(3)),
        STUDS(mesh.bounds.max[2] - mesh.bounds.min[2]),
      ],
      bounds: { min: mesh.bounds.min.map((v) => Number(v.toFixed(4))), max: mesh.bounds.max.map((v) => Number(v.toFixed(4))) },
    }
    geometryBytes += mesh.buffer.length
    triangleTotal += mesh.stats.triangles
    compiled += 1

    // Palette preview, rendered from the same compiled geometry so it can never
    // disagree with what the viewport draws.
    const thumbnail = compileThumbnail(decodeMeshBuffer(mesh.buffer), { size: 128 })
    if (thumbnail) {
      const thumbName = `${thumbnail.hash}.png`
      await writeFile(path.join(thumbnailDirectory, thumbName), thumbnail.buffer)
      record.thumbnail = {
        hash: `sha256:${thumbnail.hash}`,
        file: `assets/thumb/${thumbName}`,
        bytes: thumbnail.buffer.length,
        size: thumbnail.size,
      }
      thumbnailBytes += thumbnail.buffer.length
      thumbnails += 1
    }
    if (compiled % 50 === 0) log(`geometry pass: ${compiled}/${pack.length}`)
  }
  log(
    `geometry pass complete: ${compiled} meshes (${(geometryBytes / 1e6).toFixed(1)} MB), ` +
      `${thumbnails} thumbnails (${(thumbnailBytes / 1e6).toFixed(2)} MB)`,
  )

  for (const record of records) Object.assign(record, { search: searchFeatures(record) })

  // -- Emit ------------------------------------------------------------------
  const packRecords = pack.filter((record) => record.geometryAsset)
  const kindCounts = {}
  for (const record of records) kindCounts[record.kind] = (kindCounts[record.kind] ?? 0) + 1

  const coverage = {
    catalogIdentities: records.length,
    byLdrawKind: kindCounts,
    helperParts: records.filter((record) => record.helper).length,
    withRebrickableIdentity: records.filter((record) => record.identity.identityConfidence === 'exact').length,
    withHeuristicIdentity: records.filter((record) => record.identity.identityConfidence === 'heuristic').length,
    withCategory: records.filter((record) => record.category !== 'Unclassified').length,
    withColorEvidence: records.filter((record) => record.availableColors.length).length,
    withAuthoritativeConnections: records.filter((record) => record.connectionStatus === 'ldcad-authoritative').length,
    connectorTotal: records.reduce((sum, record) => sum + record.connectors.length, 0),
    geometryCompiled: packRecords.length,
    geometryPartial: packRecords.filter((record) => record.geometryStatus === 'partial').length,
    geometryUncompiled: records.length - pack.length,
    unresolvedReferences: Array.from(missingReferences).slice(0, 50),
    unmatchedRebrickableColors: rb.unmatchedColours.length,
    renamedAliases: Object.keys(resolvedAliases).length,
    identityAdoptedFromRename: adoptedFromRenames,
    triangleTotal,
    geometryBytes,
    thumbnailsRendered: thumbnails,
    thumbnailBytes,
    ldrawLicenses: Object.fromEntries(licenseCounts),
  }

  const searchIndex = records.map((record) => ({
    id: record.canonicalId,
    n: record.name,
    c: record.category,
    d: record.dimensions?.studs ?? null,
    f: record.frequency,
    k: record.search.connectorFamilies,
    g: record.geometryStatus === 'certified' || record.geometryStatus === 'partial' ? 1 : 0,
    s: record.connectionStatus === 'ldcad-authoritative' ? 1 : 0,
    ...(record.helper ? { h: 1 } : {}),
  }))

  const catalogDirectory = path.join(outputRoot, 'catalog', version)
  await mkdir(catalogDirectory, { recursive: true })

  const partsPayload = JSON.stringify(packRecords)
  const aliasPayload = JSON.stringify(resolvedAliases)
  const searchPayload = JSON.stringify(searchIndex)
  const coloursPayload = JSON.stringify(ldrawColours)

  const manifest = {
    schemaVersion: 2,
    catalogVersion: version,
    generatedAt: new Date().toISOString(),
    sources: {
      ldraw: { root: path.basename(ldrawRoot), partFiles: partFiles.length, colorDefinitions: ldrawColours.length },
      ldcadShadow: shadowRoot ? { root: path.basename(shadowRoot), files: shadowFiles.length } : null,
      rebrickable: rb.available ? { identities: rb.parts.size, colorMappings: rb.colourCrosswalk.size } : null,
    },
    files: {
      parts: { path: `catalog/${version}/parts.json`, hash: `sha256:${sha256(partsPayload)}`, bytes: Buffer.byteLength(partsPayload) },
      search: { path: `catalog/${version}/search.json`, hash: `sha256:${sha256(searchPayload)}`, bytes: Buffer.byteLength(searchPayload) },
      colors: { path: `catalog/${version}/colors.json`, hash: `sha256:${sha256(coloursPayload)}`, bytes: Buffer.byteLength(coloursPayload) },
      aliases: { path: `catalog/${version}/aliases.json`, hash: `sha256:${sha256(aliasPayload)}`, bytes: Buffer.byteLength(aliasPayload) },
    },
    counts: {
      parts: records.length,
      packParts: packRecords.length,
      thumbnails,
      connectors: coverage.connectorTotal,
      colors: ldrawColours.length,
      aliases: Object.keys(resolvedAliases).length,
    },
    coverage,
  }
  const manifestPayload = `${JSON.stringify(manifest, null, 2)}\n`
  const manifestDescriptor = {
    path: `catalog/${version}/manifest.json`,
    hash: `sha256:${sha256(manifestPayload)}`,
    bytes: Buffer.byteLength(manifestPayload),
  }

  await Promise.all([
    // A short-TTL pointer: the runtime resolves the current revision here, then
    // treats every versioned file underneath it as immutable.
    writeFile(
      path.join(outputRoot, 'catalog', 'latest.json'),
      `${JSON.stringify({ catalogVersion: version, generatedAt: manifest.generatedAt, manifest: manifestDescriptor })}\n`,
    ),
    writeFile(path.join(catalogDirectory, 'parts.json'), partsPayload),
    writeFile(path.join(catalogDirectory, 'search.json'), searchPayload),
    writeFile(path.join(catalogDirectory, 'colors.json'), coloursPayload),
    writeFile(path.join(catalogDirectory, 'aliases.json'), aliasPayload),
    writeFile(path.join(catalogDirectory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`),
    writeFile(path.join(catalogDirectory, 'manifest.json'), manifestPayload),
    writeFile(
      path.join(catalogDirectory, 'licenses.json'),
      `${JSON.stringify(
        {
          note: 'Brickwright compiles third-party datasets. Attribution below is required for redistribution of the compiled assets.',
          datasets: [
            {
              dataset: 'LDraw Parts Library',
              use: 'part geometry, part identity, LDraw colour definitions',
              licensePerFile: true,
              observedLicenses: Object.fromEntries(licenseCounts),
              attribution: 'This software uses the LDraw Parts Library. LEGO is a trademark of the LEGO Group, which does not sponsor, endorse or authorize LDraw or Brickwright.',
            },
            ...(shadowRoot
              ? [{
                  dataset: 'LDCad Shadow Library',
                  use: 'connection/snap metadata',
                  license: 'CC-BY-SA-4.0',
                  attribution: 'Connection metadata derived from the LDCad Shadow Library by Roland Melkert, licensed CC BY-SA 4.0.',
                  shareAlikeReviewRequired: true,
                }]
              : []),
            ...(rb.available
              ? [{
                  dataset: 'Rebrickable bulk catalog',
                  use: 'part names, categories, colour production evidence, usage frequency',
                  redistributionReviewRequired: true,
                  note: 'Redistribution rights for compiled derivatives are unspecified and must be reviewed against current Rebrickable terms before public deployment.',
                }]
              : []),
          ],
        },
        null,
        2,
      )}\n`,
    ),
  ])

  return manifest
}

/**
 * Reads back a packed `.bwmesh` for the thumbnail renderer.
 *
 * Decoding the buffer the compiler just wrote, rather than reusing the in-memory
 * intermediate, means the preview is rendered from exactly the bytes the browser
 * will fetch — a packing bug shows up as a wrong thumbnail rather than hiding.
 */
function decodeMeshBuffer(buffer) {
  const array = new Uint8Array(buffer)
  const view = new DataView(array.buffer, array.byteOffset, array.byteLength)
  const vertexCount = view.getUint32(32, true)
  const indexCount = view.getUint32(36, true)
  const sliceCount = view.getUint32(44, true)
  const slices = []
  for (let index = 0; index < sliceCount; index += 1) {
    const offset = 52 + index * 12
    slices.push({
      colour: view.getUint32(offset, true),
      start: view.getUint32(offset + 4, true),
      count: view.getUint32(offset + 8, true),
    })
  }
  let cursor = array.byteOffset + 52 + sliceCount * 12
  const positions = new Float32Array(array.buffer, cursor, vertexCount * 3)
  cursor += vertexCount * 12
  const normals = new Float32Array(array.buffer, cursor, vertexCount * 3)
  cursor += vertexCount * 12
  const indices = new Uint32Array(array.buffer, cursor, indexCount)
  return { positions, normals, indices, slices }
}

/** Depth-first warm of a part's reference closure into the synchronous cache. */
async function warmDependencies(reference, sources, readText, cache, depth = 0, seen = new Set()) {
  if (depth > 64) return
  const absolute = sources.locate(reference)
  if (!absolute || seen.has(absolute)) return
  seen.add(absolute)
  const text = await readText(absolute)
  cache.set(absolute, text)
  for (const raw of text.split(/\r?\n/)) {
    if (raw.charCodeAt(0) !== 49) continue // fast path: only type-1 lines
    const child = parseType1(raw)
    if (child) await warmDependencies(child.reference, sources, readText, cache, depth + 1, seen)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const manifest = await compileCatalog({
      ...args,
      packSize: args['pack-size'] ? Number(args['pack-size']) : undefined,
      packExtra: args['pack-extra'] ? String(args['pack-extra']).split(',').map((id) => id.trim()).filter(Boolean) : [],
      quiet: Boolean(args.quiet),
    })
    console.log(
      `Brickwright catalog ${manifest.catalogVersion}: ${manifest.counts.parts} identities, ` +
      `${manifest.counts.packParts} compiled meshes, ${manifest.counts.connectors} connectors, ` +
      `${manifest.counts.colors} colours`,
    )
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.message}\n${cause.stack}` : cause)
    process.exitCode = 1
  }
}
