import { C } from './kit.mjs'
import { voxelSculpture } from './sculpt.mjs'

/**
 * A blue whale at display scale, shaped as a solid rather than a height map.
 *
 * The earlier candidate was a height map, and it failed for a reason worth
 * writing down: a height map only knows how tall each column is, so a whale
 * built from one is a low blue lump the same colour as the sea it lies in. It
 * cannot raise a fluke clear of the water, cannot project a pectoral fin out
 * past the flank, and cannot put a pale belly under a dark back — all three of
 * which are what make the animal legible.
 *
 * Here the hull is a swept cross-section: at each station along the body a half
 * ellipse of its own girth, so the form swells behind the head and tapers into
 * the tail stock the way the animal does.
 */

const SEA = { width: 132, depth: 56 }
const AXIS = 28
/** The body runs from the tail stock at `from` to the snout at `to`. */
const BODY = { from: 14, to: 104, halfWidth: 13, halfHeight: 15 }
const FLUKE = { from: 2, to: 15, spread: 1.15, maxSpread: 15 }
const FIN = { from: 68, to: 86, courses: [3, 4, 5], reach: [5, 8, 6] }
const DORSAL = { from: 32, to: 42, courses: 4 }
const HEIGHT = 21

/**
 * Girth at a station, as a fraction of the widest section.
 *
 * Three straight runs: out of the tail stock, swelling to the shoulder, then
 * easing back into the blunt snout. A blue whale is widest about two thirds of
 * the way forward, and keeping that station right is most of what makes the
 * silhouette read as this animal rather than a fish.
 */
function girth(x) {
  const t = (x - BODY.from) / (BODY.to - BODY.from)
  if (t < 0 || t > 1) return 0
  if (t < 0.12) return 0.12 + (t / 0.12) * 0.06
  if (t < 0.62) return 0.18 + ((t - 0.12) / 0.5) * 0.82
  return 1 - ((t - 0.62) / 0.38) * 0.45
}

function blueWhaleMonument(rough) {
  return voxelSculpture(rough, {
    id: 'blue-whale-monument',
    title: 'Blue Whale Monument',
    width: SEA.width,
    depth: SEA.depth,
    roughWidth: 84,
    roughDepth: 42,
    height: HEIGHT,
    plinthColor: C.darkBluishGrey,
    fieldName: 'Editable ocean mosaic',
    fieldAccent: '#42a5c6',
    sceneName: 'Illuminated aquarium promenade',
    bodyName: 'Whale body, flukes and fins',
    bodyAccent: '#497c9a',
    accentName: 'Pale belly, foam and eye',
    accentColor: '#f7f3e8',

    // Pale water, so a dark blue animal reads against it. The previous scene
    // put a medium blue whale on a medium blue sea.
    fieldColor: (x, z) => {
      const swell = Math.sin(x * 0.24) * 2 + Math.cos(z * 0.31) * 2
      if ((x + z + Math.round(swell)) % 13 === 0) return C.white
      return (x * 2 + z) % 7 === 0 ? C.mediumBlue : C.transLightBlue
    },

    solid: (x, y, z) => {
      const dz = Math.abs(z + 0.5 - AXIS)
      const scale = girth(x)
      const halfWidth = BODY.halfWidth * scale
      const halfHeight = BODY.halfHeight * scale
      // The hull: a half ellipse at this station, standing on the waterline.
      const inHull =
        scale > 0 && halfWidth > 0.4 && (dz / halfWidth) ** 2 + ((y + 0.5) / Math.max(halfHeight, 0.6)) ** 2 <= 1

      // --- raised flukes ----------------------------------------------------
      // They corbel up and outwards off the tail stock, gaining just over a
      // stud of half-span a course, which every brick can reach back across.
      if (y >= FLUKE.from && y <= FLUKE.to) {
        const step = y - FLUKE.from
        const spread = Math.min(FLUKE.maxSpread, 2 + step * FLUKE.spread)
        const from = 12 + step * 0.42
        const to = 22 - step * 0.34
        // The notch between the two lobes opens as the fluke rises, which is
        // what stops it reading as one triangular sail.
        const notch = step < 4 ? 0 : 1.2 + step * 0.22
        if (x >= from && x <= to && dz <= spread && dz >= notch) return C.blue
      }

      // --- dorsal fin -------------------------------------------------------
      if (x >= DORSAL.from && x <= DORSAL.to && dz <= 1.5) {
        const back = Math.ceil(BODY.halfHeight * girth(x))
        if (y >= back && y < back + DORSAL.courses) return C.blue
      }

      // --- pectoral fins ----------------------------------------------------
      if (x >= FIN.from && x <= FIN.to && FIN.courses.includes(y)) {
        const reach = FIN.reach[FIN.courses.indexOf(y)]
        // Start inside the flank so the brick that carries the fin has studs
        // over hull the course below already holds.
        if (dz >= halfWidth - 3 && dz <= halfWidth + reach) return C.blue
      }

      if (inHull) {
        // A dark back over a pale belly, and the ventral pleats the animal is
        // named for, so the flank is not one flat colour.
        if (y <= 1) return { color: C.white, accent: true }
        if (y <= 3 && dz > halfWidth - 2.5) return (x + y) % 3 === 0 ? { color: C.white, accent: true } : C.mediumBlue
        const eye = x >= 92 && x <= 96 && y >= 2 && y <= 4 && dz >= halfWidth - 2
        if (eye) return { color: C.black, accent: true }
        return y >= halfHeight - 3.5 ? C.blue : C.mediumBlue
      }

      // --- foam -------------------------------------------------------------
      // A single course of white on the water where the hull breaks it.
      if (y === 0 && scale > 0 && dz <= halfWidth + 2.5) return { color: C.white, accent: true }
      return null
    },

    lights: [
      [4, 4, 5],
      [24, 3, 5],
      [44, 4, 5],
      [64, 3, 5],
      [84, 4, 5],
      [104, 3, 5],
      [126, 4, 5],
      [4, 52, 5],
      [24, 53, 5],
      [44, 52, 5],
      [64, 53, 5],
      [84, 52, 5],
      [104, 53, 5],
      [126, 52, 5],
    ],
    trees: [
      [10, 8, 3],
      [10, 48, 3],
      [120, 8, 3],
      [120, 48, 3],
      [62, 2, 4],
      [62, 54, 4],
    ],
    planters: [
      [16, 6],
      [36, 51],
      [76, 6],
      [112, 51],
    ],
  })
}

export default {
  id: 'blue-whale-monument',
  title: 'Blue Whale Monument',
  discipline: 'Large animal sculpture',
  category: 'animals',
  tagline:
    'A 132-stud blue whale with raised flukes, projecting pectoral fins and a pale belly, breaking a lit ocean promenade.',
  summary:
    'A display-scale animal sculpted as a 3D solid: a hull swept from a half-ellipse cross-section whose girth ' +
    'changes station by station, so the body swells behind the head and tapers into the tail stock. The flukes ' +
    'corbel clear of the water, the pectoral fins project past the flanks, and a pale belly and white foam separate ' +
    'the animal from the fully editable ocean mosaic beneath it.',
  techniques: [
    '3D voxel solid, not a height map',
    'Swept half-ellipse hull with varying girth',
    'Flukes corbelled clear of the water',
    'Projecting pectoral fins',
    'Pale belly, ventral pleats and foam line',
    'Editable ocean mosaic and lit promenade',
  ],
  refinement:
    'The first candidate put a simplified whale on a one-layer plate field whose parallel runs stayed disconnected, ' +
    'in the same blue as the sea around it. The published monument cross-bonds the complete ocean plinth and ' +
    'resolves the body, flukes, fins, belly and eye into an animal that reads at thumbnail size.',
  camera: { yaw: 32, pitch: 34, zoom: 1.04 },
  maxPartsPerStep: 96,
  tensionAllowance: 0,
  hero: false,
  brief: {
    prompt:
      'A large brick-built blue whale monument with a tapering body, flukes raised clear of the water, side fins, a pale belly and white foam, mounted over an editable ocean mosaic.',
    envelopeStuds: [132, null, 56],
    palette: ['Medium Blue', 'Blue', 'White', 'Trans Light Blue'],
    functions: ['Large animal figure', 'Editable water scene', 'Verified build sequence'],
  },
  author: blueWhaleMonument,
}
