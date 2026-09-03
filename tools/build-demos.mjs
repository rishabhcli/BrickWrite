#!/usr/bin/env node
/**
 * Curated demo compiler.
 *
 * The landing page and the explorer are only worth anything if what they show is
 * the real product. So the demos are not fixtures written by hand: they are
 * authored in `tools/demos/`, programmatically, against the compiled catalog and
 * the real parametric assembly planners, and then put through exactly the same
 * gates the kernel applies to an operator's own model — triangle-confirmed
 * collision, the connection graph, derived build order, catalog membership and
 * statics.
 *
 * A demo that fails any of those does not enter the manifest. This build fails
 * instead, because shipping a "showcase" the kernel would reject is the single
 * most expensive kind of dishonesty a project like this can commit.
 *
 * This file is the pipeline. One demo is one module in `tools/demos/`, exporting
 * its own copy, camera, allowances and author function, so a demo can be
 * rewritten without touching the gates or any other demo.
 *
 *   node tools/build-demos.mjs [--check] [--only=id,id]
 *
 * `--check` writes to a temporary tree and diffs it against the committed one,
 * which is how the determinism gate is asserted. `--only` builds a subset and
 * leaves the manifest alone, for iterating on one demo.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

import {
  AUTHORED_AT,
  PLATE_LDU,
  ROOT,
  STUD_LDU,
  analyseStatics,
  catalog,
  catalogManifest,
  closeKernel,
  computeBuildOrder,
  deriveConnectionEdges,
  describeMass,
  describeSupport,
  findCollisions,
  findWeakAttachments,
  frameScene,
  geometryProvider,
  getColor,
  getPartBounds,
  meshCache,
  renderScene,
  rgbFromHex,
  validateDocument,
  verifyBuildOrder,
  warmGeometry,
} from './demos/kernel.mjs'
import { HUMAN } from './demos/kit.mjs'

import blueWhaleMonument from './demos/blue-whale-monument.mjs'
import colossalDuck from './demos/colossal-duck.mjs'
import copperMammoth from './demos/copper-mammoth.mjs'
import harbourControlTower from './demos/harbour-control-tower.mjs'
import harbourStreet from './demos/harbour-street.mjs'
import illinoisMainQuad from './demos/illinois-main-quad.mjs'
import ironLatticeLookout from './demos/iron-lattice-lookout.mjs'
import meridianTower from './demos/meridian-tower.mjs'
import saucerFreighter from './demos/saucer-freighter.mjs'
import sunlineSuspensionBridge from './demos/sunline-suspension-bridge.mjs'

/**
 * The published collection, in the order the explorer lists it.
 *
 * Each entry is the default export of its own module: metadata and author
 * together, so the copy and the model it describes cannot drift apart.
 */
const DEMOS = [
  blueWhaleMonument,
  sunlineSuspensionBridge,
  copperMammoth,
  colossalDuck,
  ironLatticeLookout,
  harbourControlTower,
  saucerFreighter,
  harbourStreet,
  meridianTower,
  illinoisMainQuad,
]

const CHECK_MODE = process.argv.includes('--check')
/** `--only=id,id` builds a subset, for iterating on one demo without waiting for the full collection. */
const ONLY = (process.argv.find((argument) => argument.startsWith('--only=')) ?? '')
  .slice('--only='.length)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
// --check writes outside the working tree, so a determinism run can never leave
// an untracked directory behind for the integrator to find.
const CHECK_ROOT = path.join(os.tmpdir(), 'brickwright-demos-check')
const OUT_PUBLIC = CHECK_MODE ? path.join(CHECK_ROOT, 'public') : path.join(ROOT, 'public', 'demos')
const OUT_SRC = CHECK_MODE ? path.join(CHECK_ROOT, 'src') : path.join(ROOT, 'src', 'demos')

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assembles a finished `ModelDocument` from placed parts.
 *
 * Build steps are *derived*, never asserted: the kernel's precedence solver
 * orders the parts, every part is reassigned to the step that introduces it,
 * and the sequence is then re-verified against the guarantee it claims.
 */
function assembleDocument(build, meta) {
  const document = {
    schemaVersion: 2,
    id: `demo_${meta.id.replace(/-/g, '_')}`,
    name: meta.name,
    revision: 1,
    catalogVersion: catalog.version,
    createdAt: AUTHORED_AT,
    updatedAt: AUTHORED_AT,
    parts: Object.fromEntries(build.parts.map((part) => [part.id, part])),
    connections: {},
    // An assembly nothing was filed under is noise: an empty group in the
    // inspector and a direction with no parts in the exploded view. If the
    // authoring did not use it, it does not ship.
    subassemblies: Object.fromEntries(
      build.subassemblies
        .filter((entry) => build.parts.some((part) => part.subassemblyId === entry.id))
        .map((entry) => [
          entry.id,
          {
            id: entry.id,
            name: entry.name,
            locked: entry.locked ?? false,
            accent: entry.accent,
            partIds: build.parts.filter((part) => part.subassemblyId === entry.id).map((part) => part.id),
          },
        ]),
    ),
    steps: [],
    notes: meta.notes ?? [],
    constraints: meta.constraints ?? [],
  }
  document.connections = deriveConnectionEdges(document, 1, 'import-inferred')

  // Insertability is opt-in because it is expensive on a hot path; this is not a
  // hot path. A published demo carries instructions a person will follow, so a
  // step that cannot physically be built is exactly what this gate should say.
  const order = computeBuildOrder(document, {
    maxPartsPerStep: meta.maxPartsPerStep ?? 10,
    checkInsertability: true,
  })
  document.steps = order.steps
  for (const step of order.steps) {
    for (const partId of step.partIds) document.parts[partId] = { ...document.parts[partId], stepId: step.id }
  }
  return { document, order }
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Part identity in a form a person can act on, for a rejection message. */
function describeParts(document, ids) {
  return ids
    .slice(0, 8)
    .map((id) => {
      const part = document.parts[id]
      if (!part) return id
      const box = getPartBounds(part)
      return (
        `${id}=${part.definitionId}@[${part.transform.position.map((value) => value.toFixed(0)).join(',')}] ` +
        `y ${box.min[1].toFixed(0)}..${box.max[1].toFixed(0)}`
      )
    })
    .join('; ')
}

class DemoRejected extends Error {
  constructor(id, failures) {
    super(`Demo "${id}" failed ${failures.length} gate(s):\n  - ${failures.join('\n  - ')}`)
    this.name = 'DemoRejected'
    this.failures = failures
  }
}

/**
 * Every gate a demo must clear before it may be published.
 *
 * These are deliberately the same checks the editor runs, called through the
 * same entry points, rather than a relaxed copy: a demo is a document an
 * operator could have built and could keep building on.
 */
function gate(id, document, order, options = {}) {
  const failures = []

  // This collection is the front door, not a fixture drawer. The previous
  // gallery mixed thirty-part experiments with the campus and made "Explore"
  // feel like a toy shelf. A published starting point now has to clear an
  // explicit four-digit scale floor before any of the deeper gates matter.
  const partCount = Object.keys(document.parts).length
  if (partCount < 1_000) failures.push(`only ${partCount} parts; showcase builds must contain at least 1,000`)

  // -- catalog ---------------------------------------------------------------
  for (const part of Object.values(document.parts)) {
    const definition = catalog.get(part.definitionId)
    if (!definition) failures.push(`${part.id} references ${part.definitionId}, absent from catalog ${catalog.version}`)
    else if (!definition.geometryAsset)
      failures.push(`${part.id} references ${part.definitionId}, which has no compiled geometry`)
    else if (definition.canonicalId !== part.definitionId)
      failures.push(`${part.id} stores retired id ${part.definitionId}; use ${definition.canonicalId}`)
  }
  if (document.catalogVersion !== catalog.version) {
    failures.push(`document declares catalog ${document.catalogVersion}, built against ${catalog.version}`)
  }

  // -- collision + connectivity ---------------------------------------------
  const validation = validateDocument(document, { provideGeometry: geometryProvider })
  if (validation.collisions.length) {
    failures.push(
      `${validation.collisions.length} collision(s): ` +
        validation.collisions
          .slice(0, 4)
          .map((issue) => `${describeParts(document, [issue.partA, issue.partB])}`)
          .join(' | '),
    )
  }
  if (validation.unverifiedCollisions)
    failures.push(`${validation.unverifiedCollisions} collision verdict(s) reached from bounding boxes alone`)
  if (validation.componentCount !== 1) {
    failures.push(
      `model is in ${validation.componentCount} disconnected pieces: ${describeParts(document, validation.disconnectedPartIds)}`,
    )
  }
  for (const constraint of validation.constraints) {
    if (constraint.status === 'fail') failures.push(`constraint "${constraint.label}" fails: ${constraint.message}`)
  }

  // A second, independent collision pass with triangle geometry, so a demo can
  // never ship on an incremental or cached verdict.
  const contacts = findCollisions(document, { provide: geometryProvider })
  if (contacts.length) failures.push(`${contacts.length} contact(s) on a full triangle-confirmed re-check`)

  // -- build order -----------------------------------------------------------
  const verified = verifyBuildOrder(document, document.steps)
  if (!verified.valid) {
    failures.push(
      `build order violates its own guarantee at ${verified.violations
        .slice(0, 3)
        .map((v) => `step ${v.stepIndex}/${v.partId}`)
        .join(', ')}`,
    )
  }
  if (order.unsupportedPartIds.length) {
    failures.push(
      `${order.unsupportedPartIds.length} part(s) begin an unsupported island: ${describeParts(document, order.unsupportedPartIds)}`,
    )
  }
  const sequenced = new Set(document.steps.flatMap((step) => step.partIds))
  if (sequenced.size !== Object.keys(document.parts).length) {
    failures.push(`build sequence covers ${sequenced.size} of ${Object.keys(document.parts).length} parts`)
  }

  // -- statics ---------------------------------------------------------------
  const statics = analyseStatics(document)
  if (!statics.support) failures.push('no support polygon could be measured, so stability is unknown')
  else if (!statics.support.stable)
    failures.push(
      `centre of mass falls outside the support polygon (margin ${statics.support.marginLdu.toFixed(1)} LDU)`,
    )
  const tensionAllowance = options.tensionAllowance ?? 0
  if (statics.unsupportedPartIds.length > tensionAllowance) {
    failures.push(
      `${statics.unsupportedPartIds.length} part(s) are never reached by the load path from the ground, ` +
        `and this demo allows ${tensionAllowance}: ${describeParts(document, statics.unsupportedPartIds)}`,
    )
  }
  if (statics.coverage < 1)
    failures.push(`mass could only be measured for ${(statics.coverage * 100).toFixed(1)}% of the parts`)
  const overCapacity = statics.overloaded.filter((issue) => issue.severity === 'over-capacity')
  if (overCapacity.length) failures.push(`${overCapacity.length} group(s) hang from too few studs for their mass`)

  if (failures.length) throw new DemoRejected(id, failures)
  return { validation, statics, buildOrder: { ...order, verified: verified.valid } }
}

/** The parts of a validation report worth publishing, in a stable shape. */
function summariseValidation(validation, statics, order, document) {
  const weak = findWeakAttachments(document)
  return {
    revision: validation.revision,
    partCount: validation.partCount,
    connectionCount: validation.connectionCount,
    collisionCount: validation.collisions.length,
    unverifiedCollisions: validation.unverifiedCollisions,
    componentCount: validation.componentCount,
    disconnectedPartCount: validation.disconnectedPartIds.length,
    virtualColorCount: validation.virtualColors.length,
    weakAttachmentCount: weak.length,
    healthy: validation.healthy,
    boundsLdu: {
      min: round3(validation.bounds.min),
      max: round3(validation.bounds.max),
      size: round3(validation.bounds.size),
    },
    footprintStuds: [
      Number((validation.bounds.size[0] / STUD_LDU).toFixed(2)),
      Number((validation.bounds.size[2] / STUD_LDU).toFixed(2)),
    ],
    heightPlates: Number((validation.bounds.size[1] / PLATE_LDU).toFixed(2)),
    steps: order.steps.length,
    buildOrderVerified: order.verified ?? false,
    buildOrderWarnings: order.warnings.map((warning) => warning.message),
    statics: {
      massGrams: Number(statics.mass.grams.toFixed(2)),
      massLabel: describeMass(statics.mass.grams),
      measuredParts: statics.mass.measuredParts,
      unmeasuredParts: statics.mass.unmeasuredParts,
      coverage: Number(statics.coverage.toFixed(4)),
      supportLabel: describeSupport(statics.support),
      tippingMarginLdu: statics.support ? Number(statics.support.marginLdu.toFixed(2)) : null,
      restingParts: statics.support ? statics.support.restingParts : 0,
      stable: Boolean(statics.support?.stable),
      overloadedGroups: statics.overloaded.length,
      unsupportedParts: statics.unsupportedPartIds.length,
      massBasis: statics.assumptions.massBasis,
      clutchGramsPerStud: statics.assumptions.clutchGramsPerStud,
    },
  }
}

const round3 = (vector) => vector.map((value) => Number(value.toFixed(3)))

// ---------------------------------------------------------------------------
// Lightweight preview geometry
// ---------------------------------------------------------------------------

/**
 * The data the landing page and the explorer actually draw.
 *
 * Not a mesh: the compiled geometry for one demo is megabytes and needs Three.js
 * to draw, and the whole point of the landing route is that it costs neither.
 * What ships instead is every part's *measured* LDraw envelope at its exact
 * document transform, plus the exact position of every top stud, which a few
 * hundred lines of 2D projection turn into a legible, orbitable, occlusion-
 * correct model. It is the real document, drawn honestly at a lower fidelity —
 * and the interface says so rather than passing it off as the render.
 *
 * Every demo places parts on quarter turns about the vertical, so a transformed
 * axis-aligned box is still axis-aligned and six numbers describe it exactly.
 * That is asserted rather than assumed.
 */
function buildPreview(document, validation) {
  const definitionIndex = new Map()
  const definitionList = []
  const colorIndex = new Map()
  const colorList = []
  const subIndex = new Map()
  const subList = []
  const layoutIndex = new Map()
  const layoutList = []
  const stepIndex = new Map(document.steps.map((step, index) => [step.id, index]))

  const indexDefinition = (definitionId) => {
    const existing = definitionIndex.get(definitionId)
    if (existing !== undefined) return existing
    const definition = catalog.get(definitionId)
    const index = definitionList.length
    definitionIndex.set(definitionId, index)
    definitionList.push({
      id: definition.canonicalId,
      name: definition.name,
      category: definition.category,
      studs: definition.dimensions ? round2(definition.dimensions.studs) : null,
      connectors: definition.connectors.length,
      frequency: definition.frequency,
    })
    return index
  }

  const indexColor = (code) => {
    const existing = colorIndex.get(code)
    if (existing !== undefined) return existing
    const color = getColor(code)
    const index = colorList.length
    colorIndex.set(code, index)
    colorList.push({ code: color.code, name: color.name, hex: color.hex, edge: color.edge, alpha: color.alpha })
    return index
  }

  const indexLayout = (offsets) => {
    if (!offsets.length) return -1
    const key = offsets.map((pair) => pair.join(':')).join('|')
    const existing = layoutIndex.get(key)
    if (existing !== undefined) return existing
    const index = layoutList.length
    layoutIndex.set(key, index)
    layoutList.push(offsets.flat())
    return index
  }

  for (const entry of Object.values(document.subassemblies)) {
    subIndex.set(entry.id, subList.length)
    subList.push({ id: entry.id, name: entry.name, accent: entry.accent, locked: entry.locked })
  }

  const partIds = []
  const boxes = []
  for (const part of Object.values(document.parts)) {
    if (!isAxisAligned(part.transform.basis)) {
      throw new Error(
        `Part ${part.id} (${part.definitionId}) is not on an axis-aligned rotation, so its envelope box would be approximate rather than exact.`,
      )
    }
    const bounds = getPartBounds(part)
    if (!bounds.measured) throw new Error(`Part ${part.id} (${part.definitionId}) has no measured envelope.`)
    partIds.push(part.id)
    boxes.push([
      ...round2(bounds.min),
      ...round2(bounds.max),
      indexDefinition(part.definitionId),
      indexColor(part.color),
      stepIndex.get(part.stepId) ?? 0,
      subIndex.get(part.subassemblyId) ?? 0,
      indexLayout(topStudOffsets(part, bounds)),
    ])
  }

  return {
    id: document.id,
    name: document.name,
    revision: document.revision,
    catalogVersion: document.catalogVersion,
    boundsLdu: { min: round2(validation.bounds.min), max: round2(validation.bounds.max) },
    definitions: definitionList,
    colors: colorList,
    subassemblies: subList,
    steps: document.steps.map((step) => ({ index: step.index, name: step.name, partCount: step.partIds.length })),
    /** Normalised stud positions on a box's top face, as flat [u,v,u,v,…] runs. */
    studLayouts: layoutList,
    partIds,
    /** [minX,minY,minZ, maxX,maxY,maxZ, definition, colour, step, subassembly, studLayout] */
    parts: boxes,
  }
}

const round2 = (vector) => vector.map((value) => Number(value.toFixed(2)))

/**
 * True when a basis is a signed permutation of the axes.
 *
 * That is the exact condition under which a rotated axis-aligned box is still
 * axis-aligned, which is what lets six numbers describe a part's envelope with
 * no approximation. Every demo is authored on quarter turns — including the
 * SNOT build, whose bricks are turned about X and Z — so this holds, and it is
 * checked rather than assumed.
 */
function isAxisAligned(basis) {
  for (let row = 0; row < 3; row += 1) {
    let nonZero = 0
    for (let column = 0; column < 3; column += 1) {
      const value = basis[row * 3 + column]
      if (Math.abs(value) < 1e-9) continue
      if (Math.abs(Math.abs(value) - 1) > 1e-9) return false
      nonZero += 1
    }
    if (nonZero !== 1) return false
  }
  return true
}

/**
 * Where the studs a viewer can actually see sit on a part's top face.
 *
 * Read from the compiled LDCad connectors and pushed through the part's own
 * transform, so a jumper plate gets one dimple, a 2 x 4 gets eight in the right
 * places, and a SNOT brick turned on its side correctly gets none — its studs
 * are on a vertical face, and drawing them flat on top would be a lie about how
 * the model is put together.
 *
 * Returned as fractions of the box, because the client already has the box.
 */
function topStudOffsets(part, bounds) {
  const definition = catalog.get(part.definitionId)
  const studs = definition.connectors.filter((connector) => connector.family === 'stud' && connector.gender === 'male')
  if (!studs.length) return []
  const width = bounds.max[0] - bounds.min[0]
  const depth = bounds.max[2] - bounds.min[2]
  if (width < 1e-6 || depth < 1e-6) return []

  const { position, basis } = part.transform
  const seen = new Set()
  const offsets = []
  for (const connector of studs) {
    const [x, y, z] = connector.pos
    const wx = basis[0] * x + basis[1] * y + basis[2] * z + position[0]
    const wy = basis[3] * x + basis[4] * y + basis[5] * z + position[1]
    const wz = basis[6] * x + basis[7] * y + basis[8] * z + position[2]
    // LDraw is Y-down: the top of the box is its minimum Y. A stud more than a
    // plate below that is on a side or an underside, not on top.
    if (wy - bounds.min[1] > PLATE_LDU) continue
    const u = Number(((wx - bounds.min[0]) / width).toFixed(3))
    const v = Number(((wz - bounds.min[2]) / depth).toFixed(3))
    if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue
    const key = `${u}:${v}`
    if (seen.has(key)) continue
    seen.add(key)
    offsets.push([u, v])
  }
  return offsets.sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

// ---------------------------------------------------------------------------
// Offline rendering
// ---------------------------------------------------------------------------

const palette = (code) => rgbFromHex(getColor(code).hex)

function rasterPartsFor(document) {
  const collected = []
  for (const part of Object.values(document.parts)) {
    const mesh = meshCache.get(part.definitionId)
    if (!mesh) continue
    collected.push({
      positions: mesh.positions,
      indices: mesh.indices,
      slices: mesh.slices,
      transform: part.transform,
      rgb: palette(part.color),
      isNew: true,
    })
  }
  return collected
}

/** Union of every transformed vertex, which is what the camera has to fit. */
function meshBounds(document) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const part of Object.values(document.parts)) {
    const mesh = meshCache.get(part.definitionId)
    if (!mesh) continue
    const { position, basis } = part.transform
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index]
      const y = mesh.positions[index + 1]
      const z = mesh.positions[index + 2]
      const wx = basis[0] * x + basis[1] * y + basis[2] * z + position[0]
      const wy = basis[3] * x + basis[4] * y + basis[5] * z + position[1]
      const wz = basis[6] * x + basis[7] * y + basis[8] * z + position[2]
      if (wx < min[0]) min[0] = wx
      if (wy < min[1]) min[1] = wy
      if (wz < min[2]) min[2] = wz
      if (wx > max[0]) max[0] = wx
      if (wy > max[1]) max[1] = wy
      if (wz > max[2]) max[2] = wz
    }
  }
  return { min, max }
}

/**
 * Renders one document to PNG bytes over an opaque backdrop.
 *
 * `renderScene` returns coverage in alpha so a page can composite it anywhere;
 * a social card cannot, because link unfurlers do not composite. The flatten
 * happens here rather than in the rasterizer.
 */
function renderDocument(document, { width, height, background, supersample = 2, padding = 0.09 }) {
  const framing = frameScene(meshBounds(document), width, height, { padding, supersample })
  const image = renderScene(rasterPartsFor(document), framing, { palette, outlineNew: false })
  const rgba = Buffer.alloc(width * height * 4)
  const [br, bg, bb] = background
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = image.rgba[pixel * 4 + 3] / 255
    rgba[pixel * 4] = Math.round(image.rgba[pixel * 4] * alpha + br * (1 - alpha))
    rgba[pixel * 4 + 1] = Math.round(image.rgba[pixel * 4 + 1] * alpha + bg * (1 - alpha))
    rgba[pixel * 4 + 2] = Math.round(image.rgba[pixel * 4 + 2] * alpha + bb * (1 - alpha))
    rgba[pixel * 4 + 3] = 255
  }
  return { png: encodePng(rgba, width, height), coverage: image.coverage }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

const crc32 = (buffer) => {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * Rectangular RGBA to PNG.
 *
 * `tools/thumbnail.mjs` has a square-only encoder for palette previews; a
 * 1200 x 630 social card is not square, and widening the catalog compiler's
 * encoder to serve the landing page would couple two builds that have no other
 * reason to know about each other. Fixed deflate level, so bytes reproduce.
 */
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Stable key order, so two runs of this script produce identical bytes. */
function stableJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, walk(node[key])]),
      )
    }
    return node
  }
  return `${JSON.stringify(walk(value), null, 0)}\n`
}

const written = []
async function emit(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
  await writeFile(file, buffer)
  written.push({
    file: path.relative(ROOT, file),
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  })
  return buffer.byteLength
}


// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Which of the two candidates each demo is: the published one, or its ancestor. */
async function compile(demo, rough) {
  const authored = demo.author(rough)
  const { document, order } = assembleDocument(authored.build, {
    id: rough ? `${demo.id}-rough` : demo.id,
    name: rough ? `${demo.title} — first candidate` : demo.title,
    notes: authored.notes?.length
      ? [
          {
            id: 'note_plan',
            anchorPartIds: [],
            text: authored.notes.join(' '),
            status: 'resolved',
            author: HUMAN,
            revisionCreated: 1,
          },
        ]
      : [],
    maxPartsPerStep: demo.maxPartsPerStep,
  })
  await warmGeometry(document)
  return { document, order, warnings: authored.warnings ?? [] }
}

/** Part counts by definition, most-used first — the demo's bill of materials. */
function billOf(document) {
  const counts = new Map()
  for (const part of Object.values(document.parts)) {
    counts.set(part.definitionId, (counts.get(part.definitionId) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([definitionId, count]) => ({ definitionId, name: catalog.get(definitionId)?.name ?? definitionId, count }))
    .sort((a, b) => b.count - a.count || a.definitionId.localeCompare(b.definitionId))
}

/**
 * What the refinement pass actually changed, measured.
 *
 * Both numbers on every row come from a real validation run over a real
 * document. A "before and after" whose before was never built is marketing;
 * this one fails the build if the earlier candidate is not measurably worse.
 */
function refinementDelta(rough, refined) {
  return {
    partsAdded: refined.partCount - rough.partCount,
    connectionsAdded: refined.connectionCount - rough.connectionCount,
    componentsBefore: rough.componentCount,
    componentsAfter: refined.componentCount,
    loosePartsBefore: rough.disconnectedPartCount,
    loosePartsAfter: refined.disconnectedPartCount,
    collisionsBefore: rough.collisionCount,
    collisionsAfter: refined.collisionCount,
    unsupportedBefore: rough.statics.unsupportedParts,
    unsupportedAfter: refined.statics.unsupportedParts,
    stableBefore: rough.statics.stable,
    stableAfter: refined.statics.stable,
    massBeforeGrams: rough.statics.massGrams,
    massAfterGrams: refined.statics.massGrams,
    stepsBefore: rough.steps,
    stepsAfter: refined.steps,
  }
}

const results = []
const failures = []

for (const demo of DEMOS.filter((entry) => !ONLY.length || ONLY.includes(entry.id))) {
  const started = Date.now()
  let refined
  let roughBuild
  try {
    refined = await compile(demo, false)
    roughBuild = await compile(demo, true)
  } catch (cause) {
    failures.push(`${demo.id}: authoring failed — ${cause.message}`)
    continue
  }

  let checks
  try {
    checks = gate(demo.id, refined.document, refined.order, { tensionAllowance: demo.tensionAllowance })
  } catch (cause) {
    failures.push(cause instanceof DemoRejected ? cause.message : `${demo.id}: ${cause.message}`)
    continue
  }

  const roughValidation = validateDocument(roughBuild.document, { provideGeometry: geometryProvider })
  const roughStatics = analyseStatics(roughBuild.document)
  const refinedSummary = summariseValidation(checks.validation, checks.statics, checks.buildOrder, refined.document)
  const roughSummary = summariseValidation(
    roughValidation,
    roughStatics,
    { ...roughBuild.order, verified: verifyBuildOrder(roughBuild.document, roughBuild.document.steps).valid },
    roughBuild.document,
  )
  const delta = refinementDelta(roughSummary, refinedSummary)

  // The refinement story has to be true. If the earlier candidate is not worse
  // on a measured axis, there is nothing to show and the claim is dropped.
  const improved =
    delta.componentsAfter < delta.componentsBefore ||
    delta.loosePartsAfter < delta.loosePartsBefore ||
    delta.unsupportedAfter < delta.unsupportedBefore ||
    delta.collisionsAfter < delta.collisionsBefore
  if (!improved) {
    failures.push(
      `${demo.id}: the first candidate is not measurably worse than the published model ` +
        `(components ${delta.componentsBefore}→${delta.componentsAfter}, loose ${delta.loosePartsBefore}→${delta.loosePartsAfter}, ` +
        `unsupported ${delta.unsupportedBefore}→${delta.unsupportedAfter}, collisions ${delta.collisionsBefore}→${delta.collisionsAfter}). ` +
        'Either the refinement is real and measurable, or it is not published.',
    )
    continue
  }

  // Collection-defining scale claims are data, not copy. Count the character
  // elements and site-finish subassembly from the compiled document before the
  // numbers are allowed into the manifest or onto the landing page.
  if (demo.showcase) {
    const characterDefinitions = new Set(demo.showcaseProof?.characterDefinitionIds ?? [])
    const characterCount = Object.values(refined.document.parts).filter((part) =>
      characterDefinitions.has(part.definitionId),
    ).length
    const finishId = demo.showcaseProof?.siteFinishSubassemblyId
    const siteFinishParts = finishId ? (refined.document.subassemblies[finishId]?.partIds.length ?? 0) : 0
    if (characterCount !== demo.showcase.characterCount || siteFinishParts !== demo.showcase.siteFinishParts) {
      failures.push(
        `${demo.id}: showcase proof failed — characters ${characterCount}/${demo.showcase.characterCount}, ` +
          `site finish ${siteFinishParts}/${demo.showcase.siteFinishParts}.`,
      )
      continue
    }
  }

  const preview = buildPreview(refined.document, checks.validation)
  const roughPreview = buildPreview(roughBuild.document, roughValidation)

  const thumb = renderDocument(refined.document, { width: 720, height: 450, background: [17, 23, 25] })
  const social = renderDocument(refined.document, { width: 1200, height: 630, background: [12, 17, 19] })
  if (thumb.coverage < 0.04)
    failures.push(`${demo.id}: rendered thumbnail covers only ${(thumb.coverage * 100).toFixed(1)}% of the frame`)

  const base = path.join(OUT_PUBLIC, demo.id)
  const assets = {}
  const record = async (key, file, contents, contentType) => {
    const bytes = await emit(path.join(base, file), contents)
    const entry = written[written.length - 1]
    assets[key] = { url: `/demos/${demo.id}/${file}`, bytes, sha256: entry.sha256, contentType }
  }
  await record('document', 'document.json', stableJson(refined.document), 'application/json')
  await record('rough', 'rough.json', stableJson(roughBuild.document), 'application/json')
  await record('preview', 'preview.json', stableJson(preview), 'application/json')
  await record('roughPreview', 'rough-preview.json', stableJson(roughPreview), 'application/json')
  await record('thumbnail', 'thumb.png', thumb.png, 'image/png')
  await record('social', 'social.png', social.png, 'image/png')

  results.push({
    id: demo.id,
    title: demo.title,
    discipline: demo.discipline,
    category: demo.category,
    tagline: demo.tagline,
    summary: demo.summary,
    techniques: demo.techniques,
    showcase: demo.showcase ?? null,
    refinement: demo.refinement,
    hero: Boolean(demo.hero),
    tensionAllowance: demo.tensionAllowance ?? 0,
    tensionReason: demo.tensionReason ?? null,
    brief: demo.brief ?? null,
    camera: demo.camera,
    documentId: refined.document.id,
    roughDocumentId: roughBuild.document.id,
    schemaVersion: refined.document.schemaVersion,
    catalogVersion: refined.document.catalogVersion,
    authoredAt: AUTHORED_AT,
    assets,
    validation: refinedSummary,
    roughValidation: roughSummary,
    delta,
    bill: billOf(refined.document).slice(0, 12),
    distinctParts: billOf(refined.document).length,
    planWarnings: refined.warnings,
    provenance: {
      generator: 'tools/build-demos.mjs',
      kernel: 'src/cad — validation, collision, instructions, statics, snapping, assembly, raster',
      catalogVersion: catalog.version,
      catalogManifestGeneratedAt: catalogManifest.generatedAt,
      catalogPartsHash: catalogManifest.files.parts.hash,
      renderer: 'src/cad/raster.ts — offline software rasterizer, no browser',
      authoredAt: AUTHORED_AT,
    },
  })
  process.stdout.write(
    `  ${demo.id.padEnd(20)} ${String(refinedSummary.partCount).padStart(4)} parts  ` +
      `${String(refinedSummary.connectionCount).padStart(5)} mates  ${String(refinedSummary.steps).padStart(3)} steps  ` +
      `${refinedSummary.statics.massLabel.padStart(8)}  margin ${String(refinedSummary.statics.tippingMarginLdu).padStart(7)} LDU  ` +
      `${Date.now() - started} ms\n`,
  )
}

if (failures.length) {
  process.stderr.write(`\nDemo build FAILED — ${failures.length} demo(s) rejected:\n\n${failures.join('\n\n')}\n\n`)
  await closeKernel()
  process.exit(1)
}

// Every demo in DEMOS has to survive every gate. The count used to be pinned at
// seven, which meant shrinking the collection tripped the build rather than the
// thing the gate is for: a demo that silently stopped passing.
if (!ONLY.length && results.length < DEMOS.length) {
  const failed = DEMOS.filter((demo) => !results.some((entry) => entry.id === demo.id)).map((demo) => demo.id)
  process.stderr.write(
    `\nDemo build FAILED — ${results.length} of ${DEMOS.length} demos passed every gate; missing: ${failed.join(', ')}.\n`,
  )
  await closeKernel()
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const manifestPayload = {
  schemaVersion: 1,
  catalogVersion: catalog.version,
  generatedBy: 'tools/build-demos.mjs',
  authoredAt: AUTHORED_AT,
  gates: [
    'catalog membership and compiled geometry for every part',
    'large-scale collection floor: at least 1,000 editable parts',
    'triangle-confirmed collision, twice, with no unverified verdicts',
    'one connected component over the derived connection graph',
    'derived build order re-verified against its own guarantee',
    'measured statics: full mass coverage, load path reaches every part, centre of mass inside the support polygon',
    'a measurably worse first candidate, so the refinement shown is real',
  ],
  demos: results,
}

const summaryValidation = (validation) => ({
  partCount: validation.partCount,
  connectionCount: validation.connectionCount,
  collisionCount: validation.collisionCount,
  componentCount: validation.componentCount,
  disconnectedPartCount: validation.disconnectedPartCount,
  footprintStuds: validation.footprintStuds,
  steps: validation.steps,
  statics: {
    massLabel: validation.statics.massLabel,
    stable: validation.statics.stable,
    tippingMarginLdu: validation.statics.tippingMarginLdu,
    unsupportedParts: validation.statics.unsupportedParts,
  },
})

const summaryPayload = {
  schemaVersion: manifestPayload.schemaVersion,
  catalogVersion: manifestPayload.catalogVersion,
  generatedBy: manifestPayload.generatedBy,
  authoredAt: manifestPayload.authoredAt,
  gates: manifestPayload.gates,
  demos: results.map((demo) => ({
    id: demo.id,
    title: demo.title,
    discipline: demo.discipline,
    category: demo.category,
    tagline: demo.tagline,
    hero: demo.hero,
    brief: demo.brief,
    camera: demo.camera,
    catalogVersion: demo.catalogVersion,
    assets: {
      preview: demo.assets.preview,
      roughPreview: demo.assets.roughPreview,
      thumbnail: demo.assets.thumbnail,
    },
    validation: summaryValidation(demo.validation),
    roughValidation: summaryValidation(demo.roughValidation),
    delta: {
      partsAdded: demo.delta.partsAdded,
      connectionsAdded: demo.delta.connectionsAdded,
    },
  })),
}

if (ONLY.length) {
  process.stdout.write('\n--only run: manifest not rewritten\n')
  await closeKernel()
  process.exit(0)
}

await emit(path.join(OUT_PUBLIC, 'manifest.json'), stableJson(manifestPayload))

const generated = `/**
 * GENERATED FILE — do not edit.
 *
 * Written by \`tools/build-demos.mjs\` from the compiled catalog and the CAD
 * kernel. Every entry here passed the gates listed in \`DEMO_MANIFEST.gates\`
 * before it was allowed into this file; a demo that fails one is not written,
 * the build exits non-zero, and this file keeps its previous contents.
 *
 * Rebuild with:  node tools/build-demos.mjs
 */
import type { DemoManifest } from './types'

export const DEMO_MANIFEST: DemoManifest = ${JSON.stringify(manifestPayload, null, 2)}

export default DEMO_MANIFEST
`
await emit(path.join(OUT_SRC, 'manifest.generated.ts'), generated)

const generatedSummary = `/**
 * GENERATED FILE — do not edit.
 *
 * Landing-safe projection of the validated demo manifest. Full BOMs,
 * provenance and extended validation stay in the lazy Explore chunk.
 *
 * Rebuild with:  node tools/build-demos.mjs
 */
import type { DemoSummaryManifest } from './types'

export const DEMO_SUMMARY_MANIFEST: DemoSummaryManifest = ${JSON.stringify(summaryPayload, null, 2)}

export default DEMO_SUMMARY_MANIFEST
`
await emit(path.join(OUT_SRC, 'summary.generated.ts'), generatedSummary)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalBytes = written.reduce((sum, entry) => sum + entry.bytes, 0)
process.stdout.write(`\n${results.length} demos, ${written.length} files, ${(totalBytes / 1024).toFixed(0)} KB\n`)
process.stdout.write(`catalog ${catalog.version} · ${catalog.placeableCount} placeable identities\n`)

if (CHECK_MODE) {
  const committedPublic = path.join(ROOT, 'public', 'demos')
  const committedSrc = path.join(ROOT, 'src', 'demos', 'manifest.generated.ts')
  const committedSummarySrc = path.join(ROOT, 'src', 'demos', 'summary.generated.ts')
  const drift = []
  const compare = async (generatedFile, committedFile) => {
    if (!existsSync(committedFile)) {
      drift.push(`${path.relative(ROOT, committedFile)} is missing from the committed tree`)
      return
    }
    const [a, b] = await Promise.all([readFile(generatedFile), readFile(committedFile)])
    if (!a.equals(b))
      drift.push(
        `${path.relative(ROOT, committedFile)} differs from a fresh build (${a.byteLength} vs ${b.byteLength} bytes)`,
      )
  }
  const walk = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const nested = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(nested, path.join(prefix, entry.name))
      else await compare(nested, path.join(committedPublic, prefix, entry.name))
    }
  }
  await walk(OUT_PUBLIC)
  await compare(path.join(OUT_SRC, 'manifest.generated.ts'), committedSrc)
  await compare(path.join(OUT_SRC, 'summary.generated.ts'), committedSummarySrc)
  await rm(CHECK_ROOT, { recursive: true, force: true })
  if (drift.length) {
    process.stderr.write(`\nDeterminism check FAILED:\n  - ${drift.join('\n  - ')}\n`)
    await closeKernel()
    process.exit(1)
  }
  process.stdout.write('determinism check: a fresh build is byte-identical to the committed assets\n')
}

await closeKernel()
