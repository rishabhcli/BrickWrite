import { C, STUD_LDU, planCrane } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * A harbour control tower, on a quay with something to control.
 *
 * The previous build was a constant-section block with a window grid on it,
 * standing on an empty slab. Two things fix that, and neither is size. The
 * first is the silhouette: what makes a control tower read is a slender shaft
 * carrying a room that *overhangs it on every side*, under a roof that
 * oversails again. The second is programme — a quay with nothing on it reads as
 * a car park, so the cargo court gets container stacks, the west end gets bunded
 * fuel tanks, the podium roof gets a helipad, and the crane gets big enough to
 * matter.
 *
 * The overhang is corbelled three studs a course out of the shaft, which is
 * what keeps every brick of it on a load path to the ground.
 */

const QUAY = { width: 108, depth: 76 }
const PODIUM = { x0: 16, x1: 70, z0: 12, z1: 46, courses: 9 }
/** Two drive-through bays, given as the z centre of each. */
const BAYS = [21.5, 36.5]
const SHAFT = { x: 43, z: 29, from: 9, to: 40, half: 9, taper: 0.06 }
const ROOM = { from: 41, to: 47, half: 13 }
const ROOF = { from: 48, to: 49, half: 15 }
const MAST = { from: 50, to: 61 }
const HELIPAD = { x: 60, z: 20, radius: 7 }
/**
 * The crane, and why its boom is short.
 *
 * The boom is a cantilever off a single luffing knuckle, and the statics pass
 * checks leverage as well as load: at twelve studs it fails as over-capacity
 * even though ten grams is nothing. So the reach stays at eight and the crane
 * is made to read by standing it on a six-course gantry pedestal instead.
 */
const CRANE = { x: 58, z: 36, boom: 8, pedestal: { x0: 54, x1: 66, z0: 32, z1: 44, to: 15 } }
const TANKS = [
  [8, 20, 5],
  [8, 40, 5],
]
/** Container stacks on the cargo court: `[x, z, width, depth, courses, colour]`. */
const CONTAINERS = [
  [78, 14, 8, 6, 6, C.red],
  [78, 22, 8, 6, 3, C.blue],
  [88, 14, 8, 6, 4, C.green],
  [88, 22, 8, 6, 6, C.orange],
  [78, 32, 8, 6, 5, C.yellow],
  [88, 32, 8, 6, 3, C.red],
  [78, 40, 8, 6, 3, C.orange],
  [88, 40, 8, 6, 5, C.blue],
]
const HEIGHT = 62

/** Half-width of the shaft at `course`. */
const shaftHalf = (course) => SHAFT.half - (course - SHAFT.from) * SHAFT.taper

function harbourControlTower(rough) {
  return voxelSculpture(rough, {
    id: 'harbour-control-tower',
    title: 'Harbour Control Tower',
    width: QUAY.width,
    depth: QUAY.depth,
    roughWidth: 84,
    roughDepth: 56,
    height: HEIGHT,
    plinthColor: C.darkBluishGrey,
    fieldName: 'Editable quay apron',
    fieldAccent: '#7f8c9b',
    sceneName: 'Promenade lighting, planting and quayside trees',
    bodyName: 'Podium, shaft and control room',
    bodyAccent: '#d6a85d',
    accentName: 'Glazing, containers, tanks and crane',
    accentColor: '#f7b04a',

    // Water along the seaward edge, a hatched loading strip beside it, and
    // plain apron elsewhere.
    fieldColor: (x, z, width, depth) => {
      if (z >= depth - 8) return (x + z) % 5 === 0 ? C.transLightBlue : C.mediumBlue
      if (z >= depth - 12) return (x + z) % 4 < 2 ? C.yellow : C.darkBluishGrey
      if (x < 4 || x >= width - 4) return C.darkTan
      return (x * 2 + z) % 9 === 0 ? C.darkBluishGrey : C.lightBluishGrey
    },

    solid: (x, y, z) => {
      const dx = x + 0.5 - SHAFT.x
      const dz = z + 0.5 - SHAFT.z
      const square = Math.max(Math.abs(dx), Math.abs(dz))

      // --- mast, roof, control room ----------------------------------------
      if (y >= MAST.from && y <= MAST.to) {
        if (square > 1) return null
        return Math.floor((y - MAST.from) / 2) % 2 === 0 ? { color: C.red, accent: true } : C.white
      }
      if (y >= ROOF.from && y <= ROOF.to) {
        const half = ROOF.half - (y - ROOF.from) * 2
        return square <= half ? C.darkBluishGrey : null
      }
      if (y >= ROOM.from && y <= ROOM.to) {
        // Two solid slabs corbel the floor out of the shaft three studs a
        // course, and the glazed walls stand on the second one. Building the
        // walls straight off the shaft instead leaves their inner edge sitting
        // on the shaft's own outer edge with nothing to clutch, and the whole
        // ring is dropped as uncarried.
        const floor = y - ROOM.from
        if (floor < 2) {
          const half = Math.min(ROOM.half, shaftHalf(SHAFT.to) + (floor + 1) * 3)
          return square <= half ? C.white : null
        }
        if (square > ROOM.half) return null
        // The stair core carries straight through to the roof; without it the
        // roof slab hangs on the glazing alone and measures as over-capacity.
        if (square <= 4) return C.white
        if (square <= ROOM.half - 2.5) return null
        const ceiling = y === ROOM.to
        const corner = Math.abs(Math.abs(dx) - Math.abs(dz)) < 2.5
        return ceiling || corner ? C.white : { color: C.transLightBlue, accent: true }
      }

      // --- shaft ------------------------------------------------------------
      // Note the fall-through: this branch must only answer for cells inside
      // the shaft's own footprint. Returning null for everything at these
      // courses would swallow the crane pedestal, which stands beside it.
      if (y >= SHAFT.from && y <= SHAFT.to && square <= shaftHalf(y)) {
        const half = shaftHalf(y)
        if (square <= half - 2) return null // hollow: a shaft, not a pillar
        // A banded stair core, glazed on two elevations.
        if ((y - SHAFT.from) % 7 === 0) return C.sand
        const face = Math.abs(dx) > Math.abs(dz)
        return face && (y - SHAFT.from) % 7 > 1 && (y - SHAFT.from) % 7 < 6 && Math.abs(dz) < half - 2.5
          ? { color: C.transLightBlue, accent: true }
          : C.white
      }

      // --- crane gantry pedestal --------------------------------------------
      if (
        y >= PODIUM.courses &&
        y < CRANE.pedestal.to &&
        x >= CRANE.pedestal.x0 &&
        x < CRANE.pedestal.x1 &&
        z >= CRANE.pedestal.z0 &&
        z < CRANE.pedestal.z1
      ) {
        const rim = x < CRANE.pedestal.x0 + 2 || x >= CRANE.pedestal.x1 - 2 || z < CRANE.pedestal.z0 + 2 || z >= CRANE.pedestal.z1 - 2
        if (!rim && y < CRANE.pedestal.to - 2) return null
        return y % 3 === 0 ? { color: C.yellow, accent: true } : C.darkBluishGrey
      }

      // --- container stacks and fuel tanks ----------------------------------
      for (const [cx, cz, cw, cd, courses, colour] of CONTAINERS) {
        if (y < courses && x >= cx && x < cx + cw && z >= cz && z < cz + cd) {
          const rib = (x - cx) % 3 === 0
          return rib ? { color: colour, accent: true } : colour
        }
      }
      for (const [tx, tz, radius] of TANKS) {
        if (y < PODIUM.courses + 3 && Math.hypot(x + 0.5 - tx, z + 0.5 - tz) <= radius) {
          return y % 4 === 3 ? C.darkBluishGrey : C.lightBluishGrey
        }
      }

      // --- podium -----------------------------------------------------------
      if (y < PODIUM.courses && x >= PODIUM.x0 && x < PODIUM.x1 && z >= PODIUM.z0 && z < PODIUM.z1) {
        // The bays are tunnels straight through, their heads stepping in over
        // the last courses so the openings read as openings.
        const head = 4 - Math.max(0, y - 4) * 1.4
        if (head > 0 && BAYS.some((centre) => Math.abs(z + 0.5 - centre) <= head)) return null
        if (y >= PODIUM.courses - 2) {
          // Roof deck: a painted helipad on one half, plain concrete elsewhere.
          const pad = Math.hypot(x + 0.5 - HELIPAD.x, z + 0.5 - HELIPAD.z)
          if (pad <= HELIPAD.radius) {
            return pad > HELIPAD.radius - 1.2 || Math.abs(x + 0.5 - HELIPAD.x) < 1.2
              ? { color: C.yellow, accent: true }
              : C.darkBluishGrey
          }
          return C.lightBluishGrey
        }
        // Reveals either side of each bay, so the openings have a frame.
        const reveal = BAYS.some((centre) => Math.abs(z + 0.5 - centre) <= head + 1.5)
        return reveal ? C.darkBluishGrey : (x + y) % 6 === 0 ? C.sand : C.darkTan
      }
      return null
    },

    /**
     * The quay crane. `planCrane` builds a fixed mast and a boom on a real
     * 3937/3938 luffing joint, which the kernel's joint solver drives from the
     * inspector like any other hinge.
     */
    detail: (build, { courseTop }) => {
      build.addPlan(
        planCrane({
          originLdu: [CRANE.x * STUD_LDU, courseTop(CRANE.pedestal.to), CRANE.z * STUD_LDU],
          color: C.yellow,
          subassemblyId: 'accent',
          stepId: 'step_1',
          actor: 'human',
          boomStuds: CRANE.boom,
        }),
        { sub: 'accent' },
      )
    },

    trees: [
      [6, 56, 3],
      [20, 56, 3],
      [34, 56, 4],
      [48, 56, 3],
      [62, 56, 3],
      [76, 56, 4],
      [98, 56, 3],
      [6, 6, 3],
      [98, 6, 3],
    ],
    lights: [
      [12, 52, 6],
      [30, 52, 6],
      [48, 52, 6],
      [66, 52, 6],
      [84, 52, 6],
      [102, 52, 6],
      [2, 12, 5],
      [2, 40, 5],
      [105, 12, 5],
      [105, 40, 5],
    ],
    planters: [
      [12, 8],
      [40, 8],
      [72, 8],
      [100, 8],
      [12, 50],
      [96, 50],
    ],
  })
}

export default {
  id: 'harbour-control-tower',
  title: 'Harbour Control Tower',
  discipline: 'Play set',
  category: 'architecture',
  tagline:
    'A 108-stud quay: two drive-through bays, eight container stacks, bunded tanks, a helipad and a glazed control room that overhangs its shaft.',
  summary:
    'An original quayside play set rather than another facade. Two bays run straight through the podium so vehicles ' +
    'pass under it, the podium roof carries a painted helipad and a luffing crane, the cargo court is stacked with ' +
    'containers, and a hollow banded shaft rises to a glazed control room corbelled three studs a course out over ' +
    'every elevation, under an oversailing roof and a banded mast.',
  techniques: [
    'Drive-through vehicle bays with stepped heads',
    'Control room corbelled out over the shaft',
    'Hollow glazed shaft, banded',
    'Painted helipad on the podium roof',
    'Eight container stacks and two bunded tanks',
    'Crane on a real luffing hinge',
  ],
  refinement:
    'The rough candidate is a single glazed block on a plain one-layer slab — a tower with nothing to do, its ' +
    'ground plane in loose plate runs that never bond. The published set cross-bonds the quay, cuts the podium ' +
    'open for vehicles, fills the cargo court, and puts a crane on the roof the joint solver can drive.',
  camera: { yaw: 36, pitch: 22, zoom: 1.04 },
  maxPartsPerStep: 72,
  tensionAllowance: 420,
  tensionReason:
    'Glazing is seated inside its frames and the control-room floor and roof rest on the walls beneath them at the ' +
    'perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the ' +
    'allowance is bounded so a genuinely unsupported deck still fails the gate.',
  hero: false,
  brief: {
    prompt:
      'A quayside control tower with two drive-through vehicle bays under the podium, a helipad and working crane on the podium roof, container stacks and fuel tanks on the quay, and a glazed control room overhanging a tall shaft.',
    envelopeStuds: [108, null, 76],
    palette: ['Sand', 'White', 'Light Bluish Grey', 'Dark Bluish Grey', 'Yellow'],
    functions: ['Drive-in vehicle bays', 'Luffing crane', 'Verified build sequence'],
  },
  author: harbourControlTower,
}
