import { incompleteHistory, isRevision, verifyHistoryRecord } from '../../convex/model/history'
import type { CloudBackend, CloudResult, CloudTransactionRecord, ReadHistoryArgs } from './protocol'

/**
 * Read all pages against one fixed head. Never report success for an incomplete
 * tail, a stalled cursor, a changed branch, or a server that ignores the pin.
 * Shared by opening projects and conflict recovery, so neither can lose a tail.
 */
export async function readCompleteHistory(
  backend: Pick<CloudBackend, 'readHistory'>,
  args: ReadHistoryArgs,
): Promise<CloudResult<{ branchId: string; headRevision: number; transactions: CloudTransactionRecord[] }>> {
  let cursor = args.sinceRevision
  let head = args.throughRevision
  let branchId = args.branchId
  const transactions: CloudTransactionRecord[] = []
  for (;;) {
    const result = await backend.readHistory({ ...args, branchId, sinceRevision: cursor, throughRevision: head })
    if (!result.ok) return result
    const page = result.value
    if (
      !isRevision(page.headRevision) ||
      !isRevision(page.nextRevision) ||
      !page.branchId ||
      (head !== undefined && head !== page.headRevision) ||
      (branchId !== undefined && branchId !== page.branchId)
    ) {
      return incompleteHistory('The server changed the branch or revision while reading history.')
    }
    branchId = page.branchId
    head = page.headRevision
    const previous = cursor
    for (const record of page.transactions) {
      if (record.projectId !== args.projectId || record.resultRevision > head) {
        return incompleteHistory('A page returned records outside the requested project or revision.')
      }
      const verified = verifyHistoryRecord(record, cursor)
      if (!verified.ok) return verified
      transactions.push(record)
      cursor = record.resultRevision
    }
    if (page.nextRevision !== cursor || page.done !== cursor >= head || (!page.done && cursor === previous)) {
      return incompleteHistory('The server returned an incomplete or non-advancing history page.')
    }
    if (page.done) return { ok: true, value: { branchId, headRevision: head, transactions } }
  }
}
