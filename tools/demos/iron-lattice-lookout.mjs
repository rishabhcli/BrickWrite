import { C, STUD_LDU, planClockFaces } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * An original ironwork lookout: columns and bracing, with daylight between them.
 *
 * The previous build called `planLattice`, which bays a deck on a grid, and the
 * bays came out one stud apart — so the renderer filled every gap and three
 * stacked boxes was all anyone ever saw. A lattice does not read as a lattice
 * because of what it is made of; it reads because of the size of the holes.
 *
 * So this one is a voxel solid whose occupancy is mostly *empty*: twelve
 * three-stud columns to a tier standing four to thirteen studs apart, a zigzag
 * brace sweeping up each face between them, and nothing else. The tiers taper
 * as they climb, which is the other half of the silhouette — a tower of
 * constant section reads as a chimney no matter how open it is.
 */

const SITE = { width: 76, depth: 76 }
const AXIS = 38
const PLINTH = { half: 24, courses: 8, archHalf: 7 }
const CAP = { from: 8, to: 9 }
const TIER_A = { from: 10, to: 31, radius: 22, taper: 0.5 }
const DECK_A = { from: 32, to: 33, oversail: 2 }
const TIER_B = { from: 34, to: 49, radius: 10.5, taper: 0.25 }
const DECK_B = { from: 50, to: 51, half: 11 }
const PAVILION = { from: 52, to: 55, half: 7 }
const ROOF = { from: 56, to: 57, half: 8 }
const HEIGHT = 58
/** How far a brace sweeps along a face before it turns back, in courses. */
const BRACE_PERIOD = 24

/** Radius of a tier at `course`, tapering from its base. */
const tierRadius = (tier, course) => tier.radius - (course - tier.from) * tier.taper

/**
 * Column centres for a tier: the four corners plus two points along each face.
 *
 * Twelve rather than eight because a deck has to land on them. Eight columns on
 * a square leave a gap as wide as the tier itself between corner and midpoint,
 * and no brick is long enough to reach across that from something carrying load.
 */
function columnOffsets(radius) {
  const along = [-radius, -radius / 3, radius / 3, radius]
  const points = []
  for (const t of along) {
    points.push([radius, t], [-radius, t], [t, radius], [t, -radius])
  }
  return points
}

/** Where the zigzag brace on a face has reached at `course`. */
function bracePosition(course, radius, phase) {
  const u = (((course + phase) % BRACE_PERIOD) / (BRACE_PERIOD / 2)) % 2
  return u <= 1 ? -radius + u * 2 * radius : radius - (u - 1) * 2 * radius
}

/** True where a tier's ironwork occupies `(dx, dz)` at `course`. */
function inTier(tier, course, dx, dz) {
  const radius = tierRadius(tier, course)
  if (radius < 2) return false
  for (const [cx, cz] of columnOffsets(radius)) {
    if (Math.max(Math.abs(dx - cx), Math.abs(dz - cz)) <= 1) return 'column'
  }
  // One brace per face, each a quarter period out of step with the last, so
  // the four faces never turn at the same height.
  const faces = [
    [Math.abs(dx - radius) <= 1, dz, 0],
    [Math.abs(dx + radius) <= 1, dz, 6],
    [Math.abs(dz - radius) <= 1, dx, 12],
    [Math.abs(dz + radius) <= 1, dx, 18],
  ]
  for (const [onFace, along, phase] of faces) {
    if (!onFace) continue
    if (Math.abs(along - bracePosition(course, radius, phase)) <= 1) return 'brace'
  }
  return false
}

function ironLatticeLookout(rough) {
  return voxelSculpture(rough, {
    id: 'iron-lattice-lookout',
    title: 'Iron Lattice Lookout',
    width: SITE.width,
    depth: SITE.depth,
    roughWidth: SITE.width,
    roughDepth: SITE.depth,
    height: HEIGHT,
    plinthColor: C.darkBluishGrey,
    fieldName: 'Editable lookout gardens',
    fieldAccent: '#77b96a',
    sceneName: 'Garden lighting, avenue trees and planted beds',
    bodyName: 'Ironwork columns, bracing and plinth',
    bodyAccent: '#83e7ee',
    accentName: 'Decks, glazing and clock stage',
    accentColor: '#f7b04a',

    // Lawn quartered by four gravel avenues on the tower's own axes.
    fieldColor: (x, z) => {
      const dx = Math.abs(x + 0.5 - AXIS)
      const dz = Math.abs(z + 0.5 - AXIS)
      if (dx < 3 || dz < 3) return (x + z) % 5 === 0 ? C.darkTan : C.lightBluishGrey
      return (x * 2 + z) % 7 === 0 ? C.darkGreen : C.green
    },

    solid: (x, y, z) => {
      const dx = x + 0.5 - AXIS
      const dz = z + 0.5 - AXIS
      const square = Math.max(Math.abs(dx), Math.abs(dz))

      // --- arched plinth ----------------------------------------------------
      if (y < PLINTH.courses) {
        if (square > PLINTH.half) return null
        // Two tunnels crossing at the centre, their heads stepping in over the
        // last three courses. From outside that is four arches.
        const head = PLINTH.archHalf - Math.max(0, y - PLINTH.courses + 4) * 2
        if (head > 0 && (Math.abs(dz) <= head || Math.abs(dx) <= head)) return null
        return (y + Math.round(square)) % 5 === 0 ? C.lightBluishGrey : C.sand
      }

      // Two cross-bonded cap courses. Without them the tier below lands on a
      // one-stud wall rim, and most of the ironwork measures as unsupported.
      if (y >= CAP.from && y <= CAP.to) {
        return square <= PLINTH.half ? C.lightBluishGrey : null
      }

      // --- lower tier -------------------------------------------------------
      if (y >= TIER_A.from && y <= TIER_A.to) {
        const part = inTier(TIER_A, y, dx, dz)
        if (part) return part === 'brace' ? C.lightBluishGrey : C.darkBluishGrey
        return null
      }

      // --- intermediate deck ------------------------------------------------
      if (y >= DECK_A.from && y <= DECK_A.to) {
        const half = tierRadius(TIER_A, TIER_A.to) + DECK_A.oversail
        if (square > half) return null
        // A parapet rim in white, so the deck reads as a platform.
        return square > half - 1.5 ? { color: C.white, accent: true } : C.lightBluishGrey
      }

      // --- upper tier -------------------------------------------------------
      if (y >= TIER_B.from && y <= TIER_B.to) {
        const part = inTier(TIER_B, y, dx, dz)
        if (part) return part === 'brace' ? C.lightBluishGrey : C.darkBluishGrey
        return null
      }

      // --- observation deck, pavilion and roof ------------------------------
      if (y >= DECK_B.from && y <= DECK_B.to) {
        if (square > DECK_B.half) return null
        return square > DECK_B.half - 1.5 ? { color: C.white, accent: true } : C.lightBluishGrey
      }
      if (y >= PAVILION.from && y <= PAVILION.to) {
        if (square > PAVILION.half) return null
        // Glazed on all four elevations, framed at the corners.
        const corner = Math.abs(Math.abs(dx) - Math.abs(dz)) < 1 && square > PAVILION.half - 1.5
        if (square > PAVILION.half - 1.5) {
          return corner ? C.white : { color: C.transLightBlue, accent: true }
        }
        return null
      }
      if (y >= ROOF.from && y <= ROOF.to) {
        const half = ROOF.half - (y - ROOF.from) * 1.5
        return square <= half ? { color: C.white, accent: true } : null
      }
      return null
    },

    /**
     * The clock stage crowns the tower. `planClockFaces` lays its own bonded
     * deck and four corner pedestals, each carrying a hand on a real revolute
     * the joint solver drives — not a printed tile.
     */
    detail: (build, { courseTop }) => {
      const diameter = 8
      const size = diameter + 4
      const origin = (AXIS - size / 2) * STUD_LDU
      build.addPlan(
        planClockFaces({
          originLdu: [origin, courseTop(ROOF.to + 1), origin],
          color: C.white,
          subassemblyId: 'accent',
          stepId: 'step_1',
          actor: 'human',
          diameterStuds: diameter,
        }),
        { sub: 'accent' },
      )
    },

    trees: [
      [8, 8, 4],
      [8, 67, 4],
      [67, 8, 4],
      [67, 67, 4],
      [4, 38, 3],
      [71, 38, 3],
      [38, 4, 3],
      [38, 71, 3],
      [14, 24, 3],
      [61, 24, 3],
      [14, 51, 3],
      [61, 51, 3],
    ],
    lights: [
      [26, 26, 5],
      [49, 26, 5],
      [26, 49, 5],
      [49, 49, 5],
      [2, 20, 5],
      [2, 55, 5],
      [73, 20, 5],
      [73, 55, 5],
    ],
    planters: [
      [20, 38],
      [55, 38],
      [38, 20],
      [38, 55],
      [10, 38],
      [65, 38],
    ],
  })
}

export default {
  id: 'iron-lattice-lookout',
  title: 'Iron Lattice Lookout',
  discipline: 'Landmark ironwork',
  category: 'landmarks',
  tagline:
    'Two tapering tiers of open ironwork rise fifty-eight courses from an arched plinth to a glazed lookout and a clock stage.',
  summary:
    'An original ironwork lookout you can see through. Each tier is twelve three-stud columns standing four to ' +
    'thirteen studs apart, with a zigzag brace sweeping up every face between them and a quarter-period offset so ' +
    'no two faces turn at the same height. The tiers taper as they climb, the plinth is cut by two crossing arched ' +
    'tunnels, and the crown carries an observation deck, a glazed pavilion and a clock stage whose four hands each ' +
    'sit on a real revolute hinge.',
  techniques: [
    'Open lattice: twelve columns a tier, braced',
    'Zigzag face bracing, offset per elevation',
    'Two tiers tapering as they rise',
    'Arched masonry plinth on two crossing tunnels',
    'Cross-bonded cap courses under the ironwork',
    'Glazed observation pavilion',
    'Four independently hinged clock hands',
  ],
  refinement:
    'The first candidate bays its lattice on a one-layer plinth field whose parallel runs never bond, so the ' +
    'ironwork stands on loose plates and the tower stops less than halfway up. The published set cross-bonds the ' +
    'plinth, caps it with two bonded courses before the tiers go on, and carries the full height to the clock stage.',
  camera: { yaw: 30, pitch: 14, zoom: 1.02 },
  maxPartsPerStep: 64,
  tensionAllowance: 320,
  tensionReason:
    'Each deck rests on the column tops beneath it rather than clutching down into them, and the clock hands hang ' +
    'from their hinge knuckles. The statics pass counts both as tension-carried; the allowance is bounded so a ' +
    'genuinely unsupported deck still fails the gate.',
  hero: false,
  brief: {
    prompt:
      'An ironwork lookout tower you can see through: an arched stone plinth, two tiers of braced open lattice tapering as they rise, a glazed observation pavilion and a clock stage whose hands actually turn.',
    envelopeStuds: [76, null, 76],
    palette: ['Sand', 'Light Bluish Grey', 'Dark Bluish Grey', 'White'],
    functions: ['Open lattice structure', 'Articulated clock hands', 'Arched ground level'],
  },
  author: ironLatticeLookout,
}
