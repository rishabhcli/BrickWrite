import { catalog, originForSurface } from '../../cad/catalog'
import type { ModelDocument } from '../../cad/types'
import type { ObjectiveId } from '../types'
import { FixtureBuilder, fixtureDocument } from './build'

/**
 * Eighteen models with something specific wrong with them.
 *
 * Each is small enough to reason about by hand and built from the real compiled
 * catalog, so an assertion about one is an assertion about LEGO rather than about
 * a convenient stub. Between them they cover every class the refinement engine
 * claims to handle: structural (weak joints, cantilevers, narrow towers),
 * aesthetic (stacked seams, stepped edges, runs of tiny parts), palette, element
 * rarity, silhouette-preserving surface work, live mechanisms that must survive
 * untouched, and a locked region that must be refused.
 *
 * `targetObjective` is the claim each fixture makes: this defect is measurable,
 * and the engine can measurably reduce it. The fixture test prints the before and
 * after numbers for every one of them, so the claim is checkable rather than
 * asserted.
 */

/** LDraw colours used throughout; all have observed appearances on these parts. */
const LIGHT_GREY = 71
const WHITE = 15
const BLACK = 0
const ORANGE = 25

export type FixtureClass =
  | 'structural'
  | 'aesthetic'
  | 'palette'
  | 'rarity'
  | 'silhouette'
  | 'mechanism'
  | 'protection'

export interface RefinementFixture {
  readonly id: string
  readonly title: string
  readonly klass: FixtureClass
  /** The request a person would type, verbatim. */
  readonly instruction: string
  readonly document: ModelDocument
  readonly scopePartIds: string[]
  readonly protectedPartIds: string[]
  readonly boundaryPartIds: string[]
  readonly symmetryExceptionPartIds: string[]
  /** The objective this fixture exists to prove can be improved. */
  readonly targetObjective: ObjectiveId
  readonly silhouetteToleranceFraction?: number
  /** What is deliberately wrong with it. */
  readonly defect: string
}

// ---------------------------------------------------------------------------
// Aesthetic / structural: bond
// ---------------------------------------------------------------------------

function seamWall(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  // Plate 1 × 8 foundation, then three courses of two 1 × 4 bricks meeting at
  // x = 0. Every joint lands on the joint below it: a column, not a wall.
  let surface = build.place('3460', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  for (let course = 0; course < 3; course += 1) {
    build.place('3010', WHITE, -40, 0, surface, { step: 'step_2' })
    surface = build.place('3010', WHITE, 40, 0, surface, { step: 'step_2' })
  }
  return {
    id: 'seam-wall',
    title: 'One-stud wall with every joint stacked',
    klass: 'aesthetic',
    instruction: 'remove stacked seams from this wall',
    document: fixtureDocument(build.parts, 'Seam wall'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'seamBonding',
    defect: 'Three courses of 4 + 4 studs, so the joint at x = 0 runs the full height of the wall.',
  }
}

function seamTower(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  let surface = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  for (let course = 0; course < 3; course += 1) {
    build.place('3001', WHITE, -40, 0, surface, { step: 'step_2' })
    surface = build.place('3001', WHITE, 40, 0, surface, { step: 'step_2' })
  }
  return {
    id: 'seam-tower',
    title: 'Two-stud wall with every joint stacked',
    klass: 'aesthetic',
    instruction: 'the courses are not bonded — stagger them',
    document: fixtureDocument(build.parts, 'Seam tower'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'seamBonding',
    defect: 'Three courses of 2 × 4 bricks meeting at x = 0 in every course.',
  }
}

function tippingMast(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  // A 2 × 2 footprint carrying a four-course mast built from pairs of 1 × 2
  // bricks laid the same way each course: narrow, top-heavy and unbonded.
  let surface = build.place('3022', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  for (let course = 0; course < 4; course += 1) {
    build.place('3004', WHITE, 0, -10, surface, { step: 'step_2' })
    surface = build.place('3004', WHITE, 0, 10, surface, { step: 'step_2' })
  }
  return {
    id: 'tipping-mast',
    title: 'Narrow mast, unbonded courses',
    klass: 'structural',
    instruction: 'this mast feels flimsy — bond the courses',
    document: fixtureDocument(build.parts, 'Tipping mast'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'seamBonding',
    defect: 'Every course is two 1 × 2 bricks meeting at z = 0, on a 2 × 2 footprint with little tipping margin.',
  }
}

// ---------------------------------------------------------------------------
// Aesthetic: runs of tiny parts
// ---------------------------------------------------------------------------

function microRunDeck(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const surface = build.place('3460', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  for (const x of [-70, -50, -30, -10, 10, 30, 50, 70]) {
    build.place('3005', WHITE, x, 0, surface, { step: 'step_2' })
  }
  return {
    id: 'micro-run-deck',
    title: 'Eight 1 × 1 bricks where one 1 × 8 belongs',
    klass: 'aesthetic',
    instruction: 'simplify this — fewer pieces',
    document: fixtureDocument(build.parts, 'Micro run deck'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'partCount',
    defect: 'A run of eight 1 × 1 bricks: eight parts, seven joints and no bond.',
  }
}

function microRunPlates(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'deck' })
  const surface = build.place('3460', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  for (const x of [-70, -50, -30, -10, 10, 30, 50, 70]) {
    build.place('3024', ORANGE, x, 0, surface, { step: 'step_2' })
  }
  return {
    id: 'micro-run-plates',
    title: 'Eight 1 × 1 plates in a row',
    klass: 'aesthetic',
    instruction: 'consolidate these plates into fewer elements',
    document: fixtureDocument(build.parts, 'Micro run plates'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'partCount',
    defect: 'Eight 1 × 1 plates, each held by a single stud, where one 1 × 8 plate would do.',
  }
}

// ---------------------------------------------------------------------------
// Silhouette: stepped edges
// ---------------------------------------------------------------------------

function steppedShelf(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const course = build.place('3001', WHITE, -40, 0, base, { step: 'step_2' })
  build.place('3001', WHITE, 40, 0, base, { step: 'step_2' })
  build.place('3003', WHITE, -20, 0, course, { step: 'step_3' })
  build.place('3003', WHITE, 20, 0, course, { step: 'step_3' })
  return {
    id: 'stepped-shelf',
    title: 'Two-stud steps on both outside faces',
    klass: 'silhouette',
    instruction: 'round these edges off — make it cleaner',
    document: fixtureDocument(build.parts, 'Stepped shelf'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'steppedEdges',
    silhouetteToleranceFraction: 0.25,
    defect: 'Each 2 × 4 brick is capped by a 2 × 2, leaving two studs of bare tread on an outside face.',
  }
}

function roofSteps(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3035', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  let surface = base
  for (const z of [-20, 20]) {
    build.place('3001', WHITE, -40, z, base, { step: 'step_2' })
    surface = build.place('3001', WHITE, 40, z, base, { step: 'step_2' })
  }
  let tier2 = surface
  for (const z of [-20, 20]) {
    build.place('3003', WHITE, -20, z, surface, { step: 'step_3' })
    tier2 = build.place('3003', WHITE, 20, z, surface, { step: 'step_3' })
  }
  for (const z of [-20, 20]) build.place('3003', ORANGE, 0, z, tier2, { step: 'step_4' })
  return {
    id: 'roof-steps',
    title: 'Three-tier stepped roof',
    klass: 'silhouette',
    instruction: 'make the roof lower and cleaner',
    document: fixtureDocument(build.parts, 'Roof steps'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'steppedEdges',
    // A request that says "lower" is asking for the outline to move, so the
    // tolerance is widened rather than the guard being skipped.
    silhouetteToleranceFraction: 0.4,
    defect: 'A stepped pyramid: every tier leaves bare tread on the tier below it.',
  }
}

function noseRound(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'chassis' })
  const base = build.place('3035', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const wheelbaseA = build.parts.length
  build.place('3020', LIGHT_GREY, -40, -20, base, { step: 'step_2' })
  build.place('3020', LIGHT_GREY, -40, 20, base, { step: 'step_2' })
  const wheelbase = build.parts.slice(wheelbaseA).map((part) => part.id)

  const bodyStart = build.parts.length
  let nose = base
  build.place('3001', ORANGE, 40, -20, base, { sub: 'hull', step: 'step_3' })
  nose = build.place('3001', ORANGE, 40, 20, base, { sub: 'hull', step: 'step_3' })
  build.place('3003', ORANGE, 20, -20, nose, { sub: 'hull', step: 'step_4' })
  build.place('3003', ORANGE, 20, 20, nose, { sub: 'hull', step: 'step_4' })
  const body = build.parts.slice(bodyStart).map((part) => part.id)

  return {
    id: 'nose-round',
    title: 'Blocky nose over a fixed wheelbase',
    klass: 'silhouette',
    instruction: 'round this nose without changing the wheelbase',
    document: fixtureDocument(build.parts, 'Nose round'),
    // The wheelbase is inside the selection and held: that is what "without
    // changing the wheelbase" means, and the refusal is part of the answer.
    scopePartIds: [...wheelbase, ...body],
    protectedPartIds: wheelbase,
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'steppedEdges',
    silhouetteToleranceFraction: 0.25,
    defect: 'The nose steps down in 2 × 2 blocks; the wheelbase plates must not move.',
  }
}

// ---------------------------------------------------------------------------
// Rarity and variety
// ---------------------------------------------------------------------------

function rareHull(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const start = build.parts.length
  build.place('3001', LIGHT_GREY, -40, 0, base, { step: 'step_2' })
  const deck = build.place('3001', LIGHT_GREY, 40, 0, base, { step: 'step_2' })
  // Grille tiles and headlight bricks: real elements, but each has a far more
  // common relative with the same live connectors.
  for (const x of [-60, -20, 20, 60]) build.place('2412b', BLACK, x, -10, deck, { step: 'step_5' })
  for (const x of [-70, 70]) build.place('4070', LIGHT_GREY, x, 10, deck, { step: 'step_5' })
  return {
    id: 'rare-hull',
    title: 'Hull finished in scarce elements',
    klass: 'rarity',
    instruction: 'reduce rare pieces — I want to be able to source this',
    document: fixtureDocument(build.parts, 'Rare hull'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'rarityScore',
    defect: 'Grille tiles and headlight bricks where a plain tile and a plain 1 × 1 connect identically.',
  }
}

function varietySprawl(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const start = build.parts.length
  build.place('3001', LIGHT_GREY, -40, 0, base, { step: 'step_2' })
  const deck = build.place('3001', LIGHT_GREY, 40, 0, base, { step: 'step_2' })
  for (const x of [-60, -20, 20, 60]) build.place('2412b', BLACK, x, -10, deck, { step: 'step_5' })
  for (const x of [-60, -20, 20, 60]) build.place('3069b', BLACK, x, 10, deck, { step: 'step_5' })
  return {
    id: 'variety-sprawl',
    title: 'Two element types doing one job',
    klass: 'rarity',
    instruction: 'use fewer different elements here',
    document: fixtureDocument(build.parts, 'Variety sprawl'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'distinctElements',
    defect: 'Half the deck is grille tile, half is plain tile, for no reason the model expresses.',
  }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function paletteNoise(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  build.place('3001', LIGHT_GREY, -40, 0, base, { step: 'step_2' })
  const deck = build.place('3001', LIGHT_GREY, 40, 0, base, { step: 'step_2' })
  const tiles: Array<[number, number]> = []
  for (const x of [-60, -20, 20, 60]) for (const z of [-10, 10]) tiles.push([x, z])
  tiles.forEach(([x, z], index) => {
    build.place('3069b', index === 3 ? ORANGE : LIGHT_GREY, x, z, deck, { step: 'step_6' })
  })
  return {
    id: 'palette-noise',
    title: 'One stray colour in a grey hull',
    klass: 'palette',
    instruction: 'fix the colour on this panel',
    document: fixtureDocument(build.parts, 'Palette noise'),
    scopePartIds: build.parts.map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'paletteConformance',
    defect: 'Ten of eleven parts are light bluish grey; one tile is orange.',
  }
}

// ---------------------------------------------------------------------------
// Symmetry
// ---------------------------------------------------------------------------

function symmetricAntenna(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3035', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  build.place('3004', WHITE, -60, -30, base, { step: 'step_2' })
  build.place('3004', WHITE, 60, -30, base, { step: 'step_2' })
  build.place('3004', WHITE, -20, 30, base, { step: 'step_2' })
  const antenna = build.place('3005', ORANGE, -70, 10, base, { step: 'step_6' })
  void antenna
  const antennaId = build.parts[build.parts.length - 1].id
  return {
    id: 'symmetric-antenna',
    title: 'Symmetric body, one stray block, one deliberate aerial',
    klass: 'structural',
    instruction: 'make this symmetric except for the antenna',
    document: fixtureDocument(build.parts, 'Symmetric antenna'),
    scopePartIds: build.parts.map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [antennaId],
    targetObjective: 'symmetryError',
    defect: 'One 1 × 2 brick at x = −20 has no counterpart; the 1 × 1 aerial is meant to be one-sided.',
  }
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

function weakAntenna(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3460', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const start = build.parts.length
  for (const x of [-30, -10, 10, 30]) build.place('3005', WHITE, x, 0, base, { step: 'step_2' })
  return {
    id: 'weak-antenna',
    title: 'Four 1 × 1 bricks each on a single stud',
    klass: 'structural',
    instruction: 'these will fall off — tie them in',
    document: fixtureDocument(build.parts, 'Weak antenna'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'weakConnections',
    // "Tie them in" accepts a visible plate; a tight outline tolerance here
    // would refuse every repair the request actually asked for.
    silhouetteToleranceFraction: 0.45,
    defect: 'Every 1 × 1 brick is held by exactly one stud and pivots off it.',
  }
}

function overhangShelf(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3460', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const start = build.parts.length
  const deck = build.place('3008', WHITE, 0, 0, base, { step: 'step_2' })
  build.place('3023b', ORANGE, 40, 0, deck, { step: 'step_4' })
  build.place('3023b', ORANGE, 80, 0, deck, { step: 'step_4' })
  return {
    id: 'overhang-shelf',
    title: 'Cantilevered shelf on one stud',
    klass: 'structural',
    instruction: 'strengthen the overhang',
    document: fixtureDocument(build.parts, 'Overhang shelf'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'weakConnections',
    silhouetteToleranceFraction: 0.45,
    defect: 'The outer 1 × 2 plate hangs half off the brick below it, held by a single stud.',
  }
}

function floatingLedge(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'deck' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const start = build.parts.length
  const deck = build.place('3008', WHITE, 0, -10, base, { step: 'step_2' })
  build.place('3008', WHITE, 0, 10, base, { step: 'step_2' })
  // A 1 × 1 plate perched on a single stud at each end of the run.
  for (const x of [-70, 70]) build.place('3024', ORANGE, x, -10, deck, { step: 'step_5' })
  return {
    id: 'floating-ledge',
    title: 'Corner plates on one stud each',
    klass: 'structural',
    instruction: 'the corner plates are loose — hold them down',
    document: fixtureDocument(build.parts, 'Floating ledge'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'weakConnections',
    silhouetteToleranceFraction: 0.45,
    defect: 'Two 1 × 1 plates sit on a single stud each at opposite ends of the deck.',
  }
}

// ---------------------------------------------------------------------------
// Surface finish
// ---------------------------------------------------------------------------

function tileRecess(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'deck' })
  const base = build.place('3032', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const baseId = build.parts[0].id
  build.place('3009', WHITE, 0, -30, base, { step: 'step_3' })
  build.place('3009', WHITE, 0, 30, base, { step: 'step_3' })
  build.place('3004', WHITE, -50, 0, base, { step: 'step_3', rotationY: 90 })
  build.place('3004', WHITE, 50, 0, base, { step: 'step_3', rotationY: 90 })
  return {
    id: 'tile-recess',
    title: 'Bare deck inside a brick surround',
    klass: 'silhouette',
    instruction: 'add surface detail while preserving the silhouette',
    document: fixtureDocument(build.parts, 'Tile recess'),
    scopePartIds: [baseId],
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'exposedStuds',
    defect: 'Eight studs of bare deck inside a one-brick surround, so tiling them cannot move the outline.',
  }
}

// ---------------------------------------------------------------------------
// Mechanisms
// ---------------------------------------------------------------------------

function hingeDeck(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'deck' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const baseId = build.parts[0].id
  // The 1 × 2 hinge pair shares an origin: that is where their knuckles meet.
  const hingeOrigin = originForSurface(catalog.get('3937'), base)
  build.place('3937', LIGHT_GREY, 60, -10, base, { step: 'step_6' })
  build.placeAt('3938', WHITE, 60, hingeOrigin, -10, { step: 'step_6' })
  const hinge = build.parts.slice(-2).map((part) => part.id)
  return {
    id: 'mechanism-hinge-deck',
    title: 'Bare deck beside a working hinge',
    klass: 'mechanism',
    instruction: 'tile the deck but do not touch the hatch',
    document: fixtureDocument(build.parts, 'Hinge deck'),
    scopePartIds: [baseId],
    protectedPartIds: [],
    boundaryPartIds: hinge,
    symmetryExceptionPartIds: [],
    targetObjective: 'exposedStuds',
    defect: 'The deck is unfinished; the hinge pair beside it is a real revolute joint that must survive.',
  }
}

function hingeWall(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const hingeOrigin = originForSurface(catalog.get('3937'), base)
  build.place('3937', LIGHT_GREY, 60, 10, base, { sub: 'deck', step: 'step_6' })
  build.placeAt('3938', WHITE, 60, hingeOrigin, 10, { sub: 'deck', step: 'step_6' })
  const hinge = build.parts.slice(-2).map((part) => part.id)

  const start = build.parts.length
  let surface = base
  for (let course = 0; course < 2; course += 1) {
    build.place('3010', WHITE, -40, -10, surface, { step: 'step_2' })
    surface = build.place('3010', WHITE, 40, -10, surface, { step: 'step_2' })
  }
  return {
    id: 'mechanism-hinge-wall',
    title: 'Unbonded wall alongside a working hinge',
    klass: 'mechanism',
    instruction: 'stagger the wall courses and leave the hatch alone',
    document: fixtureDocument(build.parts, 'Hinge wall'),
    scopePartIds: build.parts.slice(start).map((part) => part.id),
    protectedPartIds: [],
    boundaryPartIds: hinge,
    symmetryExceptionPartIds: [],
    targetObjective: 'seamBonding',
    defect: 'Two courses of 4 + 4 studs with a shared joint, next to a hinge whose interface must not move.',
  }
}

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

function lockedCockpit(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'chassis' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  // `createEmptyDocument` ships the cockpit assembly locked, so these two parts
  // are protected by the kernel rather than by anything this fixture declares.
  build.place('3004', WHITE, 60, 10, base, { sub: 'cockpit', step: 'step_5' })
  build.place('3004', WHITE, 20, 10, base, { sub: 'cockpit', step: 'step_5' })
  const locked = build.parts.slice(-2).map((part) => part.id)

  const start = build.parts.length
  let surface = base
  for (let course = 0; course < 3; course += 1) {
    build.place('3010', WHITE, -40, -10, surface, { sub: 'hull', step: 'step_2' })
    surface = build.place('3010', WHITE, 40, -10, surface, { sub: 'hull', step: 'step_2' })
  }
  return {
    id: 'locked-cockpit',
    title: 'Selection that reaches into a locked assembly',
    klass: 'protection',
    instruction: 'clean up this section',
    document: fixtureDocument(build.parts, 'Locked cockpit'),
    scopePartIds: [...locked, ...build.parts.slice(start).map((part) => part.id)],
    protectedPartIds: [],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'seamBonding',
    defect: 'The selection includes two parts in the locked cockpit assembly, which must be refused by name.',
  }
}

function protectedNose(): RefinementFixture {
  const build = new FixtureBuilder({ sub: 'hull' })
  const base = build.place('3034', LIGHT_GREY, 0, 0, 0, { step: 'step_1' })
  const course = build.place('3001', WHITE, -40, 0, base, { step: 'step_2' })
  build.place('3001', WHITE, 40, 0, base, { step: 'step_2' })
  build.place('3003', ORANGE, -20, 0, course, { step: 'step_3', protectedPart: true })
  build.place('3003', WHITE, 20, 0, course, { step: 'step_3' })
  const protectedId = build.parts[3].id
  return {
    id: 'protected-cap',
    title: 'Stepped shelf with one capstone marked protected',
    klass: 'protection',
    instruction: 'clean up these edges',
    document: fixtureDocument(build.parts, 'Protected cap'),
    scopePartIds: build.parts.slice(1).map((part) => part.id),
    protectedPartIds: [protectedId],
    boundaryPartIds: [],
    symmetryExceptionPartIds: [],
    targetObjective: 'steppedEdges',
    silhouetteToleranceFraction: 0.25,
    defect: 'One 2 × 2 capstone carries the document `protected` flag and is also named by the request.',
  }
}

// ---------------------------------------------------------------------------

/** Every fixture. Built on demand, because the catalog installs at test setup. */
export function refinementFixtures(): RefinementFixture[] {
  return [
    seamWall(),
    seamTower(),
    tippingMast(),
    microRunDeck(),
    microRunPlates(),
    steppedShelf(),
    roofSteps(),
    noseRound(),
    rareHull(),
    varietySprawl(),
    paletteNoise(),
    symmetricAntenna(),
    weakAntenna(),
    overhangShelf(),
    floatingLedge(),
    tileRecess(),
    hingeDeck(),
    hingeWall(),
    lockedCockpit(),
    protectedNose(),
  ]
}

/** A fixture by id, for a test that needs one specific case. */
export function refinementFixture(id: string): RefinementFixture {
  const found = refinementFixtures().find((fixture) => fixture.id === id)
  if (!found) throw new Error(`No refinement fixture named ${id}.`)
  return found
}
