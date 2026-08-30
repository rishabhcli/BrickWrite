import {
  cloudFailure,
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  type AppendTransactionsArgs,
  type AppendTransactionsValue,
  type BatchTransaction,
  type CloudBackend,
  type CloudResult,
} from './protocol'
import { canonicalJson, utf8Bytes } from './serialize'

type Target = Pick<AppendTransactionsArgs, 'projectId' | 'branchId'>

/** Largest ordered prefix that fits one request. Invalid oversized single edits
 * remain single so the normal endpoint can explain its per-edit limit. */
export function transactionBatch(
  target: Target,
  entries: readonly BatchTransaction[],
  supportsBatch: boolean,
): AppendTransactionsArgs {
  const batch: AppendTransactionsArgs = {
    projectId: target.projectId,
    ...(target.branchId !== undefined ? { branchId: target.branchId } : {}),
    transactions: [],
  }
  let bytes = utf8Bytes(canonicalJson(batch))
  const count = supportsBatch ? MAX_TRANSACTION_BATCH_COUNT : 1
  for (const entry of entries) {
    if (batch.transactions.length >= count) break
    const added = utf8Bytes(canonicalJson(entry)) + (batch.transactions.length ? 1 : 0)
    if (batch.transactions.length && bytes + added > MAX_TRANSACTION_BATCH_BYTES) break
    batch.transactions.push(entry)
    bytes += added
  }
  return batch
}

const receiptFailure = () =>
  cloudFailure(
    'TRANSPORT_FAILED',
    'The cloud response did not acknowledge every requested edit. The local history is retained.',
    'Retry the same transaction ids; the server will acknowledge any edits already stored without applying them twice.',
  )

/** A successful HTTP/mutation envelope alone must never erase pending work. */
function verifyReceipt(
  args: AppendTransactionsArgs,
  value: AppendTransactionsValue,
): CloudResult<AppendTransactionsValue> {
  const last = args.transactions.at(-1)
  if (
    !last ||
    !value ||
    typeof value.branchId !== 'string' ||
    !value.branchId ||
    (args.branchId !== undefined && value.branchId !== args.branchId) ||
    !Number.isSafeInteger(value.headRevision) ||
    value.headRevision < last.resultRevision ||
    !Array.isArray(value.transactions) ||
    value.transactions.length !== args.transactions.length
  )
    return receiptFailure()
  const ids = new Set<string>()
  let hasNew = false
  for (const [index, receipt] of value.transactions.entries()) {
    const entry = args.transactions[index]
    if (
      !receipt ||
      receipt.clientTransactionId !== entry.clientTransactionId ||
      receipt.resultRevision !== entry.resultRevision ||
      typeof receipt.transactionId !== 'string' ||
      !receipt.transactionId ||
      ids.has(receipt.transactionId) ||
      typeof receipt.applied !== 'boolean' ||
      (hasNew && !receipt.applied)
    )
      return receiptFailure()
    ids.add(receipt.transactionId)
    hasNew ||= receipt.applied
  }
  if (hasNew && value.headRevision !== last.resultRevision) return receiptFailure()
  return { ok: true, value }
}

/** No retry or scalar fallback after ambiguous transport failure: keep ids and
 * let the existing outbox backoff/claim retry decide when to send again. */
export async function sendTransactionBatch(
  backend: CloudBackend,
  args: AppendTransactionsArgs,
): Promise<CloudResult<AppendTransactionsValue>> {
  try {
    if (!args.transactions.length)
      return cloudFailure('INVALID_ARGUMENT', 'There are no edits to send.', 'Queue a transaction first.')
    if (args.transactions.length > 1) {
      if (!backend.appendTransactions)
        return cloudFailure(
          'INVALID_ARGUMENT',
          'This host does not support atomic batches.',
          'Use one transaction per request for this host.',
        )
      const result = await backend.appendTransactions(args)
      return result.ok ? verifyReceipt(args, result.value) : result
    }
    const entry = args.transactions[0]
    const result = await backend.appendTransaction({
      projectId: args.projectId,
      ...(args.branchId !== undefined ? { branchId: args.branchId } : {}),
      ...entry,
    })
    if (!result.ok) return result
    return verifyReceipt(args, {
      branchId: result.value.branchId,
      headRevision: result.value.headRevision,
      transactions: [
        {
          clientTransactionId: entry.clientTransactionId,
          transactionId: result.value.transactionId,
          resultRevision: entry.resultRevision,
          applied: result.value.applied,
        },
      ],
    })
  } catch {
    return receiptFailure()
  }
}
