import { getPartBounds } from './geometry'
import type { BuildStep, ModelDocument } from './types'

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
}

export interface BuildOrderWarning {
  code: 'NEW_ISLAND' | 'UNCONNECTED_PART'
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
  const pick = (candidates: string[], preferredSubassembly?: string): string => {
    return candidates.sort((a, b) => {
      if (groupBySubassembly && preferredSubassembly) {
        const aPreferred = document.parts[a].subassemblyId === preferredSubassembly ? 0 : 1
        const bPreferred = document.parts[b].subassemblyId === preferredSubassembly ? 0 : 1
        if (aPreferred !== bPreferred) return aPreferred - bPreferred
      }
      const heightDelta = (bottomOf.get(b) ?? 0) - (bottomOf.get(a) ?? 0)
      if (Math.abs(heightDelta) > 1e-6) return heightDelta
      const degreeDelta = (neighbours.get(b)?.size ?? 0) - (neighbours.get(a)?.size ?? 0)
      if (degreeDelta !== 0) return degreeDelta
      return a.localeCompare(b)
    })[0]
  }

  let currentSubassembly: string | undefined

  while (remaining.size) {
    const attachable = [...remaining].filter((id) =>
      [...(neighbours.get(id) ?? [])].some((neighbour) => placed.has(neighbour)),
    )

    let next: string
    let startsIsland = false
    if (attachable.length) {
      next = pick(attachable, currentSubassembly)
    } else {
      // Nothing touches what is already built, so this part begins a new
      // independent island. That is legitimate — a separately-built subassembly
      // does exactly this — but it is reported rather than passed off as
      // continuous construction.
      next = pick([...remaining], currentSubassembly)
      startsIsland = placed.size > 0
      if (startsIsland) unsupported.push(next)
    }

    remaining.delete(next)
    placed.add(next)
    currentSubassembly = document.parts[next].subassemblyId
    ordered.push({ partId: next, subassemblyId: currentSubassembly, startsIsland })
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

  return { steps: groupIntoSteps(ordered, maxPerStep, groupBySubassembly, document), warnings, unsupportedPartIds: unsupported }
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
    const name = bucketSubassembly ? document.subassemblies[bucketSubassembly]?.name ?? bucketSubassembly : 'Assembly'
    steps.push({ id: `step_${index}`, index, name: `${name} ${index}`, partIds: bucket })
    bucket = []
  }

  for (const entry of ordered) {
    const subassemblyChanged = groupBySubassembly && bucketSubassembly !== undefined && entry.subassemblyId !== bucketSubassembly
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
      const withinStep = step.partIds.some(
        (sibling) => sibling !== partId && neighbours.get(partId)?.has(sibling),
      )
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
