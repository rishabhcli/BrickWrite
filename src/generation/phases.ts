import { mulberry32, type DesignBrief, type ModelProvider } from '../platform/contracts'
import { BRICK_LDU, PLATE_LDU, STUD_LDU } from '../cad/catalog'
import { chooseElement, MAX_GENERATED_PARTS } from '../cad/assembly'
import type { ModelDocument, Vec3 } from '../cad/types'
import type { Opening } from '../cad/assembly'
import { classifySubject, type SubjectArchetype } from './brief'
import {
  mergeProtected,
  structuralHash,
  type BuildEdge,
  type BuildGraph,
  type BuildNode,
  type ConnectorRef,
} from './graph'
import { GraphRealizer, resolvePartIdentity, type RealizeConstraints, type RealizeResult } from './realize'
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

/** Stated functions that mean "something here opens", and want a real hinge. */
const OPENING_FUNCTION = /\b(ramp|boarding|gangway|hatch|tailgate|drawbridge|shutter|canopy|lid)\b/i

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
  {
    id: 'play-program',
    label: 'Programmed block',
    rationale:
      'A plinth, two ground-floor bays a vehicle can drive into, a shaft above them and a crown — a building with named rooms rather than three identical storeys.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const plinthCourses = Math.max(1, Math.round(heightCourses * 0.15))
      const bayCourses = Math.max(2, Math.round(heightCourses * 0.3))
      const shaftCourses = Math.max(2, heightCourses - plinthCourses - bayCourses)
      const boxes: MassingBox[] = [
        { id: 'plinth', role: 'plinth', atStuds: [0, 0], widthStuds: width, depthStuds: depth, courses: plinthCourses, level: 0, fill: 'solid' },
      ]

      // Two bays side by side with a stud of pier between them, so the ground
      // floor reads as somewhere things go in and out of rather than as a wall.
      const bayWidth = Math.floor((width - 1) / 2)
      if (bayWidth >= 3 && depth >= 3) {
        boxes.push(
          { id: 'bayLeft', role: 'bay-left', atStuds: [0, 0], widthStuds: bayWidth, depthStuds: depth, courses: bayCourses, level: 1, fill: 'shell' },
          { id: 'bayRight', role: 'bay-right', atStuds: [bayWidth + 1, 0], widthStuds: width - bayWidth - 1, depthStuds: depth, courses: bayCourses, level: 1, fill: 'shell' },
        )
      } else {
        boxes.push({ id: 'bay', role: 'bay-left', atStuds: [0, 0], widthStuds: width, depthStuds: depth, courses: bayCourses, level: 1, fill: 'shell' })
      }

      const shaftWidth = Math.max(3, Math.round(width * 0.55))
      const shaftDepth = Math.max(3, Math.round(depth * 0.55))
      if (shaftCourses >= 2 && shaftWidth <= width && shaftDepth <= depth) {
        boxes.push({
          id: 'shaft',
          role: 'shaft',
          atStuds: [Math.floor((width - shaftWidth) / 2), Math.floor((depth - shaftDepth) / 2)],
          widthStuds: shaftWidth,
          depthStuds: shaftDepth,
          courses: shaftCourses,
          level: 2,
          fill: 'shell',
        })
        const padWidth = Math.max(3, shaftWidth - 2)
        const padDepth = Math.max(3, shaftDepth - 2)
        boxes.push({
          id: 'crown',
          role: 'crown',
          atStuds: [Math.floor((width - padWidth) / 2), Math.floor((depth - padDepth) / 2)],
          widthStuds: padWidth,
          depthStuds: padDepth,
          courses: 1,
          level: 3,
          fill: 'shell',
        })
      }
      return boxes
    },
  },
  {
    id: 'hull-and-keel',
    label: 'Hull and keel',
    rationale:
      'A full-length keel with port and starboard hull volumes flanking it, an offset cockpit and an engine block aft — how a ship reads, which is nothing like how a house reads.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const keelCourses = Math.max(1, Math.round(heightCourses * 0.35))
      const hullCourses = Math.max(2, Math.round(heightCourses * 0.4))
      const boxes: MassingBox[] = [
        { id: 'keel', role: 'keel', atStuds: [0, 0], widthStuds: width, depthStuds: depth, courses: keelCourses, level: 0, fill: 'solid' },
      ]

      // Port and starboard as separate volumes with a channel between them. One
      // full-width box would be a slab; the gap is what makes it a hull.
      const flankDepth = Math.max(3, Math.round(depth * 0.35))
      if (flankDepth * 2 < depth && width >= 3) {
        boxes.push(
          { id: 'port', role: 'port', atStuds: [0, 0], widthStuds: width, depthStuds: flankDepth, courses: hullCourses, level: 1, fill: 'shell' },
          { id: 'starboard', role: 'starboard', atStuds: [0, depth - flankDepth], widthStuds: width, depthStuds: flankDepth, courses: hullCourses, level: 1, fill: 'shell' },
        )
      } else {
        boxes.push({ id: 'hull', role: 'port', atStuds: [0, 0], widthStuds: width, depthStuds: depth, courses: hullCourses, level: 1, fill: 'shell' })
      }

      const cockpitWidth = Math.max(3, Math.round(width * 0.3))
      const cockpitDepth = Math.max(3, Math.round(depth * 0.4))
      const cockpitCourses = Math.max(1, heightCourses - keelCourses - hullCourses)
      if (cockpitCourses >= 1 && cockpitWidth <= width && cockpitDepth <= depth) {
        // Offset rather than centred: a cockpit on the axis is a nose cone, and
        // the whole reason to name this volume is that it sits to one side.
        boxes.push({
          id: 'cockpit',
          role: 'cockpit',
          atStuds: [Math.max(0, width - cockpitWidth), Math.floor((depth - cockpitDepth) / 4)],
          widthStuds: cockpitWidth,
          depthStuds: cockpitDepth,
          courses: cockpitCourses,
          level: 2,
          fill: 'shell',
        })
        const engineWidth = Math.max(3, Math.round(width * 0.25))
        if (engineWidth + cockpitWidth <= width) {
          boxes.push({
            id: 'engine',
            role: 'engine',
            atStuds: [0, Math.floor((depth - cockpitDepth) / 4)],
            widthStuds: engineWidth,
            depthStuds: cockpitDepth,
            courses: cockpitCourses,
            level: 2,
            fill: 'solid',
          })
        }
      }
      return boxes
    },
  },
  {
    id: 'tower-stages',
    label: 'Tower stages',
    rationale:
      'Diminishing stacked footprints — shaft, clock stage, belfry, spire — which is how a landmark carries its height without becoming a box.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const stages: Array<{ id: string; role: string; scale: number; share: number }> = [
        { id: 'stage0', role: 'base', scale: 1, share: 0.35 },
        { id: 'stage1', role: 'clock-stage', scale: 0.75, share: 0.3 },
        { id: 'stage2', role: 'belfry', scale: 0.55, share: 0.2 },
        { id: 'stage3', role: 'spire', scale: 0.4, share: 0.15 },
      ]
      const boxes: MassingBox[] = []
      let level = 0
      for (const stage of stages) {
        const stageWidth = Math.max(3, Math.round(width * stage.scale))
        const stageDepth = Math.max(3, Math.round(depth * stage.scale))
        const courses = Math.round(heightCourses * stage.share)
        if (courses < 1) continue
        // A stage no smaller than the one below it is not a stage.
        const previous = boxes.at(-1)
        if (previous && stageWidth >= previous.widthStuds && stageDepth >= previous.depthStuds) continue
        boxes.push({
          id: stage.id,
          role: stage.role,
          atStuds: [Math.floor((width - stageWidth) / 2), Math.floor((depth - stageDepth) / 2)],
          widthStuds: stageWidth,
          depthStuds: stageDepth,
          courses,
          level,
          fill: level === 0 ? 'solid' : 'shell',
        })
        level += 1
      }
      return boxes.length ? boxes : [groundBox(width, depth, heightCourses)]
    },
  },
  {
    id: 'machine-frame',
    label: 'Machine frame',
    rationale:
      'A heavy base, a narrow mast rising off it and a boom reaching to one side — the massing a crane or a press wants, and one a storey stack cannot express.',
    decompose({ footprint, heightCourses }) {
      const [width, depth] = footprint
      const baseCourses = Math.max(1, Math.round(heightCourses * 0.25))
      const mastCourses = Math.max(2, heightCourses - baseCourses - 1)
      const mastWidth = Math.max(3, Math.round(width * 0.35))
      const mastDepth = Math.max(3, Math.round(depth * 0.35))
      const boxes: MassingBox[] = [
        { id: 'bed', role: 'bed', atStuds: [0, 0], widthStuds: width, depthStuds: depth, courses: baseCourses, level: 0, fill: 'solid' },
      ]
      if (mastWidth <= width && mastDepth <= depth) {
        boxes.push({
          id: 'mast',
          role: 'mast',
          atStuds: [Math.floor((width - mastWidth) / 2), Math.floor((depth - mastDepth) / 2)],
          widthStuds: mastWidth,
          depthStuds: mastDepth,
          courses: mastCourses,
          level: 1,
          fill: 'shell',
        })
        const boomWidth = Math.max(3, Math.round(width * 0.7))
        if (boomWidth <= width) {
          boxes.push({
            id: 'boom',
            role: 'boom',
            atStuds: [Math.max(0, width - boomWidth), Math.floor((depth - mastDepth) / 2)],
            widthStuds: boomWidth,
            depthStuds: mastDepth,
            courses: 1,
            level: 2,
            fill: 'shell',
          })
        }
      }
      return boxes
    },
  },
]

/**
 * Which decomposition a subject wants, before anyone has proposed one.
 *
 * The three original strategies all describe a building, which is why a
 * freighter and a clock tower used to come out of the pipeline as houses. This
 * is the archetype-to-massing map: it decides what a candidate is *first*, and
 * the alternatives after it exist so a builder still gets a choice.
 *
 * The order is the search order. `generate` walks it for candidate 0, 1, 2, so
 * the first candidate is the one the subject asked for and the rest are honest
 * second opinions rather than three variations on a shed.
 */
const PROGRAM_FUNCTIONS = /\b(metro|underground|crane|hangar|bays?|garage|platform|concourse|depot|terminal|interiors?)\b/i

export function strategyOrderFor(brief: DesignBrief, archetype?: SubjectArchetype): string[] {
  const kind = archetype ?? archetypeOf(brief)
  // Everything the compiler recorded, not just the subject phrase: "with a
  // metro station" lands in the evidence, and it is the whole reason to pick a
  // programmed massing over a plain shell.
  const functions = `${brief.functions.join(' ')} ${Object.values(brief.evidence).join(' ')}`
  const rest = (...ids: string[]): string[] => [
    ...ids,
    ...STRATEGIES.map((strategy) => strategy.id).filter((id) => !ids.includes(id)),
  ]

  switch (kind) {
    case 'vehicle':
      return rest('hull-and-keel', 'spine-and-ribs')
    case 'mechanism':
      return rest('machine-frame', 'spine-and-ribs')
    case 'sculpture':
      return rest('tower-stages', 'framed-shell')
    case 'creature':
      return rest('spine-and-ribs', 'stacked-slab')
    case 'building':
      // A building with a stated programme wants named rooms first. A plain one
      // wants its second opinion to be a *structurally* different massing —
      // slabs, then a spine — rather than a second arrangement of rooms nobody
      // asked for.
      return PROGRAM_FUNCTIONS.test(functions) || PROGRAM_FUNCTIONS.test(brief.subject)
        ? rest('play-program', 'framed-shell', 'stacked-slab')
        : rest('framed-shell', 'stacked-slab', 'spine-and-ribs')
    default:
      return rest('framed-shell')
  }
}

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

/**
 * What "large" means when the builder says it and gives no numbers.
 *
 * The default footprints above are minifig-desk scale, and against a request
 * for a large freighter a 14 × 8 × 8 stud envelope is not a small answer, it is
 * the wrong answer — the massing has nowhere to put a keel, two hull halves and
 * a cockpit, so it produces a brick. Anything not listed keeps its default,
 * because "large chair" is still a chair.
 */
const LARGE_FOOTPRINT: Partial<Record<SubjectArchetype, readonly [number, number, number]>> = {
  vehicle: [48, 16, 40],
  building: [32, 40, 32],
  mechanism: [28, 32, 28],
  sculpture: [24, 48, 24],
  creature: [24, 28, 20],
}

/** Part budget assumed when the brief sets none. Bounded well under the kernel cap. */
export const DEFAULT_PART_BUDGET = 420

/**
 * Budget assumed when the brief sets none, by what is being built.
 *
 * A budget is a hard gate, so a default that is too small does not produce a
 * smaller model — it produces no model, scored as "exceeds the 420-part
 * budget". These are sized to the footprints above and stay well under
 * `MAX_GENERATED_PARTS`; a builder who wants a number says one and it wins.
 */
const LARGE_PART_BUDGET: Partial<Record<SubjectArchetype, number>> = {
  vehicle: 1500,
  building: 1200,
  mechanism: 800,
  sculpture: 3000,
  creature: 900,
}

export function defaultPartBudget(brief: DesignBrief, archetype?: SubjectArchetype): number {
  // A stated envelope already says how big the thing is, so the budget can be
  // derived from it rather than guessed. This matters more than it looks: the
  // budget is a *hard gate*, so a default that is too small does not produce a
  // smaller model, it produces a truncated one — and once upper storeys started
  // building, 420 parts stopped being enough for anything with a roof on it. A
  // builder who names a piece count still wins; this is only the fallback.
  if (brief.envelopeStuds) {
    const [width, heightStuds, depth] = brief.envelopeStuds
    // Two cross-bonded plate layers per deck, in 8 x 4 plates.
    const deckParts = Math.ceil((width * depth) / 32) * 2
    const storeys = Math.max(1, Math.min(8, Math.round(heightStuds / 8)))
    // A one-stud perimeter in 1 x 4 bricks, every course of the full height.
    const courses = Math.max(1, Math.floor((heightStuds * STUD_LDU) / BRICK_LDU))
    const wallParts = Math.ceil((2 * (width + depth)) / 4) * courses
    // The margin covers bracing and surface detail, which the estimate above
    // does not model.
    const estimate = Math.round((deckParts * storeys + wallParts) * 1.4)
    return Math.max(DEFAULT_PART_BUDGET, Math.min(MAX_GENERATED_PARTS, estimate))
  }
  if (brief.scale !== 'large') return DEFAULT_PART_BUDGET
  return LARGE_PART_BUDGET[archetype ?? archetypeOf(brief)] ?? DEFAULT_PART_BUDGET
}

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
  /**
   * Which candidate this event belongs to.
   *
   * Candidates run concurrently, so events arrive interleaved. A consumer that
   * assumed arrival order was candidate order would attribute one candidate's
   * packing to another's. This is the same id the finished `Candidate` carries.
   */
  readonly candidateId: string
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

/** Paid model work performed while producing one candidate or one run. */
export interface InferenceUsage {
  /** Successful structured requests. Corrective retries are included in their token totals. */
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
}

const NO_INFERENCE: InferenceUsage = { requests: 0, inputTokens: 0, outputTokens: 0 }

const addInference = (...usage: readonly InferenceUsage[]): InferenceUsage =>
  usage.reduce<InferenceUsage>(
    (total, entry) => ({
      requests: total.requests + entry.requests,
      inputTokens: total.inputTokens + entry.inputTokens,
      outputTokens: total.outputTokens + entry.outputTokens,
    }),
    NO_INFERENCE,
  )

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
  /**
   * The brief the candidate's metrics are measured against, when that differs
   * from the brief it was massed from.
   *
   * `generate_region` is the case that needs it: the region is massed to an
   * 8 × 6 × 8 envelope because that is the space the builder pointed at, but
   * the candidate document also holds the model it was added to, so measuring
   * its extent against the region envelope would fail every time. The two
   * briefs are the same object for a whole-model generate.
   */
  readonly scoreAgainst?: DesignBrief
  /**
   * Where the build starts, in document LDU.
   *
   * Zero — the plate origin — for a whole model. `generate_region` sets it to a
   * measured corner of the existing build so a wing or a ramp is generated
   * where the builder pointed, and so the realiser checks its collisions
   * against the parts that are actually there rather than against an empty
   * volume it would later be translated out of.
   */
  readonly originLdu?: Vec3
}

/**
 * What a candidate ran out of room to build, and how to ask for the rest.
 *
 * A 10,000-part landmark does not fit under the kernel's 4,000-part ceiling,
 * and neither silently returning a third of it nor failing the run is a useful
 * answer. Truncation is reported as a continuation instead: these are the
 * volumes that were massed and not built, and this is the call that builds them
 * onto what is already there.
 */
export interface Continuation {
  readonly reason: 'part-ceiling'
  readonly placedParts: number
  readonly remainingRoles: readonly string[]
  readonly remainingNodes: number
  readonly suggestedTool: 'generate_region'
  readonly suggestedPrompt: string
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
  /** Model requests and tokens used for this candidate. Zero on the deterministic path. */
  readonly inference: InferenceUsage
  /** Boxes the massing settled on, for inspection and for the UI. */
  readonly boxes: MassingBox[]
  /** Set when the part ceiling stopped the build before the massing was finished. */
  readonly continuation: Continuation | null
}

/** Constraints the realiser enforces, derived from the brief unless overridden. */
export function constraintsFor(brief: DesignBrief, override?: RealizeConstraints): RealizeConstraints {
  return {
    partBudget: override?.partBudget ?? brief.partBudget ?? defaultPartBudget(brief),
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
  const envelope =
    brief.envelopeStuds ?? (brief.scale === 'large' ? LARGE_FOOTPRINT[archetype] : undefined) ?? DEFAULT_FOOTPRINT[archetype]
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
/**
 * Openings, but only where a real element will seat in them.
 *
 * An opening the planner cannot fill is not a window, it is a hole: the course
 * is partitioned around a gap and nothing is placed in it. That happened to
 * every door this pipeline ever asked for, because the catalog's only door
 * element is six courses tall and a framed-shell storey is five — so
 * `chooseElement` returned nothing, the wall was cut, and the frame never
 * arrived. The build passed every gate, because a hole is structurally sound.
 *
 * Asking the element library first is what makes the difference between a
 * doorway and a gap.
 */
function openingsFor(brief: DesignBrief, box: MassingBox): Opening[] {
  if (box.courses < 3) return []
  const wants = (pattern: RegExp) => brief.functions.some((entry) => pattern.test(entry))
  const openings: Opening[] = []

  // Doors belong at ground level, where somebody walks in.
  if (box.level === 0 && wants(/door|gate/i) && box.widthStuds >= 10) {
    const door = chooseElement('door', 4, box.courses)
    if (door) {
      openings.push({
        atStud: Math.floor(box.widthStuds / 2) - Math.floor(door.widthStuds / 2),
        widthStuds: door.widthStuds,
        fromCourse: 0,
        toCourse: Math.min(box.courses - 1, door.courses),
        element: 'door',
      })
    }
  }

  // Windows go on every storey, not just the ground floor, and repeat along the
  // run. One window on one level reads as a wall with an accident in it.
  if (wants(/window|shutter/i) && box.widthStuds >= 8) {
    const window = chooseElement('window', 2, Math.max(1, box.courses - 1))
    if (window) {
      const bay = window.widthStuds + 2
      const from = box.level === 0 ? 1 : 0
      for (let at = 2; at + window.widthStuds < box.widthStuds - 1; at += bay) {
        // Clear of the door, which owns the middle of the ground-floor run.
        if (openings.some((opening) => at < opening.atStud + opening.widthStuds + 1 && at + window.widthStuds + 1 > opening.atStud)) {
          continue
        }
        openings.push({
          atStud: at,
          widthStuds: window.widthStuds,
          fromCourse: from + 1,
          toCourse: Math.min(box.courses - 1, from + window.courses),
          element: 'window',
        })
      }
    }
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

/**
 * Which colour each part of the build takes.
 *
 * Every structural phase used to read `baseColour`, so a brief naming five
 * colours produced a model in one: walls, decks and bracing all took
 * `palette[0]` and only the six detail greebles took `palette[1]`. Three of the
 * five were never placed at all. A set is legible because its parts are told
 * apart by colour — the deck reads as a floor, the crown reads as a roof — and
 * a monolith is the one thing a real one never looks like.
 *
 * The palette is honoured exactly, never widened: a builder who names one
 * colour gets one colour, and `generation.test.ts` asserts no part falls
 * outside what the brief asked for.
 */
interface ColourScheme {
  /** Decks and floors. */
  readonly deck: number
  /** Perimeter shells — the colour the model reads as. */
  readonly wall: number
  /** Interior bracing, mostly unseen. */
  readonly brace: number
  /** Surface detail. */
  readonly detail: number
}

function colourScheme(brief: DesignBrief): ColourScheme {
  const palette = brief.palette
  const wall = baseColour(brief)
  if (palette.length < 2) {
    // One stated colour means one colour. Detail keeps its historical black
    // default only when nothing was stated at all.
    return { deck: wall, wall, brace: wall, detail: palette.length ? wall : accentColour(brief, 0) }
  }
  return {
    wall,
    deck: palette[1],
    // Bracing is interior. With a third colour it gets its own; with two it
    // matches the walls it braces rather than striping the inside of the model.
    brace: palette[2] ?? wall,
    detail: palette[palette.length - 1],
  }
}

// ---------------------------------------------------------------------------
// Phase proposers
// ---------------------------------------------------------------------------

function massingDelta(brief: DesignBrief, storeys: readonly StoreyLayout[], origin: Vec3 = [0, 0, 0]): PhaseDelta {
  const nodes: BuildNode[] = []
  const colour = colourScheme(brief).deck
  for (const storey of storeys) {
    nodes.push({
      id: deckNodeId(storey.level),
      kind: 'region',
      colour,
      role: storey.level === 0 ? 'base' : `storey${storey.level}`,
      // The only absolute coordinate in a candidate. Everything after this is
      // an edge to a connector, which is why moving the origin moves the whole
      // build rather than shearing it.
      anchorLdu: [
        origin[0] + storey.atStuds[0] * STUD_LDU,
        origin[1] + storey.baseY,
        origin[2] + storey.atStuds[1] * STUD_LDU,
      ],
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
  const colour = colourScheme(brief).wall
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
  const colour = colourScheme(brief).brace
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
          // The box's own role, not `${box.role}_brace`: the role is what the
          // realiser groups parts into subassemblies by, and a builder who
          // wants to lock the keel means the keel and its bracing, not the
          // shell of the keel and a second assembly they have to find.
          role: box.role,
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
  proposal?: DetailProposal,
): PhaseDelta {
  const nodes: BuildNode[] = []
  const edges: BuildEdge[] = []
  const notes: string[] = []
  const accent = colourScheme(brief).detail
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

  // A stated function comes before decoration. "With a boarding ramp" is not a
  // greeble: it is the one thing in the brief that has to move, and the kernel
  // can drive a hinge as a revolute joint once the flap is built. Detail is
  // also the right phase for it — by now something is actually standing to
  // hang it off.
  const flapHost = ranked
    .map((storey) => ({ width: storey.widthStuds, depth: storey.depthStuds, node: deckNodeId(storey.level), level: storey.level }))
    .filter((entry) => placed.has(entry.node))
    .sort((a, b) => a.level - b.level)[0]
  if (flapHost && OPENING_FUNCTION.test(`${brief.subject} ${brief.functions.join(' ')} ${Object.values(brief.evidence).join(' ')}`)) {
    const flapWidth = Math.max(2, Math.min(8, Math.trunc(flapHost.width / 3) * 2 || 2))
    nodes.push({
      id: 'flap',
      kind: 'region',
      colour: accent,
      role: 'ramp',
      region: {
        shape: 'hinged-flap',
        widthStuds: flapWidth,
        depthStuds: Math.max(2, Math.round(flapWidth / 2)),
        courses: 1,
        family: 'plate',
        reachStuds: Math.max(2, Math.round(flapWidth / 2)),
      },
    })
    edges.push({
      id: 'e_flap',
      from: flapHost.node,
      to: 'flap',
      fromConnector: topStud(Math.max(0, Math.floor((flapHost.width - flapWidth) / 2)), 0),
      toConnector: underside,
      family: 'stud',
    })
    notes.push(`Detail: a ${flapWidth}-stud hinged flap on ${flapHost.node} for the opening the brief asked for.`)
  }

  // A model that proposed surface elements gets them, resolved by the kernel.
  // What it proposed is a *query* and a count against a named volume — never an
  // identity, never a coordinate. `resolveIdentity` answers the query out of
  // the placeable, geometry-carrying catalog, so an element the model invented
  // simply finds no match and is reported, rather than becoming a part nobody
  // can build.
  // A model that proposed surface features gets them, resolved by the kernel.
  // Each one names a volume, a query and a stud on that volume; an id, a colour
  // or a world coordinate is not on offer, so the worst a bad proposal can do
  // is match no part and be reported.
  if (proposal?.features.length) {
    const byRole = new Map<string, { width: number; depth: number; node: string }>()
    for (const storey of ranked) {
      for (const box of storey.boxes) {
        const node = shellNodeId(box)
        if (placed.has(node)) byRole.set(box.role, { width: box.widthStuds, depth: box.depthStuds, node })
      }
      const deck = deckNodeId(storey.level)
      if (placed.has(deck)) {
        byRole.set(`deck${storey.level}`, { width: storey.widthStuds, depth: storey.depthStuds, node: deck })
        if (!byRole.has(storey.boxes[0]?.role ?? '')) {
          for (const box of storey.boxes) {
            if (!byRole.has(box.role)) byRole.set(box.role, { width: storey.widthStuds, depth: storey.depthStuds, node: deck })
          }
        }
      }
    }

    const skipped: string[] = []
    for (const [index, feature] of proposal.features.entries()) {
      const host = byRole.get(feature.role)
      if (!host) {
        skipped.push(`${feature.id}: volume “${feature.role}” was not built`)
        continue
      }
      const resolution = resolvePartIdentity({ query: feature.query })
      if (!resolution.definition) {
        skipped.push(`${feature.id}: ${resolution.explanation}`)
        continue
      }
      const id = `detail_${index}_${feature.id.replace(/[^a-zA-Z0-9_]/g, '')}`
      nodes.push({
        id,
        kind: 'part',
        colour: accent,
        role: 'detail',
        // Pin the grounded identity. The realiser tier-checks it again, but it
        // cannot drift to a different lexical match between proposal review
        // and placement.
        part: { query: feature.query, definitionId: resolution.definition.canonicalId },
        ...(feature.quarterTurns ? { quarterTurns: feature.quarterTurns } : {}),
      })
      edges.push({
        id: `e_${id}`,
        from: host.node,
        to: id,
        // Clamped into the host's own footprint: a stud past the edge is not a
        // placement the snapper can find, and refusing it here names the reason.
        fromConnector: topStud(
          clampInt(feature.atXStuds, 0, Math.max(0, host.width - 1)),
          clampInt(feature.atZStuds, 0, Math.max(0, host.depth - 1)),
        ),
        toConnector: underside,
        family: 'stud',
      })
    }
    if (nodes.length) {
      notes.push(
        `Detail: ${nodes.length} of ${proposal.features.length} feature(s) proposed by the model were grounded to built volumes and placeable catalog identities.`,
      )
      if (skipped.length) notes.push(`Detail skipped ${skipped.length} ungrounded proposal(s): ${skipped.slice(0, 4).join('; ')}.`)
      return { nodes, edges, notes }
    }

    // A schema-valid payload can still be useless: part queries and volume
    // roles are open vocabulary. Falling through gives the model a visible,
    // deterministic surface instead of a syntactically successful empty one.
    notes.push(
      `detail:fallback — none of ${proposal.features.length} model-proposed feature(s) grounded to a built volume and a placeable catalog identity${
        skipped.length ? ` (${skipped.slice(0, 4).join('; ')})` : ''
      }; the deterministic surface was used instead.`,
    )
  }

  // Every surface that actually got built, not only the topmost one.
  //
  // Detail used to land on a single host — the highest placed node — so a
  // four-storey tower carried six tiles on its crown and nothing anywhere
  // else, and a 24 x 24 deck carried the same six as a 4 x 4 one. Spreading
  // over the placed surfaces and scaling each by its own footprint is what
  // makes the count describe the model rather than a constant.
  const surfaces = ranked
    .flatMap((storey) => [
      ...storey.boxes.map((box) => ({ width: box.widthStuds, depth: box.depthStuds, node: shellNodeId(box) })),
      { width: storey.widthStuds, depth: storey.depthStuds, node: deckNodeId(storey.level) },
    ])
    .filter((entry) => placed.has(entry.node))
  const targets = surfaces.length ? surfaces : [hosted]

  // A ceiling, because detail costs more than its share of both budgets.
  //
  // Parts: a candidate truncated halfway through its walls to make room for
  // greebles is a worse model than a plain one.
  //
  // Time: a region is one placement for hundreds of parts, but detail is one
  // placement *per part*, and each pays three full-document scans in
  // `rejectionFor` — `floatingPartIds`, `airbornePartIds` and
  // `unclutchedRestPartIds` all rebuild the connection graph and every part's
  // bounds. Measured on a 939-part tower that is ~157ms per detail part against
  // ~1.2ms per part for packing, so the detail phase was 63% of the runtime for
  // 3% of the model. This bound keeps the phase in proportion; making the scans
  // themselves scoped is the real fix and is recorded in NIGHT-QUEUE.
  const DETAIL_CEILING = 24
  let placedDetail = 0

  for (const [hostIndex, host] of targets.entries()) {
    if (placedDetail >= DETAIL_CEILING) break
    const count = clampInt((host.width + host.depth) / 10, 2, 5)
    for (let index = 0; index < count && placedDetail < DETAIL_CEILING; index += 1) {
      const u = clampInt(1 + random() * Math.max(1, host.width - 3), 1, Math.max(1, host.width - 2))
      const v = index % 2 === 0 ? 0 : Math.max(0, host.depth - 1)
      const id = `detail_${hostIndex}_${index}`
      nodes.push({
        id,
        kind: 'part',
        colour: accent,
        role: 'detail',
        part: { query: 'tile 1 x 2 with groove', sizeStuds: [2, 1, 1] },
      })
      edges.push({
        id: `e_${id}`,
        from: host.node,
        to: id,
        fromConnector: topStud(u, v),
        toConnector: underside,
        family: 'stud',
      })
      placedDetail += 1
      if (mirrored && placedDetail < DETAIL_CEILING) {
        const mirrorId = `${id}_m`
        nodes.push({
          id: mirrorId,
          kind: 'part',
          colour: accent,
          role: 'detail',
          part: { query: 'tile 1 x 2 with groove', sizeStuds: [2, 1, 1] },
        })
        edges.push({
          id: `e_${mirrorId}`,
          from: host.node,
          to: mirrorId,
          fromConnector: topStud(Math.max(0, host.width - 1 - u), v),
          toConnector: underside,
          family: 'stud',
        })
        placedDetail += 1
      }
    }
  }
  notes.push(
    `Detail: ${nodes.length} surface element(s) across ${targets.length} surface(s)${mirrored ? ', mirrored about the long axis' : ''}.`,
  )
  return { nodes, edges, notes }
}

// ---------------------------------------------------------------------------
// Model-proposed decomposition
// ---------------------------------------------------------------------------

/**
 * Surface features a model may propose, and the ceiling on them.
 *
 * The detail phase used to place `tile 1 x 2 with groove` on everything, so a
 * castle and a spaceship were greebled identically. This is the seam where a
 * model gets to say what the surface of *this* subject is made of.
 *
 * The shape is the point, and it is the same shape `server/generation/schema.ts`
 * has always validated: a feature names a **volume**, a **query** and a stud on
 * that volume's lattice. Never an identity — the kernel resolves the query
 * against the placeable, geometry-carrying catalog, so a part the model
 * imagined simply matches nothing. Never a coordinate — `atXStuds` and
 * `atZStuds` index the host's own studs, and the snapper computes the pose.
 */
export const MAX_DETAIL_FEATURES = 24

export const DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['features'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'query', 'atXStuds', 'atZStuds', 'quarterTurns'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          role: { type: 'string', minLength: 1, maxLength: 40 },
          query: { type: 'string', minLength: 1, maxLength: 80 },
          atXStuds: { type: 'integer' },
          atZStuds: { type: 'integer' },
          quarterTurns: { type: 'integer' },
        },
      },
    },
  },
} as const

export interface DetailFeature {
  readonly id: string
  readonly role: string
  readonly query: string
  readonly atXStuds: number
  readonly atZStuds: number
  readonly quarterTurns: number
}

export interface DetailProposal {
  readonly features: readonly DetailFeature[]
}

export const DETAIL_SYSTEM = [
  'You choose the surface features of a LEGO model whose structure is already built.',
  'You are given the named volumes of the massing, each with its footprint in studs. Each feature you propose sits on the top surface of one of those volumes.',
  'role names one of the volumes you were given. query is a plain-language part description — "tile 1 x 2 with groove", "grille tile", "slope brick 2 x 2", "round plate 1 x 1", "windscreen".',
  'atXStuds and atZStuds are stud coordinates on that volume, counted from its minimum corner, and must lie inside its footprint. quarterTurns is 0, 1, 2 or 3 about the vertical axis.',
  'Never name a part number, a colour or a world coordinate. The kernel resolves your query against the parts it can actually build with, and its connector solver computes the pose.',
  `Return at most ${MAX_DETAIL_FEATURES} features. Detail is surface: greebles, tiles, glazing, accents. It is not structure, and it is not the functions the brief asked for.`,
].join(' ')

/**
 * Reads a detail proposal, or refuses it.
 *
 * Clamped rather than trusted, and thrown on rather than repaired into
 * something the model did not say: a caller that gets an exception falls back
 * to the deterministic tiles and records that it did, which is a result the
 * operator can see. Silently keeping half of a malformed proposal would be a
 * third behaviour nobody asked for.
 */
export function parseDetail(raw: unknown): DetailProposal {
  if (!raw || typeof raw !== 'object') throw new Error('The detail response was not a JSON object.')
  const features = (raw as { features?: unknown }).features
  if (!Array.isArray(features) || !features.length) throw new Error('Field "features" was missing or empty.')
  if (features.length > MAX_DETAIL_FEATURES) {
    throw new Error(`Field "features" held ${features.length} entries; at most ${MAX_DETAIL_FEATURES} are allowed.`)
  }
  return {
    features: features.map((entry, index): DetailFeature => {
      const feature = entry as Record<string, unknown>
      const text = (key: string): string => {
        const value = feature[key]
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Feature ${index} has no "${key}".`)
        return value.trim()
      }
      const number = (key: string): number => {
        const value = feature[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Feature ${index} has no numeric "${key}".`)
        return Math.trunc(value)
      }
      return {
        id: text('id'),
        role: text('role'),
        query: text('query'),
        atXStuds: Math.max(0, number('atXStuds')),
        atZStuds: Math.max(0, number('atZStuds')),
        quarterTurns: clampInt(number('quarterTurns'), 0, 3),
      }
    }),
  }
}

/**
 * Asks the model what this subject's surface is made of.
 *
 * Returns null rather than throwing: a detail proposal is an improvement on the
 * deterministic tiles, never a precondition for a candidate. Losing it costs
 * greebles; failing the run over it would cost the model.
 */
async function proposeDetail(
  brief: DesignBrief,
  boxes: readonly MassingBox[],
  options: PipelineOptions,
  maxFeatures = MAX_DETAIL_FEATURES,
): Promise<{ proposal: DetailProposal | null; notes: string[]; inference: InferenceUsage }> {
  if (!options.provider) return { proposal: null, notes: [], inference: NO_INFERENCE }
  if (!boxes.length) {
    return {
      proposal: null,
      notes: ['Detail model skipped because the structural phases produced no buildable surface.'],
      inference: NO_INFERENCE,
    }
  }
  const featureBudget = clampInt(maxFeatures, 0, MAX_DETAIL_FEATURES)
  if (featureBudget === 0) {
    return {
      proposal: null,
      notes: ['Detail model skipped because the structural phases spent the candidate part budget.'],
      inference: NO_INFERENCE,
    }
  }
  try {
    const result = await options.provider.complete<DetailProposal>({
      system: DETAIL_SYSTEM,
      prompt: [
        `Subject: ${brief.subject}`,
        `Scale: ${brief.scale}. Style: ${brief.style.length ? brief.style.join(', ') : 'none stated'}.`,
        brief.functions.length ? `Functions: ${brief.functions.join(', ')}.` : 'Functions: none stated.',
        `Volumes: ${boxes.map((box) => `${box.role} (${box.widthStuds} × ${box.depthStuds} studs)`).join('; ')}.`,
        `Feature budget: at most ${featureBudget}. These are the volumes the kernel actually built; do not name another one.`,
        `Variation seed: ${options.seed}.`,
      ].join('\n'),
      schema: DETAIL_SCHEMA,
      parse: parseDetail,
      ...(options.signal ? { signal: options.signal } : {}),
      maxTokens: 1200,
      temperature: 0,
    })
    const proposal = result.value.features.length > featureBudget
      ? { features: result.value.features.slice(0, featureBudget) }
      : result.value
    return {
      proposal,
      notes: [
        `Detail proposed by ${result.provenance.model ?? result.provenance.provider} against ${boxes.length} kernel-built volume(s).`,
        ...(result.value.features.length > featureBudget
          ? [`Detail budget kept ${featureBudget} of ${result.value.features.length} proposed feature(s).`]
          : []),
      ],
      inference: { requests: 1, ...result.usage },
    }
  } catch (cause) {
    // `detail:fallback` is one token an operator and a test can both grep for.
    return {
      proposal: null,
      notes: [
        `detail:fallback — the model's detail proposal was not usable (${(cause as Error)?.message ?? cause}); the deterministic surface was used instead.`,
      ],
      inference: NO_INFERENCE,
    }
  }
}

/**
 * How many volumes one decomposition may name.
 *
 * Eight was enough for a building. A freighter with a keel, two hull halves, a
 * cockpit, an engine block and a ramp is already six before any greeble, and a
 * landmark's stages plus its platforms run past that.
 */
export const MAX_MASSING_BOXES = 16

/**
 * The wire schema for a decomposition.
 *
 * Written to the subset the structured-output endpoint actually accepts, which
 * is narrower than JSON Schema and was established by probing rather than
 * assumed: `minItems`/`maxItems`, `minimum`/`maximum` and open-ended
 * `additionalProperties` maps are all rejected outright. Two consequences are
 * visible here — the position is two scalars rather than a two-element array,
 * and no numeric range appears — and both are enforced anyway, by the zod
 * validator on the server and by `parseMassing` here. The endpoint constrains
 * the *shape*; this side constrains the *values*.
 */
export const MASSING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['boxes'],
  properties: {
    boxes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'atXStuds', 'atZStuds', 'widthStuds', 'depthStuds', 'courses', 'level', 'fill'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 40 },
          role: { type: 'string', minLength: 1, maxLength: 40 },
          atXStuds: { type: 'integer' },
          atZStuds: { type: 'integer' },
          widthStuds: { type: 'integer' },
          depthStuds: { type: 'integer' },
          courses: { type: 'integer' },
          level: { type: 'integer' },
          fill: { type: 'string', enum: ['shell', 'solid'] },
        },
      },
    },
  },
} as const

/** One box as it travels on the wire, before it becomes a `MassingBox`. */
export interface RawMassingBox {
  readonly id: string
  readonly role: string
  readonly atXStuds: number
  readonly atZStuds: number
  readonly widthStuds: number
  readonly depthStuds: number
  readonly courses: number
  readonly level: number
  readonly fill: 'shell' | 'solid'
}

const MASSING_SYSTEM = [
  'You decompose a LEGO design brief into a small set of axis-aligned rectangular boxes on the stud lattice.',
  'Boxes describe volume only. Do not describe parts, colours or connections; a deterministic kernel fills them.',
  'atXStuds and atZStuds are the box minimum corner in studs from the build origin, and are never negative.',
  'Level 0 rests on the ground plane; each higher level rests on the level below.',
  'courses is height in standard brick courses (24 LDU each).',
  'Every box must be at least 3 studs wide and 3 studs deep, and must stay inside the stated envelope.',
  'Roles name what a volume is for. Prefer these where they fit: base, plinth, bay-left, bay-right, shaft, crown, pad, keel, port, starboard, cockpit, engine, clock-stage, belfry, spire, bed, mast, boom.',
  'Return between one and sixteen boxes; prefer four or fewer unless the subject genuinely needs more — a vehicle or a landmark usually does, a shed does not.',
].join(' ')

interface RawMassing {
  boxes: RawMassingBox[]
}

function parseMassing(raw: unknown): RawMassing {
  if (!raw || typeof raw !== 'object') throw new Error('The massing response was not a JSON object.')
  const boxes = (raw as { boxes?: unknown }).boxes
  if (!Array.isArray(boxes) || !boxes.length) throw new Error('Field "boxes" was missing or empty.')
  if (boxes.length > MAX_MASSING_BOXES) throw new Error(`Field "boxes" held ${boxes.length} entries; at most ${MAX_MASSING_BOXES} are allowed.`)
  return {
    boxes: boxes.map((entry, index): RawMassingBox => {
      const box = entry as Record<string, unknown>
      const number = (key: string): number => {
        const value = box[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Box ${index} has no numeric "${key}".`)
        return Math.trunc(value)
      }
      if (box.fill !== 'shell' && box.fill !== 'solid') throw new Error(`Box ${index} has an unknown "fill".`)
      if (typeof box.id !== 'string' || !box.id.trim()) throw new Error(`Box ${index} has no id.`)
      return {
        id: box.id.trim(),
        role: typeof box.role === 'string' && box.role.trim() ? box.role.trim() : `box${index}`,
        atXStuds: number('atXStuds'),
        atZStuds: number('atZStuds'),
        widthStuds: number('widthStuds'),
        depthStuds: number('depthStuds'),
        courses: number('courses'),
        level: number('level'),
        fill: box.fill,
      }
    }),
  }
}

/** Wire boxes as the pipeline's own type. Range checks happen in `clampBoxes`. */
export const fromRawBoxes = (boxes: readonly RawMassingBox[]): MassingBox[] =>
  boxes.map((box) => ({
    id: box.id,
    role: box.role,
    atStuds: [box.atXStuds, box.atZStuds] as const,
    widthStuds: box.widthStuds,
    depthStuds: box.depthStuds,
    courses: box.courses,
    level: box.level,
    fill: box.fill,
  }))

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
    const x = clampInt(Math.max(0, box.atStuds[0]), 0, Math.max(0, width - 3))
    const z = clampInt(Math.max(0, box.atStuds[1]), 0, Math.max(0, depth - 3))
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

export interface StabilizedMassing {
  readonly boxes: MassingBox[]
  /** Human-readable repairs applied before any graph or part was produced. */
  readonly notes: string[]
  readonly repairedBoxes: number
  readonly droppedBoxes: number
}

/**
 * Makes a schema-valid massing stack physically meaningful before realisation.
 *
 * Numeric bounds are not enough for a stack: a model can return levels 2 and 7
 * with no ground floor, or put an upper volume completely outside the deck
 * below it. `layoutStoreys` would still make rectangles from that payload and
 * the snap solver would then be asked to repair a planning error it cannot
 * faithfully interpret. This pass keeps the model's roles and proportions but:
 *
 * - compacts the levels to 0..N, so every stack begins on the ground;
 * - constrains each upper footprint to the deck carried by the previous level;
 * - drops an upper box only when no 3 x 3 supported footprint can exist.
 *
 * Every repair is reported. The function is deterministic and is exported so
 * the contract can be regression-tested independently of a provider.
 */
export function stabilizeMassing(boxes: readonly MassingBox[]): StabilizedMassing {
  if (!boxes.length) return { boxes: [], notes: [], repairedBoxes: 0, droppedBoxes: 0 }

  const sourceLevels = [...new Set(boxes.map((box) => box.level))].sort((a, b) => a - b)
  const compactLevel = new Map(sourceLevels.map((level, index) => [level, index]))
  const stabilized: MassingBox[] = []
  const repairs = new Set<string>()
  let droppedBoxes = 0

  for (const sourceLevel of sourceLevels) {
    const level = compactLevel.get(sourceLevel) ?? 0
    const own = boxes.filter((box) => box.level === sourceLevel)
    const supportBoxes = level > 0 ? stabilized.filter((box) => box.level === level - 1) : []
    const support = supportBoxes.length ? rectUnion(supportBoxes) : null

    for (const box of own) {
      if (level === 0) {
        if (box.level !== level) repairs.add(`${box.id}: level ${box.level} -> ${level}`)
        stabilized.push({ ...box, level })
        continue
      }

      if (!support) {
        droppedBoxes += 1
        repairs.add(`${box.id}: dropped because level ${level - 1} has no supporting volume`)
        continue
      }

      if (support.widthStuds < 3 || support.depthStuds < 3) {
        droppedBoxes += 1
        repairs.add(`${box.id}: dropped because level ${level - 1} has no 3 x 3 supporting deck`)
        continue
      }

      const maxX = support.atStuds[0] + support.widthStuds
      const maxZ = support.atStuds[1] + support.depthStuds
      const x = clampInt(box.atStuds[0], support.atStuds[0], maxX - 3)
      const z = clampInt(box.atStuds[1], support.atStuds[1], maxZ - 3)
      const widthStuds = Math.min(box.widthStuds, maxX - x)
      const depthStuds = Math.min(box.depthStuds, maxZ - z)

      if (widthStuds < 3 || depthStuds < 3) {
        droppedBoxes += 1
        repairs.add(`${box.id}: dropped because it has no supported 3 x 3 footprint on level ${level - 1}`)
        continue
      }

      const changed = box.level !== level
        || box.atStuds[0] !== x
        || box.atStuds[1] !== z
        || box.widthStuds !== widthStuds
        || box.depthStuds !== depthStuds
      if (changed) {
        repairs.add(
          `${box.id}: level ${box.level} at ${box.atStuds[0]},${box.atStuds[1]} ${box.widthStuds} x ${box.depthStuds} -> level ${level} at ${x},${z} ${widthStuds} x ${depthStuds}`,
        )
      }
      stabilized.push({ ...box, level, atStuds: [x, z], widthStuds, depthStuds })
    }
  }

  return {
    boxes: stabilized,
    notes: repairs.size
      ? [`Massing audit repaired ${repairs.size} stack issue(s): ${[...repairs].slice(0, 6).join('; ')}.`]
      : [],
    repairedBoxes: repairs.size - droppedBoxes,
    droppedBoxes,
  }
}

interface Massing {
  boxes: MassingBox[]
  notes: string[]
  inference: InferenceUsage
}

/**
 * The strategy's own decomposition, with no model in the loop.
 *
 * Split out from {@link decompose} so there is a path through the whole
 * pipeline that never returns a promise. `generate_from_brief` is a shared
 * capability, and `planSharedMutation` is synchronous for every other
 * capability in the vocabulary; making it async for one would mean every
 * caller — including the kernel's own tests — had to await a plan that does no
 * I/O.
 */
function deterministicMassing(
  brief: DesignBrief,
  archetype: SubjectArchetype,
  strategy: GenerationStrategy,
  options: PipelineOptions,
): Massing {
  const { footprint, heightCourses } = volumeFor(brief, archetype)
  const maxHeightLdu = brief.envelopeStuds ? brief.envelopeStuds[1] * STUD_LDU : Number.POSITIVE_INFINITY
  const random = mulberry32(options.seed >>> 0)
  const boxes = strategy.decompose({ brief, archetype, footprint, heightCourses, random })
  return {
    boxes: fitBoxHeights(clampBoxes(boxes, footprint, heightCourses), maxHeightLdu),
    notes: [`Massing came from the “${strategy.label}” rule set; no model provider was configured.`],
    inference: NO_INFERENCE,
  }
}

async function decompose(
  brief: DesignBrief,
  archetype: SubjectArchetype,
  strategy: GenerationStrategy,
  options: PipelineOptions,
): Promise<Massing> {
  if (!options.provider) return deterministicMassing(brief, archetype, strategy, options)

  const { footprint, heightCourses } = volumeFor(brief, archetype)
  const maxHeightLdu = brief.envelopeStuds ? brief.envelopeStuds[1] * STUD_LDU : Number.POSITIVE_INFINITY
  const fit = (boxes: readonly MassingBox[]) => {
    const audited = stabilizeMassing(clampBoxes(boxes, footprint, heightCourses))
    return { ...audited, boxes: fitBoxHeights(audited.boxes, maxHeightLdu) }
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

  const audited = fit(fromRawBoxes(result.value.boxes))
  if (!audited.boxes.length) {
    return {
      boxes: deterministicMassing(brief, archetype, strategy, options).boxes,
      notes: [
        `The model proposed ${result.value.boxes.length} box(es), none of which survived envelope and stack validation; the “${strategy.label}” rule set was used instead.`,
        ...audited.notes,
      ],
      inference: { requests: 1, ...result.usage },
    }
  }
  return {
    boxes: audited.boxes,
    notes: [
      `Massing proposed by ${result.provenance.model ?? result.provenance.provider} under the “${strategy.label}” approach.`,
      ...audited.notes,
    ],
    inference: { requests: 1, ...result.usage },
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
  const strategy = strategyById(options.strategy ?? strategyOrderFor(brief)[0])
  const archetype = archetypeOf(brief)
  const massing = await decompose(brief, archetype, strategy, options)
  if (options.signal?.aborted) throw new GenerationCancelled('massing')

  // Detail is intentionally proposed after the first three kernel phases. The
  // model now sees only roles that really produced a surface, and the number of
  // feature slots left in the hard part budget. Previously this request ran
  // against optimistic massing boxes before the realiser had accepted a single
  // one, which wasted tokens and encouraged features on volumes that would
  // never exist.
  const assembly = createCandidateAssembly(brief, options, strategy, massing)
  for (const phase of PHASES.slice(0, -1)) runCandidatePhase(assembly, phase)
  const detail = await proposeDetail(
    brief,
    builtDetailBoxes(assembly),
    options,
    remainingDetailCapacity(assembly),
  )
  if (options.signal?.aborted) throw new GenerationCancelled('detail')
  assembly.notes.push(...detail.notes)
  assembly.inference = addInference(assembly.inference, detail.inference)
  runCandidatePhase(assembly, 'detail', detail.proposal)
  return finishCandidate(assembly)
}

/**
 * The pipeline with the model left out.
 *
 * Identical to {@link runPipeline} except that massing comes from the
 * strategy's rule set, which is the one phase a provider participates in. Used
 * by the `generate_from_brief` shared capability, and by tests that want a real
 * candidate without a network.
 */
export function runPipelineSync(brief: DesignBrief, options: PipelineOptions): Candidate {
  const strategy = strategyById(options.strategy ?? strategyOrderFor(brief)[0])
  const archetype = archetypeOf(brief)
  return assembleCandidate(brief, options, strategy, deterministicMassing(brief, archetype, strategy, options))
}

const archetypeOf = (brief: DesignBrief): SubjectArchetype =>
  classifySubject(`${brief.subject} ${Object.values(brief.evidence).join(' ')}`).archetype

interface CandidateAssembly {
  readonly brief: DesignBrief
  readonly options: PipelineOptions
  readonly strategy: GenerationStrategy
  readonly constraints: RealizeConstraints
  readonly random: () => number
  readonly origin: Vec3
  readonly realizer: GraphRealizer
  readonly boxes: MassingBox[]
  readonly storeys: StoreyLayout[]
  readonly candidateId: string
  readonly protectedIds: readonly string[]
  readonly existingPartIds: ReadonlySet<string>
  graph: BuildGraph
  readonly phases: PhaseEvent[]
  readonly notes: string[]
  inference: InferenceUsage
  realize: RealizeResult
}

function createCandidateAssembly(
  brief: DesignBrief,
  options: PipelineOptions,
  strategy: GenerationStrategy,
  massing: Massing,
): CandidateAssembly {
  const constraints = constraintsFor(brief, options.constraints)
  const realizer = new GraphRealizer(options.base, {
    seed: options.seed,
    idPrefix: options.idPrefix ?? `g${strategy.id.replace(/[^a-z]/g, '')}${options.seed.toString(36)}`,
    constraints,
    ...(options.repairBudget !== undefined ? { repairBudget: options.repairBudget } : {}),
    ...(options.provideGeometry ? { provideGeometry: options.provideGeometry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })

  return {
    brief,
    options,
    strategy,
    constraints,
    random: mulberry32((options.seed >>> 0) ^ 0x9e3779b9),
    origin: options.originLdu ?? [0, 0, 0],
    realizer,
    boxes: massing.boxes,
    storeys: massing.boxes.length ? layoutStoreys(massing.boxes) : [],
    candidateId: `${strategy.id}#${options.seed}`,
    protectedIds: constraints.protectedPartIds ?? [],
    existingPartIds: new Set(Object.keys(options.base.parts)),
    graph: { version: 1, strategy: strategy.id, nodes: [], edges: [] },
    phases: [],
    notes: [...massing.notes],
    inference: massing.inference,
    realize: {
      operations: [],
      document: options.base,
      nodes: [],
      edges: [],
      partCount: 0,
      truncated: false,
      notes: [],
      graphViolations: [],
    },
  }
}

const placedNodeIds = (assembly: CandidateAssembly): Set<string> =>
  new Set(
    assembly.realize.nodes
      .filter((outcome) => outcome.status === 'realized' || outcome.status === 'repaired')
      .map((outcome) => outcome.nodeId),
  )

/** Volumes that still have a shell or carrying deck after kernel realisation. */
const builtDetailBoxes = (assembly: CandidateAssembly): MassingBox[] => {
  const placed = placedNodeIds(assembly)
  return assembly.boxes.filter((box) => placed.has(shellNodeId(box)) || placed.has(deckNodeId(box.level)))
}

/** One proposed surface part consumes at least one remaining part slot. */
const remainingDetailCapacity = (assembly: CandidateAssembly): number => {
  const declared = assembly.constraints.partBudget ?? Number.POSITIVE_INFINITY
  const ceiling = Math.min(declared, MAX_GENERATED_PARTS)
  return clampInt(ceiling - assembly.realize.partCount, 0, MAX_DETAIL_FEATURES)
}

function runCandidatePhase(
  assembly: CandidateAssembly,
  phase: PhaseName,
  detail?: DetailProposal | null,
): void {
  const { brief, options, strategy, storeys } = assembly
  const index = PHASES.indexOf(phase)
  if (options.signal?.aborted) throw new GenerationCancelled(phase)
  const startedAt = Date.now()
  const before = Object.keys(assembly.realize.document.parts).length

  const delta =
    !storeys.length
      ? EMPTY_DELTA
      : phase === 'massing'
        ? massingDelta(brief, storeys, assembly.origin)
        : phase === 'skeleton'
          ? skeletonDelta(brief, storeys)
          : phase === 'packing'
            ? packingDelta(brief, storeys)
            : detailDelta(brief, storeys, assembly.random, placedNodeIds(assembly), detail ?? undefined)

  assembly.graph = {
    ...assembly.graph,
    nodes: [...assembly.graph.nodes, ...delta.nodes],
    edges: [...assembly.graph.edges, ...delta.edges],
  }
  // Parts the brief froze enter the graph as protected nodes rather than as
  // an out-of-band exclusion list. That is what makes "leave these alone"
  // enforceable instead of merely intended: `validateGraph` refuses any edge
  // that would place one, and the realiser emits nothing for them.
  if (assembly.protectedIds.length) {
    const merged = mergeProtected(assembly.graph, assembly.protectedIds, assembly.existingPartIds)
    assembly.graph = merged.graph
    if (merged.missing.length && index === 0) {
      assembly.notes.push(
        `${merged.missing.length} protected part id(s) are not in the base document and were ignored: ${merged.missing.slice(0, 5).join(', ')}.`,
      )
    }
  }
  assembly.realize = assembly.realizer.extend(assembly.graph)
  assembly.notes.push(...delta.notes)

  const event: PhaseEvent = {
    phase,
    index,
    candidateId: assembly.candidateId,
    strategy: strategy.id,
    seed: options.seed,
    graph: assembly.graph,
    structuralHash: structuralHash(assembly.graph),
    nodesAdded: delta.nodes.length,
    partsAdded: Object.keys(assembly.realize.document.parts).length - before,
    metrics: phaseMetrics(assembly.realize.document, options.references),
    elapsedMs: Date.now() - startedAt,
    notes: delta.notes,
  }
  assembly.phases.push(event)
  options.onPhase?.(event)
}

function finishCandidate(assembly: CandidateAssembly): Candidate {
  const { brief, options, strategy, boxes, candidateId, graph, realize } = assembly
  const scoreOptions: ScoreOptions = {
    ...(options.references?.length ? { references: options.references } : {}),
    ...(options.provideGeometry ? { provideGeometry: options.provideGeometry } : {}),
  }

  return {
    id: candidateId,
    strategy: strategy.id,
    seed: options.seed,
    graph,
    structuralHash: structuralHash(graph),
    realize,
    document: realize.document,
    metrics: scoreDocument(realize.document, options.scoreAgainst ?? brief, scoreOptions),
    phases: assembly.phases,
    notes: [...assembly.notes, ...realize.notes],
    inference: assembly.inference,
    boxes,
    continuation: continuationFor(brief, boxes, realize),
  }
}

function assembleCandidate(
  brief: DesignBrief,
  options: PipelineOptions,
  strategy: GenerationStrategy,
  massing: Massing,
  detail?: DetailProposal | null,
): Candidate {
  const assembly = createCandidateAssembly(brief, options, strategy, massing)
  for (const phase of PHASES) runCandidatePhase(assembly, phase, detail)
  return finishCandidate(assembly)
}

/**
 * What the ceiling stopped, expressed as the next thing to ask for.
 *
 * Every node the realiser skipped for want of budget belongs to a massing box,
 * and every box has a role the brief can name. Handing back "plinth, shaft,
 * crown are still unbuilt — call generate_region for them" turns a truncated
 * model from a silent failure into a two-wave build.
 */
function continuationFor(
  brief: DesignBrief,
  boxes: readonly MassingBox[],
  realize: RealizeResult,
): Continuation | null {
  if (!realize.truncated) return null
  // Skipped (the budget was already spent) and rejected-for-budget (this one
  // volume would not fit in what is left) are the same fact to a caller.
  const skipped = realize.nodes
    .filter((outcome) => outcome.status === 'skipped' || (outcome.status === 'rejected' && /budget/.test(outcome.reason ?? '')))
    .map((outcome) => outcome.nodeId)
  if (!skipped.length) return null

  const roles = new Set<string>()
  for (const box of boxes) {
    const owned = [shellNodeId(box), ...skipped.filter((id) => id.startsWith(`brace_${box.id}_`))]
    if (skipped.some((id) => owned.includes(id))) roles.add(box.role)
  }
  for (const id of skipped) {
    const level = /^deck_l(\d+)$/.exec(id)
    if (level) roles.add(`storey ${level[1]}`)
  }

  const remainingRoles = [...roles]
  return {
    reason: 'part-ceiling',
    placedParts: realize.partCount,
    remainingNodes: skipped.length,
    remainingRoles,
    suggestedTool: 'generate_region',
    suggestedPrompt: remainingRoles.length
      ? `The ${remainingRoles.join(', ')} of ${brief.subject}`
      : `The rest of ${brief.subject}`,
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
