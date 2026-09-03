import { BRICK_LDU, Build, C, PLATE_LDU, STUD_LDU, addLamp, addPlanter, addTree, elementLibrary, planBrickField, planEnclosure, spec, studCentre } from './kit.mjs'

/**
 * A terrace of five modular shopfronts, the other shape a town block comes in.
 *
 * Same rule as the tower: every storey of every building is its own
 * subassembly, so the block comes apart building by building and floor by
 * floor rather than being one welded lump. The street itself is laid a tile at
 * a time — carriageway, kerb and pavement fall out of the tile colour rather
 * than being drawn on — which is what makes the ground plane editable at the
 * same grain as the buildings standing on it.
 */
function harbourStreet(rough) {
  const UNITS = rough ? 2 : 7
  const UNIT_W = rough ? 14 : 16
  const UNIT_GAP = rough ? 0 : 2
  const DEPTH = rough ? 12 : 16
  const COURSES = 5
  const STOREYS = rough ? 2 : 4
  const SITE_W = UNITS * UNIT_W + (UNITS - 1) * UNIT_GAP + (rough ? 6 : 10)
  const SITE_D = rough ? 34 : 50
  const ROW_Z = rough ? 16 : 26
  const unitX = (index) => (rough ? 3 : 5) + index * (UNIT_W + UNIT_GAP)

  const units = Array.from({ length: UNITS }, (_, index) => ({
    id: `unit_${index + 1}`,
    name: `Shopfront ${index + 1}`,
    accent: ['#d66b55', '#f7b04a', '#77b96a', '#83e7ee', '#d6a85d'][index % 5],
  }))

  const build = new Build({
    subassemblies: [
      { id: 'street', name: 'Street, kerb and pavement', accent: '#7f8c9b' },
      { id: 'landscape', name: 'Street trees, lamps and planted thresholds', accent: '#77b96a' },
      ...units,
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

  const windowWidths = [...new Set(elementLibrary('window').map((entry) => entry.widthStuds))].sort((a, b) => a - b)
  const bay = windowWidths.includes(2) ? 2 : (windowWidths[0] ?? 2)
  const shopfront = (lengthStuds, doorAt) => {
    const openings = []
    for (let at = 2; at + bay < lengthStuds; at += 4) {
      if (doorAt >= 0 && Math.abs(at - doorAt) < 5) continue
      openings.push({ atStud: at, widthStuds: bay, fromCourse: 1, toCourse: 2, element: 'window' })
    }
    // The frame has to fit the storey it is cut into: a door reaching past the
    // top course pokes through the deck above and the kernel counts that, twice,
    // as a collision and as a break in the build order.
    if (doorAt >= 0)
      openings.push({ atStud: doorAt, widthStuds: 4, fromCourse: 0, toCourse: COURSES - 1, element: 'door' })
    return openings
  }

  const groundLayers = rough ? 1 : 2
  absorb(
    planBrickField(
      spec({
        sub: 'street',
        origin: [0, 0, 0],
        color: C.darkBluishGrey,
        family: 'plate',
        widthStuds: SITE_W,
        footprintDepthStuds: SITE_D,
        layers: groundLayers,
      }),
    ),
    'street',
  )
  const groundSurface = -groundLayers * PLATE_LDU

  const onTerrace = (x, z) =>
    units.some((_unit, index) => x >= unitX(index) && x < unitX(index) + UNIT_W && z >= ROW_Z && z < ROW_Z + DEPTH)
  const treeSites = rough
    ? []
    : Array.from({ length: UNITS + 1 }, (_, index) => [4 + index * 18, 20]).filter(([x]) => x < SITE_W - 2)
  const lampSites = rough
    ? []
    : Array.from({ length: UNITS }, (_, index) => [13 + index * 18, 17]).filter(([x]) => x < SITE_W - 2)
  const planterSites = rough
    ? []
    : units.flatMap((_unit, index) => [
        [unitX(index) + 2, ROW_Z - 2],
        [unitX(index) + UNIT_W - 3, ROW_Z - 2],
      ])
  const figures = []
  for (let index = 0; index < (rough ? 2 : 18); index += 1) {
    const x = 1 + ((index * 5) % (SITE_W - 2))
    const z = index % 3 === 0 ? 12 : index % 3 === 1 ? 13 : ROW_Z + DEPTH + 1
    if (onTerrace(x, z) || z >= SITE_D - 1) continue
    figures.push({ x, z, color: [C.red, C.blue, C.yellow, C.green, C.white][index % 5] })
  }
  const figureTaken = new Set(figures.map((figure) => `${figure.x}:${figure.z}`))
  const taken = new Set(
    [...figures.map((figure) => [figure.x, figure.z]), ...treeSites, ...lampSites, ...planterSites].map(
      ([x, z]) => `${x}:${z}`,
    ),
  )

  // Inset by a stud: the base field fills its outer corners with round plates
  // whose studs a flat tile cannot sit down onto, and the exposed border reads
  // as the edge of the plate anyway.
  for (let x = 1; x < SITE_W - 1; x += 1) {
    for (let z = 1; z < SITE_D - 1; z += 1) {
      if (onTerrace(x, z) || figureTaken.has(`${x}:${z}`)) continue
      const carriageway = z < (rough ? 9 : 12)
      const kerb = z === (rough ? 9 : 12)
      build.place(
        taken.has(`${x}:${z}`) ? '3024' : '3070b',
        carriageway ? C.black : kerb ? C.white : C.lightBluishGrey,
        (x + 0.5) * STUD_LDU,
        (z + 0.5) * STUD_LDU,
        groundSurface,
        { sub: 'street' },
      )
    }
  }

  for (const figure of figures) {
    build.place('90398', figure.color, (figure.x + 0.5) * STUD_LDU, (figure.z + 0.5) * STUD_LDU, groundSurface, {
      sub: 'street',
    })
  }

  if (!rough) {
    const finishTop = groundSurface - PLATE_LDU
    treeSites.forEach(([x, z], index) =>
      addTree(build, { x, z, surfaceY: finishTop, sub: 'landscape', height: 3 + (index % 2), variant: index }),
    )
    lampSites.forEach(([x, z], index) =>
      addLamp(build, { x, z, surfaceY: finishTop, sub: 'landscape', height: 4 + (index % 2) }),
    )
    planterSites.forEach(([x, z], index) =>
      addPlanter(build, {
        x,
        z,
        surfaceY: finishTop,
        sub: 'landscape',
        variant: index,
        flower: index % 3 ? C.orange : C.yellow,
      }),
    )
  }

  const facades = [C.reddishBrown, C.sand, C.darkTan, C.white, C.tan]
  units.forEach((unit, index) => {
    const x = unitX(index)
    let surface = groundSurface
    for (let storey = 0; storey < STOREYS; storey += 1) {
      absorb(
        planEnclosure(
          spec({
            sub: unit.id,
            origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
            color: facades[index % facades.length],
            trimColor: C.white,
            glassColor: C.transLightBlue,
            family: 'brick',
            depthStuds: 1,
            widthStuds: UNIT_W,
            footprintDepthStuds: DEPTH,
            courses: COURSES,
            floor: false,
            openings: storey === 0 ? shopfront(UNIT_W, 5) : shopfront(UNIT_W, -1),
          }),
        ),
        unit.id,
      )
      surface -= COURSES * BRICK_LDU
      absorb(
        planBrickField(
          spec({
            sub: unit.id,
            origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
            color: C.lightBluishGrey,
            family: 'plate',
            widthStuds: UNIT_W,
            footprintDepthStuds: DEPTH,
            layers: 2,
          }),
        ),
        unit.id,
      )
      surface -= 2 * PLATE_LDU
    }
    // Seven identical flat roofs is what made this street read as a texture
    // rather than as seven buildings. Each address now takes one of three
    // rooflines, and the pitched ones are laid as stepped courses of brick
    // bands — hollow, so a gable costs a few hundred parts rather than a few
    // thousand, and each band rests on the one below it.
    const roofline = index % 3
    if (roofline === 0) {
      const roofColour = index % 2 === 0 ? C.darkRed : C.reddishBrown
      const pitchCourses = Math.floor(DEPTH / 2) - 1
      for (let course = 0; course < pitchCourses; course += 1) {
        const bandDepth = 2
        const near = ROW_Z + course
        const far = ROW_Z + DEPTH - course - bandDepth
        const bands = course === pitchCourses - 1 ? [near] : [near, far]
        const depthStuds = course === pitchCourses - 1 ? DEPTH - 2 * course : bandDepth
        for (const bandZ of bands) {
          absorb(
            planBrickField(
              spec({
                sub: unit.id,
                origin: [x * STUD_LDU, surface - course * BRICK_LDU, bandZ * STUD_LDU],
                color: roofColour,
                family: 'brick',
                widthStuds: UNIT_W,
                footprintDepthStuds: depthStuds,
                layers: 1,
              }),
            ),
            unit.id,
          )
        }
      }
      if (!rough) {
        // A chimney stack at one gable end, and a ridge vent at the other.
        const ridgeTop = surface - pitchCourses * BRICK_LDU
        // A 2 x 2 spans an even number of studs on both axes, so it centres on
        // a multiple of 20 — not on `studCentre`, which is for odd spans.
        const stackZ = ROW_Z + Math.floor(DEPTH / 2) - 1
        let stack = ridgeTop
        for (let course = 0; course < 3; course += 1) {
          stack = build.place('3003', C.reddishBrown, (x + 3) * STUD_LDU, (stackZ + 1) * STUD_LDU, stack, {
            sub: unit.id,
            label: `${unit.id} chimney ${course}`,
          })
        }
        build.place('3062b', C.darkBluishGrey, studCentre(x + 2), studCentre(stackZ), stack, { sub: unit.id })
      }
      return
    }

    // A parapet, so the roofline is a roofline and not a cut.
    absorb(
      planEnclosure(
        spec({
          sub: unit.id,
          origin: [x * STUD_LDU, surface, ROW_Z * STUD_LDU],
          color: C.darkBluishGrey,
          family: 'brick',
          depthStuds: 1,
          widthStuds: UNIT_W,
          footprintDepthStuds: DEPTH,
          courses: roofline === 1 ? 2 : 1,
          floor: false,
          openings: [],
        }),
      ),
      unit.id,
    )
    if (roofline === 1) {
      // A stepped parapet: corner piers standing proud of the run between them.
      const parapetTop = surface - 2 * BRICK_LDU
      for (const pierX of [x, x + UNIT_W - 2]) {
        absorb(
          planBrickField(
            spec({
              sub: unit.id,
              origin: [pierX * STUD_LDU, parapetTop, ROW_Z * STUD_LDU],
              color: index % 2 === 0 ? C.sand : C.white,
              family: 'brick',
              widthStuds: 2,
              footprintDepthStuds: 2,
              layers: 2,
            }),
          ),
          unit.id,
        )
      }
    }
    if (!rough) {
      const roofRoomW = 6
      const roofRoomD = 6
      const roofRoomX = x + (index % 2 === 0 ? 2 : UNIT_W - roofRoomW - 2)
      const roofRoomZ = ROW_Z + Math.floor((DEPTH - roofRoomD) / 2)
      absorb(
        planEnclosure(
          spec({
            sub: unit.id,
            origin: [roofRoomX * STUD_LDU, surface, roofRoomZ * STUD_LDU],
            color: index % 2 === 0 ? C.darkTan : C.lightBluishGrey,
            trimColor: C.white,
            glassColor: C.transLightBlue,
            family: 'brick',
            depthStuds: 1,
            widthStuds: roofRoomW,
            footprintDepthStuds: roofRoomD,
            courses: 2,
            floor: false,
            openings: [{ atStud: 2, widthStuds: 2, fromCourse: 0, toCourse: 1, element: 'window' }],
          }),
        ),
        unit.id,
      )
      const roofRoomTop = surface - 2 * BRICK_LDU
      absorb(
        planBrickField(
          spec({
            sub: unit.id,
            origin: [roofRoomX * STUD_LDU, roofRoomTop, roofRoomZ * STUD_LDU],
            color: index % 3 === 0 ? C.darkGreen : C.darkBluishGrey,
            family: 'plate',
            widthStuds: roofRoomW,
            footprintDepthStuds: roofRoomD,
            layers: 2,
          }),
        ),
        unit.id,
      )
    }
  })

  if (!rough)
    notes.push(
      'Seven separated addresses now sit between real two-stud alleys, with eight street trees, seven illuminated posts, fourteen planted thresholds and individually detailed roof rooms.',
    )

  return { build, notes, warnings }
}

export default {
    id: 'harbour-street',
    title: 'Harbour Street',
    discipline: 'Modular architecture',
    category: 'architecture',
    tagline:
      'Seven four-storey shopfronts under three different rooflines — pitched gables with chimneys, stepped parapets and flat roofs with roof rooms.',
    summary:
      'Seven four-storey shopfronts on a full street district. Every address lifts out, every floor lifts off, and ' +
      'the public realm is built at the same editable grain. Each address takes one of three rooflines — a pitched ' +
      'gable laid as hollow stepped brick bands with a chimney stack, a stepped parapet on corner piers, or a flat ' +
      'roof with its own glazed roof room — so the terrace reads as seven buildings rather than one long shell.',
    techniques: [
      'One subassembly per storey, per unit',
      'Tiled carriageway, kerb and pavement',
      'Seated shopfront doors and glazing',
      'Three rooflines: pitched, stepped parapet, flat',
      'Hollow stepped gables with chimney stacks',
      'Two-stud alleys and individual roof rooms',
      'Street trees, lamps and planted thresholds',
    ],
    refinement:
      'The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came ' +
      'apart and the street was a texture. The published set separates every unit and every floor, and lays the ' +
      'road surface as individual tiles.',
    camera: { yaw: 34, pitch: 28, zoom: 1.08 },
    maxPartsPerStep: 72,
    tensionAllowance: 480,
    tensionReason:
      'Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter ' +
      'rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is ' +
      'bounded so a genuinely unsupported storey still fails.',
    hero: false,
    brief: {
      prompt:
        'A street of seven four-storey modular shops with flats above, separate alleys, three different rooflines with chimneys and roof rooms, trees, lights and planted thresholds, where every building and every floor can be lifted off separately.',
      envelopeStuds: [134, null, 50],
      palette: ['Reddish Brown', 'Sand', 'Dark Tan', 'White', 'Tan'],
      functions: ['Separable units and storeys', 'Glazed shopfronts', 'Verified build sequence'],
    },
    author: harbourStreet,
  }
