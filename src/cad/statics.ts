import { catalog, STUD_LDU } from './catalog'
import { getPartBounds } from './geometry'
import { deriveConnections } from './snapping'
import type { ConnectionFamily, ModelDocument, PartInstance, Vec3 } from './types'

/**
 * Static physics: will the thing stand up, and what is holding it together?
 *
 * Collision answers "do two parts occupy the same space". It says nothing about
 * whether a model topples, whether a balcony is hanging off two studs, or how
 * much a stud is being asked to carry — which is the difference between a shape
 * that renders and a model that survives being picked up.
 *
 * Everything here is measured or explicitly labelled:
 *
 *   - **Mass** comes from the compiled mesh's exact enclosed volume, not from a
 *     bounding box a slope or a bracket does not fill. A part outside the
 *     geometry pack has no volume, so it is reported as unmeasured rather than
 *     estimated, and the report says how much of the model that covers.
 *   - **The support polygon** is the convex hull of everything resting on the
 *     lowest plane, which is what a model actually balances on.
 *   - **Clutch capacity** is a stated assumption, not a measurement: LEGO does
 *     not publish one. The default is deliberately conservative and is carried
 *     in the report so a reader can see what the verdict was computed against.
 */

/**
 * Density of ABS, in grams per cubic LDU.
 *
 * ABS is about 1.05 g/cm³. One LDU is 0.4 mm, so 1 LDU³ = 6.4e-5 cm³, giving
 * 6.72e-5 g per LDU³.
 *
 * The mass this yields runs **8–15% heavy** against a physical element — a 2 × 4
 * brick computes at 2.67 g where the moulded part is about 2.32 g — because
 * LDraw models an idealized solid with no draft angles, no wall thinning and no
 * small reliefs. The bias is systematic and close to uniform, so every
 * *relative* quantity built on it — where the centre of mass sits, which
 * connection carries the most, whether a model tips — is unaffected. The
 * absolute grams are reported with that caveat attached rather than quietly
 * scaled by a fudge factor.
 */
export const ABS_GRAMS_PER_LDU3 = 1.05 * (0.04 ** 3)

/** What the mass figure is, and is not, so a reader is not misled by it. */
export const MASS_BASIS =
  'Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized '
  + 'solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is '
  + 'uniform, so centre of mass, load share and tipping margin are unaffected.'

/**
 * Assumed holding force of one stud-to-anti-stud clutch, in grams-force.
 *
 * Independent measurements of LEGO clutch power cluster around 1–2 N for a
 * single stud in good condition. 100 gf (≈ 0.98 N) is the conservative end of
 * that range. It is an assumption, it is reported as one, and it is the only
 * number in this module that is not measured.
 */
export const DEFAULT_CLUTCH_GRAMS = 100

/**
 * Relative clutch of each connector family, in stud-equivalents.
 *
 * LEGO does not publish pull-apart figures per family. These weights are
 * assumptions, reported on the statics report, scaled so a stud is 1. A pin in
 * a pin-hole holds more than a stud; a clip on a bar and a ball joint hold
 * less. The absolute grams still come from `clutchGramsPerStud`.
 */
export const CLUTCH_FAMILY_WEIGHT: Record<ConnectionFamily, number> = {
  stud: 1,
  'anti-stud': 1,
  pin: 1.4,
  'pin-hole': 1.4,
  axle: 0.5,
  'axle-hole': 0.5,
  bar: 0.7,
  clip: 0.7,
  hinge: 0.8,
  ball: 0.45,
  socket: 0.45,
  generic: 0.7,
}

/** Stud-equivalent capacity of one mated pair. */
export function clutchCapacityWeight(a: ConnectionFamily, b: ConnectionFamily): number {
  return Math.min(CLUTCH_FAMILY_WEIGHT[a], CLUTCH_FAMILY_WEIGHT[b])
}

/**
 * Assumed resisting arm of even a single stud, in LDU.
 *
 * A stud is 12 LDU across. A one-connector attachment has no pairwise span, so
 * without a floor the moment capacity would be zero and every hanging part
 * would fail in rotation. This is an assumption, reported as one.
 */
export const MIN_RESISTING_ARM_LDU = 12

export interface MassReport {
  /** Total measured mass in grams, over parts with compiled geometry. */
  readonly grams: number
  readonly measuredParts: number
  readonly unmeasuredParts: number
  /** Centre of mass in document LDU, over the measured parts. */
  readonly centreLdu: Vec3
}

export interface SupportReport {
  /** Document Y of the plane the model rests on. LDraw is Y-down, so this is a maximum. */
  readonly groundY: number
  /** Convex hull of the resting footprint, in document XZ. */
  readonly polygon: Array<[number, number]>
  /** Parts touching the ground plane. */
  readonly restingParts: number
  /**
   * Shortest distance from the centre of mass to the edge of the support
   * polygon, in LDU. Negative means the centre of mass is outside it and the
   * model tips.
   */
  readonly marginLdu: number
  readonly stable: boolean
}

export interface OverhangIssue {
  readonly partIds: string[]
  /** Mass the connection is carrying, in grams. */
  readonly grams: number
  /** Stud-equivalent connections holding it. */
  readonly studs: number
  /** Assumed capacity of those studs, in grams-force. */
  readonly capacityGrams: number
  readonly severity: 'over-capacity' | 'marginal'
  readonly message: string
  /** Cluster whose weight is hanging — excludes the supporting anchors. */
  readonly hangingPartIds: string[]
  /** Present only when the cluster's weight acts away from its anchors. */
  readonly leverage?: {
    readonly armLdu: number
    readonly spanLdu: number
    readonly momentGramLdu: number
    readonly capacityGramLdu: number
    readonly severity: 'over-capacity' | 'marginal'
  }
}

export interface StaticsReport {
  readonly mass: MassReport
  readonly support: SupportReport | null
  /** Groups held by too few studs for the mass hanging from them. */
  readonly overloaded: OverhangIssue[]
  /** Parts the load path from the ground never reaches: hanging or floating. */
  readonly unsupportedPartIds: string[]
  readonly assumptions: {
    clutchGramsPerStud: number
    densityGramsPerLdu3: number
    massBasis: string
    /** Assumed resisting arm of a single stud, in LDU. A stud is 12 LDU across. */
    minResistingArmLdu: number
    clutchFamilyWeights: Record<ConnectionFamily, number>
  }
  /** Fraction of the model, by part count, whose mass could be measured. */
  readonly coverage: number
}

/** Exact mass of one placed part, or null when this build cannot measure it. */
export function partMassGrams(part: PartInstance): number | null {
  const volume = catalog.get(part.definitionId)?.dimensions?.volumeLdu3
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) return null
  return volume * ABS_GRAMS_PER_LDU3
}

/** Centroid of a part's compiled envelope, which is where its mass acts. */
function partCentre(part: PartInstance): Vec3 {
  const bounds = getPartBounds(part)
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
}

/** Mass-weighted centroid of named parts, falling back to geometric centres. */
export function centroidOf(partIds: readonly string[], document: ModelDocument): Vec3 {
  let mass = 0
  let x = 0
  let y = 0
  let z = 0
  for (const id of partIds) {
    const part = document.parts[id]
    if (!part) continue
    const grams = partMassGrams(part) ?? 0
    const centre = partCentre(part)
    const weight = grams > 0 ? grams : 1
    mass += weight
    x += centre[0] * weight
    y += centre[1] * weight
    z += centre[2] * weight
  }
  if (mass <= 0) return [0, 0, 0]
  return [x / mass, y / mass, z / mass]
}

export function centroidOfPoints(points: readonly Vec3[]): Vec3 {
  if (!points.length) return [0, 0, 0]
  let x = 0
  let y = 0
  let z = 0
  for (const point of points) {
    x += point[0]
    y += point[1]
    z += point[2]
  }
  return [x / points.length, y / points.length, z / points.length]
}

/** Horizontal throw. Gravity is −Y in LDraw, so only XZ produces a bending moment. */
export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

export function maxPairwiseDistance(points: readonly Vec3[]): number {
  let span = 0
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      span = Math.max(span, horizontalDistance(points[i]!, points[j]!))
    }
  }
  return span
}

/**
 * Grams the optimiser should treat as excess on this cluster.
 *
 * Force excess is already in grams. Moment excess is gram·LDU; dividing by the
 * arm converts it back into an equivalent hanging mass so a far load and a
 * heavy load can share one objective without inventing a second unit.
 */
/** Issues whose weight acts past the assumed resisting arm of their studs. */
export function hangingArmIssues(overloaded: readonly OverhangIssue[]): OverhangIssue[] {
  return overloaded.filter(
    (item) => item.leverage !== undefined && item.leverage.momentGramLdu > item.leverage.capacityGramLdu,
  )
}

export function overhangPenaltyGrams(overhang: OverhangIssue): number {
  const force = Math.max(0, overhang.grams - overhang.capacityGrams)
  const leverage = overhang.leverage
  if (!leverage || leverage.armLdu < 1e-6) return force
  const momentExcess = Math.max(0, leverage.momentGramLdu - leverage.capacityGramLdu)
  return force + momentExcess / leverage.armLdu
}

export function computeMass(document: ModelDocument): MassReport {
  let grams = 0
  let measured = 0
  let unmeasured = 0
  const moment: [number, number, number] = [0, 0, 0]
  for (const part of Object.values(document.parts)) {
    const mass = partMassGrams(part)
    if (mass === null) {
      unmeasured += 1
      continue
    }
    const centre = partCentre(part)
    grams += mass
    measured += 1
    moment[0] += centre[0] * mass
    moment[1] += centre[1] * mass
    moment[2] += centre[2] * mass
  }
  return {
    grams,
    measuredParts: measured,
    unmeasuredParts: unmeasured,
    centreLdu: grams > 0 ? [moment[0] / grams, moment[1] / grams, moment[2] / grams] : [0, 0, 0],
  }
}

/** Andrew's monotone chain. Returns the hull counter-clockwise in XZ. */
export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const unique = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()]
  if (unique.length <= 2) return unique
  unique.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const build = (source: Array<[number, number]>) => {
    const chain: Array<[number, number]> = []
    for (const point of source) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop()
      chain.push(point)
    }
    chain.pop()
    return chain
  }
  return [...build(unique), ...build([...unique].reverse())]
}

/** Signed distance from a point to a convex polygon; positive means inside. */
export function distanceInsidePolygon(polygon: Array<[number, number]>, point: [number, number]): number {
  if (polygon.length < 3) {
    if (polygon.length === 0) return -Infinity
    if (polygon.length === 1) return -Math.hypot(point[0] - polygon[0][0], point[1] - polygon[0][1])
    // A line has no interior: the margin is the distance to the segment, negated.
    return -distanceToSegment(polygon[0], polygon[1], point)
  }
  let inside = true
  let nearest = Infinity
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]
    const b = polygon[(index + 1) % polygon.length]
    const side = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
    if (side < 0) inside = false
    nearest = Math.min(nearest, distanceToSegment(a, b, point))
  }
  return inside ? nearest : -nearest
}

function distanceToSegment(a: [number, number], b: [number, number], point: [number, number]): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point[0] - a[0], point[1] - a[1])
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))
}

/**
 * The footprint the model balances on.
 *
 * Everything whose underside reaches the lowest plane in the model is resting
 * on it; the hull of those footprints is the polygon the centre of mass has to
 * stay inside. A tolerance of one plate keeps a model that is a hair off the
 * plane from being reported as balancing on a single brick.
 */
export function computeSupport(document: ModelDocument, mass: MassReport): SupportReport | null {
  const parts = Object.values(document.parts)
  if (!parts.length || mass.grams <= 0) return null
  const bounds = parts.map((part) => ({ part, box: getPartBounds(part) })).filter((entry) => entry.box.measured)
  if (!bounds.length) return null

  // LDraw is Y-down, so the ground is the greatest Y anything reaches.
  const groundY = Math.max(...bounds.map((entry) => entry.box.max[1]))
  const resting = bounds.filter((entry) => Math.abs(entry.box.max[1] - groundY) <= 8)

  const corners: Array<[number, number]> = []
  for (const entry of resting) {
    corners.push([entry.box.min[0], entry.box.min[2]])
    corners.push([entry.box.min[0], entry.box.max[2]])
    corners.push([entry.box.max[0], entry.box.min[2]])
    corners.push([entry.box.max[0], entry.box.max[2]])
  }
  const polygon = convexHull(corners)
  const marginLdu = distanceInsidePolygon(polygon, [mass.centreLdu[0], mass.centreLdu[2]])
  return { groundY, polygon, restingParts: resting.length, marginLdu, stable: marginLdu > 0 }
}

/**
 * Loads that hang, and the studs asked to hold them.
 *
 * Clutch resists being pulled apart. A brick resting on another brick is not
 * testing it — the load goes into the brick below in compression, and the studs
 * are only there to stop it sliding. What actually pulls a model apart is mass
 * that hangs: a balcony reached only from above, an overhang attached at one
 * end, a sign hung off the side of a wall.
 *
 * So the model is walked *upward* from whatever is resting on the ground: a
 * part is carried in compression if its underside meets the top of something
 * already carried. Anything the walk never reaches either hangs from its
 * neighbours — and the connections into it are in tension with the whole
 * cluster's mass behind them, which is the number a clutch assumption can be
 * compared against — or reaches the ground through nothing at all, and is
 * simply floating.
 *
 * In a purely stud-built model tension is rare, because a brick on a brick is
 * compression. It arrives with SNOT: brackets, headlight bricks and clips that
 * hold a sub-assembly out sideways or underneath. Those are the cases this
 * finds, and the floating case is the one an agent placing parts by coordinate
 * produces most often.
 */
export function computeOverloads(
  document: ModelDocument,
  clutchGrams: number,
): { overloaded: OverhangIssue[]; unsupportedPartIds: string[] } {
  const parts = Object.values(document.parts)
  if (!parts.length) return { overloaded: [], unsupportedPartIds: [] }

  const derived = deriveConnections(document)
  const neighbours = new Map<string, Map<string, number>>()
  for (const part of parts) neighbours.set(part.id, new Map())
  for (const pair of derived.pairs) {
    const a = neighbours.get(pair.a.partId)
    const b = neighbours.get(pair.b.partId)
    const weight = clutchCapacityWeight(pair.a.family, pair.b.family)
    if (a) a.set(pair.b.partId, (a.get(pair.b.partId) ?? 0) + weight)
    if (b) b.set(pair.a.partId, (b.get(pair.a.partId) ?? 0) + weight)
  }

  const boxes = new Map(parts.map((part) => [part.id, getPartBounds(part)]))
  const measured = parts.filter((part) => boxes.get(part.id)!.measured)
  if (!measured.length) return { overloaded: [], unsupportedPartIds: parts.map((part) => part.id) }

  // LDraw is Y-down: the ground is the greatest Y anything reaches, and one
  // part rests on another when its underside meets that part's top.
  const groundY = Math.max(...measured.map((part) => boxes.get(part.id)!.max[1]))
  const carried = new Set<string>()
  const queue: string[] = []
  for (const part of measured) {
    if (Math.abs(boxes.get(part.id)!.max[1] - groundY) <= 8) {
      carried.add(part.id)
      queue.push(part.id)
    }
  }
  while (queue.length) {
    const current = queue.shift()!
    const currentTop = boxes.get(current)!.min[1]
    for (const [id] of neighbours.get(current) ?? []) {
      if (carried.has(id)) continue
      const box = boxes.get(id)
      if (!box?.measured) continue
      // `id` rests on `current` only when its underside meets that part's top.
      // A looser test marks a part hanging *underneath* as carried, which is
      // the opposite of the truth: it is exactly the case clutch has to hold.
      if (Math.abs(box.max[1] - currentTop) <= 8) {
        carried.add(id)
        queue.push(id)
      }
    }
  }

  // Everything the walk did not reach is hanging. Cluster it, so a balcony of
  // twenty parts is reported as one load rather than twenty.
  // Anything the walk never reached does not stand on the ground: either it is
  // hanging from something that does, or it is floating with nothing under it.
  const unsupportedPartIds = parts.filter((part) => !carried.has(part.id)).map((part) => part.id)
  const hanging = measured.filter((part) => !carried.has(part.id) && (neighbours.get(part.id)?.size ?? 0) > 0)
  const seen = new Set<string>()
  const overloaded: OverhangIssue[] = []
  for (const seed of hanging) {
    if (seen.has(seed.id)) continue
    const cluster: string[] = []
    const frontier = [seed.id]
    seen.add(seed.id)
    while (frontier.length) {
      const current = frontier.shift()!
      cluster.push(current)
      for (const [id] of neighbours.get(current) ?? []) {
        if (carried.has(id) || seen.has(id)) continue
        seen.add(id)
        frontier.push(id)
      }
    }

    let studs = 0
    const anchors = new Set<string>()
    for (const id of cluster) {
      for (const [other, count] of neighbours.get(id) ?? []) {
        if (!carried.has(other)) continue
        studs += count
        anchors.add(other)
      }
    }
    if (!studs) continue

    const grams = cluster.reduce((sum, id) => sum + (partMassGrams(document.parts[id]) ?? 0), 0)
    const capacity = studs * clutchGrams
    const loadCentre = centroidOf(cluster, document)
    const anchorPoints: Vec3[] = []
    for (const pair of derived.pairs) {
      const clusterHasA = cluster.includes(pair.a.partId)
      const clusterHasB = cluster.includes(pair.b.partId)
      const anchorHasA = anchors.has(pair.a.partId)
      const anchorHasB = anchors.has(pair.b.partId)
      if (clusterHasA && anchorHasB) anchorPoints.push(pair.b.frame.position)
      else if (clusterHasB && anchorHasA) anchorPoints.push(pair.a.frame.position)
    }
    const armLdu = horizontalDistance(loadCentre, centroidOfPoints(anchorPoints))
    const spanLdu = maxPairwiseDistance(anchorPoints)
    const momentGramLdu = grams * armLdu
    const momentCapacity =
      studs * clutchGrams * Math.max(spanLdu, MIN_RESISTING_ARM_LDU) / 2
    const forceOver = grams > capacity
    const leverageOver = armLdu > 1 && momentGramLdu > momentCapacity
    if (!forceOver && !leverageOver) continue

    const leverage =
      armLdu > 1
        ? {
            armLdu: Math.round(armLdu * 10) / 10,
            spanLdu: Math.round(spanLdu * 10) / 10,
            momentGramLdu: Math.round(momentGramLdu),
            capacityGramLdu: Math.round(momentCapacity),
            severity: (momentGramLdu > momentCapacity * 2 ? 'over-capacity' : 'marginal') as
              | 'over-capacity'
              | 'marginal',
          }
        : undefined

    const message =
      leverage && leverageOver && !forceOver
        ? `${cluster.length} part${cluster.length === 1 ? '' : 's'} weighing ${Math.round(grams)} g hang ${Math.round(armLdu)} LDU out from ${studs} stud${studs === 1 ? '' : 's'} spanning ${Math.round(spanLdu)} LDU. The weight is within what those studs can hold, but the leverage is not — bring the load back over a support, or widen the attachment.`
        : `${cluster.length} part${cluster.length === 1 ? '' : 's'} weighing ${Math.round(grams)} g hang from `
          + `${studs} stud${studs === 1 ? '' : 's'}, assumed to hold ${capacity} g. `
          + 'Add another attachment point, or bring the load back over a support.'

    overloaded.push({
      partIds: [...cluster, ...anchors],
      hangingPartIds: [...cluster],
      grams: Math.round(grams * 10) / 10,
      studs,
      capacityGrams: capacity,
      severity: forceOver
        ? grams > capacity * 2
          ? 'over-capacity'
          : 'marginal'
        : leverage?.severity ?? 'marginal',
      message,
      leverage,
    })
  }

  return { overloaded: overloaded.sort((a, b) => b.grams - a.grams).slice(0, 24), unsupportedPartIds }
}

export function analyseStatics(document: ModelDocument, clutchGrams = DEFAULT_CLUTCH_GRAMS): StaticsReport {
  const mass = computeMass(document)
  const support = computeSupport(document, mass)
  const { overloaded, unsupportedPartIds } = computeOverloads(document, clutchGrams)
  const total = mass.measuredParts + mass.unmeasuredParts
  return {
    mass,
    support,
    overloaded,
    unsupportedPartIds,
    assumptions: {
      clutchGramsPerStud: clutchGrams,
      densityGramsPerLdu3: ABS_GRAMS_PER_LDU3,
      massBasis: MASS_BASIS,
      minResistingArmLdu: MIN_RESISTING_ARM_LDU,
      clutchFamilyWeights: CLUTCH_FAMILY_WEIGHT,
    },
    coverage: total ? mass.measuredParts / total : 1,
  }
}

/** Human-facing mass, switching to kilograms where grams stop being readable. */
export function describeMass(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg`
  if (grams >= 10) return `${Math.round(grams)} g`
  return `${grams.toFixed(1)} g`
}

/** Stud-grid footprint of the support polygon, for display. */
export function describeSupport(support: SupportReport | null): string {
  if (!support) return 'nothing measured'
  const xs = support.polygon.map((point) => point[0])
  const zs = support.polygon.map((point) => point[1])
  const width = (Math.max(...xs) - Math.min(...xs)) / STUD_LDU
  const depth = (Math.max(...zs) - Math.min(...zs)) / STUD_LDU
  return `${width.toFixed(1)} × ${depth.toFixed(1)} studs`
}
