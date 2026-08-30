import { z } from 'zod'
import type { CadOperation, Transaction } from '../../src/cad/types'
import type { EntityMutation } from '../../src/cad/patch'
import {
  id,
  revision,
  timestamp,
  actor,
  part,
  transform,
  subassembly,
  connection,
  step,
  note,
  constraint,
  moduleDefinition,
  unique,
} from './cadSchema'
import { cloudFailure, type CloudResult } from './protocol'
import { storageJsonProblem } from './storageJson'

const operation: z.ZodType<CadOperation> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('document.rename'), name: z.string() }),
  z.object({ type: z.literal('part.add'), part }),
  z.object({ type: z.literal('part.remove'), partId: id }),
  z.object({ type: z.literal('part.transform'), partId: id, transform }),
  z.object({ type: z.literal('part.recolor'), partId: id, color: z.number().int() }),
  z.object({ type: z.literal('part.protect'), partId: id, protected: z.boolean() }),
  z.object({ type: z.literal('part.assign-subassembly'), partId: id, subassemblyId: id }),
  z.object({ type: z.literal('subassembly.add'), subassembly }),
  z.object({ type: z.literal('subassembly.rename'), subassemblyId: id, name: z.string() }),
  z.object({ type: z.literal('subassembly.lock'), subassemblyId: id, locked: z.boolean() }),
  z.object({ type: z.literal('note.add'), note }),
  z.object({ type: z.literal('note.respond'), noteId: id, response: z.string(), resolved: z.boolean().optional() }),
  z.object({ type: z.literal('constraint.set'), constraint }),
  z.object({ type: z.literal('constraint.remove'), constraintId: id }),
  z.object({ type: z.literal('module.define'), module: moduleDefinition }),
  z.object({ type: z.literal('module.remove'), moduleId: id }),
  z.object({ type: z.literal('steps.replace'), steps: unique(step) }),
])

const mutation: z.ZodType<EntityMutation> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document-name'), value: z.string() }),
  z.object({ kind: z.literal('part'), id, value: part.nullable() }),
  z.object({ kind: z.literal('subassembly'), id, value: subassembly.nullable() }),
  z.object({ kind: z.literal('connection'), id, value: connection.nullable() }),
  z.object({ kind: z.literal('steps'), value: unique(step) }),
  z.object({ kind: z.literal('notes'), value: unique(note) }),
  z.object({ kind: z.literal('constraints'), value: unique(constraint) }),
  z.object({ kind: z.literal('modules'), value: unique(moduleDefinition) }),
])
const ids = z.array(id).refine((values) => new Set(values).size === values.length, 'Duplicate tracked ids.')
const transactionShape: z.ZodType<Transaction> = z.object({
  id,
  author: actor,
  label: z.string(),
  baseRevision: revision,
  resultRevision: revision,
  timestamp,
  operations: z.array(operation),
  patch: z.object({
    baseRevision: revision,
    forward: z.array(mutation),
    inverse: z.array(mutation),
    touched: z.object({ partIds: ids, subassemblyIds: ids }),
  }),
  affectedPartIds: ids,
  sourceTool: z.string().optional(),
  kind: z.enum(['edit', 'undo', 'redo']).optional(),
})

const invalid = (path: string, reason: string) =>
  cloudFailure(
    'INVALID_ARGUMENT',
    `The transaction is invalid at ${path}: ${reason}.`,
    'Re-derive the complete edit from the CAD engine. Keep the local history; no part of this upload was saved.',
    { path },
  )
const isEntityMutation = (entry: EntityMutation): entry is Extract<EntityMutation, { id: string }> =>
  entry.kind === 'part' || entry.kind === 'subassembly' || entry.kind === 'connection'
const target = (entry: EntityMutation): string => (isEntityMutation(entry) ? `${entry.kind}:${entry.id}` : entry.kind)

/** Validate, never normalize. Patches are authoritative for replay; operations
 * also need valid shapes because undo/redo and agent reporting retain them.
 * This does not prove geometric validity or compare an inverse to prior state. */
export function validateTransactionPayload(raw: unknown): CloudResult<Transaction> {
  const problem = storageJsonProblem(raw)
  if (problem) return invalid('transaction', problem)
  const parsed = transactionShape.safeParse(raw)
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join('.').slice(0, 160) || 'transaction'
    return invalid(path, 'invalid stored data shape')
  }
  const transaction = raw as Transaction
  if (
    transaction.resultRevision !== transaction.baseRevision + 1 ||
    transaction.patch.baseRevision !== transaction.baseRevision
  )
    return invalid('patch.baseRevision', 'inconsistent revisions')

  const forwardTargets = new Set<string>()
  const inverseTargets = new Set<string>()
  const touchedParts = new Set(transaction.patch.touched.partIds)
  const touchedAssemblies = new Set(transaction.patch.touched.subassemblyIds)
  const affectedParts = new Set(transaction.affectedPartIds)
  for (const direction of ['forward', 'inverse'] as const) {
    for (const [index, entry] of transaction.patch[direction].entries()) {
      const path = `patch.${direction}.${index}`
      if (isEntityMutation(entry) && entry.value !== null && entry.id !== entry.value.id)
        return invalid(path, 'the entity key and value id disagree')
      if (entry.kind === 'part' && (!touchedParts.has(entry.id) || !affectedParts.has(entry.id)))
        return invalid(path, 'the changed part is missing from change tracking')
      if (entry.kind === 'subassembly' && !touchedAssemblies.has(entry.id))
        return invalid(path, 'the changed subassembly is missing from change tracking')
      const key = target(entry)
      if (direction === 'inverse' && inverseTargets.has(key)) return invalid(path, 'duplicate inverse target')
      const targets = direction === 'forward' ? forwardTargets : inverseTargets
      targets.add(key)
    }
  }
  if (forwardTargets.size !== inverseTargets.size || [...forwardTargets].some((key) => !inverseTargets.has(key)))
    return invalid('patch.inverse', 'the inverse must cover exactly the forward mutation targets')
  return { ok: true, value: transaction }
}
