import { C } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * A giant rubber duck float, shaped as a solid rather than a height map.
 *
 * The joke only lands if the silhouette reads instantly, and that needs the
 * three things a height map cannot give: a dome that overhangs its own
 * waterline, a neck narrower than the body it rises from, and a bill that
 * cantilevers forward past the head. All three come out of `solid` below,
 * which answers occupancy per cell in all three axes.
 */
const BASIN = { width: 96, depth: 68 }
const BODY = { x: 40, z: 34, rx: 27, rz: 19, courses: 18 }
const NECK = { x: 61, z: 34, radius: 6, from: 12, to: 25 }
const HEAD = { x: 67, z: 34, radius: 7.5, centreCourse: 30, from: 24, to: 36 }
/**
 * The bill, course by course, as `[lowest x, highest x, half depth]`.
 *
 * It starts well inside the head so its rear studs stand over head courses
 * that already carry load, and each course only reaches a few studs past the
 * one below it. That is a corbel — the way a real bill would have to be built —
 * rather than a slab hanging in the air that the statics gate would reject.
 */
const BILL = [
  [27, 62, 78, 4.5],
  [28, 62, 83, 4.5],
  [29, 62, 79, 3.0],
]

/**
 * The tail, course by course: a broad fin that corbels backwards as it rises.
 *
 * Its front edge retreats and its rear edge marches back by under two studs a
 * course, so every course overlaps the one beneath it and the fin is carried
 * all the way down into the body.
 */
const TAIL = { from: 6, to: 20, backStop: 6 }

/** Squared radius of `(x, z)` in an ellipse — at or below 1 is inside. */
const inEllipse = (x, z, cx, cz, rx, rz) => {
  const dx = (x + 0.5 - cx) / rx
  const dz = (z + 0.5 - cz) / rz
  return dx * dx + dz * dz
}

/** How much of a full radius survives at `course`, over a dome of `courses`. */
const domeFactor = (course, courses) => {
  const t = (course + 0.5) / courses
  return t >= 1 ? 0 : Math.sqrt(1 - t * t)
}

function colossalDuck(rough) {
  return voxelSculpture(rough, {
    id: 'colossal-duck',
    title: 'Colossal Duck Float',
    width: BASIN.width,
    depth: BASIN.depth,
    roughWidth: 64,
    roughDepth: 46,
    height: HEAD.to,
    plinthColor: C.lightBluishGrey,
    fieldName: 'Editable festival basin',
    fieldAccent: '#83e7ee',
    sceneName: 'Basin lighting, shoreline trees and planted moorings',
    bodyName: 'Duck body, neck and head',
    bodyAccent: '#f7b04a',
    accentName: 'Bill, eyes and wing flashes',
    accentColor: '#d66b55',

    // Concentric ripples, so the water reads as water at thumbnail size
    // instead of as a flat blue rectangle.
    fieldColor: (x, z, width, depth) => {
      const ring = Math.hypot(x - width / 2, (z - depth / 2) * 1.4)
      if (ring % 9 < 1.2) return C.mediumBlue
      if (ring % 9 < 3) return C.blue
      return C.transLightBlue
    },

    solid: (x, y, z) => {
      // --- bill ------------------------------------------------------------
      // Checked before the head so its anchor courses override head cells and
      // every orange brick has studs over something that carries load.
      const bill = BILL.find((course) => course[0] === y)
      if (bill && x >= bill[1] && x <= bill[2] && Math.abs(z + 0.5 - HEAD.z) <= bill[3]) {
        return { color: C.orange, accent: true }
      }

      // --- head ------------------------------------------------------------
      if (y >= HEAD.from && y <= HEAD.to) {
        const factor = Math.sqrt(Math.max(0, 1 - ((y + 0.5 - HEAD.centreCourse) / 6.5) ** 2))
        const radius = HEAD.radius * factor
        if (radius > 0.6 && inEllipse(x, z, HEAD.x, HEAD.z, radius, radius) <= 1) {
          // The eye is a black patch on the cheek, two courses tall, far
          // enough forward to sit beside the bill rather than behind it.
          const eye = y >= 30 && y <= 33 && x >= HEAD.x - 2 && x <= HEAD.x + 4 && Math.abs(z + 0.5 - HEAD.z) >= radius - 2.1
          return eye ? { color: C.black, accent: true } : C.yellow
        }
      }

      // --- neck ------------------------------------------------------------
      if (y >= NECK.from && y <= NECK.to) {
        const radius = NECK.radius - (y - NECK.from) * 0.08
        if (inEllipse(x, z, NECK.x, NECK.z, radius, radius) <= 1) return C.yellow
      }

      // --- tail ------------------------------------------------------------
      if (y >= TAIL.from && y <= TAIL.to) {
        const step = y - TAIL.from
        const xFrom = Math.max(TAIL.backStop, 20 - step * 1.6)
        const xTo = 26 - step * 0.6
        if (x >= xFrom && x <= xTo && Math.abs(z + 0.5 - BODY.z) <= 6.5 - step * 0.3) return C.yellow
      }

      // --- body ------------------------------------------------------------
      if (y < BODY.courses) {
        const factor = domeFactor(y, BODY.courses)
        if (inEllipse(x, z, BODY.x, BODY.z, BODY.rx * factor, BODY.rz * factor) <= 1) {
          // A wing flash near the waterline, so the flank is not one flat mass.
          const flank = Math.abs(z + 0.5 - BODY.z) >= BODY.rz * factor - 2.2
          const wing = y >= 9 && y <= 11 && flank && x >= 26 && x <= 50
          return wing ? { color: C.orange, accent: true } : C.yellow
        }
      }
      return null
    },

    trees: [
      [5, 6, 4],
      [6, 60, 3],
      [90, 8, 3],
      [88, 62, 4],
      [46, 3, 3],
      [50, 64, 3],
      [14, 4, 3],
      [78, 65, 4],
    ],
    lights: [
      [2, 20, 5],
      [2, 48, 5],
      [93, 20, 5],
      [93, 48, 5],
      [24, 2, 5],
      [70, 2, 5],
      [24, 65, 5],
      [70, 65, 5],
      [48, 1, 6],
      [48, 66, 6],
    ],
    planters: [
      [10, 14],
      [10, 54],
      [86, 14],
      [86, 54],
      [34, 2],
      [60, 66],
    ],
  })
}

export default {
  id: 'colossal-duck',
  title: 'Colossal Duck Float',
  discipline: 'Playful public art',
  category: 'creative',
  tagline:
    'A ninety-six-stud rubber duck: domed body, tall neck, cantilevered orange bill and a wake of lit moorings.',
  summary:
    'A deliberately ridiculous public-art build at landmark scale. The duck is a 3D voxel solid rather than a ' +
    'height map, so the body domes out over its own waterline, the neck rises narrower than the body beneath it, ' +
    'and the orange bill cantilevers forward past the head on bricks that reach back into it. Every course is laid ' +
    'as cross-bonded brickwork over a rippling, fully editable festival basin.',
  techniques: [
    '3D voxel solid, not a height map',
    'Cross-bonded courses in eleven brick footprints',
    'Overhanging domed body',
    'Cantilevered bill anchored into the head',
    'Editable rippled festival basin',
    'Festival lighting and shoreline planting',
  ],
  refinement:
    'The first float was a small yellow mass on loose one-layer water: its plate runs never bonded to each other ' +
    'and the silhouette had no neck, bill or eye. The published version cross-bonds the whole basin and resolves ' +
    'the body, neck, head, bill and eyes into a duck that reads at thumbnail size.',
  camera: { yaw: 34, pitch: 38, zoom: 1.04 },
  maxPartsPerStep: 96,
  tensionAllowance: 0,
  hero: false,
  brief: {
    prompt:
      'A funny large-scale yellow duck public-art float with a huge rounded body, tall neck, an orange bill that juts forward and black eyes, on an editable blue festival basin.',
    envelopeStuds: [96, null, 68],
    palette: ['Yellow', 'Orange', 'Black', 'Trans Light Blue'],
    functions: ['Funny creative landmark', 'Editable scenic base', 'Verified build sequence'],
  },
  author: colossalDuck,
}
