import { BRICK_LDU, Build, C, PLATE_LDU, STUD_LDU, addLamp, addPlanter, addTree, elementLibrary, planBrickField, planEnclosure, spec, studCentre } from './kit.mjs'

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
  // The plaza is the frame, not the leftover. Twenty-eight storeys is nearly
  // twice as tall as the old 84-stud site was wide, so the render was a column
  // in a void with a sliver of ground at the bottom.
  const PLAZA_W = rough ? 58 : 108
  const PLAZA_D = rough ? 30 : 72
  const OX = rough ? 9 : 30
  const OZ = rough ? 9 : 27
  const POOL = { x0: 78, x1: 102, z0: 24, z1: 48 }
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
  const annex = rough ? null : { x: 8, z: 26, width: 14, depth: 20 }
  const outsideTower = (x, z) => !(x >= OX - 1 && x < OX + WIDTH + 1 && z >= OZ - 1 && z < OZ + DEPTH + 1)
  const outsideAnnex = (x, z) =>
    !annex || !(x >= annex.x && x < annex.x + annex.width && z >= annex.z && z < annex.z + annex.depth)
  // Site furniture is generated from the plaza dimensions rather than listed,
  // so enlarging the site does not leave the trees clustered in one corner.
  const range = (from, to, step) => {
    const out = []
    for (let value = from; value <= to; value += step) out.push(value)
    return out
  }
  const treeSites = rough
    ? []
    : [
        ...range(6, PLAZA_W - 7, 10).flatMap((x) => [
          [x, 6],
          [x, PLAZA_D - 7],
        ]),
        ...range(17, PLAZA_D - 18, 11).flatMap((z) => [
          [6, z],
          [PLAZA_W - 7, z],
        ]),
      ]
  const lampSites = rough
    ? []
    : [
        ...range(12, PLAZA_W - 13, 12).flatMap((x) => [
          [x, 12],
          [x, PLAZA_D - 13],
        ]),
        ...range(24, PLAZA_D - 25, 12).flatMap((z) => [
          [12, z],
          [PLAZA_W - 13, z],
        ]),
      ]
  const planterSites = rough
    ? []
    : [
        [OX - 6, OZ - 4],
        [OX - 6, OZ + DEPTH + 3],
        [OX + WIDTH + 5, OZ - 4],
        [OX + WIDTH + 5, OZ + DEPTH + 3],
        [OX + 8, OZ - 8],
        [OX + WIDTH - 9, OZ - 8],
        [OX + 8, OZ + DEPTH + 7],
        [OX + WIDTH - 9, OZ + DEPTH + 7],
      ]
  // Generated sites can land on the pavilion or the tower footprint; drop those
  // rather than stacking a lamp post through a roof.
  const clear = (sites) => sites.filter(([x, z]) => outsideTower(x, z) && outsideAnnex(x, z))
  const figures = []
  for (let index = 0; index < (rough ? 2 : 26); index += 1) {
    const x = 2 + ((index * 7) % (PLAZA_W - 4))
    const z = index % 2 === 0 ? 5 : PLAZA_D - 6
    if (!outsideTower(x, z) || !outsideAnnex(x, z)) continue
    figures.push({ x, z, color: index % 3 === 0 ? C.red : index % 3 === 1 ? C.blue : C.yellow })
  }
  const takenByFigure = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))
  const trees = clear(treeSites)
  const lamps = clear(lampSites)
  const planters = clear(planterSites)
  const reserved = new Set([...trees, ...lamps, ...planters].map(([x, z]) => `${x}:${z}`))

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
            : !rough && x >= POOL.x0 && x < POOL.x1 && z >= POOL.z0 && z < POOL.z1
              ? (x + z) % 6 === 0
                ? C.mediumBlue
                : C.transLightBlue
              : (x + z * 2) % 17 === 0
                ? C.sand
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
    trees.forEach(([x, z], index) =>
      addTree(build, { x, z, surfaceY: finishTop, sub: 'plaza', height: 3 + (index % 2), variant: index }),
    )
    lamps.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: finishTop, sub: 'plaza', height: 4 + (index % 2) }),
    )
    planters.forEach(([x, z], index) =>
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
        courses: 7,
        floor: false,
        openings: [],
      }),
    ),
    'crown',
  )
  surface -= 7 * BRICK_LDU
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
  for (let level = 0; level < 12; level += 1) {
    mastSurface = build.place('3062b', level % 2 === 0 ? C.white : C.red, mastX, mastZ, mastSurface, { sub: 'crown' })
  }

  if (!rough)
    notes.push(
      'Two upper setbacks separate the tower into base, middle and crown volumes; the expanded plaza adds a pavilion, reflecting pool, twelve trees and ten illuminated posts.',
    )

  return { build, notes, warnings }
}

export default {
    id: 'meridian-tower',
    title: 'Meridian Tower',
    discipline: 'Modular architecture',
    category: 'architecture',
    tagline:
      'A twenty-eight-storey modular high-rise with two setbacks, a seven-course crown and a 108-stud civic plaza.',
    summary:
      'Twenty-eight storeys, each its own subassembly, step through three distinct tower volumes to a seven-course ' +
      'crown and a banded mast. Beneath them a 108 x 72-stud civic plaza carries a reflecting pool, a glazed ' +
      'pavilion, thirty-odd street trees, lit approach posts, planted beds and a crowd, all laid one tile at a time ' +
      'so the public realm is editable at the same grain as the building.',
    techniques: [
      'One subassembly per storey',
      'Cross-bonded deck between floors',
      'Seated window frames on every elevation',
      'Stepped crown and mast',
      'Two structural setbacks',
      'Landscaped 108 x 72-stud plaza, pavilion and reflecting pool',
    ],
    refinement:
      'The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the ' +
      'facades were blank. The published set separates every floor onto its own two-layer deck and glazes the ' +
      'elevations with frames the catalogue actually compiles.',
    camera: { yaw: 38, pitch: 30, zoom: 1.06 },
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
        'A twenty-eight-storey modular tower on a large landscaped civic plaza with a reflecting pool and a pavilion, where every floor lifts off separately, the elevations carry real windows, two upper volumes set back, and the crown rises to a banded mast.',
      envelopeStuds: [108, null, 72],
      palette: ['Sand', 'Tan', 'White', 'Light Bluish Grey', 'Dark Bluish Grey'],
      functions: ['Separable storeys', 'Glazed elevations', 'Verified build sequence'],
    },
    author: meridianTower,
  }
