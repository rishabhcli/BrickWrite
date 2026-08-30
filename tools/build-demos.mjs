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
const { planEnclosure, planBrickField, elementLibrary } = assemblyModule
const { findCollisions, geometryFromArrays } = collisionModule
const { getPartBounds } = geometryModule
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
    if (!definition.geometryAsset)
      throw new Error(`Demo references ${definitionId}, which has no compiled geometry in this build.`)
    return definition
  }

  #push(definition, color, position, basis, options) {
    // Solved poses come from the connector kernel and are correct by
    // construction — a studs-not-on-top tile is deliberately off the vertical
    // grid, so checking it would reject the very technique it is there to show.
    if (!options.solved && !options.offGrid)
      assertOnGrid(definition, position, basis, options.label ?? definition.canonicalId)
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
      throw new Error(
        `No connector on ${definitionId} mates anything within ${options.radiusLdu ?? 26} LDU of ${cursorPosition.join(', ')}.`,
      )
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
      if (operation.type !== 'part.add')
        throw new Error(`Assembly plan emitted an unexpected ${operation.type} operation.`)
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
        `${label}: ${definition.canonicalId} sits off the stud grid — its stud ${connector.id} lands at ` +
          `x ${world[0].toFixed(1)}, z ${world[2].toFixed(1)}, and stud centres are odd multiples of 10 LDU. ` +
          'A part centres on a multiple of 20 along an axis it spans an even number of studs on, ' +
          'and on an odd multiple of 10 along an axis it spans an odd number.',
      )
    }
  }
  if (seats && !aligned) {
    throw new Error(
      `${label}: ${definition.canonicalId} has ${seats} vertical connector(s) and not one of them lands on the ` +
        `stud grid at position ${position.map((value) => value.toFixed(1)).join(', ')}. It would rest on nothing.`,
    )
  }
}


const basisFor = (degrees) =>
  degrees % 90 === 0
    ? QUARTER_TURN_BASES[(((degrees / 90) % 4) + 4) % 4]
    : cleanBasis(basisFromEulerDegrees([0, degrees, 0]))

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
// The demos
// ---------------------------------------------------------------------------

const HUMAN = 'human'

/** Shared spec fields every parametric plan needs. */
const spec = (fields) => ({ actor: HUMAN, subassemblyId: fields.sub, stepId: 'step_1', ...fields })

/**
 * A display-scale interpretation of the University of Illinois Main Quad.
 *
 * This is intentionally not a single facade enlarged until the piece counter
 * looks impressive. The 120 x 80-stud site is a real three-layer landscape:
 * a cross-bonded structural slab, then 9,600 individually placeable finish
 * pieces describing lawn, paths, roads, plots and building pads. Seven named
 * buildings, the Alma Mater group, Morrow Plots, mature trees and brick-built
 * students sit on that common foundation. Every last piece is still an ordinary
 * catalog-backed PartInstance and therefore still goes through collision,
 * connection, instructions and statics with the rest of the collection.
 */
function illinoisMainQuad(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'site', name: 'Campus base and quad', accent: '#83e7ee' },
      { id: 'finish', name: 'Paths, lawns and building pads', accent: '#8bcf65' },
      { id: 'union', name: 'Illini Union', accent: '#f7b04a' },
      { id: 'foellinger', name: 'Foellinger Auditorium', accent: '#77b96a' },
      { id: 'altgeld', name: 'Altgeld Hall and Alma Mater', accent: '#d66b55' },
      { id: 'west_halls', name: 'West Quad halls', accent: '#d6a85d' },
      { id: 'east_halls', name: 'East Quad halls', accent: '#d98662' },
      { id: 'morrow', name: 'Morrow Plots', accent: '#8bcf65' },
      { id: 'landscape', name: 'Trees and campus furniture', accent: '#5da765' },
      { id: 'people', name: 'Students and visitors', accent: '#f5a33f' },
    ],
  })
  const notes = []
  const warnings = []
  const absorb = (plan, sub) => {
    build.addPlan(plan, { sub })
    notes.push(...(plan.notes ?? []))
    warnings.push(...(plan.warnings ?? []))
    return plan
  }

  const width = 120
  const depth = 80
  const baseLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'site',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers: baseLayers,
      }),
    ),
    'site',
  )
  const baseSurface = -baseLayers * PLATE_LDU

  // The first candidate is a genuine massing study on a one-layer site. The
  // large sheets touch but do not clutch, and the four block models only bind
  // the plates directly underneath them. The published pass resolves that
  // measurable failure with the cross-bonded base and the full campus above.
  if (rough) {
    const mass = (sub, x, z, w, d, courses, color) => {
      absorb(
        planEnclosure(
          spec({
            sub,
            origin: [x * STUD_LDU, baseSurface, z * STUD_LDU],
            color,
            family: 'brick',
            depthStuds: 1,
            widthStuds: w,
            footprintDepthStuds: d,
            courses,
            floor: false,
          }),
        ),
        sub,
      )
    }
    mass('union', 44, 2, 32, 12, 2, C.reddishBrown)
    mass('foellinger', 44, 66, 32, 12, 3, C.reddishBrown)
    mass('west_halls', 6, 20, 21, 43, 2, C.darkTan)
    mass('east_halls', 93, 20, 21, 43, 2, C.darkTan)
    return {
      build,
      notes: [
        'A one-layer site and four block models established the axial campus plan, but the slab remained a field of disconnected strips.',
      ],
      warnings,
    }
  }

  const BUILDING_ZONES = [
    { x0: 44, x1: 76, z0: 2, z1: 14 },
    { x0: 44, x1: 76, z0: 66, z1: 78 },
    { x0: 5, x1: 30, z0: 2, z1: 15 },
    { x0: 5, x1: 27, z0: 18, z1: 35 },
    { x0: 5, x1: 27, z0: 45, z1: 63 },
    { x0: 93, x1: 115, z0: 18, z1: 35 },
    { x0: 93, x1: 115, z0: 45, z1: 63 },
  ]
  const TREE_SITES = [
    [29, 20],
    [29, 31],
    [29, 49],
    [29, 60],
    [90, 20],
    [90, 31],
    [90, 49],
    [90, 60],
    [35, 15],
    [84, 15],
    [35, 64],
    [84, 64],
    [33, 22],
    [86, 22],
    [33, 57],
    [86, 57],
  ]
  // x and z are the stud cells carrying the campus figures.
  const FIGURE_SITES = [
    [39, 25],
    [43, 33],
    [48, 52],
    [53, 20],
    [55, 58],
    [58, 29],
    [62, 51],
    [65, 22],
    [69, 57],
    [73, 34],
    [78, 49],
    [82, 27],
    [34, 41],
    [47, 39],
    [73, 40],
    [86, 43],
    [58, 10],
    [63, 69],
  ]
  const forcedStuds = new Set([
    ...TREE_SITES.map(([x, z]) => `${x}:${z}`),
    ...FIGURE_SITES.map(([x, z]) => `${x}:${z}`),
    ...[49, 53, 57, 62, 66, 70].flatMap((x) => [`${x}:14`, `${x}:65`]),
  ])
  const inBuilding = (x, z) => BUILDING_ZONES.some((zone) => x >= zone.x0 && x < zone.x1 && z >= zone.z0 && z < zone.z1)
  const inMorrow = (x, z) => x >= 92 && x < 114 && z >= 68 && z < 78
  const inQuad = (x, z) => x >= 31 && x < 89 && z >= 14 && z < 66
  const onQuadPath = (x, z) => {
    if (!inQuad(x, z)) return false
    if (Math.abs(x - 60) <= 1 || Math.abs(z - 40) <= 1) return true
    if (x <= 60 && z <= 40 && Math.abs(z - 40 - 0.82 * (x - 60)) <= 0.85) return true
    if (x >= 60 && z <= 40 && Math.abs(z - 40 + 0.82 * (x - 60)) <= 0.85) return true
    if (x <= 60 && z >= 40 && Math.abs(z - 40 + 0.82 * (x - 60)) <= 0.85) return true
    if (x >= 60 && z >= 40 && Math.abs(z - 40 - 0.82 * (x - 60)) <= 0.85) return true
    return x <= 32 || x >= 87 || z <= 15 || z >= 64
  }

  // One finish piece per stud is what gives this scale model a readable site
  // plan instead of a green rectangle. Smooth tiles carry every path and road;
  // studded plates remain wherever architecture, vegetation or people attach.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const forced = forcedStuds.has(`${x}:${z}`)
      const building = inBuilding(x, z)
      const road = z < 2 || x < 2 || x >= width - 2
      const plot = inMorrow(x, z)
      const path = !building && (onQuadPath(x, z) || (z >= 7 && z <= 9) || (x >= 59 && x <= 61))
      const tiled = !forced && !building && (road || path)
      const color = road
        ? C.darkBluishGrey
        : path
          ? C.lightBluishGrey
          : plot
            ? (x + z) % 3 === 0
              ? C.reddishBrown
              : C.green
            : building
              ? C.darkTan
              : C.green
      build.place(tiled ? '3070b' : '3024', color, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, baseSurface, {
        sub: 'finish',
        label: `campus finish ${x},${z}`,
      })
    }
  }
  const campusSurface = baseSurface - PLATE_LDU

  const addBuilding = ({ sub, x, z, w, d, courses, color, roofColor, openings = [], parapet = true }) => {
    absorb(
      planEnclosure(
        spec({
          sub,
          origin: [x * STUD_LDU, campusSurface, z * STUD_LDU],
          color,
          trimColor: C.white,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: w,
          footprintDepthStuds: d,
          courses,
          floor: false,
          openings,
        }),
      ),
      sub,
    )
    const roofSurface = campusSurface - courses * BRICK_LDU
    absorb(
      planBrickField(
        spec({
          sub,
          origin: [x * STUD_LDU, roofSurface, z * STUD_LDU],
          color: roofColor,
          family: 'plate',
          widthStuds: w,
          footprintDepthStuds: d,
          layers: 2,
        }),
      ),
      sub,
    )
    const roofTop = roofSurface - 2 * PLATE_LDU
    if (parapet) {
      absorb(
        planEnclosure(
          spec({
            sub,
            origin: [x * STUD_LDU, roofTop, z * STUD_LDU],
            color: C.darkTan,
            family: 'brick',
            depthStuds: 1,
            widthStuds: w,
            footprintDepthStuds: d,
            courses: 1,
            floor: false,
          }),
        ),
        sub,
      )
    }
    return { roofTop }
  }
  const windows = (widthStuds, doorAt) => {
    const result = []
    for (let at = 3; at + 2 < widthStuds; at += 5) {
      if (Math.abs(at - doorAt) < 4) continue
      result.push({ atStud: at, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' })
    }
    if (doorAt >= 0) result.push({ atStud: doorAt, widthStuds: 4, fromCourse: 0, toCourse: 5, element: 'door' })
    return result
  }

  const union = addBuilding({
    sub: 'union',
    x: 44,
    z: 2,
    w: 32,
    d: 12,
    courses: 6,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(32, 14),
    parapet: false,
  })
  const foellinger = addBuilding({
    sub: 'foellinger',
    x: 44,
    z: 66,
    w: 32,
    d: 12,
    courses: 7,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(32, 14),
    parapet: false,
  })
  const altgeld = addBuilding({
    sub: 'altgeld',
    x: 5,
    z: 2,
    w: 24,
    d: 13,
    courses: 6,
    color: C.darkRed,
    roofColor: C.darkBluishGrey,
    openings: windows(24, 10),
    parapet: false,
  })
  addBuilding({
    sub: 'west_halls',
    x: 5,
    z: 18,
    w: 22,
    d: 17,
    courses: 6,
    color: C.darkTan,
    roofColor: C.darkBluishGrey,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'west_halls',
    x: 5,
    z: 45,
    w: 22,
    d: 18,
    courses: 6,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 93,
    z: 18,
    w: 22,
    d: 17,
    courses: 6,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 93,
    z: 45,
    w: 22,
    d: 18,
    courses: 6,
    color: C.darkTan,
    roofColor: C.darkBluishGrey,
    openings: windows(22, 9),
  })

  const stackColumn = (sub, xStud, zStud, courses, color = C.white) => {
    let surface = campusSurface
    for (let course = 0; course < courses; course += 1) {
      surface = build.place('3062b', color, xStud * STUD_LDU, zStud * STUD_LDU, surface, { sub })
    }
    return surface
  }
  // Colonnades face the Quad: south on the Union, north on Foellinger.
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('union', x, 14.5, 4)
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('foellinger', x, 65.5, 5)

  // Foellinger's copper dome: six bonded plate lifts narrow into two real
  // compiled cone elements, so the south-end silhouette remains unmistakable.
  let domeSurface = foellinger.roofTop
  for (const [w, d] of [
    [10, 8],
    [8, 6],
    [6, 4],
  ]) {
    absorb(
      planBrickField(
        spec({
          sub: 'foellinger',
          origin: [(60 - w / 2) * STUD_LDU, domeSurface, (72 - d / 2) * STUD_LDU],
          color: C.darkGreen,
          family: 'plate',
          widthStuds: w,
          footprintDepthStuds: d,
          layers: 2,
        }),
      ),
      'foellinger',
    )
    domeSurface -= 2 * PLATE_LDU
  }
  domeSurface = build.place('3943b', C.darkGreen, 60 * STUD_LDU, 72 * STUD_LDU, domeSurface, { sub: 'foellinger' })
  build.place('3942c', C.darkGreen, 60 * STUD_LDU, 72 * STUD_LDU, domeSurface, { sub: 'foellinger', offGrid: true })

  // The Union cupola and Altgeld bell tower make the north edge read as a
  // campus, not as a row of anonymous boxes.
  absorb(
    planEnclosure(
      spec({
        sub: 'union',
        origin: [57 * STUD_LDU, union.roofTop, 5 * STUD_LDU],
        color: C.white,
        family: 'brick',
        depthStuds: 1,
        widthStuds: 6,
        footprintDepthStuds: 6,
        courses: 2,
        floor: false,
      }),
    ),
    'union',
  )
  let cupolaSurface = union.roofTop - 2 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'union',
        origin: [57 * STUD_LDU, cupolaSurface, 5 * STUD_LDU],
        color: C.darkGreen,
        family: 'plate',
        widthStuds: 6,
        footprintDepthStuds: 6,
        layers: 2,
      }),
    ),
    'union',
  )
  cupolaSurface -= 2 * PLATE_LDU
  build.place('3943b', C.darkGreen, 60 * STUD_LDU, 8 * STUD_LDU, cupolaSurface, { sub: 'union' })

  absorb(
    planEnclosure(
      spec({
        sub: 'altgeld',
        origin: [7 * STUD_LDU, altgeld.roofTop, 3 * STUD_LDU],
        color: C.darkRed,
        family: 'brick',
        depthStuds: 1,
        widthStuds: 6,
        footprintDepthStuds: 6,
        courses: 4,
        floor: false,
      }),
    ),
    'altgeld',
  )
  let towerSurface = altgeld.roofTop - 4 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'altgeld',
        origin: [7 * STUD_LDU, towerSurface, 3 * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: 6,
        footprintDepthStuds: 6,
        layers: 2,
      }),
    ),
    'altgeld',
  )
  towerSurface -= 2 * PLATE_LDU
  build.place('3943b', C.darkGreen, 10 * STUD_LDU, 6 * STUD_LDU, towerSurface, { sub: 'altgeld' })

  // Alma Mater, Learning and Labor: three bronze statuette elements on a
  // stone plinth. The element is a catalog-backed minifigure silhouette, not a
  // painted cuboid, and each figure is separately selectable in the editor.
  let almaSurface = campusSurface
  almaSurface = build.place('3031', C.lightBluishGrey, 36 * STUD_LDU, 12 * STUD_LDU, almaSurface, { sub: 'altgeld' })
  almaSurface = build.place('3001', C.darkBluishGrey, 36 * STUD_LDU, 12 * STUD_LDU, almaSurface, { sub: 'altgeld' })
  for (const x of [34.5, 35.5, 36.5]) {
    const seat = build.place('3024', C.lightBluishGrey, x * STUD_LDU, 12.5 * STUD_LDU, almaSurface, { sub: 'altgeld' })
    build.place('90398', 80, x * STUD_LDU, 12.5 * STUD_LDU, seat, { sub: 'altgeld', offGrid: true })
  }

  // Morrow Plots, protected by their characteristic low perimeter fence.
  for (const z of [68.5, 77.5]) {
    for (const x of [94, 98, 102, 106, 110])
      build.place('3633', C.white, x * STUD_LDU, z * STUD_LDU, campusSurface, { sub: 'morrow' })
  }
  for (const x of [92.5, 113.5]) {
    for (const z of [71, 75])
      build.place('3633', C.white, x * STUD_LDU, z * STUD_LDU, campusSurface, { sub: 'morrow', rotY: 90 })
  }
  for (let z = 70; z <= 76; z += 2) {
    for (let x = 94; x <= 112; x += 3) {
      const cropSurface = build.place('3062b', C.green, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, campusSurface, {
        sub: 'morrow',
      })
      build.place('32607', (x + z) % 2 ? C.yellow : C.orange, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, cropSurface, {
        sub: 'morrow',
      })
    }
  }

  for (const [index, [x, z]] of TREE_SITES.entries()) {
    let surface = build.place('3062b', C.reddishBrown, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, campusSurface, {
      sub: 'landscape',
    })
    surface = build.place('3062b', C.reddishBrown, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, surface, {
      sub: 'landscape',
    })
    surface = build.place(
      '4727',
      index % 3 === 0 ? C.darkGreen : C.green,
      (x + 0.5) * STUD_LDU,
      (z + 0.5) * STUD_LDU,
      surface,
      {
        sub: 'landscape',
        rotY: (index % 4) * 90,
      },
    )
    build.place('4728', index % 4 === 0 ? C.green : C.darkGreen, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, surface, {
      sub: 'landscape',
      rotY: ((index + 1) % 4) * 90,
    })
  }

  const figureColors = [C.orange, C.blue, C.white, C.mediumBlue, C.green, C.darkBluishGrey]
  for (const [index, [x, z]] of FIGURE_SITES.entries()) {
    const worldX = (x + 0.5) * STUD_LDU
    const worldZ = (z + 0.5) * STUD_LDU
    build.place('90398', figureColors[index % figureColors.length], worldX, worldZ, campusSurface, { sub: 'people' })
  }

  notes.push(
    'The site follows the Main Quad axis: Illini Union at the north, Foellinger Auditorium at the south, academic halls on both flanks, Altgeld and Alma Mater at the northwest, and Morrow Plots at the southeast.',
    'Eighteen campus figures and the three-figure Alma Mater group are ordinary selectable parts in the same document as the architecture.',
  )
  return { build, notes, warnings }
}

/**
 * A modular high-rise that comes apart floor by floor.
 *
 * The point of this one is not the piece count, it is the seam. Every storey is
 * its own subassembly sitting on the deck of the one below, exactly the way a
 * modular building is designed to lift apart in the hand, so the layer scrubber
 * in the viewer is showing real structure rather than slicing a solid lump at
 * arbitrary heights. Facades carry real seated window frames chosen from the
 * compiled catalogue by measured width, which is the single thing that stops a
 * generated elevation reading as a box with a texture on it.
 */
function meridianTower(rough) {
  const FLOORS = rough ? 4 : 22
  const WIDTH = 40
  // A slab tower. The deck between storeys is carried only by the walls at its
  // perimeter, so the depth is held to the span the collection already proves
  // safe: go wider and the middle of every floor is unreachable from the ground,
  // which is exactly what the statics gate refuses.
  const DEPTH = 12
  const PLAZA_W = 58
  const PLAZA_D = 30
  const OX = 9
  const OZ = 9
  const COURSES = 5

  const storeys = Array.from({ length: FLOORS }, (_, index) => ({
    id: `floor_${String(index + 1).padStart(2, '0')}`,
    name: `Storey ${index + 1}`,
    accent: index % 2 === 0 ? '#83e7ee' : '#f7b04a',
  }))

  const build = new Build({
    subassemblies: [
      { id: 'plaza', name: 'Plaza and street deck', accent: '#7f8c9b' },
      { id: 'lobby', name: 'Lobby', accent: '#8bcf65' },
      ...storeys,
      { id: 'crown', name: 'Crown and mast', accent: '#d66b55' },
    ],
  })

  const notes = []
  const warnings = []
  const absorb = (plan, sub) => {
    build.addPlan(plan, { sub })
    notes.push(...(plan.notes ?? []))
    warnings.push(...(plan.warnings ?? []))
    return plan
  }

  // Widths the compiled catalogue actually has frames for. Asking rather than
  // hard-coding means a catalogue rebuild cannot leave holes where windows were.
  const windowWidths = [...new Set(elementLibrary('window').map((entry) => entry.widthStuds))].sort((a, b) => a - b)
  const bay = windowWidths.includes(2) ? 2 : (windowWidths[0] ?? 2)

  // A band of evenly spaced windows along a wall of `lengthStuds`, inset from
  // the corners so the structure that carries the floor above stays solid.
  const band = (lengthStuds, doorAt = -1) => {
    const openings = []
    for (let at = 3; at + bay < lengthStuds; at += 5) {
      if (doorAt >= 0 && Math.abs(at - doorAt) < 4) continue
      openings.push({ atStud: at, widthStuds: bay, fromCourse: 1, toCourse: 2, element: 'window' })
    }
    if (doorAt >= 0) openings.push({ atStud: doorAt, widthStuds: 4, fromCourse: 0, toCourse: 5, element: 'door' })
    return openings
  }

  const plazaLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'plaza',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: PLAZA_W,
        footprintDepthStuds: PLAZA_D,
        layers: plazaLayers,
      }),
    ),
    'plaza',
  )
  let surface = -plazaLayers * PLATE_LDU

  // People first, so the paving can leave their cells clear: a figure standing
  // on a smooth tile has nothing to clutch, and one dropped on top of a laid
  // tile is simply inside it. Both are things the kernel refuses, correctly.
  const plazaSurface = surface
  const outsideTower = (x, z) => !(x >= OX - 1 && x < OX + WIDTH + 1 && z >= OZ - 1 && z < OZ + DEPTH + 1)
  const figures = []
  for (let index = 0; index < (rough ? 2 : 14); index += 1) {
    const x = 2 + ((index * 7) % (PLAZA_W - 4))
    const z = index % 2 === 0 ? 5 : PLAZA_D - 6
    if (!outsideTower(x, z)) continue
    figures.push({ x, z, color: index % 3 === 0 ? C.red : index % 3 === 1 ? C.blue : C.yellow })
  }
  const takenByFigure = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))

  // Paving, laid one tile at a time. The plaza is editable at the same grain as
  // the tower rather than being a single painted slab, and the kerb line falls
  // out of the tile colour rather than being drawn on.
  for (let x = 0; x < PLAZA_W; x += 1) {
    for (let z = 0; z < PLAZA_D; z += 1) {
      if (x >= OX && x < OX + WIDTH && z >= OZ && z < OZ + DEPTH) continue
      if (takenByFigure.has(`${x}:${z}`)) continue
      const carriageway = z < 3 || z >= PLAZA_D - 3
      const kerb = z === 3 || z === PLAZA_D - 4
      build.place(
        '3070b',
        carriageway ? C.darkBluishGrey : kerb ? C.white : C.lightBluishGrey,
        (x + 0.5) * STUD_LDU,
        (z + 0.5) * STUD_LDU,
        plazaSurface,
        { sub: 'plaza' },
      )
    }
  }

  for (const figure of figures) {
    build.place('90398', figure.color, (figure.x + 0.5) * STUD_LDU, (figure.z + 0.5) * STUD_LDU, plazaSurface, {
      sub: 'plaza',
    })
  }

  const storeyPalette = [C.sand, C.tan, C.white, C.lightBluishGrey]
  const raise = (sub, color, courses, openings) => {
    absorb(
      planEnclosure(
        spec({
          sub,
          origin: [OX * STUD_LDU, surface, OZ * STUD_LDU],
          color,
          trimColor: C.white,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: WIDTH,
          footprintDepthStuds: DEPTH,
          courses,
          floor: false,
          openings,
        }),
      ),
      sub,
    )
    surface -= courses * BRICK_LDU
    // The deck the next storey lifts off. Two cross-bonded layers, because a
    // floor that comes apart when the storey is picked up is not a floor.
    absorb(
      planBrickField(
        spec({
          sub,
          origin: [OX * STUD_LDU, surface, OZ * STUD_LDU],
          color: C.lightBluishGrey,
          family: 'plate',
          widthStuds: WIDTH,
          footprintDepthStuds: DEPTH,
          layers: 2,
        }),
      ),
      sub,
    )
    surface -= 2 * PLATE_LDU
  }

  // A double-height lobby, glazed the whole way round.
  raise('lobby', C.darkBluishGrey, COURSES + 2, band(WIDTH, 11))

  for (const storey of storeys) {
    raise(storey.id, storeyPalette[storeys.indexOf(storey) % storeyPalette.length], COURSES, band(WIDTH))
  }

  // Crown: a stepped setback and a mast, so the silhouette resolves instead of
  // stopping flat where the last storey happens to end.
  absorb(
    planEnclosure(
      spec({
        sub: 'crown',
        origin: [(OX + 3) * STUD_LDU, surface, (OZ + 3) * STUD_LDU],
        color: C.darkBluishGrey,
        trimColor: C.white,
        glassColor: C.transLightBlue,
        family: 'brick',
        depthStuds: 1,
        widthStuds: WIDTH - 6,
        footprintDepthStuds: DEPTH - 6,
        courses: 3,
        floor: false,
        openings: [],
      }),
    ),
    'crown',
  )
  surface -= 3 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'crown',
        origin: [(OX + 3) * STUD_LDU, surface, (OZ + 3) * STUD_LDU],
        color: C.lightBluishGrey,
        family: 'plate',
        widthStuds: WIDTH - 6,
        footprintDepthStuds: DEPTH - 6,
        layers: 2,
      }),
    ),
    'crown',
  )
  surface -= 2 * PLATE_LDU

  // A 1 x 1 spans one stud on both axes, so it centres on an odd multiple of
  // 10 LDU — half a stud off the even grid the walls are laid on.
  const mastX = (OX + WIDTH / 2) * STUD_LDU + STUD_LDU / 2
  const mastZ = (OZ + DEPTH / 2) * STUD_LDU + STUD_LDU / 2
  let mastSurface = surface
  for (let level = 0; level < 6; level += 1) {
    mastSurface = build.place('3062b', level % 2 === 0 ? C.white : C.red, mastX, mastZ, mastSurface, { sub: 'crown' })
  }

  return { build, notes, warnings }
}

/**
 * A terrace of five modular shopfronts, the other shape a town block comes in.
 *
 * Same rule as the tower: every storey of every building is its own
 * subassembly, so the block comes apart building by building and floor by
 * floor rather than being one welded lump. The street itself is laid a tile at
 * a time — carriageway, kerb and pavement fall out of the tile colour rather
 * than being drawn on — which is what makes the ground plane editable at the
 * same grain as the buildings standing on it.
 */
function harbourStreet(rough) {
  const UNITS = rough ? 2 : 5
  const UNIT_W = 14
  const DEPTH = 12
  const COURSES = 5
  const STOREYS = rough ? 2 : 3
  const SITE_W = UNITS * UNIT_W + 6
  const SITE_D = 34
  const ROW_Z = 16

  const units = Array.from({ length: UNITS }, (_, index) => ({
    id: `unit_${index + 1}`,
    name: `Shopfront ${index + 1}`,
    accent: ['#d66b55', '#f7b04a', '#77b96a', '#83e7ee', '#d6a85d'][index % 5],
  }))

  const build = new Build({
    subassemblies: [
      { id: 'street', name: 'Street, kerb and pavement', accent: '#7f8c9b' },
      ...units,
    ],
  })

  const notes = []
  const warnings = []
  const absorb = (plan, sub) => {
    build.addPlan(plan, { sub })
    notes.push(...(plan.notes ?? []))
    warnings.push(...(plan.warnings ?? []))
    return plan
  }

  const windowWidths = [...new Set(elementLibrary('window').map((entry) => entry.widthStuds))].sort((a, b) => a - b)
  const bay = windowWidths.includes(2) ? 2 : (windowWidths[0] ?? 2)
  const shopfront = (lengthStuds, doorAt) => {
    const openings = []
    for (let at = 2; at + bay < lengthStuds; at += 4) {
      if (doorAt >= 0 && Math.abs(at - doorAt) < 5) continue
      openings.push({ atStud: at, widthStuds: bay, fromCourse: 1, toCourse: 2, element: 'window' })
    }
    // The frame has to fit the storey it is cut into: a door reaching past the
    // top course pokes through the deck above and the kernel counts that, twice,
    // as a collision and as a break in the build order.
    if (doorAt >= 0)
      openings.push({ atStud: doorAt, widthStuds: 4, fromCourse: 0, toCourse: COURSES - 1, element: 'door' })
    return openings
  }

  const groundLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'street',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: SITE_W,
        footprintDepthStuds: SITE_D,
        layers: groundLayers,
      }),
    ),
    'street',
  )
  const groundSurface = -groundLayers * PLATE_LDU

  const onTerrace = (x, z) => x >= 3 && x < 3 + UNITS * UNIT_W && z >= ROW_Z && z < ROW_Z + DEPTH
  const figures = []
  for (let index = 0; index < (rough ? 2 : 18); index += 1) {
    const x = 1 + ((index * 5) % (SITE_W - 2))
    const z = index % 3 === 0 ? 12 : index % 3 === 1 ? 13 : ROW_Z + DEPTH + 1
    if (onTerrace(x, z) || z >= SITE_D - 1) continue
    figures.push({ x, z, color: [C.red, C.blue, C.yellow, C.green, C.white][index % 5] })
  }
  const taken = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))

  // Inset by a stud: the base field fills its outer corners with round plates
  // whose studs a flat tile cannot sit down onto, and the exposed border reads
  // as the edge of the plate anyway.
  for (let x = 1; x < SITE_W - 1; x += 1) {
    for (let z = 1; z < SITE_D - 1; z += 1) {
      if (onTerrace(x, z) || taken.has(`${x}:${z}`)) continue
      const carriageway = z < 9
      const kerb = z === 9
      build.place(
        '3070b',
        carriageway ? C.black : kerb ? C.white : C.lightBluishGrey,
        (x + 0.5) * STUD_LDU,
        (z + 0.5) * STUD_LDU,
        groundSurface,
        { sub: 'street' },
      )
    }
  }

  for (const figure of figures) {
    build.place('90398', figure.color, (figure.x + 0.5) * STUD_LDU, (figure.z + 0.5) * STUD_LDU, groundSurface, {
      sub: 'street',
    })
  }

  const facades = [C.reddishBrown, C.sand, C.darkTan, C.white, C.tan]
  units.forEach((unit, index) => {
    const x = 3 + index * UNIT_W
    let surface = groundSurface
    for (let storey = 0; storey < STOREYS; storey += 1) {
      absorb(
        planEnclosure(
          spec({
            sub: unit.id,
            origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
            color: facades[index % facades.length],
            trimColor: C.white,
            glassColor: C.transLightBlue,
            family: 'brick',
            depthStuds: 1,
            widthStuds: UNIT_W,
            footprintDepthStuds: DEPTH,
            courses: COURSES,
            floor: false,
            openings: storey === 0 ? shopfront(UNIT_W, 5) : shopfront(UNIT_W, -1),
          }),
        ),
        unit.id,
      )
      surface -= COURSES * BRICK_LDU
      absorb(
        planBrickField(
          spec({
            sub: unit.id,
            origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
            color: C.lightBluishGrey,
            family: 'plate',
            widthStuds: UNIT_W,
            footprintDepthStuds: DEPTH,
            layers: 2,
          }),
        ),
        unit.id,
      )
      surface -= 2 * PLATE_LDU
    }
    // A parapet, so the roofline is a roofline and not a cut.
    absorb(
      planEnclosure(
        spec({
          sub: unit.id,
          origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
          color: C.darkBluishGrey,
          family: 'brick',
          depthStuds: 1,
          widthStuds: UNIT_W,
          footprintDepthStuds: DEPTH,
          courses: 1,
          floor: false,
          openings: [],
        }),
      ),
      unit.id,
    )
  })

  return { build, notes, warnings }
}

const DEMOS = [
  {
    id: 'harbour-street',
    title: 'Harbour Street',
    discipline: 'Modular architecture',
    tagline: 'A terrace of five shopfronts on a tiled street, every building and every floor separable.',
    summary: 'Five shopfronts on a tiled street. Every building lifts out, every floor lifts off.',
    techniques: [
      'One subassembly per storey, per unit',
      'Tiled carriageway, kerb and pavement',
      'Seated shopfront doors and glazing',
      'Parapet roofline',
    ],
    refinement:
      'The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came ' +
      'apart and the street was a texture. The published set separates every unit and every floor, and lays the ' +
      'road surface as individual tiles.',
    camera: { yaw: 34, pitch: 26, zoom: 1.12 },
    maxPartsPerStep: 72,
    tensionAllowance: 480,
    tensionReason:
      'Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter ' +
      'rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is ' +
      'bounded so a genuinely unsupported storey still fails.',
    hero: false,
    brief: {
      prompt:
        'A street of five modular shops with flats above, on a tiled road with kerbs and pavement, where every building and every floor can be lifted off separately.',
      envelopeStuds: [76, null, 34],
      palette: ['Reddish Brown', 'Sand', 'Dark Tan', 'White', 'Tan'],
      functions: ['Separable units and storeys', 'Glazed shopfronts', 'Verified build sequence'],
    },
    author: harbourStreet,
  },
  {
    id: 'meridian-tower',
    title: 'Meridian Tower',
    discipline: 'Modular architecture',
    tagline: 'A twenty-two-storey modular high-rise that lifts apart floor by floor, with real seated glazing.',
    summary: 'Twenty-two storeys, each its own subassembly. Every floor lifts off the one below it.',
    techniques: [
      'One subassembly per storey',
      'Cross-bonded deck between floors',
      'Seated window frames on every elevation',
      'Stepped crown and mast',
    ],
    refinement:
      'The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the ' +
      'facades were blank. The published set separates every floor onto its own two-layer deck and glazes the ' +
      'elevations with frames the catalogue actually compiles.',
    camera: { yaw: 38, pitch: 18, zoom: 1.06 },
    maxPartsPerStep: 72,
    tensionAllowance: 640,
    tensionReason:
      'Two things in this model are held in bearing rather than in clutch, and the statics pass counts both as ' +
      'tension-carried. The glazing is seated inside its frames, and the middle of each storey deck rests on the ' +
      'walls below it at the perimeter rather than clutching down into them. Both are how a modular building is ' +
      'actually assembled; the allowance is bounded so a genuinely floating storey still fails the gate.',
    hero: false,
    brief: {
      prompt:
        'A twenty-two-storey modular tower on a plaza, where every floor lifts off separately, the elevations carry real windows, and the crown steps back to a mast.',
      envelopeStuds: [58, null, 30],
      palette: ['Sand', 'Tan', 'White', 'Light Bluish Grey', 'Dark Bluish Grey'],
      functions: ['Separable storeys', 'Glazed elevations', 'Verified build sequence'],
    },
    author: meridianTower,
  },
  {
    id: 'illinois-main-quad',
    title: 'Illinois Main Quad campus',
    discipline: 'Campus architecture',
    tagline:
      'A 120 × 80-stud university campus with seven landmarks, a tiled quad, trees, Morrow Plots and 21 LEGO characters.',
    summary:
      'A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, ' +
      'Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and ' +
      'brick-built students. The site finish alone is 9,600 individually editable pieces over a cross-bonded base.',
    techniques: [
      '10,000+ catalog-backed pieces',
      'Cross-bonded 120 × 80-stud foundation',
      'Seven named campus landmarks',
      'Stepped copper dome and bell tower',
      '18 campus figures',
      'Three-figure Alma Mater group',
    ],
    refinement:
      'The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. ' +
      'The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings, ' +
      'and adds the 9,600-piece landscape, characters and buildable campus life.',
    camera: { yaw: 34, pitch: 54, zoom: 0.96 },
    showcase: { landmarkCount: 7, characterCount: 21, siteFinishParts: 9_600 },
    showcaseProof: { characterDefinitionIds: ['90398'], siteFinishSubassemblyId: 'finish' },
    maxPartsPerStep: 64,
    tensionAllowance: 256,
    tensionReason:
      'Window panes are seated inside their frames rather than carried in vertical compression. The statics pass ' +
      'counts those glazed inserts as tension-carried, measures their mass, and still checks every attachment group ' +
      'against the conservative clutch assumption.',
    hero: true,
    brief: {
      prompt:
        'Build a display-scale replica of the University of Illinois Main Quad with the Union and Foellinger on axis, Altgeld and Alma Mater, academic halls, Morrow Plots, trees, paths, and enough students to make it feel alive. It must exceed ten thousand real pieces and still pass the physical kernel.',
      envelopeStuds: [120, null, 80],
      palette: ['Illinois orange and blue', 'Campus red brick', 'Copper green', 'Quad green', 'Limestone white'],
      functions: [
        '10,000+ editable pieces',
        'Recognisable campus landmarks',
        'LEGO characters',
        'Verified build sequence',
      ],
    },
    author: illinoisMainQuad,
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
      catalogManifestGeneratedAt: manifest.generatedAt,
      catalogPartsHash: manifest.files.parts.hash,
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
  await server.close()
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
  await rm(CHECK_ROOT, { recursive: true, force: true })
  if (drift.length) {
    process.stderr.write(`\nDeterminism check FAILED:\n  - ${drift.join('\n  - ')}\n`)
    await server.close()
    process.exit(1)
  }
  process.stdout.write('determinism check: a fresh build is byte-identical to the committed assets\n')
}

await server.close()
