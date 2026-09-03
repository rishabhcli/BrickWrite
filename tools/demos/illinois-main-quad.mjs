import { BRICK_LDU, Build, C, PLATE_LDU, STUD_LDU, addLamp, addPlanter, addTree, planBrickField, planEnclosure, spec } from './kit.mjs'

/**
 * A display-scale interpretation of the University of Illinois Main Quad.
 *
 * This is intentionally not a single facade enlarged until the piece counter
 * looks impressive. The 120 x 80-stud site is a real three-layer landscape:
 * a cross-bonded structural slab, then 9,600 individually placeable finish
 * pieces describing lawn, paths, roads, plots and building pads. Seven named
 * buildings, the Alma Mater group, Morrow Plots, mature trees and brick-built
 * students sit on that common foundation. Every last piece is still an ordinary
 * catalog-backed PartInstance and therefore still goes through collision,
 * connection, instructions and statics with the rest of the collection.
 */
function illinoisMainQuad(rough) {
  const build = new Build({
    subassemblies: [
      { id: 'site', name: 'Campus base and quad', accent: '#83e7ee' },
      { id: 'finish', name: 'Paths, lawns and building pads', accent: '#8bcf65' },
      { id: 'union', name: 'Illini Union', accent: '#f7b04a' },
      { id: 'foellinger', name: 'Foellinger Auditorium', accent: '#77b96a' },
      { id: 'altgeld', name: 'Altgeld Hall and Alma Mater', accent: '#d66b55' },
      { id: 'west_halls', name: 'West Quad halls', accent: '#d6a85d' },
      { id: 'east_halls', name: 'East Quad halls', accent: '#d98662' },
      { id: 'morrow', name: 'Morrow Plots', accent: '#8bcf65' },
      { id: 'landscape', name: 'Trees and campus furniture', accent: '#5da765' },
      { id: 'people', name: 'Students and visitors', accent: '#f5a33f' },
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

  const width = rough ? 120 : 128
  const depth = rough ? 80 : 88
  const baseLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'site',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers: baseLayers,
      }),
    ),
    'site',
  )
  const baseSurface = -baseLayers * PLATE_LDU

  // The first candidate is a genuine massing study on a one-layer site. The
  // large sheets touch but do not clutch, and the four block models only bind
  // the plates directly underneath them. The published pass resolves that
  // measurable failure with the cross-bonded base and the full campus above.
  if (rough) {
    const mass = (sub, x, z, w, d, courses, color) => {
      absorb(
        planEnclosure(
          spec({
            sub,
            origin: [x * STUD_LDU, baseSurface, z * STUD_LDU],
            color,
            family: 'brick',
            depthStuds: 1,
            widthStuds: w,
            footprintDepthStuds: d,
            courses,
            floor: false,
          }),
        ),
        sub,
      )
    }
    mass('union', 44, 2, 32, 12, 2, C.reddishBrown)
    mass('foellinger', 44, 66, 32, 12, 3, C.reddishBrown)
    mass('west_halls', 6, 20, 21, 43, 2, C.darkTan)
    mass('east_halls', 93, 20, 21, 43, 2, C.darkTan)
    return {
      build,
      notes: [
        'A one-layer site and four block models established the axial campus plan, but the slab remained a field of disconnected strips.',
      ],
      warnings,
    }
  }

  const BUILDING_ZONES = [
    { x0: 44, x1: 76, z0: 2, z1: 14 },
    { x0: 44, x1: 76, z0: 66, z1: 78 },
    { x0: 5, x1: 30, z0: 2, z1: 15 },
    { x0: 5, x1: 27, z0: 18, z1: 35 },
    { x0: 5, x1: 27, z0: 45, z1: 63 },
    { x0: 93, x1: 115, z0: 18, z1: 35 },
    { x0: 93, x1: 115, z0: 45, z1: 63 },
    { x0: 117, x1: 127, z0: 18, z1: 36 },
    { x0: 46, x1: 74, z0: 80, z1: 87 },
  ]
  const TREE_SITES = [
    [29, 20],
    [29, 31],
    [29, 49],
    [29, 60],
    [90, 20],
    [90, 31],
    [90, 49],
    [90, 60],
    [35, 15],
    [84, 15],
    [35, 64],
    [84, 64],
    [33, 22],
    [86, 22],
    [33, 57],
    [86, 57],
    [119, 8],
    [123, 14],
    [120, 42],
    [124, 52],
    [119, 68],
    [123, 78],
    [8, 83],
    [22, 82],
    [35, 84],
    [85, 84],
    [101, 82],
    [116, 84],
  ]
  const LAMP_SITES = [
    [38, 18],
    [46, 18],
    [74, 18],
    [82, 18],
    [38, 62],
    [46, 62],
    [74, 62],
    [82, 62],
    [59, 18],
    [61, 18],
    [59, 62],
    [61, 62],
    [118, 40],
    [118, 58],
    [40, 83],
    [80, 83],
  ]
  const PLANTER_SITES = [
    [41, 16],
    [78, 16],
    [41, 64],
    [78, 64],
    [91, 67],
    [115, 67],
  ]
  // x and z are the stud cells carrying the campus figures.
  const FIGURE_SITES = [
    [39, 25],
    [43, 33],
    [48, 52],
    [53, 20],
    [55, 58],
    [58, 29],
    [62, 51],
    [65, 22],
    [69, 57],
    [73, 34],
    [78, 49],
    [82, 27],
    [34, 41],
    [47, 39],
    [73, 40],
    [86, 43],
    [58, 10],
    [63, 69],
  ]
  const forcedStuds = new Set([
    ...TREE_SITES.map(([x, z]) => `${x}:${z}`),
    ...LAMP_SITES.map(([x, z]) => `${x}:${z}`),
    ...PLANTER_SITES.map(([x, z]) => `${x}:${z}`),
    ...FIGURE_SITES.map(([x, z]) => `${x}:${z}`),
    ...[49, 53, 57, 62, 66, 70].flatMap((x) => [`${x}:14`, `${x}:65`]),
  ])
  const inBuilding = (x, z) => BUILDING_ZONES.some((zone) => x >= zone.x0 && x < zone.x1 && z >= zone.z0 && z < zone.z1)
  const inMorrow = (x, z) => x >= 92 && x < 114 && z >= 68 && z < 78
  const inQuad = (x, z) => x >= 31 && x < 89 && z >= 14 && z < 66
  const onQuadPath = (x, z) => {
    if (!inQuad(x, z)) return false
    if (Math.abs(x - 60) <= 1 || Math.abs(z - 40) <= 1) return true
    if (x <= 60 && z <= 40 && Math.abs(z - 40 - 0.82 * (x - 60)) <= 0.85) return true
    if (x >= 60 && z <= 40 && Math.abs(z - 40 + 0.82 * (x - 60)) <= 0.85) return true
    if (x <= 60 && z >= 40 && Math.abs(z - 40 + 0.82 * (x - 60)) <= 0.85) return true
    if (x >= 60 && z >= 40 && Math.abs(z - 40 - 0.82 * (x - 60)) <= 0.85) return true
    return x <= 32 || x >= 87 || z <= 15 || z >= 64
  }

  // One finish piece per stud is what gives this scale model a readable site
  // plan instead of a green rectangle. Smooth tiles carry every path and road;
  // studded plates remain wherever architecture, vegetation or people attach.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const forced = forcedStuds.has(`${x}:${z}`)
      const building = inBuilding(x, z)
      const road = z < 2 || x < 2 || x >= width - 2
      const plot = inMorrow(x, z)
      const path = !building && (onQuadPath(x, z) || (z >= 7 && z <= 9) || (x >= 59 && x <= 61))
      const tiled = !forced && !building && (road || path)
      const color = road
        ? C.darkBluishGrey
        : path
          ? C.lightBluishGrey
          : plot
            ? (x + z) % 3 === 0
              ? C.reddishBrown
              : C.green
            : building
              ? C.darkTan
              : C.green
      build.place(tiled ? '3070b' : '3024', color, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, baseSurface, {
        sub: 'finish',
        label: `campus finish ${x},${z}`,
      })
    }
  }
  const campusSurface = baseSurface - PLATE_LDU

  const addBuilding = ({ sub, x, z, w, d, courses, color, roofColor, openings = [], parapet = true, pitch = false }) => {
    absorb(
      planEnclosure(
        spec({
          sub,
          origin: [x * STUD_LDU, campusSurface, z * STUD_LDU],
          color,
          trimColor: C.white,
          glassColor: C.transLightBlue,
          family: 'brick',
          depthStuds: 1,
          widthStuds: w,
          footprintDepthStuds: d,
          courses,
          floor: false,
          openings,
        }),
      ),
      sub,
    )
    const roofSurface = campusSurface - courses * BRICK_LDU
    if (pitch) {
      // A gable, laid as hollow stepped brick bands narrowing towards the
      // ridge. Hollow because a solid stepped pyramid over a 20-stud hall is
      // several thousand bricks nobody will ever see the inside of; each band
      // overlaps the one below it, and the first sits on the wall head.
      const band = (course, bandZ, bandDepth) =>
        absorb(
          planBrickField(
            spec({
              sub,
              origin: [x * STUD_LDU, roofSurface - course * BRICK_LDU, bandZ * STUD_LDU],
              color: roofColor,
              family: 'brick',
              widthStuds: w,
              footprintDepthStuds: bandDepth,
              layers: 1,
            }),
          ),
          sub,
        )
      // Climb in two-stud bands until four studs or fewer are left, then cap.
      // The cap has to be four deep at most: `layField` tiles a band in rows two
      // studs deep, and a wider cap grows a middle row that overlaps neither
      // eave below it — a course of loose bricks the connectivity gate rejects.
      let course = 0
      while (d - 2 * course > 4) {
        band(course, z + course, 2)
        band(course, z + d - course - 2, 2)
        course += 1
      }
      band(course, z + course, Math.max(1, d - 2 * course))
      return { roofTop: roofSurface - (course + 1) * BRICK_LDU }
    }
    absorb(
      planBrickField(
        spec({
          sub,
          origin: [x * STUD_LDU, roofSurface, z * STUD_LDU],
          color: roofColor,
          family: 'plate',
          widthStuds: w,
          footprintDepthStuds: d,
          layers: 2,
        }),
      ),
      sub,
    )
    const roofTop = roofSurface - 2 * PLATE_LDU
    if (parapet) {
      absorb(
        planEnclosure(
          spec({
            sub,
            origin: [x * STUD_LDU, roofTop, z * STUD_LDU],
            color: C.darkTan,
            family: 'brick',
            depthStuds: 1,
            widthStuds: w,
            footprintDepthStuds: d,
            courses: 1,
            floor: false,
          }),
        ),
        sub,
      )
    }
    return { roofTop }
  }
  const windows = (widthStuds, doorAt) => {
    const result = []
    for (let at = 3; at + 2 < widthStuds; at += 5) {
      if (Math.abs(at - doorAt) < 4) continue
      result.push({ atStud: at, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' })
    }
    if (doorAt >= 0) result.push({ atStud: doorAt, widthStuds: 4, fromCourse: 0, toCourse: 5, element: 'door' })
    return result
  }

  const union = addBuilding({
    sub: 'union',
    x: 44,
    z: 2,
    w: 32,
    d: 12,
    courses: 8,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(32, 14),
    parapet: false,
  })
  const foellinger = addBuilding({
    sub: 'foellinger',
    x: 44,
    z: 66,
    w: 32,
    d: 12,
    courses: 9,
    color: C.reddishBrown,
    roofColor: C.darkBluishGrey,
    openings: windows(32, 14),
    parapet: false,
  })
  const altgeld = addBuilding({
    sub: 'altgeld',
    x: 5,
    z: 2,
    w: 24,
    d: 13,
    courses: 8,
    color: C.darkRed,
    roofColor: C.darkRed,
    pitch: true,
    openings: windows(24, 10),
    parapet: false,
  })
  addBuilding({
    sub: 'west_halls',
    x: 5,
    z: 18,
    w: 22,
    d: 17,
    courses: 8,
    color: C.darkTan,
    roofColor: C.reddishBrown,
    pitch: true,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'west_halls',
    x: 5,
    z: 45,
    w: 22,
    d: 18,
    courses: 8,
    color: C.reddishBrown,
    roofColor: C.brown,
    pitch: true,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 93,
    z: 18,
    w: 22,
    d: 17,
    courses: 8,
    color: C.reddishBrown,
    roofColor: C.darkRed,
    pitch: true,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 93,
    z: 45,
    w: 22,
    d: 18,
    courses: 8,
    color: C.darkTan,
    roofColor: C.reddishBrown,
    pitch: true,
    openings: windows(22, 9),
  })
  addBuilding({
    sub: 'east_halls',
    x: 117,
    z: 18,
    w: 10,
    d: 18,
    courses: 7,
    color: C.darkRed,
    roofColor: C.brown,
    pitch: true,
    openings: windows(10, 3),
  })
  addBuilding({
    sub: 'foellinger',
    x: 46,
    z: 80,
    w: 28,
    d: 7,
    courses: 3,
    color: C.sand,
    roofColor: C.darkGreen,
    openings: windows(28, -1),
    parapet: false,
  })

  const stackColumn = (sub, xStud, zStud, courses, color = C.white) => {
    let surface = campusSurface
    for (let course = 0; course < courses; course += 1) {
      surface = build.place('3062b', color, xStud * STUD_LDU, zStud * STUD_LDU, surface, { sub })
    }
    return surface
  }
  // Colonnades face the Quad: south on the Union, north on Foellinger.
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('union', x, 14.5, 6)
  for (const x of [49.5, 53.5, 57.5, 62.5, 66.5, 70.5]) stackColumn('foellinger', x, 65.5, 7)

  // Foellinger's copper dome: six bonded plate lifts narrow into two real
  // compiled cone elements, so the south-end silhouette remains unmistakable.
  let domeSurface = foellinger.roofTop
  for (const [w, d] of [
    [10, 8],
    [8, 6],
    [6, 4],
  ]) {
    absorb(
      planBrickField(
        spec({
          sub: 'foellinger',
          origin: [(60 - w / 2) * STUD_LDU, domeSurface, (72 - d / 2) * STUD_LDU],
          color: C.darkGreen,
          family: 'plate',
          widthStuds: w,
          footprintDepthStuds: d,
          layers: 2,
        }),
      ),
      'foellinger',
    )
    domeSurface -= 2 * PLATE_LDU
  }
  domeSurface = build.place('3943b', C.darkGreen, 60 * STUD_LDU, 72 * STUD_LDU, domeSurface, { sub: 'foellinger' })
  build.place('3942c', C.darkGreen, 60 * STUD_LDU, 72 * STUD_LDU, domeSurface, { sub: 'foellinger', offGrid: true })

  // The Union cupola and Altgeld bell tower make the north edge read as a
  // campus, not as a row of anonymous boxes.
  absorb(
    planEnclosure(
      spec({
        sub: 'union',
        origin: [57 * STUD_LDU, union.roofTop, 5 * STUD_LDU],
        color: C.white,
        family: 'brick',
        depthStuds: 1,
        widthStuds: 6,
        footprintDepthStuds: 6,
        courses: 2,
        floor: false,
      }),
    ),
    'union',
  )
  let cupolaSurface = union.roofTop - 2 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'union',
        origin: [57 * STUD_LDU, cupolaSurface, 5 * STUD_LDU],
        color: C.darkGreen,
        family: 'plate',
        widthStuds: 6,
        footprintDepthStuds: 6,
        layers: 2,
      }),
    ),
    'union',
  )
  cupolaSurface -= 2 * PLATE_LDU
  build.place('3943b', C.darkGreen, 60 * STUD_LDU, 8 * STUD_LDU, cupolaSurface, { sub: 'union' })

  absorb(
    planEnclosure(
      spec({
        sub: 'altgeld',
        origin: [7 * STUD_LDU, altgeld.roofTop, 3 * STUD_LDU],
        color: C.darkRed,
        family: 'brick',
        depthStuds: 1,
        widthStuds: 6,
        footprintDepthStuds: 6,
        courses: 4,
        floor: false,
      }),
    ),
    'altgeld',
  )
  let towerSurface = altgeld.roofTop - 4 * BRICK_LDU
  absorb(
    planBrickField(
      spec({
        sub: 'altgeld',
        origin: [7 * STUD_LDU, towerSurface, 3 * STUD_LDU],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: 6,
        footprintDepthStuds: 6,
        layers: 2,
      }),
    ),
    'altgeld',
  )
  towerSurface -= 2 * PLATE_LDU
  build.place('3943b', C.darkGreen, 10 * STUD_LDU, 6 * STUD_LDU, towerSurface, { sub: 'altgeld' })

  // Alma Mater, Learning and Labor: three bronze statuette elements on a
  // stone plinth. The element is a catalog-backed minifigure silhouette, not a
  // painted cuboid, and each figure is separately selectable in the editor.
  let almaSurface = campusSurface
  almaSurface = build.place('3031', C.lightBluishGrey, 36 * STUD_LDU, 12 * STUD_LDU, almaSurface, { sub: 'altgeld' })
  almaSurface = build.place('3001', C.darkBluishGrey, 36 * STUD_LDU, 12 * STUD_LDU, almaSurface, { sub: 'altgeld' })
  for (const x of [34.5, 35.5, 36.5]) {
    const seat = build.place('3024', C.lightBluishGrey, x * STUD_LDU, 12.5 * STUD_LDU, almaSurface, { sub: 'altgeld' })
    build.place('90398', 80, x * STUD_LDU, 12.5 * STUD_LDU, seat, { sub: 'altgeld', offGrid: true })
  }

  // Morrow Plots, protected by their characteristic low perimeter fence.
  for (const z of [68.5, 77.5]) {
    for (const x of [94, 98, 102, 106, 110])
      build.place('3633', C.white, x * STUD_LDU, z * STUD_LDU, campusSurface, { sub: 'morrow' })
  }
  for (const x of [92.5, 113.5]) {
    for (const z of [71, 75])
      build.place('3633', C.white, x * STUD_LDU, z * STUD_LDU, campusSurface, { sub: 'morrow', rotY: 90 })
  }
  for (let z = 70; z <= 76; z += 2) {
    for (let x = 94; x <= 112; x += 3) {
      const cropSurface = build.place('3062b', C.green, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, campusSurface, {
        sub: 'morrow',
      })
      build.place('32607', (x + z) % 2 ? C.yellow : C.orange, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, cropSurface, {
        sub: 'morrow',
      })
    }
  }

  TREE_SITES.forEach(([x, z], index) =>
    addTree(build, { x, z, surfaceY: campusSurface, sub: 'landscape', height: 3 + (index % 2), variant: index }),
  )
  LAMP_SITES.forEach(([x, z], index) =>
    addLamp(build, { x, z, surfaceY: campusSurface, sub: 'landscape', height: 4 + (index % 2) }),
  )
  PLANTER_SITES.forEach(([x, z], index) =>
    addPlanter(build, { x, z, surfaceY: campusSurface, sub: 'landscape', variant: index }),
  )

  const figureColors = [C.orange, C.blue, C.white, C.mediumBlue, C.green, C.darkBluishGrey]
  for (const [index, [x, z]] of FIGURE_SITES.entries()) {
    const worldX = (x + 0.5) * STUD_LDU
    const worldZ = (z + 0.5) * STUD_LDU
    build.place('90398', figureColors[index % figureColors.length], worldX, worldZ, campusSurface, { sub: 'people' })
  }

  notes.push(
    'The site follows the Main Quad axis: Illini Union at the north, Foellinger Auditorium at the south, academic halls on both flanks, Altgeld and Alma Mater at the northwest, and Morrow Plots at the southeast.',
    'Eighteen campus figures and the three-figure Alma Mater group are ordinary selectable parts in the same document as the architecture.',
    'The expanded east and south precincts add a visitor hall, garden pavilion, twelve additional mature trees, sixteen illuminated path posts and planted gateways.',
  )
  return { build, notes, warnings }
}

export default {
    id: 'illinois-main-quad',
    title: 'Illinois Main Quad campus',
    discipline: 'Campus architecture',
    category: 'architecture',
    tagline:
      'A 128 × 88-stud university campus with nine landmark structures, a tiled quad, mature trees, path lights and 21 LEGO characters.',
    summary:
      'A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, ' +
      'Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and ' +
      'brick-built students, an east visitor hall and a south garden pavilion. Six of the halls carry pitched gable ' +
      'roofs laid as hollow stepped brick bands in three tile colours, so the campus reads as buildings rather than ' +
      'as a site plan. The site finish alone is 11,264 individually editable pieces over a cross-bonded base.',
    techniques: [
      '10,000+ catalog-backed pieces',
      'Cross-bonded 128 × 88-stud foundation',
      'Nine landmark structures',
      'Pitched gable roofs on six academic halls',
      'Stepped copper dome, cupola and bell tower',
      '18 campus figures',
      'Three-figure Alma Mater group',
      'Twenty-eight mature trees and sixteen path lights',
    ],
    refinement:
      'The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. ' +
      'The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings ' +
      'under pitched roofs, and adds the 11,264-piece landscape, characters and buildable campus life.',
    camera: { yaw: 34, pitch: 54, zoom: 1.02 },
    showcase: { landmarkCount: 9, characterCount: 21, siteFinishParts: 11_264 },
    showcaseProof: { characterDefinitionIds: ['90398'], siteFinishSubassemblyId: 'finish' },
    maxPartsPerStep: 64,
    tensionAllowance: 256,
    tensionReason:
      'Window panes are seated inside their frames rather than carried in vertical compression. The statics pass ' +
      'counts those glazed inserts as tension-carried, measures their mass, and still checks every attachment group ' +
      'against the conservative clutch assumption.',
    hero: true,
    brief: {
      prompt:
        'Build a display-scale replica of the University of Illinois Main Quad with the Union and Foellinger on axis, Altgeld and Alma Mater, pitched-roof academic halls, Morrow Plots, trees, paths, and enough students to make it feel alive. It must exceed ten thousand real pieces and still pass the physical kernel.',
      envelopeStuds: [128, null, 88],
      palette: ['Illinois orange and blue', 'Campus red brick', 'Copper green', 'Quad green', 'Limestone white'],
      functions: [
        '10,000+ editable pieces',
        'Recognisable campus landmarks',
        'LEGO characters',
        'Verified build sequence',
      ],
    },
    author: illinoisMainQuad,
  }
