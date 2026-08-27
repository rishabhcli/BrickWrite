import { catalog, originForSurface, STUD_LDU, studPlaneLdu, underPlaneLdu } from './catalog'
import { createId } from './ids'
import { IDENTITY_BASIS } from './math'
import { QUARTER_TURN_BASES } from './placement'
import type { Actor, CadOperation, ConnectionFeature, PartDefinition, PartInstance, Vec3 } from './types'

/**
 * Parametric assembly: one instruction, hundreds of correctly-bonded bricks.
 *
 * Everything above the kernel had been per-part. An agent building a tower had
 * to author every brick's coordinates itself, which is slow, and — far worse —
 * it is the point where quality is lost: a model authored brick-by-brick by a
 * language model has stacked seams, unbonded courses and walls that are a
 * single stud thick because nothing was tracking the bond.
 *
 * This module is the layer that removes that work *and* that failure mode. It
 * emits ordinary `part.add` operations, so everything downstream is unchanged:
 * the kernel still checks revisions, protected regions, hard constraints and
 * collisions, and the result can be previewed as a ghost before it is accepted.
 * What it adds is the part of bricklaying that is a solved problem and should
 * never have been the caller's job:
 *
 *   - **running bond** — courses are offset so no vertical seam runs through
 *     two courses, which is what makes a wall a wall rather than a stack of
 *     columns. This is enforced by searching lead offsets and *verified*, not
 *     assumed.
 *   - **exact coverage** — a run is partitioned into real part lengths that sum
 *     to the run, drawn from what this build can actually place.
 *   - **corner interlock** — an enclosure alternates which pair of walls runs
 *     full length each course, so the corners tie together.
 *   - **openings** — doors and windows are spans a course skips, so a facade is
 *     a facade instead of a slab.
 *
 * Nothing here estimates or approximates. Where it cannot do something — a run
 * it cannot cover exactly, a course whose seams it could not fully stagger — it
 * reports that in the plan rather than quietly producing a worse wall.
 */

/**
 * Window and door elements the pack can seat in an opening.
 *
 * A cut opening is a hole; a real facade has an element in it. These are chosen
 * by measured footprint rather than by name, so the generator can say exactly
 * which openings it can furnish and which it can only cut.
 */
export type ElementKind = 'window' | 'door'

export interface WallElement {
  readonly definition: PartDefinition
  readonly widthStuds: number
  /** Whole brick courses the element occupies. */
  readonly courses: number
}

/** Course height of the standard brick, which every element is sized against. */
const BRICK_COURSE_LDU = 24

/** The most-used hinge in the library, and the one the kernel already drives. */
const HINGE_BASE_ID = '3937'
const HINGE_TOP_ID = '3938'

/**
 * Elements of a kind, indexed by footprint.
 *
 * Height is read from the compiled bounds rather than the part name: an element
 * that occupies 48 LDU of wall is two courses tall whatever it is called.
 */
export function elementLibrary(kind: ElementKind): WallElement[] {
  const wanted = kind === 'window' ? /^Window \d/ : /^Door Frame \d/
  const found: WallElement[] = []
  for (const definition of catalog.placeable()) {
    if (definition.category !== 'Windows and Doors' || !wanted.test(definition.name)) continue
    const studs = definition.dimensions?.studs
    const bounds = definition.dimensions?.bounds
    if (!studs || !bounds) continue
    const widthStuds = studs[0]
    if (!Number.isInteger(widthStuds)) continue
    // LDraw part origins sit at the stud plane, so the element's body runs from
    // 0 down to `bounds.max[1]`; the negative minimum is the studs on top of it.
    const heightLdu = bounds.max[1]
    const courses = Math.round(heightLdu / BRICK_COURSE_LDU)
    if (courses < 1 || Math.abs(courses * BRICK_COURSE_LDU - heightLdu) > 1) continue
    // A frame that is not one stud deep does not sit in a one-stud wall.
    if (Math.abs(studs[2] - 1) > 0.01) continue
    found.push({ definition, widthStuds, courses })
  }
  return found.sort((a, b) => b.definition.frequency - a.definition.frequency)
}

/**
 * The pane that goes in a frame, and where it sits relative to it.
 *
 * Matched geometrically rather than by name: a frame that offers a `generic`
 * socket and a pane that offers the matching plug, whose compiled envelope fits
 * inside the frame's. That is the same relationship the connector solver would
 * find, computed directly because the offset between two known connectors is
 * exact and does not need searching for.
 *
 * A frame with no socket — the taller windows carry a hinge for a shutter
 * instead — simply has no pane, and the plan says so rather than glazing it
 * with something that does not fit.
 */
export function paneFor(element: WallElement): { definition: PartDefinition; offsetLdu: Vec3 } | null {
  const socket = element.definition.connectors.find(
    (feature) => feature.family === 'generic' && feature.gender === 'female',
  )
  const frameBounds = element.definition.dimensions?.bounds
  if (!socket || !frameBounds) return null

  let best: { definition: PartDefinition; plug: ConnectionFeature } | null = null
  for (const candidate of catalog.placeable()) {
    if (candidate.canonicalId === element.definition.canonicalId) continue
    const bounds = candidate.dimensions?.bounds
    if (!bounds) continue
    const plugs = candidate.connectors.filter((feature) => feature.family === 'generic' && feature.gender === 'male')
    // A pane is inert: one plug and nothing else to attach to.
    if (plugs.length !== 1 || candidate.connectors.length !== 1) continue
    const fits = [0, 1, 2].every((axis) => bounds.min[axis] >= frameBounds.min[axis] - 0.01 && bounds.max[axis] <= frameBounds.max[axis] + 0.01)
    if (!fits) continue
    // Fitting inside is not enough: a 1 × 2 pane fits inside a 1 × 4 × 6 door
    // frame and glazes nothing. A pane exists to fill its opening, so it has to
    // be most of the frame's width and height, which is what tells the two
    // apart without either being named here.
    const fills = (axis: number, ratio: number) =>
      (bounds.max[axis] - bounds.min[axis]) >= (frameBounds.max[axis] - frameBounds.min[axis]) * ratio
    if (!fills(0, 0.6) || !fills(1, 0.5)) continue
    if (!best || candidate.frequency > best.definition.frequency) best = { definition: candidate, plug: plugs[0] }
  }
  if (!best) return null
  return {
    definition: best.definition,
    offsetLdu: [
      socket.pos[0] - best.plug.pos[0],
      socket.pos[1] - best.plug.pos[1],
      socket.pos[2] - best.plug.pos[2],
    ],
  }
}

/**
 * The best element for an opening.
 *
 * Exact width is required — a frame narrower than its hole leaves a gap and one
 * wider will not fit — while the course span is taken from the element, because
 * an opening exists to hold it rather than the other way round.
 */
export function chooseElement(kind: ElementKind, widthStuds: number, maxCourses?: number): WallElement | null {
  const candidates = elementLibrary(kind).filter(
    (element) => element.widthStuds === widthStuds && (maxCourses === undefined || element.courses <= maxCourses),
  )
  // Tallest that fits, then most used, so a three-course hole gets a
  // three-course window rather than a two-course one floating in it.
  return candidates.sort((a, b) => b.courses - a.courses || b.definition.frequency - a.definition.frequency)[0] ?? null
}

export type BrickFamily = 'brick' | 'plate' | 'tile'

/** Measured stud height of each family, used to pick parts by shape not by name. */
const FAMILY_HEIGHT_STUDS: Record<BrickFamily, number> = { brick: 3.5, plate: 1.5, tile: 1 }

export interface FamilyLibrary {
  readonly family: BrickFamily
  readonly depthStuds: number
  /** Vertical pitch in LDU: how far the next course sits above this one. */
  readonly courseLdu: number
  /** Part lengths in studs, longest first. */
  readonly lengths: readonly number[]
  readonly definitionFor: (lengthStuds: number) => PartDefinition | undefined
}

/**
 * The parts this build can actually lay, chosen by measured shape.
 *
 * Selecting by name would be guesswork across 900 compiled parts; selecting by
 * the compiled envelope is exact. Where several parts share a footprint the
 * most-used one wins, which is how "Brick 1 x 2" beats "Brick 1 x 2 without
 * Bottom Tube" without either being named here.
 */
export function familyLibrary(family: BrickFamily, depthStuds: number): FamilyLibrary | null {
  const targetHeight = FAMILY_HEIGHT_STUDS[family]
  const best = new Map<number, PartDefinition>()
  for (const definition of catalog.placeable()) {
    const studs = definition.dimensions?.studs
    if (!studs) continue
    const [length, height, depth] = studs
    if (!Number.isInteger(length) || length < 1) continue
    if (Math.abs(height - targetHeight) > 0.01 || Math.abs(depth - depthStuds) > 0.01) continue
    // Everything laid has to sit on studs; everything laid *on* needs studs of
    // its own, which is exactly the difference between a tile and a plate.
    const families = new Set(definition.connectors.map((feature) => feature.family))
    if (!families.has('anti-stud')) continue
    if (family !== 'tile' && !families.has('stud')) continue
    const incumbent = best.get(length)
    if (!incumbent || definition.frequency > incumbent.frequency) best.set(length, definition)
  }
  if (!best.size) return null

  const sample = best.values().next().value as PartDefinition
  const courseLdu = underPlaneLdu(sample) - (studPlaneLdu(sample) ?? 0)
  return {
    family,
    depthStuds,
    courseLdu: courseLdu > 0 ? courseLdu : STUD_LDU,
    lengths: [...best.keys()].sort((a, b) => b - a),
    definitionFor: (lengthStuds) => best.get(lengthStuds),
  }
}

/** Cumulative interior seam positions of a partitioned run, in studs. */
export function seamsOf(parts: readonly number[]): number[] {
  const seams: number[] = []
  let at = 0
  for (let index = 0; index < parts.length - 1; index += 1) {
    at += parts[index]
    seams.push(at)
  }
  return seams
}

/** Greedy longest-first cover of `run`, after an optional lead part. */
function partitionRun(run: number, lengths: readonly number[], lead: number): number[] {
  const parts: number[] = []
  let remaining = run
  if (lead > 0 && lead <= remaining && lengths.includes(lead)) {
    parts.push(lead)
    remaining -= lead
  }
  while (remaining > 0) {
    const next = lengths.find((length) => length <= remaining)
    if (next === undefined) break
    parts.push(next)
    remaining -= next
  }
  return parts
}

export interface CoursePlan {
  readonly parts: number[]
  /** Seams this course shares with the one below. Zero is a bonded course. */
  readonly sharedSeams: number
  /** True when the parts sum to the requested run exactly. */
  readonly exact: boolean
}

/**
 * Lays one course of a run, staggered against the course below it.
 *
 * Lead offsets are tried in the order a bricklayer would: a half-length lead
 * first, since that *is* running bond, then the other available lengths, then
 * no lead at all. The first lead that shares no seam with the course below
 * wins; if none does, the least-shared one is used and the shortfall is
 * reported rather than hidden.
 */
export function planCourse(
  run: number,
  lengths: readonly number[],
  previousSeams: ReadonlySet<number>,
  startStud = 0,
): CoursePlan {
  const longest = lengths[0] ?? 1
  const candidates = [...lengths]
    .sort((a, b) => Math.abs(a - longest / 2) - Math.abs(b - longest / 2) || b - a)
    .concat(0)

  let fallback: CoursePlan | null = null
  for (const lead of candidates) {
    const parts = partitionRun(run, lengths, lead)
    const exact = parts.reduce((sum, value) => sum + value, 0) === run
    if (!exact) continue
    const shared = seamsOf(parts).filter((seam) => previousSeams.has(startStud + seam)).length
    if (shared === 0) return { parts, sharedSeams: 0, exact: true }
    if (!fallback || shared < fallback.sharedSeams || (shared === fallback.sharedSeams && parts.length < fallback.parts.length)) {
      fallback = { parts, sharedSeams: shared, exact: true }
    }
  }
  if (fallback) return fallback
  const parts = partitionRun(run, lengths, 0)
  return { parts, sharedSeams: seamsOf(parts).filter((seam) => previousSeams.has(startStud + seam)).length, exact: false }
}

/** A contiguous stretch of a course, in studs from the wall's start. */
export interface Span {
  readonly from: number
  readonly to: number
}

export interface Opening {
  /** Stud offset of the opening's left edge along the wall. */
  readonly atStud: number
  readonly widthStuds: number
  /** Inclusive course range the opening cuts through, counting from 0. */
  readonly fromCourse: number
  readonly toCourse: number
  /**
   * Seat a real window or door frame in the hole.
   *
   * When set, the element decides the course span: an opening exists to hold
   * one, and a frame that does not reach the top of its hole leaves a gap the
   * kernel would then have to be told to ignore.
   */
  readonly element?: ElementKind
}

/** Resolves an opening's course span, letting a seated element set its height. */
export function resolveOpening(opening: Opening): { opening: Opening; element: WallElement | null } {
  if (!opening.element) return { opening, element: null }
  const requested = opening.toCourse - opening.fromCourse + 1
  const element = chooseElement(opening.element, opening.widthStuds, Math.max(1, requested))
  if (!element) return { opening: { ...opening, element: undefined }, element: null }
  return {
    opening: { ...opening, toCourse: opening.fromCourse + element.courses - 1 },
    element,
  }
}

/** The stretches of a course left solid once its openings are cut out. */
export function courseSpans(lengthStuds: number, course: number, openings: readonly Opening[]): Span[] {
  const cuts = openings
    .filter((opening) => course >= opening.fromCourse && course <= opening.toCourse)
    .map((opening) => ({
      from: Math.max(0, Math.min(lengthStuds, opening.atStud)),
      to: Math.max(0, Math.min(lengthStuds, opening.atStud + opening.widthStuds)),
    }))
    .filter((cut) => cut.to > cut.from)
    .sort((a, b) => a.from - b.from)

  const spans: Span[] = []
  let at = 0
  for (const cut of cuts) {
    if (cut.from > at) spans.push({ from: at, to: cut.from })
    at = Math.max(at, cut.to)
  }
  if (at < lengthStuds) spans.push({ from: at, to: lengthStuds })
  return spans
}

/** LDraw White: the default trim, as most real window and door frames are. */
export const DEFAULT_TRIM_COLOR = 15
/** LDraw Trans-Clear: glazing is glazing, not a painted panel. */
export const DEFAULT_GLASS_COLOR = 47

export interface AssemblySpec {
  /**
   * Document-space LDU corner the assembly grows from: minimum X, minimum Z,
   * and the Y of the surface its first course rests on.
   */
  readonly origin: Vec3
  readonly color: number
  /**
   * Colour for seated window and door frames.
   *
   * Frames left in the wall colour read as recesses rather than windows, which
   * is the single thing that stops a generated facade looking like a building.
   */
  readonly trimColor?: number
  /** Colour for glazing. Trans-Clear unless the caller wants tinted glass. */
  readonly glassColor?: number
  readonly family?: BrickFamily
  readonly depthStuds?: number
  readonly subassemblyId: string
  readonly stepId: string
  readonly actor: Actor
}

export interface WallSpec extends AssemblySpec {
  readonly axis: 'x' | 'z'
  readonly lengthStuds: number
  readonly courses: number
  readonly openings?: readonly Opening[]
}

export interface AssemblyPlan {
  readonly operations: CadOperation[]
  readonly partIds: string[]
  readonly partCount: number
  readonly courses: number
  /** How many parts of each definition the plan uses, most-used first. */
  readonly bill: Array<{ definitionId: string; name: string; count: number }>
  /** Courses whose seams could not be fully staggered against the one below. */
  readonly unbondedCourses: number
  readonly notes: string[]
  readonly warnings: string[]
}

/** Accumulates operations and the honest report that goes with them. */
class PlanBuilder {
  readonly operations: CadOperation[] = []
  readonly partIds: string[] = []
  readonly notes: string[] = []
  readonly warnings: string[] = []
  courses = 0
  unbondedCourses = 0
  private readonly counts = new Map<string, number>()

  constructor(private readonly spec: AssemblySpec) {}

  /** Places a part at an already-resolved origin, bypassing the surface rest. */
  placeAt(definition: PartDefinition, x: number, y: number, z: number, rotated: boolean, color?: number) {
    const part: PartInstance = {
      id: createId(`${this.spec.actor}_gen`),
      definitionId: definition.canonicalId,
      color: color ?? this.spec.color,
      transform: { position: [x, y, z], basis: rotated ? QUARTER_TURN_BASES[1] : IDENTITY_BASIS },
      subassemblyId: this.spec.subassemblyId,
      stepId: this.spec.stepId,
      provenance: this.spec.actor,
      protected: false,
    }
    this.operations.push({ type: 'part.add', part })
    this.partIds.push(part.id)
    this.counts.set(definition.canonicalId, (this.counts.get(definition.canonicalId) ?? 0) + 1)
  }

  place(definition: PartDefinition, centreX: number, surfaceY: number, centreZ: number, rotated: boolean, color?: number) {
    const part: PartInstance = {
      id: createId(`${this.spec.actor}_gen`),
      definitionId: definition.canonicalId,
      color: color ?? this.spec.color,
      transform: {
        position: [centreX, originForSurface(definition, surfaceY), centreZ],
        basis: rotated ? QUARTER_TURN_BASES[1] : IDENTITY_BASIS,
      },
      subassemblyId: this.spec.subassemblyId,
      stepId: this.spec.stepId,
      provenance: this.spec.actor,
      protected: false,
    }
    this.operations.push({ type: 'part.add', part })
    this.partIds.push(part.id)
    this.counts.set(definition.canonicalId, (this.counts.get(definition.canonicalId) ?? 0) + 1)
  }

  finish(): AssemblyPlan {
    return {
      operations: this.operations,
      partIds: this.partIds,
      partCount: this.partIds.length,
      courses: this.courses,
      bill: [...this.counts.entries()]
        .map(([definitionId, count]) => ({ definitionId, name: catalog.get(definitionId)?.name ?? definitionId, count }))
        .sort((a, b) => b.count - a.count || a.definitionId.localeCompare(b.definitionId)),
      unbondedCourses: this.unbondedCourses,
      notes: this.notes,
      warnings: this.warnings,
    }
  }
}

export class AssemblyError extends Error {
  constructor(readonly code: 'NO_FAMILY' | 'INVALID_SPEC' | 'RESOURCE_LIMIT', message: string, readonly repair: string) {
    super(message)
    this.name = 'AssemblyError'
  }
}

/** Hard ceiling on one generated assembly, so a typo cannot author a million bricks. */
export const MAX_GENERATED_PARTS = 4000

function resolveLibrary(spec: AssemblySpec): FamilyLibrary {
  const family = spec.family ?? 'brick'
  const depth = spec.depthStuds ?? 1
  const library = familyLibrary(family, depth)
  if (!library) {
    throw new AssemblyError(
      'NO_FAMILY',
      `This build has no compiled ${family} parts ${depth} studs deep.`,
      'Choose family "brick", "plate" or "tile" with depthStuds 1 or 2, which the compiled pack covers.',
    )
  }
  return library
}

/**
 * Lays one wall: `courses` rows of bonded brickwork along an axis.
 *
 * Course `c` sits `c` pitches above the origin surface. LDraw is Y-down, so
 * "above" is a decreasing Y, which is why the pitch is subtracted rather than
 * added — getting that backwards builds the wall into the ground.
 */
export function planWall(spec: WallSpec): AssemblyPlan {
  const library = resolveLibrary(spec)
  const length = Math.trunc(spec.lengthStuds)
  const courses = Math.trunc(spec.courses)
  if (length < 1 || courses < 1) {
    throw new AssemblyError('INVALID_SPEC', 'A wall needs at least one stud of length and one course.', 'Send lengthStuds ≥ 1 and courses ≥ 1.')
  }
  const builder = new PlanBuilder(spec)
  const resolved = resolveOpenings(builder, spec.openings ?? [])
  layWall(builder, library, spec, length, courses, resolved.openings, 0)
  seatElements(builder, spec, resolved, 0, library.depthStuds)
  builder.courses = courses
  return builder.finish()
}

interface ResolvedOpenings {
  readonly openings: Opening[]
  readonly elements: Array<{ opening: Opening; element: WallElement }>
}

/** Resolves every opening's element and course span, reporting what it could not seat. */
function resolveOpenings(builder: PlanBuilder, requested: readonly Opening[]): ResolvedOpenings {
  const openings: Opening[] = []
  const elements: Array<{ opening: Opening; element: WallElement }> = []
  for (const raw of requested) {
    const { opening, element } = resolveOpening(raw)
    openings.push(opening)
    if (element) elements.push({ opening, element })
    else if (raw.element) {
      builder.warnings.push(
        `No ${raw.element} frame ${raw.widthStuds} studs wide is compiled in this build, so that opening is a bare hole.`,
      )
    }
  }
  if (openings.length) {
    builder.notes.push(
      elements.length
        ? `${openings.length} opening(s) cut, ${elements.length} with a real frame seated in them.`
        : `${openings.length} opening(s) cut through the courses they span.`,
    )
  }
  return { openings, elements }
}

/** Places the resolved window and door frames into the holes left for them. */
function seatElements(
  builder: PlanBuilder,
  spec: WallSpec,
  resolved: ResolvedOpenings,
  perpStuds: number,
  wallDepthStuds: number,
) {
  for (const { opening, element } of resolved.elements) {
    // A frame is one stud deep; in a thicker wall it sits on the outer face.
    const across = (perpStuds + 0.5) * STUD_LDU
    const along = (opening.atStud + element.widthStuds / 2) * STUD_LDU
    const surfaceY = spec.origin[1] - opening.fromCourse * BRICK_COURSE_LDU
    void wallDepthStuds
    const rotated = spec.axis !== 'x'
    const frameX = rotated ? spec.origin[0] + across : spec.origin[0] + along
    const frameZ = rotated ? spec.origin[2] + along : spec.origin[2] + across
    builder.place(element.definition, frameX, surfaceY, frameZ, rotated, spec.trimColor ?? DEFAULT_TRIM_COLOR)

    // Glazing, where the frame has a socket for it. An unglazed frame is a
    // hole with a surround; a glazed one is a window.
    const pane = paneFor(element)
    if (!pane) {
      builder.notes.push(`${element.definition.name} has no compiled pane in this build, so it is left unglazed.`)
      continue
    }
    const frameY = originForSurface(element.definition, surfaceY)
    // The frame's own quarter turn maps local +X onto world -Z, so the pane's
    // offset has to travel through the same rotation to stay in the frame.
    const offsetX = rotated ? pane.offsetLdu[2] : pane.offsetLdu[0]
    const offsetZ = rotated ? -pane.offsetLdu[0] : pane.offsetLdu[2]
    builder.placeAt(
      pane.definition,
      frameX + offsetX,
      frameY + pane.offsetLdu[1],
      frameZ + offsetZ,
      rotated,
      spec.glassColor ?? DEFAULT_GLASS_COLOR,
    )
  }
}

/**
 * Lays `courses` rows into `builder`, returning nothing.
 *
 * Shared by the wall and the enclosure so the two cannot bond differently; the
 * enclosure only varies the span each course covers.
 */
function layWall(
  builder: PlanBuilder,
  library: FamilyLibrary,
  spec: WallSpec,
  length: number,
  courses: number,
  openings: readonly Opening[],
  perpStuds: number,
  spansFor?: (course: number) => Span[],
) {
  // Every course's spans are resolved first, because the courses immediately
  // above and below an opening have to *bridge* its edges rather than place
  // their own seam there. Without that, a doorway's two edges continue as an
  // unbroken vertical joint through the whole wall and the run beside it comes
  // away as a separate column — which is exactly the failure a bond prevents,
  // and it is invisible until something tries to pick the model up.
  const allSpans: Span[][] = []
  for (let course = 0; course < courses; course += 1) {
    allSpans.push(spansFor ? spansFor(course) : courseSpans(length, course, openings))
  }
  /** Interior boundaries between a course's spans — the edges of its openings. */
  const spanEdges = (course: number): number[] => {
    const spans = allSpans[course]
    if (!spans) return []
    const edges: number[] = []
    for (const span of spans) {
      if (span.from > 0) edges.push(span.from)
      if (span.to < length) edges.push(span.to)
    }
    return edges
  }

  let previousSeams: Set<number> = new Set()
  for (let course = 0; course < courses; course += 1) {
    const spans = allSpans[course]
    const seams = new Set<number>()
    const forbidden = new Set<number>(previousSeams)
    for (const edge of spanEdges(course - 1)) forbidden.add(edge)
    for (const edge of spanEdges(course + 1)) forbidden.add(edge)
    const surfaceY = spec.origin[1] - course * library.courseLdu

    for (const span of spans) {
      const run = span.to - span.from
      if (run <= 0) continue
      const plan = planCourse(run, library.lengths, forbidden, span.from)
      if (!plan.exact) {
        builder.warnings.push(
          `Course ${course + 1} could not be covered exactly over ${run} studs with the available part lengths; ${plan.parts.reduce((s, v) => s + v, 0)} studs were laid.`,
        )
      }
      if (plan.sharedSeams > 0) {
        builder.unbondedCourses += 1
        builder.warnings.push(
          `Course ${course + 1} shares ${plan.sharedSeams} seam(s) with the course below over a ${run}-stud run; the available lengths do not permit a full stagger there.`,
        )
      }
      // A span's own edges are structural boundaries, not seams to stagger.
      for (const seam of seamsOf(plan.parts)) seams.add(span.from + seam)

      let at = span.from
      for (const partLength of plan.parts) {
        const definition = library.definitionFor(partLength)
        if (!definition) continue
        const along = (at + partLength / 2) * STUD_LDU
        const across = (perpStuds + library.depthStuds / 2) * STUD_LDU
        if (spec.axis === 'x') {
          builder.place(definition, spec.origin[0] + along, surfaceY, spec.origin[2] + across, false)
        } else {
          builder.place(definition, spec.origin[0] + across, surfaceY, spec.origin[2] + along, true)
        }
        at += partLength
      }
    }
    previousSeams = seams
    if (builder.partIds.length > MAX_GENERATED_PARTS) {
      throw new AssemblyError(
        'RESOURCE_LIMIT',
        `This assembly would place more than ${MAX_GENERATED_PARTS} parts.`,
        'Build it in sections, or reduce the footprint or course count.',
      )
    }
  }
}

export interface EnclosureSpec extends AssemblySpec {
  readonly widthStuds: number
  readonly footprintDepthStuds: number
  readonly courses: number
  readonly openings?: readonly Opening[]
  /** Lay a plate floor under the walls, so the storey has a deck to stand on. */
  readonly floor?: boolean
  /**
   * Layers in that floor, default 2.
   *
   * Two are cross-bonded into a rigid slab; one is cheaper and is held only
   * where the walls stand on it, leaving the middle of the deck loose. Two is
   * the default because a floor that falls apart when you pick the model up is
   * not a floor.
   */
  readonly floorLayers?: number
}

/**
 * Four interlocking walls, and optionally a floor: one storey.
 *
 * Corners alternate by course — on even courses the walls running along X take
 * the full width and the Z walls are inset, on odd courses the reverse — which
 * is how a real corner ties together instead of leaving a vertical joint at
 * every corner of the building.
 */
export function planEnclosure(spec: EnclosureSpec): AssemblyPlan {
  const library = resolveLibrary(spec)
  const width = Math.trunc(spec.widthStuds)
  const depth = Math.trunc(spec.footprintDepthStuds)
  const courses = Math.trunc(spec.courses)
  const wallDepth = library.depthStuds
  if (width < wallDepth * 2 + 1 || depth < wallDepth * 2 + 1) {
    throw new AssemblyError(
      'INVALID_SPEC',
      `A ${width} × ${depth} stud enclosure is too small for ${wallDepth}-stud walls.`,
      `Use a footprint of at least ${wallDepth * 2 + 1} × ${wallDepth * 2 + 1} studs.`,
    )
  }
  if (courses < 1) throw new AssemblyError('INVALID_SPEC', 'An enclosure needs at least one course.', 'Send courses ≥ 1.')

  const builder = new PlanBuilder(spec)
  const resolved = resolveOpenings(builder, spec.openings ?? [])
  const openings = resolved.openings

  // The floor is laid first and at full footprint, so the walls stand *on* it.
  // Laying it inside the walls instead left every plate touching nothing, which
  // is a floor in appearance only.
  let wallOrigin = spec.origin
  if (spec.floor) {
    const floorLibrary = resolveLibrary({ ...spec, family: 'plate', depthStuds: 1 })
    const before = builder.partIds.length
    layField(builder, {
      ...spec,
      family: 'plate',
      depthStuds: undefined,
      layers: spec.floorLayers ?? 2,
      widthStuds: width,
      footprintDepthStuds: depth,
    })
    const layers = Math.max(1, Math.min(2, Math.trunc(spec.floorLayers ?? 2)))
    wallOrigin = [spec.origin[0], spec.origin[1] - layers * floorLibrary.courseLdu, spec.origin[2]]
    builder.notes.push(`Floor laid under the walls: ${builder.partIds.length - before} plates in ${layers} layer(s).`)
  }

  for (const side of ['front', 'back', 'left', 'right'] as const) {
    const alongX = side === 'front' || side === 'back'
    const runLength = alongX ? width : depth
    const perp = side === 'front' || side === 'left' ? 0 : (alongX ? depth : width) - wallDepth
    const wallSpec: WallSpec = {
      ...spec,
      axis: alongX ? 'x' : 'z',
      lengthStuds: runLength,
      courses,
      origin: wallOrigin,
    }
    if (alongX) seatElements(builder, wallSpec, resolved, perp, wallDepth)
    layWall(builder, library, wallSpec, runLength, courses, openings, perp, (course) => {
      // Even courses: the X walls run full width, the Z walls are inset.
      // Odd courses: the reverse. That alternation is the interlock.
      const full = alongX ? course % 2 === 0 : course % 2 === 1
      const inset = full ? 0 : wallDepth
      const spans = courseSpans(runLength, course, side === 'front' || side === 'back' ? openings : [])
      return spans
        .map((span) => ({ from: Math.max(span.from, inset), to: Math.min(span.to, runLength - inset) }))
        .filter((span) => span.to > span.from)
    })
  }

  builder.courses = courses
  builder.notes.push('Corners interlock: the X walls and the Z walls alternate which runs full length each course.')
  return builder.finish()
}

export interface HingedFlapSpec extends AssemblySpec {
  /** Studs along the hinge line. Rounded up to whole 1 × 2 hinge bricks. */
  readonly widthStuds: number
  /** How far the flap reaches out from the hinge, in studs. */
  readonly reachStuds: number
}

/**
 * A flap that actually opens.
 *
 * Structure is only half of what a model does; a City building has shutters
 * that swing, a hatch that lifts, a roof that comes off. Those are hinges, and
 * the kernel already drives them — `findArticulatedJoints` reads the persisted
 * connection graph and `articulate_joint` rotates the moving island. What was
 * missing is anything that *builds* one.
 *
 * A hinge brick pair is the honest choice here. The compiled door leaves cannot
 * be seated automatically: LDCad records both the door frame's knuckles and the
 * leaf's pin as `hinge:male`, so the two do not pair and no amount of solving
 * will make them. The 1 × 2 hinge brick and its top plate do pair, are the most
 * used hinge in the library, and produce a joint the kernel finds and moves.
 */
export function planHingedFlap(spec: HingedFlapSpec): AssemblyPlan {
  const hingeBase = catalog.get(HINGE_BASE_ID)
  const hingeTop = catalog.get(HINGE_TOP_ID)
  if (!hingeBase || !hingeTop) {
    throw new AssemblyError(
      'NO_FAMILY',
      'This build has no compiled hinge bricks, so it cannot make a moving flap.',
      'Widen the geometry pack to include 3937 and 3938, or place the hinge by hand.',
    )
  }
  const width = Math.trunc(spec.widthStuds)
  const reach = Math.trunc(spec.reachStuds)
  if (width < 2 || reach < 1) {
    throw new AssemblyError('INVALID_SPEC', 'A flap needs at least two studs of hinge and one stud of reach.', 'Send widthStuds ≥ 2 and reachStuds ≥ 1.')
  }

  const builder = new PlanBuilder(spec)
  const knuckles = Math.floor(width / 2)
  if (knuckles * 2 !== width) {
    builder.warnings.push(`A hinge line is built from 1 × 2 bricks, so ${width} studs was laid as ${knuckles * 2}.`)
  }

  // The hinge pair shares one origin: their knuckles are the same connector, so
  // the base and the top plate sit at the same point and interleave there.
  const hingeOrigin = originForSurface(hingeBase, spec.origin[1])
  for (let index = 0; index < knuckles; index += 1) {
    const x = spec.origin[0] + (index * 2 + 1) * STUD_LDU
    const z = spec.origin[2] + STUD_LDU / 2
    builder.placeAt(hingeBase, x, hingeOrigin, z, false)
    builder.placeAt(hingeTop, x, hingeOrigin, z, false)
  }

  // The flap rests on the top plates' studs, and reaches out from the hinge.
  const flapSurface = hingeOrigin + (studPlaneLdu(hingeTop) ?? 0)
  layField(builder, {
    ...spec,
    family: 'plate',
    depthStuds: undefined,
    widthStuds: knuckles * 2,
    footprintDepthStuds: reach,
    origin: [spec.origin[0], flapSurface, spec.origin[2]],
  })

  builder.courses = 1
  builder.notes.push(
    `${knuckles} hinge pair(s) on a ${knuckles * 2} × ${reach} stud flap. `
    + 'The joint is a real revolute in the connection graph, so it can be driven from the inspector or by the agent.',
  )
  return builder.finish()
}

export interface FieldSpec extends AssemblySpec {
  readonly widthStuds: number
  readonly footprintDepthStuds: number
  /**
   * How many layers deep to lay the field.
   *
   * One layer is what a floor usually is, and it is genuinely loose in the
   * middle: plates side by side in a single plane do not clutch each other, so
   * only the perimeter is held by whatever is built on it. Two layers are
   * cross-bonded — the upper rows straddle the lower rows' seams and the runs
   * are staggered — which makes a rigid slab at twice the piece count.
   */
  readonly layers?: number
}

/**
 * Tiles a rectangular footprint one layer deep — a floor, a roof, a baseplate.
 *
 * Rows are laid along X and staggered against the row before them, for the same
 * reason courses are: a field of aligned seams is a grid of loose strips.
 */
export function planBrickField(spec: FieldSpec): AssemblyPlan {
  const builder = new PlanBuilder(spec)
  layField(builder, spec)
  builder.courses = 1
  return builder.finish()
}

function layField(builder: PlanBuilder, spec: FieldSpec) {
  const width = Math.trunc(spec.widthStuds)
  const depth = Math.trunc(spec.footprintDepthStuds)
  const layers = Math.max(1, Math.min(2, Math.trunc(spec.layers ?? 1)))
  if (width < 1 || depth < 1) {
    throw new AssemblyError('INVALID_SPEC', 'A field needs a footprint of at least one stud.', 'Send widthStuds ≥ 1 and depthStuds ≥ 1.')
  }
  // Two-deep parts halve the piece count and bridge more seams, so they are the
  // default wherever the footprint allows an exact number of rows.
  const preferredDepth = spec.depthStuds ?? 2
  const family = spec.family ?? 'plate'
  const pitch = resolveLibrary({ ...spec, family, depthStuds: 1 }).courseLdu
  let rows = 0

  for (let layer = 0; layer < layers; layer += 1) {
    // The upper layer starts with a half-depth row, so its row boundaries fall
    // between the lower layer's. That is what turns two loose sheets into one
    // slab: every seam below is spanned by a part above.
    const offset = layer % 2 === 1 ? 1 : 0
    const surfaceY = spec.origin[1] - layer * pitch
    let previousSeams: Set<number> = new Set()
    let z = 0
    while (z < depth) {
      const wanted = z === 0 && offset ? offset : preferredDepth
      const rowDepth = Math.min(wanted, depth - z)
      const library = resolveLibrary({ ...spec, family, depthStuds: rowDepth })
      const plan = planCourse(width, library.lengths, previousSeams)
      if (!plan.exact) {
        builder.warnings.push(`Row ${rows + 1} could not be covered exactly over ${width} studs with the available part lengths.`)
      }
      if (plan.sharedSeams > 0) builder.unbondedCourses += 1

      let at = 0
      for (const partLength of plan.parts) {
        const definition = library.definitionFor(partLength)
        if (!definition) continue
        builder.place(
          definition,
          spec.origin[0] + (at + partLength / 2) * STUD_LDU,
          surfaceY,
          spec.origin[2] + (z + rowDepth / 2) * STUD_LDU,
          false,
        )
        at += partLength
      }
      previousSeams = new Set(seamsOf(plan.parts))
      z += rowDepth
      rows += 1
      if (builder.partIds.length > MAX_GENERATED_PARTS) {
        throw new AssemblyError(
          'RESOURCE_LIMIT',
          `This field would place more than ${MAX_GENERATED_PARTS} parts.`,
          'Lay it in sections, or reduce the footprint.',
        )
      }
    }
  }

  builder.notes.push(
    layers > 1
      ? `${rows} row(s) across ${layers} cross-bonded layers, so the slab is rigid rather than loose plates.`
      : `${rows} row(s) laid in one layer. A single layer is held only where something is built on it — pass layers: 2 for a rigid slab.`,
  )
}
