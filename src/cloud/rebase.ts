import { applyMutations, invertMutations, type EntityMutation } from '../cad/patch'
import type { ModelDocument, Transaction } from '../cad/types'
import type { CloudBackend, CloudResult } from './protocol'
import { snapshotUploadFor, transactionChecksum } from './serialize'

/**
 * What to do when the local head and the cloud head have diverged.
 *
 * The rule is deliberately narrow, because the alternative is a merge algorithm
 * that is wrong in ways nobody notices until a model is built. A local tail is
 * replayed onto the cloud head **only** when the two sides provably touched
 * disjoint sets of entities. Anything else keeps both histories: the cloud
 * branch stays exactly as it is, and the local tail is preserved as a named
 * conflict branch. Nothing is discarded, ever, and no operator is asked to pick
 * a winner before they have seen both.
 *
 * `Transaction.patch.touched` reports the parts and subassemblies an edit
 * touched — that is what drives incremental revalidation. A rebase needs more
 * than that: two edits that touch no common part can still both rewrite the
 * step list, both edit the constraint set, or both mutate the same connection
 * edge. So the scope below extends `touched` with the connection ids and the
 * whole-document collections the patch mutated, all read straight off
 * `patch.forward`. Anything not provably disjoint is treated as a conflict.
 */

export type GlobalScope = 'name' | 'steps' | 'notes' | 'constraints' | 'modules'

export interface TouchedScope {
  partIds: ReadonlySet<string>
  subassemblyIds: ReadonlySet<string>
  connectionIds: ReadonlySet<string>
  globals: ReadonlySet<GlobalScope>
}

export interface ScopeOverlap {
  partIds: string[]
  subassemblyIds: string[]
  connectionIds: string[]
  globals: GlobalScope[]
}

const GLOBAL_FOR: Partial<Record<EntityMutation['kind'], GlobalScope>> = {
  'document-name': 'name',
  steps: 'steps',
  notes: 'notes',
  constraints: 'constraints',
  modules: 'modules',
}

/** The full entity scope of a run of transactions. */
export function scopeOf(transactions: readonly Transaction[]): TouchedScope {
  const partIds = new Set<string>()
  const subassemblyIds = new Set<string>()
  const connectionIds = new Set<string>()
  const globals = new Set<GlobalScope>()

  for (const transaction of transactions) {
    for (const id of transaction.patch.touched.partIds) partIds.add(id)
    for (const id of transaction.patch.touched.subassemblyIds) subassemblyIds.add(id)
    for (const mutation of transaction.patch.forward) {
      if (mutation.kind === 'connection') connectionIds.add(mutation.id)
      const global = GLOBAL_FOR[mutation.kind]
      if (global) globals.add(global)
    }
  }
  return { partIds, subassemblyIds, connectionIds, globals }
}

const intersect = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] =>
  [...a].filter((value) => b.has(value))

export function overlapOf(a: TouchedScope, b: TouchedScope): ScopeOverlap {
  return {
    partIds: intersect(a.partIds, b.partIds),
    subassemblyIds: intersect(a.subassemblyIds, b.subassemblyIds),
    connectionIds: intersect(a.connectionIds, b.connectionIds),
    globals: intersect(a.globals, b.globals),
  }
}

export const isDisjoint = (overlap: ScopeOverlap): boolean =>
  overlap.partIds.length === 0 &&
  overlap.subassemblyIds.length === 0 &&
  overlap.connectionIds.length === 0 &&
  overlap.globals.length === 0

export type RebasePlan =
  /** The cloud has nothing this browser lacks. */
  | { kind: 'up-to-date'; headRevision: number; document: ModelDocument }
  /** Local had no unsent work; adopt the cloud history as-is. */
  | { kind: 'fast-forward'; headRevision: number; document: ModelDocument; adopted: Transaction[] }
  /** Disjoint scopes: the local tail replays onto the cloud head. */
  | {
      kind: 'rebase'
      headRevision: number
      document: ModelDocument
      /** The local tail, renumbered onto the cloud head. Ids are preserved. */
      rebased: Transaction[]
      /** The cloud tail, which now comes first in the reconciled history. */
      adoptedRemote: Transaction[]
      /** Local transactions the cloud already had, skipped rather than resent. */
      alreadyLanded: Transaction[]
      onto: number
    }
  /** Overlapping scopes: both histories are kept, neither is applied to the other. */
  | {
      kind: 'conflict-fork'
      overlap: ScopeOverlap
      forkRevision: number
      baseDocument: ModelDocument
      localTail: Transaction[]
      remoteTail: Transaction[]
      localDocument: ModelDocument
      remoteDocument: ModelDocument
      /** Suggested branch name; the caller may override it. */
      branchName: string
    }

function replay(base: ModelDocument, transactions: readonly Transaction[]): ModelDocument {
  let document = base
  for (const transaction of transactions) {
    document = applyMutations(document, transaction.patch.forward)
    document = {
      ...document,
      revision: transaction.resultRevision,
      updatedAt: transaction.timestamp,
    }
  }
  return document
}

export interface RebaseInput {
  /** The document at the revision both sides last agreed on. */
  base: ModelDocument
  /** Local transactions after `base`, oldest first. */
  localTail: readonly Transaction[]
  /** Cloud transactions after `base`, oldest first. */
  remoteTail: readonly Transaction[]
  /** Used only to name a conflict branch. */
  now?: () => Date
}

/**
 * Decides what to do, without doing it.
 *
 * Pure: it reads three documents' worth of history and returns a plan. That
 * separation is deliberate — the decision is the part worth testing
 * exhaustively, and executing it involves the network.
 */
export function planRebase(input: RebaseInput): RebasePlan {
  const landedIds = new Set(input.remoteTail.map((transaction) => transaction.id))
  // A transaction the cloud already has is not rebased. Renumbering it would
  // change its content while keeping its id, and the deployment would rightly
  // refuse the pair as two different edits claiming one identity.
  const alreadyLanded = input.localTail.filter((transaction) => landedIds.has(transaction.id))
  const localTail = input.localTail.filter((transaction) => !landedIds.has(transaction.id))

  const remoteDocument = replay(input.base, input.remoteTail)

  if (localTail.length === 0) {
    if (input.remoteTail.length === 0) {
      return { kind: 'up-to-date', headRevision: input.base.revision, document: input.base }
    }
    return {
      kind: 'fast-forward',
      headRevision: remoteDocument.revision,
      document: remoteDocument,
      adopted: [...input.remoteTail],
    }
  }

  if (input.remoteTail.length === 0) {
    return { kind: 'up-to-date', headRevision: input.base.revision, document: input.base }
  }

  const overlap = overlapOf(scopeOf(localTail), scopeOf(input.remoteTail))
  if (!isDisjoint(overlap)) {
    const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
    return {
      kind: 'conflict-fork',
      overlap,
      forkRevision: input.base.revision,
      baseDocument: input.base,
      localTail: [...localTail],
      remoteTail: [...input.remoteTail],
      localDocument: replay(input.base, localTail),
      remoteDocument,
      branchName: `conflict/${stamp}`,
    }
  }

  let document = remoteDocument
  let revision = remoteDocument.revision
  const rebased: Transaction[] = []
  for (const transaction of localTail) {
    const forward = transaction.patch.forward
    // The inverse has to be recomputed against the document the transaction now
    // sits on top of. Carrying the original inverse forward would make undo
    // restore state from a history this branch never had.
    const inverse = invertMutations(document, forward)
    const resultRevision = revision + 1
    rebased.push({
      ...transaction,
      baseRevision: revision,
      resultRevision,
      patch: { baseRevision: revision, forward, inverse, touched: transaction.patch.touched },
    })
    document = applyMutations(document, forward)
    document = { ...document, revision: resultRevision, updatedAt: transaction.timestamp }
    revision = resultRevision
  }

  return {
    kind: 'rebase',
    headRevision: revision,
    document,
    rebased,
    adoptedRemote: [...input.remoteTail],
    alreadyLanded,
    onto: remoteDocument.revision,
  }
}

export interface ConflictFork {
  branchId: string
  branchName: string
  forkRevision: number
  /** Local transactions preserved on the fork, in order. */
  preserved: Transaction[]
}

/**
 * Materialises a conflict fork in the cloud.
 *
 * The branch is created **at the divergence revision**, seeded with a
 * checkpoint of the document as it was there, and then the local tail is
 * appended to it unchanged — same ids, same revisions, same order. The result
 * is a self-contained history: nothing had to be renumbered, so nothing about
 * the losing side was rewritten to make it fit.
 *
 * The main branch is not touched. Both histories exist afterwards and a person
 * chooses between them with both in front of them.
 */
export async function executeConflictFork(
  backend: CloudBackend,
  args: {
    projectId: string
    plan: Extract<RebasePlan, { kind: 'conflict-fork' }>
    branchName?: string
  },
): Promise<CloudResult<ConflictFork>> {
  const name = args.branchName ?? args.plan.branchName
  const branch = await backend.createBranch({
    projectId: args.projectId,
    name,
    kind: 'conflict',
    atRevision: args.plan.forkRevision,
  })
  if (!branch.ok) return branch

  const seeded = await backend.saveCheckpoint({
    projectId: args.projectId,
    branchId: branch.value.branchId,
    snapshot: snapshotUploadFor(args.plan.baseDocument),
  })
  if (!seeded.ok) return seeded

  const preserved: Transaction[] = []
  for (const transaction of args.plan.localTail) {
    const appended = await backend.appendTransaction({
      projectId: args.projectId,
      branchId: branch.value.branchId,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      transaction,
      checksum: transactionChecksum(transaction),
      schemaVersion: args.plan.baseDocument.schemaVersion,
      catalogVersion: args.plan.baseDocument.catalogVersion,
    })
    // A partial fork is worse than none: the caller is told which transaction
    // stopped it so it can retry, and the local log still holds all of them.
    if (!appended.ok) return appended
    preserved.push(transaction)
  }

  return {
    ok: true,
    value: {
      branchId: branch.value.branchId,
      branchName: name,
      forkRevision: args.plan.forkRevision,
      preserved,
    },
  }
}
