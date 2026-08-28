#!/usr/bin/env node
/**
 * Curated demo compiler.
 *
 * The landing page and the explorer are only worth anything if what they show is
 * the real product. So the demos are not fixtures written by hand: they are
 * authored here, programmatically, against the compiled catalog and the real
 * parametric assembly planners, and then put through exactly the same gates the
 * kernel applies to an operator's own model — triangle-confirmed collision, the
 * connection graph, derived build order, catalog membership and statics.
 *
 * A demo that fails any of those does not enter the manifest. This build fails
 * instead, because shipping a "showcase" the kernel would reject is the single
 * most expensive kind of dishonesty a project like this can commit.
 *
 * The kernel is TypeScript and imports without file extensions, so the modules
 * are loaded through Vite's own module runner rather than through Node's
 * strip-only TypeScript support: that way the tool sees byte-for-byte the same
 * kernel the browser does, with no second transpiler to drift against.
 *
 *   node tools/build-demos.mjs [--check]
 *
 * `--check` writes to a temporary tree and diffs it against the committed one,
 * which is how the determinism gate is asserted.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createServer } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_ROOT = path.join(ROOT, 'public')
const CHECK_MODE = process.argv.includes('--check')
/** `--only=id,id` builds a subset, for iterating on one demo without waiting for six. */
const ONLY = (process.argv.find((argument) => argument.startsWith('--only=')) ?? '').slice('--only='.length)
  .split(',').map((id) => id.trim()).filter(Boolean)
// --check writes outside the working tree, so a determinism run can never leave
// an untracked directory behind for the integrator to find.
const CHECK_ROOT = path.join(os.tmpdir(), 'brickwright-demos-check')
const OUT_PUBLIC = CHECK_MODE ? path.join(CHECK_ROOT, 'public') : path.join(ROOT, 'public', 'demos')
const OUT_SRC = CHECK_MODE ? path.join(CHECK_ROOT, 'src') : path.join(ROOT, 'src', 'demos')

/**
 * Every timestamp the demos carry.
 *
 * A generated document that stamps `new Date()` is not reproducible, and a
 * manifest whose bytes change on every run cannot be diffed, cached or verified.
 * The demos are content, so they are dated by the catalog build they were
 * authored against rather than by when the script happened to run.
 */
const AUTHORED_AT = '2026-07-01T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Kernel access
// ---------------------------------------------------------------------------

const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { middlewareMode: true, watch: null },
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
})
const runner = server.environments.ssr.runner
const load = (module) => runner.import(`/src/cad/${module}.ts`)

const [
  catalogModule,
  assemblyModule,
  collisionModule,
  geometryModule,
  instructionsModule,
  mathModule,
  meshModule,
  placementModule,
  rasterModule,
  snappingModule,
  staticsModule,
  validationModule,
] = await Promise.all([
  load('catalog'),
  load('assembly'),
  load('collision'),
  load('geometry'),
  load('instructions'),
  load('math'),
  load('mesh'),
  load('placement'),
  load('raster'),
  load('snapping'),
  load('statics'),
  load('validation'),
])

const { catalog, getColor, originForSurface, surfaceAbove, STUD_LDU, PLATE_LDU, BRICK_LDU } = catalogModule
const { planWall, planEnclosure, planBrickField, planHingedFlap } = assemblyModule
const { findCollisions, geometryFromArrays } = collisionModule
const { getDocumentBounds, getPartBounds } = geometryModule
const { computeBuildOrder, verifyBuildOrder } = instructionsModule
const { basisFromEulerDegrees, cleanBasis } = mathModule
const { decodeMesh } = meshModule
const { QUARTER_TURN_BASES } = placementModule
const { frameScene, renderScene, rgbFromHex } = rasterModule
const { bestSnapTransform, deriveConnectionEdges } = snappingModule
const { analyseStatics, describeMass, describeSupport } = staticsModule
const { validateDocument, findWeakAttachments } = validationModule

// ---------------------------------------------------------------------------
// Catalog + compiled geometry
// ---------------------------------------------------------------------------

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

const pointer = await readJson(path.join(CATALOG_ROOT, 'catalog', 'latest.json'))
const catalogVersion = pointer.catalogVersion
const versionRoot = path.join(CATALOG_ROOT, 'catalog', catalogVersion)
const manifest = await readJson(path.join(versionRoot, 'manifest.json'))
const [parts, search, colors, aliases] = await Promise.all([
  readJson(path.join(versionRoot, 'parts.json')),
  readJson(path.join(versionRoot, 'search.json')),
  readJson(path.join(versionRoot, 'colors.json')),
  readJson(path.join(versionRoot, 'aliases.json')),
])
catalog.install({ manifest, parts, search, colors, aliases })

/** Decoded compiled meshes, keyed by definition id, loaded on first request. */
const meshCache = new Map()
async function meshFor(definitionId) {
  if (meshCache.has(definitionId)) return meshCache.get(definitionId)
  const definition = catalog.get(definitionId)
  const asset = definition?.geometryAsset
  if (!asset) {
    meshCache.set(definitionId, null)
    return null
  }
  const buffer = await readFile(path.join(CATALOG_ROOT, asset.file))
  const decoded = decodeMesh(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  meshCache.set(definitionId, decoded)
  return decoded
}

/** Warms every mesh a document references, so the checks below are synchronous. */
async function warmGeometry(document) {
  await Promise.all([...new Set(Object.values(document.parts).map((part) => part.definitionId))].map(meshFor))
}

const threeCache = new Map()
/**
 * Triangle geometry for the collision kernel.
 *
 * Without this the collision pass falls back to bounding boxes and reports
 * `unknown` certainty, and a demo that ships on an unverified verdict is exactly
 * what the gate exists to prevent.
 */
const geometryProvider = (definitionId) => {
  if (threeCache.has(definitionId)) return threeCache.get(definitionId)
  const mesh = meshCache.get(definitionId)
  const geometry = mesh ? geometryFromArrays(mesh.positions, mesh.indices, mesh.normals) : null
  threeCache.set(definitionId, geometry)
  return geometry
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/** LDraw colour codes used by the demos, named so the authoring reads. */
const C = {
  black: 0,
  blue: 1,
  green: 2,
  red: 4,
  brown: 6,
  lightGrey: 7,
  yellow: 14,
  white: 15,
  tan: 19,
  transLightBlue: 43,
  transClear: 47,
  darkGrey: 72,
  lightBluishGrey: 71,
  orange: 25,
  darkRed: 320,
  darkTan: 28,
  sand: 135,
  darkGreen: 288,
  reddishBrown: 70,
  mediumBlue: 42,
  darkBluishGrey: 72,
}

class Build {
  /**
   * @param {{ subassemblies: Array<{id:string,name:string,locked?:boolean,accent:string}> }} options
   */
  constructor(options) {
    this.parts = []
    this.subassemblies = options.subassemblies
    this.defaultSubassembly = options.subassemblies[0].id
    this.sequence = 0
  }

  #definition(definitionId) {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Demo references ${definitionId}, which is not in catalog ${catalog.version}.`)
    if (!definition.geometryAsset) throw new Error(`Demo references ${definitionId}, which has no compiled geometry in this build.`)
    return definition
  }

  #push(definition, color, position, basis, options) {
    // Solved poses come from the connector kernel and are correct by
    // construction — a studs-not-on-top tile is deliberately off the vertical
    // grid, so checking it would reject the very technique it is there to show.
    if (!options.solved && !options.offGrid) assertOnGrid(definition, position, basis, options.label ?? definition.canonicalId)
    this.sequence += 1
    this.parts.push({
      id: `part_${String(this.sequence).padStart(4, '0')}`,
      definitionId: definition.canonicalId,
      color,
      transform: { position, basis },
      subassemblyId: options.sub ?? this.defaultSubassembly,
      stepId: 'step_1',
      provenance: 'human',
      protected: options.protectedPart ?? false,
    })
  }

  /** Rests a part on `surfaceY`; returns the stud plane it exposes. */
  place(definitionId, color, x, z, surfaceY, options = {}) {
    const definition = this.#definition(definitionId)
    const y = originForSurface(definition, surfaceY)
    this.#push(definition, color, [x, y, z], basisFor(options.rotY ?? 0), options)
    return surfaceAbove(definition, y) ?? surfaceY
  }

  /** Places at an explicit origin, for parts that mate rather than rest. */
  placeAt(definitionId, color, x, y, z, options = {}) {
    const definition = this.#definition(definitionId)
    this.#push(definition, color, [x, y, z], basisFor(options.rotY ?? 0), options)
    return surfaceAbove(definition, y) ?? y
  }

  /**
   * Places a part at the pose the connector solver derives.
   *
   * The caller supplies a rough cursor position — where a hand would hold the
   * part — and the kernel returns the full 6-DOF pose that mates its connectors
   * with something already in the model. That is how a tile lands on a vertical
   * stud without anyone computing the quarter turn by hand, and it means the
   * demo is posed by exactly the code an editor drag runs through.
   */
  snap(definitionId, color, cursorPosition, options = {}) {
    const definition = this.#definition(definitionId)
    const basis = basisFor(options.rotY ?? 0)
    const moving = {
      id: 'snap_probe',
      definitionId: definition.canonicalId,
      color,
      transform: { position: cursorPosition, basis },
      subassemblyId: options.sub ?? this.defaultSubassembly,
      stepId: 'step_1',
      provenance: HUMAN,
      protected: false,
    }
    const solved = bestSnapTransform(moving, this.probeDocument(), moving.transform, {
      radiusLdu: options.radiusLdu ?? 26,
      targetPartIds: options.targetPartIds,
      targetFeatureId: options.targetFeatureId,
    })
    if (!solved) {
      throw new Error(`No connector on ${definitionId} mates anything within ${options.radiusLdu ?? 26} LDU of ${cursorPosition.join(', ')}.`)
    }
    this.#push(definition, color, solved.position, solved.basis, { ...options, solved: true })
    return solved
  }

  /** The id of the most recently placed part, for aiming a later solve at it. */
  lastPartId() {
    return this.parts[this.parts.length - 1].id
  }

  /** A throwaway document holding what has been placed so far, for the solver. */
  probeDocument() {
    return {
      schemaVersion: 2,
      id: 'probe',
      name: 'probe',
      revision: 0,
      catalogVersion: catalog.version,
      createdAt: AUTHORED_AT,
      updatedAt: AUTHORED_AT,
      parts: Object.fromEntries(this.parts.map((part) => [part.id, part])),
      connections: {},
      subassemblies: {},
      steps: [],
      notes: [],
      constraints: [],
    }
  }

  row(definitionId, color, xs, zs, surfaceY, options = {}) {
    let exposed = surfaceY
    for (const x of xs) for (const z of zs) exposed = this.place(definitionId, color, x, z, surfaceY, options)
    return exposed
  }

  /**
   * Absorbs a parametric assembly plan.
   *
   * The planners mint `crypto.randomUUID()` ids, which is right for a live
   * transaction and wrong for a committed asset, so the parts are re-identified
   * in plan order. Everything else about them — the exact poses the bricklayer
   * solved for — is taken unchanged.
   */
  addPlan(plan, options = {}) {
    for (const operation of plan.operations) {
      if (operation.type !== 'part.add') throw new Error(`Assembly plan emitted an unexpected ${operation.type} operation.`)
      const part = operation.part
      this.sequence += 1
      this.parts.push({
        ...part,
        id: `part_${String(this.sequence).padStart(4, '0')}`,
        subassemblyId: options.sub ?? part.subassemblyId,
        stepId: 'step_1',
      })
    }
    return plan
  }
}

/**
 * The stud grid.
 *
 * Every stud centre in a Brickwright document lands on an odd multiple of ten
 * LDU, because that is where the parametric planners put theirs: a run starting
 * at the origin places its first stud half a stud in. A hand-placed part half a
 * stud out of phase looks perfect in a render and is wrong in every way that
 * matters — its anti-studs miss, so it neither mates nor rests, and it collides
 * with the tube walls of whatever it was meant to sit on. That failure mode is
 * invisible by eye and obvious to this check, so the check runs on every place.
 */
const GRID_LDU = 20
const GRID_PHASE_LDU = 10

function assertOnGrid(definition, position, basis, label) {
  const toWorld = (local) => [
    basis[0] * local[0] + basis[1] * local[1] + basis[2] * local[2] + position[0],
    0,
    basis[6] * local[0] + basis[7] * local[1] + basis[8] * local[2] + position[2],
  ]
  const onGrid = (value) => {
    const phase = (((value - GRID_PHASE_LDU) % GRID_LDU) + GRID_LDU) % GRID_LDU
    return Math.min(phase, GRID_LDU - phase) <= 0.01
  }
  // LDCad puts a connector's axis on its frame's local +Y, so a horizontal one
  // is a studs-not-on-top feature and does not sit on the vertical grid at all.
  const vertical = (connector) => Math.abs(connector.ori ? connector.ori[4] : 1) >= 0.5

  let seats = 0
  let aligned = 0
  for (const connector of definition.connectors) {
    const isStud = connector.family === 'stud' && connector.gender === 'male'
    const isSeat = connector.family === 'anti-stud' && connector.gender === 'female'
    if ((!isStud && !isSeat) || !vertical(connector)) continue
    const world = toWorld(connector.pos)
    const good = onGrid(world[0]) && onGrid(world[2])
    seats += 1
    if (good) aligned += 1
    // A stud is unambiguous: it is always at a stud centre, so one off the grid
    // is a placement error. An anti-stud is not — a 2 x 2 brick's centre tube
    // sits deliberately between the four studs — so those are judged in bulk.
    if (isStud && !good) {
      throw new Error(
        `${label}: ${definition.canonicalId} sits off the stud grid — its stud ${connector.id} lands at `
        + `x ${world[0].toFixed(1)}, z ${world[2].toFixed(1)}, and stud centres are odd multiples of 10 LDU. `
        + 'A part centres on a multiple of 20 along an axis it spans an even number of studs on, '
        + 'and on an odd multiple of 10 along an axis it spans an odd number.',
      )
    }
  }
  if (seats && !aligned) {
    throw new Error(
      `${label}: ${definition.canonicalId} has ${seats} vertical connector(s) and not one of them lands on the `
      + `stud grid at position ${position.map((value) => value.toFixed(1)).join(', ')}. It would rest on nothing.`,
    )
  }
}

/** A part's own underside plane, in its local frame. */
const underPlaneOf = (definition) => {
  const seats = definition.connectors.filter((connector) => connector.family === 'anti-stud' && connector.gender === 'female')
  return seats.length ? Math.max(...seats.map((connector) => connector.pos[1])) : 0
}

const basisFor = (degrees) =>
  degrees % 90 === 0 ? QUARTER_TURN_BASES[(((degrees / 90) % 4) + 4) % 4] : cleanBasis(basisFromEulerDegrees([0, degrees, 0]))

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

  const order = computeBuildOrder(document, { maxPartsPerStep: meta.maxPartsPerStep ?? 10 })
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
  return ids.slice(0, 8).map((id) => {
    const part = document.parts[id]
    if (!part) return id
    const box = getPartBounds(part)
    return `${id}=${part.definitionId}@[${part.transform.position.map((value) => value.toFixed(0)).join(',')}] `
      + `y ${box.min[1].toFixed(0)}..${box.max[1].toFixed(0)}`
  }).join('; ')
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

  // -- catalog ---------------------------------------------------------------
  for (const part of Object.values(document.parts)) {
    const definition = catalog.get(part.definitionId)
    if (!definition) failures.push(`${part.id} references ${part.definitionId}, absent from catalog ${catalog.version}`)
    else if (!definition.geometryAsset) failures.push(`${part.id} references ${part.definitionId}, which has no compiled geometry`)
    else if (definition.canonicalId !== part.definitionId) failures.push(`${part.id} stores retired id ${part.definitionId}; use ${definition.canonicalId}`)
  }
  if (document.catalogVersion !== catalog.version) {
    failures.push(`document declares catalog ${document.catalogVersion}, built against ${catalog.version}`)
  }

  // -- collision + connectivity ---------------------------------------------
  const validation = validateDocument(document, { provideGeometry: geometryProvider })
  if (validation.collisions.length) {
    failures.push(
      `${validation.collisions.length} collision(s): `
      + validation.collisions.slice(0, 4).map((issue) => `${describeParts(document, [issue.partA, issue.partB])}`).join(' | '),
    )
  }
  if (validation.unverifiedCollisions) failures.push(`${validation.unverifiedCollisions} collision verdict(s) reached from bounding boxes alone`)
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
    failures.push(`build order violates its own guarantee at ${verified.violations.slice(0, 3).map((v) => `step ${v.stepIndex}/${v.partId}`).join(', ')}`)
  }
  if (order.unsupportedPartIds.length) {
    failures.push(`${order.unsupportedPartIds.length} part(s) begin an unsupported island: ${describeParts(document, order.unsupportedPartIds)}`)
  }
  const sequenced = new Set(document.steps.flatMap((step) => step.partIds))
  if (sequenced.size !== Object.keys(document.parts).length) {
    failures.push(`build sequence covers ${sequenced.size} of ${Object.keys(document.parts).length} parts`)
  }

  // -- statics ---------------------------------------------------------------
  const statics = analyseStatics(document)
  if (!statics.support) failures.push('no support polygon could be measured, so stability is unknown')
  else if (!statics.support.stable) failures.push(`centre of mass falls outside the support polygon (margin ${statics.support.marginLdu.toFixed(1)} LDU)`)
  const tensionAllowance = options.tensionAllowance ?? 0
  if (statics.unsupportedPartIds.length > tensionAllowance) {
    failures.push(
      `${statics.unsupportedPartIds.length} part(s) are never reached by the load path from the ground, `
      + `and this demo allows ${tensionAllowance}: ${describeParts(document, statics.unsupportedPartIds)}`,
    )
  }
  if (statics.coverage < 1) failures.push(`mass could only be measured for ${(statics.coverage * 100).toFixed(1)}% of the parts`)
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
      throw new Error(`Part ${part.id} (${part.definitionId}) is not on an axis-aligned rotation, so its envelope box would be approximate rather than exact.`)
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
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, walk(node[key])]))
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
  written.push({ file: path.relative(ROOT, file), bytes: buffer.byteLength, sha256: createHash('sha256').update(buffer).digest('hex') })
  return buffer.byteLength
}


// ---------------------------------------------------------------------------
// The demos
// ---------------------------------------------------------------------------

const HUMAN = 'human'

/** Shared spec fields every parametric plan needs. */
const spec = (fields) => ({ actor: HUMAN, subassemblyId: fields.sub, stepId: 'step_1', ...fields })

/**
 * A brick-built terrace block.
 *
 * Authored almost entirely by the parametric planners, because that is the
 * claim the landing page makes about them: one instruction lays a bonded
 * storey with real window and door frames seated in its openings. Nothing here
 * chooses a part by name — the planners pick from the compiled pack by measured
 * envelope, and the roof, the parapet and the deck are the same call with
 * different arguments.
 */
function courtyardTerrace(rough) {
  const build = new Build({
    subassemblies: [
      // planEnclosure lays its floor into the same assembly as the walls that
      // stand on it, so the name says so rather than implying two groups.
      { id: 'shell', name: 'Deck and shell', accent: '#f7b04a' },
      { id: 'roof', name: 'Roof slab', accent: '#8bcf65' },
      { id: 'parapet', name: 'Parapet', accent: '#87f7ff' },
    ],
  })

  const width = 20
  const depth = 14
  const courses = 6
  const floorLayers = rough ? 1 : 2
  const openings = [
    { atStud: 2, widthStuds: 2, fromCourse: 1, toCourse: 3, element: rough ? undefined : 'window' },
    { atStud: 8, widthStuds: 4, fromCourse: 0, toCourse: 5, element: rough ? undefined : 'door' },
    { atStud: 15, widthStuds: 2, fromCourse: 1, toCourse: 3, element: rough ? undefined : 'window' },
  ]

  const shell = planEnclosure(spec({
    sub: 'shell',
    origin: [0, 0, 0],
    color: C.tan,
    trimColor: C.white,
    glassColor: C.transClear,
    family: 'brick',
    depthStuds: 1,
    widthStuds: width,
    footprintDepthStuds: depth,
    courses,
    floor: true,
    floorLayers,
    openings,
  }))
  build.addPlan(shell)

  // The deck is laid inside the enclosure plan, so the wall origin — and with
  // it every level above — moves down by however many plate courses it used.
  const roofSurface = -(floorLayers * PLATE_LDU + courses * BRICK_LDU)
  if (rough) return { build, notes: shell.notes, warnings: shell.warnings }

  build.addPlan(planBrickField(spec({
    sub: 'roof',
    origin: [0, roofSurface, 0],
    color: C.darkBluishGrey,
    family: 'plate',
    widthStuds: width,
    footprintDepthStuds: depth,
    layers: 2,
  })))

  const parapetSurface = roofSurface - 2 * PLATE_LDU
  build.addPlan(planEnclosure(spec({
    sub: 'parapet',
    origin: [0, parapetSurface, 0],
    color: C.darkTan,
    family: 'brick',
    depthStuds: 1,
    widthStuds: width,
    footprintDepthStuds: depth,
    courses: 1,
    floor: false,
  })))

  return { build, notes: shell.notes, warnings: shell.warnings }
}

/**
 * A flatbed hauler.
 *
 * Hand-placed, because a vehicle is exactly what the parametric planners do not
 * do: there is no bonded-course problem here, only a chassis that has to sit on
 * its wheels and a cab that has to close. Every vertical position still comes
 * from the parts' own compiled connectors rather than a nominal brick height.
 */
function ridgelineHauler(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'running', name: 'Running gear', accent: '#6bbbd6' },
      { id: 'chassis', name: 'Chassis', accent: '#f7b04a' },
      { id: 'cab', name: 'Cab', accent: '#87f7ff' },
      { id: 'bed', name: 'Flatbed', accent: '#8bcf65' },
    ],
  })

  // Wheels first: they are what the vehicle stands on, so they define ground.
  // A 2 x 2 wheel brick is one part per axle, which keeps the running gear a
  // real sub-assembly rather than a pile of hubs with nothing holding an axle.
  const running = { sub: 'running' }
  const deck = build.place('3137c01', C.red, 0, -80, 0, running)
  build.place('3137c01', C.red, 0, 80, 0, running)

  // Chassis, four studs wide and twelve long. Layer one runs fore and aft with
  // its seam on the centreline; layer two crosses that seam. Without the
  // crossing the hauler is two half-chassis that merely touch.
  const chassis = { sub: 'chassis' }
  const afterFloor = build.row('3795', C.darkBluishGrey, [-20, 20], [-60, 60], deck, { ...chassis, rotY: 90 })
  const afterLock = rough
    ? build.row('3031', C.darkBluishGrey, [0], [-80, 80], afterFloor, chassis)
    : (() => {
        build.place('3031', C.darkBluishGrey, 0, -80, afterFloor, chassis)
        return build.place('3035', C.darkBluishGrey, 0, 40, afterFloor, { ...chassis, rotY: 90 })
      })()

  // Cab: a real windscreen, walls down each side and a closed back, so the
  // cabin encloses something instead of being a screen leaning on a plate.
  const cab = { sub: 'cab' }
  build.place('3823', C.transLightBlue, 0, -90, afterLock, cab)
  const course1 = build.row('3004', C.orange, [-30, 30], [-60], afterLock, { ...cab, rotY: 90 })
  build.place('3010', C.orange, 0, -30, afterLock, cab)
  const course2 = build.row('3004', C.orange, [-30, 30], [-60], course1, { ...cab, rotY: 90 })
  build.place('3010', C.orange, 0, -30, course1, cab)
  // One plate ties the windscreen, both side walls and the back wall together.
  const roof = build.place('3031', C.orange, 0, -60, course2, cab)
  build.place('87079', C.white, 0, -60, roof, cab)

  // Bed: a tiled load floor between two rails, and a tailboard.
  const bed = { sub: 'bed' }
  const railBase = build.row('3004', C.darkBluishGrey, [-30, 30], [0, 40, 80], afterLock, { ...bed, rotY: 90 })
  build.row('3069b', C.orange, [-30, 30], [0, 40, 80], railBase, { ...bed, rotY: 90 })
  build.row('3068b', C.lightBluishGrey, [0], [0, 40, 80], afterLock, bed)
  build.place('3010', C.darkBluishGrey, 0, 110, afterLock, bed)

  return { build, notes: [], warnings: [] }
}/**
 * A standing heron.
 *
 * The creature demo exists to show the kernel handling something that is not a
 * box: slopes, round bricks and a beak that is a cheese slope, all resting on
 * planes derived from their own connectors. It is also the demo where statics
 * earns its place — a tall, narrow bird either stands or it does not, and the
 * gate refuses to publish one whose centre of mass leaves its base.
 */
function heronSculpture(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'base', name: 'Base', accent: '#6bbbd6' },
      { id: 'legs', name: 'Legs', accent: '#f7b04a' },
      { id: 'body', name: 'Body', accent: '#8bcf65' },
      { id: 'head', name: 'Head and neck', accent: '#87f7ff' },
    ],
  })

  build.addPlan(planBrickField(spec({
    sub: 'base',
    origin: [0, 0, 0],
    color: C.darkGreen,
    family: 'plate',
    widthStuds: 8,
    footprintDepthStuds: 8,
    layers: 2,
  })), { sub: 'base' })
  const baseTop = -2 * PLATE_LDU

  // Two round-brick columns under the body's centreline, so the load path is
  // vertical rather than a cantilever the clutch has to hold.
  const legs = { sub: 'legs' }
  let left = baseTop
  let right = baseTop
  for (let course = 0; course < 3; course += 1) {
    left = build.place('3062b', C.yellow, 70, 70, left, legs)
    right = build.place('3062b', C.yellow, 90, 70, right, legs)
  }

  // The spine plate is what turns two columns into one bird: it spans both legs
  // and everything above rests on it.
  const body = { sub: 'body' }
  const spine = build.place('3034', C.white, 80, 80, left, { ...body, rotY: 90 })
  const belly = build.row('3003', C.white, [80], [60, 100], spine, body)
  const back = build.place('3020', C.white, 80, 80, belly, { ...body, rotY: 90 })
  // The tail starts where the belly ends: a 45° slope is two studs deep, so at
  // z = 130 it would have run back through the rear body brick.
  build.row('3040b', C.lightBluishGrey, [70, 90], [150], spine, body)
  build.place('85984', C.lightBluishGrey, 80, 50, back, { ...body, rotY: 180 })

  const head = { sub: 'head' }
  if (rough) {
    // The first candidate puts the head where it looks right and attaches it to
    // nothing — the usual result of placing parts by coordinate.
    build.placeAt('3004', C.white, 80, spine - 96, 30, head)
    build.placeAt('3003', C.white, 80, spine - 120, 20, head)
    return { build, notes: [], warnings: ['Head placed by coordinate; nothing carries it.'] }
  }

  let neck = spine
  for (let course = 0; course < 4; course += 1) neck = build.place('3004', C.white, 80, 30, neck, head)
  const skull = build.place('3003', C.white, 80, 20, neck, head)
  build.place('85984', C.orange, 80, 10, skull, { ...head, rotY: 180 })
  build.row('3070b', C.black, [70, 90], [30], skull, head)

  return { build, notes: [], warnings: [] }
}/**
 * A shutter bay with a hinge the kernel can drive.
 *
 * `planHingedFlap` builds a joint the connection graph reads as a real revolute
 * — the same one `articulate_joint` moves — so this demo is the one that proves
 * a Brickwright model is a mechanism and not only a shape.
 */
function shutterBay(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'deck', name: 'Deck', accent: '#6bbbd6' },
      { id: 'wall', name: 'Back wall', accent: '#f7b04a' },
      { id: 'shutter', name: 'Shutter', accent: '#87f7ff' },
      { id: 'trim', name: 'Trim', accent: '#8bcf65' },
    ],
  })

  build.addPlan(planBrickField(spec({
    sub: 'deck',
    origin: [0, 0, 0],
    color: C.lightBluishGrey,
    family: 'plate',
    widthStuds: 14,
    footprintDepthStuds: 10,
    layers: 2,
  })))
  const deckTop = -2 * PLATE_LDU

  build.addPlan(planWall(spec({
    sub: 'wall',
    origin: [0, deckTop, 180],
    color: C.sand,
    trimColor: C.white,
    glassColor: C.transClear,
    family: 'brick',
    depthStuds: 1,
    axis: 'x',
    lengthStuds: 14,
    courses: 5,
    openings: [{ atStud: 5, widthStuds: 4, fromCourse: 1, toCourse: 3, element: 'window' }],
  })))

  if (rough) {
    // Before the refinement pass the shutter is a slab of plates sitting a
    // course above the deck with nothing holding it: it looks right and comes
    // apart in your hands.
    build.addPlan(planBrickField(spec({
      sub: 'shutter',
      origin: [40, deckTop - BRICK_LDU, 20],
      color: C.orange,
      family: 'plate',
      widthStuds: 8,
      footprintDepthStuds: 4,
      layers: 1,
    })))
    return { build, notes: [], warnings: ['Shutter placed by coordinate; nothing carries it.'] }
  }

  const flap = planHingedFlap(spec({
    sub: 'shutter',
    origin: [40, deckTop, 20],
    color: C.orange,
    widthStuds: 8,
    reachStuds: 2,
  }))
  build.addPlan(flap)

  // Tiles finish the exposed deck either side of the shutter.
  // Deck strips either side of the shutter's swing, tiled so they read as floor
  // rather than as unfinished studs.
  const trim = { sub: 'trim' }
  build.row('3068b', C.darkBluishGrey, [20], [20, 60, 100, 140], deckTop, trim)
  build.row('87079', C.darkBluishGrey, [240], [20, 60, 100, 140], deckTop, trim)

  return { build, notes: flap.notes, warnings: flap.warnings }
}

/**
 * A draughting desk.
 *
 * The product demo: four legs, a cross-braced underframe, a two-layer top and a
 * lower shelf. A single-layer top would pass collision and connectivity and
 * still be wrong — plates side by side in one plane do not clutch each other —
 * which is precisely the difference the rough candidate shows.
 */
function draughtingDesk(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'legs', name: 'Legs', accent: '#f7b04a' },
      { id: 'shelf', name: 'Shelf', accent: '#87f7ff' },
      { id: 'frame', name: 'Underframe', accent: '#6bbbd6' },
      { id: 'top', name: 'Desktop', accent: '#8bcf65' },
    ],
  })

  const legs = { sub: 'legs' }
  const legX = [10, 230]
  const legZ = [20, 60]
  // Two 1 x 2 x 5 bricks per corner: one seam per leg, and the seam is exactly
  // where the shelf lands.
  const lower = []
  for (const x of legX) for (const z of legZ) lower.push(build.place('2454b', C.reddishBrown, x, z, 0, { ...legs, rotY: 90 }))
  const shelfSurface = lower[0]

  // One layer or two is the whole difference between a shelf and a sheet:
  // plates side by side in a single plane do not clutch each other at all.
  const layers = rough ? 1 : 2
  build.addPlan(planBrickField(spec({
    sub: 'shelf',
    origin: [0, shelfSurface, 0],
    color: C.tan,
    family: 'plate',
    widthStuds: 12,
    footprintDepthStuds: 4,
    layers,
  })), { sub: 'shelf' })
  const shelfTop = shelfSurface - layers * PLATE_LDU

  const upper = []
  for (const x of legX) for (const z of legZ) upper.push(build.place('2454b', C.reddishBrown, x, z, shelfTop, { ...legs, rotY: 90 }))
  const deskSurface = upper[0]

  // Rails tie each pair of legs together, so the desktop is carried along its
  // whole edge instead of at four points.
  const frame = { sub: 'frame' }
  const railTop = build.row('6112', C.reddishBrown, [120], [10, 70], deskSurface, frame)

  build.addPlan(planBrickField(spec({
    sub: 'top',
    origin: [0, railTop, 0],
    color: C.darkTan,
    family: 'plate',
    widthStuds: 12,
    footprintDepthStuds: 4,
    layers,
  })), { sub: 'top' })

  if (!rough) {
    const topSurface = railTop - 2 * PLATE_LDU
    build.row('87079', C.white, [40, 120, 200], [20, 60], topSurface, { sub: 'top' })
  }

  return { build, notes: [], warnings: [] }
}/**
 * A SNOT kiosk.
 *
 * Studs-not-on-top is the technique that separates a stack of bricks from a
 * built model, and it is also the hardest thing to place by hand: the tile on a
 * sideways stud needs a pose the kernel derives from two connector *frames*,
 * not a position guessed from a bounding box. So the facade tiles here are
 * solved by `bestSnapTransform` — the same 6-DOF solver a drag in the editor
 * runs through — and the result is committed at whatever pose it returns.
 */
function snotKiosk(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'plinth', name: 'Plinth', accent: '#6bbbd6' },
      { id: 'core', name: 'Core', accent: '#f7b04a' },
      { id: 'facade', name: 'SNOT facade', accent: '#87f7ff' },
      { id: 'cap', name: 'Cap', accent: '#8bcf65' },
    ],
  })

  build.addPlan(planBrickField(spec({
    sub: 'plinth',
    origin: [0, 0, 0],
    color: C.darkBluishGrey,
    family: 'plate',
    widthStuds: 6,
    footprintDepthStuds: 6,
    layers: 2,
  })), { sub: 'plinth' })

  // Three brick courses. `planBrickField` staggers each row against the one
  // before it, so the core is bonded in both directions rather than three
  // sheets of bricks that happen to be stacked.
  let level = -2 * PLATE_LDU
  for (let course = 0; course < 3; course += 1) {
    build.addPlan(planBrickField(spec({
      sub: 'core',
      origin: [0, level, 0],
      color: C.white,
      family: 'brick',
      widthStuds: 6,
      footprintDepthStuds: 6,
      layers: 1,
    })), { sub: 'core' })
    level -= BRICK_LDU
  }

  // The SNOT course: the front row is bricks whose studs face out of the wall,
  // the rest of the course is ordinary bonded brickwork, and both are laid at
  // the same level so the cap above lands on a complete course.
  const facade = { sub: 'facade' }
  const snotXs = [20, 60, 100]
  const snotIds = []
  for (const x of snotXs) {
    build.place('11211', C.white, x, 10, level, facade)
    snotIds.push(build.lastPartId())
  }
  build.addPlan(planBrickField(spec({
    sub: 'core',
    origin: [0, level, 20],
    color: C.white,
    family: 'brick',
    widthStuds: 6,
    footprintDepthStuds: 5,
    layers: 1,
  })), { sub: 'core' })
  const capSurface = level - BRICK_LDU

  // Where the studs on the side of those bricks are, read from the compiled
  // connectors rather than guessed from the envelope. LDCad puts a connector's
  // axis on its frame's local +Y, so a stud whose axis is horizontal is the
  // studs-not-on-top one.
  const snotDefinition = catalog.get('11211')
  const sideStud = snotDefinition.connectors.find(
    (connector) =>
      connector.family === 'stud'
      && connector.gender === 'male'
      && Math.abs(connector.ori ? connector.ori[4] : 1) < 0.5,
  )
  if (!sideStud) throw new Error('11211 no longer carries a horizontal stud connector; the SNOT demo has nothing to face.')

  snotXs.forEach((x, index) => {
    const studY = level - underPlaneOf(snotDefinition) + sideStud.pos[1]
    const studZ = 10 + sideStud.pos[2]
    if (rough) {
      // The first candidate works out where the tile goes and not which way it
      // faces: a flat tile at roughly the right point, mating nothing.
      build.placeAt('3069b', C.orange, x, studY - 4, studZ - 6, { ...facade, offGrid: true })
      return
    }
    build.snap('3069b', C.orange, [x, studY, studZ - 6], {
      ...facade,
      radiusLdu: 30,
      targetPartIds: [snotIds[index]],
      targetFeatureId: sideStud.id,
    })
  })

  build.addPlan(planBrickField(spec({
    sub: 'cap',
    origin: [0, capSurface, 0],
    color: C.darkBluishGrey,
    family: 'plate',
    widthStuds: 6,
    footprintDepthStuds: 6,
    layers: 2,
  })), { sub: 'cap' })

  return { build, notes: [], warnings: [] }
}const DEMOS = [
  {
    id: 'courtyard-terrace',
    title: 'Courtyard terrace',
    discipline: 'Architecture',
    tagline: 'A bonded storey, seated windows and a parapet roof, from four parametric calls.',
    summary:
      'Every course is offset against the one below, the corners alternate which run goes full length, '
      + 'and each opening holds a real compiled window or door frame chosen by measured footprint.',
    techniques: ['Running bond', 'Interlocking corners', 'Seated window and door frames', 'Cross-bonded slab'],
    refinement:
      'The first candidate laid a single-layer deck and cut bare holes where the openings are. '
      + 'Plates side by side in one plane do not clutch, so the deck came apart into loose strips.',
    camera: { yaw: 38, pitch: 26, zoom: 1 },
    maxPartsPerStep: 12,
    hero: true,
    brief: {
      prompt: 'A terrace block twenty studs by fourteen, six courses high, in tan, with two windows and a door across the front, and a roof you could stand a figure on.',
      envelopeStuds: [20, null, 14],
      palette: ['Tan', 'White', 'Dark Bluish Grey', 'Dark Tan'],
      functions: ['Bonded courses', 'Seated frames', 'Walkable roof'],
    },
    author: courtyardTerrace,
  },
  {
    id: 'ridgeline-hauler',
    title: 'Ridgeline hauler',
    discipline: 'Vehicle',
    tagline: 'A flatbed on two real wheel bricks, with a closed cab and a tiled deck.',
    summary:
      'The chassis is two plate layers whose seams deliberately miss each other, so the hauler is one '
      + 'rigid body rather than two halves that happen to touch.',
    techniques: ['Interlocked chassis', 'Wheel bricks as running gear', 'Tiled load bed'],
    refinement:
      'The first candidate locked the chassis with two 4 x 4 plates that left the centreline seam '
      + 'unbridged, so the front and rear halves were separate components.',
    camera: { yaw: -34, pitch: 22, zoom: 1 },
    maxPartsPerStep: 8,
    author: ridgelineHauler,
  },
  {
    id: 'heron-sculpture',
    title: 'Heron',
    discipline: 'Creature',
    tagline: 'A standing bird whose stability is measured, not assumed.',
    summary:
      'Slopes, round bricks and a cheese-slope beak, every one of them resting on a plane derived from '
      + 'its own compiled connectors rather than a nominal brick height.',
    techniques: ['Round-brick legs', 'Slope tail and wings', 'Measured tipping margin'],
    refinement:
      'The first candidate placed the head by coordinate in front of the body. It rendered perfectly and '
      + 'the load path from the ground never reached it.',
    camera: { yaw: 24, pitch: 14, zoom: 1 },
    maxPartsPerStep: 6,
    author: heronSculpture,
  },
  {
    id: 'shutter-bay',
    title: 'Shutter bay',
    discipline: 'Mechanism',
    tagline: 'A hinge the connection graph reads as a real revolute joint.',
    summary:
      'The shutter is a hinge-brick pair and a plate flap. The kernel records the joint with its freedom, '
      + 'so the same model can be opened from the inspector or by an agent.',
    techniques: ['Hinge-brick pair', 'Revolute joint in the graph', 'Seated window'],
    refinement:
      'The first candidate laid the shutter as free plates one course above the deck — a slab held by '
      + 'nothing, which the load-path walk never reaches.',
    camera: { yaw: -22, pitch: 30, zoom: 1 },
    maxPartsPerStep: 8,
    tensionAllowance: 5,
    tensionReason:
      'The hinge top plates and the flap they carry hang from the hinge rather than resting on it, '
      + 'which is what a hinge is. The statics pass reports them as carried in tension and checks that '
      + 'the clutch assumption covers their mass.',
    author: shutterBay,
  },
  {
    id: 'draughting-desk',
    title: 'Draughting desk',
    discipline: 'Furniture',
    tagline: 'Four legs, a braced underframe and a top that is a slab rather than a sheet.',
    summary:
      'Rails tie the legs at desk height so the top is carried at its edges, and both the shelf and the '
      + 'desktop are cross-bonded two-layer slabs.',
    techniques: ['Cross-bonded slab', 'Braced underframe', 'Tiled work surface'],
    refinement:
      'The first candidate laid the shelf and the desktop one plate deep. Single-layer plates in one plane '
      + 'do not clutch each other, so the middle of both surfaces was loose.',
    camera: { yaw: 42, pitch: 18, zoom: 1 },
    maxPartsPerStep: 8,
    author: draughtingDesk,
  },
  {
    id: 'snot-kiosk',
    title: 'SNOT kiosk',
    discipline: 'Advanced technique',
    tagline: 'Facade tiles placed on vertical studs by the 6-DOF connector solver.',
    summary:
      'A course of studs-on-side bricks turns the front wall sideways, and every facing tile is posed by '
      + '`bestSnapTransform` from the two connector frames — the same solver a drag in the editor uses.',
    techniques: ['Studs not on top', 'Solved connector frames', 'Cross-bonded cap'],
    refinement:
      'The first candidate stopped at the studs-on-side course: the sideways studs were exposed and the '
      + 'facade was never faced.',
    camera: { yaw: 12, pitch: 20, zoom: 1 },
    maxPartsPerStep: 10,
    tensionAllowance: 3,
    tensionReason:
      'The facing tiles hang off vertical studs. That is what studs-not-on-top means, and it is the one '
      + 'case where clutch is genuinely in tension, so the statics pass measures the load against the '
      + 'clutch assumption instead of waving it through.',
    author: snotKiosk,
  },
]

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
      ? [{
          id: 'note_plan',
          anchorPartIds: [],
          text: authored.notes.join(' '),
          status: 'resolved',
          author: HUMAN,
          revisionCreated: 1,
        }]
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
    delta.componentsAfter < delta.componentsBefore
    || delta.loosePartsAfter < delta.loosePartsBefore
    || delta.unsupportedAfter < delta.unsupportedBefore
    || delta.collisionsAfter < delta.collisionsBefore
  if (!improved) {
    failures.push(
      `${demo.id}: the first candidate is not measurably worse than the published model `
      + `(components ${delta.componentsBefore}→${delta.componentsAfter}, loose ${delta.loosePartsBefore}→${delta.loosePartsAfter}, `
      + `unsupported ${delta.unsupportedBefore}→${delta.unsupportedAfter}, collisions ${delta.collisionsBefore}→${delta.collisionsAfter}). `
      + 'Either the refinement is real and measurable, or it is not published.',
    )
    continue
  }

  const preview = buildPreview(refined.document, checks.validation)
  const roughPreview = buildPreview(roughBuild.document, roughValidation)

  const thumb = renderDocument(refined.document, { width: 720, height: 450, background: [17, 23, 25] })
  const social = renderDocument(refined.document, { width: 1200, height: 630, background: [12, 17, 19] })
  if (thumb.coverage < 0.04) failures.push(`${demo.id}: rendered thumbnail covers only ${(thumb.coverage * 100).toFixed(1)}% of the frame`)

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
    tagline: demo.tagline,
    summary: demo.summary,
    techniques: demo.techniques,
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
      catalogManifestGeneratedAt: manifest.generatedAt,
      catalogPartsHash: manifest.files.parts.hash,
      renderer: 'src/cad/raster.ts — offline software rasterizer, no browser',
      authoredAt: AUTHORED_AT,
    },
  })
  process.stdout.write(
    `  ${demo.id.padEnd(20)} ${String(refinedSummary.partCount).padStart(4)} parts  `
    + `${String(refinedSummary.connectionCount).padStart(5)} mates  ${String(refinedSummary.steps).padStart(3)} steps  `
    + `${refinedSummary.statics.massLabel.padStart(8)}  margin ${String(refinedSummary.statics.tippingMarginLdu).padStart(7)} LDU  `
    + `${Date.now() - started} ms\n`,
  )
}

if (failures.length) {
  process.stderr.write(`\nDemo build FAILED — ${failures.length} demo(s) rejected:\n\n${failures.join('\n\n')}\n\n`)
  await server.close()
  process.exit(1)
}

if (!ONLY.length && results.length < 6) {
  process.stderr.write(`\nDemo build FAILED — only ${results.length} demo(s) passed every gate; six are required.\n`)
  await server.close()
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
    'triangle-confirmed collision, twice, with no unverified verdicts',
    'one connected component over the derived connection graph',
    'derived build order re-verified against its own guarantee',
    'measured statics: full mass coverage, load path reaches every part, centre of mass inside the support polygon',
    'a measurably worse first candidate, so the refinement shown is real',
  ],
  demos: results,
}

if (ONLY.length) {
  process.stdout.write('\n--only run: manifest not rewritten\n')
  await server.close()
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

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalBytes = written.reduce((sum, entry) => sum + entry.bytes, 0)
process.stdout.write(`\n${results.length} demos, ${written.length} files, ${(totalBytes / 1024).toFixed(0)} KB\n`)
process.stdout.write(`catalog ${catalog.version} · ${catalog.placeableCount} placeable identities\n`)

if (CHECK_MODE) {
  const committedPublic = path.join(ROOT, 'public', 'demos')
  const committedSrc = path.join(ROOT, 'src', 'demos', 'manifest.generated.ts')
  const drift = []
  for (const entry of written) {
    const relative = path.relative(OUT_PUBLIC, path.join(ROOT, entry.file))
    void relative
  }
  const compare = async (generatedFile, committedFile) => {
    if (!existsSync(committedFile)) {
      drift.push(`${path.relative(ROOT, committedFile)} is missing from the committed tree`)
      return
    }
    const [a, b] = await Promise.all([readFile(generatedFile), readFile(committedFile)])
    if (!a.equals(b)) drift.push(`${path.relative(ROOT, committedFile)} differs from a fresh build (${a.byteLength} vs ${b.byteLength} bytes)`)
  }
  const walk = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const nested = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(nested, path.join(prefix, entry.name))
      else await compare(nested, path.join(committedPublic, prefix, entry.name))
    }
  }
  await walk(OUT_PUBLIC)
  await compare(path.join(OUT_SRC, 'manifest.generated.ts'), committedSrc)
  await rm(CHECK_ROOT, { recursive: true, force: true })
  if (drift.length) {
    process.stderr.write(`\nDeterminism check FAILED:\n  - ${drift.join('\n  - ')}\n`)
    await server.close()
    process.exit(1)
  }
  process.stdout.write('determinism check: a fresh build is byte-identical to the committed assets\n')
}

await server.close()
