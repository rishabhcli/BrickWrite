import { BRICK_LDU, Build, C, PLATE_LDU, STUD_LDU, addLamp, addTree, planBrickField, spec, studCentre } from './kit.mjs'

/**
 * An original suspension bridge across a fully editable river district.
 *
 * The shape of the thing is carried by four elements, in this order, because
 * each one has to stand on the last: masonry piers out of the river bed, a
 * bonded road deck across their tops, two portal towers straddling the road,
 * and then the suspension system.
 *
 * That last one is where a brick-built suspension bridge has to be honest about
 * itself. A real cable hangs and the deck hangs off it; studs only clutch
 * downwards, so a cable modelled that way is a line of parts resting on nothing
 * and the statics gate is right to throw it out. Here the order is inverted:
 * the hangers stand up off the deck, and each stepped segment of the main cable
 * rests on the pair of hangers beneath it. Every part is on a load path to the
 * river bed, and the elevation still draws the catenary the eye expects.
 */

const SITE = { width: 168, depth: 64 }
/** Water between these two banks; land outside them. */
const BANKS = { from: 26, to: 142 }
/** The deck occupies z ∈ [z0, z1); the carriageway is inset a kerb either side. */
const DECK = { z0: 25, z1: 39, from: 4, to: 164 }
const TOWERS = [52, 108]
const TOWER = {
  widthStuds: 8,
  legDepth: 4,
  legInset: 4,
  courses: 27,
  /** First course of each two-course portal beam. */
  beams: [8, 17],
  /** Course runs the legs occupy, leaving the beam courses to the beams. */
  legRuns: [
    [0, 8],
    [10, 17],
    [19, 27],
  ],
}
/** Piers under the deck, as `[x, widthStuds]`. */
const PIERS = [
  [8, 6],
  [24, 6],
  [38, 6],
  [76, 8],
  [126, 6],
  [140, 6],
  [154, 6],
]
/** Where the back-stays land, and where the hangers stop. */
const ANCHORS = [26, 134]
const CABLE = { spacing: 3, peak: 24, sag: 5, backstayDrop: 17 }

/** Height in courses of the main cable above the deck at `x`. */
function cableCourses(x) {
  const [left, right] = TOWERS
  const mid = (left + right) / 2
  const half = (right - left) / 2
  if (x >= left && x <= right) {
    // A parabola between the towers: full height at each tower, `sag` at mid.
    const t = (x - mid) / half
    return Math.round(CABLE.sag + (CABLE.peak - CABLE.sag) * t * t)
  }
  // Back-stays: a straight run from the tower down to its anchorage.
  const tower = x < left ? left : right
  const anchor = x < left ? ANCHORS[0] : ANCHORS[1]
  const t = Math.min(1, Math.abs(x - tower) / Math.abs(anchor - tower))
  const height = Math.round(CABLE.peak - CABLE.backstayDrop * t)
  return t >= 1 ? 0 : height
}

function sunlineSuspensionBridge(rough) {
  const width = rough ? 56 : SITE.width
  const depth = rough ? 22 : SITE.depth
  const layers = rough ? 1 : 2
  const build = new Build({
    subassemblies: [
      { id: 'river', name: 'River foundation', accent: '#42a5c6' },
      { id: 'water', name: 'Editable river mosaic', accent: '#83e7ee' },
      { id: 'piers', name: 'Masonry river piers', accent: '#7f8c9b' },
      { id: 'deck', name: 'Road deck and carriageway', accent: '#8bcf65' },
      { id: 'towers', name: 'Twin portal towers', accent: '#d66b55' },
      { id: 'cable', name: 'Main cables and hangers', accent: '#f7b04a' },
      { id: 'scene', name: 'Riverbanks, lighting and planting', accent: '#77b96a' },
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
  /**
   * A bonded stack of courses over a rectangle of studs.
   *
   * `planBrickField` cross-bonds at most two layers per call — that is its
   * whole job, a slab rather than a column — so anything taller is laid as
   * successive bonded pairs, each resting on the one below.
   */
  const block = (sub, color, x, z, y, widthStuds, depthStuds, courses, family = 'brick') => {
    const pitch = family === 'brick' ? BRICK_LDU : PLATE_LDU
    for (let course = 0; course < courses; course += 2) {
      absorb(
        planBrickField(
          spec({
            sub,
            origin: [x * STUD_LDU, y - course * pitch, z * STUD_LDU],
            color,
            family,
            widthStuds,
            footprintDepthStuds: depthStuds,
            layers: Math.min(2, courses - course),
          }),
        ),
        sub,
      )
    }
  }

  block('river', C.darkBluishGrey, 0, 0, 0, width, depth, layers, 'plate')
  const riverTop = -layers * PLATE_LDU

  // --- water and banks -----------------------------------------------------
  const bankFrom = rough ? 12 : BANKS.from
  const bankTo = rough ? width - 12 : BANKS.to
  const towerBase = (towerX) => [towerX - 2, TOWER.widthStuds + 4, DECK.z0 - 5, DECK.z1 - DECK.z0 + 10]
  const pierFootprint = (x, z) =>
    !rough &&
    ((z >= DECK.z0 && z < DECK.z1 && PIERS.some(([pierX, pierWidth]) => x >= pierX && x < pierX + pierWidth)) ||
      TOWERS.some((towerX) => {
        const [baseX, baseWidth, baseZ, baseDepth] = towerBase(towerX)
        return x >= baseX && x < baseX + baseWidth && z >= baseZ && z < baseZ + baseDepth
      }))
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pierFootprint(x, z)) continue
      const land = x < bankFrom || x >= bankTo
      const colour = land
        ? (x + z) % 7 === 0
          ? C.darkTan
          : (x * 3 + z) % 5 === 0
            ? C.darkGreen
            : C.green
        : (x + z * 2) % 11 === 0
          ? C.transLightBlue
          : (x * 2 + z) % 6 === 0
            ? C.blue
            : C.mediumBlue
      build.place('3024', colour, studCentre(x), studCentre(z), riverTop, { sub: 'water' })
    }
  }
  const groundTop = riverTop - PLATE_LDU

  if (rough) {
    notes.push(
      'The first site study lays the river on a single plate field; its parallel runs remain disconnected and no crossing spans them yet.',
    )
    return { build, notes, warnings }
  }

  // --- piers ---------------------------------------------------------------
  const pierCourses = 9
  const deckDepth = DECK.z1 - DECK.z0
  for (const [pierX, pierWidth] of PIERS) {
    block('piers', C.lightBluishGrey, pierX, DECK.z0, riverTop, pierWidth, deckDepth, pierCourses)
  }
  // The towers carry their own share straight to the bed on a wider base.
  for (const towerX of TOWERS) {
    const [baseX, baseWidth, baseZ, baseDepth] = towerBase(towerX)
    block('piers', C.lightBluishGrey, baseX, baseZ, riverTop, baseWidth, baseDepth, pierCourses)
  }
  const deckBase = riverTop - pierCourses * BRICK_LDU

  // --- deck ----------------------------------------------------------------
  block('deck', C.darkBluishGrey, DECK.from, DECK.z0, deckBase, DECK.to - DECK.from, deckDepth, 2)
  const deckTop = deckBase - 2 * BRICK_LDU

  // The carriageway stays editable one piece at a time: kerbs in dark grey, a
  // smooth running surface, and a dashed centre line down the middle.
  const kerbs = [DECK.z0 + 1, DECK.z1 - 2]
  const centre = [DECK.z0 + 6, DECK.z0 + 7]
  const insideTower = (x) => TOWERS.some((towerX) => x >= towerX && x < towerX + TOWER.widthStuds)
  // Towers and anchorage blocks land on the bonded deck itself; a road tile
  // under either would put a tile and a wall in the same vertical slice.
  const underStructure = (x) =>
    insideTower(x) || ANCHORS.some((anchorX) => x >= anchorX - 3 && x < anchorX + 3)
  for (let x = DECK.from; x < DECK.to; x += 1) {
    if (underStructure(x)) continue
    for (let z = DECK.z0 + 1; z < DECK.z1 - 1; z += 1) {
      const kerb = kerbs.includes(z)
      const line = centre.includes(z) && x % 6 < 3
      build.place(kerb ? '3005' : '3070b', kerb ? C.darkBluishGrey : line ? C.white : C.lightBluishGrey, studCentre(x), studCentre(z), deckTop, {
        sub: 'deck',
      })
    }
  }

  // --- towers --------------------------------------------------------------
  // Two legs either side of the roadway, tied together by portal beams. The
  // opening between the legs is the whole point: a suspension tower reads as
  // one because the road passes through it.
  const towerTops = new Map()
  for (const towerX of TOWERS) {
    const legZs = [DECK.z0 - TOWER.legInset, DECK.z1 + TOWER.legInset - TOWER.legDepth]
    const spanZ = legZs[0]
    const spanDepth = legZs[1] + TOWER.legDepth - legZs[0]
    // Legs alone are two posts. The beams are what make it a frame: each is a
    // bonded slab reaching from leg to leg and seated on both. The legs stop
    // short of each beam and resume above it, so a beam course and a leg course
    // never claim the same slice.
    for (const [from, to] of TOWER.legRuns) {
      for (const legZ of legZs) {
        block('towers', C.darkRed, towerX, legZ, deckBase - from * BRICK_LDU, TOWER.widthStuds, TOWER.legDepth, to - from)
      }
    }
    // Banded in stone rather than the tower's brick, so the two portal frames
    // read as the horizontal members they are instead of vanishing into a slab.
    for (const beam of TOWER.beams) {
      block('towers', C.darkTan, towerX, spanZ, deckBase - beam * BRICK_LDU, TOWER.widthStuds, spanDepth, 2)
    }
    const capY = deckBase - TOWER.courses * BRICK_LDU
    block('towers', C.darkTan, towerX - 1, spanZ - 1, capY, TOWER.widthStuds + 2, spanDepth + 2, 1)
    block('towers', C.darkTan, towerX, spanZ, capY - BRICK_LDU, TOWER.widthStuds, spanDepth, 1)
    towerTops.set(towerX, capY)
  }

  // --- suspension ----------------------------------------------------------
  // Hangers rise off the deck; the cable rests on them. Each segment spans the
  // gap to the next hanger, so the run reads as one continuous stepped curve.
  const cableZs = [DECK.z0, DECK.z1 - 1]
  let hangerCount = 0
  for (let x = ANCHORS[0]; x <= ANCHORS[1]; x += CABLE.spacing) {
    // A hanger inside a tower or an anchorage block would be inside masonry.
    if (underStructure(x + 1) || underStructure(x + 3)) continue
    const courses = cableCourses(x)
    if (courses < 1) continue
    for (const z of cableZs) {
      let surface = deckTop
      for (let course = 0; course < courses; course += 1) {
        surface = build.place('3005', C.darkBluishGrey, studCentre(x + 1), studCentre(z), surface, { sub: 'cable' })
      }
      // A 1 x 3 segment carried on the hanger it stands on, reaching to the
      // next one. Neighbouring segments sit at different heights and never
      // touch, which is what draws the curve.
      build.place('3622', C.yellow, (x + 2.5) * STUD_LDU, studCentre(z), surface, { sub: 'cable' })
      hangerCount += 1
    }
  }

  // Anchorage blocks, so the back-stays land on something.
  for (const anchorX of ANCHORS) {
    block('towers', C.darkTan, anchorX - 3, DECK.z0 - 3, deckTop, 6, deckDepth + 6, 3)
  }

  // --- scene ---------------------------------------------------------------
  for (const [index, x] of [6, 14, 18, 148, 156, 162].entries()) {
    for (const z of [6, 12, depth - 13, depth - 7]) {
      addTree(build, { x, z, surfaceY: groundTop, sub: 'scene', height: 3 + (index % 2), variant: index + z })
    }
  }
  for (const x of [10, 20, 146, 158]) {
    for (const z of [DECK.z0 - 8, DECK.z1 + 7]) {
      addLamp(build, { x, z, surfaceY: groundTop, sub: 'scene', height: 5 })
    }
  }
  // Deck lighting on the approach spans, where no hanger occupies the edge.
  for (const x of [8, 16, 144, 152, 160]) {
    for (const z of cableZs) addLamp(build, { x, z, surfaceY: deckTop, sub: 'scene', height: 4 })
  }

  notes.push(
    `A ${DECK.to - DECK.from}-stud road deck crosses a ${width} x ${depth}-stud river district on ` +
      `${PIERS.length} masonry piers and two portal towers ${TOWER.courses} courses tall.`,
    `${hangerCount} hangers stand off the deck and carry ${hangerCount} stepped cable segments, ` +
      'so the catenary is drawn by parts that are each on a load path to the river bed.',
  )
  return { build, notes, warnings }
}

export default {
  id: 'sunline-suspension-bridge',
  title: 'Sunline Suspension Bridge',
  discipline: 'Landmark infrastructure',
  category: 'landmarks',
  tagline:
    'Twin portal towers carry a 160-stud road deck and two stepped golden catenaries across a 168-stud river district.',
  summary:
    'An original city landmark on a fully editable river. Masonry piers lift a bonded fourteen-stud road deck clear ' +
    'of the water, two portal towers straddle the carriageway so the road passes through them, and the suspension ' +
    'system is built the only way studs allow: hangers stand up off the deck and each stepped cable segment rests ' +
    'on the pair beneath it, so the catenary is drawn by parts that are every one of them on a load path to the bed.',
  techniques: [
    '168 x 64-stud river district',
    'Twin portal towers with a through-road opening',
    'Nine-course masonry piers',
    'Bonded fourteen-stud road deck with kerbs and centre line',
    'Stepped catenary carried on standing hangers',
    'Back-stays landing on anchorage blocks',
  ],
  refinement:
    'The first candidate stopped at a one-layer river study, leaving its plate runs disconnected and no crossing ' +
    'between the banks. The published build cross-bonds the river, lifts a complete road deck onto piers, frames ' +
    'two portal towers over the carriageway and draws both catenaries.',
  camera: { yaw: 28, pitch: 22, zoom: 1.02 },
  maxPartsPerStep: 96,
  tensionAllowance: 320,
  tensionReason:
    'The portal beams between each tower’s legs are seated on the legs at both ends rather than clutching down ' +
    'into them, and the bonded tower caps rest on the masonry beneath them. The statics pass counts both as ' +
    'tension-carried. The allowance is bounded so a floating deck, pier or cable segment still fails.',
  hero: false,
  brief: {
    prompt:
      'An original large suspension bridge with twin portal towers the road passes through, a long raised deck, stepped golden catenaries carried on hangers, and a fully editable river beneath it.',
    envelopeStuds: [168, null, 64],
    palette: ['Dark Red', 'Yellow', 'Medium Blue', 'Light Bluish Grey'],
    functions: ['Large landmark', 'Editable river scene', 'Verified build sequence'],
  },
  author: sunlineSuspensionBridge,
}
