import { catalog, originForSurface, surfaceAbove } from './catalog'
import { basisFromEulerDegrees, cleanBasis } from './math'
import { deriveConnectionEdges } from './snapping'
import type { BuildStep, ModelDocument, PartDefinition, PartInstance, Subassembly, Vec3 } from './types'

/**
 * The starting document: Meridian Green, a four-storey civic building on a
 * landscaped plaza, assembled from real catalog parts at exact LDU transforms.
 *
 * It is generated rather than transcribed. A model with enough in it to be
 * worth opening — a curtain wall, a roof terrace, eight trees, a dozen people —
 * is thousands of parts, and thousands of hand-written coordinates are thousands
 * of chances to type 140 where 240 belongs. Every vertical position here comes
 * from the part's own compiled connectors through `place`, so a course that
 * stacks is a course that stacks in LDraw too.
 */

/** Stud pitch. Every plan coordinate below is in whole studs from the plaza's near-left corner. */
const STUD = 20
/** Plaza extent, in studs. */
const PLAN = { cols: 64, rows: 44 } as const
/** World x of the left edge of stud column `col`. */
const edgeX = (col: number) => col * STUD - (PLAN.cols * STUD) / 2
/** World z of the near edge of stud row `row`. */
const edgeZ = (row: number) => row * STUD - (PLAN.rows * STUD) / 2

const WHITE = 15
const BLACK = 0
const GREY = 71
const DARK_GREY = 72
const SAND = 19
const DARK_TAN = 28
const GLASS = 43
const CLEAR = 47
const GREEN = 2
const DARK_GREEN = 288
const BROWN = 70
const DARK_BROWN = 308
const RED = 4
const BLUE = 1
const DARK_BLUE = 272
const AZURE = 322
const YELLOW = 14
const ORANGE = 25
const BRIGHT_ORANGE = 191
const NOUGAT = 84
const SAND_GREEN = 378

const SUBASSEMBLIES: Array<Omit<Subassembly, 'partIds'>> = [
  { id: 'plaza', name: 'Plaza deck', locked: false, accent: '#6bbbd6' },
  { id: 'structure', name: 'Building structure', locked: true, accent: '#f7b04a' },
  { id: 'facade', name: 'Facade and glazing', locked: false, accent: '#87f7ff' },
  { id: 'roof', name: 'Roof terrace', locked: false, accent: '#8bcf65' },
  { id: 'park', name: 'Park and planting', locked: false, accent: '#5fd08b' },
  { id: 'street', name: 'Street furniture', locked: false, accent: '#d98cf0' },
  { id: 'people', name: 'People', locked: false, accent: '#ffd166' },
]

const STEPS: Array<Omit<BuildStep, 'partIds'>> = [
  { id: 'step_1', index: 1, name: 'Plaza deck' },
  { id: 'step_2', index: 2, name: 'Paving and paths' },
  { id: 'step_3', index: 3, name: 'Ground floor' },
  { id: 'step_4', index: 4, name: 'Upper floors' },
  { id: 'step_5', index: 5, name: 'Roof terrace' },
  { id: 'step_6', index: 6, name: 'Planting' },
  { id: 'step_7', index: 7, name: 'Street furniture' },
  { id: 'step_8', index: 8, name: 'People' },
]

interface PlaceOptions {
  rotationY?: number
  subassemblyId?: string
  stepId?: string
  protectedPart?: boolean
}

/** Footprint of a definition in whole studs, after an optional quarter turn. */
function footprint(definitionId: string, rotationY = 0): { w: number; d: number } {
  const definition = catalog.get(definitionId)
  if (!definition?.dimensions?.studs) {
    throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
  }
  const [x, , z] = definition.dimensions.studs
  const w = Math.max(1, Math.round(x))
  const d = Math.max(1, Math.round(z))
  const turned = Math.abs(((rotationY % 360) + 360) % 360 - 90) < 1 || Math.abs(((rotationY % 360) + 360) % 360 - 270) < 1
  return turned ? { w: d, d: w } : { w, d }
}

/**
 * The plane the next part rests on.
 *
 * A stud plane where the part has one. Where it does not — a tile, a round
 * tile, a jumper cap — the geometric top face, because returning the surface
 * *underneath* it means the next part is placed inside it. That is a cup
 * standing in a cafe table rather than on it, and 163 overlaps on the opening
 * document is not a rounding error.
 */
function topOf(definition: PartDefinition, originY: number, fallback: number): number {
  const stud = surfaceAbove(definition, originY)
  if (stud !== null) return stud
  const min = definition.dimensions?.bounds?.min?.[1]
  return min === undefined ? fallback : originY + min
}

class SiteBuilder {
  readonly parts: PartInstance[] = []
  private sequence = 0
  private context: Required<Pick<PlaceOptions, 'subassemblyId' | 'stepId'>> = {
    subassemblyId: 'plaza',
    stepId: 'step_1',
  }

  /** Every part placed until the next call joins this assembly and step. */
  section(subassemblyId: string, stepId: string): void {
    this.context = { subassemblyId, stepId }
  }

  private push(definitionId: string, color: number, position: Vec3, options: PlaceOptions): void {
    this.sequence += 1
    this.parts.push({
      id: `part_${String(this.sequence).padStart(4, '0')}`,
      definitionId,
      color,
      transform: {
        position,
        basis: cleanBasis(basisFromEulerDegrees([0, options.rotationY ?? 0, 0])),
      },
      subassemblyId: options.subassemblyId ?? this.context.subassemblyId,
      stepId: options.stepId ?? this.context.stepId,
      provenance: 'human',
      protected: options.protectedPart ?? false,
    })
  }

  /**
   * Places a part with its near-left stud on column `col`, row `row`, resting
   * on `surfaceY`; returns the stud plane it exposes.
   *
   * Plan coordinates are the part's own corner rather than its centre, because
   * a wall is laid by saying where the next brick starts, not by averaging its
   * ends. The centre the transform actually needs is derived from the compiled
   * footprint.
   */
  at(definitionId: string, color: number, col: number, row: number, surfaceY: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
    const { w, d } = footprint(definitionId, options.rotationY)
    const y = originForSurface(definition, surfaceY)
    this.push(definitionId, color, [edgeX(col) + (w * STUD) / 2, y, edgeZ(row) + (d * STUD) / 2], options)
    return topOf(definition, y, surfaceY)
  }

  /** Places at an explicit origin, for parts that mate to a connector rather than a surface. */
  atOrigin(definitionId: string, color: number, col: number, row: number, y: number, options: PlaceOptions = {}): void {
    if (!catalog.get(definitionId)) {
      throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
    }
    const { w, d } = footprint(definitionId, options.rotationY)
    this.push(definitionId, color, [edgeX(col) + (w * STUD) / 2, y, edgeZ(row) + (d * STUD) / 2], options)
  }

  /**
   * Places a part centred on the stud at (col, row).
   *
   * Foliage and headgear have footprints like 4.8 x 5.8 studs, so corner
   * alignment puts them half a stud off the trunk they grow out of. These parts
   * carry a single central anti-stud, and this is where it lands.
   */
  centred(definitionId: string, color: number, col: number, row: number, surfaceY: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
    const y = originForSurface(definition, surfaceY)
    this.push(definitionId, color, [edgeX(col) + STUD / 2, y, edgeZ(row) + STUD / 2], options)
    return topOf(definition, y, surfaceY)
  }

  /**
   * Tiles a rectangle with the largest plate that fits at each uncovered cell.
   *
   * A single definition cannot tile an arbitrary rectangle: a 6x8 plate laid
   * across a 20 x 16 floor leaves a four-stud strip on two sides, and every
   * storey slab, roof deck and lawn in this model was short by exactly that.
   * Descending the ladder covers the remainder in the sizes a builder would
   * actually reach for.
   */
  pave(
    color: number | ((col: number, row: number) => number),
    col: number,
    row: number,
    cols: number,
    rows: number,
    surfaceY: number,
    options: PlaceOptions = {},
  ): number {
    const covered = new Set<number>()
    const index = (x: number, z: number) => (z - row) * cols + (x - col)
    let exposed = surfaceY
    for (let z = row; z < row + rows; z += 1) {
      for (let x = col; x < col + cols; x += 1) {
        if (covered.has(index(x, z))) continue
        const plate = PLATE_LADDER.find(
          (candidate) =>
            x + candidate.w <= col + cols &&
            z + candidate.d <= row + rows &&
            !overlapsCovered(covered, index, x, z, candidate.w, candidate.d),
        )
        if (!plate) continue
        for (let dz = 0; dz < plate.d; dz += 1) {
          for (let dx = 0; dx < plate.w; dx += 1) covered.add(index(x + dx, z + dz))
        }
        exposed = this.at(plate.id, typeof color === 'function' ? color(x, z) : color, x, z, surfaceY, options)
      }
    }
    return exposed
  }

  /**
   * A second plate course whose seams cross the one below it.
   *
   * Plates laid edge to edge do not clutch each other, so a deck tiled in one
   * course is as many separate pieces as it has plates — 154 of them here, and
   * every tree and bollard standing on one inherits its island. Real baseplates
   * are locked the same way: a second course laid to a different partition, so
   * every seam below is spanned by a plate above.
   */
  paveOver(
    color: number | ((col: number, row: number) => number),
    col: number,
    row: number,
    cols: number,
    rows: number,
    surfaceY: number,
    options: PlaceOptions = {},
  ): number {
    const inset = 2
    const bands = [
      { col, row, cols, rows: inset },
      { col, row: row + rows - inset, cols, rows: inset },
      { col, row: row + inset, cols: inset, rows: rows - inset * 2 },
      { col: col + cols - inset, row: row + inset, cols: inset, rows: rows - inset * 2 },
      { col: col + inset, row: row + inset, cols: cols - inset * 2, rows: rows - inset * 2 },
    ]
    let exposed = surfaceY
    for (const band of bands) {
      if (band.cols <= 0 || band.rows <= 0) continue
      exposed = this.pave(color, band.col, band.row, band.cols, band.rows, surfaceY, options)
    }
    return exposed
  }

  /** Tiles a rectangle with one definition, left to right then near to far. */
  field(
    definitionId: string,
    color: number | ((col: number, row: number) => number),
    col: number,
    row: number,
    cols: number,
    rows: number,
    surfaceY: number,
    options: PlaceOptions = {},
  ): number {
    const { w, d } = footprint(definitionId, options.rotationY)
    let exposed = surfaceY
    for (let z = row; z + d <= row + rows; z += d) {
      for (let x = col; x + w <= col + cols; x += w) {
        exposed = this.at(definitionId, typeof color === 'function' ? color(x, z) : color, x, z, surfaceY, options)
      }
    }
    return exposed
  }
}

/**
 * A run of 1×N bricks covering `length` studs, partitioned longest-first and
 * offset by `phase` so consecutive courses break their joints.
 *
 * Real walls are laid this way for the same reason the connectivity check likes
 * it: a stack of identical bricks with aligned seams is several columns that
 * merely touch, and it falls apart the moment anything leans on it.
 */
const RUN_LENGTHS = [8, 6, 4, 3, 2, 1] as const
export function partitionCourse(length: number, phase: number): number[] {
  const pieces: number[] = []
  let remaining = length
  // The phase brick shortens the first piece, which is what staggers the seam.
  if (phase > 0 && remaining > phase) {
    pieces.push(phase)
    remaining -= phase
  }
  while (remaining > 0) {
    const piece = RUN_LENGTHS.find((candidate) => candidate <= remaining) ?? 1
    pieces.push(piece)
    remaining -= piece
  }
  return pieces
}

/**
 * Plates the tiler may reach for, largest first.
 *
 * Both orientations of each rectangle are listed rather than rotated, because a
 * rotated part needs its transform turned too and the tiler's job is to choose
 * a size, not to compose a basis.
 */
const PLATE_LADDER: ReadonlyArray<{ id: string; w: number; d: number }> = [
  { id: '91405', w: 16, d: 16 },
  { id: '3036', w: 8, d: 6 },
  { id: '3958', w: 6, d: 6 },
  { id: '3035', w: 8, d: 4 },
  { id: '3032', w: 6, d: 4 },
  { id: '3031', w: 4, d: 4 },
  { id: '3034', w: 8, d: 2 },
  { id: '3795', w: 6, d: 2 },
  { id: '3020', w: 4, d: 2 },
  { id: '3021', w: 3, d: 2 },
  { id: '3022', w: 2, d: 2 },
  { id: '3460', w: 8, d: 1 },
  { id: '3666', w: 6, d: 1 },
  { id: '3710', w: 4, d: 1 },
  { id: '3623', w: 3, d: 1 },
  { id: '3023b', w: 2, d: 1 },
  { id: '3024', w: 1, d: 1 },
]

function overlapsCovered(
  covered: ReadonlySet<number>,
  index: (x: number, z: number) => number,
  col: number,
  row: number,
  w: number,
  d: number,
): boolean {
  for (let z = row; z < row + d; z += 1) {
    for (let x = col; x < col + w; x += 1) if (covered.has(index(x, z))) return true
  }
  return false
}

const BRICK_BY_LENGTH: Record<number, string> = { 8: '3008', 6: '3009', 4: '3010', 3: '3622', 2: '3004', 1: '3005' }
const PLATE_BY_LENGTH: Record<number, string> = { 8: '3460', 6: '3666', 4: '3710', 3: '3623', 2: '3023b', 1: '3024' }

function courseRun(
  build: SiteBuilder,
  kind: 'brick' | 'plate',
  color: number,
  col: number,
  row: number,
  length: number,
  surfaceY: number,
  axis: 'x' | 'z',
  phase: number,
  options: PlaceOptions = {},
): number {
  const table = kind === 'brick' ? BRICK_BY_LENGTH : PLATE_BY_LENGTH
  const rotationY = axis === 'z' ? 90 : 0
  let cursor = 0
  let exposed = surfaceY
  for (const piece of partitionCourse(length, phase)) {
    const definitionId = table[piece]
    exposed =
      axis === 'x'
        ? build.at(definitionId, color, col + cursor, row, surfaceY, { ...options, rotationY })
        : build.at(definitionId, color, col, row + cursor, surfaceY, { ...options, rotationY })
    cursor += piece
  }
  return exposed
}

/** A rectangular footprint on the plaza grid. */
interface Footprint {
  readonly col: number
  readonly row: number
  readonly w: number
  readonly d: number
}

/** A window or door opening on one face, as a span of studs along that face. */
interface Opening {
  readonly start: number
  readonly length: number
}

interface Faces {
  readonly front: readonly Opening[]
  readonly back: readonly Opening[]
  readonly left: readonly Opening[]
  readonly right: readonly Opening[]
}

const inOpening = (offset: number, openings: readonly Opening[]) =>
  openings.some((opening) => offset >= opening.start && offset < opening.start + opening.length)

/**
 * Lays one course of a rectangular perimeter, skipping the openings.
 *
 * The two x-runs take the corners, so the z-runs cover only the interior rows.
 * Anything else double-books the corner stud and leaves two bricks fighting for
 * it — which the collision check would report, correctly, on the starting
 * document.
 */
function perimeterCourse(
  build: SiteBuilder,
  plot: Footprint,
  color: number,
  surfaceY: number,
  phase: number,
  faces: Faces,
  options: PlaceOptions = {},
): number {
  const { col, row, w, d } = plot
  let exposed = surfaceY
  const solidSpans = (length: number, openings: readonly Opening[]) => {
    const spans: Array<{ start: number; length: number }> = []
    let start = 0
    for (let offset = 0; offset <= length; offset += 1) {
      if (offset < length && !inOpening(offset, openings)) continue
      if (offset > start) spans.push({ start, length: offset - start })
      start = offset + 1
    }
    return spans
  }

  for (const span of solidSpans(w, faces.back)) {
    exposed = courseRun(build, 'brick', color, col + span.start, row, span.length, surfaceY, 'x', phase, options)
  }
  for (const span of solidSpans(w, faces.front)) {
    exposed = courseRun(build, 'brick', color, col + span.start, row + d - 1, span.length, surfaceY, 'x', phase, options)
  }
  for (const span of solidSpans(d - 2, faces.left)) {
    exposed = courseRun(build, 'brick', color, col, row + 1 + span.start, span.length, surfaceY, 'z', phase, options)
  }
  for (const span of solidSpans(d - 2, faces.right)) {
    exposed = courseRun(build, 'brick', color, col + w - 1, row + 1 + span.start, span.length, surfaceY, 'z', phase, options)
  }
  return exposed
}

/** Hangs a glazed panel in every opening on a storey. */
function glazeStorey(build: SiteBuilder, plot: Footprint, surfaceY: number, faces: Faces): void {
  const { col, row, w, d } = plot
  const bay = (colIndex: number, rowIndex: number, rotationY: number, length: number) => {
    // Four studs is the entrance, which is a door rather than a window.
    if (length !== 6) return
    build.at('59349', GLASS, colIndex, rowIndex, surfaceY, { rotationY })
  }
  for (const opening of faces.back) bay(col + opening.start, row, 180, opening.length)
  for (const opening of faces.front) bay(col + opening.start, row + d - 1, 0, opening.length)
  for (const opening of faces.left) bay(col, row + 1 + opening.start, 270, opening.length)
  for (const opening of faces.right) bay(col + w - 1, row + 1 + opening.start, 90, opening.length)
}

/** A tree: a round-brick trunk under stacked leaf sprays. */
function tree(build: SiteBuilder, col: number, row: number, surfaceY: number, height: number, leaf: number): void {
  let top = surfaceY
  for (let course = 0; course < height; course += 1) {
    top = build.centred('3062b', course === 0 ? DARK_BROWN : BROWN, col, row, top)
  }
  const lower = build.centred('2417', leaf, col, row, top)
  const upper = build.centred('2423', leaf, col, row, lower, { rotationY: 90 })
  build.centred('2423', leaf, col, row, upper)
}

/** A bench: a brick frame under a slatted wooden seat. */
function bench(build: SiteBuilder, col: number, row: number, surfaceY: number, rotationY: number): void {
  const seat = build.at('3010', DARK_GREY, col, row, surfaceY, { rotationY })
  build.at('2431', BROWN, col, row, seat, { rotationY })
}

/** A lamp: a round-brick column under a lit cover. */
function lamp(build: SiteBuilder, col: number, row: number, surfaceY: number, courses = 4): void {
  let top = surfaceY
  for (let course = 0; course < courses; course += 1) top = build.centred('3062b', DARK_GREY, col, row, top)
  build.centred('58176', 226, col, row, top)
}

/**
 * A minifigure.
 *
 * The compiled pack carries heads, legs and headgear but no torso mould, so the
 * body is a 1×2 brick — the same two-by-one footprint, and the part a builder
 * would actually reach for to stand a figure up out of the box.
 */
function figure(
  build: SiteBuilder,
  col: number,
  row: number,
  surfaceY: number,
  outfit: { legs: number; torso: number; hair: string | null; hairColor: number },
  rotationY = 0,
): number {
  const hips = build.at('41879a', outfit.legs, col, row, surfaceY, { rotationY })
  const shoulders = build.at('3004', outfit.torso, col, row, hips, { rotationY })
  // The head's neck socket is central and one stud wide, so it seats on the
  // torso's near stud rather than between the two.
  const crown = build.at('3626b', 14, col, row, shoulders, { rotationY })
  if (outfit.hair) build.centred(outfit.hair, outfit.hairColor, col, row, crown, { rotationY })
  return crown
}

/**
 * Curtain-wall bays for a face of `length` studs, six studs wide on a ten-stud
 * pitch with a pier at each corner.
 *
 * Six wide and five courses tall is exactly one storey, so a bay is a single
 * `59349` panel rather than a frame with a pane that does not fit it. The pack
 * carries glass for a 1x4x6 window and none for the 1x4x3, and putting the tall
 * one in the short frame is a 72-LDU overlap on every window in the building.
 */
function bays(length: number, pitch = 10): Opening[] {
  const openings: Opening[] = []
  for (let start = 2; start + 6 <= length - 2; start += pitch) openings.push({ start, length: 6 })
  return openings
}

const facesFor = (plot: Footprint, pitch = 10): Faces => ({
  front: bays(plot.w, pitch),
  back: bays(plot.w, pitch),
  left: bays(plot.d - 2, pitch),
  right: bays(plot.d - 2, pitch),
})

/** Interior columns on a footprint's own grid, one every eight studs. */
function columnsFor(plot: Footprint): Array<{ col: number; row: number }> {
  const columns: Array<{ col: number; row: number }> = []
  for (let row = 5; row < plot.d - 2; row += 6) {
    for (let col = 6; col < plot.w - 2; col += 7) columns.push({ col, row })
  }
  return columns
}

/** Courses of brick per storey. Five leaves room for a minifigure to stand up. */
const STOREY_COURSES = 5

/** The two buildings on the site. */
const TOWER: Footprint = { col: 3, row: 5, w: 24, d: 18 }
const PAVILION: Footprint = { col: 32, row: 5, w: 14, d: 12 }
const TOWER_STOREYS = 5
const PAVILION_STOREYS = 1

/**
 * Raises a building on `plot`: ground floor, upper storeys, roof.
 *
 * One generator for both buildings on the site. Every storey is a full-footprint
 * plate slab carrying five courses of wall, with the curtain-wall bays glazed
 * and interior columns under the middle of the slab above.
 */
function raise(
  build: SiteBuilder,
  plot: Footprint,
  deck: number,
  options: { storeys: number; roof: 'terrace' | 'plain'; entranceAt?: number },
): number {
  const { col: bc, row: br, w: bw, d: bd } = plot
  const faces = facesFor(plot)
  const columns = columnsFor(plot)
  const entrance = options.entranceAt ?? Math.floor(bw / 2) - 2

  // -- Ground floor --------------------------------------------------------
  build.section('structure', 'step_3')
  const slab = build.pave(DARK_GREY, bc, br, bw, bd, deck, { protectedPart: true })
  const groundFaces: Faces = { ...faces, front: [...faces.front, { start: entrance, length: 4 }] }
  // A plinth course under the glazing, then five more to the first floor.
  let course = perimeterCourse(
    build,
    plot,
    DARK_GREY,
    slab,
    0,
    { front: [{ start: entrance, length: 4 }], back: [], left: [], right: [] },
    { protectedPart: true },
  )
  const groundSill = course
  for (let index = 0; index < STOREY_COURSES; index += 1) {
    course = perimeterCourse(build, plot, WHITE, course, index % 2 === 0 ? 2 : 0, groundFaces, {
      protectedPart: true,
    })
  }

  build.section('facade', 'step_3')
  glazeStorey(build, plot, groundSill, groundFaces)
  // The entrance runs the full storey, so its frame seats on the slab.
  build.at('60596', DARK_GREY, bc + entrance, br + bd - 1, slab)
  build.at('60616b', CLEAR, bc + entrance, br + bd - 1, slab)

  // -- Upper storeys -------------------------------------------------------
  let floor = course
  for (let storey = 0; storey < options.storeys; storey += 1) {
    build.section('structure', 'step_4')
    const band = storey % 2 === 0 ? DARK_GREY : AZURE
    const onEdge = (col: number, row: number) =>
      col === bc || col === bc + bw - 1 || row === br || row === br + bd - 1
    // One slab, not a perimeter band with a separate interior sheet: the band
    // only covered the wall line, so the floor inside it rested on nothing.
    // On terrace storeys it runs two studs past the front wall, laid as part of
    // the same rectangle — a ledge paved on its own butts against the slab and
    // is carried by nothing.
    const terrace = options.roof === 'terrace' && storey % 2 === 1
    const shade = (col: number, row: number) => (row >= br + bd ? GREY : onEdge(col, row) ? band : GREY)
    let ring: number
    if (terrace) {
      // The front band is laid as its own six-row rectangle so that every plate
      // in it spans the wall line at `br + bd - 1`. Paving the whole slab in one
      // go leaves the two overhanging rows as a separate two-row band, carried
      // by nothing, with the railing standing on it.
      ring = build.pave(shade, bc, br, bw, bd - 4, floor)
      build.pave(shade, bc, br + bd - 4, bw, 6, floor)
    } else {
      ring = build.pave(shade, bc, br, bw, bd, floor)
    }

    let wall = ring
    for (let index = 0; index < STOREY_COURSES; index += 1) {
      wall = perimeterCourse(build, plot, WHITE, wall, index % 2 === 0 ? 3 : 1, faces)
    }
    // A slab tiled with 8x6 plates leaves plates that touch no wall at all, and
    // a building with nothing in the middle holding the floor up is a building
    // the statics pass is right to complain about.
    for (const column of columns) {
      let lift = ring
      for (let index = 0; index < STOREY_COURSES; index += 1) {
        lift = build.at('3005', GREY, bc + column.col, br + column.row, lift)
      }
    }
    build.section('facade', 'step_4')
    glazeStorey(build, plot, ring, faces)
    if (terrace) {
      for (let col = bc; col + 4 <= bc + bw; col += 4) build.at('15332', GREY, col, br + bd + 1, ring)
      // Posts rather than rails on the returns: the shortest fence in the pack
      // is four studs and the terrace is two deep, so a rail there runs through
      // the front one.
      build.at('3005', GREY, bc, br + bd, ring)
      build.at('3005', GREY, bc + bw - 1, br + bd, ring)
    }
    floor = wall
  }
  return floor
}

/** Lawn beds, which the paving pass leaves bare for turf. */
const LAWNS = [
  { col: 48, row: 6, cols: 14, rows: 14 },
  { col: 30, row: 26, cols: 16, rows: 12 },
  { col: 4, row: 32, cols: 14, rows: 8 },
  { col: 50, row: 24, cols: 12, rows: 16 },
] as const

/** The tan route from the park to the entrance, laid inside the paving pass. */
const PATH = [
  { col: 12, row: 24, cols: 40, rows: 2 },
  { col: 12, row: 24, cols: 4, rows: 20 },
  { col: 46, row: 4, cols: 2, rows: 22 },
] as const

const TREES = [
  { col: 50, row: 8, height: 5 },
  { col: 56, row: 11, height: 6 },
  { col: 51, row: 15, height: 4 },
  { col: 58, row: 17, height: 5 },
  { col: 33, row: 28, height: 5 },
  { col: 38, row: 31, height: 4 },
  { col: 43, row: 28, height: 6 },
  { col: 35, row: 35, height: 4 },
  { col: 41, row: 36, height: 5 },
  { col: 7, row: 34, height: 5 },
  { col: 11, row: 37, height: 4 },
  { col: 15, row: 34, height: 6 },
  { col: 53, row: 27, height: 5 },
  { col: 58, row: 30, height: 4 },
  { col: 52, row: 34, height: 6 },
  { col: 59, row: 37, height: 5 },
  { col: 28, row: 6, height: 4 },
  { col: 28, row: 14, height: 5 },
] as const

const BENCHES = [
  { col: 20, row: 27, rotationY: 0 },
  { col: 26, row: 27, rotationY: 0 },
  { col: 32, row: 22, rotationY: 0 },
  { col: 38, row: 22, rotationY: 0 },
  { col: 48, row: 21, rotationY: 0 },
  { col: 54, row: 21, rotationY: 0 },
  { col: 6, row: 28, rotationY: 0 },
  { col: 12, row: 28, rotationY: 0 },
  { col: 20, row: 38, rotationY: 0 },
  { col: 26, row: 38, rotationY: 0 },
  { col: 47, row: 34, rotationY: 90 },
  { col: 47, row: 40, rotationY: 90 },
] as const

const LAMPS = [
  { col: 29, row: 2 },
  { col: 29, row: 12 },
  { col: 29, row: 22 },
  { col: 18, row: 23 },
  { col: 24, row: 23 },
  { col: 36, row: 23 },
  { col: 42, row: 23 },
  { col: 2, row: 26 },
  { col: 2, row: 42 },
  { col: 18, row: 42 },
  { col: 62, row: 2 },
  { col: 62, row: 22 },
  { col: 62, row: 42 },
  { col: 30, row: 42 },
  { col: 44, row: 42 },
] as const

const TABLES = [
  { col: 21, row: 30 },
  { col: 25, row: 32 },
  { col: 19, row: 34 },
  { col: 24, row: 36 },
  { col: 49, row: 4 },
  { col: 49, row: 8 },
] as const

const PLANTERS = [
  { col: 29, row: 6 },
  { col: 29, row: 16 },
  { col: 47, row: 6 },
  { col: 47, row: 16 },
  { col: 16, row: 30 },
  { col: 16, row: 36 },
  { col: 55, row: 22 },
] as const

const FLOWER_BEDS = [
  { col: 48, row: 20, length: 14, flower: RED },
  { col: 30, row: 38, length: 16, flower: YELLOW },
  { col: 4, row: 31, length: 14, flower: BRIGHT_ORANGE },
  { col: 50, row: 40, length: 12, flower: AZURE },
  { col: 48, row: 5, length: 14, flower: WHITE },
] as const

const CROWD = [
  { col: 26, row: 29, legs: DARK_BLUE, torso: RED, hair: '3901', hairColor: DARK_BROWN, rotationY: 180 },
  { col: 29, row: 30, legs: BLACK, torso: AZURE, hair: '87990', hairColor: YELLOW, rotationY: 180 },
  { col: 22, row: 24, legs: BROWN, torso: GREEN, hair: '62810', hairColor: BLACK, rotationY: 90 },
  { col: 22, row: 29, legs: DARK_GREY, torso: ORANGE, hair: '3833', hairColor: YELLOW, rotationY: 0 },
  { col: 32, row: 12, legs: BLUE, torso: WHITE, hair: '98385', hairColor: DARK_BROWN, rotationY: 270 },
  { col: 36, row: 20, legs: DARK_BLUE, torso: DARK_BLUE, hair: '3624', hairColor: DARK_BLUE, rotationY: 180 },
  { col: 43, row: 28, legs: NOUGAT, torso: YELLOW, hair: '11303', hairColor: RED, rotationY: 0 },
  { col: 9, row: 22, legs: BLACK, torso: DARK_BLUE, hair: '3901', hairColor: BLACK, rotationY: 0 },
  { col: 13, row: 31, legs: RED, torso: WHITE, hair: '87990', hairColor: BROWN, rotationY: 180 },
  { col: 19, row: 18, legs: DARK_GREY, torso: BRIGHT_ORANGE, hair: '3833', hairColor: WHITE, rotationY: 90 },
  { col: 46, row: 12, legs: GREEN, torso: SAND, hair: '62810', hairColor: BROWN, rotationY: 270 },
  { col: 30, row: 2, legs: DARK_BROWN, torso: DARK_GREEN, hair: '98385', hairColor: BLACK, rotationY: 0 },
] as const

/** Loose items on the deck, each on its own stud. */
const PROPS = [
  { id: '30162', color: BLACK, col: 33, row: 12 },
  { id: '30150', color: BROWN, col: 20, row: 22 },
  { id: '2489', color: DARK_BROWN, col: 18, row: 21 },
  { id: '95343', color: AZURE, col: 24, row: 21 },
  { id: '2489', color: BROWN, col: 57, row: 41 },
  { id: '95343', color: RED, col: 60, row: 26 },
  { id: '30150', color: DARK_TAN, col: 42, row: 42 },
  { id: '95343', color: YELLOW, col: 9, row: 41 },
] as const

const inside = (rect: { col: number; row: number; cols: number; rows: number }, col: number, row: number) =>
  col >= rect.col && col < rect.col + rect.cols && row >= rect.row && row < rect.row + rect.rows


/**
 * Caps a building: parapet, terrace decking, planters and — on the tall one —
 * the plant room and mast that make a flat roof read as somewhere people go.
 */
function roof(build: SiteBuilder, plot: Footprint, floor: number, furnished: boolean): void {
  const { col: bc, row: br, w: bw, d: bd } = plot
  build.section('roof', 'step_5')
  const deck = build.pave(DARK_GREY, bc, br, bw, bd, floor)
  const parapet = perimeterCourse(build, plot, GREY, deck, 0, { front: [], back: [], left: [], right: [] })
  for (let col = bc; col + 4 <= bc + bw; col += 4) {
    build.at('2431', WHITE, col, br, parapet)
    build.at('2431', WHITE, col, br + bd - 1, parapet)
  }
  for (let row = br + 1; row + 4 <= br + bd - 1; row += 4) {
    build.at('2431', WHITE, bc, row, parapet, { rotationY: 90 })
    build.at('2431', WHITE, bc + bw - 1, row, parapet, { rotationY: 90 })
  }
  build.field('87079', BROWN, bc + 2, br + 2, 8, 6, deck)
  for (const spot of [
    { col: bc + 12, row: br + 2 },
    { col: bc + 16, row: br + 2 },
    { col: bc + 12, row: br + bd - 5 },
    { col: bc + 3, row: br + bd - 5 },
  ]) {
    if (spot.col + 2 > bc + bw - 1 || spot.row + 2 > br + bd - 1) continue
    const rim = build.field('3004', SAND_GREEN, spot.col, spot.row, 2, 2, deck)
    build.centred('2423', DARK_GREEN, spot.col, spot.row, rim)
    build.centred('4728', RED, spot.col + 1, spot.row + 1, rim)
  }
  if (!furnished) return
  const plantRoom = build.field('3001', GREY, bc + bw - 9, br + bd - 9, 4, 4, deck)
  for (let col = bc + bw - 9; col + 2 <= bc + bw - 5; col += 2) {
    build.at('2412b', DARK_GREY, col, br + bd - 9, plantRoom)
    build.at('2412b', DARK_GREY, col, br + bd - 6, plantRoom)
  }
  build.centred('2569', DARK_GREY, bc + bw - 7, br + bd - 7, plantRoom)
  for (const col of [bc + 3, bc + Math.floor(bw / 2), bc + bw - 4]) lamp(build, col, br + bd - 2, deck, 2)
}

export function createShowcaseDocument(): ModelDocument {
  const build = new SiteBuilder()

  /*
   * What already stands on the deck.
   *
   * Paving is laid *around* the site rather than under it. A tile and a bollard
   * both resting on the same deck stud is not a stacking order, it is two parts
   * occupying one volume — and doing it site-wide put 86 overlaps on the
   * document the editor opens with.
   */
  const reserved = new Set<string>()
  const key = (col: number, row: number) => `${col},${row}`
  const reserve = (col: number, row: number, cols = 1, rows = 1) => {
    for (let z = row; z < row + rows; z += 1) for (let x = col; x < col + cols; x += 1) reserved.add(key(x, z))
  }
  for (const tree of TREES) reserve(tree.col, tree.row)
  for (const bench of BENCHES) reserve(bench.col, bench.row, bench.rotationY === 90 ? 1 : 4, bench.rotationY === 90 ? 4 : 1)
  for (const spot of LAMPS) reserve(spot.col, spot.row)
  for (const spot of TABLES) reserve(spot.col, spot.row)
  for (const spot of PLANTERS) reserve(spot.col, spot.row, 2, 2)
  for (const bed of FLOWER_BEDS) reserve(bed.col, bed.row, bed.length, 1)
  for (const person of CROWD) reserve(person.col, person.row, 2, 1)
  for (const prop of PROPS) reserve(prop.col, prop.row, 4, 4)
  for (let row = 21; row <= 29; row += 2) {
    reserve(18, row)
    reserve(23, row)
  }
  for (let col = 27; col < 33; col += 4) reserve(col, 31, 4, 1)
  reserve(34, 17)

  const insideBuilding = (col: number, row: number) =>
    [TOWER, PAVILION].some(
      (plot) => col >= plot.col && col < plot.col + plot.w && row >= plot.row && row < plot.row + plot.d,
    )
  const insideLawn = (col: number, row: number) => LAWNS.some((lawn) => inside(lawn, col, row))
  const onPath = (col: number, row: number) => PATH.some((leg) => inside(leg, col, row))

  // -- Plaza deck ----------------------------------------------------------
  build.section('plaza', 'step_1')
  // Paved with the ladder rather than one plate size: a 64 x 44 deck is not a
  // whole number of 16 x 16 plates, and tiling it with only those left the last
  // twelve rows of the site standing on nothing at all.
  const base = build.pave(DARK_GREY, 0, 0, PLAN.cols, PLAN.rows, 0)
  const deck = build.paveOver(
    (col, row) => ((Math.floor(col / 8) + Math.floor(row / 8)) % 2 === 0 ? GREY : DARK_GREY),
    0,
    0,
    PLAN.cols,
    PLAN.rows,
    base,
  )

  // -- Paving, path and turf ----------------------------------------------
  build.section('plaza', 'step_2')
  const blocked = (col: number, row: number, cols: number, rows: number) => {
    for (let z = row; z < row + rows; z += 1) {
      for (let x = col; x < col + cols; x += 1) {
        if (insideBuilding(x, z) || insideLawn(x, z) || reserved.has(key(x, z))) return true
      }
    }
    return false
  }
  for (let row = 0; row + 2 <= PLAN.rows; row += 2) {
    for (let col = 0; col + 4 <= PLAN.cols; col += 4) {
      if (blocked(col, row, 4, 2)) continue
      // Two greys on a four-stud module so paving reads as paving rather than
      // as one flat slab the eye slides off; tan marks the route to the door.
      const shade = onPath(col, row) ? SAND : (col / 4 + row / 2) % 3 === 0 ? DARK_GREY : GREY
      build.at('87079', shade, col, row, deck)
    }
  }
  // Whatever the 2x4 module could not reach, in 1x2 tiles, so the deck is not
  // left showing bare studs in the gaps around the furniture.
  for (let row = 0; row < PLAN.rows; row += 1) {
    for (let col = 0; col + 2 <= PLAN.cols; col += 2) {
      if (blocked(col, row, 2, 1)) continue
      if (!blocked(col - (col % 4), row - (row % 2), 4, 2)) continue
      build.at('3069b', onPath(col, row) ? SAND : GREY, col, row, deck)
    }
  }
  let turf = deck
  for (const lawn of LAWNS) turf = build.pave(GREEN, lawn.col, lawn.row, lawn.cols, lawn.rows, deck)
  // Grass is a plate proud of the deck, so a tree planted on it starts a plate
  // higher. Standing everything on `deck` regardless put every trunk, figure
  // and flower bed inside the turf it is supposed to be growing out of.
  const ground = (col: number, row: number) => (insideLawn(col, row) ? turf : deck)

  const towerTop = raise(build, TOWER, deck, { storeys: TOWER_STOREYS, roof: 'terrace' })
  roof(build, TOWER, towerTop, true)
  const pavilionTop = raise(build, PAVILION, deck, { storeys: PAVILION_STOREYS, roof: 'plain' })
  roof(build, PAVILION, pavilionTop, false)

  // -- Park and planting ---------------------------------------------------
  build.section('park', 'step_6')
  for (const [index, spot] of TREES.entries()) {
    tree(build, spot.col, spot.row, ground(spot.col, spot.row), spot.height, index % 3 === 0 ? DARK_GREEN : GREEN)
  }
  for (const bed of FLOWER_BEDS) {
    for (let offset = 0; offset < bed.length; offset += 2) {
      const rim = build.at('3024', DARK_TAN, bed.col + offset, bed.row, ground(bed.col + offset, bed.row))
      build.centred(offset % 4 === 0 ? '32607' : '4728', bed.flower, bed.col + offset, bed.row, rim)
    }
  }
  for (const spot of PLANTERS) {
    const rim = build.field('3004', DARK_TAN, spot.col, spot.row, 2, 2, ground(spot.col, spot.row))
    build.centred('30176', DARK_GREEN, spot.col, spot.row, rim)
    build.centred('32607', GREEN, spot.col + 1, spot.row + 1, rim)
  }

  // -- Street furniture ----------------------------------------------------
  build.section('street', 'step_7')
  for (const spot of BENCHES) bench(build, spot.col, spot.row, ground(spot.col, spot.row), spot.rotationY)
  for (const spot of LAMPS) lamp(build, spot.col, spot.row, ground(spot.col, spot.row))
  for (let row = 21; row <= 29; row += 2) {
    build.centred('3062b', DARK_GREY, 18, row, deck)
    build.centred('3062b', DARK_GREY, 23, row, deck)
  }
  let post = deck
  for (let course = 0; course < 3; course += 1) post = build.centred('3062b', DARK_GREY, 34, 17, post)
  const board = build.at('3022', WHITE, 34, 17, post)
  build.at('3068b', BLUE, 34, 17, board)
  for (let col = 27; col < 33; col += 4) build.at('3633', DARK_GREY, col, 31, deck)
  for (const spot of TABLES) {
    let top = ground(spot.col, spot.row)
    for (let course = 0; course < 2; course += 1) top = build.centred('3062b', WHITE, spot.col, spot.row, top)
    const table = build.at('3022', WHITE, spot.col, spot.row, top)
    build.centred('3899', AZURE, spot.col, spot.row, table)
  }

  // -- People --------------------------------------------------------------
  build.section('people', 'step_8')
  for (const person of CROWD) {
    figure(build, person.col, person.row, ground(person.col, person.row), person, person.rotationY)
  }
  for (const prop of PROPS) build.at(prop.id, prop.color, prop.col, prop.row, ground(prop.col, prop.row))

  return assemble(build.parts, 'Meridian Green', 1)
}

function assemble(parts: PartInstance[], name: string, revision: number): ModelDocument {
  const subassemblies: Record<string, Subassembly> = {}
  for (const definition of SUBASSEMBLIES) {
    subassemblies[definition.id] = {
      ...definition,
      partIds: parts.filter((part) => part.subassemblyId === definition.id).map((part) => part.id),
    }
  }
  const steps: BuildStep[] = STEPS.map((step) => ({
    ...step,
    partIds: parts.filter((part) => part.stepId === step.id).map((part) => part.id),
  }))
  const timestamp = new Date().toISOString()
  const document: ModelDocument = {
    schemaVersion: 2,
    id: `doc_${name.toLowerCase().replace(/\W+/g, '_')}`,
    name,
    revision,
    catalogVersion: catalog.version,
    createdAt: timestamp,
    updatedAt: timestamp,
    parts: Object.fromEntries(parts.map((part) => [part.id, part])),
    connections: {},
    subassemblies,
    steps,
    notes: [
      {
        id: 'note_1',
        anchorPartIds: parts.filter((part) => part.subassemblyId === 'structure').slice(0, 8).map((part) => part.id),
        text: 'Structure is signed off. Change the facade, the roof and the park freely; leave the frame alone.',
        status: 'open',
        author: 'human',
        revisionCreated: 1,
      },
    ],
    constraints: [
      {
        id: 'c_size',
        // Two studs of slack: foliage and railings overhang the deck by design,
        // and a hard envelope measured to the millimetre fails the document the
        // editor opens on for a leaf hanging over the kerb.
        kind: 'dimensions',
        label: `Site envelope ${PLAN.cols + 2} × ${PLAN.rows + 2} studs`,
        value: { width: PLAN.cols + 2, depth: PLAN.rows + 2 },
        hard: true,
      },
      { id: 'c_lock', kind: 'locked-region', label: 'Building structure locked', value: 'structure', hard: true },
    ],
  }
  document.connections = deriveConnectionEdges(document, revision, 'import-inferred')
  return document
}
