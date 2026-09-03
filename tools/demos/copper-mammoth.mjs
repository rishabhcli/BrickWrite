import { C } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * A woolly mammoth standing on four legs, sculpted as a 3D solid.
 *
 * The earlier candidate was a height map and could not be anything but a mound:
 * a height map has one number per column, so there is no way to say "solid up
 * here, open underneath", which is the entire difference between an animal and
 * a hill. Everything that makes this one read — daylight under the belly, a
 * trunk reaching down to the canyon floor, tusks sweeping out past the head —
 * needs occupancy to be a function of all three axes.
 *
 * The load path is the design constraint. Bricks clutch downwards only, so the
 * body cannot simply appear above the legs: the haunches grow out of them three
 * studs a course until they meet over the middle, the trunk is built from the
 * floor up because it touches down, and the tusks root inside the head before
 * they corbel forward.
 */

const CANYON = { width: 112, depth: 64 }
const AXIS = 32
/** Leg centres, and how far the haunches spread per course once they start. */
const LEGS = [
  [34, 24],
  [34, 40],
  [62, 24],
  [62, 40],
]
// The legs have to stand inside the body's own envelope at the course the
// haunches start, or the belly has nothing beneath it to corbel out of and the
// whole animal ends up hanging off its trunk.
const LEG = { radius: 5, courses: 15, spread: 3 }
const BODY = { x: 48, z: AXIS, rx: 27, rz: 15, ry: 12, centreCourse: 23 }
const HUMP = { from: 52, to: 68, lift: 4 }
const HEAD = { x: 84, z: AXIS, radius: 12, ry: 9, centreCourse: 24, from: 15, to: 33 }
const TRUNK = { foot: 100, courses: 24, radius: 3.4 }
const TUSK = { from: 16, to: 27, rootX: 86, rise: 1.15, offset: 6, radius: 2.4 }
const EAR = { from: 22, to: 32, reach: 4 }
const HEIGHT = 36

/** Distance from `(x, z)` to the nearest leg centre. */
const legDistance = (x, z) => Math.min(...LEGS.map(([lx, lz]) => Math.hypot(x + 0.5 - lx, z + 0.5 - lz)))

/** Radius of the head sphere at `course`, or 0 above and below it. */
function headRadius(course) {
  const t = (course + 0.5 - HEAD.centreCourse) / HEAD.ry
  return Math.abs(t) >= 1 ? 0 : HEAD.radius * Math.sqrt(1 - t * t)
}

function copperMammoth(rough) {
  return voxelSculpture(rough, {
    id: 'copper-mammoth',
    title: 'Copper Canyon Mammoth',
    width: CANYON.width,
    depth: CANYON.depth,
    roughWidth: 68,
    roughDepth: 44,
    height: HEIGHT,
    plinthColor: C.lightBluishGrey,
    fieldName: 'Editable canyon floor',
    fieldAccent: '#d6a85d',
    sceneName: 'Canyon pines, trail lighting and planted markers',
    bodyName: 'Mammoth body, legs and trunk',
    bodyAccent: '#8b5a3c',
    accentName: 'Tusks, ears and eye',
    accentColor: '#f7f3e8',

    fieldColor: (x, z) => {
      const strata = Math.round(Math.sin(x * 0.18) * 3 + z * 0.35)
      if (strata % 7 === 0) return C.orange
      if (strata % 7 === 3) return C.darkTan
      return (x + z) % 5 === 0 ? C.lightBluishGrey : C.sand
    },

    solid: (x, y, z) => {
      const dz = Math.abs(z + 0.5 - AXIS)

      // --- tusks ------------------------------------------------------------
      // Checked first so their root overrides head cells: the white region has
      // to reach back over head the course below already carries, or no white
      // brick has anything to clutch onto.
      if (y >= TUSK.from && y <= TUSK.to) {
        const step = y - TUSK.from
        const tipX = TUSK.rootX + step * TUSK.rise
        const offset = TUSK.offset + step * 0.22
        if (
          x >= TUSK.rootX - 4 &&
          x <= tipX &&
          Math.abs(dz - offset) <= TUSK.radius - Math.max(0, step - 7) * 0.2
        ) {
          return { color: C.white, accent: true }
        }
      }

      // --- ears -------------------------------------------------------------
      if (y >= EAR.from && y <= EAR.to) {
        const radius = headRadius(y)
        if (radius > 2 && x >= HEAD.x - 8 && x <= HEAD.x + 1 && dz >= radius - 2.5 && dz <= radius + EAR.reach) {
          return { color: C.orange, accent: true }
        }
      }

      // --- trunk ------------------------------------------------------------
      // Built from the canyon floor up, because it reaches the ground: every
      // course leans back barely a stud towards the head, so it carries itself.
      if (y < TRUNK.courses) {
        const t = y / TRUNK.courses
        const centre = TRUNK.foot - t ** 1.5 * 16
        const radius = TRUNK.radius + t * 1.6
        if (Math.hypot(x + 0.5 - centre, dz) <= radius) return C.brown
      }

      // --- head -------------------------------------------------------------
      if (y >= HEAD.from && y <= HEAD.to) {
        const radius = headRadius(y)
        if (radius > 0.8 && Math.hypot(x + 0.5 - HEAD.x, dz) <= radius) {
          const eye = y >= 27 && y <= 29 && x >= HEAD.x - 4 && x <= HEAD.x && dz >= radius - 2.4
          return eye ? { color: C.black, accent: true } : C.reddishBrown
        }
      }

      // --- legs and body ----------------------------------------------------
      if (y < LEG.courses) {
        // Four columns with real daylight between them.
        return legDistance(x, z) <= LEG.radius ? C.reddishBrown : null
      }

      const hump = x >= HUMP.from && x <= HUMP.to ? HUMP.lift : 0
      const inBody =
        ((x + 0.5 - BODY.x) / BODY.rx) ** 2 +
          (dz / BODY.rz) ** 2 +
          ((y + 0.5 - BODY.centreCourse) / (BODY.ry + hump)) ** 2 <=
        1
      if (!inBody) return null
      // The haunches spread out of the legs rather than appearing above them,
      // so the underside is a real corbel and every brick is carried.
      if (legDistance(x, z) > LEG.radius + (y - LEG.courses + 1) * LEG.spread) return null
      // Shaggy banding, so the flank is not one flat mass at render scale.
      const shaggy = (x * 2 + y * 3 + Math.round(dz)) % 9 < 2
      return shaggy ? C.brown : C.reddishBrown
    },

    trees: [
      [6, 8, 4],
      [8, 54, 3],
      [104, 10, 3],
      [106, 56, 4],
      [52, 4, 4],
      [46, 60, 3],
      [20, 6, 3],
      [86, 60, 3],
      [4, 30, 4],
      [108, 34, 3],
    ],
    lights: [
      [2, 16, 5],
      [2, 48, 5],
      [109, 16, 5],
      [109, 48, 5],
      [28, 2, 5],
      [76, 2, 5],
      [28, 61, 5],
      [76, 61, 5],
    ],
    planters: [
      [14, 18],
      [16, 46],
      [96, 18],
      [98, 46],
      [58, 2],
      [62, 61],
    ],
  })
}

export default {
  id: 'copper-mammoth',
  title: 'Copper Canyon Mammoth',
  discipline: 'Large animal sculpture',
  category: 'animals',
  tagline:
    'A 112-stud woolly mammoth standing on four legs, trunk down to the canyon floor and white tusks sweeping forward.',
  summary:
    'A large animal figure sculpted as a 3D solid over a copper-and-sand canyon floor. It stands on four separate ' +
    'legs with daylight under the belly, the haunches corbel out of those legs course by course until they close ' +
    'over the middle, the trunk is built from the floor up because it reaches the ground, and the tusks root inside ' +
    'the head before they corbel forward. Body, legs, trunk, ears and tusks stay separate editable regions of one ' +
    'physically connected model.',
  techniques: [
    '3D voxel solid, not a height map',
    'Four legs with an open belly',
    'Haunches corbelled out of the legs',
    'Trunk carried from the canyon floor',
    'Tusks rooted in the head, corbelled forward',
    'Editable canyon mosaic with strata banding',
  ],
  refinement:
    'The first candidate used a smaller height-mapped silhouette over loose plate runs — a brown mound with no ' +
    'legs, trunk or tusks. The published figure cross-bonds a 112-stud canyon and resolves the mammoth into a ' +
    'standing body, four grounded legs, ears, a lowered trunk and paired tusks.',
  camera: { yaw: 36, pitch: 30, zoom: 1.06 },
  maxPartsPerStep: 96,
  tensionAllowance: 0,
  hero: false,
  brief: {
    prompt:
      'A large brick-built woolly mammoth standing on four legs with an open belly, a lowered trunk reaching the ground, amber ears and white tusks, on a canyon display plinth.',
    envelopeStuds: [112, null, 64],
    palette: ['Reddish Brown', 'Orange', 'White', 'Sand'],
    functions: ['Large animal figure', 'Editable scenic base', 'Verified build sequence'],
  },
  author: copperMammoth,
}
