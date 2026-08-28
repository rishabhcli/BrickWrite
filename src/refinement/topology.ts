import { catalog, STUD_LDU, studPlaneLdu, surfaceAbove } from '../cad/catalog'
import { seamsOf } from '../cad/assembly'
import { getPartBounds, type PartBounds } from '../cad/geometry'
import { deriveConnections } from '../cad/snapping'
import type { ModelDocument, PartInstance, Vec3 } from '../cad/types'

/**
 * Reading brickwork back out of a document.
 *
 * The kernel stores parts and connections; it does not store "this is a course",
 * "these two seams line up" or "that is a staircase". Those are the things a
 * refinement is asked about, so they have to be *recovered* — and recovered from
 * measured geometry, because a model that arrives from an importer, an agent or
 * a person dragging bricks carries no record of how it was laid.
 *
 * Everything here works from compiled bounds and the connector planes the
 * catalog publishes. Nothing infers a course from a part's name.
 */

/** Coordinates are compared at a tenth of an LDU: finer than any placement. */
const EPS = 0.1

/** Two undersides within one brick course of each other are vertically adjacent. */
const COURSE_REACH_LDU = 26

const round = (value: number) => Math.round(value * 10) / 10

export interface PlacedPart {
  readonly part: PartInstance
  readonly bounds: PartBounds
}

/** Measured parts of a document, or of a subset, in stable id order. */
export function placedParts(document: ModelDocument, partIds?: Iterable<string>): PlacedPart[] {
  const ids = partIds ? [...partIds] : Object.keys(document.parts)
  const out: PlacedPart[] = []
  for (const id of [...ids].sort()) {
    const part = document.parts[id]
    if (!part) continue
    const bounds = getPartBounds(part)
    if (!bounds.measured) continue
    out.push({ part, bounds })
  }
  return out
}

export type RowAxis = 'x' | 'z'

export interface Row {
  readonly key: string
  readonly axis: RowAxis
  /** Underside plane, in LDU. LDraw is Y-down, so this is the row's greatest Y. */
  readonly underY: number
  /** Perpendicular extent shared by every member, in LDU. */
  readonly across: readonly [number, number]
  /** Members ordered along the row axis. */
  readonly members: ReadonlyArray<{ readonly partId: string; readonly from: number; readonly to: number }>
  /** True when the members abut with no gap, which is what makes seams meaningful. */
  readonly contiguous: boolean
  readonly fromLdu: number
  readonly toLdu: number
}

/**
 * Groups parts into rows: same underside plane, same perpendicular footprint.
 *
 * Both axes are extracted, because a wall running along X and a wall running
 * along Z are the same structure seen from different sides and either can carry
 * a stacked seam. A part contributes to one row per axis; a row of one is kept
 * so that a lone brick still reports its course.
 */
export function extractRows(document: ModelDocument, partIds?: Iterable<string>): Row[] {
  const parts = placedParts(document, partIds)
  const buckets = new Map<string, Array<{ partId: string; from: number; to: number; across: [number, number]; underY: number; axis: RowAxis }>>()

  for (const { part, bounds } of parts) {
    for (const axis of ['x', 'z'] as const) {
      const along = axis === 'x' ? 0 : 2
      const across = axis === 'x' ? 2 : 0
      const entry = {
        partId: part.id,
        from: round(bounds.min[along]),
        to: round(bounds.max[along]),
        across: [round(bounds.min[across]), round(bounds.max[across])] as [number, number],
        underY: round(bounds.max[1]),
        axis,
      }
      const key = `${axis}|${entry.underY}|${entry.across[0]}|${entry.across[1]}`
      const bucket = buckets.get(key)
      if (bucket) bucket.push(entry)
      else buckets.set(key, [entry])
    }
  }

  const rows: Row[] = []
  for (const [key, members] of [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    members.sort((a, b) => a.from - b.from || a.partId.localeCompare(b.partId))
    let contiguous = true
    for (let index = 1; index < members.length; index += 1) {
      if (Math.abs(members[index].from - members[index - 1].to) > EPS) contiguous = false
    }
    rows.push({
      key,
      axis: members[0].axis,
      underY: members[0].underY,
      across: members[0].across,
      members: members.map(({ partId, from, to }) => ({ partId, from, to })),
      contiguous,
      fromLdu: members[0].from,
      toLdu: members[members.length - 1].to,
    })
  }
  return rows
}

export interface Seam {
  readonly rowKey: string
  readonly axis: RowAxis
  readonly underY: number
  readonly across: readonly [number, number]
  /** Document-space coordinate of the joint, along the row axis. */
  readonly atLdu: number
  /** The two parts the joint sits between. */
  readonly partIds: readonly [string, string]
}

/**
 * Interior joints of every contiguous row.
 *
 * The offsets come from `seamsOf` — the same function the assembly planner uses
 * to decide where a course's joints will fall — applied to the run's measured
 * part lengths. Using the planner's own accounting means a wall this module
 * calls unbonded is unbonded by the definition the planner was trying to satisfy.
 */
export function extractSeams(rows: readonly Row[]): Seam[] {
  const seams: Seam[] = []
  for (const row of rows) {
    if (!row.contiguous || row.members.length < 2) continue
    const lengths = row.members.map((member) => (member.to - member.from) / STUD_LDU)
    const offsets = seamsOf(lengths)
    offsets.forEach((offsetStuds, index) => {
      seams.push({
        rowKey: row.key,
        axis: row.axis,
        underY: row.underY,
        across: row.across,
        atLdu: round(row.fromLdu + offsetStuds * STUD_LDU),
        partIds: [row.members[index].partId, row.members[index + 1].partId],
      })
    })
  }
  return seams
}

export interface StackedSeam {
  readonly axis: RowAxis
  readonly atLdu: number
  readonly upperRowKey: string
  readonly lowerRowKey: string
  readonly partIds: readonly string[]
  readonly atPoint: Vec3
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > EPS

/**
 * Joints that run through two courses.
 *
 * A stacked seam is the structural failure a running bond exists to prevent:
 * the two courses are not tied to each other there, so the wall comes apart
 * along that line when it is picked up. Two seams count as stacked when they sit
 * at the same coordinate, on the same axis, in courses within one brick height
 * of each other, whose perpendicular footprints actually overlap.
 */
export function findStackedSeams(rows: readonly Row[]): StackedSeam[] {
  const seams = extractSeams(rows)
  const byRow = new Map(rows.map((row) => [row.key, row]))
  const stacked: StackedSeam[] = []
  const seen = new Set<string>()

  for (const upper of seams) {
    for (const lower of seams) {
      if (upper.axis !== lower.axis) continue
      const drop = lower.underY - upper.underY
      if (drop <= EPS || drop > COURSE_REACH_LDU) continue
      if (Math.abs(upper.atLdu - lower.atLdu) > 0.5) continue
      if (!overlaps(upper.across, lower.across)) continue
      const key = `${upper.rowKey}|${lower.rowKey}|${upper.atLdu}`
      if (seen.has(key)) continue
      seen.add(key)
      const upperRow = byRow.get(upper.rowKey)!
      const acrossMid = (upperRow.across[0] + upperRow.across[1]) / 2
      stacked.push({
        axis: upper.axis,
        atLdu: upper.atLdu,
        upperRowKey: upper.rowKey,
        lowerRowKey: lower.rowKey,
        partIds: [...upper.partIds, ...lower.partIds],
        atPoint:
          upper.axis === 'x'
            ? [upper.atLdu, upper.underY, acrossMid]
            : [acrossMid, upper.underY, upper.atLdu],
      })
    }
  }
  return stacked
}

/** Total interior joints, so bonding can be expressed as a ratio rather than a count. */
export const countSeams = (rows: readonly Row[]): number => extractSeams(rows).length

// ---------------------------------------------------------------------------
// Vertical relationships
// ---------------------------------------------------------------------------

const footprintOverlap = (a: PartBounds, b: PartBounds): number => {
  const x = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0])
  const z = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2])
  return x > EPS && z > EPS ? x * z : 0
}

/**
 * The exposed stud plane on top of a part, or null when nothing can stack on it.
 *
 * Read from the part's own compiled connectors rather than from its height, so a
 * tile reports nothing and a slope reports the plane its remaining studs are on.
 */
export function exposedStudPlane(part: PartInstance): number | null {
  return surfaceAbove(catalog.get(part.definitionId), part.transform.position[1])
}

/**
 * The plane something resting on this part would sit on.
 *
 * Not `bounds.min[1]`: a brick's minimum Y is the top of its *studs*, four LDU
 * above the face the next brick's underside actually meets. Using the bounding
 * box here would make every stacked pair look four LDU apart and every course
 * look like a separate island. The stud plane is read from the part's own
 * connectors; a studless element has none, and then the box top is the face.
 */
export function topPlaneOf(part: PartInstance): number {
  return exposedStudPlane(part) ?? getPartBounds(part).min[1]
}

export interface StepEdge {
  readonly lowerPartId: string
  readonly upperPartId: string | null
  /** Which face of the lower part the step exposes. */
  readonly side: '-x' | '+x' | '-z' | '+z'
  /** Exposed depth of the tread, in studs. */
  readonly treadStuds: number
  readonly atPoint: Vec3
}

/**
 * Staircases: a part whose top is only partly covered, at an outside edge.
 *
 * This is what "make it less blocky" is pointing at. The tread is measured, so a
 * one-stud step — which a 45° slope replaces exactly — is distinguished from a
 * three-stud shelf, which it does not.
 */
export function findStepEdges(document: ModelDocument, partIds?: Iterable<string>): StepEdge[] {
  const all = placedParts(document)
  const subject = new Set(partIds ? [...partIds] : Object.keys(document.parts))
  const steps: StepEdge[] = []

  for (const lower of all) {
    if (!subject.has(lower.part.id)) continue
    const topY = topPlaneOf(lower.part)
    const above = all.filter(
      (other) =>
        other.part.id !== lower.part.id &&
        Math.abs(other.bounds.max[1] - topY) <= 1 &&
        footprintOverlap(other.bounds, lower.bounds) > 0,
    )
    if (!above.length) continue

    for (const side of ['-x', '+x', '-z', '+z'] as const) {
      const axis = side === '-x' || side === '+x' ? 0 : 2
      const positive = side === '+x' || side === '+z'
      // How far the covering parts stop short of this face.
      const reach = positive
        ? Math.max(...above.map((other) => other.bounds.max[axis]))
        : Math.min(...above.map((other) => other.bounds.min[axis]))
      const tread = positive ? lower.bounds.max[axis] - reach : reach - lower.bounds.min[axis]
      if (tread <= STUD_LDU / 2) continue

      // Only an *outside* step reads as a staircase; an internal shelf inside the
      // model is not what "round this off" is about, and smoothing it would cut
      // into structure the outline never shows.
      const outside = !all.some(
        (other) =>
          other.part.id !== lower.part.id &&
          Math.abs(other.bounds.max[1] - lower.bounds.max[1]) <= 1 &&
          (positive ? other.bounds.min[axis] >= lower.bounds.max[axis] - EPS : other.bounds.max[axis] <= lower.bounds.min[axis] + EPS) &&
          footprintOverlapOnOtherAxis(other.bounds, lower.bounds, axis),
      )
      if (!outside) continue

      steps.push({
        lowerPartId: lower.part.id,
        upperPartId: above[0].part.id,
        side,
        treadStuds: Number((tread / STUD_LDU).toFixed(3)),
        atPoint: [
          axis === 0 ? (positive ? lower.bounds.max[0] : lower.bounds.min[0]) : (lower.bounds.min[0] + lower.bounds.max[0]) / 2,
          topY,
          axis === 2 ? (positive ? lower.bounds.max[2] : lower.bounds.min[2]) : (lower.bounds.min[2] + lower.bounds.max[2]) / 2,
        ],
      })
    }
  }
  return steps.sort((a, b) => a.lowerPartId.localeCompare(b.lowerPartId) || a.side.localeCompare(b.side))
}

function footprintOverlapOnOtherAxis(a: PartBounds, b: PartBounds, axis: number): boolean {
  const other = axis === 0 ? 2 : 0
  return Math.min(a.max[other], b.max[other]) - Math.max(a.min[other], b.min[other]) > EPS
}

// ---------------------------------------------------------------------------
// Free studs
// ---------------------------------------------------------------------------

export interface FreeStud {
  readonly partId: string
  readonly featureId: string
  /** Document-space position of the stud, in LDU. */
  readonly atLdu: Vec3
  /** Plane a part resting on this stud would sit on. */
  readonly surfaceY: number
}

/**
 * Studs on top of the model that nothing is using.
 *
 * Occupancy comes from the kernel's own connector derivation, so a stud under a
 * plate is never offered as a place to put a tile. Two further filters make the
 * result mean "a surface you could finish": the connector's axis has to be
 * vertical, which excludes the sideways stud on a bracket or a headlight — a
 * mounting point, not a surface — and it has to sit on the part's own top stud
 * plane, which excludes a stud pointing down out of an inverted part.
 *
 * The axis is *not* tested for sign. LDCad frames a stud along its own local +Y
 * whichever way the part is turned, so both faces of a stacked pair report the
 * same direction; the plane comparison is what actually distinguishes them.
 */
export function findFreeStuds(document: ModelDocument, partIds?: Iterable<string>): FreeStud[] {
  const derived = deriveConnections(document)
  const subject = new Set(partIds ? [...partIds] : Object.keys(document.parts))
  const free: FreeStud[] = []

  for (const connector of derived.connectors) {
    if (connector.family !== 'stud') continue
    if (!subject.has(connector.partId)) continue
    if (derived.occupied.has(`${connector.partId}/${connector.id}`)) continue
    if (Math.abs(connector.axis[1]) < 0.99) continue
    const local = studPlaneLdu(catalog.get(connector.definitionId))
    if (local === null) continue
    const surfaceY = document.parts[connector.partId].transform.position[1] + local
    if (Math.abs(connector.frame.position[1] - surfaceY) > 0.5) continue
    free.push({
      partId: connector.partId,
      featureId: connector.id,
      atLdu: connector.frame.position,
      surfaceY,
    })
  }
  return free.sort((a, b) => a.partId.localeCompare(b.partId) || a.featureId.localeCompare(b.featureId))
}

/** Grid-aligned stud centre, so two parts' studs can be compared as integers. */
export const studCell = (position: Vec3): string =>
  `${Math.round(position[0] / (STUD_LDU / 2))}:${Math.round(position[2] / (STUD_LDU / 2))}`

// ---------------------------------------------------------------------------
// Connector interfaces
// ---------------------------------------------------------------------------

/**
 * The connectors of `partId` that are currently carrying a mate, in the part's
 * own frame, quantized so two definitions can be compared for interface
 * equivalence.
 *
 * This is what makes a substitution safe: a candidate part that offers every
 * feature the incumbent is actually *using*, at the same local position and in
 * the same family, cannot break a connection that exists. Features the incumbent
 * has but is not using are irrelevant, which is exactly why a brick can become a
 * slope when nothing is stacked on it and cannot when something is.
 */
export function matedLocalFeatures(document: ModelDocument, partId: string): string[] {
  const definition = catalog.get(document.parts[partId]?.definitionId ?? '')
  if (!definition) return []
  const derived = deriveConnections(document)
  const used = new Set<string>()
  for (const pair of derived.pairs) {
    if (pair.a.partId === partId) used.add(pair.a.id)
    if (pair.b.partId === partId) used.add(pair.b.id)
  }
  const keys: string[] = []
  for (const feature of definition.connectors) {
    if (!used.has(feature.id)) continue
    keys.push(featureKey(feature.family, feature.gender, feature.pos))
  }
  return keys.sort()
}

export const featureKey = (family: string, gender: string, pos: Vec3): string =>
  `${family}:${gender}:${Math.round(pos[0] * 10)}:${Math.round(pos[1] * 10)}:${Math.round(pos[2] * 10)}`

/** Every local feature a definition offers, in the same quantized form. */
export function definitionFeatureKeys(definitionId: string): Set<string> {
  const definition = catalog.get(definitionId)
  if (!definition) return new Set()
  return new Set(definition.connectors.map((feature) => featureKey(feature.family, feature.gender, feature.pos)))
}
