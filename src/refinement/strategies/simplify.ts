import { familyLibrary, planCourse, type BrickFamily } from '../../cad/assembly'
import { catalog, STUD_LDU } from '../../cad/catalog'
import type { CadOperation, ModelDocument } from '../../cad/types'
import { findMicroRuns, mutablePartIds, type MicroRun } from '../analyse'
import { rowsOf } from '../cache'
import { extractSeams } from '../topology'
import type { RefinementScope } from '../types'
import {
  basisForAxis,
  dedupeBatches,
  makePart,
  modalColor,
  restingTransform,
  sample,
  sourceOf,
  type Rng,
} from './support'

/**
 * Merge a run of small elements into fewer larger ones.
 *
 * Four 1 × 1 bricks in a line are four parts, three joints and no bond; one 1 × 4
 * is one part, no joint and a course that is actually tied together. Models
 * authored a brick at a time are full of these, because placing the same small
 * element repeatedly is the path of least resistance for a generator.
 *
 * The merge is not "pick the longest part that fits" — it is `planCourse` again,
 * against the joints of the course below, so consolidating a run also stops it
 * from re-creating the stacked seam the shorter parts happened to avoid.
 */

function familyOf(definitionId: string): BrickFamily | null {
  const studs = catalog.get(definitionId)?.dimensions?.studs
  if (!studs) return null
  if (Math.abs(studs[1] - 3.5) < 0.01) return 'brick'
  if (Math.abs(studs[1] - 1.5) < 0.01) return 'plate'
  if (Math.abs(studs[1] - 1) < 0.01) return 'tile'
  return null
}

function mergeRun(document: ModelDocument, run: MicroRun, forbidden: ReadonlySet<number>): CadOperation[] | null {
  const family = familyOf(run.definitionId)
  if (!family) return null
  const depthStuds = Math.round((run.across[1] - run.across[0]) / STUD_LDU)
  if (depthStuds < 1) return null
  const library = familyLibrary(family, depthStuds)
  if (!library) return null

  const runStuds = Math.round(run.lengthStuds)
  const plan = planCourse(runStuds, library.lengths, forbidden, 0)
  if (!plan.exact || plan.parts.length >= run.partIds.length) return null

  const source = sourceOf(document, run.partIds[0])
  if (!source) return null
  const color = modalColor(document, run.partIds)
  const acrossCentre = (run.across[0] + run.across[1]) / 2
  const basis = basisForAxis(run.axis)

  const operations: CadOperation[] = run.partIds.map((partId) => ({ type: 'part.remove', partId }))
  let at = 0
  for (const length of plan.parts) {
    const definition = library.definitionFor(length)
    if (!definition) return null
    const along = run.fromLdu + (at + length / 2) * STUD_LDU
    operations.push({
      type: 'part.add',
      part: makePart(
        `simplify|${run.rowKey}|${at}|${length}`,
        definition.canonicalId,
        restingTransform(
          definition,
          run.axis === 'x' ? along : acrossCentre,
          run.underY,
          run.axis === 'x' ? acrossCentre : along,
          basis,
        ),
        { ...source, color },
      ),
    })
    at += length
  }
  return operations
}

export const simplify = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const rows = rowsOf(document)
  const runs = findMicroRuns(rows, document, mutable)
  if (!runs.length) return []

  const batches: CadOperation[][] = []
  const combined: CadOperation[] = []
  const consumed = new Set<string>()

  for (const run of sample(runs, 8, rng)) {
    const below = rows.filter(
      (other) =>
        other.axis === run.axis &&
        other.underY - run.underY > 0.1 &&
        other.underY - run.underY <= 26 &&
        Math.min(other.across[1], run.across[1]) - Math.max(other.across[0], run.across[0]) > 0.1,
    )
    const forbidden = new Set(extractSeams(below).map((seam) => Math.round((seam.atLdu - run.fromLdu) / STUD_LDU)))
    const operations = mergeRun(document, run, forbidden)
    if (!operations) continue
    batches.push(operations)
    if (run.partIds.every((id) => !consumed.has(id))) {
      for (const id of run.partIds) consumed.add(id)
      combined.push(...operations)
    }
  }

  if (combined.length && batches.length > 1) batches.push(combined)
  return dedupeBatches(batches)
}
