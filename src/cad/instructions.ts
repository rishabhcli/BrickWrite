import { getPartBounds } from './geometry'
import type { Bounds, BuildStep, ModelDocument } from './types'

/**
 * Build-order generation.
 *
 * Instruction steps are not a cosmetic grouping: a step is only meaningful if
 * everything it introduces can actually be attached to what is already in front
 * of the builder. That makes ordering a precedence problem over the connection
 * graph, not a spatial sort.
 *
 * The guarantee this produces is deliberately narrow and checkable: **every part
 * after the first step connects to structure placed in an earlier step, unless it
 * begins a new independent subassembly**, which is reported. Producing genuinely
 * good instructions — grouping by technique, hiding internals until they matter,
 * choosing where to sub-model — is a larger problem and is not claimed here.
 */

export interface BuildOrderOptions {
  /** Upper bound on parts introduced by one step. */
  maxPartsPerStep?: number
  /** Keep a subassembly's parts contiguous rather than interleaving them. */
  groupBySubassembly?: boolean
  /**
   * Check whether each part can physically be brought to its pose.
   *
   * **Off by default**, and the reason is measured. It costs 234 ms on the
   * largest shipped demo — fine for publishing instructions, and not fine on a
   * path the generation pipeline walks once per candidate, where it pushed two
   * strategy tests past a thirty-second budget. A caller that publishes a report
   * a human will act on asks for it; a caller that just wants the grouping does
   * not pay for it.
   */
  checkInsertability?: boolean
}

export interface BuildOrderWarning {
  code: 'NEW_ISLAND' | 'UNCONNECTED_PART' | 'BLOCKED_INSERTION'
  partIds: string[]
  message: string
}

export interface BuildOrderResult {
  steps: BuildStep[]
  warnings: BuildOrderWarning[]
  /** Parts introduced with no connection to earlier structure. */
  unsupportedPartIds: string[]
}

const DEFAULT_MAX_PARTS_PER_STEP = 8

/** Adjacency over every recorded connection, regardless of joint type. */
function adjacency(document: ModelDocument): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>(Object.keys(document.parts).map((id) => [id, new Set<string>()]))
  for (const edge of Object.values(document.connections)) {
    map.get(edge.a.partId)?.add(edge.b.partId)
    map.get(edge.b.partId)?.add(edge.a.partId)
  }
  return map
}

/**
 * Derives a build sequence from the connection graph.
 *
 * Growth is frontier-first: at each point the candidates are the unplaced parts
 * that already touch placed structure. Ties break downward — LDraw is Y-down, so
 * the largest y is the lowest part — because building bottom-up is what a person
 * actually does and what keeps a step reachable.
 */
export function computeBuildOrder(document: ModelDocument, options: BuildOrderOptions = {}): BuildOrderResult {
  const maxPerStep = Math.max(1, options.maxPartsPerStep ?? DEFAULT_MAX_PARTS_PER_STEP)
  const groupBySubassembly = options.groupBySubassembly ?? true
  const neighbours = adjacency(document)

  const bottomOf = new Map<string, number>()
  for (const part of Object.values(document.parts)) {
    bottomOf.set(part.id, getPartBounds(part).max[1])
  }

  const remaining = new Set(Object.keys(document.parts))
  const placed = new Set<string>()
  const warnings: BuildOrderWarning[] = []
  const unsupported: string[] = []
  const ordered: Array<{ partId: string; subassemblyId: string; startsIsland: boolean }> = []

  /** Lowest, then most-connected, then id — fully deterministic. */
  const compare = (a: string, b: string): number => {
    const heightDelta = (bottomOf.get(b) ?? 0) - (bottomOf.get(a) ?? 0)
    if (Math.abs(heightDelta) > 1e-6) return heightDelta
    const degreeDelta = (neighbours.get(b)?.size ?? 0) - (neighbours.get(a)?.size ?? 0)
    if (degreeDelta !== 0) return degreeDelta
    return a.localeCompare(b)
  }

  /*
   * Four lazy priority indexes replace the old repeated `remaining.filter`
   * and `candidates.sort` loop. That loop was pleasantly small, but O(n^2): a
   * ten-thousand-piece model inspected roughly fifty million remaining entries
   * before it had even grouped a build step. The queues below preserve the
   * exact ordering contract while making frontier growth O((n + e) log n).
   *
   * "Lazy" means removal only changes the authoritative Set. A stale heap head
   * is discarded when read, avoiding an indexed-heap bookkeeping layer and
   * keeping the implementation deterministic and easy to audit.
   */
  const remainingAll = new MinHeap(compare, remaining)
  const remainingBySubassembly = heapsBySubassembly(Object.keys(document.parts), document, compare)
  const frontier = new Set<string>()
  const frontierAll = new MinHeap(compare)
  const frontierBySubassembly = new Map<string, MinHeap>()

  const addToFrontier = (id: string) => {
    if (!remaining.has(id) || frontier.has(id)) return
    frontier.add(id)
    frontierAll.push(id)
    const subassemblyId = document.parts[id].subassemblyId
    let queue = frontierBySubassembly.get(subassemblyId)
    if (!queue) {
      queue = new MinHeap(compare)
      frontierBySubassembly.set(subassemblyId, queue)
    }
    queue.push(id)
  }

  const take = (
    all: MinHeap,
    bySubassembly: Map<string, MinHeap>,
    active: ReadonlySet<string>,
    preferredSubassembly?: string,
  ): string | undefined => {
    const valid = (id: string) => remaining.has(id) && active.has(id)
    if (groupBySubassembly && preferredSubassembly) {
      const preferred = bySubassembly.get(preferredSubassembly)?.popValid(valid)
      if (preferred !== undefined) return preferred
    }
    return all.popValid(valid)
  }

  let currentSubassembly: string | undefined

  while (remaining.size) {
    let next = take(frontierAll, frontierBySubassembly, frontier, currentSubassembly)
    let startsIsland = false
    if (next === undefined) {
      // Nothing touches what is already built, so this part begins a new
      // independent island. That is legitimate — a separately-built subassembly
      // does exactly this — but it is reported rather than passed off as
      // continuous construction.
      next = take(remainingAll, remainingBySubassembly, remaining, currentSubassembly)
      if (next === undefined) break
      startsIsland = placed.size > 0
      if (startsIsland) unsupported.push(next)
    }

    remaining.delete(next)
    frontier.delete(next)
    placed.add(next)
    currentSubassembly = document.parts[next].subassemblyId
    ordered.push({ partId: next, subassemblyId: currentSubassembly, startsIsland })
    for (const neighbour of neighbours.get(next) ?? []) addToFrontier(neighbour)
  }

  if (unsupported.length) {
    warnings.push({
      code: 'NEW_ISLAND',
      partIds: unsupported,
      message:
        `${unsupported.length} part${unsupported.length === 1 ? '' : 's'} begin a new independent island: ` +
        'they attach to nothing placed earlier, so each starts a separately-built subassembly.',
    })
  }

  const isolated = Object.keys(document.parts).filter((id) => (neighbours.get(id)?.size ?? 0) === 0)
  if (isolated.length) {
    warnings.push({
      code: 'UNCONNECTED_PART',
      partIds: isolated,
      message: `${isolated.length} part${isolated.length === 1 ? '' : 's'} have no connection at all and cannot be attached in any step.`,
    })
  }

  const steps = groupIntoSteps(ordered, maxPerStep, groupBySubassembly, document)

  if (options.checkInsertability === true) {
    for (const blocked of findBlockedInsertions(document, steps)) {
      warnings.push({
        code: 'BLOCKED_INSERTION',
        partIds: [blocked.partId, ...blocked.blockedBy],
        // Deliberately terse. This string is recorded into the shipped demo
        // manifest, and a five-sentence explanation per warning put ten
        // kilobytes of prose into an asset the gallery downloads. The reasoning
        // belongs in `findBlockedInsertions`; the report needs the facts.
        message:
          `Step ${blocked.stepIndex} adds ${blocked.partId} into a pose already enclosed by `
          + `${blocked.blockedBy.slice(0, 2).join(', ')}${blocked.blockedBy.length > 2 ? ` +${blocked.blockedBy.length - 2}` : ''}. `
          + 'Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.',
      })
    }
  }

  return {
    steps,
    warnings,
    unsupportedPartIds: unsupported,
  }
}

/** Small binary heap whose comparator follows `Array.sort` ordering. */
class MinHeap {
  private readonly values: string[] = []

  constructor(
    private readonly compare: (a: string, b: string) => number,
    initial: Iterable<string> = [],
  ) {
    for (const value of initial) this.push(value)
  }

  push(value: string) {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.values[parent], this.values[index]) <= 0) break
      ;[this.values[parent], this.values[index]] = [this.values[index], this.values[parent]]
      index = parent
    }
  }

  popValid(valid: (value: string) => boolean): string | undefined {
    let value = this.pop()
    while (value !== undefined && !valid(value)) value = this.pop()
    return value
  }

  private pop(): string | undefined {
    if (!this.values.length) return undefined
    const first = this.values[0]
    const last = this.values.pop()!
    if (this.values.length) {
      this.values[0] = last
      let index = 0
      while (true) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.values.length && this.compare(this.values[left], this.values[smallest]) < 0) smallest = left
        if (right < this.values.length && this.compare(this.values[right], this.values[smallest]) < 0) smallest = right
        if (smallest === index) break
        ;[this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]]
        index = smallest
      }
    }
    return first
  }
}

function heapsBySubassembly(
  ids: readonly string[],
  document: ModelDocument,
  compare: (a: string, b: string) => number,
): Map<string, MinHeap> {
  const heaps = new Map<string, MinHeap>()
  for (const id of ids) {
    const subassemblyId = document.parts[id].subassemblyId
    let heap = heaps.get(subassemblyId)
    if (!heap) {
      heap = new MinHeap(compare)
      heaps.set(subassemblyId, heap)
    }
    heap.push(id)
  }
  return heaps
}

function groupIntoSteps(
  ordered: ReadonlyArray<{ partId: string; subassemblyId: string; startsIsland: boolean }>,
  maxPerStep: number,
  groupBySubassembly: boolean,
  document: ModelDocument,
): BuildStep[] {
  const steps: BuildStep[] = []
  let bucket: string[] = []
  let bucketSubassembly: string | undefined

  const flush = () => {
    if (!bucket.length) return
    const index = steps.length + 1
    const name = bucketSubassembly ? (document.subassemblies[bucketSubassembly]?.name ?? bucketSubassembly) : 'Assembly'
    steps.push({ id: `step_${index}`, index, name: `${name} ${index}`, partIds: bucket })
    bucket = []
  }

  for (const entry of ordered) {
    const subassemblyChanged =
      groupBySubassembly && bucketSubassembly !== undefined && entry.subassemblyId !== bucketSubassembly
    // A new island always starts a step: it is where the builder puts the
    // previous assembly down and picks up fresh parts.
    if (bucket.length >= maxPerStep || subassemblyChanged || entry.startsIsland) flush()
    if (!bucket.length) bucketSubassembly = entry.subassemblyId
    bucket.push(entry.partId)
  }
  flush()

  return steps
}

/**
 * Checks a step sequence against the guarantee the generator claims.
 *
 * Exposed so the property can be asserted on any document, including one whose
 * steps a human reordered by hand.
 */
export function verifyBuildOrder(
  document: ModelDocument,
  steps: readonly BuildStep[],
): { valid: boolean; violations: Array<{ stepIndex: number; partId: string }> } {
  const neighbours = adjacency(document)
  const placed = new Set<string>()
  const violations: Array<{ stepIndex: number; partId: string }> = []

  for (const step of [...steps].sort((a, b) => a.index - b.index)) {
    for (const partId of step.partIds) {
      const attaches = [...(neighbours.get(partId) ?? [])].some((neighbour) => placed.has(neighbour))
      const withinStep = step.partIds.some((sibling) => sibling !== partId && neighbours.get(partId)?.has(sibling))
      if (placed.size > 0 && !attaches && !withinStep) violations.push({ stepIndex: step.index, partId })
    }
    for (const partId of step.partIds) placed.add(partId)
  }

  return { valid: violations.length === 0, violations }
}

/** Operations that replace a document's steps with a generated sequence. */
export function applyBuildOrder(result: BuildOrderResult): { steps: BuildStep[]; assignments: Map<string, string> } {
  const assignments = new Map<string, string>()
  for (const step of result.steps) {
    for (const partId of step.partIds) assignments.set(partId, step.id)
  }
  return { steps: result.steps, assignments }
}

// ---------------------------------------------------------------------------
// Insertability
// ---------------------------------------------------------------------------

/** One stud of approach clearance; the smallest step worth testing. */
const APPROACH_STEP_LDU = 20

/**
 * How far a part must be able to travel before its approach counts as open.
 *
 * Four studs, not "until it leaves the model". A part that can retract four
 * studs along some axis without touching anything is in open space *relative to
 * its neighbours*, and extending the sweep to the model's full extent turns this
 * into a corridor search — which is the real motion-planning problem, and which
 * would report every part of a dense build as blocked.
 */
const APPROACH_TRAVEL_LDU = APPROACH_STEP_LDU * 4

/**
 * How far a part stays entangled with its own supports.
 *
 * A part legitimately shares volume with what it mates onto — a stud sits inside
 * an anti-stud, a pin inside a hole, and a deep pin keeps sharing volume for most
 * of a stud of travel. So a mate is transparent for the first stretch of the
 * retraction and opaque after it: excluding mates for the *whole* sweep says a
 * part can always be inserted straight down through its own floor, which is how
 * the first version of this check declared a fully walled-in part insertable.
 *
 * 26 LDU is the deep-insertion allowance `collision.ts` uses for pins, bars and
 * sockets, for the same reason.
 */
const MATE_ENTANGLEMENT_LDU = 26

export interface InsertionWarning {
  /** Step in which the part is introduced. */
  readonly stepIndex: number
  readonly partId: string
  /** Parts blocking the approach, one per direction that was tried. */
  readonly blockedBy: readonly string[]
}

/**
 * A uniform grid over part boxes, so a swept box asks about its own
 * neighbourhood rather than the whole model.
 *
 * Without it this check is O(n²): every retraction step scanned every part
 * placed so far, which measured **14.5 s** on the 11,493-part campus. Cells are
 * one approach-travel wide, so a swept box touches at most a handful of them.
 */
class BoxGrid {
  private readonly cells = new Map<string, string[]>()

  constructor(
    boxes: ReadonlyMap<string, Bounds>,
    private readonly cellLdu: number,
  ) {
    for (const [id, box] of boxes) {
      for (const key of this.keysFor(box)) {
        const bucket = this.cells.get(key)
        if (bucket) bucket.push(id)
        else this.cells.set(key, [id])
      }
    }
  }

  private *keysFor(box: Bounds): Generator<string> {
    const lo = box.min.map((value) => Math.floor(value / this.cellLdu))
    const hi = box.max.map((value) => Math.floor(value / this.cellLdu))
    for (let x = lo[0]; x <= hi[0]; x += 1) {
      for (let y = lo[1]; y <= hi[1]; y += 1) {
        for (let z = lo[2]; z <= hi[2]; z += 1) yield `${x}|${y}|${z}`
      }
    }
  }

  /** Ids whose box shares a cell with `box`. A superset of the real overlaps. */
  candidates(box: Bounds): string[] {
    const found = new Set<string>()
    for (const key of this.keysFor(box)) {
      for (const id of this.cells.get(key) ?? []) found.add(id)
    }
    return [...found]
  }
}

/** A box grown equally on every side, covering every approach a sweep will try. */
const expand = (box: Bounds, by: number): Bounds => ({
  min: [box.min[0] - by, box.min[1] - by, box.min[2] - by],
  max: [box.max[0] + by, box.max[1] + by, box.max[2] + by],
  size: box.size,
})

const shift = (box: Bounds, axis: 0 | 1 | 2, distance: number): Bounds => {
  const min: [number, number, number] = [box.min[0], box.min[1], box.min[2]]
  const max: [number, number, number] = [box.max[0], box.max[1], box.max[2]]
  min[axis] += distance
  max[axis] += distance
  return { min, max, size: box.size }
}

/** Do two boxes share volume, allowing a hair of contact? */
const boxesOverlap = (a: Bounds, b: Bounds): boolean => {
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) <= 0.01) return false
  }
  return true
}

/**
 * Parts a build sequence asks for in an order that cannot physically be built.
 *
 * `verifyBuildOrder` answers a graph question — does each part attach to
 * something placed earlier — and a sequence can satisfy it while being
 * impossible: an interior mechanism sequenced after the shell that encloses it,
 * or a part that has to pass through a wall an earlier step already closed. That
 * gap is the difference between "verified" and "buildable", which is the
 * distinction this project exists to hold.
 *
 * The test is deliberately coarse and is a **warning, never a refusal**. For
 * each part, at the moment its step introduces it, the part's bounding box is
 * retracted a stud at a time along each of the six axes against the boxes of
 * everything already placed. If some direction clears
 * `APPROACH_TRAVEL_LDU` the part can be brought in that way; if every direction
 * is blocked within a stud or two, a builder holding that piece has nowhere to
 * put it.
 *
 * What it does *not* do, stated plainly because a warning nobody trusts is
 * worse than none:
 *
 *   - Bounding boxes, not geometry. A part that can be threaded diagonally
 *     through a gap its box cannot pass will be reported. False positives are
 *     the expected error, which is why this never blocks.
 *   - Axis-aligned approaches only. A real hand rotates.
 *   - The parts a part *mates with* are excluded, since it legitimately shares
 *     volume with its own supports at the final pose.
 *   - It says nothing about the four studs beyond the sweep. The enclosure case
 *     it exists for is local by nature — a shell around a mechanism blocks the
 *     first stud of travel, not the fortieth.
 */
export function findBlockedInsertions(
  document: ModelDocument,
  steps: readonly BuildStep[],
  options: { travelLdu?: number } = {},
): InsertionWarning[] {
  const travel = Math.max(APPROACH_STEP_LDU, options.travelLdu ?? APPROACH_TRAVEL_LDU)
  const neighbours = adjacency(document)
  const boxes = new Map<string, Bounds>()
  for (const part of Object.values(document.parts)) {
    const bounds = getPartBounds(part)
    if (bounds.measured) boxes.set(part.id, bounds)
  }

  const grid = new BoxGrid(boxes, travel)
  const warnings: InsertionWarning[] = []
  const placed = new Set<string>()
  const ordered = [...steps].sort((a, b) => a.index - b.index)

  for (const step of ordered) {
    // Everything the step introduces arrives together, so a part is only
    // obstructed by *earlier* steps — two parts of one step are placed by the
    // same pair of hands and their mutual order is not this function's business.
    const arriving = step.partIds.filter((id) => boxes.has(id))
    for (const partId of arriving) {
      const box = boxes.get(partId)!
      const mates = neighbours.get(partId) ?? new Set<string>()
      if (!placed.size) continue

      // One spatial query per part, not one per retraction step. Every swept box
      // lies inside the part's own box grown by the travel distance, so the
      // candidate list is the same for all twenty-four probes — and querying per
      // probe meant 275,832 lookups on the campus demo, each allocating a set and
      // a handful of cell keys. The churn was enough to slow the whole worker and
      // time out unrelated tests in the same file.
      const nearby: Array<{ id: string; box: Bounds }> = []
      for (const other of grid.candidates(expand(box, travel))) {
        if (other === partId || !placed.has(other)) continue
        const otherBox = boxes.get(other)
        if (otherBox) nearby.push({ id: other, box: otherBox })
      }
      if (!nearby.length) continue

      const blockers: string[] = []
      let open = false
      for (const axis of [0, 1, 2] as const) {
        for (const sign of [1, -1] as const) {
          let blocker: string | undefined
          for (let distance = APPROACH_STEP_LDU; distance <= travel && !blocker; distance += APPROACH_STEP_LDU) {
            const swept = shift(box, axis, distance * sign)
            const entangled = distance < MATE_ENTANGLEMENT_LDU
            for (const other of nearby) {
              if (entangled && mates.has(other.id)) continue
              if (boxesOverlap(swept, other.box)) {
                blocker = other.id
                break
              }
            }
          }
          if (!blocker) {
            open = true
            break
          }
          blockers.push(blocker)
        }
        if (open) break
      }
      if (!open) {
        warnings.push({ stepIndex: step.index, partId, blockedBy: [...new Set(blockers)] })
      }
    }
    for (const id of step.partIds) placed.add(id)
  }
  return warnings
}
