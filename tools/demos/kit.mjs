/**
 * The demo authoring toolkit.
 *
 * One demo lives in one module beside this one and uses nothing but what is
 * exported here: a `Build` that refuses an off-grid placement, the connector
 * solver for parts that mate rather than rest, the parametric planners, and the
 * small scene elements every showcase shares. Anything a demo needs from the
 * kernel is re-exported at the bottom, so a demo module has exactly one import.
 */
import {
  AUTHORED_AT,
  QUARTER_TURN_BASES,
  STUD_LDU,
  basisFromEulerDegrees,
  bestSnapTransform,
  catalog,
  cleanBasis,
  originForSurface,
  surfaceAbove,
} from './kernel.mjs'

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/** LDraw colour codes used by the demos, named so the authoring reads. */
export const C = {
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

export class Build {
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

export const basisFor = (degrees) =>
  degrees % 90 === 0
    ? QUARTER_TURN_BASES[(((degrees / 90) % 4) + 4) % 4]
    : cleanBasis(basisFromEulerDegrees([0, degrees, 0]))

// ---------------------------------------------------------------------------
// The demos
// ---------------------------------------------------------------------------

export const HUMAN = 'human'

/** Shared spec fields every parametric plan needs. */
export const spec = (fields) => ({ actor: HUMAN, subassemblyId: fields.sub, stepId: 'step_1', ...fields })

export const studCentre = (stud) => (stud + 0.5) * STUD_LDU

/**
 * Small scene elements shared by the showcase builds.
 *
 * These are deliberately ordinary, connected catalogue parts rather than
 * decoration drawn by the preview renderer. A tree or light can therefore be
 * selected, moved, exploded and rebuilt like everything around it.
 */
export function addTree(build, { x, z, surfaceY, sub, height = 3, variant = 0 }) {
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

export function addLamp(build, { x, z, surfaceY, sub, height = 4, color = C.darkBluishGrey }) {
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

export function addPlanter(build, { x, z, surfaceY, sub, color = C.green, flower = C.orange, variant = 0 }) {
  const surface = build.place('3062b', color, studCentre(x), studCentre(z), surfaceY, { sub })
  build.place('32607', flower, studCentre(x), studCentre(z), surface, {
    sub,
    rotY: (variant % 4) * 90,
  })
}

export {
  BRICK_LDU,
  PLATE_LDU,
  STUD_LDU,
  catalog,
  elementLibrary,
  getColor,
  originForSurface,
  planBrickField,
  planClockFaces,
  planCrane,
  planEnclosure,
  planHingedFlap,
  planLattice,
  planSnotHull,
  planWall,
  surfaceAbove,
} from './kernel.mjs'
