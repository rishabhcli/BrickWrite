import { C, planHingedFlap, spec } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * A freighter standing on its landing gear over a shipyard apron.
 *
 * The previous build laid the whole ship out of plate layers, and the result
 * read as a grey slab painted on the ground — barely taller than the lamp posts
 * around it, with no way to tell which end was the bow. What a spacecraft needs
 * from a render this size is mass and daylight: a deep hull, a stepped upper
 * deck and a bridge above that, all of it lifted clear of the apron so the eye
 * reads a vehicle rather than a foundation.
 *
 * Six legs carry it. Everything above them corbels out of those legs four studs
 * a course, which is why the underbelly tapers into the gear instead of ending
 * in a flat floor hanging in the air.
 */

const APRON = { width: 96, depth: 64 }
const AXIS = 32
const SHIP = { stern: 6, bow: 86 }
const GEAR = { xs: [18, 46, 74], zs: [22, 42], radius: 4.5, courses: 6, spread: 4 }
const HULL = { from: 6, to: 18 }
const UPPER = { from: 19, to: 23, inset: 6 }
const BRIDGE = { from: 24, to: 30, x0: 58, x1: 74, halfDepth: 8 }
const SPINE = { from: 24, to: 26, x0: 22, x1: 54, halfDepth: 4 }
const ENGINES = { from: 9, to: 17, x0: 4, x1: 13, zs: [22, 32, 42], radius: 4 }
const HEIGHT = 31

/**
 * Half-width of the planform at a station.
 *
 * A blunt stern, a parallel midbody and a long taper to a pointed bow. The
 * taper is the whole reason the ship reads as one from above; the earlier
 * rectangular deck is what made it read as a building.
 */
function halfWidth(x) {
  if (x < SHIP.stern || x > SHIP.bow) return 0
  if (x < 14) return 4 + (x - SHIP.stern) * 1.75
  if (x < 30) return 18 + (x - 14) * 0.25
  if (x < 56) return 22
  return Math.max(0, 22 - (x - 56) * 0.67)
}

const distanceToGear = (x, z) =>
  Math.min(
    ...GEAR.xs.flatMap((gx) => GEAR.zs.map((gz) => Math.hypot(x + 0.5 - gx, z + 0.5 - gz))),
  )

function saucerFreighter(rough) {
  return voxelSculpture(rough, {
    id: 'saucer-freighter',
    title: 'Saucer Freighter',
    width: APRON.width,
    depth: APRON.depth,
    roughWidth: 70,
    roughDepth: 52,
    height: HEIGHT,
    plinthColor: C.darkBluishGrey,
    fieldName: 'Editable shipyard apron',
    fieldAccent: '#7f8c9b',
    sceneName: 'Apron lighting and hazard markings',
    bodyName: 'Hull, upper deck and landing gear',
    bodyAccent: '#b6bec7',
    accentName: 'Bridge glazing, engines and hinged flaps',
    accentColor: '#83e7ee',

    // Hazard chevrons around a plain landing square, so the apron reads as a
    // working surface rather than a tan rectangle.
    fieldColor: (x, z, width, depth) => {
      const edge = Math.min(x, z, width - 1 - x, depth - 1 - z)
      if (edge < 3) return (x + z) % 6 < 3 ? C.orange : C.darkBluishGrey
      if (edge < 5) return C.darkTan
      return (x * 2 + z) % 9 === 0 ? C.darkBluishGrey : C.lightBluishGrey
    },

    solid: (x, y, z) => {
      const dz = Math.abs(z + 0.5 - AXIS)

      // --- landing gear -----------------------------------------------------
      if (y < GEAR.courses) {
        return distanceToGear(x, z) <= GEAR.radius ? C.darkBluishGrey : null
      }
      // Everything above the gear has to reach back down into it.
      if (distanceToGear(x, z) > GEAR.radius + (y - GEAR.courses + 1) * GEAR.spread) return null

      // --- engines ----------------------------------------------------------
      if (y >= ENGINES.from && y <= ENGINES.to && x >= ENGINES.x0 && x <= ENGINES.x1) {
        const bell = Math.min(...ENGINES.zs.map((ez) => Math.hypot(x + 0.5 - ENGINES.x1, z + 0.5 - ez)))
        if (bell <= ENGINES.radius) {
          return x <= ENGINES.x0 + 1 ? { color: C.transNeonOrange, accent: true } : C.darkBluishGrey
        }
      }

      // --- bridge -----------------------------------------------------------
      if (y >= BRIDGE.from && y <= BRIDGE.to && x >= BRIDGE.x0 && x <= BRIDGE.x1) {
        const taper = Math.max(0, y - BRIDGE.to + 3)
        if (dz <= BRIDGE.halfDepth - taper) {
          const glazed = y >= BRIDGE.from + 1 && y <= BRIDGE.from + 3 && (dz >= BRIDGE.halfDepth - taper - 1 || x >= BRIDGE.x1 - 1)
          return glazed ? { color: C.transLightBlue, accent: true } : C.lightBluishGrey
        }
      }

      // --- dorsal spine -----------------------------------------------------
      if (y >= SPINE.from && y <= SPINE.to && x >= SPINE.x0 && x <= SPINE.x1 && dz <= SPINE.halfDepth) {
        return C.darkBluishGrey
      }

      // --- upper deck -------------------------------------------------------
      if (y >= UPPER.from && y <= UPPER.to) {
        const step = Math.max(0, y - UPPER.to + 2)
        if (dz <= halfWidth(x) - UPPER.inset - step) return C.darkTan
      }

      // --- hull -------------------------------------------------------------
      if (y >= HULL.from && y <= HULL.to) {
        // Chamfer the bottom two courses and the top one, so the section is a
        // hull rather than an extrusion.
        const chamfer = Math.max(0, HULL.from + 2 - y) * 2 + Math.max(0, y - HULL.to + 1) * 2
        if (dz <= halfWidth(x) - chamfer) {
          // A waistline band, and a lit strip along the flanks.
          if (y === HULL.to - 3 && dz >= halfWidth(x) - chamfer - 1.5) {
            return x % 7 < 3 ? { color: C.transNeonOrange, accent: true } : C.darkBluishGrey
          }
          return y >= HULL.to - 5 ? C.lightBluishGrey : C.darkBluishGrey
        }
      }
      return null
    },

    /**
     * The two hinges, added after the solid so they can be seated on surfaces
     * the courses have already established. Both are driven by the same joint
     * solver the editor uses, not moulded on.
     */
    detail: (build, { courseTop }) => {
      build.addPlan(
        planHingedFlap(
          spec({
            sub: 'accent',
            origin: [14 * 20, courseTop(UPPER.to + 1), 32 * 20],
            color: C.darkTan,
            widthStuds: 6,
            // `planHingedFlap` lays the leaf as a field, and a reach over two
            // studs puts an outer plate row past the hinge tops with nothing
            // under it — a loose part the connectivity gate is right to reject.
            reachStuds: 2,
          }),
        ),
        { sub: 'accent' },
      )
      build.addPlan(
        planHingedFlap(
          spec({
            sub: 'accent',
            origin: [32 * 20, courseTop(SPINE.to + 1), 32 * 20],
            color: C.darkBluishGrey,
            widthStuds: 6,
            reachStuds: 2,
          }),
        ),
        { sub: 'accent' },
      )
    },

    lights: [
      [3, 6, 6],
      [3, 57, 6],
      [92, 6, 6],
      [92, 57, 6],
      [48, 2, 6],
      [48, 61, 6],
    ],
    trees: [],
    planters: [
      [10, 8],
      [10, 55],
      [86, 8],
      [86, 55],
    ],
  })
}

export default {
  id: 'saucer-freighter',
  title: 'Saucer Freighter',
  discipline: 'Vehicle and mechanism',
  category: 'vehicles',
  tagline:
    'A ninety-six-stud freighter on six landing legs: deep tapering hull, stepped upper deck, raised bridge and three lit engine bells.',
  summary:
    'An original freighter shaped as a 3D solid and stood clear of its apron. The planform runs from a blunt stern ' +
    'through a parallel midbody to a pointed bow, the hull is chamfered top and bottom rather than extruded, a ' +
    'stepped upper deck carries a glazed bridge forward and a dorsal spine aft, and three engine bells glow at the ' +
    'stern. Everything above the legs corbels out of them course by course, so the underbelly tapers into the gear ' +
    'instead of hanging in the air. Two real hinges — a boarding flap and a dorsal turret — are driven by the ' +
    'kernel’s own joint solver.',
  techniques: [
    '3D voxel solid, not a plate stack',
    'Six landing legs with daylight beneath the hull',
    'Tapered lozenge planform, pointed bow',
    'Chamfered hull section',
    'Glazed bridge over a stepped upper deck',
    'Three lit engine bells',
    'Two flaps on real hinges',
  ],
  refinement:
    'The rough candidate is a single rectangular slab lying on the apron with the cockpit sitting on top of it — a ' +
    'box with a windscreen, and loose one-layer ground under it. The published set lifts the ship onto six legs, ' +
    'gives it a tapering chamfered hull twelve courses deep, and puts a bridge, a spine and three engines on it.',
  camera: { yaw: 40, pitch: 26, zoom: 1.04 },
  maxPartsPerStep: 64,
  tensionAllowance: 640,
  tensionReason:
    'The hinged flaps rest on their knuckles rather than clutching down into the deck, and the bridge glazing is ' +
    'seated in its frame. The statics pass counts both as tension-carried; the allowance is bounded so an actually ' +
    'unsupported hull panel still fails the gate.',
  hero: false,
  brief: {
    prompt:
      'An original saucer freighter standing on landing legs, with a deep tapering hull, a pointed bow, a stepped upper deck, a glazed bridge, three engine bells and two flaps that open.',
    envelopeStuds: [96, null, 64],
    palette: ['Light Bluish Grey', 'Dark Bluish Grey', 'Dark Tan', 'Trans Neon Orange'],
    functions: ['Hinged boarding flap', 'Hinged dorsal turret', 'Verified build sequence'],
  },
  author: saucerFreighter,
}
