import { catalog, STUD_LDU } from '../cad/catalog'
import { getDocumentBounds } from '../cad/geometry'
import { transformsEqual } from '../cad/math'
import { overhangPenaltyGrams, type StaticsReport } from '../cad/statics'
import type { Bounds, ModelDocument, Vec3 } from '../cad/types'
import { rowsOf, silhouetteOf, stackedSeamsOf, staticsOf, weakAttachmentsOf } from './cache'
import { canMirror, mirrorPlaneFor, mirrorTransform, type MirrorAxis } from './mirror'
import { boundsOfParts, silhouetteFrame } from './silhouette'
import {
  countSeams,
  findFreeStuds,
  findStepEdges,
  placedParts,
  type FreeStud,
  type Row,
  type StackedSeam,
  type StepEdge,
} from './topology'
import type { ObjectiveId, RefinementIssue, RefinementScope, SilhouetteV1 } from './types'

/**
 * What is actually wrong with this region.
 *
 * Every finding is a located, measured `RefinementIssue`. That is the whole
 * point: "the roof looks blocky" is not something a search can optimize, while
 * "part_0031's top is uncovered for two studs on its +x face" is. A strategy
 * reads issues, an objective reads the same underlying measurements, and the
 * proposal that comes back can be traced to the finding that motivated it.
 *
 * Nothing in here is a heuristic dressed as a fact. Mass, tipping margin and
 * overhang load come from `analyseStatics`; connection counts come from the
 * kernel's derived graph; part rarity is the number of official set inventories
 * the element appears in. Where a judgement had to be made — how rare is rare,
 * how many studs of exposed tread is a step — the threshold is a named constant
 * with its reasoning next to it.
 */

/**
 * Set-appearance count the rarity scale is normalized against.
 *
 * The most-used elements in the compiled catalogue — the 1 × 2 plate, the 1 × 1
 * plate — appear in a little under thirty thousand official set inventories.
 * Fixing the reference rather than taking the maximum of whatever is loaded
 * means a rarity score is comparable between two documents, and between a
 * fixture catalogue and the full one.
 */
export const RARITY_REFERENCE_FREQUENCY = 30_000

/** Rarity above this is worth telling a builder about: roughly fewer than 500 sets. */
const RARE_THRESHOLD = 0.4

/** A tread shallower than this is a chamfer, not a staircase. */
const STEP_TREAD_STUDS = 0.9

/** Runs of at least this many identical small parts are worth merging. */
const MICRO_RUN_MINIMUM = 3

/** A colour used by less than this share of the region is not part of its palette. */
const PALETTE_SHARE = 0.1

export interface VarietyEntry {
  readonly definitionId: string
  readonly name: string
  readonly count: number
  readonly frequency: number
}

export interface RarityEntry {
  readonly partId: string
  readonly definitionId: string
  readonly name: string
  readonly frequency: number
  /** 0 for a staple element, approaching 1 for something almost never produced. */
  readonly rarity: number
}

export interface PaletteEntry {
  readonly code: number
  readonly name: string
  readonly count: number
}

export interface SymmetryReport {
  readonly axis: MirrorAxis
  readonly planeLdu: number
  readonly matchedPartIds: readonly string[]
  readonly unmatchedPartIds: readonly string[]
  /** Parts whose compiled connectors are not symmetric about the reflection plane. */
  readonly unmirrorablePartIds: readonly string[]
  readonly exceptedPartIds: readonly string[]
  /** Unmatched share of the region, 0 when it is perfectly symmetric. */
  readonly error: number
}

export interface MicroRun {
  readonly rowKey: string
  readonly axis: Row['axis']
  readonly definitionId: string
  readonly partIds: readonly string[]
  readonly fromLdu: number
  readonly toLdu: number
  readonly lengthStuds: number
  readonly underY: number
  readonly across: readonly [number, number]
}

export interface RegionAnalysis {
  readonly scopePartIds: readonly string[]
  readonly issues: readonly RefinementIssue[]
  readonly rows: readonly Row[]
  readonly stackedSeams: readonly StackedSeam[]
  readonly seamCount: number
  readonly weakAttachments: ReadonlyArray<{ partId: string; connections: number }>
  readonly statics: StaticsReport
  readonly symmetry: SymmetryReport
  readonly rarity: { readonly mean: number; readonly worst: readonly RarityEntry[] }
  readonly variety: { readonly partCount: number; readonly distinctCount: number; readonly histogram: readonly VarietyEntry[] }
  readonly palette: { readonly reference: readonly number[]; readonly used: readonly PaletteEntry[]; readonly outlierPartIds: readonly string[]; readonly conformance: number }
  readonly silhouette: SilhouetteV1
  readonly frame: { min: Vec3; max: Vec3 }
  readonly bounds: Bounds
  readonly stepEdges: readonly StepEdge[]
  readonly freeStuds: readonly FreeStud[]
  readonly microRuns: readonly MicroRun[]
  /**
   * Whether a monetary objective was available.
   *
   * The compiled catalog carries set-appearance frequency, not price: there is
   * no field to read one from, and inventing an average would make a number
   * appear in a ranked comparison that nothing in this build measured. Rarity is
   * published instead, because it *is* measured, and this flag says so out loud
   * rather than leaving the absence to be discovered.
   */
  readonly costBasis: 'unavailable-no-price-data'
}

/** Builds the immutable scope every strategy and objective is handed. */
export function createScope(options: {
  partIds: Iterable<string>
  protectedPartIds?: Iterable<string>
  boundaryPartIds?: Iterable<string>
  symmetryExceptionPartIds?: Iterable<string>
  reference?: SilhouetteV1 | null
  instruction?: string
}): RefinementScope {
  const partIds = [...new Set(options.partIds)].sort()
  return {
    partIds,
    partIdSet: new Set(partIds),
    protectedPartIds: new Set(options.protectedPartIds ?? []),
    boundaryPartIds: new Set(options.boundaryPartIds ?? []),
    symmetryExceptionPartIds: new Set(options.symmetryExceptionPartIds ?? []),
    reference: options.reference ?? null,
    instruction: options.instruction ?? '',
  }
}

/** Part ids a refinement may actually rewrite: the scope minus what is held. */
export function mutablePartIds(document: ModelDocument, scope: RefinementScope): string[] {
  return scope.partIds.filter((id) => {
    const part = document.parts[id]
    if (!part) return false
    if (part.protected) return false
    if (document.subassemblies[part.subassemblyId]?.locked) return false
    if (scope.protectedPartIds.has(id)) return false
    if (scope.boundaryPartIds.has(id)) return false
    return true
  })
}

export const rarityOf = (frequency: number): number =>
  1 - Math.log10(Math.max(0, frequency) + 1) / Math.log10(RARITY_REFERENCE_FREQUENCY + 1)

export function analyseRegion(document: ModelDocument, scope: RefinementScope): RegionAnalysis {
  const scopeIds = scope.partIds.filter((id) => Boolean(document.parts[id]))
  const scopeSet = new Set(scopeIds)
  const issues: RefinementIssue[] = []
  const push = (
    kind: RefinementIssue['kind'],
    partIds: readonly string[],
    atLdu: Vec3,
    measure: number,
    unit: RefinementIssue['unit'],
    severity: RefinementIssue['severity'],
    detail: string,
    objectives: readonly ObjectiveId[],
  ) => {
    issues.push({
      id: `${kind}:${partIds.join('+')}:${issues.length}`,
      kind,
      partIds,
      atLdu,
      measure,
      unit,
      severity,
      detail,
      objectives,
    })
  }

  // -- Bonding -------------------------------------------------------------
  const rows = rowsOf(document).filter((row) => row.members.some((member) => scopeSet.has(member.partId)))
  const stacked = stackedSeamsOf(document).filter((seam) => seam.partIds.some((id) => scopeSet.has(id)))
  const seamCount = countSeams(rows)
  for (const seam of stacked) {
    push(
      'stacked-seam',
      seam.partIds,
      seam.atPoint,
      1,
      'count',
      'warning',
      `A joint at ${seam.axis} = ${seam.atLdu} LDU runs through two courses, so those courses are not tied together there.`,
      ['seamBonding'],
    )
  }

  // -- Attachment and load -------------------------------------------------
  const weak = weakAttachmentsOf(document).filter((entry) => scopeSet.has(entry.partId))
  for (const entry of weak) {
    const part = document.parts[entry.partId]
    push(
      'weak-attachment',
      [entry.partId],
      part.transform.position,
      entry.connections,
      'count',
      'warning',
      `${catalog.get(part.definitionId)?.name ?? part.definitionId} is held by a single connection.`,
      ['weakConnections'],
    )
  }

  const statics = staticsOf(document)
  for (const overhang of statics.overloaded) {
    if (!overhang.partIds.some((id) => scopeSet.has(id))) continue
    const anchor = document.parts[overhang.partIds[0]]
    push(
      'overhang-overload',
      overhang.partIds,
      anchor?.transform.position ?? [0, 0, 0],
      overhangPenaltyGrams(overhang),
      'grams',
      overhang.severity === 'over-capacity' ? 'error' : 'warning',
      overhang.message,
      ['overhangLoad', 'weakConnections'],
    )
  }
  for (const partId of statics.unsupportedPartIds) {
    if (!scopeSet.has(partId)) continue
    push(
      'unsupported-part',
      [partId],
      document.parts[partId].transform.position,
      1,
      'count',
      'error',
      'Nothing under this part reaches the ground: it hangs from its neighbours or floats.',
      ['supportMargin', 'overhangLoad'],
    )
  }
  if (statics.support && statics.support.marginLdu <= STUD_LDU) {
    push(
      'tipping-margin',
      scopeIds,
      [statics.mass.centreLdu[0], statics.support.groundY, statics.mass.centreLdu[2]],
      statics.support.marginLdu,
      'ldu',
      statics.support.stable ? 'warning' : 'error',
      `The centre of mass sits ${statics.support.marginLdu.toFixed(1)} LDU from the edge of the support polygon.`,
      ['supportMargin'],
    )
  }

  // -- Shape ---------------------------------------------------------------
  const stepEdges = findStepEdges(document, scopeIds).filter((step) => step.treadStuds >= STEP_TREAD_STUDS)
  for (const step of stepEdges) {
    push(
      'stepped-edge',
      [step.lowerPartId],
      step.atPoint,
      step.treadStuds,
      'count',
      'info',
      `${step.treadStuds.toFixed(1)} studs of tread are exposed on the ${step.side} face — a stepped edge a slope or curve would close.`,
      ['silhouetteFidelity', 'partCount'],
    )
  }

  const freeStuds = findFreeStuds(document, scopeIds)
  if (freeStuds.length >= 4) {
    push(
      'exposed-stud-field',
      [...new Set(freeStuds.map((stud) => stud.partId))],
      freeStuds[0].atLdu,
      freeStuds.length,
      'count',
      'info',
      `${freeStuds.length} studs on top of this region carry nothing, so surface detail can be added without touching the outline.`,
      ['silhouetteFidelity'],
    )
  }

  // -- Symmetry ------------------------------------------------------------
  const bounds = boundsOfParts(document, scopeIds)
  const symmetry = analyseSymmetry(document, scope, scopeIds, bounds)
  for (const partId of symmetry.unmatchedPartIds) {
    push(
      'symmetry-deviation',
      [partId],
      document.parts[partId].transform.position,
      1,
      'count',
      'info',
      `No counterpart across ${symmetry.axis === 0 ? 'x' : 'z'} = ${symmetry.planeLdu.toFixed(1)}.`,
      ['symmetryError'],
    )
  }

  // -- Elements ------------------------------------------------------------
  const histogram = new Map<string, number>()
  for (const id of scopeIds) {
    const definitionId = document.parts[id].definitionId
    histogram.set(definitionId, (histogram.get(definitionId) ?? 0) + 1)
  }
  const variety: VarietyEntry[] = [...histogram.entries()]
    .map(([definitionId, count]) => ({
      definitionId,
      name: catalog.get(definitionId)?.name ?? definitionId,
      count,
      frequency: catalog.get(definitionId)?.frequency ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.definitionId.localeCompare(b.definitionId))

  const rarityEntries: RarityEntry[] = scopeIds
    .map((partId) => {
      const definitionId = document.parts[partId].definitionId
      const definition = catalog.get(definitionId)
      const frequency = definition?.frequency ?? 0
      return {
        partId,
        definitionId,
        name: definition?.name ?? definitionId,
        frequency,
        rarity: rarityOf(frequency),
      }
    })
    .sort((a, b) => b.rarity - a.rarity || a.partId.localeCompare(b.partId))
  const rarityMean = rarityEntries.length
    ? rarityEntries.reduce((sum, entry) => sum + entry.rarity, 0) / rarityEntries.length
    : 0
  for (const entry of rarityEntries.filter((item) => item.rarity >= RARE_THRESHOLD)) {
    push(
      'rare-part',
      [entry.partId],
      document.parts[entry.partId].transform.position,
      entry.rarity,
      'fraction',
      'info',
      `${entry.name} appears in ${entry.frequency} official set inventories.`,
      ['rarityScore'],
    )
  }
  if (variety.length >= 6 && scopeIds.length > 0 && variety.length / scopeIds.length > 0.4) {
    push(
      'element-variety',
      scopeIds,
      bounds.min,
      variety.length,
      'count',
      'info',
      `${variety.length} distinct elements across ${scopeIds.length} parts: the region uses close to a new element per brick.`,
      ['distinctElements'],
    )
  }

  // -- Palette -------------------------------------------------------------
  const palette = analysePalette(document, scopeIds)
  for (const partId of palette.outlierPartIds) {
    push(
      'palette-outlier',
      [partId],
      document.parts[partId].transform.position,
      1,
      'count',
      'info',
      `Colour ${document.parts[partId].color} is outside the region's palette or has no observed appearance on this element.`,
      ['paletteConformance'],
    )
  }

  // -- Merge candidates ----------------------------------------------------
  const microRuns = findMicroRuns(rows, document, scopeSet)
  for (const run of microRuns) {
    push(
      'micro-run',
      run.partIds,
      [run.fromLdu, run.underY, run.across[0]],
      run.partIds.length,
      'count',
      'info',
      `${run.partIds.length} × ${catalog.get(run.definitionId)?.name ?? run.definitionId} in a row could be one longer element.`,
      ['partCount', 'seamBonding'],
    )
  }

  const frame = silhouetteFrame(getDocumentBounds(document))
  return {
    scopePartIds: scopeIds,
    issues,
    rows,
    stackedSeams: stacked,
    seamCount,
    weakAttachments: weak,
    statics,
    symmetry,
    rarity: { mean: rarityMean, worst: rarityEntries.slice(0, 12) },
    variety: { partCount: scopeIds.length, distinctCount: variety.length, histogram: variety },
    palette,
    silhouette: silhouetteOf(document, frame),
    frame,
    bounds,
    stepEdges,
    freeStuds,
    microRuns,
    costBasis: 'unavailable-no-price-data',
  }
}

/**
 * Which axis the region is closest to being symmetric about, and how far off.
 *
 * Both horizontal axes are tried and the better one is reported, because a
 * request to "make this symmetric" never says across what — and picking the axis
 * the model is already nearly symmetric about is the only reading of it that
 * does not amount to rebuilding the region.
 */
export function analyseSymmetry(
  document: ModelDocument,
  scope: RefinementScope,
  scopeIds: readonly string[],
  bounds: Bounds,
): SymmetryReport {
  const candidates: SymmetryReport[] = ([0, 2] as MirrorAxis[]).map((axis) => {
    const planeLdu = mirrorPlaneFor(bounds, axis)
    const matched: string[] = []
    const unmatched: string[] = []
    const unmirrorable: string[] = []
    const excepted: string[] = []

    for (const partId of scopeIds) {
      if (scope.symmetryExceptionPartIds.has(partId)) {
        excepted.push(partId)
        continue
      }
      const part = document.parts[partId]
      if (!canMirror(document, partId, axis)) {
        unmirrorable.push(partId)
        continue
      }
      const wanted = mirrorTransform(part.transform, axis, planeLdu)
      const partner = scopeIds.find((otherId) => {
        const other = document.parts[otherId]
        return (
          other.definitionId === part.definitionId &&
          other.color === part.color &&
          transformsEqual(other.transform, wanted, 0.4)
        )
      })
      if (partner) matched.push(partId)
      else unmatched.push(partId)
    }

    const considered = matched.length + unmatched.length + unmirrorable.length
    return {
      axis,
      planeLdu,
      matchedPartIds: matched,
      unmatchedPartIds: unmatched,
      unmirrorablePartIds: unmirrorable,
      exceptedPartIds: excepted,
      error: considered ? (unmatched.length + unmirrorable.length) / considered : 0,
    }
  })
  return candidates.sort((a, b) => a.error - b.error || a.axis - b.axis)[0]
}

/**
 * The region's palette, and who is outside it.
 *
 * A declared palette constraint wins, because the operator said so. Absent one,
 * the palette is inferred from what the region actually uses, which is what
 * makes "one stray blue brick in a grey hull" detectable at all — there is no
 * document field that would have recorded the intent.
 */
export function analysePalette(
  document: ModelDocument,
  scopeIds: readonly string[],
): RegionAnalysis['palette'] {
  const counts = new Map<number, number>()
  for (const id of scopeIds) {
    const color = document.parts[id].color
    counts.set(color, (counts.get(color) ?? 0) + 1)
  }
  const used: PaletteEntry[] = [...counts.entries()]
    .map(([code, count]) => ({ code, name: catalog.color(code).name, count }))
    .sort((a, b) => b.count - a.count || a.code - b.code)

  const declared = document.constraints.find((constraint) => constraint.kind === 'palette')
  const reference = declared && Array.isArray(declared.value)
    ? (declared.value as number[])
    : used.filter((entry) => entry.count >= Math.max(1, scopeIds.length * PALETTE_SHARE)).map((entry) => entry.code)

  const allowed = new Set(reference)
  const outlierPartIds: string[] = []
  for (const id of scopeIds) {
    const part = document.parts[id]
    const definition = catalog.get(part.definitionId)
    const unobserved = Boolean(definition?.availableColors.length) && !definition!.availableColors.includes(part.color)
    if (!allowed.has(part.color) || unobserved) outlierPartIds.push(id)
  }
  return {
    reference,
    used,
    outlierPartIds,
    conformance: scopeIds.length ? 1 - outlierPartIds.length / scopeIds.length : 1,
  }
}

/** Runs of identical short elements that one longer element would replace. */
export function findMicroRuns(
  rows: readonly Row[],
  document: ModelDocument,
  scopeSet: ReadonlySet<string>,
): MicroRun[] {
  const runs: MicroRun[] = []
  for (const row of rows) {
    if (!row.contiguous || row.members.length < MICRO_RUN_MINIMUM) continue
    let start = 0
    while (start < row.members.length) {
      const definitionId = document.parts[row.members[start].partId]?.definitionId
      let end = start
      while (
        end + 1 < row.members.length &&
        document.parts[row.members[end + 1].partId]?.definitionId === definitionId
      ) {
        end += 1
      }
      const members = row.members.slice(start, end + 1)
      const sameColor = new Set(members.map((member) => document.parts[member.partId].color)).size === 1
      if (
        definitionId &&
        members.length >= MICRO_RUN_MINIMUM &&
        sameColor &&
        members.every((member) => scopeSet.has(member.partId))
      ) {
        runs.push({
          rowKey: row.key,
          axis: row.axis,
          definitionId,
          partIds: members.map((member) => member.partId),
          fromLdu: members[0].from,
          toLdu: members[members.length - 1].to,
          lengthStuds: (members[members.length - 1].to - members[0].from) / STUD_LDU,
          underY: row.underY,
          across: row.across,
        })
      }
      start = end + 1
    }
  }
  return runs
}

/** Parts in `document` that fall inside a box, for turning a marquee into a scope. */
export function partsWithinBounds(document: ModelDocument, box: { min: Vec3; max: Vec3 }): string[] {
  return placedParts(document)
    .filter(({ bounds }) =>
      [0, 1, 2].every((axis) => bounds.min[axis] >= box.min[axis] - 0.01 && bounds.max[axis] <= box.max[axis] + 0.01),
    )
    .map(({ part }) => part.id)
}
