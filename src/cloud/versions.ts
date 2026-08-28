import type {
  BuilderNote,
  CadOperation,
  Constraint,
  ModelDocument,
  ModuleDefinition,
  PartInstance,
} from '../cad/types'
import { canonicalJson } from './serialize'

/**
 * Comparing and restoring versions.
 *
 * A version is immutable in the deployment — nothing patches a version row or
 * its snapshot — so everything here is about reading two documents and saying
 * what changed, and about expressing a restore as *new* work rather than as a
 * rewind.
 *
 * `restorePlan` returns `CadOperation[]`, which means a restore goes through
 * the same kernel path as a human edit: it is preflighted, it collides, it
 * respects locked regions, and it lands as one more transaction on the head. A
 * restore that wrote the old document straight into storage would bypass every
 * one of those and would silently delete work made since.
 *
 * Where the operation vocabulary cannot express a difference, the plan says so
 * instead of quietly dropping it. A restore that claims to be complete and is
 * not is worse than one that reports its own limits.
 */

export interface CollectionDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface DocumentDiff {
  identical: boolean
  name: { from: string; to: string } | null
  revision: { from: number; to: number }
  parts: {
    added: string[]
    removed: string[]
    moved: string[]
    recolored: string[]
    reassigned: string[]
    protectionChanged: string[]
  }
  subassemblies: CollectionDiff
  connections: CollectionDiff
  steps: { changed: boolean; from: number; to: number }
  notes: CollectionDiff
  constraints: CollectionDiff
  modules: CollectionDiff
}

const keysOf = (record: Record<string, unknown>) => Object.keys(record)
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

function diffById<T extends { id: string }>(from: readonly T[], to: readonly T[]): CollectionDiff {
  const before = new Map(from.map((entry) => [entry.id, entry]))
  const after = new Map(to.map((entry) => [entry.id, entry]))
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && !same(before.get(id), after.get(id))),
  }
}

function diffRecord<T>(
  from: Record<string, T>,
  to: Record<string, T>,
): CollectionDiff {
  return {
    added: keysOf(to).filter((id) => !(id in from)),
    removed: keysOf(from).filter((id) => !(id in to)),
    changed: keysOf(to).filter((id) => id in from && !same(from[id], to[id])),
  }
}

/** Structural difference between two documents, `from` → `to`. */
export function diffDocuments(from: ModelDocument, to: ModelDocument): DocumentDiff {
  const partIds = new Set([...keysOf(from.parts), ...keysOf(to.parts)])
  const added: string[] = []
  const removed: string[] = []
  const moved: string[] = []
  const recolored: string[] = []
  const reassigned: string[] = []
  const protectionChanged: string[] = []

  for (const id of partIds) {
    const before = from.parts[id]
    const after = to.parts[id]
    if (!before && after) {
      added.push(id)
      continue
    }
    if (before && !after) {
      removed.push(id)
      continue
    }
    if (!before || !after) continue
    if (!same(before.transform, after.transform)) moved.push(id)
    if (before.color !== after.color) recolored.push(id)
    if (before.subassemblyId !== after.subassemblyId) reassigned.push(id)
    if (before.protected !== after.protected) protectionChanged.push(id)
  }

  const diff: DocumentDiff = {
    identical: false,
    name: from.name === to.name ? null : { from: from.name, to: to.name },
    revision: { from: from.revision, to: to.revision },
    parts: {
      added: added.sort(),
      removed: removed.sort(),
      moved: moved.sort(),
      recolored: recolored.sort(),
      reassigned: reassigned.sort(),
      protectionChanged: protectionChanged.sort(),
    },
    subassemblies: diffRecord(from.subassemblies, to.subassemblies),
    connections: diffRecord(from.connections, to.connections),
    steps: {
      changed: !same(from.steps, to.steps),
      from: from.steps.length,
      to: to.steps.length,
    },
    notes: diffById(from.notes, to.notes),
    constraints: diffById(from.constraints, to.constraints),
    modules: diffById(from.modules ?? [], to.modules ?? []),
  }
  diff.identical = isEmptyDiff(diff)
  return diff
}

function isEmptyDiff(diff: DocumentDiff): boolean {
  const empty = (collection: CollectionDiff) =>
    collection.added.length === 0 &&
    collection.removed.length === 0 &&
    collection.changed.length === 0
  return (
    diff.name === null &&
    diff.parts.added.length === 0 &&
    diff.parts.removed.length === 0 &&
    diff.parts.moved.length === 0 &&
    diff.parts.recolored.length === 0 &&
    diff.parts.reassigned.length === 0 &&
    diff.parts.protectionChanged.length === 0 &&
    empty(diff.subassemblies) &&
    empty(diff.connections) &&
    !diff.steps.changed &&
    empty(diff.notes) &&
    empty(diff.constraints) &&
    empty(diff.modules)
  )
}

/** One line an operator can read, for a version list or a merge proposal. */
export function summariseDiff(diff: DocumentDiff): string {
  if (diff.identical) return 'No structural change.'
  const parts: string[] = []
  const push = (count: number, singular: string, plural = `${singular}s`) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`)
  }
  push(diff.parts.added.length, 'part added', 'parts added')
  push(diff.parts.removed.length, 'part removed', 'parts removed')
  push(diff.parts.moved.length, 'part moved', 'parts moved')
  push(diff.parts.recolored.length, 'part recoloured', 'parts recoloured')
  push(diff.subassemblies.added.length + diff.subassemblies.changed.length, 'subassembly change', 'subassembly changes')
  push(diff.connections.added.length, 'connection added', 'connections added')
  push(diff.connections.removed.length, 'connection removed', 'connections removed')
  push(diff.notes.added.length, 'note added', 'notes added')
  push(diff.constraints.added.length + diff.constraints.changed.length + diff.constraints.removed.length, 'constraint change', 'constraint changes')
  push(diff.modules.added.length + diff.modules.changed.length + diff.modules.removed.length, 'module change', 'module changes')
  if (diff.steps.changed) parts.push('build sequence changed')
  if (diff.name) parts.push('renamed')
  return parts.length > 0 ? parts.join(', ') : 'Changed in fields not summarised here.'
}

export interface RestorePlan {
  operations: CadOperation[]
  /** Differences the operation vocabulary cannot express, stated rather than dropped. */
  unrestorable: string[]
  diff: DocumentDiff
}

/**
 * Operations that turn `current` into `target`, as new work on the head.
 *
 * Order matters: parts are removed before subassemblies are re-pointed, and the
 * build sequence is replaced last, because `steps.replace` reassigns every
 * part's step and would otherwise be undone by the part edits that follow it.
 */
export function restorePlan(current: ModelDocument, target: ModelDocument): RestorePlan {
  const diff = diffDocuments(current, target)
  const operations: CadOperation[] = []
  const unrestorable: string[] = []

  if (diff.name) operations.push({ type: 'document.rename', name: target.name })

  for (const id of diff.subassemblies.added) {
    operations.push({ type: 'subassembly.add', subassembly: clone(target.subassemblies[id]) })
  }
  for (const id of diff.subassemblies.changed) {
    const before = current.subassemblies[id]
    const after = target.subassemblies[id]
    if (before.name !== after.name) {
      operations.push({ type: 'subassembly.rename', subassemblyId: id, name: after.name })
    }
    if (before.locked !== after.locked) {
      operations.push({ type: 'subassembly.lock', subassemblyId: id, locked: after.locked })
    }
    if (before.accent !== after.accent) {
      unrestorable.push(`Subassembly ${id} accent colour cannot be restored.`)
    }
  }
  for (const id of diff.subassemblies.removed) {
    unrestorable.push(`Subassembly ${id} was added after this version and cannot be removed.`)
  }

  // Removals first: a part that has to go should not be re-pointed or recoloured
  // on its way out, and its connection edges are dropped with it by the kernel.
  for (const id of diff.parts.removed) operations.push({ type: 'part.remove', partId: id })
  for (const id of diff.parts.added) {
    operations.push({ type: 'part.add', part: clone(target.parts[id]) as PartInstance })
  }
  for (const id of diff.parts.reassigned) {
    operations.push({
      type: 'part.assign-subassembly',
      partId: id,
      subassemblyId: target.parts[id].subassemblyId,
    })
  }
  for (const id of diff.parts.moved) {
    operations.push({ type: 'part.transform', partId: id, transform: target.parts[id].transform })
  }
  for (const id of diff.parts.recolored) {
    operations.push({ type: 'part.recolor', partId: id, color: target.parts[id].color })
  }
  for (const id of diff.parts.protectionChanged) {
    operations.push({ type: 'part.protect', partId: id, protected: target.parts[id].protected })
  }

  for (const constraint of target.constraints) {
    const before = current.constraints.find((entry) => entry.id === constraint.id)
    if (!before || !same(before, constraint)) {
      operations.push({ type: 'constraint.set', constraint: clone(constraint) as Constraint })
    }
  }
  for (const id of diff.constraints.removed) {
    operations.push({ type: 'constraint.remove', constraintId: id })
  }

  for (const module of target.modules ?? []) {
    const before = (current.modules ?? []).find((entry) => entry.id === module.id)
    if (!before || !same(before, module)) {
      operations.push({ type: 'module.define', module: clone(module) as ModuleDefinition })
    }
  }
  for (const id of diff.modules.removed) {
    operations.push({ type: 'module.remove', moduleId: id })
  }

  for (const note of target.notes) {
    const before = current.notes.find((entry) => entry.id === note.id)
    if (!before) operations.push({ type: 'note.add', note: clone(note) as BuilderNote })
    else if (!same(before, note) && note.response !== undefined) {
      operations.push({
        type: 'note.respond',
        noteId: note.id,
        response: note.response,
        resolved: note.status === 'resolved',
      })
    } else if (!same(before, note)) {
      unrestorable.push(`Note ${note.id} differs in a field the operation set cannot express.`)
    }
  }
  for (const id of diff.notes.removed) {
    unrestorable.push(`Note ${id} was added after this version and cannot be removed.`)
  }

  if (diff.steps.changed) {
    operations.push({ type: 'steps.replace', steps: clone(target.steps) })
  }

  for (const id of diff.connections.removed) {
    unrestorable.push(`Connection ${id} was added after this version; disconnect it by hand.`)
  }
  if (diff.connections.added.length > 0) {
    // Connection edges are recorded by the snap solver when two parts are
    // actually mated; there is no operation that asserts one directly, and
    // fabricating edges the geometry does not support would be worse than
    // saying so.
    unrestorable.push(
      `${diff.connections.added.length} connection edge(s) from this version must be re-made by snapping the parts together.`,
    )
  }

  return { operations, unrestorable, diff }
}

const clone = <T>(value: T): T => structuredClone(value)

export interface VersionComparison {
  diff: DocumentDiff
  summary: string
  /** True when the version and the open document are structurally identical. */
  identical: boolean
}

export function compareToVersion(
  current: ModelDocument,
  version: ModelDocument,
): VersionComparison {
  const diff = diffDocuments(version, current)
  return { diff, summary: summariseDiff(diff), identical: diff.identical }
}
