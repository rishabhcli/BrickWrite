import type {
  BuildStep,
  BuilderNote,
  CadOperation,
  ConnectionEdge,
  Constraint,
  ModelDocument,
  PartInstance,
  Subassembly,
} from './types'

/**
 * Document patches.
 *
 * A transaction is a forward mutation list plus its exact inverse, not a pair of
 * whole-document snapshots. Two things follow from that:
 *
 *   - Undo applies the inverse instead of restoring a historical copy, so
 *     history costs what the edit costs rather than what the model costs.
 *   - Every commit reports precisely which entities it touched, which is what
 *     lets collision and connectivity be rechecked locally.
 *
 * Cardinality decides granularity. Parts, subassemblies and connection edges are
 * patched per entity because a model has thousands of them. Steps, notes and
 * constraints are replaced wholesale because a document has a handful, and
 * per-entity mutation of an ordered array would cost more in index bookkeeping
 * than it saves.
 */

export type EntityMutation =
  | { kind: 'document-name'; value: string }
  /** `value: null` deletes the entity. */
  | { kind: 'part'; id: string; value: PartInstance | null }
  | { kind: 'subassembly'; id: string; value: Subassembly | null }
  | { kind: 'connection'; id: string; value: ConnectionEdge | null }
  | { kind: 'steps'; value: BuildStep[] }
  | { kind: 'notes'; value: BuilderNote[] }
  | { kind: 'constraints'; value: Constraint[] }

export interface TouchedEntities {
  readonly partIds: readonly string[]
  readonly subassemblyIds: readonly string[]
}

export interface DocumentPatch {
  readonly baseRevision: number
  readonly forward: readonly EntityMutation[]
  readonly inverse: readonly EntityMutation[]
  readonly touched: TouchedEntities
}

const clone = <T,>(value: T): T => structuredClone(value)

/**
 * Applies mutations, sharing structure with the previous document.
 *
 * Only the top-level records are copied and only touched entries replaced, so an
 * edit to one brick does not deep-copy the other four thousand. Untouched part
 * objects are shared by reference, which is safe because the kernel never
 * mutates a stored entity in place.
 */
export function applyMutations(document: ModelDocument, mutations: readonly EntityMutation[]): ModelDocument {
  const next: ModelDocument = {
    ...document,
    parts: { ...document.parts },
    subassemblies: { ...document.subassemblies },
    connections: { ...document.connections },
  }
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'document-name':
        next.name = mutation.value
        break
      case 'part':
        if (mutation.value) next.parts[mutation.id] = mutation.value
        else delete next.parts[mutation.id]
        break
      case 'subassembly':
        if (mutation.value) next.subassemblies[mutation.id] = mutation.value
        else delete next.subassemblies[mutation.id]
        break
      case 'connection':
        if (mutation.value) next.connections[mutation.id] = mutation.value
        else delete next.connections[mutation.id]
        break
      case 'steps':
        next.steps = mutation.value
        break
      case 'notes':
        next.notes = mutation.value
        break
      case 'constraints':
        next.constraints = mutation.value
        break
    }
  }
  return next
}

/**
 * Reads the mutations that would undo `forward` against `document`.
 *
 * Computed before the forward list is applied, so each inverse carries the value
 * that was actually there — including "was absent", which deletes on undo.
 */
export function invertMutations(
  document: ModelDocument,
  forward: readonly EntityMutation[],
): EntityMutation[] {
  const inverse: EntityMutation[] = []
  const seen = new Set<string>()
  for (const mutation of forward) {
    switch (mutation.kind) {
      case 'document-name':
        if (!seen.has('document-name')) {
          seen.add('document-name')
          inverse.push({ kind: 'document-name', value: document.name })
        }
        break
      case 'part':
      case 'subassembly':
      case 'connection': {
        // Only the first mutation of an entity matters: the inverse must restore
        // the state before the whole batch, not before the last touch.
        const key = `${mutation.kind}:${mutation.id}`
        if (seen.has(key)) break
        seen.add(key)
        const source =
          mutation.kind === 'part'
            ? document.parts
            : mutation.kind === 'subassembly'
              ? document.subassemblies
              : document.connections
        const previous = (source as Record<string, unknown>)[mutation.id]
        inverse.push({ kind: mutation.kind, id: mutation.id, value: (previous ? clone(previous) : null) as never })
        break
      }
      case 'steps':
        if (!seen.has('steps')) {
          seen.add('steps')
          inverse.push({ kind: 'steps', value: clone(document.steps) })
        }
        break
      case 'notes':
        if (!seen.has('notes')) {
          seen.add('notes')
          inverse.push({ kind: 'notes', value: clone(document.notes) })
        }
        break
      case 'constraints':
        if (!seen.has('constraints')) {
          seen.add('constraints')
          inverse.push({ kind: 'constraints', value: clone(document.constraints) })
        }
        break
    }
  }
  return inverse
}

export function touchedBy(mutations: readonly EntityMutation[]): TouchedEntities {
  const partIds = new Set<string>()
  const subassemblyIds = new Set<string>()
  for (const mutation of mutations) {
    if (mutation.kind === 'part') partIds.add(mutation.id)
    if (mutation.kind === 'subassembly') subassemblyIds.add(mutation.id)
  }
  return { partIds: [...partIds], subassemblyIds: [...subassemblyIds] }
}

/**
 * Translates the operation language into entity mutations.
 *
 * Operations are the stable contract shared by the editor and WebMCP; mutations
 * are the storage-level representation. Keeping them separate means the
 * operation vocabulary can grow without changing how history is stored.
 */
export function mutationsForOperations(
  document: ModelDocument,
  operations: readonly CadOperation[],
  author: 'human' | 'agent',
  transactionId: string,
): EntityMutation[] {
  // A working copy lets a batch build on its own earlier operations — placing a
  // part and then recolouring it in one transaction, for instance.
  let working = document
  const mutations: EntityMutation[] = []
  const emit = (mutation: EntityMutation) => {
    mutations.push(mutation)
    working = applyMutations(working, [mutation])
  }

  const withMembership = (subassemblyId: string, mutate: (members: string[]) => string[]) => {
    const subassembly = working.subassemblies[subassemblyId]
    if (!subassembly) return
    emit({
      kind: 'subassembly',
      id: subassemblyId,
      value: { ...subassembly, partIds: mutate([...subassembly.partIds]) },
    })
  }

  const withSteps = (mutate: (steps: BuildStep[]) => BuildStep[]) => {
    emit({ kind: 'steps', value: mutate(working.steps.map((step) => ({ ...step, partIds: [...step.partIds] }))) })
  }

  for (const operation of operations) {
    switch (operation.type) {
      case 'document.rename':
        emit({ kind: 'document-name', value: operation.name.trim() })
        break
      case 'part.add': {
        const part: PartInstance = {
          ...clone(operation.part),
          provenance: author,
          createdByTransaction: transactionId,
        }
        emit({ kind: 'part', id: part.id, value: part })
        withMembership(part.subassemblyId, (members) => (members.includes(part.id) ? members : [...members, part.id]))
        withSteps((steps) =>
          steps.map((step) =>
            step.id === part.stepId && !step.partIds.includes(part.id)
              ? { ...step, partIds: [...step.partIds, part.id] }
              : step,
          ),
        )
        break
      }
      case 'part.remove': {
        const part = working.parts[operation.partId]
        if (!part) break
        emit({ kind: 'part', id: part.id, value: null })
        withMembership(part.subassemblyId, (members) => members.filter((id) => id !== part.id))
        withSteps((steps) => steps.map((step) => ({ ...step, partIds: step.partIds.filter((id) => id !== part.id) })))
        // A removed part cannot remain an endpoint of any connection.
        for (const edge of Object.values(working.connections)) {
          if (edge.a.partId === part.id || edge.b.partId === part.id) {
            emit({ kind: 'connection', id: edge.id, value: null })
          }
        }
        break
      }
      case 'part.transform': {
        const part = working.parts[operation.partId]
        if (part) {
          emit({
            kind: 'part',
            id: part.id,
            value: { ...part, transform: operation.transform, provenance: author, createdByTransaction: transactionId },
          })
        }
        break
      }
      case 'part.recolor': {
        const part = working.parts[operation.partId]
        if (part) {
          emit({ kind: 'part', id: part.id, value: { ...part, color: operation.color, provenance: author, createdByTransaction: transactionId } })
        }
        break
      }
      case 'part.protect': {
        const part = working.parts[operation.partId]
        if (part) emit({ kind: 'part', id: part.id, value: { ...part, protected: operation.protected } })
        break
      }
      case 'part.assign-subassembly': {
        const part = working.parts[operation.partId]
        if (!part) break
        withMembership(part.subassemblyId, (members) => members.filter((id) => id !== part.id))
        emit({ kind: 'part', id: part.id, value: { ...part, subassemblyId: operation.subassemblyId, provenance: author } })
        withMembership(operation.subassemblyId, (members) =>
          members.includes(part.id) ? members : [...members, part.id],
        )
        break
      }
      case 'subassembly.add':
        emit({ kind: 'subassembly', id: operation.subassembly.id, value: clone(operation.subassembly) })
        break
      case 'subassembly.rename': {
        const subassembly = working.subassemblies[operation.subassemblyId]
        if (subassembly) {
          emit({ kind: 'subassembly', id: subassembly.id, value: { ...subassembly, name: operation.name.trim() } })
        }
        break
      }
      case 'subassembly.lock': {
        const subassembly = working.subassemblies[operation.subassemblyId]
        if (subassembly) {
          emit({ kind: 'subassembly', id: subassembly.id, value: { ...subassembly, locked: operation.locked } })
        }
        break
      }
      case 'constraint.set': {
        const index = working.constraints.findIndex((constraint) => constraint.id === operation.constraint.id)
        const constraints = clone(working.constraints)
        if (index >= 0) constraints[index] = clone(operation.constraint)
        else constraints.push(clone(operation.constraint))
        emit({ kind: 'constraints', value: constraints })
        break
      }
      case 'constraint.remove':
        emit({ kind: 'constraints', value: working.constraints.filter((constraint) => constraint.id !== operation.constraintId) })
        break
      case 'steps.replace': {
        emit({ kind: 'steps', value: operation.steps.map((step) => ({ ...step, partIds: [...step.partIds] })) })
        const owner = new Map<string, string>()
        for (const step of operation.steps) {
          for (const partId of step.partIds) owner.set(partId, step.id)
        }
        for (const part of Object.values(working.parts)) {
          const stepId = owner.get(part.id)
          if (stepId && stepId !== part.stepId) emit({ kind: 'part', id: part.id, value: { ...part, stepId } })
        }
        break
      }
      case 'note.add':
        emit({
          kind: 'notes',
          value: [
            ...working.notes,
            { ...clone(operation.note), author, revisionCreated: working.revision },
          ],
        })
        break
      case 'note.respond':
        emit({
          kind: 'notes',
          value: working.notes.map((note) =>
            note.id === operation.noteId
              ? { ...note, response: operation.response, status: operation.resolved ? 'resolved' : note.status }
              : note,
          ),
        })
        break
    }
  }
  return mutations
}
