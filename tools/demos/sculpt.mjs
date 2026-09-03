/**
 * Shared sculpture authoring for the large animal and public-art builds.
 *
 * See `voxelSculpture` for the modern path: a genuine 3D occupancy function
 * compiled into bonded, supported bricks. `largeSculpture` is the older
 * height-map driver kept for builds that are honestly 2.5D.
 */
import {
  BRICK_LDU,
  Build,
  C,
  PLATE_LDU,
  STUD_LDU,
  addLamp,
  addPlanter,
  addTree,
  planBrickField,
  spec,
} from './kit.mjs'

/**
 * A shared compiler for the collection's large brick-built sculptures.
 *
 * The figure is not a mesh or an image pasted onto a base. Every cell is a
 * catalog-backed 1 x 1 plate, and every occupied cell grows into a real stack
 * of 1 x 1 bricks. That gives the animals enough resolution to read from a
 * distance while keeping every piece editable, selectable and attached to the
 * same cross-bonded plinth. The rough pass deliberately uses a one-layer
 * foundation: its parallel plate runs look plausible but remain disconnected,
 * which the published cross-bond fixes measurably.
 */
export function largeSculpture(rough, design) {
  const width = rough ? design.roughWidth : design.width
  const depth = rough ? design.roughDepth : design.depth
  const layers = rough ? 1 : 2
  const build = new Build({
    subassemblies: [
      { id: 'foundation', name: 'Cross-bonded display plinth', accent: '#7f8c9b' },
      { id: 'field', name: design.fieldName, accent: design.fieldAccent },
      { id: 'scene', name: design.sceneName ?? 'Landscape, lighting and visitor details', accent: '#f7b04a' },
      { id: 'body', name: design.bodyName, accent: design.bodyAccent },
      { id: 'accent', name: design.accentName, accent: design.accentColor },
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

  absorb(
    planBrickField(
      spec({
        sub: 'foundation',
        origin: [0, 0, 0],
        color: design.plinthColor,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers,
      }),
    ),
    'foundation',
  )
  const foundationTop = -layers * PLATE_LDU
  let occupied = 0
  let sculptureParts = 0
  const occupiedCells = new Set()

  // A one-piece-per-stud finish is deliberate. It is the large build's editable
  // scene rather than a painted rectangle, and it gives every sculpted column a
  // known catalog-backed seat.
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const finish = design.fieldColor(x, z, width, depth)
      let surface = build.place('3024', finish, (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, foundationTop, {
        sub: 'field',
        label: `${design.id} field ${x},${z}`,
      })
      const column = design.column(x, z, width, depth, rough)
      if (!column || column.height < 1) continue
      occupied += 1
      occupiedCells.add(`${x}:${z}`)
      for (let level = 0; level < column.height; level += 1) {
        const accent = column.accentFrom !== undefined && level >= column.accentFrom
        surface = build.place(
          '3005',
          accent ? column.accentColor : column.color,
          (x + 0.5) * STUD_LDU,
          (z + 0.5) * STUD_LDU,
          surface,
          {
            sub: accent ? 'accent' : 'body',
            label: `${design.id} voxel ${x},${z},${level}`,
          },
        )
        sculptureParts += 1
      }
    }
  }

  if (!rough) {
    const fieldTop = foundationTop - PLATE_LDU
    for (const [index, [x, z, height]] of (design.trees ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addTree(build, { x, z, surfaceY: fieldTop, sub: 'scene', height, variant: index })
    }
    for (const [x, z, height] of design.lights ?? []) {
      if (!occupiedCells.has(`${x}:${z}`)) addLamp(build, { x, z, surfaceY: fieldTop, sub: 'scene', height })
    }
    for (const [index, [x, z]] of (design.planters ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addPlanter(build, {
          x,
          z,
          surfaceY: fieldTop,
          sub: 'scene',
          variant: index,
          flower: index % 2 ? C.yellow : C.orange,
        })
    }
    notes.push(
      `${(design.trees ?? []).length} trees, ${(design.lights ?? []).length} illuminated posts and ` +
        `${(design.planters ?? []).length} planted edge details turn the plinth into a complete public setting.`,
    )
  }

  notes.push(
    `${design.title} occupies ${occupied.toLocaleString()} stud columns and ${sculptureParts.toLocaleString()} stacked body bricks on a ${width} x ${depth}-stud scene.`,
  )
  if (!rough) notes.push('The two-layer foundation cross-bonds every row into one editable, stable model.')
  return { build, notes, warnings }
}

export const ellipse = (x, z, cx, cz, rx, rz) => {
  const dx = (x - cx) / rx
  const dz = (z - cz) / rz
  return dx * dx + dz * dz
}

// ---------------------------------------------------------------------------
// 3D voxel sculpture
// ---------------------------------------------------------------------------

/**
 * The brick footprints the sculpture tiler may use, widest first.
 *
 * All of these are one brick tall, so a course has a single top surface and the
 * next course can be laid against it without measuring anything. `[w, d, id]`
 * is the extent along x and z at `rotY: 0`; the tiler also tries each one
 * turned a quarter, which is what lets a course run long in either direction.
 */
const SCULPT_BRICKS = [
  [8, 2, '3007'],
  [6, 2, '2456'],
  [8, 1, '3008'],
  [4, 2, '3001'],
  [6, 1, '3009'],
  [3, 2, '3002'],
  [4, 1, '3010'],
  [2, 2, '3003'],
  [3, 1, '3622'],
  [2, 1, '3004'],
  [1, 1, '3005'],
]

/** Every orientation of every footprint, deduplicated, widest first. */
const SCULPT_FOOTPRINTS = (() => {
  const seen = new Set()
  const all = []
  for (const [w, d, id] of SCULPT_BRICKS) {
    for (const [width, depth, rotY] of [
      [w, d, 0],
      [d, w, 90],
    ]) {
      const key = `${width}x${depth}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push({ width, depth, rotY, id })
    }
  }
  return all.sort((a, b) => b.width * b.depth - a.width * a.depth || b.width - a.width)
})()

/**
 * Lays one course of a voxel solid as bonded brickwork.
 *
 * Two rules make the result a model rather than a pile. A brick may only cover
 * cells of one colour that the course below actually carries somewhere, so the
 * load path reaches every piece and an overhang has to be earned. And the scan
 * alternates its long axis and its start corner with the course number, so the
 * seams of one course fall across the seams of the last instead of stacking
 * into a crack running the height of the sculpture.
 *
 * A cell no footprint can reach is dropped and counted. That is deliberate: the
 * alternative is a floating brick, and the statics gate would reject the whole
 * demo for it — correctly.
 */
function layCourse(build, { cells, carried, course, surfaceY, sub, accentSub, label }) {
  const covered = new Set()
  const placed = new Set()
  const longAxisX = course % 2 === 0
  // Footprints only ever grow towards +x and +z from the cell that anchors
  // them, so the scan has to run the same way. Reversing it would leave every
  // anchor facing into ground it had already covered, and the only footprint
  // that ever fits is 1 x 1 — a course of loose columns wearing the shape of a
  // wall. The bond is staggered by the two knobs below instead.
  const keys = [...cells.keys()].sort((a, b) => {
    const [ax, az] = a.split(':').map(Number)
    const [bx, bz] = b.split(':').map(Number)
    const primary = longAxisX ? az - bz : ax - bx
    const secondary = longAxisX ? ax - bx : az - bz
    return primary || secondary
  })
  // Successive courses run their long bricks across each other, and every
  // other pair shortens the maximum run, so four courses pass before a seam
  // pattern can repeat.
  const maxRun = course % 4 >= 2 ? 6 : 8

  let dropped = 0
  for (const key of keys) {
    if (covered.has(key)) continue
    const [x, z] = key.split(':').map(Number)
    const cell = cells.get(key)
    // Cells are matched by what they *are*, not by object identity: two cells
    // of the same colour and role are one region and may share a brick.
    const alike = (other) => other !== undefined && other.color === cell.color && other.accent === cell.accent
    const fits = (footprint) => {
      let reaches = false
      for (let dx = 0; dx < footprint.width; dx += 1) {
        for (let dz = 0; dz < footprint.depth; dz += 1) {
          const probe = `${x + dx}:${z + dz}`
          if (covered.has(probe)) return null
          if (!alike(cells.get(probe))) return null
          if (carried.has(probe)) reaches = true
        }
      }
      return reaches ? footprint : null
    }
    const along = (footprint) => (longAxisX ? footprint.width : footprint.depth)
    const ordered = SCULPT_FOOTPRINTS.filter((footprint) => along(footprint) <= maxRun).sort(
      (a, b) => b.width * b.depth - a.width * a.depth || along(b) - along(a),
    )
    const chosen = ordered.map(fits).find(Boolean)
    if (!chosen) {
      dropped += 1
      continue
    }
    for (let dx = 0; dx < chosen.width; dx += 1) {
      for (let dz = 0; dz < chosen.depth; dz += 1) {
        covered.add(`${x + dx}:${z + dz}`)
        placed.add(`${x + dx}:${z + dz}`)
      }
    }
    build.place(
      chosen.id,
      cell.color,
      (x + chosen.width / 2) * STUD_LDU,
      (z + chosen.depth / 2) * STUD_LDU,
      surfaceY,
      { sub: cell.accent ? accentSub : sub, rotY: chosen.rotY, label: `${label} ${x},${z}` },
    )
  }
  return { placed, dropped, bricks: covered.size }
}

/**
 * A large sculpture shaped as a genuine 3D solid.
 *
 * `design.solid(x, y, z)` answers which colour, if any, occupies a cell of the
 * sculpture's own grid — `x` and `z` in studs across the scene, `y` in brick
 * courses up from the field. Because occupancy is a function of all three axes
 * it can carve the gap under a belly, cantilever a trunk past the feet and
 * taper a fluke to nothing, none of which a height map can express: a height
 * map only knows how tall each column is, which is exactly why the earlier
 * candidates for these builds read as a solid lump with a colour change on it.
 *
 * The solid is then laid course by course as bonded brickwork by `layCourse`,
 * so what ships is not a stack of loose 1 x 1 columns but interlocking bricks
 * of eleven footprints, cross-bonded, every one of them on the load path.
 */
export function voxelSculpture(rough, design) {
  const width = rough ? design.roughWidth : design.width
  const depth = rough ? design.roughDepth : design.depth
  const layers = rough ? 1 : 2
  const build = new Build({
    subassemblies: [
      { id: 'foundation', name: 'Cross-bonded display plinth', accent: '#7f8c9b' },
      { id: 'field', name: design.fieldName, accent: design.fieldAccent },
      { id: 'scene', name: design.sceneName ?? 'Landscape, lighting and visitor details', accent: '#f7b04a' },
      { id: 'body', name: design.bodyName, accent: design.bodyAccent },
      { id: 'accent', name: design.accentName, accent: design.accentColor },
    ],
  })
  const notes = []
  const warnings = []

  build.addPlan(
    planBrickField(
      spec({
        sub: 'foundation',
        origin: [0, 0, 0],
        color: design.plinthColor,
        family: 'plate',
        widthStuds: width,
        footprintDepthStuds: depth,
        layers,
      }),
    ),
    { sub: 'foundation' },
  )
  const foundationTop = -layers * PLATE_LDU

  // One finish piece per stud. It is the scene the operator can edit rather
  // than a painted rectangle, and it is also what bonds the sculpture's courses
  // to each other: 1 x 1 plates all share the plinth beneath them.
  const occupiedCells = new Set()
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      build.place('3024', design.fieldColor(x, z, width, depth), (x + 0.5) * STUD_LDU, (z + 0.5) * STUD_LDU, foundationTop, {
        sub: 'field',
        label: `${design.id} field ${x},${z}`,
      })
    }
  }
  const fieldTop = foundationTop - PLATE_LDU

  // Read the solid once, then lay it. Courses are read in full before any is
  // laid so a course can be told what the one below it actually carries.
  const courses = []
  const height = rough ? Math.max(1, Math.round(design.height * 0.55)) : design.height
  for (let y = 0; y < height; y += 1) {
    const cells = new Map()
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        // Not `!filled`: black is LDraw colour 0, and a falsy test would drop
        // every black cell in the sculpture.
        const filled = design.solid(x, y, z, { width, depth, height, rough })
        if (filled === null || filled === undefined || filled === false) continue
        occupiedCells.add(`${x}:${z}`)
        cells.set(`${x}:${z}`, typeof filled === 'object' ? filled : { color: filled, accent: false })
      }
    }
    courses.push(cells)
  }

  let carried = new Set(courses[0]?.keys() ?? [])
  let bricks = 0
  let dropped = 0
  for (const [course, cells] of courses.entries()) {
    if (!cells.size) continue
    const result = layCourse(build, {
      cells,
      // The first course rests on the field, which carries everywhere.
      carried: course === 0 ? new Set(cells.keys()) : carried,
      course,
      surfaceY: fieldTop - course * BRICK_LDU,
      sub: 'body',
      accentSub: 'accent',
      label: `${design.id} course ${course}`,
    })
    carried = result.placed
    bricks += result.bricks
    dropped += result.dropped
  }
  if (dropped) {
    warnings.push(
      `${dropped} sculpted cell(s) had no course beneath them to clutch onto and were left out of ${design.title}.`,
    )
  }

  if (!rough) {
    for (const [index, [x, z, treeHeight]] of (design.trees ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addTree(build, { x, z, surfaceY: fieldTop, sub: 'scene', height: treeHeight, variant: index })
    }
    for (const [x, z, lampHeight] of design.lights ?? []) {
      if (!occupiedCells.has(`${x}:${z}`)) addLamp(build, { x, z, surfaceY: fieldTop, sub: 'scene', height: lampHeight })
    }
    for (const [index, [x, z]] of (design.planters ?? []).entries()) {
      if (!occupiedCells.has(`${x}:${z}`))
        addPlanter(build, {
          x,
          z,
          surfaceY: fieldTop,
          sub: 'scene',
          variant: index,
          flower: index % 2 ? C.yellow : C.orange,
        })
    }
    // Anything the solid cannot express — an eye, a horn, a bill tip — is
    // placed by hand against surfaces the courses have already established.
    design.detail?.(build, { fieldTop, courseTop: (course) => fieldTop - course * BRICK_LDU, occupiedCells, C })
    notes.push(
      `${(design.trees ?? []).length} trees, ${(design.lights ?? []).length} illuminated posts and ` +
        `${(design.planters ?? []).length} planted edge details turn the plinth into a complete public setting.`,
    )
  }

  notes.push(
    `${design.title} is a 3D voxel solid ${occupiedCells.size.toLocaleString()} stud columns across and ` +
      `${height} courses tall, laid as ${bricks.toLocaleString()} cross-bonded brick cells on a ${width} x ${depth}-stud scene.`,
  )
  if (!rough) notes.push('The two-layer foundation cross-bonds every row into one editable, stable model.')
  return { build, notes, warnings }
}
