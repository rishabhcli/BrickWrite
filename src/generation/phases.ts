import { mulberry32, type DesignBrief, type ModelProvider } from '../platform/contracts'
import { BRICK_LDU, PLATE_LDU, STUD_LDU } from '../cad/catalog'
import { MAX_GENERATED_PARTS } from '../cad/assembly'
import type { ModelDocument } from '../cad/types'
import type { Opening } from '../cad/assembly'
import { classifySubject, type SubjectArchetype } from './brief'
import {
  structuralHash,
  type BuildEdge,
  type BuildGraph,
  type BuildNode,
  type ConnectorRef,
} from './graph'
import { GraphRealizer, type RealizeConstraints, type RealizeResult } from './realize'
import { scoreDocument, type MetricVector, type ScoreOptions } from './score'
import { silhouetteScore, type SilhouetteReference } from './silhouette'
import type { GeometryProvider } from '../cad/collision'

/**
 * Coarse to fine, in four phases that mean something.
 *
 * The phases are not four passes over the same idea. Each one answers a
 * different question, and each one can be looked at on its own:
 *
 *   massing   what volume is this thing, and how does it break into boxes?
 *             Realised as the deck of each box — the footprint at the right
 *             height, and nothing else.
 *   skeleton  what holds it up? The perimeter of each box, full height, one
 *             stud thick, which is also what gives the model its outline.
 *   packing   fill, with a real bond. Interior bracing and decks, laid by the
 *             parametric planners so seams stagger and runs cover exactly.
 *   detail    surface: accents, tiles, greebles, and the functional openings the
 *             brief asked for. Single parts, each solved through the snapper.
 *
 * The order is load-bearing rather than cosmetic. Every phase only ever *adds*
 * to the graph, so a candidate's silhouette coverage is monotonic, and a phase
 * that fails leaves the previous phase's candidate intact and inspectable rather
 * than leaving a half-built one.
 *
 * Where a model provider is configured it proposes the decomposition and the
 * detail placements, under a JSON schema, and a response that violates the schema
 * is a hard failure rather than something to paper over. With no provider the
 * decomposition comes from the brief and the strategy — measured proportions, not
 * a template keyed on the prompt.
 */

export type PhaseName = 'massing' | 'skeleton' | 'packing' | 'detail'

export const PHASES: readonly PhaseName[] = ['massing', 'skeleton', 'packing', 'detail']

/** A box in the decomposition: a rectangular volume on the stud lattice. */
export interface MassingBox {
  readonly id: string
  readonly role: string
  /** Minimum corner in studs from the build origin, [x, z]. */
  readonly atStuds: readonly [number, number]
  readonly widthStuds: number
  readonly depthStuds: number
  /** Height in standard brick courses. */
  readonly courses: number
  /** Which storey the box sits on. Level 0 rests on the ground plane. */
  readonly level: number
  /** `shell` leaves the interior open; `solid` asks packing to brace it through. */
  readonly fill: 'shell' | 'solid'
}

export interface MassingInput {
  readonly brief: DesignBrief
  readonly archetype: SubjectArchetype
  readonly footprint: readonly [number, number]
  readonly heightCourses: number
  readonly random: () => number
}

export interface GenerationStrategy {
  readonly id: string
  readonly label: string
  /** Stated so a candidate can explain why it looks the way it does. */
  readonly rationale: string
  decompose(input: MassingInput): MassingBox[]
}

const clampInt = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(value)))

/** LDraw stud height. The topmost course's studs stand this far proud of it. */
const STUD_PROTRUSION_LDU = 4

/**
 * Three genuinely different ways to occupy the same volume.
 *
 * Diversity has to come from somewhere real. Re-rolling a seed inside one
 * strategy produces the same building with the seams in different places, which
 * is not a different design; changing how the volume is divided is.
 */
export const STRATEGIES: readonly GenerationStrategy[] = [
  {
    id: 'framed-shell',
    label: 'Framed shell',
    rationale: 'One perimeter per storey, hollow inside, storeys stepping inward — how a building is actually built.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const storeys = clampInt(heightCourses / 4, 1, 3)
      const perStorey = Math.max(2, Math.floor(heightCourses / storeys))
      const boxes: MassingBox[] = []
      for (let level = 0; level < storeys; level += 1) {
        const inset = level === 0 ? 0 : level
        const boxWidth = width - inset * 2
        const boxDepth = depth - inset * 2
        if (boxWidth < 3 || boxDepth < 3) break
        boxes.push({
          id: `box${level}`,
          role: level === 0 ? 'base' : `storey${level}`,
          atStuds: [inset, inset],
          widthStuds: boxWidth,
          depthStuds: boxDepth,
          courses: perStorey,
          level,
          fill: 'shell',
        })
      }
      return boxes.length ? boxes : [groundBox(width, depth, heightCourses)]
    },
  },
  {
    id: 'stacked-slab',
    label: 'Stacked slabs',
    rationale: 'Equal full-footprint slices with their own decks — a solid, heavy read with a strong horizontal grain.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const slices = clampInt(heightCourses / 3, 1, 4)
      const perSlice = Math.max(2, Math.floor(heightCourses / slices))
      const boxes: MassingBox[] = []
      for (let level = 0; level < slices; level += 1) {
        boxes.push({
          id: `slab${level}`,
          role: level === 0 ? 'base' : `slab${level}`,
          atStuds: [0, 0],
          widthStuds: width,
          depthStuds: depth,
          courses: perSlice,
          level,
          fill: level === 0 ? 'solid' : 'shell',
        })
      }
      return boxes
    },
  },
  {
    id: 'spine-and-ribs',
    label: 'Spine and ribs',
    rationale: 'A narrow full-height spine with lower flanking bays — the massing a vehicle or a creature wants.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const spineDepth = Math.max(3, Math.round(depth / 3))
      const flankDepth = Math.max(3, Math.floor((depth - spineDepth) / 2))
      const boxes: MassingBox[] = [
        {
          id: 'spine',
          role: 'base',
          atStuds: [0, 0],
          widthStuds: width,
          depthStuds: depth,
          courses: Math.max(2, Math.floor(heightCourses / 2)),
          level: 0,
          fill: 'solid',
        },
      ]
      if (flankDepth >= 3 && heightCourses >= 4) {
        boxes.push({
          id: 'crest',
          role: 'crest',
          atStuds: [Math.max(0, Math.round((width - Math.max(3, Math.round(width / 2))) / 2)), flankDepth],
          widthStuds: Math.max(3, Math.round(width / 2)),
          depthStuds: spineDepth,
          courses: Math.max(2, heightCourses - Math.max(2, Math.floor(heightCourses / 2))),
          level: 1,
          fill: 'shell',
        })
      }
      return boxes
    },
  },
]

/**
 * Shrinks a stack until it fits the height it was given.
 *
 * Each storey costs its own courses *plus* the two plate layers of deck under
 * it, and the deck is easy to forget: a two-storey box sized to exactly fill the
 * envelope in bricks overshoots it by 32 LDU, which the realiser then correctly
 * refuses one wall at a time. Taking the height off the tallest level first
 * keeps the proportions closest to what the strategy asked for.
 */
export function fitBoxHeights(boxes: readonly MassingBox[], maxHeightLdu: number): MassingBox[] {
  if (!Number.isFinite(maxHeightLdu) || !boxes.length) return [...boxes]
  // The measured extent includes the studs standing proud of the topmost course.
  // Four LDU is not rounding error at this scale — it is the difference between
  // a wall the realiser accepts and one it correctly refuses for leaving the
  // envelope, which is exactly how the top storey used to disappear.
  const available = maxHeightLdu - STUD_PROTRUSION_LDU
  const courses = new Map<number, number>()
  for (const box of boxes) courses.set(box.level, Math.max(courses.get(box.level) ?? 0, box.courses))

  const stackHeight = () =>
    [...courses.entries()].reduce((total, [, value]) => total + 2 * PLATE_LDU + value * BRICK_LDU, 0)

  let guard = 512
  while (stackHeight() > available && guard > 0) {
    guard -= 1
    const tallest = [...courses.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    if (!tallest || tallest[1] <= 1) break
    courses.set(tallest[0], tallest[1] - 1)
  }

  // A level that no longer fits at all is dropped rather than laid one course
  // tall inside the storey below it.
  const affordable = new Set<number>()
  let running = 0
  for (const level of [...courses.keys()].sort((a, b) => a - b)) {
    running += 2 * PLATE_LDU + (courses.get(level) ?? 1) * BRICK_LDU
    if (running <= available + 1e-6) affordable.add(level)
  }
  if (!affordable.size) affordable.add(Math.min(...courses.keys()))

  return boxes
    .filter((box) => affordable.has(box.level))
    .map((box) => ({ ...box, courses: Math.max(1, Math.min(box.courses, courses.get(box.level) ?? box.courses)) }))
}

const groundBox = (width: number, depth: number, courses: number): MassingBox => ({
  id: 'box0',
  role: 'base',
  atStuds: [0, 0],
  widthStuds: Math.max(3, width),
  depthStuds: Math.max(3, depth),
  courses: Math.max(1, courses),
  level: 0,
  fill: 'shell',
})

export const strategyById = (id: string): GenerationStrategy =>
  STRATEGIES.find((strategy) => strategy.id === id) ?? STRATEGIES[0]

/** Proportions used when the brief states no envelope, by archetype. */
const DEFAULT_FOOTPRINT: Record<SubjectArchetype, readonly [number, number, number]> = {
  vehicle: [14, 8, 8],
  building: [16, 14, 12],
  furniture: [8, 8, 6],
  creature: [10, 12, 8],
  mechanism: [12, 10, 10],
  sculpture: [8, 14, 8],
  unknown: [12, 10, 10],
}

/** Part budget assumed when the brief sets none. Bounded well under the kernel cap. */
export const DEFAULT_PART_BUDGET = 420

export interface PhaseMetrics {
  readonly partCount: number
  readonly distinctElements: number
  /** Mean IoU against the supplied references, or null when none was given. */
  readonly silhouetteIou: number | null
  readonly silhouettePerView: Record<string, number>
  readonly extentStuds: readonly [number, number, number]
}

export interface PhaseEvent {
  readonly phase: PhaseName
  readonly index: number
  readonly strategy: string
  readonly seed: number
  /** The graph as it stands after this phase — cumulative, not a delta. */
  readonly graph: BuildGraph
  readonly structuralHash: string
  readonly nodesAdded: number
  readonly partsAdded: number
  readonly metrics: PhaseMetrics
  readonly elapsedMs: number
  readonly notes: readonly string[]
}

export interface PipelineOptions {
  readonly seed: number
  readonly strategy?: string
  readonly provider?: ModelProvider
  readonly base: ModelDocument
  readonly signal?: AbortSignal
  readonly onPhase?: (event: PhaseEvent) => void
  readonly references?: readonly SilhouetteReference[]
  readonly provideGeometry?: GeometryProvider
  readonly idPrefix?: string
  readonly repairBudget?: number
  /** Overrides the constraints derived from the brief. */
  readonly constraints?: RealizeConstraints
}

export interface Candidate {
  readonly id: string
  readonly strategy: string
  readonly seed: number
  readonly graph: BuildGraph
  readonly structuralHash: string
  readonly realize: RealizeResult
  readonly document: ModelDocument
  readonly metrics: MetricVector
  readonly phases: PhaseEvent[]
  readonly notes: string[]
  /** Boxes the massing settled on, for inspection and for the UI. */
  readonly boxes: MassingBox[]
}

/** Constraints the realiser enforces, derived from the brief unless overridden. */
export function constraintsFor(brief: DesignBrief, override?: RealizeConstraints): RealizeConstraints {
  return {
    partBudget: override?.partBudget ?? brief.partBudget ?? DEFAULT_PART_BUDGET,
    envelopeStuds: override?.envelopeStuds ?? brief.envelopeStuds,
    palette: override?.palette ?? brief.palette,
    protectedPartIds: override?.protectedPartIds ?? brief.protectedPartIds,
  }
}

/** Footprint and height the pipeline works to, in studs and courses. */
export function volumeFor(brief: DesignBrief, archetype: SubjectArchetype): {
  footprint: [number, number]
  heightCourses: number
} {
  const envelope = brief.envelopeStuds ?? DEFAULT_FOOTPRINT[archetype]
  const width = clampInt(envelope[0], 3, 64)
  const depth = clampInt(envelope[2], 3, 64)
  // LDraw is Y-down and a course is 24 LDU against a 20 LDU stud pitch, so a
  // height quoted in studs is 20/24 of a course each. Rounding down keeps the
  // build inside the envelope rather than one course past it.
  const heightCourses = Math.max(1, Math.floor((envelope[1] * STUD_LDU) / BRICK_LDU))
  return { footprint: [width, depth], heightCourses }
}

/**
 * One deck per storey, spanning the storey below it.
 *
 * This is the detail that decides whether the model is one object or several.
 * A storey's deck has to *cap the walls underneath it*, so its footprint is the
 * union of the boxes on the level below, not the footprint of the box it
 * carries. An upper deck inset to match its own box lands entirely inside the
 * wall ring below and touches nothing — it looks right in a render and comes
 * apart the moment anything picks it up, and the connectivity metric is the only
 * thing that would ever notice.
 */
export interface StoreyLayout {
  readonly level: number
  /** Minimum corner of the deck in studs, [x, z]. */
  readonly atStuds: readonly [number, number]
  readonly widthStuds: number
  readonly depthStuds: number
  /** Surface the deck's first layer rests on, in document LDU. Y-down. */
  readonly baseY: number
  readonly boxes: MassingBox[]
}

const rectUnion = (boxes: readonly MassingBox[]) => {
  const minX = Math.min(...boxes.map((box) => box.atStuds[0]))
  const minZ = Math.min(...boxes.map((box) => box.atStuds[1]))
  const maxX = Math.max(...boxes.map((box) => box.atStuds[0] + box.widthStuds))
  const maxZ = Math.max(...boxes.map((box) => box.atStuds[1] + box.depthStuds))
  return { atStuds: [minX, minZ] as const, widthStuds: maxX - minX, depthStuds: maxZ - minZ }
}

/** Groups a decomposition into storeys and works out where each deck sits. */
export function layoutStoreys(boxes: readonly MassingBox[]): StoreyLayout[] {
  const levels = [...new Set(boxes.map((box) => box.level))].sort((a, b) => a - b)
  const layouts: StoreyLayout[] = []
  let baseY = 0
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index]
    const own = boxes.filter((box) => box.level === level)
    const below = index === 0 ? own : boxes.filter((box) => box.level === levels[index - 1])
    const rect = rectUnion(below)
    layouts.push({ level, ...rect, baseY, boxes: own })
    // Two plate layers of deck, then the tallest box on this storey.
    baseY -= 2 * PLATE_LDU + Math.max(...own.map((box) => box.courses)) * BRICK_LDU
  }
  return layouts
}

const deckNodeId = (level: number) => `deck_l${level}`
const shellNodeId = (box: MassingBox) => `shell_${box.id}`
const braceNodeId = (box: MassingBox, index: number) => `brace_${box.id}_${index}`

const topStud = (uStuds: number, vStuds: number): ConnectorRef => ({
  family: 'stud',
  gender: 'male',
  pick: { kind: 'grid', uStuds, vStuds, level: 'top' },
})

const underside: ConnectorRef = {
  family: 'anti-stud',
  gender: 'female',
  pick: { kind: 'grid', uStuds: 0, vStuds: 0 },
}

/**
 * Openings the brief's stated functions actually justify.
 *
 * A door is only cut where the request asked for one. Inventing a facade full of
 * windows because the subject is a house would be the generator deciding what
 * the brief meant, which is the failure this whole pipeline is arranged to
 * avoid.
 */
function openingsFor(brief: DesignBrief, box: MassingBox): Opening[] {
  if (box.level !== 0 || box.courses < 3) return []
  const wants = (pattern: RegExp) => brief.functions.some((entry) => pattern.test(entry))
  const openings: Opening[] = []
  if (wants(/door|gate/i) && box.widthStuds >= 10) {
    openings.push({
      atStud: Math.floor(box.widthStuds / 2) - 2,
      widthStuds: 4,
      fromCourse: 0,
      toCourse: Math.min(box.courses - 1, 5),
      element: 'door',
    })
  }
  if (wants(/window|shutter/i) && box.widthStuds >= 8) {
    openings.push({
      atStud: 1,
      widthStuds: 2,
      fromCourse: 1,
      toCourse: Math.min(box.courses - 1, 2),
      element: 'window',
    })
  }
  return openings
}

interface PhaseDelta {
  readonly nodes: BuildNode[]
  readonly edges: BuildEdge[]
  readonly notes: string[]
}

const EMPTY_DELTA: PhaseDelta = { nodes: [], edges: [], notes: [] }

/** Accent colour for detail, drawn from the palette when the brief states one. */
function accentColour(brief: DesignBrief, base: number): number {
  if (brief.palette.length > 1) return brief.palette[1]
  if (brief.palette.length === 1) return brief.palette[0]
  return base
}

function baseColour(brief: DesignBrief): number {
  // LDraw 71 is Light Bluish Grey: the most-produced structural colour, and the
  // honest default when the request names none.
  return brief.palette[0] ?? 71
}

// ---------------------------------------------------------------------------
// Phase proposers
// ---------------------------------------------------------------------------

function massingDelta(brief: DesignBrief, storeys: readonly StoreyLayout[]): PhaseDelta {
  const nodes: BuildNode[] = []
  const colour = baseColour(brief)
  for (const storey of storeys) {
    nodes.push({
      id: deckNodeId(storey.level),
      kind: 'region',
      colour,
      role: storey.level === 0 ? 'base' : `storey${storey.level}`,
      anchorLdu: [storey.atStuds[0] * STUD_LDU, storey.baseY, storey.atStuds[1] * STUD_LDU],
      region: {
        shape: 'field',
        widthStuds: storey.widthStuds,
        depthStuds: storey.depthStuds,
        // Two cross-bonded layers. One layer is genuinely loose in the middle,
        // which would surface later as a connectivity failure rather than as a
        // floor.
        courses: 2,
        family: 'plate',
      },
    })
  }
  return {
    nodes,
    edges: [],
    notes: [
      `Massing: ${storeys.length} storey(s) — ${storeys
        .map((storey) => `${storey.widthStuds} × ${storey.depthStuds} deck at level ${storey.level} carrying ${storey.boxes.length} box(es)`)
        .join('; ')}.`,
    ],
  }
}

function skeletonDelta(brief: DesignBrief, storeys: readonly StoreyLayout[]): PhaseDelta {
  const nodes: BuildNode[] = []
  const edges: BuildEdge[] = []
  const notes: string[] = []
  const colour = baseColour(brief)
  for (const storey of storeys) {
    for (const box of storey.boxes) {
      if (box.widthStuds < 3 || box.depthStuds < 3) {
        notes.push(`Skeleton: box ${box.id} is ${box.widthStuds} × ${box.depthStuds} studs, too small for a one-stud perimeter.`)
        continue
      }
      const openings = openingsFor(brief, box)
      nodes.push({
        id: shellNodeId(box),
        kind: 'region',
        colour,
        role: box.role,
        region: {
          shape: 'enclosure',
          widthStuds: box.widthStuds,
          depthStuds: box.depthStuds,
          courses: box.courses,
          family: 'brick',
          thicknessStuds: 1,
          floor: false,
          ...(openings.length ? { openings } : {}),
        },
      })
      edges.push({
        id: `e_${shellNodeId(box)}`,
        from: deckNodeId(storey.level),
        to: shellNodeId(box),
        fromConnector: topStud(box.atStuds[0] - storey.atStuds[0], box.atStuds[1] - storey.atStuds[1]),
        toConnector: underside,
        family: 'stud',
      })
    }
  }
  notes.push(`Skeleton: ${nodes.length} perimeter(s) raised on their decks.`)
  return { nodes, edges, notes }
}

function packingDelta(brief: DesignBrief, storeys: readonly StoreyLayout[]): PhaseDelta {
  const nodes: BuildNode[] = []
  const edges: BuildEdge[] = []
  const colour = baseColour(brief)
  for (const storey of storeys) {
    for (const box of storey.boxes) {
      if (box.widthStuds < 5 || box.depthStuds < 5) continue
      // A shell gets one cross-brace; a solid box gets one every third stud,
      // which is what turns an open perimeter into something that survives being
      // picked up without paying for a genuinely solid fill.
      const spacing = box.fill === 'solid' ? 3 : Math.max(2, Math.floor(box.depthStuds / 2))
      let index = 0
      for (let v = spacing; v <= box.depthStuds - 2; v += spacing) {
        nodes.push({
          id: braceNodeId(box, index),
          kind: 'region',
          colour,
          role: `${box.role}_brace`,
          region: {
            shape: 'wall',
            widthStuds: box.widthStuds - 2,
            depthStuds: 1,
            courses: box.courses,
            family: 'brick',
            thicknessStuds: 1,
            axis: 'x',
          },
        })
        edges.push({
          id: `e_${braceNodeId(box, index)}`,
          from: deckNodeId(storey.level),
          to: braceNodeId(box, index),
          fromConnector: topStud(
            box.atStuds[0] - storey.atStuds[0] + 1,
            box.atStuds[1] - storey.atStuds[1] + v,
          ),
          toConnector: underside,
          family: 'stud',
        })
        index += 1
      }
    }
  }
  return {
    nodes,
    edges,
    notes: [`Packing: ${nodes.length} interior brace(s) laid with staggered seams.`],
  }
}

function detailDelta(
  brief: DesignBrief,
  storeys: readonly StoreyLayout[],
  random: () => number,
  placed: ReadonlySet<string>,
): PhaseDelta {
  const nodes: BuildNode[] = []
  const edges: BuildEdge[] = []
  const notes: string[] = []
  const accent = accentColour(brief, 0)
  const mirrored = brief.symmetry === 'mirror-x' || brief.symmetry === 'radial'

  // Detail hangs off whatever the earlier phases *actually* placed, highest
  // first. Choosing a host from the graph alone would attach greebles to a wall
  // that was rejected for leaving the envelope, and the whole detail phase would
  // then fail for a reason that has nothing to do with detail.
  const ranked = [...storeys].sort((a, b) => b.level - a.level)
  const hosted = ranked
    .flatMap((storey) => [
      ...storey.boxes.map((box) => ({ width: box.widthStuds, depth: box.depthStuds, node: shellNodeId(box) })),
      { width: storey.widthStuds, depth: storey.depthStuds, node: deckNodeId(storey.level) },
    ])
    .find((entry) => placed.has(entry.node))
  if (!hosted) {
    return {
      nodes,
      edges,
      notes: ['Detail: nothing from the earlier phases was placed, so there is no surface to detail.'],
    }
  }

  const count = clampInt(2 + random() * 4, 2, 6)
  for (let index = 0; index < count; index += 1) {
    const u = clampInt(1 + random() * Math.max(1, hosted.width - 3), 1, Math.max(1, hosted.width - 2))
    const v = index % 2 === 0 ? 0 : Math.max(0, hosted.depth - 1)
    const id = `detail_${index}`
    nodes.push({
      id,
      kind: 'part',
      colour: accent,
      role: 'detail',
      part: { query: 'tile 1 x 2 with groove', sizeStuds: [2, 1, 1] },
    })
    edges.push({
      id: `e_${id}`,
      from: hosted.node,
      to: id,
      fromConnector: topStud(u, v),
      toConnector: underside,
      family: 'stud',
    })
    if (mirrored) {
      const mirrorId = `detail_${index}_m`
      nodes.push({
        id: mirrorId,
        kind: 'part',
        colour: accent,
        role: 'detail',
        part: { query: 'tile 1 x 2 with groove', sizeStuds: [2, 1, 1] },
      })
      edges.push({
        id: `e_${mirrorId}`,
        from: hosted.node,
        to: mirrorId,
        fromConnector: topStud(Math.max(0, hosted.width - 1 - u), v),
        toConnector: underside,
        family: 'stud',
      })
    }
  }
  notes.push(`Detail: ${nodes.length} surface element(s) on ${hosted.node}${mirrored ? ', mirrored about the long axis' : ''}.`)
  return { nodes, edges, notes }
}

// ---------------------------------------------------------------------------
// Model-proposed decomposition
// ---------------------------------------------------------------------------

export const MASSING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['boxes'],
  properties: {
    boxes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'atStuds', 'widthStuds', 'depthStuds', 'courses', 'level', 'fill'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          role: { type: 'string', minLength: 1, maxLength: 40 },
          atStuds: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 256 }, minItems: 2, maxItems: 2 },
          widthStuds: { type: 'integer', minimum: 1, maximum: 256 },
          depthStuds: { type: 'integer', minimum: 1, maximum: 256 },
          courses: { type: 'integer', minimum: 1, maximum: 64 },
          level: { type: 'integer', minimum: 0, maximum: 8 },
          fill: { type: 'string', enum: ['shell', 'solid'] },
        },
      },
    },
  },
} as const

const MASSING_SYSTEM = [
  'You decompose a LEGO design brief into a small set of axis-aligned rectangular boxes on the stud lattice.',
  'Boxes describe volume only. Do not describe parts, colours or connections; a deterministic kernel fills them.',
  'atStuds is the box minimum corner as [x, z] studs from the build origin. Level 0 rests on the ground plane;',
  'each higher level rests on the level below. courses is height in standard brick courses (24 LDU each).',
  'Stay inside the stated envelope. Prefer three boxes or fewer unless the subject genuinely needs more.',
].join(' ')

interface RawMassing {
  boxes: MassingBox[]
}

function parseMassing(raw: unknown): RawMassing {
  if (!raw || typeof raw !== 'object') throw new Error('The massing response was not a JSON object.')
  const boxes = (raw as { boxes?: unknown }).boxes
  if (!Array.isArray(boxes) || !boxes.length) throw new Error('Field "boxes" was missing or empty.')
  return {
    boxes: boxes.map((entry, index) => {
      const box = entry as Record<string, unknown>
      const at = box.atStuds
      if (!Array.isArray(at) || at.length !== 2 || at.some((value) => typeof value !== 'number')) {
        throw new Error(`Box ${index} has no valid "atStuds" pair.`)
      }
      for (const key of ['widthStuds', 'depthStuds', 'courses', 'level'] as const) {
        if (typeof box[key] !== 'number' || !Number.isFinite(box[key] as number)) {
          throw new Error(`Box ${index} has no numeric "${key}".`)
        }
      }
      if (box.fill !== 'shell' && box.fill !== 'solid') throw new Error(`Box ${index} has an unknown "fill".`)
      if (typeof box.id !== 'string' || !box.id.trim()) throw new Error(`Box ${index} has no id.`)
      return {
        id: box.id.trim(),
        role: typeof box.role === 'string' && box.role.trim() ? box.role.trim() : `box${index}`,
        atStuds: [Math.trunc(at[0] as number), Math.trunc(at[1] as number)] as const,
        widthStuds: Math.trunc(box.widthStuds as number),
        depthStuds: Math.trunc(box.depthStuds as number),
        courses: Math.trunc(box.courses as number),
        level: Math.trunc(box.level as number),
        fill: box.fill,
      }
    }),
  }
}

/**
 * Clamps a proposed decomposition to what the brief permits.
 *
 * A model's boxes are a proposal about *design*, not a licence to leave the
 * envelope. Clamping here rather than rejecting keeps a slightly-oversized
 * proposal usable, and the realiser still refuses anything that would actually
 * breach the envelope once it is measured in LDU.
 */
export function clampBoxes(boxes: readonly MassingBox[], footprint: readonly [number, number], heightCourses: number): MassingBox[] {
  const [width, depth] = footprint
  const clamped: MassingBox[] = []
  const seen = new Set<string>()
  for (const box of boxes) {
    const x = clampInt(box.atStuds[0], 0, Math.max(0, width - 3))
    const z = clampInt(box.atStuds[1], 0, Math.max(0, depth - 3))
    const boxWidth = clampInt(box.widthStuds, 3, width - x)
    const boxDepth = clampInt(box.depthStuds, 3, depth - z)
    if (boxWidth < 3 || boxDepth < 3) continue
    let id = box.id
    let suffix = 1
    while (seen.has(id)) {
      id = `${box.id}_${suffix}`
      suffix += 1
    }
    seen.add(id)
    clamped.push({
      id,
      role: box.role,
      atStuds: [x, z],
      widthStuds: boxWidth,
      depthStuds: boxDepth,
      courses: clampInt(box.courses, 1, Math.max(1, heightCourses)),
      level: clampInt(box.level, 0, 4),
      fill: box.fill,
    })
  }
  return clamped.length ? clamped : []
}

async function decompose(
  brief: DesignBrief,
  archetype: SubjectArchetype,
  strategy: GenerationStrategy,
  options: PipelineOptions,
): Promise<{ boxes: MassingBox[]; notes: string[] }> {
  const { footprint, heightCourses } = volumeFor(brief, archetype)
  const maxHeightLdu = brief.envelopeStuds ? brief.envelopeStuds[1] * STUD_LDU : Number.POSITIVE_INFINITY
  const fit = (boxes: readonly MassingBox[]) => fitBoxHeights(clampBoxes(boxes, footprint, heightCourses), maxHeightLdu)
  const random = mulberry32(options.seed >>> 0)
  const deterministic = strategy.decompose({ brief, archetype, footprint, heightCourses, random })

  if (!options.provider) {
    return {
      boxes: fit(deterministic),
      notes: [`Massing came from the “${strategy.label}” rule set; no model provider was configured.`],
    }
  }

  const result = await options.provider.complete<RawMassing>({
    system: MASSING_SYSTEM,
    prompt: [
      `Subject: ${brief.subject}`,
      `Envelope: ${footprint[0]} × ${footprint[1]} studs, ${heightCourses} courses tall.`,
      `Scale: ${brief.scale}. Symmetry: ${brief.symmetry}.`,
      brief.functions.length ? `Functions: ${brief.functions.join(', ')}.` : 'Functions: none stated.',
      brief.style.length ? `Style: ${brief.style.join(', ')}.` : 'Style: none stated.',
      `Structural approach to follow: ${strategy.label} — ${strategy.rationale}`,
      `Variation seed: ${options.seed}.`,
    ].join('\n'),
    schema: MASSING_SCHEMA,
    parse: parseMassing,
    ...(options.signal ? { signal: options.signal } : {}),
    maxTokens: 1500,
    temperature: 0,
  })

  const boxes = fit(result.value.boxes)
  if (!boxes.length) {
    return {
      boxes: fit(deterministic),
      notes: [
        `The model proposed ${result.value.boxes.length} box(es), none of which survived clamping to the ${footprint[0]} × ${footprint[1]} stud envelope; the “${strategy.label}” rule set was used instead.`,
      ],
    }
  }
  return {
    boxes,
    notes: [`Massing proposed by ${result.provenance.model ?? result.provenance.provider} under the “${strategy.label}” approach.`],
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const phaseMetrics = (
  document: ModelDocument,
  references: readonly SilhouetteReference[] | undefined,
): PhaseMetrics => {
  const parts = Object.values(document.parts)
  const silhouette = references?.length ? silhouetteScore(document, references) : null
  const perView: Record<string, number> = {}
  if (silhouette) for (const [view, comparison] of Object.entries(silhouette.perView)) perView[view] = comparison.iou
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const part of parts) {
    const position = part.transform.position
    minX = Math.min(minX, position[0])
    maxX = Math.max(maxX, position[0])
    minY = Math.min(minY, position[1])
    maxY = Math.max(maxY, position[1])
    minZ = Math.min(minZ, position[2])
    maxZ = Math.max(maxZ, position[2])
  }
  return {
    partCount: parts.length,
    distinctElements: new Set(parts.map((part) => part.definitionId)).size,
    silhouetteIou: silhouette ? silhouette.mean : null,
    silhouettePerView: perView,
    extentStuds: parts.length
      ? [(maxX - minX) / STUD_LDU, (maxY - minY) / STUD_LDU, (maxZ - minZ) / STUD_LDU]
      : [0, 0, 0],
  }
}

/**
 * Runs the four phases against one seed and one strategy.
 *
 * The realiser is created once and extended, so each node is placed exactly once
 * by the phase that proposed it. Nothing is committed anywhere: the result is an
 * operation list and the document it would produce, which is what makes abort
 * safe at any point.
 */
export async function runPipeline(brief: DesignBrief, options: PipelineOptions): Promise<Candidate> {
  const classification = classifySubject(`${brief.subject} ${Object.values(brief.evidence).join(' ')}`)
  const strategy = strategyById(options.strategy ?? STRATEGIES[0].id)
  const constraints = constraintsFor(brief, options.constraints)
  const random = mulberry32((options.seed >>> 0) ^ 0x9e3779b9)

  const realizer = new GraphRealizer(options.base, {
    seed: options.seed,
    idPrefix: options.idPrefix ?? `g${strategy.id.replace(/[^a-z]/g, '')}${options.seed.toString(36)}`,
    constraints,
    ...(options.repairBudget !== undefined ? { repairBudget: options.repairBudget } : {}),
    ...(options.provideGeometry ? { provideGeometry: options.provideGeometry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const { boxes, notes: massingNotes } = await decompose(brief, classification.archetype, strategy, options)
  if (options.signal?.aborted) throw new GenerationCancelled('massing')
  const storeys = boxes.length ? layoutStoreys(boxes) : []

  let graph: BuildGraph = { version: 1, strategy: strategy.id, nodes: [], edges: [] }
  const phases: PhaseEvent[] = []
  const notes: string[] = [...massingNotes]
  let realize: RealizeResult = {
    operations: [],
    document: options.base,
    nodes: [],
    edges: [],
    partCount: 0,
    truncated: false,
    notes: [],
    graphViolations: [],
  }

  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index]
    if (options.signal?.aborted) throw new GenerationCancelled(phase)
    const startedAt = Date.now()
    const before = Object.keys(realize.document.parts).length

    const delta =
      !storeys.length
        ? EMPTY_DELTA
        : phase === 'massing'
        ? massingDelta(brief, storeys)
        : phase === 'skeleton'
          ? skeletonDelta(brief, storeys)
          : phase === 'packing'
            ? packingDelta(brief, storeys)
            : detailDelta(
                brief,
                storeys,
                random,
                new Set(
                  realize.nodes
                    .filter((outcome) => outcome.status === 'realized' || outcome.status === 'repaired')
                    .map((outcome) => outcome.nodeId),
                ),
              )

    graph = {
      ...graph,
      nodes: [...graph.nodes, ...delta.nodes],
      edges: [...graph.edges, ...delta.edges],
    }
    realize = realizer.extend(graph)
    notes.push(...delta.notes)

    const event: PhaseEvent = {
      phase,
      index,
      strategy: strategy.id,
      seed: options.seed,
      graph,
      structuralHash: structuralHash(graph),
      nodesAdded: delta.nodes.length,
      partsAdded: Object.keys(realize.document.parts).length - before,
      metrics: phaseMetrics(realize.document, options.references),
      elapsedMs: Date.now() - startedAt,
      notes: delta.notes,
    }
    phases.push(event)
    options.onPhase?.(event)
  }

  const scoreOptions: ScoreOptions = {
    ...(options.references?.length ? { references: options.references } : {}),
    ...(options.provideGeometry ? { provideGeometry: options.provideGeometry } : {}),
  }

  return {
    id: `${strategy.id}#${options.seed}`,
    strategy: strategy.id,
    seed: options.seed,
    graph,
    structuralHash: structuralHash(graph),
    realize,
    document: realize.document,
    metrics: scoreDocument(realize.document, brief, scoreOptions),
    phases,
    notes: [...notes, ...realize.notes],
    boxes,
  }
}

/** Raised when an `AbortSignal` fires between phases. */
export class GenerationCancelled extends Error {
  constructor(readonly phase: string) {
    super(`Generation was cancelled before the ${phase} phase completed.`)
    this.name = 'GenerationCancelled'
  }
}

/** Kernel ceiling, republished so a caller can size a budget against it. */
export const HARD_PART_CEILING = MAX_GENERATED_PARTS
