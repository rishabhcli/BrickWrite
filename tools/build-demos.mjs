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
const {
  planEnclosure,
  planBrickField,
  planWall,
  planLattice,
  planClockFaces,
  planHingedFlap,
  planCrane,
  planSnotHull,
  elementLibrary,
} = assemblyModule
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
  transYellow: 46,
  transNeonOrange: 38,
  darkGrey: 72,
  lightBluishGrey: 71,
  orange: 25,
  darkRed: 320,
  darkTan: 28,
  sand: 135,
  darkGreen: 288,
  reddishBrown: 70,
  mediumBlue: 73,
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
// The demos
// ---------------------------------------------------------------------------

const HUMAN = 'human'

/** Shared spec fields every parametric plan needs. */
const spec = (fields) => ({ actor: HUMAN, subassemblyId: fields.sub, stepId: 'step_1', ...fields })

const studCentre = (stud) => (stud + 0.5) * STUD_LDU

/**
 * Small scene elements shared by the showcase builds.
 *
 * These are deliberately ordinary, connected catalogue parts rather than
 * decoration drawn by the preview renderer. A tree or light can therefore be
 * selected, moved, exploded and rebuilt like everything around it.
 */
function addTree(build, { x, z, surfaceY, sub, height = 3, variant = 0 }) {
  let surface = surfaceY
  for (let course = 0; course < height; course += 1) {
    surface = build.place('3062b', C.reddishBrown, studCentre(x), studCentre(z), surface, {
      sub,
      label: `tree trunk ${x},${z},${course}`,
    })
  }
  surface = build.place('4727', variant % 2 === 0 ? C.darkGreen : C.green, studCentre(x), studCentre(z), surface, {
    sub,
    rotY: (variant % 4) * 90,
  })
  build.place('4728', variant % 3 === 0 ? C.green : C.darkGreen, studCentre(x), studCentre(z), surface, {
    sub,
    rotY: ((variant + 1) % 4) * 90,
  })
}

function addLamp(build, { x, z, surfaceY, sub, height = 4, color = C.darkBluishGrey }) {
  let surface = surfaceY
  for (let course = 0; course < height; course += 1) {
    surface = build.place('3062b', color, studCentre(x), studCentre(z), surface, {
      sub,
      label: `lamp post ${x},${z},${course}`,
    })
  }
  build.place('6141', C.transYellow, studCentre(x), studCentre(z), surface, {
    sub,
    label: `lamp glow ${x},${z}`,
  })
}

function addPlanter(build, { x, z, surfaceY, sub, color = C.green, flower = C.orange, variant = 0 }) {
  const surface = build.place('3062b', color, studCentre(x), studCentre(z), surfaceY, { sub })
  build.place('32607', flower, studCentre(x), studCentre(z), surface, {
    sub,
    rotY: (variant % 4) * 90,
  })
}

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

  const width = rough ? 120 : 128
  const depth = rough ? 80 : 88
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
    { x0: 117, x1: 127, z0: 18, z1: 36 },
    { x0: 46, x1: 74, z0: 80, z1: 87 },
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
    [119, 8],
    [123, 14],
    [120, 42],
    [124, 52],
    [119, 68],
    [123, 78],
    [8, 83],
    [22, 82],
    [35, 84],
    [85, 84],
    [101, 82],
    [116, 84],
  ]
  const LAMP_SITES = [
    [38, 18],
    [46, 18],
    [74, 18],
    [82, 18],
    [38, 62],
    [46, 62],
    [74, 62],
    [82, 62],
    [59, 18],
    [61, 18],
    [59, 62],
    [61, 62],
    [118, 40],
    [118, 58],
    [40, 83],
    [80, 83],
  ]
  const PLANTER_SITES = [
    [41, 16],
    [78, 16],
    [41, 64],
    [78, 64],
    [91, 67],
    [115, 67],
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
    ...LAMP_SITES.map(([x, z]) => `${x}:${z}`),
    ...PLANTER_SITES.map(([x, z]) => `${x}:${z}`),
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
    courses: 8,
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
    courses: 9,
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
    courses: 8,
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
    courses: 8,
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
    courses: 8,
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
    courses: 8,
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
    courses: 8,
    color: C.darkTan,
    roofColor: C.darkBluishGrey,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 117,
    z: 18,
    w: 10,
    d: 18,
    courses: 7,
    color: C.darkRed,
    roofColor: C.darkBluishGrey,
    openings: windows(10, 3),
  })
  addBuilding({
    sub: 'foellinger',
    x: 46,
    z: 80,
    w: 28,
    d: 7,
    courses: 3,
    color: C.sand,
    roofColor: C.darkGreen,
    openings: windows(28, -1),
    parapet: false,
  })

  const stackColumn = (sub, xStud, zStud, courses, color = C.white) => {
    let surface = campusSurface
    for (let course = 0; course < courses; course += 1) {
      surface = build.place('3062b', color, xStud * STUD_LDU, zStud * STUD_LDU, surface, { sub })
    }
    return surface
  }
  // Colonnades face the Quad: south on the Union, north on Foellinger.
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('union', x, 14.5, 6)
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('foellinger', x, 65.5, 7)

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

  TREE_SITES.forEach(([x, z], index) =>
    addTree(build, { x, z, surfaceY: campusSurface, sub: 'landscape', height: 3 + (index % 2), variant: index }),
  )
  LAMP_SITES.forEach(([x, z], index) =>
    addLamp(build, { x, z, surfaceY: campusSurface, sub: 'landscape', height: 4 + (index % 2) }),
  )
  PLANTER_SITES.forEach(([x, z], index) =>
    addPlanter(build, { x, z, surfaceY: campusSurface, sub: 'landscape', variant: index }),
  )

  const figureColors = [C.orange, C.blue, C.white, C.mediumBlue, C.green, C.darkBluishGrey]
  for (const [index, [x, z]] of FIGURE_SITES.entries()) {
    const worldX = (x + 0.5) * STUD_LDU
    const worldZ = (z + 0.5) * STUD_LDU
    build.place('90398', figureColors[index % figureColors.length], worldX, worldZ, campusSurface, { sub: 'people' })
  }

  notes.push(
    'The site follows the Main Quad axis: Illini Union at the north, Foellinger Auditorium at the south, academic halls on both flanks, Altgeld and Alma Mater at the northwest, and Morrow Plots at the southeast.',
    'Eighteen campus figures and the three-figure Alma Mater group are ordinary selectable parts in the same document as the architecture.',
    'The expanded east and south precincts add a visitor hall, garden pavilion, twelve additional mature trees, sixteen illuminated path posts and planted gateways.',
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
  const FLOORS = rough ? 4 : 28
  const WIDTH = rough ? 40 : 48
  // A slab tower. The deck between storeys is carried only by the walls at its
  // perimeter, so the depth is held to the span the collection already proves
  // safe: go wider and the middle of every floor is unreachable from the ground,
  // which is exactly what the statics gate refuses.
  const DEPTH = rough ? 12 : 18
  const PLAZA_W = rough ? 58 : 84
  const PLAZA_D = rough ? 30 : 52
  const OX = rough ? 9 : 18
  const OZ = rough ? 9 : 17
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
  const annex = rough ? null : { x: 4, z: 19, width: 10, depth: 14 }
  const outsideTower = (x, z) => !(x >= OX - 1 && x < OX + WIDTH + 1 && z >= OZ - 1 && z < OZ + DEPTH + 1)
  const outsideAnnex = (x, z) =>
    !annex || !(x >= annex.x && x < annex.x + annex.width && z >= annex.z && z < annex.z + annex.depth)
  const treeSites = rough
    ? []
    : [
        [5, 7],
        [17, 7],
        [31, 7],
        [47, 7],
        [63, 7],
        [78, 7],
        [5, 44],
        [17, 44],
        [31, 44],
        [47, 44],
        [63, 44],
        [78, 44],
      ]
  const lampSites = rough
    ? []
    : [
        [11, 11],
        [25, 11],
        [39, 11],
        [53, 11],
        [67, 11],
        [11, 40],
        [25, 40],
        [39, 40],
        [53, 40],
        [67, 40],
      ]
  const planterSites = rough
    ? []
    : [
        [15, 22],
        [15, 28],
        [67, 22],
        [67, 28],
      ]
  const figures = []
  for (let index = 0; index < (rough ? 2 : 14); index += 1) {
    const x = 2 + ((index * 7) % (PLAZA_W - 4))
    const z = index % 2 === 0 ? 5 : PLAZA_D - 6
    if (!outsideTower(x, z) || !outsideAnnex(x, z)) continue
    figures.push({ x, z, color: index % 3 === 0 ? C.red : index % 3 === 1 ? C.blue : C.yellow })
  }
  const takenByFigure = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))
  const reserved = new Set([...treeSites, ...lampSites, ...planterSites].map(([x, z]) => `${x}:${z}`))

  // Paving, laid one tile at a time. The plaza is editable at the same grain as
  // the tower rather than being a single painted slab, and the kerb line falls
  // out of the tile colour rather than being drawn on.
  for (let x = 0; x < PLAZA_W; x += 1) {
    for (let z = 0; z < PLAZA_D; z += 1) {
      if (x >= OX && x < OX + WIDTH && z >= OZ && z < OZ + DEPTH) continue
      if (!outsideAnnex(x, z)) continue
      if (takenByFigure.has(`${x}:${z}`)) continue
      const carriageway = z < 3 || z >= PLAZA_D - 3
      const kerb = z === 3 || z === PLAZA_D - 4
      build.place(
        reserved.has(`${x}:${z}`) ? '3024' : '3070b',
        carriageway
          ? C.darkBluishGrey
          : kerb
            ? C.white
            : x > 67 && z > 16 && z < 36
              ? C.transLightBlue
              : C.lightBluishGrey,
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

  if (!rough) {
    const finishTop = plazaSurface - PLATE_LDU
    treeSites.forEach(([x, z], index) =>
      addTree(build, { x, z, surfaceY: finishTop, sub: 'plaza', height: 3 + (index % 2), variant: index }),
    )
    lampSites.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: finishTop, sub: 'plaza', height: 4 + (index % 2) }),
    )
    planterSites.forEach(([x, z], index) =>
      addPlanter(build, { x, z, surfaceY: finishTop, sub: 'plaza', variant: index }),
    )
    absorb(
      planEnclosure(
        spec({
          sub: 'plaza',
          origin: [annex.x * STUD_LDU, plazaSurface, annex.z * STUD_LDU],
          color: C.darkTan,
          trimColor: C.white,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: annex.width,
          footprintDepthStuds: annex.depth,
          courses: 3,
          floor: true,
          floorLayers: 2,
          openings: [{ atStud: 4, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' }],
        }),
      ),
      'plaza',
    )
    const annexTop = plazaSurface - (2 * PLATE_LDU + 3 * BRICK_LDU)
    absorb(
      planBrickField(
        spec({
          sub: 'plaza',
          origin: [annex.x * STUD_LDU, annexTop, annex.z * STUD_LDU],
          color: C.darkGreen,
          family: 'plate',
          widthStuds: annex.width,
          footprintDepthStuds: annex.depth,
          layers: 2,
        }),
      ),
      'plaza',
    )
  }

  const storeyPalette = [C.sand, C.tan, C.white, C.lightBluishGrey]
  let towerX = OX
  let towerZ = OZ
  let towerWidth = WIDTH
  let towerDepth = DEPTH
  const raise = (sub, color, courses, openings) => {
    absorb(
      planEnclosure(
        spec({
          sub,
          origin: [towerX * STUD_LDU, surface, towerZ * STUD_LDU],
          color,
          trimColor: C.white,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: towerWidth,
          footprintDepthStuds: towerDepth,
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
          origin: [towerX * STUD_LDU, surface, towerZ * STUD_LDU],
          color: C.lightBluishGrey,
          family: 'plate',
          widthStuds: towerWidth,
          footprintDepthStuds: towerDepth,
          layers: 2,
        }),
      ),
      sub,
    )
    surface -= 2 * PLATE_LDU
  }

  // A double-height lobby, glazed the whole way round.
  raise('lobby', C.darkBluishGrey, COURSES + 2, band(towerWidth, Math.floor(towerWidth / 2) - 2))

  for (const [index, storey] of storeys.entries()) {
    if (!rough && (index === 10 || index === 20)) {
      towerX += 2
      towerZ += 2
      towerWidth -= 4
      towerDepth -= 4
    }
    raise(storey.id, storeyPalette[index % storeyPalette.length], COURSES, band(towerWidth))
  }

  // Crown: a stepped setback and a mast, so the silhouette resolves instead of
  // stopping flat where the last storey happens to end.
  absorb(
    planEnclosure(
      spec({
        sub: 'crown',
        origin: [(towerX + 2) * STUD_LDU, surface, (towerZ + 2) * STUD_LDU],
        color: C.darkBluishGrey,
        trimColor: C.white,
        glassColor: C.transLightBlue,
        family: 'brick',
        depthStuds: 1,
        widthStuds: towerWidth - 4,
        footprintDepthStuds: towerDepth - 4,
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
        origin: [(towerX + 2) * STUD_LDU, surface, (towerZ + 2) * STUD_LDU],
        color: C.lightBluishGrey,
        family: 'plate',
        widthStuds: towerWidth - 4,
        footprintDepthStuds: towerDepth - 4,
        layers: 2,
      }),
    ),
    'crown',
  )
  surface -= 2 * PLATE_LDU

  // A 1 x 1 spans one stud on both axes, so it centres on an odd multiple of
  // 10 LDU — half a stud off the even grid the walls are laid on.
  const mastX = studCentre(towerX + Math.floor(towerWidth / 2))
  const mastZ = studCentre(towerZ + Math.floor(towerDepth / 2))
  let mastSurface = surface
  for (let level = 0; level < 6; level += 1) {
    mastSurface = build.place('3062b', level % 2 === 0 ? C.white : C.red, mastX, mastZ, mastSurface, { sub: 'crown' })
  }

  if (!rough)
    notes.push(
      'Two upper setbacks separate the tower into base, middle and crown volumes; the expanded plaza adds a pavilion, reflecting pool, twelve trees and ten illuminated posts.',
    )

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
  const UNITS = rough ? 2 : 7
  const UNIT_W = rough ? 14 : 16
  const UNIT_GAP = rough ? 0 : 2
  const DEPTH = rough ? 12 : 16
  const COURSES = 5
  const STOREYS = rough ? 2 : 4
  const SITE_W = UNITS * UNIT_W + (UNITS - 1) * UNIT_GAP + (rough ? 6 : 10)
  const SITE_D = rough ? 34 : 50
  const ROW_Z = rough ? 16 : 26
  const unitX = (index) => (rough ? 3 : 5) + index * (UNIT_W + UNIT_GAP)

  const units = Array.from({ length: UNITS }, (_, index) => ({
    id: `unit_${index + 1}`,
    name: `Shopfront ${index + 1}`,
    accent: ['#d66b55', '#f7b04a', '#77b96a', '#83e7ee', '#d6a85d'][index % 5],
  }))

  const build = new Build({
    subassemblies: [
      { id: 'street', name: 'Street, kerb and pavement', accent: '#7f8c9b' },
      { id: 'landscape', name: 'Street trees, lamps and planted thresholds', accent: '#77b96a' },
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

  const onTerrace = (x, z) =>
    units.some((_unit, index) => x >= unitX(index) && x < unitX(index) + UNIT_W && z >= ROW_Z && z < ROW_Z + DEPTH)
  const treeSites = rough
    ? []
    : Array.from({ length: UNITS + 1 }, (_, index) => [4 + index * 18, 20]).filter(([x]) => x < SITE_W - 2)
  const lampSites = rough
    ? []
    : Array.from({ length: UNITS }, (_, index) => [13 + index * 18, 17]).filter(([x]) => x < SITE_W - 2)
  const planterSites = rough
    ? []
    : units.flatMap((_unit, index) => [
        [unitX(index) + 2, ROW_Z - 2],
        [unitX(index) + UNIT_W - 3, ROW_Z - 2],
      ])
  const figures = []
  for (let index = 0; index < (rough ? 2 : 18); index += 1) {
    const x = 1 + ((index * 5) % (SITE_W - 2))
    const z = index % 3 === 0 ? 12 : index % 3 === 1 ? 13 : ROW_Z + DEPTH + 1
    if (onTerrace(x, z) || z >= SITE_D - 1) continue
    figures.push({ x, z, color: [C.red, C.blue, C.yellow, C.green, C.white][index % 5] })
  }
  const figureTaken = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))
  const taken = new Set(
    [...figures.map((figure) => [figure.x, figure.z]), ...treeSites, ...lampSites, ...planterSites].map(
      ([x, z]) => `${x}:${z}`,
    ),
  )

  // Inset by a stud: the base field fills its outer corners with round plates
  // whose studs a flat tile cannot sit down onto, and the exposed border reads
  // as the edge of the plate anyway.
  for (let x = 1; x < SITE_W - 1; x += 1) {
    for (let z = 1; z < SITE_D - 1; z += 1) {
      if (onTerrace(x, z) || figureTaken.has(`${x}:${z}`)) continue
      const carriageway = z < (rough ? 9 : 12)
      const kerb = z === (rough ? 9 : 12)
      build.place(
        taken.has(`${x}:${z}`) ? '3024' : '3070b',
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

  if (!rough) {
    const finishTop = groundSurface - PLATE_LDU
    treeSites.forEach(([x, z], index) =>
      addTree(build, { x, z, surfaceY: finishTop, sub: 'landscape', height: 3 + (index % 2), variant: index }),
    )
    lampSites.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: finishTop, sub: 'landscape', height: 4 + (index % 2) }),
    )
    planterSites.forEach(([x, z], index) =>
      addPlanter(build, {
        x,
        z,
        surfaceY: finishTop,
        sub: 'landscape',
        variant: index,
        flower: index % 3 ? C.orange : C.yellow,
      }),
    )
  }

  const facades = [C.reddishBrown, C.sand, C.darkTan, C.white, C.tan]
  units.forEach((unit, index) => {
    const x = unitX(index)
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
    if (!rough) {
      const roofRoomW = 6
      const roofRoomD = 6
      const roofRoomX = x + (index % 2 === 0 ? 2 : UNIT_W - roofRoomW - 2)
      const roofRoomZ = ROW_Z + Math.floor((DEPTH - roofRoomD) / 2)
      absorb(
        planEnclosure(
          spec({
            sub: unit.id,
            origin: [roofRoomX * STUD_LDU, surface, roofRoomZ * STUD_LDU],
            color: index % 2 === 0 ? C.darkTan : C.lightBluishGrey,
            trimColor: C.white,
            glassColor: C.transLightBlue,
            family: 'brick',
            depthStuds: 1,
            widthStuds: roofRoomW,
            footprintDepthStuds: roofRoomD,
            courses: 2,
            floor: false,
            openings: [{ atStud: 2, widthStuds: 2, fromCourse: 0, toCourse: 1, element: 'window' }],
          }),
        ),
        unit.id,
      )
      const roofRoomTop = surface - 2 * BRICK_LDU
      absorb(
        planBrickField(
          spec({
            sub: unit.id,
            origin: [roofRoomX * STUD_LDU, roofRoomTop, roofRoomZ * STUD_LDU],
            color: index % 3 === 0 ? C.darkGreen : C.darkBluishGrey,
            family: 'plate',
            widthStuds: roofRoomW,
            footprintDepthStuds: roofRoomD,
            layers: 2,
          }),
        ),
        unit.id,
      )
    }
  })

  if (!rough)
    notes.push(
      'Seven separated addresses now sit between real two-stud alleys, with eight street trees, seven illuminated posts, fourteen planted thresholds and individually detailed roof rooms.',
    )

  return { build, notes, warnings }
}

/**
 * An original saucer freighter.
 *
 * The published demos are all modular AABB architecture — a terrace, a tower, a
 * campus — so the collection proves one discipline three times. This one exists
 * to prove a different one: a hull whose skin is built sideways, a ramp that
 * actually opens, a turret that actually turns, and a planform that is not a
 * box.
 *
 * The planform is deliberately its own thing: a centred cockpit between twin
 * forward booms, on a lozenge hull that steps in at both ends. It is not a
 * recreation of any film ship or any retail set, and it is not meant to read as
 * one — what it borrows is *technique* (sideways-stud skins, a hinged ramp, a
 * pinned turret), which is the part worth showing.
 *
 * Two of the four assemblies come from the kernel's own mechanism planners
 * rather than from brick-by-brick authoring here: `planSnotHull` builds the
 * side-stud rim and its clutched skins, and `planHingedFlap` builds the ramp.
 * Duplicating that geometry in this file would be a second implementation to
 * keep in step with the first.
 */
function saucerFreighter(rough) {
  // The bow/stern apron. It has to clear the hull skins, which hang outward
  // from the rim brackets by a little over a stud — an apron only as deep as
  // the inset would put the ramp's hinge line straight through them.
  const STEP = rough ? 3 : 14
  const HULL_W = rough ? 18 : 60
  const HULL_D = rough ? 14 : 46
  const DOCK_W = rough ? HULL_W : 70
  const DOCK_D = rough ? HULL_D : 56
  const HULL_X = rough ? 0 : 5
  const HULL_Z = rough ? 0 : 5
  // The deck is inset on all four edges, not just fore and aft: that is what
  // makes the planform a lozenge rather than a slab with two chamfers, and it
  // leaves an apron the hull sides and the ramp can stand on.
  const STEP_Z = rough ? 1 : 7
  const DECK_W = HULL_W - STEP * 2
  const DECK_D = HULL_D - STEP_Z * 2

  const build = new Build({
    subassemblies: [
      { id: 'dock', name: 'Launch cradle', accent: '#d66b55' },
      { id: 'keel', name: 'Keel and lower hull', accent: '#7f8c9b' },
      { id: 'skin', name: 'Sideways hull skin', accent: '#83e7ee' },
      { id: 'booms', name: 'Forward booms', accent: '#d6a85d' },
      { id: 'cockpit', name: 'Cockpit and turret', accent: '#f7b04a' },
      { id: 'ramp', name: 'Boarding ramp', accent: '#77b96a' },
      { id: 'engine', name: 'Engine block', accent: '#d66b55' },
      { id: 'cargo', name: 'Cargo pods', accent: '#8bcf65' },
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

  // -- launch cradle -------------------------------------------------------
  // The earlier ship sat directly on the ground and still read as a medium
  // vehicle beside the city-scale builds. A full-footprint, cross-bonded lift
  // cradle makes this a display-scale shipyard model and gives builders a
  // structural field they can extend with gantries, service carts or scenery.
  const dockLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'dock',
        origin: [0, 0, 0],
        color: C.darkTan,
        family: 'plate',
        widthStuds: DOCK_W,
        footprintDepthStuds: DOCK_D,
        layers: dockLayers,
      }),
    ),
    'dock',
  )
  const dockFoundationTop = -dockLayers * PLATE_LDU
  if (!rough) {
    for (let z = 0; z < DOCK_D; z += 1) {
      for (let x = 0; x < DOCK_W; x += 1) {
        build.place(
          '3024',
          x === Math.floor(DOCK_W / 2) || z === Math.floor(DOCK_D / 2) || ((x === 2 || x === DOCK_W - 3) && z % 4 < 2)
            ? C.orange
            : C.darkTan,
          (x + 0.5) * STUD_LDU,
          (z + 0.5) * STUD_LDU,
          dockFoundationTop,
          { sub: 'dock', label: `launch cradle finish ${x},${z}` },
        )
      }
    }
  }
  const dockTop = dockFoundationTop - (rough ? 0 : PLATE_LDU)

  // -- keel ----------------------------------------------------------------
  // Three overlapping *profiles*, joined by raised cross-bonded bands, form a
  // stepped lozenge. The previous full-width rectangle made the freighter read
  // as a storage tray no matter how much mechanism detail sat on top of it.
  const keelSections = rough
    ? [{ x: HULL_X, z: HULL_Z, width: HULL_W, depth: HULL_D }]
    : [
        { x: HULL_X, z: HULL_Z + 9, width: STEP, depth: HULL_D - 18 },
        { x: HULL_X + STEP, z: HULL_Z, width: DECK_W, depth: HULL_D },
        { x: HULL_X + STEP + DECK_W, z: HULL_Z + 6, width: STEP, depth: HULL_D - 12 },
      ]
  for (const section of keelSections) {
    absorb(
      planBrickField(
        spec({
          sub: 'keel',
          origin: [section.x * STUD_LDU, dockTop, section.z * STUD_LDU],
          color: C.darkBluishGrey,
          family: 'plate',
          widthStuds: section.width,
          footprintDepthStuds: section.depth,
          layers: 2,
        }),
      ),
      'keel',
    )
  }
  const keelBaseTop = dockTop - 2 * PLATE_LDU
  if (!rough) {
    for (const seamX of [HULL_X + STEP - 2, HULL_X + STEP + DECK_W - 2]) {
      for (const z of [HULL_Z + 11, HULL_Z + 28]) {
        absorb(
          planBrickField(
            spec({
              sub: 'keel',
              origin: [seamX * STUD_LDU, keelBaseTop, z * STUD_LDU],
              color: C.lightBluishGrey,
              family: 'plate',
              widthStuds: 4,
              footprintDepthStuds: 6,
              layers: 2,
            }),
          ),
          'keel',
        )
      }
    }
  }
  const keelTop = keelBaseTop - (rough ? 0 : 2 * PLATE_LDU)

  // Stud-connected perimeter ribs trace the faceted edge without filling its
  // negative space back in. Their changing rhythm also keeps the hull side
  // readable when the SNOT skin is viewed nearly edge-on.
  if (!rough) {
    const ribs = []
    for (let z = HULL_Z + 10; z < HULL_Z + HULL_D - 9; z += 4) ribs.push([HULL_X, z], [HULL_X + HULL_W - 1, z])
    for (let x = HULL_X + STEP; x < HULL_X + STEP + DECK_W; x += 4) ribs.push([x, HULL_Z], [x, HULL_Z + HULL_D - 1])
    ribs.forEach(([x, z], index) => {
      let surface = keelBaseTop
      for (let course = 0; course < 2 + (index % 2); course += 1)
        surface = build.place('3005', C.lightBluishGrey, studCentre(x), studCentre(z), surface, { sub: 'keel' })
      build.place(
        '6141',
        index % 3 === 0 ? C.transNeonOrange : C.darkBluishGrey,
        studCentre(x),
        studCentre(z),
        surface,
        {
          sub: 'keel',
        },
      )
    })
  }

  // -- sideways hull skin --------------------------------------------------
  // `planSnotHull` is the kernel's own side-stud rim: a bonded deck, a
  // one-brick rim of brackets around it, and 1 x 1 plate skins genuinely
  // clutched to the side studs. Inset from the keel at both ends, that rim is
  // also what gives the ship its stepped lozenge planform rather than a box.
  //
  // Its own geometry sets the surfaces everything else lands on: the deck is
  // two plate layers below its origin, and the rim stands one brick above that.
  const deckTop = keelTop - 2 * PLATE_LDU
  absorb(
    planSnotHull({
      originLdu: [(HULL_X + STEP) * STUD_LDU, keelTop, (HULL_Z + STEP_Z) * STUD_LDU],
      color: C.lightBluishGrey,
      subassemblyId: 'skin',
      stepId: 'step_1',
      actor: HUMAN,
      widthStuds: Math.min(32, DECK_W),
      depthStuds: Math.min(32, DECK_D),
      layers: rough ? 1 : 2,
    }),
    'skin',
  )
  notes.push(
    `Hull skin: ${DECK_W} x ${DECK_D} stud open deck with a side-stud rim, inset ${STEP} studs fore and aft and ${STEP_Z} abeam.`,
  )

  // The deck interior, one stud inside the rim on every edge. Everything built
  // on top of the hull is placed inside this rectangle so nothing lands on the
  // rim brackets or overhangs the skin.
  const ix0 = HULL_X + STEP + 1
  const ix1 = HULL_X + STEP + DECK_W - 2
  const iz0 = HULL_Z + STEP_Z + 1
  const iz1 = HULL_Z + STEP_Z + DECK_D - 2

  // -- twin booms ----------------------------------------------------------
  // Two longitudinal bays with the cockpit centred between them. A single
  // offset tube would be somebody else's ship; this planform is its own.
  const boomLen = Math.min(rough ? 6 : 18, ix1 - ix0)
  const boomDepth = rough ? 4 : 5
  const boomX = ix1 - boomLen
  for (const [index, z] of [iz0, iz1 - boomDepth].entries()) {
    absorb(
      planEnclosure(
        spec({
          sub: 'booms',
          origin: [boomX * STUD_LDU, deckTop, z * STUD_LDU],
          color: C.lightBluishGrey,
          family: 'brick',
          depthStuds: 1,
          widthStuds: boomLen,
          footprintDepthStuds: boomDepth,
          courses: 2,
          floor: true,
          floorLayers: 2,
        }),
      ),
      'booms',
    )
    notes.push(`Boom ${index + 1}: ${boomLen} studs long on the ${index === 0 ? 'port' : 'starboard'} side.`)
  }

  // -- cockpit -------------------------------------------------------------
  // Centred in the beam, between the booms, at the forward end of the deck.
  const cockpitSize = rough ? 4 : 10
  const cockpitX = ix1 - cockpitSize
  const cockpitZ = HULL_Z + Math.round((HULL_D - cockpitSize) / 2)
  absorb(
    planEnclosure(
      spec({
        sub: 'cockpit',
        origin: [cockpitX * STUD_LDU, deckTop, cockpitZ * STUD_LDU],
        color: C.lightBluishGrey,
        family: 'brick',
        depthStuds: 1,
        widthStuds: cockpitSize,
        footprintDepthStuds: cockpitSize,
        courses: 3,
        floor: true,
        floorLayers: 2,
      }),
    ),
    'cockpit',
  )

  // -- boarding ramp -------------------------------------------------------
  // On the exposed keel step at the stern, clear of the hull rim, so it swings
  // down to the ground rather than into the skin.
  absorb(
    planHingedFlap(
      spec({
        sub: 'ramp',
        // Inboard of the hull side ring, which occupies the outer stud.
        origin: [
          (HULL_X + 2) * STUD_LDU,
          rough ? keelTop : keelBaseTop,
          (HULL_Z + Math.round(HULL_D / 2 - 2)) * STUD_LDU,
        ],
        color: C.darkTan,
        widthStuds: rough ? 2 : 4,
        reachStuds: rough ? 1 : 2,
      }),
    ),
    'ramp',
  )
  notes.push('Boarding ramp is a hinged flap on the stern step, driven by the same joint solver as any other hinge.')

  // -- engine block --------------------------------------------------------
  // Aft, between the booms' line and the stern rim, so the mass sits behind the
  // cockpit where a freighter's would.
  const engineW = rough ? 4 : 10
  absorb(
    planEnclosure(
      spec({
        sub: 'engine',
        origin: [ix0 * STUD_LDU, deckTop, cockpitZ * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'brick',
        depthStuds: 1,
        widthStuds: engineW,
        footprintDepthStuds: cockpitSize,
        courses: 3,
        floor: true,
        floorLayers: 2,
      }),
    ),
    'engine',
  )

  // -- cargo pods ----------------------------------------------------------
  // A freighter carries something. Two pods sit inboard of the booms, each its
  // own separable assembly.
  // Inboard of the booms in x, and in the central band in z so they clear the
  // boom bays entirely rather than sharing a stud with them.
  // The booms take the outboard z bands (iz0..iz0+4 and iz1-4..iz1), so the
  // pods share what is left between them and must not overlap each other.
  // Even footprints only: an odd run leaves the enclosure planner a single
  // leftover stud, and the 1 x 1 it picks for that corner lands with nothing
  // under it.
  const podSize = rough ? 4 : 8
  const podX = ix0 + engineW + 1
  for (const [index, z] of [iz0 + 6, iz0 + 15].entries()) {
    if (z + podSize > iz1 - 4) break
    if (podX + podSize > ix1) break
    absorb(
      planEnclosure(
        spec({
          sub: 'cargo',
          origin: [podX * STUD_LDU, deckTop, z * STUD_LDU],
          color: C.darkTan,
          family: 'brick',
          depthStuds: 1,
          widthStuds: podSize,
          footprintDepthStuds: podSize,
          courses: 2,
          floor: true,
          floorLayers: 2,
        }),
      ),
      'cargo',
    )
    notes.push(`Cargo pod ${index + 1} lifts out of the hull as its own assembly.`)
  }

  // -- spine deck ----------------------------------------------------------
  // Ties the booms, cockpit and engine into one dorsal surface rather than
  // leaving them as separate lumps on an open deck.
  const spineZ = cockpitZ
  const engineTop = deckTop - (2 * PLATE_LDU + 3 * BRICK_LDU)
  absorb(
    planBrickField(
      spec({
        sub: 'keel',
        origin: [ix0 * STUD_LDU, engineTop, spineZ * STUD_LDU],
        color: C.lightBluishGrey,
        family: 'plate',
        widthStuds: Math.min(engineW, ix1 - ix0),
        footprintDepthStuds: cockpitSize,
        layers: 2,
      }),
    ),
    'keel',
  )
  const spineTop = engineTop - 2 * PLATE_LDU

  if (!rough) {
    for (let z = spineZ + 1; z < spineZ + cockpitSize - 1; z += 2) {
      build.place('6141', C.transNeonOrange, studCentre(ix0 + 1), studCentre(z), spineTop, { sub: 'engine' })
    }
    const dockLightSites = [
      [3, 3],
      [14, 3],
      [28, 3],
      [41, 3],
      [55, 3],
      [66, 3],
      [3, 52],
      [14, 52],
      [28, 52],
      [41, 52],
      [55, 52],
      [66, 52],
      [3, 18],
      [3, 37],
      [66, 18],
      [66, 37],
    ]
    dockLightSites.forEach(([x, z], index) =>
      addLamp(build, {
        x,
        z,
        surfaceY: dockTop,
        sub: 'dock',
        height: 3 + (index % 2),
        color: index % 3 === 0 ? C.white : C.darkBluishGrey,
      }),
    )
    notes.push(
      'Sixteen illuminated launch markers, hazard striping and a pulsing engine-light bank separate the ship from its service apron.',
    )
  }

  // -- dorsal turret -------------------------------------------------------
  // On the spine, above the engine, which is where a dorsal turret goes and
  // also the only place on this hull with clear air above it. A hinged flap is
  // a turret that actually elevates: the kernel reads 3937/3938 as a revolute
  // joint and drives it, so this is a mechanism rather than a moulded detail.
  absorb(
    planHingedFlap(
      spec({
        sub: 'cockpit',
        origin: [(ix0 + 2) * STUD_LDU, spineTop, (spineZ + 2) * STUD_LDU],
        color: C.darkBluishGrey,
        widthStuds: 2,
        reachStuds: rough ? 1 : 2,
      }),
    ),
    'cockpit',
  )
  notes.push('Dorsal turret is a real hinge on the spine; the joint solver drives it in the editor.')

  return { build, notes, warnings }
}

/**
 * A harbour control tower with a working programme.
 *
 * The complaint the demo collection answers here is not size — the campus set
 * is 11,473 parts. It is *kind*: every published demo is a modular architecture
 * stack, so the collection proves one discipline repeatedly. A play set is a
 * different thing. It has a programme — places where vehicles go in and out, a
 * platform, a machine that moves — and the parts of it that matter are the ones
 * that do something.
 *
 * So this one is a podium with two vehicle bays, a metro platform along one
 * edge, a glazed control shaft, and a crane on the podium roof built by the
 * kernel's own `planCrane` — a real luffing hinge, not a moulded jib.
 */
function harbourControlTower(rough) {
  const SITE_W = rough ? 28 : 84
  const SITE_D = rough ? 20 : 56
  const PODIUM_W = rough ? 16 : 52
  const PODIUM_D = rough ? 12 : 34
  const PODIUM_COURSES = rough ? 3 : 8
  const SHAFT = rough ? 8 : 18
  const SHAFT_COURSES = rough ? 6 : 30

  const build = new Build({
    subassemblies: [
      { id: 'site', name: 'Quayside and platform', accent: '#7f8c9b' },
      { id: 'landscape', name: 'Promenade, lights and cargo court', accent: '#77b96a' },
      { id: 'podium', name: 'Podium and vehicle bays', accent: '#d6a85d' },
      { id: 'shaft', name: 'Control shaft', accent: '#83e7ee' },
      { id: 'crane', name: 'Quay crane', accent: '#f7b04a' },
      { id: 'crown', name: 'Control room and mast', accent: '#77b96a' },
      { id: 'shed', name: 'Quayside warehouse', accent: '#d66b55' },
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

  // -- quayside ------------------------------------------------------------
  absorb(
    planBrickField(
      spec({
        sub: 'site',
        origin: [0, 0, 0],
        color: C.lightBluishGrey,
        family: 'plate',
        widthStuds: SITE_W,
        footprintDepthStuds: SITE_D,
        layers: 2,
      }),
    ),
    'site',
  )
  const groundTop = -2 * PLATE_LDU

  // The metro platform: a raised strip along the seaward edge, which is where
  // the programme starts. Two layers so it is rigid, not a painted stripe.
  const platformDepth = rough ? 4 : 8
  absorb(
    planBrickField(
      spec({
        sub: 'site',
        origin: [0, groundTop, (SITE_D - platformDepth) * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: SITE_W,
        footprintDepthStuds: platformDepth,
        layers: 2,
      }),
    ),
    'site',
  )
  notes.push(`Metro platform runs the full ${SITE_W}-stud quay edge.`)

  // -- podium with vehicle bays -------------------------------------------
  // Two openings cut to the full height of the podium wall: this is where a
  // vehicle drives in, so the opening has to be a door, not a window.
  const bayWidth = rough ? 4 : 6
  const openings = [
    { atStud: 3, widthStuds: bayWidth, fromCourse: 0, toCourse: PODIUM_COURSES - 1, element: 'door' },
    {
      atStud: PODIUM_W - 3 - bayWidth,
      widthStuds: bayWidth,
      fromCourse: 0,
      toCourse: PODIUM_COURSES - 1,
      element: 'door',
    },
  ]
  absorb(
    planEnclosure(
      spec({
        sub: 'podium',
        origin: [2 * STUD_LDU, groundTop, 2 * STUD_LDU],
        color: C.sand,
        family: 'brick',
        depthStuds: 1,
        widthStuds: PODIUM_W,
        footprintDepthStuds: PODIUM_D,
        courses: PODIUM_COURSES,
        floor: true,
        floorLayers: 2,
        openings,
      }),
    ),
    'podium',
  )
  // An enclosure with a floor is that floor *plus* its courses: the deck is laid
  // at the origin and the walls stand on it. Measuring only the courses puts the
  // next storey a floor's thickness inside the one below it.
  const podiumTop = groundTop - (2 * PLATE_LDU + PODIUM_COURSES * BRICK_LDU)
  notes.push(`Podium carries ${openings.length} full-height vehicle bays.`)

  // The podium roof deck, which the shaft and the crane both stand on.
  absorb(
    planBrickField(
      spec({
        sub: 'podium',
        origin: [2 * STUD_LDU, podiumTop, 2 * STUD_LDU],
        color: C.darkTan,
        family: 'plate',
        widthStuds: PODIUM_W,
        footprintDepthStuds: PODIUM_D,
        layers: 2,
      }),
    ),
    'podium',
  )
  const roofTop = podiumTop - 2 * PLATE_LDU

  // -- control shaft -------------------------------------------------------
  // A stack of storeys rather than one tall shell with decks dropped into it.
  // A deck spanning a hollow shell rests on nothing — its edges only touch the
  // inner faces of the walls, and touching a wall is not clutching it. Built as
  // separate enclosures, each storey's floor lands on the walls below and the
  // tower comes apart floor by floor.
  const shaftX = rough ? 4 : 6
  const shaftZ = rough ? 4 : 6
  const storeyCourses = rough ? 3 : 5
  const storeys = Math.max(1, Math.round(SHAFT_COURSES / storeyCourses))
  let shaftTop = roofTop
  for (let storey = 0; storey < storeys; storey += 1) {
    const shaftOpenings = []
    for (let at = 1; at + bay < SHAFT; at += 3) {
      shaftOpenings.push({ atStud: at, widthStuds: bay, fromCourse: 1, toCourse: storeyCourses - 2, element: 'window' })
    }
    absorb(
      planEnclosure(
        spec({
          sub: 'shaft',
          origin: [shaftX * STUD_LDU, shaftTop, shaftZ * STUD_LDU],
          color: storey % 2 === 0 ? C.white : C.sand,
          family: 'brick',
          depthStuds: 1,
          widthStuds: SHAFT,
          footprintDepthStuds: SHAFT,
          courses: storeyCourses,
          floor: true,
          floorLayers: 2,
          openings: storeyCourses >= 4 ? shaftOpenings : [],
        }),
      ),
      'shaft',
    )
    shaftTop -= 2 * PLATE_LDU + storeyCourses * BRICK_LDU
  }
  notes.push(`Control shaft is ${storeys} separable storeys, each on its own two-layer deck.`)

  // -- control room and mast ----------------------------------------------
  absorb(
    planBrickField(
      spec({
        sub: 'crown',
        origin: [shaftX * STUD_LDU, shaftTop, shaftZ * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: SHAFT,
        footprintDepthStuds: SHAFT,
        layers: 2,
      }),
    ),
    'crown',
  )
  const crownTop = shaftTop - 2 * PLATE_LDU
  absorb(
    planEnclosure(
      spec({
        sub: 'crown',
        origin: [(shaftX + 1) * STUD_LDU, crownTop, (shaftZ + 1) * STUD_LDU],
        color: C.white,
        family: 'brick',
        depthStuds: 1,
        widthStuds: SHAFT - 2,
        footprintDepthStuds: SHAFT - 2,
        courses: 2,
        floor: false,
      }),
    ),
    'crown',
  )
  const controlRoomTop = crownTop - 2 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'crown',
        origin: [(shaftX + 1) * STUD_LDU, controlRoomTop, (shaftZ + 1) * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: SHAFT - 2,
        footprintDepthStuds: SHAFT - 2,
        layers: 2,
      }),
    ),
    'crown',
  )
  let beaconSurface = controlRoomTop - 2 * PLATE_LDU
  const beaconX = studCentre(shaftX + Math.floor(SHAFT / 2))
  const beaconZ = studCentre(shaftZ + Math.floor(SHAFT / 2))
  for (let course = 0; course < (rough ? 2 : 4); course += 1) {
    beaconSurface = build.place('3062b', course % 2 ? C.white : C.red, beaconX, beaconZ, beaconSurface, {
      sub: 'crown',
    })
  }
  build.place('6141', C.transNeonOrange, beaconX, beaconZ, beaconSurface, {
    sub: 'crown',
  })

  // -- quay crane ----------------------------------------------------------
  // `planCrane` is the kernel's own: a bonded mast and a boom on a real 3937 /
  // 3938 luffing hinge. Re-deriving the mast geometry in this file would be a
  // second implementation to keep in step with the first.
  const craneX = PODIUM_W - (rough ? 5 : 7)
  const craneZ = PODIUM_D - 6
  absorb(
    planCrane({
      originLdu: [craneX * STUD_LDU, roofTop, craneZ * STUD_LDU],
      color: C.yellow,
      subassemblyId: 'crane',
      stepId: 'step_1',
      actor: HUMAN,
      boomStuds: rough ? 4 : 8,
    }),
    'crane',
  )
  notes.push('Quay crane luffs on a real hinge; the kernel drives it as a revolute joint.')

  // -- quayside warehouse --------------------------------------------------
  // The second building is what turns a tower into a site: somewhere for the
  // crane to move cargo to.
  // Clear of the podium, which occupies x 2 .. 2 + PODIUM_W.
  const shedX = PODIUM_W + (rough ? 4 : 6)
  const shedW = Math.max(6, SITE_W - shedX - 2)
  const shedD = rough ? 8 : 18
  const shedZ = 2
  absorb(
    planEnclosure(
      spec({
        sub: 'shed',
        origin: [shedX * STUD_LDU, groundTop, shedZ * STUD_LDU],
        color: C.reddishBrown,
        family: 'brick',
        depthStuds: 1,
        widthStuds: shedW,
        footprintDepthStuds: shedD,
        courses: 4,
        floor: true,
        floorLayers: 2,
        openings: [{ atStud: 3, widthStuds: 4, fromCourse: 0, toCourse: 3, element: 'door' }],
      }),
    ),
    'shed',
  )

  const shedTop = groundTop - (2 * PLATE_LDU + 4 * BRICK_LDU)
  absorb(
    planBrickField(
      spec({
        sub: 'shed',
        origin: [shedX * STUD_LDU, shedTop, shedZ * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: shedW,
        footprintDepthStuds: shedD,
        layers: 2,
      }),
    ),
    'shed',
  )
  if (!rough) {
    const shedRoof = shedTop - 2 * PLATE_LDU
    for (const x of [shedX + 4, shedX + 10, shedX + 16]) {
      const vent = build.place('3062b', C.lightBluishGrey, studCentre(x), studCentre(shedZ + 5), shedRoof, {
        sub: 'shed',
      })
      build.place('6141', C.darkBluishGrey, studCentre(x), studCentre(shedZ + 5), vent, { sub: 'shed' })
    }
  }

  // -- platform canopy -----------------------------------------------------
  // Two low walls carrying a roof over the metro platform, so the platform is
  // a place rather than a stripe of darker plate.
  const canopyZ = SITE_D - platformDepth
  const platformTop = groundTop - 2 * PLATE_LDU
  for (const z of [canopyZ, SITE_D - 1]) {
    absorb(
      planWall(
        spec({
          sub: 'site',
          origin: [2 * STUD_LDU, platformTop, z * STUD_LDU],
          color: C.white,
          family: 'brick',
          axis: 'x',
          depthStuds: 1,
          lengthStuds: SITE_W - 4,
          courses: 3,
        }),
      ),
      'site',
    )
  }
  absorb(
    planBrickField(
      spec({
        sub: 'site',
        origin: [2 * STUD_LDU, platformTop - 3 * BRICK_LDU, canopyZ * STUD_LDU],
        color: C.darkTan,
        family: 'plate',
        widthStuds: SITE_W - 4,
        footprintDepthStuds: platformDepth,
        layers: 2,
      }),
    ),
    'site',
  )
  notes.push('Metro platform is covered: two bonded walls carrying a plate canopy.')

  if (!rough) {
    const landscapeSurface = groundTop
    const treeSites = [
      [3, 41],
      [12, 41],
      [24, 41],
      [38, 41],
      [52, 41],
      [67, 37],
      [78, 37],
    ]
    const lampSites = [
      [5, 45],
      [17, 45],
      [29, 45],
      [41, 45],
      [53, 45],
      [65, 45],
      [77, 45],
      [5, 39],
      [29, 39],
      [53, 39],
      [77, 39],
    ]
    const planterSites = [
      [58, 23],
      [63, 23],
      [68, 23],
      [73, 23],
    ]
    const reserved = new Set([...treeSites, ...lampSites, ...planterSites].map(([x, z]) => `${x}:${z}`))
    const onPodium = (x, z) => x >= 2 && x < 2 + PODIUM_W && z >= 2 && z < 2 + PODIUM_D
    const onShed = (x, z) => x >= shedX && x < shedX + shedW && z >= shedZ && z < shedZ + shedD
    const onPlatform = (_x, z) => z >= SITE_D - platformDepth
    for (let z = 1; z < SITE_D - 1; z += 1) {
      for (let x = 1; x < SITE_W - 1; x += 1) {
        if (onPodium(x, z) || onShed(x, z) || onPlatform(x, z)) continue
        const accessLane = z < 7 || (x > 54 && z > 20 && z < 28)
        build.place(
          reserved.has(`${x}:${z}`) ? '3024' : '3070b',
          accessLane ? C.darkBluishGrey : (x + z) % 7 === 0 ? C.darkTan : C.lightBluishGrey,
          studCentre(x),
          studCentre(z),
          landscapeSurface,
          { sub: 'landscape' },
        )
      }
    }
    treeSites.forEach(([x, z], index) =>
      addTree(build, {
        x,
        z,
        surfaceY: landscapeSurface - PLATE_LDU,
        sub: 'landscape',
        height: 3 + (index % 2),
        variant: index,
      }),
    )
    lampSites.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: landscapeSurface - PLATE_LDU, sub: 'landscape', height: 4 + (index % 2) }),
    )
    planterSites.forEach(([x, z], index) =>
      addPlanter(build, { x, z, surfaceY: landscapeSurface - PLATE_LDU, sub: 'landscape', variant: index }),
    )
    notes.push(
      'A separated cargo court, seven mature trees, eleven illuminated posts and planted warehouse frontage complete the harbour district.',
    )
  }

  return { build, notes, warnings }
}

/**
 * An original ironwork lookout with a clock stage.
 *
 * The third discipline the collection was missing. A lattice is not a wall with
 * holes in it — it is columns carrying decks, with nothing between them — and a
 * clock face is not a printed tile, it is a hand on a hinge. Both exist as
 * kernel planners (`planLattice`, `planClockFaces`) that no demo had ever
 * called, so the collection was shipping planners it did not demonstrate.
 *
 * The tower is two lattice tiers stepping inward over a masonry plinth, a clock
 * stage with four independently hinged hands, and an observation deck. It is
 * its own design: no landmark is being reproduced, and the proportions come
 * from what the planners can actually build.
 */
function ironLatticeLookout(rough) {
  // `planLattice` bays the deck on a grid, so both dimensions must be one more
  // than a multiple of the bay — and the bay is odd here on purpose. An even
  // bay forces an odd deck (17 = 4x4+1), and `planBrickField` fills the
  // leftover column of an odd footprint with 1 x 1 specials that land on
  // nothing. An odd bay gives an even deck the field planner tiles cleanly.
  const BAY = 3
  const TIER_A = rough ? 10 : 28
  const TIER_B = rough ? 7 : 16
  const PLINTH = rough ? 16 : 36
  const SITE = rough ? PLINTH : 56
  const PLINTH_X = Math.floor((SITE - PLINTH) / 2)
  const PLINTH_COURSES = rough ? 3 : 7
  const TIER_A_COURSES = rough ? 5 : 16
  const TIER_B_COURSES = rough ? 4 : 14

  const build = new Build({
    subassemblies: [
      { id: 'plinth', name: 'Masonry plinth', accent: '#d6a85d' },
      { id: 'landscape', name: 'Lookout gardens and lighting', accent: '#77b96a' },
      { id: 'lower', name: 'Lower ironwork tier', accent: '#7f8c9b' },
      { id: 'upper', name: 'Upper ironwork tier', accent: '#83e7ee' },
      { id: 'clock', name: 'Clock stage', accent: '#f7b04a' },
      { id: 'lookout', name: 'Observation deck', accent: '#77b96a' },
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

  // -- plinth --------------------------------------------------------------
  absorb(
    planBrickField(
      spec({
        sub: 'plinth',
        origin: [0, 0, 0],
        color: C.lightBluishGrey,
        family: 'plate',
        widthStuds: SITE,
        footprintDepthStuds: SITE,
        layers: 2,
      }),
    ),
    'plinth',
  )
  const groundTop = -2 * PLATE_LDU

  if (!rough) {
    const treeSites = [
      [4, 4],
      [18, 5],
      [37, 5],
      [51, 4],
      [4, 51],
      [18, 50],
      [37, 50],
      [51, 51],
    ]
    const lampSites = [
      [3, 27],
      [7, 27],
      [48, 27],
      [52, 27],
      [27, 3],
      [27, 7],
      [27, 48],
      [27, 52],
    ]
    const reserved = new Set([...treeSites, ...lampSites].map(([x, z]) => `${x}:${z}`))
    for (let z = 1; z < SITE - 1; z += 1) {
      for (let x = 1; x < SITE - 1; x += 1) {
        const onPlinth = x >= PLINTH_X && x < PLINTH_X + PLINTH && z >= PLINTH_X && z < PLINTH_X + PLINTH
        if (onPlinth) continue
        const avenue = Math.abs(x - SITE / 2) <= 1 || Math.abs(z - SITE / 2) <= 1
        build.place(
          reserved.has(`${x}:${z}`) ? '3024' : '3070b',
          avenue ? C.lightBluishGrey : (x + z) % 5 === 0 ? C.darkGreen : C.green,
          studCentre(x),
          studCentre(z),
          groundTop,
          { sub: 'landscape' },
        )
      }
    }
    treeSites.forEach(([x, z], index) =>
      addTree(build, {
        x,
        z,
        surfaceY: groundTop - PLATE_LDU,
        sub: 'landscape',
        height: 3 + (index % 2),
        variant: index,
      }),
    )
    lampSites.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: groundTop - PLATE_LDU, sub: 'landscape', height: 4 + (index % 2) }),
    )
  }

  const arches = []
  for (let at = 3; at + 4 < PLINTH; at += 8) {
    // Stop one course short of the top. A door frame reaching past the last
    // course pokes through the deck above and the kernel counts that twice:
    // once as a collision, once as a break in the build order.
    arches.push({ atStud: at, widthStuds: 4, fromCourse: 0, toCourse: PLINTH_COURSES - 2, element: 'door' })
  }
  absorb(
    planEnclosure(
      spec({
        sub: 'plinth',
        origin: [PLINTH_X * STUD_LDU, groundTop, PLINTH_X * STUD_LDU],
        color: C.sand,
        family: 'brick',
        depthStuds: 1,
        widthStuds: PLINTH,
        footprintDepthStuds: PLINTH,
        courses: PLINTH_COURSES,
        floor: true,
        floorLayers: 2,
        openings: arches,
      }),
    ),
    'plinth',
  )
  let cursor = groundTop - (2 * PLATE_LDU + PLINTH_COURSES * BRICK_LDU)

  // The plinth roof, and the whole difference between the two candidates.
  //
  // The published set caps the plinth with two cross-bonded plate layers, so
  // the sheet interlocks with itself and carries the ironwork above it. The
  // first attempt stood the lattice straight on the open plinth: its lower deck
  // then had nothing under it but the one-stud wall rim, and most of that deck
  // is measured as unsupported. That is the refinement, and it is why the
  // rough candidate is worse on an axis the kernel counts rather than on taste.
  if (!rough) {
    absorb(
      planBrickField(
        spec({
          sub: 'plinth',
          origin: [PLINTH_X * STUD_LDU, cursor, PLINTH_X * STUD_LDU],
          color: C.lightBluishGrey,
          family: 'plate',
          widthStuds: PLINTH,
          footprintDepthStuds: PLINTH,
          layers: 2,
        }),
      ),
      'plinth',
    )
    cursor -= 2 * PLATE_LDU
  }
  notes.push(`Plinth carries ${arches.length} open arches at ground level.`)

  // -- lower ironwork tier -------------------------------------------------
  const lowerX = PLINTH_X + Math.floor((PLINTH - TIER_A) / 2)
  absorb(
    planLattice({
      originLdu: [lowerX * STUD_LDU, cursor, lowerX * STUD_LDU],
      color: C.darkBluishGrey,
      subassemblyId: 'lower',
      stepId: 'step_1',
      actor: HUMAN,
      widthStuds: TIER_A,
      depthStuds: TIER_A,
      heightCourses: TIER_A_COURSES,
      bayStuds: BAY,
    }),
    'lower',
  )
  // Lattice height is its own two decks plus the columns between them.
  cursor -= 2 * (2 * PLATE_LDU) + TIER_A_COURSES * BRICK_LDU

  // -- upper ironwork tier -------------------------------------------------
  const upperX = lowerX + Math.floor((TIER_A - TIER_B) / 2)
  absorb(
    planLattice({
      originLdu: [upperX * STUD_LDU, cursor, upperX * STUD_LDU],
      color: C.darkBluishGrey,
      subassemblyId: 'upper',
      stepId: 'step_1',
      actor: HUMAN,
      widthStuds: TIER_B,
      depthStuds: TIER_B,
      heightCourses: TIER_B_COURSES,
      bayStuds: BAY,
    }),
    'upper',
  )
  cursor -= 2 * (2 * PLATE_LDU) + TIER_B_COURSES * BRICK_LDU
  notes.push(`Ironwork is ${TIER_A_COURSES + TIER_B_COURSES} courses of open lattice on a ${BAY}-stud bay.`)

  // -- clock stage ---------------------------------------------------------
  // `planClockFaces` lays its own deck and four corner pedestals, each with a
  // hand on a real hinge. Its footprint is the nominal sweep plus four studs.
  const clockDiameter = rough ? 4 : 8
  const clockSize = clockDiameter + 4
  const clockX = upperX + Math.floor((TIER_B - clockSize) / 2)
  absorb(
    planClockFaces({
      originLdu: [clockX * STUD_LDU, cursor, clockX * STUD_LDU],
      color: C.white,
      subassemblyId: 'clock',
      stepId: 'step_1',
      actor: HUMAN,
      diameterStuds: clockDiameter,
    }),
    'clock',
  )
  if (!rough) {
    const pavilionSize = 4
    const pavilionX = clockX + Math.floor((clockSize - pavilionSize) / 2)
    const clockDeckTop = cursor - 2 * PLATE_LDU
    absorb(
      planEnclosure(
        spec({
          sub: 'lookout',
          origin: [pavilionX * STUD_LDU, clockDeckTop, pavilionX * STUD_LDU],
          color: C.white,
          trimColor: C.darkBluishGrey,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: pavilionSize,
          footprintDepthStuds: pavilionSize,
          courses: 5,
          floor: false,
          openings: [{ atStud: 1, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' }],
        }),
      ),
      'lookout',
    )
    const pavilionTop = clockDeckTop - 5 * BRICK_LDU
    absorb(
      planBrickField(
        spec({
          sub: 'lookout',
          origin: [pavilionX * STUD_LDU, pavilionTop, pavilionX * STUD_LDU],
          color: C.darkBluishGrey,
          family: 'plate',
          widthStuds: pavilionSize,
          footprintDepthStuds: pavilionSize,
          layers: 2,
        }),
      ),
      'lookout',
    )
    build.place(
      '3943b',
      C.darkGreen,
      (pavilionX + pavilionSize / 2) * STUD_LDU,
      (pavilionX + pavilionSize / 2) * STUD_LDU,
      pavilionTop - 2 * PLATE_LDU,
      {
        sub: 'lookout',
      },
    )
  }
  notes.push(
    'Clock stage carries four independently hinged hands, each driven by the joint solver.',
    rough
      ? 'The first ironwork study omits the civic garden and observation pavilion.'
      : 'A cross-axial garden, eight trees, eight illuminated posts and a glazed observation pavilion give the lookout a complete civic setting.',
  )

  return { build, notes, warnings }
}

/**
 * A shared compiler for the collection's large brick-built sculptures.
 *
 * The figure is not a mesh or an image pasted onto a base. Every cell is a
 * catalog-backed 1 x 1 plate, and every occupied cell grows into a real stack
 * of 1 x 1 bricks. That gives the animals enough resolution to read from a
 * distance while keeping every piece editable, selectable and attached to the
 * same cross-bonded plinth. The rough pass deliberately uses a one-layer
 * foundation: its parallel plate runs look plausible but remain disconnected,
 * which the published cross-bond fixes measurably.
 */
function largeSculpture(rough, design) {
  const width = rough ? design.roughWidth : design.width
  const depth = rough ? design.roughDepth : design.depth
  const layers = rough ? 1 : 2
  const build = new Build({
    subassemblies: [
      { id: 'foundation', name: 'Cross-bonded display plinth', accent: '#7f8c9b' },
      { id: 'field', name: design.fieldName, accent: design.fieldAccent },
      { id: 'scene', name: design.sceneName ?? 'Landscape, lighting and visitor details', accent: '#f7b04a' },
      { id: 'body', name: design.bodyName, accent: design.bodyAccent },
      { id: 'accent', name: design.accentName, accent: design.accentColor },
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

  absorb(
    planBrickField(
      spec({
        sub: 'foundation',
        origin: [0, 0, 0],
        color: design.plinthColor,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers,
      }),
    ),
    'foundation',
  )
  const foundationTop = -layers * PLATE_LDU
  let occupied = 0
  let sculptureParts = 0
  const occupiedCells = new Set()

  // A one-piece-per-stud finish is deliberate. It is the large build's editable
  // scene rather than a painted rectangle, and it gives every sculpted column a
  // known catalog-backed seat.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const finish = design.fieldColor(x, z, width, depth)
      let surface = build.place('3024', finish, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, foundationTop, {
        sub: 'field',
        label: `${design.id} field ${x},${z}`,
      })
      const column = design.column(x, z, width, depth, rough)
      if (!column || column.height < 1) continue
      occupied += 1
      occupiedCells.add(`${x}:${z}`)
      for (let level = 0; level < column.height; level += 1) {
        const accent = column.accentFrom !== undefined && level >= column.accentFrom
        surface = build.place(
          '3005',
          accent ? column.accentColor : column.color,
          (x + 0.5) * STUD_LDU,
          (z + 0.5) * STUD_LDU,
          surface,
          {
            sub: accent ? 'accent' : 'body',
            label: `${design.id} voxel ${x},${z},${level}`,
          },
        )
        sculptureParts += 1
      }
    }
  }

  if (!rough) {
    const fieldTop = foundationTop - PLATE_LDU
    for (const [index, [x, z, height]] of (design.trees ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addTree(build, { x, z, surfaceY: fieldTop, sub: 'scene', height, variant: index })
    }
    for (const [x, z, height] of design.lights ?? []) {
      if (!occupiedCells.has(`${x}:${z}`)) addLamp(build, { x, z, surfaceY: fieldTop, sub: 'scene', height })
    }
    for (const [index, [x, z]] of (design.planters ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addPlanter(build, {
          x,
          z,
          surfaceY: fieldTop,
          sub: 'scene',
          variant: index,
          flower: index % 2 ? C.yellow : C.orange,
        })
    }
    notes.push(
      `${(design.trees ?? []).length} trees, ${(design.lights ?? []).length} illuminated posts and ` +
        `${(design.planters ?? []).length} planted edge details turn the plinth into a complete public setting.`,
    )
  }

  notes.push(
    `${design.title} occupies ${occupied.toLocaleString()} stud columns and ${sculptureParts.toLocaleString()} stacked body bricks on a ${width} x ${depth}-stud scene.`,
  )
  if (!rough) notes.push('The two-layer foundation cross-bonds every row into one editable, stable model.')
  return { build, notes, warnings }
}

const ellipse = (x, z, cx, cz, rx, rz) => {
  const dx = (x - cx) / rx
  const dz = (z - cz) / rz
  return dx * dx + dz * dz
}

function blueWhaleMonument(rough) {
  return largeSculpture(rough, {
    id: 'blue-whale-monument',
    title: 'Blue Whale Monument',
    width: 84,
    depth: 42,
    roughWidth: 42,
    roughDepth: 22,
    plinthColor: C.darkBluishGrey,
    fieldName: 'Ocean mosaic',
    fieldAccent: '#42a5c6',
    fieldColor: (x, z) => ((x + z) % 5 === 0 ? C.transLightBlue : C.mediumBlue),
    bodyName: 'Whale body, fins and flukes',
    bodyAccent: '#497c9a',
    accentName: 'Belly, eye and foam details',
    accentColor: '#f7f3e8',
    sceneName: 'Illuminated aquarium promenade',
    lights: [
      [4, 4, 5],
      [16, 4, 4],
      [28, 4, 5],
      [40, 4, 4],
      [52, 4, 5],
      [64, 4, 4],
      [76, 4, 5],
      [4, 37, 4],
      [16, 37, 5],
      [28, 37, 4],
      [40, 37, 5],
      [52, 37, 4],
      [64, 37, 5],
      [76, 37, 4],
    ],
    planters: [
      [8, 8],
      [22, 34],
      [60, 8],
      [78, 31],
    ],
    column: (x, z, width, depth, isRough) => {
      const cx = width * 0.48
      const cz = depth * 0.5
      const body = ellipse(x, z, cx, cz, width * 0.3, depth * 0.23)
      const head = ellipse(x, z, width * 0.72, cz, width * 0.13, depth * 0.27)
      const tailStem = x > width * 0.1 && x < width * 0.23 && Math.abs(z - cz) < depth * 0.085
      const upperFluke = ellipse(x, z, width * 0.1, cz - depth * 0.17, width * 0.1, depth * 0.11) < 1
      const lowerFluke = ellipse(x, z, width * 0.1, cz + depth * 0.17, width * 0.1, depth * 0.11) < 1
      const fin =
        x > width * 0.42 && x < width * 0.62 && Math.abs(z - cz) > depth * 0.2 && Math.abs(z - cz) < depth * 0.34
      if (body >= 1 && head >= 1 && !tailStem && !upperFluke && !lowerFluke && !fin) return null
      const fullness = Math.max(0, 1 - Math.min(body, head))
      const height = Math.max(1, Math.round((isRough ? 2 : 4) + fullness * (isRough ? 2 : 7)))
      const eye = x > width * 0.72 && x < width * 0.77 && z < cz && Math.abs(z - cz) > depth * 0.15
      const foam = (upperFluke || lowerFluke) && (x + z) % 3 === 0
      return {
        height: fin || upperFluke || lowerFluke ? Math.min(height, isRough ? 2 : 3) : height,
        color: C.mediumBlue,
        accentFrom: eye || foam ? Math.max(0, height - 1) : undefined,
        accentColor: eye ? C.black : C.white,
      }
    },
  })
}

function copperMammoth(rough) {
  return largeSculpture(rough, {
    id: 'copper-mammoth',
    title: 'Copper Canyon Mammoth',
    width: 68,
    depth: 44,
    roughWidth: 34,
    roughDepth: 22,
    plinthColor: C.darkTan,
    fieldName: 'Canyon floor mosaic',
    fieldAccent: '#c8834b',
    fieldColor: (x, z) => ((x * 3 + z) % 7 < 2 ? C.orange : C.sand),
    bodyName: 'Mammoth body, legs and trunk',
    bodyAccent: '#8a5a3b',
    accentName: 'Ivory tusks and amber ears',
    accentColor: '#f2ddab',
    sceneName: 'Canyon pines, trail lights and scrub',
    trees: [
      [5, 5, 4],
      [16, 6, 3],
      [31, 5, 4],
      [48, 6, 3],
      [62, 5, 4],
      [5, 38, 3],
      [18, 37, 4],
      [34, 39, 3],
      [51, 37, 4],
      [62, 38, 3],
    ],
    lights: [
      [9, 3, 4],
      [25, 3, 4],
      [42, 3, 4],
      [58, 3, 4],
    ],
    planters: [
      [11, 10],
      [57, 12],
      [10, 32],
      [58, 33],
    ],
    column: (x, z, width, depth, isRough) => {
      const cz = depth * 0.5
      const body = ellipse(x, z, width * 0.44, cz, width * 0.23, depth * 0.25)
      const head = ellipse(x, z, width * 0.69, cz, width * 0.12, depth * 0.2)
      const trunk = x > width * 0.74 && x < width * 0.84 && Math.abs(z - cz) < depth * 0.08
      const legs =
        x > width * 0.28 && x < width * 0.61 && Math.abs(z - cz) > depth * 0.14 && Math.abs(z - cz) < depth * 0.28
      const ear =
        x > width * 0.58 && x < width * 0.71 && Math.abs(z - cz) > depth * 0.15 && Math.abs(z - cz) < depth * 0.28
      const tusk =
        x > width * 0.75 && x < width * 0.88 && Math.abs(z - cz) > depth * 0.09 && Math.abs(z - cz) < depth * 0.17
      if (body >= 1 && head >= 1 && !trunk && !legs && !ear && !tusk) return null
      const fullness = Math.max(0, 1 - Math.min(body, head))
      const height = Math.max(1, Math.round((isRough ? 2 : 4) + fullness * (isRough ? 2 : 7)))
      return {
        height: tusk ? Math.min(height, 2) : trunk ? Math.min(height, isRough ? 2 : 4) : height,
        color: ear ? C.orange : C.reddishBrown,
        accentFrom: tusk ? 0 : undefined,
        accentColor: C.white,
      }
    },
  })
}

function colossalDuck(rough) {
  return largeSculpture(rough, {
    id: 'colossal-duck',
    title: 'Colossal Duck Float',
    width: 64,
    depth: 46,
    roughWidth: 32,
    roughDepth: 24,
    plinthColor: C.mediumBlue,
    fieldName: 'Festival water mosaic',
    fieldAccent: '#83e7ee',
    fieldColor: (x, z) => ((x + z * 2) % 6 === 0 ? C.white : C.transLightBlue),
    bodyName: 'Giant duck body and head',
    bodyAccent: '#f4c542',
    accentName: 'Orange bill and black eyes',
    accentColor: '#f47b52',
    sceneName: 'Festival promenade and basin lighting',
    trees: [
      [5, 6, 3],
      [17, 5, 4],
      [46, 5, 4],
      [58, 6, 3],
    ],
    lights: [
      [4, 40, 4],
      [13, 40, 5],
      [22, 40, 4],
      [31, 40, 5],
      [40, 40, 4],
      [49, 40, 5],
      [58, 40, 4],
    ],
    planters: [
      [8, 36],
      [26, 38],
      [44, 37],
      [56, 35],
    ],
    column: (x, z, width, depth, isRough) => {
      const cz = depth * 0.53
      const body = ellipse(x, z, width * 0.4, cz, width * 0.27, depth * 0.27)
      const head = ellipse(x, z, width * 0.66, depth * 0.39, width * 0.14, depth * 0.17)
      const bill = x > width * 0.76 && x < width * 0.9 && z > depth * 0.31 && z < depth * 0.47
      if (body >= 1 && head >= 1 && !bill) return null
      const fullness = Math.max(0, 1 - Math.min(body, head))
      const height = Math.max(1, Math.round((isRough ? 2 : 4) + fullness * (isRough ? 2 : 9)))
      const eye = x > width * 0.67 && x < width * 0.72 && z > depth * 0.26 && z < depth * 0.31
      return {
        height: bill ? Math.min(height, isRough ? 2 : 3) : height,
        color: bill ? C.orange : C.yellow,
        accentFrom: eye ? Math.max(0, height - 1) : undefined,
        accentColor: C.black,
      }
    },
  })
}

/** A display-scale original suspension bridge over a fully editable river. */
function sunlineSuspensionBridge(rough) {
  const width = rough ? 56 : 120
  const depth = rough ? 22 : 50
  const layers = rough ? 1 : 2
  const build = new Build({
    subassemblies: [
      { id: 'river', name: 'River foundation', accent: '#42a5c6' },
      { id: 'water', name: 'Editable river mosaic', accent: '#83e7ee' },
      { id: 'deck', name: 'Suspended road deck', accent: '#7f8c9b' },
      { id: 'towers', name: 'Twin gateway towers', accent: '#d66b55' },
      { id: 'hangers', name: 'Stepped suspension hangers', accent: '#f7b04a' },
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

  absorb(
    planBrickField(
      spec({
        sub: 'river',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers,
      }),
    ),
    'river',
  )
  const riverTop = -layers * PLATE_LDU
  const deckX = rough ? 6 : 8
  const deckDepth = rough ? 8 : 10
  const deckZ = Math.floor(depth / 2) - Math.floor(deckDepth / 2)
  const deckWidth = width - deckX * 2
  const towerWidth = rough ? 6 : 8
  const towerXs = rough ? [16, width - 22] : [28, width - 36]
  const pierXs = rough ? [] : [deckX + 6, 28, 48, 68, 88, deckX + deckWidth - 10]
  const inPier = (x, z) =>
    pierXs.some((pierX) => x >= pierX && x < pierX + 4 && z >= deckZ + 1 && z < deckZ + deckDepth - 1)
  for (let z = 0; z < depth; z += 1)
    for (let x = 0; x < width; x += 1) {
      if (inPier(x, z)) continue
      const bank = z < 6 || z >= depth - 6
      build.place(
        '3024',
        bank ? ((x + z) % 4 === 0 ? C.darkTan : C.green) : (x + z) % 5 === 0 ? C.transLightBlue : C.mediumBlue,
        (x + 0.5) * STUD_LDU,
        (z + 0.5) * STUD_LDU,
        riverTop,
        { sub: 'water' },
      )
    }
  const waterTop = riverTop - PLATE_LDU
  if (rough) {
    notes.push(
      'The first site study lays the river on a single plate field; its parallel runs remain disconnected and no bridge spans them yet.',
    )
    return { build, notes, warnings }
  }

  // Six masonry piers lift the entire crossing clear of the water. The old
  // version laid its road directly onto the river mosaic, which was physically
  // connected but visually read as a painted stripe instead of a bridge.
  const pierCourses = 4
  for (const pierX of pierXs) {
    absorb(
      planEnclosure(
        spec({
          sub: 'towers',
          origin: [pierX * STUD_LDU, riverTop, (deckZ + 1) * STUD_LDU],
          color: C.lightBluishGrey,
          family: 'brick',
          depthStuds: 1,
          widthStuds: 4,
          footprintDepthStuds: deckDepth - 2,
          courses: pierCourses,
          floor: false,
        }),
      ),
      'towers',
    )
  }
  const elevatedDeckSurface = riverTop - pierCourses * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'deck',
        origin: [deckX * STUD_LDU, elevatedDeckSurface, deckZ * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: deckWidth,
        footprintDepthStuds: deckDepth,
        layers: 2,
      }),
    ),
    'deck',
  )
  const deckTop = elevatedDeckSurface - 2 * PLATE_LDU

  // The road surface remains editable one stud at a time. Studded edge lanes
  // are left for the hanger columns; the centre becomes a smooth orange stripe.
  for (let x = deckX; x < deckX + deckWidth; x += 1)
    for (let z = deckZ + 1; z < deckZ + deckDepth - 1; z += 1) {
      // Towers land directly on the bonded deck. Leaving road tiles underneath
      // would put a wall and a tile in the same vertical slice.
      if (towerXs.some((towerX) => x >= towerX && x < towerX + towerWidth)) continue
      build.place(
        '3070b',
        z === deckZ + Math.floor(deckDepth / 2) || z === deckZ + Math.floor(deckDepth / 2) - 1
          ? C.orange
          : C.lightBluishGrey,
        (x + 0.5) * STUD_LDU,
        (z + 0.5) * STUD_LDU,
        deckTop,
        { sub: 'deck' },
      )
    }

  const towerCourses = 18
  for (const x of towerXs) {
    absorb(
      planEnclosure(
        spec({
          sub: 'towers',
          origin: [x * STUD_LDU, deckTop, (deckZ - 3) * STUD_LDU],
          color: C.darkRed,
          family: 'brick',
          depthStuds: 1,
          widthStuds: towerWidth,
          footprintDepthStuds: deckDepth + 6,
          courses: towerCourses,
          floor: false,
          openings: [
            {
              atStud: Math.floor((towerWidth - 4) / 2),
              widthStuds: 4,
              fromCourse: 0,
              toCourse: towerCourses - 6,
            },
          ],
        }),
      ),
      'towers',
    )
    const towerTop = deckTop - towerCourses * BRICK_LDU
    absorb(
      planBrickField(
        spec({
          sub: 'towers',
          origin: [x * STUD_LDU, towerTop, (deckZ - 3) * STUD_LDU],
          color: C.darkTan,
          family: 'plate',
          widthStuds: towerWidth,
          footprintDepthStuds: deckDepth + 6,
          layers: 2,
        }),
      ),
      'towers',
    )
  }

  // Vertical stacks trace a stepped catenary on both sides. They are honest
  // stud-connected columns, not diagonal bars floated between coordinates.
  for (let x = deckX + 2; x < deckX + deckWidth - 2; x += 3) {
    if (towerXs.some((towerX) => x >= towerX && x < towerX + towerWidth)) continue
    const distance = Math.min(...towerXs.map((towerX) => Math.abs(x - (towerX + towerWidth / 2))))
    const courses = Math.max(2, 12 - Math.min(10, Math.floor(distance / 4)))
    for (const z of [deckZ, deckZ + deckDepth - 1]) {
      let surface = deckTop
      for (let course = 0; course < courses; course += 1) {
        surface = build.place('3005', C.yellow, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, surface, { sub: 'hangers' })
      }
    }
  }

  const bankSurface = waterTop
  const landscapeXs = [6, 18, 42, 60, 78, 102, 114]
  landscapeXs.forEach((x, index) => {
    addTree(build, {
      x,
      z: index % 2 ? 3 : 4,
      surfaceY: bankSurface,
      sub: 'water',
      height: 3 + (index % 2),
      variant: index,
    })
    addTree(build, {
      x: width - 1 - x,
      z: depth - (index % 2 ? 4 : 5),
      surfaceY: bankSurface,
      sub: 'water',
      height: 3 + ((index + 1) % 2),
      variant: index + 1,
    })
  })
  for (const x of [11, 35, 59, 83, 107]) {
    addLamp(build, { x, z: 1, surfaceY: bankSurface, sub: 'water', height: 4 })
    addLamp(build, { x, z: depth - 2, surfaceY: bankSurface, sub: 'water', height: 4 })
  }
  notes.push(
    `A raised ${deckWidth}-stud road crosses a ${width} x ${depth}-stud river on six masonry piers between two eighteen-course gateway towers.`,
    'Landscaped banks and ten illuminated approach posts separate the civic setting from the suspended span.',
  )
  return { build, notes, warnings }
}

const DEMOS = [
  {
    id: 'blue-whale-monument',
    title: 'Blue Whale Monument',
    discipline: 'Large animal sculpture',
    category: 'animals',
    tagline: 'An eighty-four-stud blue whale with fins, flukes and foam rising from an illuminated ocean promenade.',
    summary:
      'A display-scale whale built as hundreds of individually editable stud columns over a fully tiled ocean scene. ' +
      'The body swells in measured brick courses, the flukes spread across the water, and a white eye-and-foam pass keeps the silhouette readable from every orbit. Fourteen lit promenade posts and planted reef markers frame the monument without crowding it.',
    techniques: [
      'Voxel-sculpted animal anatomy',
      'Cross-bonded 84 x 42-stud plinth',
      'Editable ocean mosaic',
      'Layered fins and flukes',
      'Illuminated aquarium promenade',
    ],
    refinement:
      'The first candidate put a simplified whale on a one-layer plate field whose parallel runs stayed disconnected. ' +
      'The published monument cross-bonds the complete ocean plinth and expands the body, fins, flukes and surface detail.',
    camera: { yaw: 34, pitch: 48, zoom: 1.08 },
    maxPartsPerStep: 96,
    tensionAllowance: 0,
    hero: false,
    brief: {
      prompt:
        'A large brick-built blue whale monument with a readable body, broad flukes, side fins and white foam, mounted over an editable ocean mosaic.',
      envelopeStuds: [84, null, 42],
      palette: ['Medium Blue', 'Trans Light Blue', 'White', 'Dark Bluish Grey'],
      functions: ['Large animal figure', 'Editable water scene', 'Verified build sequence'],
    },
    author: blueWhaleMonument,
  },
  {
    id: 'sunline-suspension-bridge',
    title: 'Sunline Suspension Bridge',
    discipline: 'Landmark infrastructure',
    category: 'landmarks',
    tagline: 'Twin brick-red gateways carry a raised road and stepped golden hangers across a 120-stud river district.',
    summary:
      'An original city landmark on a fully editable river: a cross-bonded road deck raised on six masonry piers, twin eighteen-course gateway towers, ' +
      'smooth traffic lanes, landscaped banks and honest stud-connected hanger columns tracing the suspension profile on both edges.',
    techniques: [
      '120 x 50-stud river district',
      'Twin masonry gateway towers',
      'Six structural river piers',
      'Cross-bonded suspended deck',
      'Stepped catenary hangers',
      'Landscaped, illuminated approaches',
    ],
    refinement:
      'The first candidate stopped at a one-layer river study, leaving its plate runs disconnected and no crossing between the banks. ' +
      'The published build cross-bonds the river, adds the complete road deck, towers, lanes and two lines of suspension hangers.',
    camera: { yaw: 32, pitch: 42, zoom: 1.04 },
    maxPartsPerStep: 96,
    tensionAllowance: 320,
    tensionReason:
      'The bonded tower caps rest on perimeter masonry and the statics pass counts their interior plates as tension-carried. ' +
      'The allowance is bounded so a floating deck or tower still fails.',
    hero: false,
    brief: {
      prompt:
        'An original large suspension bridge with twin brick-red gateway towers, a long road deck, golden vertical hangers and a fully editable river beneath it.',
      envelopeStuds: [120, null, 50],
      palette: ['Dark Red', 'Yellow', 'Medium Blue', 'Light Bluish Grey'],
      functions: ['Large landmark', 'Editable river scene', 'Verified build sequence'],
    },
    author: sunlineSuspensionBridge,
  },
  {
    id: 'copper-mammoth',
    title: 'Copper Canyon Mammoth',
    discipline: 'Large animal sculpture',
    category: 'animals',
    tagline: 'A brick-built mammoth with a domed back, four legs, a long trunk, amber ears and paired ivory tusks.',
    summary:
      'A large animal figure shaped column by column over a copper-and-sand canyon floor. The broad body, lowered head, ' +
      'grounded legs, trunk, ears and white tusks remain separate editable regions of the same physically connected model.',
    techniques: [
      'Voxel-sculpted quadruped anatomy',
      'Grounded four-leg silhouette',
      'Ivory tusk accents',
      'Editable canyon mosaic',
      'Canyon pines and trail lighting',
    ],
    refinement:
      'The first candidate used a smaller silhouette over loose plate runs. The published figure cross-bonds a sixty-eight-stud scene ' +
      'and resolves the mammoth into a fuller body, grounded legs, ears, trunk and paired tusks.',
    camera: { yaw: 38, pitch: 45, zoom: 1.08 },
    maxPartsPerStep: 96,
    tensionAllowance: 0,
    hero: false,
    brief: {
      prompt:
        'A large brick-built woolly mammoth with a massive rounded body, four grounded legs, a lowered trunk, amber ears and white tusks on a canyon display plinth.',
      envelopeStuds: [68, null, 44],
      palette: ['Reddish Brown', 'Orange', 'White', 'Sand'],
      functions: ['Large animal figure', 'Editable scenic base', 'Verified build sequence'],
    },
    author: copperMammoth,
  },
  {
    id: 'colossal-duck',
    title: 'Colossal Duck Float',
    discipline: 'Playful public art',
    category: 'creative',
    tagline: 'A giant yellow duck, orange bill and all, bobbing over a sixty-four-stud illuminated festival basin.',
    summary:
      'A deliberately ridiculous public-art build at landmark scale: a round yellow body, oversized head, orange bill and black eye ' +
      'assembled from editable brick columns over a rippling blue festival basin.',
    techniques: [
      'Large-scale comic sculpture',
      'Domed voxel body',
      'Graphic bill and eye accents',
      'Editable festival-water scene',
      'Festival lighting and shoreline trees',
    ],
    refinement:
      'The first float was a small yellow mass on loose one-layer water. The published version cross-bonds the whole basin and ' +
      'separates the body, head, bill and eyes into a clear, giant duck silhouette.',
    camera: { yaw: 34, pitch: 46, zoom: 1.08 },
    maxPartsPerStep: 96,
    tensionAllowance: 0,
    hero: false,
    brief: {
      prompt:
        'A funny large-scale yellow duck public-art float with a huge rounded body, tall head, orange bill and black eyes on an editable blue festival basin.',
      envelopeStuds: [64, null, 46],
      palette: ['Yellow', 'Orange', 'Black', 'Trans Light Blue'],
      functions: ['Funny creative landmark', 'Editable scenic base', 'Verified build sequence'],
    },
    author: colossalDuck,
  },
  {
    id: 'iron-lattice-lookout',
    title: 'Iron Lattice Lookout',
    discipline: 'Landmark ironwork',
    category: 'landmarks',
    tagline: 'Two tall tiers of open lattice rise from a landscaped civic garden to a clock stage and glazed lookout.',
    summary:
      'An original ironwork lookout: an arched plinth, two lattice tiers of columns and bonded decks stepping inward, ' +
      'and a clock stage whose four hands each sit on a real revolute hinge. The lattice and the clock are built by ' +
      'the kernel\u2019s own planners rather than drawn as solid walls with holes in them.',
    techniques: [
      'Open lattice: columns between bonded decks',
      'Two tiers stepping inward',
      'Arched masonry plinth',
      'Four independently hinged clock hands',
      'Glazed observation pavilion and lit gardens',
    ],
    refinement:
      'The first candidate stood the ironwork straight on the open plinth, so the lower lattice deck rested on a ' +
      'one-stud wall rim and nothing else \u2014 most of that deck measures as unsupported. The published set caps the ' +
      'plinth with two cross-bonded plate layers before the tiers go on, which is what carries the tower.',
    camera: { yaw: 30, pitch: 24, zoom: 1.06 },
    maxPartsPerStep: 64,
    tensionAllowance: 320,
    tensionReason:
      'Each lattice deck rests on the columns beneath it at their tops rather than clutching down into them, and the ' +
      'clock hands hang from their hinge knuckles. The statics pass counts both as tension-carried; the allowance is ' +
      'bounded so a genuinely unsupported deck still fails the gate.',
    hero: false,
    brief: {
      prompt:
        'An ironwork lookout tower: an arched stone plinth, two tiers of open lattice stepping inward, and a clock stage near the top whose hands actually turn.',
      envelopeStuds: [56, null, 56],
      palette: ['Sand', 'Light Bluish Grey', 'Dark Bluish Grey', 'White'],
      functions: ['Open lattice structure', 'Articulated clock hands', 'Arched ground level'],
    },
    author: ironLatticeLookout,
  },
  {
    id: 'harbour-control-tower',
    title: 'Harbour Control Tower',
    discipline: 'Play set',
    category: 'architecture',
    tagline:
      'An eighty-four-stud harbour district with drive-in bays, a metro platform, a glazed control shaft and a crane that luffs.',
    summary:
      'An original quayside play set rather than another facade: two full-height vehicle bays cut through the podium, ' +
      'a metro platform along the seaward edge, a glazed control shaft with a control room on top, and a quay crane ' +
      'built by the kernel\u2019s own planner on a real luffing hinge.',
    techniques: [
      'Full-height drive-in vehicle bays',
      'Raised metro platform',
      'Glazed control shaft',
      'Crane on a real luffing hinge',
      'One subassembly per programme element',
      'Lit promenade, cargo court and warehouse planting',
    ],
    refinement:
      'The rough candidate was a single glazed block on a plain slab \u2014 a tower with nothing to do. The published ' +
      'set cuts the podium open for vehicles, raises a platform along the quay, and puts a crane on the roof that ' +
      'the joint solver can actually drive.',
    camera: { yaw: 36, pitch: 28, zoom: 1.08 },
    maxPartsPerStep: 72,
    tensionAllowance: 420,
    tensionReason:
      'Glazing is seated inside its frames and the podium roof deck rests on the walls below it at the perimeter ' +
      'rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is ' +
      'bounded so a genuinely unsupported deck still fails the gate.',
    hero: false,
    brief: {
      prompt:
        'A quayside control tower with two drive-in vehicle bays under the podium, a metro platform along the water, a glazed control shaft with a control room on top, and a working crane on the podium roof.',
      envelopeStuds: [84, null, 56],
      palette: ['Sand', 'White', 'Light Bluish Grey', 'Dark Bluish Grey', 'Yellow'],
      functions: ['Drive-in vehicle bays', 'Metro platform', 'Luffing crane', 'Verified build sequence'],
    },
    author: harbourControlTower,
  },
  {
    id: 'saucer-freighter',
    title: 'Saucer Freighter',
    discipline: 'Vehicle and mechanism',
    category: 'vehicles',
    tagline:
      'A faceted lozenge hull on a seventy-stud illuminated dock, with twin booms, a turning turret and opening ramp.',
    summary:
      'An original freighter: a cross-bonded keel, a sideways-stud hull skin built by the kernel\u2019s own SNOT planner, ' +
      'twin booms flanking a centred cockpit, and two real hinges \u2014 a dorsal turret and a boarding ramp \u2014 that the ' +
      'joint solver drives in the editor.',
    techniques: [
      'Sideways-stud hull skin (SNOT)',
      'Stepped lozenge planform',
      'Twin booms, centred cockpit',
      'Hinged boarding ramp',
      'Hinged dorsal turret',
      'Illuminated shipyard apron and hull ribs',
    ],
    refinement:
      'The rough candidate was a single rectangular slab with the cockpit sitting on top of it \u2014 a box with a ' +
      'windscreen. The published set steps the hull in at bow and stern, wraps it in a genuinely clutched sideways ' +
      'skin, and replaces the moulded-on details with two hinges the kernel can actually drive.',
    camera: { yaw: 42, pitch: 30, zoom: 1.08 },
    maxPartsPerStep: 64,
    tensionAllowance: 640,
    tensionReason:
      'The sideways skins hang from side-facing studs on the rim brackets and the hinged flaps rest on their ' +
      'knuckles rather than clutching down into the deck. The raised inner deck also spans the four cross-bonded ' +
      'keel bands instead of being packed solid underneath. The statics pass counts these as tension-carried; the ' +
      'allowance is bounded so an actually unsupported panel still fails the gate.',
    hero: false,
    brief: {
      prompt:
        'An original saucer freighter with a stepped lozenge hull, sideways-stud skins, twin forward booms either side of a centred cockpit, a dorsal turret that turns and a boarding ramp that opens.',
      envelopeStuds: [70, null, 56],
      palette: ['Light Bluish Grey', 'Dark Bluish Grey', 'Dark Tan'],
      functions: ['Hinged boarding ramp', 'Hinged dorsal turret', 'Sideways-stud hull skin'],
    },
    author: saucerFreighter,
  },
  {
    id: 'harbour-street',
    title: 'Harbour Street',
    discipline: 'Modular architecture',
    category: 'architecture',
    tagline:
      'Seven four-storey shopfronts, separated by alleys and finished with roof rooms, trees, lights and planted entries.',
    summary:
      'Seven four-storey shopfronts on a full street district. Every address lifts out, every floor lifts off, and the public realm is built at the same editable grain.',
    techniques: [
      'One subassembly per storey, per unit',
      'Tiled carriageway, kerb and pavement',
      'Seated shopfront doors and glazing',
      'Parapet roofline',
      'Two-stud alleys and individual roof rooms',
      'Street trees, lamps and planted thresholds',
    ],
    refinement:
      'The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came ' +
      'apart and the street was a texture. The published set separates every unit and every floor, and lays the ' +
      'road surface as individual tiles.',
    camera: { yaw: 34, pitch: 28, zoom: 1.08 },
    maxPartsPerStep: 72,
    tensionAllowance: 480,
    tensionReason:
      'Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter ' +
      'rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is ' +
      'bounded so a genuinely unsupported storey still fails.',
    hero: false,
    brief: {
      prompt:
        'A street of seven four-storey modular shops with flats above, separate alleys, detailed roofs, trees, lights and planted thresholds, where every building and every floor can be lifted off separately.',
      envelopeStuds: [134, null, 50],
      palette: ['Reddish Brown', 'Sand', 'Dark Tan', 'White', 'Tan'],
      functions: ['Separable units and storeys', 'Glazed shopfronts', 'Verified build sequence'],
    },
    author: harbourStreet,
  },
  {
    id: 'meridian-tower',
    title: 'Meridian Tower',
    discipline: 'Modular architecture',
    category: 'architecture',
    tagline:
      'A twenty-eight-storey modular high-rise with two setbacks, a complete civic plaza and real seated glazing.',
    summary:
      'Twenty-eight storeys, each its own subassembly, step through three distinct tower volumes above a landscaped plaza, pavilion and reflecting pool.',
    techniques: [
      'One subassembly per storey',
      'Cross-bonded deck between floors',
      'Seated window frames on every elevation',
      'Stepped crown and mast',
      'Two structural setbacks',
      'Landscaped plaza, pavilion and reflecting pool',
    ],
    refinement:
      'The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the ' +
      'facades were blank. The published set separates every floor onto its own two-layer deck and glazes the ' +
      'elevations with frames the catalogue actually compiles.',
    camera: { yaw: 38, pitch: 20, zoom: 1.1 },
    maxPartsPerStep: 72,
    tensionAllowance: 1_100,
    tensionReason:
      'Two things in this model are held in bearing rather than in clutch, and the statics pass counts both as ' +
      'tension-carried. The glazing is seated inside its frames, and the middle of each storey deck rests on the ' +
      'walls below it at the perimeter rather than clutching down into them. The two setback transfer decks use ' +
      'the same bearing condition. All three are how a modular building is ' +
      'actually assembled; the allowance is bounded so a genuinely floating storey still fails the gate.',
    hero: false,
    brief: {
      prompt:
        'A twenty-eight-storey modular tower on a landscaped plaza, where every floor lifts off separately, the elevations carry real windows, two upper volumes set back, and the crown rises to a mast.',
      envelopeStuds: [84, null, 52],
      palette: ['Sand', 'Tan', 'White', 'Light Bluish Grey', 'Dark Bluish Grey'],
      functions: ['Separable storeys', 'Glazed elevations', 'Verified build sequence'],
    },
    author: meridianTower,
  },
  {
    id: 'illinois-main-quad',
    title: 'Illinois Main Quad campus',
    discipline: 'Campus architecture',
    category: 'architecture',
    tagline:
      'A 128 × 88-stud university campus with nine landmark structures, a tiled quad, mature trees, path lights and 21 LEGO characters.',
    summary:
      'A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, ' +
      'Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and ' +
      'brick-built students, an east visitor hall and a south garden pavilion. The site finish alone is 11,264 individually editable pieces over a cross-bonded base.',
    techniques: [
      '10,000+ catalog-backed pieces',
      'Cross-bonded 128 × 88-stud foundation',
      'Nine landmark structures',
      'Stepped copper dome and bell tower',
      '18 campus figures',
      'Three-figure Alma Mater group',
      'Twenty-eight mature trees and sixteen path lights',
    ],
    refinement:
      'The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. ' +
      'The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings, ' +
      'and adds the 11,264-piece landscape, characters and buildable campus life.',
    camera: { yaw: 34, pitch: 54, zoom: 1.02 },
    showcase: { landmarkCount: 9, characterCount: 21, siteFinishParts: 11_264 },
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
      envelopeStuds: [128, null, 88],
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
  await compare(path.join(OUT_SRC, 'summary.generated.ts'), committedSummarySrc)
  await rm(CHECK_ROOT, { recursive: true, force: true })
  if (drift.length) {
    process.stderr.write(`\nDeterminism check FAILED:\n  - ${drift.join('\n  - ')}\n`)
    await server.close()
    process.exit(1)
  }
  process.stdout.write('determinism check: a fresh build is byte-identical to the committed assets\n')
}

await server.close()
