import { applyMutations, invertMutations, type EntityMutation } from '../cad/patch'
import type { ModelDocument, Transaction } from '../cad/types'
import { cloudFailure, MAX_TRANSACTION_BYTES, type CloudBackend, type CloudResult } from './protocol'
import { canonicalJson, snapshotUploadFor, transactionChecksum, utf8Bytes } from './serialize'
import { sendTransactionBatch, transactionBatch } from './batches'
import { incompleteHistory, isRevision } from '../../convex/model/history'
import { validateTransactionPayload } from '../../convex/model/transactionValidation'
import { decodeSnapshotUpload } from '../../convex/model/snapshotValidation'
import { storageJsonProblem } from '../../convex/model/storageJson'

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

const intersect = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] => [...a].filter((value) => b.has(value))

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
  // Only a byte-equivalent common prefix is already landed. Comparing ids alone
  // can discard a different local edit; filtering a prefix without advancing the
  // fork checkpoint leaves a revision gap in the preserved history.
  let shared = 0
  while (
    shared < input.localTail.length &&
    shared < input.remoteTail.length &&
    canonicalJson(input.localTail[shared]) === canonicalJson(input.remoteTail[shared])
  )
    shared += 1
  const alreadyLanded = input.localTail.slice(0, shared)
  const base = replay(input.base, alreadyLanded)
  const localTail = input.localTail.slice(shared)
  const remoteTail = input.remoteTail.slice(shared)

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

  if (remoteTail.length === 0) {
    return { kind: 'up-to-date', headRevision: base.revision, document: base }
  }

  const overlap = overlapOf(scopeOf(localTail), scopeOf(remoteTail))
  const remoteIds = new Set(remoteTail.map((transaction) => transaction.id))
  const reusedId = localTail.some((transaction) => remoteIds.has(transaction.id))
  if (!isDisjoint(overlap) || reusedId) {
    const stamp = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
    return {
      kind: 'conflict-fork',
      overlap,
      forkRevision: base.revision,
      baseDocument: base,
      localTail: [...localTail],
      remoteTail: [...input.remoteTail],
      localDocument: replay(base, localTail),
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
    /** Pin the source branch returned by the history read, never assume main. */
    fromBranchId?: string
  },
): Promise<CloudResult<ConflictFork>> {
  // Validate the whole local tail before allocating anything remotely. A later
  // malformed edit must not strand an otherwise valid prefix on a new branch.
  if (
    !isRevision(args.plan.forkRevision) ||
    args.plan.baseDocument.revision !== args.plan.forkRevision ||
    !args.plan.localTail.length ||
    storageJsonProblem(args.plan.baseDocument)
  ) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'Conflict recovery needs a complete base and non-empty local history.',
      'Keep the local copy and retry from the divergence checkpoint.',
    )
  }
  let revision = args.plan.forkRevision
  const ids = new Set<string>()
  for (const transaction of args.plan.localTail) {
    const valid = validateTransactionPayload(transaction)
    if (!valid.ok) return valid
    if (utf8Bytes(canonicalJson(transaction)) > MAX_TRANSACTION_BYTES)
      return cloudFailure(
        'PAYLOAD_TOO_LARGE',
        'A local edit exceeds the cloud transaction limit.',
        'Keep the local history and split the edit into smaller commits before retrying recovery.',
      )
    if (transaction.baseRevision !== revision || transaction.resultRevision !== revision + 1 || ids.has(transaction.id))
      return incompleteHistory('The local conflict history has a revision gap or duplicate transaction id.')
    ids.add(transaction.id)
    revision += 1
  }
  const snapshot = snapshotUploadFor(args.plan.baseDocument)
  const decoded = decodeSnapshotUpload(snapshot)
  if (!decoded.ok) return decoded
  // The identity is independent of timestamps, remote-head movement and a
  // process-local journal. Reloading the same local history recreates it.
  // Hash each edit separately so long tails do not require one giant JSON body.
  const digest = async (value: unknown) => {
    const bytes = new TextEncoder().encode(canonicalJson(value))
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  const tail: string[] = []
  for (const transaction of args.plan.localTail) tail.push(await digest(transaction))
  const requestedName = args.branchName?.trim()
  const key = await digest({
    version: 1,
    projectId: args.projectId,
    fromBranchId: args.fromBranchId,
    base: await digest(args.plan.baseDocument),
    tail,
    branchName: requestedName,
  })
  const name = requestedName ?? `conflict/r${args.plan.forkRevision}-${key.slice(0, 24)}`
  const branch = await backend.createBranch({
    projectId: args.projectId,
    name,
    kind: 'conflict',
    atRevision: args.plan.forkRevision,
    fromBranchId: args.fromBranchId,
    recovery: { key, snapshot },
  })
  if (!branch.ok) return branch

  if (
    !branch.value?.branchId ||
    branch.value.projectId !== args.projectId ||
    branch.value.kind !== 'conflict' ||
    branch.value.name !== name ||
    branch.value.baseRevision !== args.plan.forkRevision ||
    !isRevision(branch.value.headRevision) ||
    branch.value.headRevision < args.plan.forkRevision ||
    (args.fromBranchId !== undefined && branch.value.forkedFromBranchId !== args.fromBranchId)
  )
    return cloudFailure(
      'TRANSPORT_FAILED',
      'The cloud did not acknowledge the requested conflict branch.',
      'Retry the same recovery; local work is retained.',
    )

  const entries = args.plan.localTail.map((transaction) => ({
    clientTransactionId: transaction.id,
    baseRevision: transaction.baseRevision,
    resultRevision: transaction.resultRevision,
    transaction,
    checksum: transactionChecksum(transaction),
    schemaVersion: args.plan.baseDocument.schemaVersion,
    catalogVersion: args.plan.baseDocument.catalogVersion,
  }))
  let sent = 0
  while (sent < entries.length) {
    const batch = transactionBatch(
      { projectId: args.projectId, branchId: branch.value.branchId },
      entries.slice(sent),
      !!backend.appendTransactions,
    )
    const appended = await sendTransactionBatch(backend, batch)
    // Re-submit the same ids on retry. The server acknowledges committed
    // prefixes without duplicate writes; verified receipts gate local cleanup.
    if (!appended.ok) return appended
    sent += batch.transactions.length
  }

  return {
    ok: true,
    value: {
      branchId: branch.value.branchId,
      branchName: name,
      forkRevision: args.plan.forkRevision,
      preserved: [...args.plan.localTail],
    },
  }
}
