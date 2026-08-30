# Atomic batched cloud synchronization

Human and agent edits share the same revisioned transaction log. Claiming a local
project or reconnecting after offline work now uploads bounded groups of those
original transactions instead of making one round trip per edit. Nothing is
squashed: IDs, patches, inverses, authorship, provenance and revisions survive.

The local Convex integration tests demonstrate **120 edits in 3 append requests**
(`50 + 50 + 20`) for both claims and queued catch-up, with the original history
preserved. This is a request-count measurement, not a live latency benchmark.

## Shared backend contract

`transactions:appendBatch` / `CloudBackend.appendTransactions()` accepts:

```ts
{
  projectId: string,
  branchId?: string, // defaults to the project's default branch
  transactions: Array<{
    clientTransactionId: string,
    baseRevision: number,
    resultRevision: number,
    transaction: Transaction,
    checksum: string,
    schemaVersion: number,
    catalogVersion: string,
  }>,
}
```

- One request contains **1–50 edits**, at most **2 MiB** of canonical UTF-8 JSON
  including the request envelope. The existing **512 KiB per-edit** limit also
  applies. Split histories at transaction boundaries; never split a transaction.
- The caller needs the existing `transaction.write` capability. Hexclave identity,
  project membership and branch ownership checks are unchanged; this adds no
  anonymous-write or elevated-agent path.
- Edits must be contiguous and ordered, each advancing exactly one revision, with
  unique client transaction IDs. The server checks schema, checksums and the
  shared [transaction-integrity rules](cloud-transaction-integrity.md), including
  nested forward/inverse shapes and change tracking, before writing anything.
- A new suffix must start at the current branch head. `STALE_DOCUMENT` carries
  the actual stored head and branch for conflict recovery, not a hypothetical
  partially applied head. Per-item refusals include the zero-based `batchIndex`,
  `clientTransactionId` and `resultRevision`.
- **The whole batch commits or none of it does.** All expected validation and
  retry checks precede the first write. Unexpected storage errors throw to roll
  back the transaction. New edits retain individual redacted audit events, while
  branch/project head metadata is updated once per batch.
- These are storage-shape and replay-envelope checks, not geometric certification.
  The CAD kernel remains responsible for physical validity, protected regions
  and command semantics.

Success returns `branchId`, `headRevision`, and one ordered receipt per input:
`{ clientTransactionId, transactionId, resultRevision, applied }`.

Idempotency is scoped to project, branch and client transaction ID. An exact retry
must match the complete canonical payload and revision/schema/catalogue metadata,
not merely its non-cryptographic checksum. Existing edits may form a prefix of
the request, followed by new edits; retries return their original stored IDs with
`applied: false` and add no audits or timestamp writes. An entirely retried range
can return a newer branch head without claiming the new revisions were uploaded.

`transactions:append` retains its single-edit arguments and response, using the
same validation and storage path. Existing clients can continue to call it.

## Client recovery and ordering

The public cloud entry point exports the batch types, limits, `transactionBatch()`
and `sendTransactionBatch()`. Packing counts actual UTF-8 bytes and caps the
candidate prefix before checksum work; it does not rehash the entire queue for
each network request.

- Claims retain exact-seed retry behavior and validate the complete local log
  before upload. `transactionsUploaded` counts newly applied edits, not retry
  receipts. A local/cloud link is recorded only after successful upload and a
  final head check. See [save integrity](cloud-save-integrity.md).
- The outbox batches only adjacent, ready transactions in the same project,
  local history and schema/catalogue. Checkpoints, parked entries, backoff timers
  and revision gaps are boundaries. Global FIFO ordering is unchanged: a blocked
  project still blocks the queue rather than silently skipping dependent work.
- Before deleting queue entries, the client verifies receipt count, order, IDs,
  revisions, branch, head and applied/retry ordering. Missing or malformed
  acknowledgements become `TRANSPORT_FAILED`; pending work remains retryable.
- A network failure can occur after a successful commit. There is no immediate
  scalar fallback for an ambiguous outcome: reconnect/retry sends the same IDs.
  If local acknowledgement deletion fails partway, the remaining entries also
  retry safely after storage recovers.
- A definitive data refusal from an atomic batch may trigger a single-edit
  request to isolate a bad later item. Valid leading edits can then drain while
  the bad item remains visible and queued. Stale/permission/transport errors
  never trigger that fallback.
- Custom hosts without the optional batch method stay on the legacy scalar
  path. A single pending edit also uses `append`, so interactive editing does not
  wait for a batch to fill.

Atomicity applies to **each bounded batch**, not an entire multi-batch claim.
Earlier successful batches remain stored when a later batch fails; retry resumes
without overwriting either local history or a competing cloud history.

## Verification and rollout

```sh
npm run test:cloud -- --maxWorkers=2 --testTimeout=30000
npm run typecheck:convex
npm run typecheck:functions
npm run lint
npm run build
```

`batch.integration.test.ts` invokes real Convex functions via `convex-test`, using
real CAD-engine histories. It covers all-or-nothing refusal/rollback, competing
writers, authorization, branch isolation, human/agent authorship, exact retries,
120-edit uploads, dropped acknowledgements, malformed receipts, local storage
failure and queue boundaries. `batches.test.ts` checks byte packing and receipt
validation; legacy scalar recovery remains covered by the cloud suite.

**Deploy Convex before the frontend.** This feature adds an endpoint, not tables
or a schema migration. The new Convex adapter advertises batch support; an older
deployment missing `transactions:appendBatch` is not automatically downgraded
after a transport error. Retained queues can recover after backend rollout.
No live Hexclave-authenticated write or production deployment is implied by the
local test harness.
