import { canonicalJson, checksumOf, utf8Bytes } from './checksum'
import {
  cloudFailure,
  type CloudBranchRecord,
  type CloudHistoryPage,
  type CloudResult,
  type CloudTransactionRecord,
  type ReadHistoryArgs,
} from './protocol'

export const HISTORY_PAGE_SIZE = 200
export const MAX_HISTORY_PAGE_SIZE = 500
export const MAX_HISTORY_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_HISTORY_DEPTH = 64

/** Storage seam shared by real Convex functions and the deterministic UI harness. */
export interface HistorySource {
  branch(id: string): Promise<CloudBranchRecord | null>
  transactions(branchId: string, after: number, through: number): AsyncIterable<CloudTransactionRecord>
}

export function incompleteHistory(message: string, details?: unknown): CloudResult<never> {
  return cloudFailure(
    'INCOMPLETE_HISTORY',
    message,
    'No partial model was opened. Retry, or restore a complete saved version; keep your local copy.',
    details,
  )
}

export const isRevision = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/** Verify the replay envelope before applying anything or advancing a cursor. */
export function verifyHistoryRecord(
  record: Pick<
    CloudTransactionRecord,
    'transaction' | 'baseRevision' | 'resultRevision' | 'clientTransactionId' | 'checksum'
  >,
  base: number,
): CloudResult<true> {
  const transaction = record.transaction
  if (
    !isRevision(base) ||
    !isRevision(record.resultRevision) ||
    !transaction ||
    record.baseRevision !== base ||
    record.resultRevision !== base + 1 ||
    transaction.baseRevision !== base ||
    transaction.resultRevision !== base + 1 ||
    transaction.id !== record.clientTransactionId ||
    transaction.patch?.baseRevision !== base ||
    !Array.isArray(transaction.patch?.forward) ||
    !Array.isArray(transaction.patch?.inverse) ||
    typeof transaction.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(transaction.timestamp))
  ) {
    return incompleteHistory(`The log cannot replay revision ${base + 1}.`, { expectedRevision: base + 1 })
  }
  if (checksumOf(transaction) !== record.checksum) {
    return cloudFailure(
      'CHECKSUM_MISMATCH',
      `Transaction at revision ${base + 1} failed its checksum.`,
      'Keep the local copy and restore a complete saved version; this log cannot safely be replayed.',
    )
  }
  // Unknown mutation kinds are silently ignored by the kernel's switch. They
  // must not turn an unsupported stored patch into a successful partial replay.
  for (const mutation of transaction.patch.forward) {
    if (!mutation || typeof mutation !== 'object') return incompleteHistory('A stored patch is malformed.')
    switch (mutation.kind) {
      case 'document-name':
        if (typeof mutation.value !== 'string') return incompleteHistory('A stored name patch is malformed.')
        break
      case 'part':
      case 'subassembly':
      case 'connection':
        if (
          typeof mutation.id !== 'string' ||
          ['__proto__', 'constructor', 'prototype'].includes(mutation.id) ||
          (mutation.value !== null && (typeof mutation.value !== 'object' || mutation.value.id !== mutation.id))
        ) {
          return incompleteHistory('A stored entity patch is malformed.')
        }
        break
      case 'steps':
      case 'notes':
      case 'constraints':
      case 'modules':
        if (!Array.isArray(mutation.value)) return incompleteHistory('A stored collection patch is malformed.')
        break
      default:
        return incompleteHistory('A stored patch uses an unsupported mutation kind.')
    }
  }
  return { ok: true, value: true }
}

/**
 * A bounded, revision-pinned page across a branch's immutable ancestry.
 * Parent edits are inherited only through the fork revision; later parent edits
 * never leak into the child. Records retain their original branch/provenance.
 */
export async function readBranchHistory(
  source: HistorySource,
  branch: CloudBranchRecord,
  args: ReadHistoryArgs,
): Promise<CloudResult<CloudHistoryPage>> {
  if (
    !isRevision(args.sinceRevision) ||
    (args.throughRevision !== undefined && !isRevision(args.throughRevision)) ||
    (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1))
  ) {
    return cloudFailure(
      'INVALID_ARGUMENT',
      'History cursors must be non-negative safe integers and the page limit must be positive.',
      'Use nextRevision and headRevision from the previous page.',
    )
  }
  const head = args.throughRevision ?? branch.headRevision
  if (!isRevision(branch.headRevision) || !isRevision(branch.baseRevision) || branch.baseRevision > branch.headRevision)
    return incompleteHistory('The branch has invalid revision metadata.')
  if (head > branch.headRevision) {
    return cloudFailure(
      'STALE_DOCUMENT',
      'The requested history ends beyond the branch head.',
      'Restart the read at the current branch head.',
      { headRevision: branch.headRevision, branchId: branch.branchId },
    )
  }
  const limit = Math.min(args.limit ?? HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE)
  let cursor = args.sinceRevision
  const records: CloudTransactionRecord[] = []
  const page = (): CloudResult<CloudHistoryPage> => ({
    ok: true,
    value: {
      branchId: branch.branchId,
      headRevision: head,
      transactions: records,
      nextRevision: cursor,
      done: cursor >= head,
    },
  })
  // A local checkpoint can be ahead of the cloud while its outbox drains.
  if (cursor >= head) return page()

  const segments: { branchId: string; after: number; through: number }[] = []
  const visited = new Set<string>()
  let current = branch
  let through = head
  while (through > cursor) {
    if (
      visited.has(current.branchId) ||
      visited.size >= MAX_HISTORY_DEPTH ||
      current.projectId !== branch.projectId ||
      !isRevision(current.baseRevision) ||
      !isRevision(current.headRevision) ||
      current.baseRevision > current.headRevision ||
      through > current.headRevision
    ) {
      return incompleteHistory('The branch ancestry is invalid or too deep to replay safely.')
    }
    visited.add(current.branchId)
    const after = current.forkedFromBranchId ? Math.max(cursor, current.baseRevision) : cursor
    if (through > after) segments.push({ branchId: current.branchId, after, through })
    if (!current.forkedFromBranchId || cursor >= current.baseRevision) break
    through = Math.min(through, current.baseRevision)
    const parent = await source.branch(current.forkedFromBranchId)
    if (!parent) return incompleteHistory('A parent branch required to replay this history is missing.')
    current = parent
  }

  let bytes = 0
  for (const segment of segments.reverse()) {
    for await (const record of source.transactions(segment.branchId, segment.after, segment.through)) {
      if (
        record.projectId !== branch.projectId ||
        record.branchId !== segment.branchId ||
        record.resultRevision > segment.through
      ) {
        return incompleteHistory('A history record does not belong to the requested branch range.')
      }
      const verified = verifyHistoryRecord(record, cursor)
      if (!verified.ok) return verified
      const size = utf8Bytes(canonicalJson(record))
      if (size > MAX_HISTORY_PAGE_BYTES)
        return cloudFailure(
          'PAYLOAD_TOO_LARGE',
          'A stored transaction exceeds the history page budget.',
          'Restore a complete saved version or keep this project local.',
        )
      if (records.length && bytes + size > MAX_HISTORY_PAGE_BYTES) return page()
      records.push(record)
      bytes += size
      cursor = record.resultRevision
      if (records.length >= limit) return page()
    }
    if (cursor !== segment.through)
      return incompleteHistory(`The branch is missing history after revision ${cursor}.`, {
        expectedRevision: cursor + 1,
        headRevision: head,
      })
  }
  if (cursor !== head) return incompleteHistory('The history ended before the requested branch revision.')
  return page()
}
