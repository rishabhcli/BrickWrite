import { describe, expect, it, vi } from 'vitest'
import { blankProject, commitAll } from './harness'
import { transactionBatch, sendTransactionBatch } from '../batches'
import { canonicalJson, transactionChecksum, utf8Bytes } from '../serialize'
import {
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  cloudFailure,
  type AppendTransactionsArgs,
  type AppendTransactionsValue,
  type CloudBackend,
} from '../protocol'

const base = blankProject('batch-client-contract')
const history = commitAll(
  base,
  Array.from({ length: 51 }, (_, index) => [{ type: 'document.rename', name: `Build ${index}` }]),
)
const all = history.transactions.map((transaction) => ({
  transaction,
  clientTransactionId: transaction.id,
  baseRevision: transaction.baseRevision,
  resultRevision: transaction.resultRevision,
  checksum: transactionChecksum(transaction),
  schemaVersion: base.schemaVersion,
  catalogVersion: base.catalogVersion,
}))
const args = (): AppendTransactionsArgs => ({
  projectId: 'project',
  branchId: 'branch',
  transactions: structuredClone(all.slice(0, 3)),
})
const receipt = (request: AppendTransactionsArgs): AppendTransactionsValue => ({
  branchId: request.branchId ?? 'branch',
  headRevision: request.transactions.at(-1)!.resultRevision,
  transactions: request.transactions.map((entry) => ({
    clientTransactionId: entry.clientTransactionId,
    transactionId: `stored-${entry.clientTransactionId}`,
    resultRevision: entry.resultRevision,
    applied: true,
  })),
})
function host() {
  const appendTransactions = vi.fn(async (request: AppendTransactionsArgs) => ({
    ok: true as const,
    value: receipt(request),
  }))
  const appendTransaction = vi.fn(async () => ({
    ok: true as const,
    value: { transactionId: 'stored', branchId: 'branch', headRevision: 1, applied: true },
  }))
  return {
    appendTransactions,
    appendTransaction,
    backend: { appendTransaction, appendTransactions } as unknown as CloudBackend,
  }
}

describe('bounded batch packing', () => {
  it('caps the count while preserving the original payload references and ordering', () => {
    const batch = transactionBatch({ projectId: 'project' }, all, true)
    expect(batch.transactions).toHaveLength(MAX_TRANSACTION_BATCH_COUNT)
    expect(batch.transactions[0]).toBe(all[0])
    expect(batch.transactions.at(-1)).toBe(all[49])
  })

  it('packs by UTF-8 bytes including wire metadata, not UTF-16 string length', () => {
    const entries = all
      .slice(0, 8)
      .map((entry) => ({ ...entry, transaction: { ...entry.transaction, label: '界'.repeat(100_000) } }))
    const target = { projectId: 'project', branchId: 'branch' }
    const batch = transactionBatch(target, entries, true)
    expect(batch.transactions.length).toBe(6)
    expect(utf8Bytes(canonicalJson(batch))).toBeLessThanOrEqual(MAX_TRANSACTION_BATCH_BYTES)
    expect(utf8Bytes(canonicalJson({ ...batch, transactions: [...batch.transactions, entries[6]] }))).toBeGreaterThan(
      MAX_TRANSACTION_BATCH_BYTES,
    )
  })

  it('keeps legacy hosts on the single-transaction path', () => {
    expect(transactionBatch({ projectId: 'project' }, all, false).transactions).toEqual([all[0]])
  })

  it('makes progress on an invalid oversize single edit so the endpoint can refuse it', () => {
    const bad = { ...all[0], transaction: { ...all[0].transaction, label: 'x'.repeat(MAX_TRANSACTION_BATCH_BYTES) } }
    expect(transactionBatch({ projectId: 'project' }, [bad, all[1]], true).transactions).toEqual([bad])
  })
})

describe('batch acknowledgement integrity', () => {
  it('returns complete per-edit acknowledgements', async () => {
    const h = host()
    const request = args()
    expect(await sendTransactionBatch(h.backend, request)).toEqual({ ok: true, value: receipt(request) })
    expect(h.appendTransactions).toHaveBeenCalledExactlyOnceWith(request)
    expect(h.appendTransaction).not.toHaveBeenCalled()
  })

  it('verifies single-edit receipts without requiring batch support', async () => {
    const h = host()
    const request = { ...args(), transactions: [all[0]] }
    expect((await sendTransactionBatch(h.backend, request)).ok).toBe(true)
    expect(h.appendTransaction).toHaveBeenCalledOnce()
    expect(h.appendTransactions).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { ok: false },
    { ok: true },
    { ok: true, value: { transactionId: '', branchId: 'branch', headRevision: 1, applied: true } },
    { ok: true, value: { transactionId: 'stored', branchId: 'branch', headRevision: 2, applied: true } },
  ])('also retains a single edit after an invalid acknowledgement (%j)', async (response) => {
    const h = host()
    h.appendTransaction.mockResolvedValueOnce(response as never)
    expect(await sendTransactionBatch(h.backend, { ...args(), transactions: [all[0]] })).toMatchObject({
      ok: false,
      error: { code: 'TRANSPORT_FAILED' },
    })
    expect(h.appendTransaction).toHaveBeenCalledOnce()
    expect(h.appendTransactions).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing receipt',
      (value: AppendTransactionsValue) => {
        value.transactions.pop()
      },
    ],
    [
      'wrong branch',
      (value: AppendTransactionsValue) => {
        value.branchId = 'other'
      },
    ],
    [
      'behind head',
      (value: AppendTransactionsValue) => {
        value.headRevision = 2
      },
    ],
    [
      'fictitious head',
      (value: AppendTransactionsValue) => {
        value.headRevision = 4
      },
    ],
    [
      'wrong client id',
      (value: AppendTransactionsValue) => {
        value.transactions[1].clientTransactionId = 'wrong'
      },
    ],
    [
      'wrong revision',
      (value: AppendTransactionsValue) => {
        value.transactions[1].resultRevision = 99
      },
    ],
    [
      'duplicate stored id',
      (value: AppendTransactionsValue) => {
        value.transactions[1].transactionId = value.transactions[0].transactionId
      },
    ],
    [
      'empty stored id',
      (value: AppendTransactionsValue) => {
        value.transactions[1].transactionId = ''
      },
    ],
    [
      'retry after new edit',
      (value: AppendTransactionsValue) => {
        value.transactions[1].applied = false
      },
    ],
  ] as const)('refuses %s without scalar fallback', async (_name, change) => {
    const h = host()
    const request = args()
    const response = receipt(request)
    change(response)
    h.appendTransactions.mockResolvedValueOnce({ ok: true, value: response })
    expect(await sendTransactionBatch(h.backend, request)).toMatchObject({
      ok: false,
      error: { code: 'TRANSPORT_FAILED' },
    })
    expect(h.appendTransaction).not.toHaveBeenCalled()
  })

  it.each([{}, { ok: false }, { ok: false, error: 'bad' }, { ok: true }, null])(
    'retains work after a malformed response envelope (%j)',
    async (response) => {
      const h = host()
      h.appendTransactions.mockResolvedValueOnce(response as never)
      expect(await sendTransactionBatch(h.backend, args())).toMatchObject({
        ok: false,
        error: { code: 'TRANSPORT_FAILED' },
      })
    },
  )

  it('permits a fully stored prefix with a newer branch head', async () => {
    const h = host()
    const request = args()
    const response = receipt(request)
    response.headRevision = 99
    response.transactions.forEach((entry) => {
      entry.applied = false
    })
    h.appendTransactions.mockResolvedValueOnce({ ok: true, value: response })
    expect((await sendTransactionBatch(h.backend, request)).ok).toBe(true)
  })

  it('does not make additional writes when a batch outcome is unknown', async () => {
    const h = host()
    h.appendTransactions.mockRejectedValueOnce(new Error('Connection dropped'))
    expect(await sendTransactionBatch(h.backend, args())).toMatchObject({
      ok: false,
      error: { code: 'TRANSPORT_FAILED' },
    })
    expect(h.appendTransactions).toHaveBeenCalledOnce()
    expect(h.appendTransaction).not.toHaveBeenCalled()
  })

  it('preserves a typed backend refusal and its recovery details', async () => {
    const h = host()
    const failure = cloudFailure('STALE_DOCUMENT', 'Behind cloud', 'Rebase', { headRevision: 10, branchId: 'branch' })
    h.appendTransactions.mockResolvedValueOnce(failure as never)
    expect(await sendTransactionBatch(h.backend, args())).toEqual(failure)
  })

  it('refuses empty groups and unsupported multi-edit groups before sending', async () => {
    const h = host()
    expect((await sendTransactionBatch(h.backend, { ...args(), transactions: [] })).ok).toBe(false)
    delete h.backend.appendTransactions
    expect((await sendTransactionBatch(h.backend, args())).ok).toBe(false)
    expect(h.appendTransaction).not.toHaveBeenCalled()
    expect(h.appendTransactions).not.toHaveBeenCalled()
  })
})
