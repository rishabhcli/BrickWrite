import { familyLibrary, planCourse, seamsOf, type BrickFamily, type FamilyLibrary } from '../../cad/assembly'
import { catalog, STUD_LDU } from '../../cad/catalog'
import type { CadOperation, ModelDocument } from '../../cad/types'
import { mutablePartIds } from '../analyse'
import { rowsOf, stackedSeamsOf } from '../cache'
import { extractSeams, type Row } from '../topology'
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
 * Re-lay a course so its joints stop lining up with the one below.
 *
 * A stacked seam is not cosmetic. Two courses whose joints coincide are not tied
 * to each other along that line, and the wall separates there when the model is
 * picked up — which is the single most common structural defect in anything a
 * language model authored brick by brick, because nothing was tracking the bond.
 *
 * The fix is the assembly planner's own: `planCourse` searches lead offsets for
 * a partition that shares no joint with the course below, and reports honestly
 * when the available part lengths do not permit one. Calling it here rather than
 * reimplementing a stagger means a course this repairs is bonded by exactly the
 * definition the generator was trying to satisfy in the first place.
 *
 * Alternatives come from *withholding* lengths: forbidding the longest element
 * forces a different partition, which matters when the obvious re-lay merely
 * moves the shared joint one brick along.
 */

/** Height in studs the family libraries are keyed by; read from compiled bounds. */
function familyOf(definitionId: string): BrickFamily | null {
  const studs = catalog.get(definitionId)?.dimensions?.studs
  if (!studs) return null
  const height = studs[1]
  if (Math.abs(height - 3.5) < 0.01) return 'brick'
  if (Math.abs(height - 1.5) < 0.01) return 'plate'
  if (Math.abs(height - 1) < 0.01) return 'tile'
  return null
}

/** Joints of every course sitting directly under `row`, as stud offsets along it. */
function seamsBelow(rows: readonly Row[], row: Row): Set<number> {
  const below = rows.filter(
    (other) =>
      other.axis === row.axis &&
      other.underY - row.underY > 0.1 &&
      other.underY - row.underY <= 26 &&
      Math.min(other.across[1], row.across[1]) - Math.max(other.across[0], row.across[0]) > 0.1,
  )
  const offsets = new Set<number>()
  for (const seam of extractSeams(below)) offsets.add(Math.round((seam.atLdu - row.fromLdu) / STUD_LDU))
  return offsets
}

function relayOperations(
  document: ModelDocument,
  row: Row,
  library: FamilyLibrary,
  lengths: readonly number[],
  forbidden: ReadonlySet<number>,
  tag: string,
): CadOperation[] | null {
  const runStuds = Math.round((row.toLdu - row.fromLdu) / STUD_LDU)
  if (runStuds < 2) return null
  const plan = planCourse(runStuds, lengths, forbidden, 0)
  if (!plan.exact) return null
  if (plan.sharedSeams > 0) return null

  const current = row.members.map((member) => Math.round((member.to - member.from) / STUD_LDU))
  if (current.length === plan.parts.length && current.every((value, index) => value === plan.parts[index])) return null

  const source = sourceOf(document, row.members[0].partId)
  if (!source) return null
  const color = modalColor(document, row.members.map((member) => member.partId))
  const acrossCentre = (row.across[0] + row.across[1]) / 2
  const basis = basisForAxis(row.axis)

  const operations: CadOperation[] = row.members.map((member) => ({ type: 'part.remove', partId: member.partId }))
  let at = 0
  for (const length of plan.parts) {
    const definition = library.definitionFor(length)
    if (!definition) return null
    const along = row.fromLdu + (at + length / 2) * STUD_LDU
    const transform = restingTransform(
      definition,
      row.axis === 'x' ? along : acrossCentre,
      row.underY,
      row.axis === 'x' ? acrossCentre : along,
      basis,
    )
    operations.push({
      type: 'part.add',
      part: makePart(`restack|${tag}|${row.key}|${at}|${length}`, definition.canonicalId, transform, { ...source, color }),
    })
    at += length
  }
  return operations
}

export const restack = (document: ModelDocument, scope: RefinementScope, rng: Rng): CadOperation[][] => {
  const mutable = new Set(mutablePartIds(document, scope))
  const rows = rowsOf(document)
  const stacked = stackedSeamsOf(document).filter((seam) => seam.partIds.some((id) => mutable.has(id)))
  if (!stacked.length) return []

  const byKey = new Map(rows.map((row) => [row.key, row]))
  const affected = [...new Set(stacked.map((seam) => seam.upperRowKey))].sort()
  const batches: CadOperation[][] = []

  for (const key of sample(affected, 6, rng)) {
    const row = byKey.get(key)
    if (!row || !row.contiguous || row.members.length < 2) continue
    if (!row.members.every((member) => mutable.has(member.partId))) continue

    const definitionId = document.parts[row.members[0].partId]?.definitionId
    const family = definitionId ? familyOf(definitionId) : null
    if (!family) continue
    const depthStuds = Math.round((row.across[1] - row.across[0]) / STUD_LDU)
    if (depthStuds < 1) continue
    const library = familyLibrary(family, depthStuds)
    if (!library) continue

    const forbidden = seamsBelow(rows, row)
    // Withholding the longest lengths forces genuinely different partitions; the
    // full set is tried first because it produces the fewest parts.
    const variants: Array<{ tag: string; lengths: readonly number[] }> = [
      { tag: 'full', lengths: library.lengths },
      { tag: 'no-longest', lengths: library.lengths.slice(1) },
      { tag: 'no-two-longest', lengths: library.lengths.slice(2) },
    ]
    for (const variant of variants) {
      if (variant.lengths.length < 2) continue
      const operations = relayOperations(document, row, library, variant.lengths, forbidden, variant.tag)
      if (operations) batches.push(operations)
    }
  }

  // One batch that repairs every affected course at once, so a wall with four
  // stacked joints can be fixed in a single reviewable transaction.
  const combined: CadOperation[] = []
  const touched = new Set<string>()
  for (const key of affected) {
    const row = byKey.get(key)
    if (!row || !row.contiguous || row.members.length < 2) continue
    if (!row.members.every((member) => mutable.has(member.partId) && !touched.has(member.partId))) continue
    const definitionId = document.parts[row.members[0].partId]?.definitionId
    const family = definitionId ? familyOf(definitionId) : null
    if (!family) continue
    const depthStuds = Math.round((row.across[1] - row.across[0]) / STUD_LDU)
    const library = depthStuds >= 1 ? familyLibrary(family, depthStuds) : null
    if (!library) continue
    const operations = relayOperations(document, row, library, library.lengths, seamsBelow(rows, row), 'all')
    if (!operations) continue
    for (const member of row.members) touched.add(member.partId)
    combined.push(...operations)
  }
  if (combined.length) batches.push(combined)

  return dedupeBatches(batches)
}

/** Exposed so a test can assert the planner's accounting is what is being used. */
export const courseSeams = seamsOf
