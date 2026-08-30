# Retry-safe conflict recovery

Overlapping human and agent edits are preserved on a conflict branch instead of
silently choosing a winner. Recovery now survives a lost creation response,
a partially uploaded tail, or a client restart without allocating another fork
for the same local history.

## Cloud contract

`versions:createBranch` accepts an optional recovery request:

```ts
{
  projectId,
  name,
  kind: 'conflict',
  fromBranchId,
  atRevision,
  recovery: { key, snapshot }
}
```

- The key is 16–128 ASCII letters, digits, underscores or hyphens. Recovery
  requires an explicit fork revision and a complete checkpoint at that revision.
- Authorization runs before looking up a receipt. Receipts are indexed by
  project, authenticated creator and key, not by a caller-supplied identity.
- The branch, checkpoint chunks, immutable seed reference and audit event are
  created in **one Convex mutation**. Expected validation failures occur before
  any write; unexpected storage failures throw and roll back the mutation.
- A retry must match the original name, parent, revision and complete seed
  document. The server compares canonical content, not merely checksums, and
  returns the existing branch at its current head. It does not write another
  audit event, reset the head or replace a newer checkpoint.
- A legacy branch with the same name is not treated as a recovery receipt.
  Changed requests are refused rather than grafted onto someone else's work.

Ordinary branch creation remains create-only. The two optional branch fields
(`recoveryKey`, `recoverySnapshotGroupId`) and the `by_recovery` index are additive;
existing branches need no backfill.

## Shared human/agent recovery path

`executeConflictFork` validates the complete local tail and checkpoint before
creating remote state. Its default key is SHA-256 over the project, selected
source branch, canonical base, ordered transaction digests and optional explicit
name. Plan timestamps and subsequent remote-head movement do not change that
identity. A new local history intentionally produces a different recovery fork.
Keys identify requests; they are not authorization credentials.

The fork is seeded atomically, then edits are uploaded in bounded batches using
the existing batch protocol (up to 50 edits and 2 MiB per request, 512 KiB per
edit). Hosts without batching use the same verified scalar path. Retries resend
the original transaction IDs and payloads; already-committed prefixes are
acknowledged without applying them again. No partial receipt counts as success.
A very large fork is therefore **resumable, not one atomic upload**.

Reconciliation recognizes only a content-identical, contiguous common prefix as
already landed. The fork checkpoint advances past that prefix, so its remaining
local transactions retain their original revision sequence. Matching IDs with
different content force preservation on a separate branch, even if the edited
entities otherwise appear disjoint. The source branch comes from the pinned
history read, not an assumption that every project is on main.

The mirrored store retains its log and outbox after upload failures or malformed
acknowledgements. Before adopting the remote history it rechecks the checkpoint,
link and local tail under a per-project local-write lock. New human or agent
edits made while uploads are in flight cause a `STALE_DOCUMENT` refusal rather
than being erased. The lock is not held during fork uploads. Concurrent recovery
calls cannot both finalize the same captured local state.

## Boundaries and rollout

- The finalization lock coordinates one `MirroredProjectStore` instance. This
  change does not add cross-tab locking or make the existing multi-store local
  history replacement an atomic IndexedDB transaction. The preserved cloud fork
  remains available if local storage fails during finalization.
- A failed upload may leave a visible, partially populated conflict branch. It
  is retained for retry and inspection, not automatically deleted. No merge is
  performed and the selected source branch is not rewritten.
- Recovery receipts are additive metadata. Deploy the Convex schema/functions
  before the new frontend. An old backend that rejects the new argument returns
  a transport failure; the client retains local work, without falling back to
  unsafe legacy creation. Existing old partial forks are not silently adopted.
- These checks verify schema, content identity, sequencing and receipts. They
  do not prove geometric correctness or that a client checkpoint was derived
  from the server's history.
- No new dependency, paid service, credential or live deployment was introduced.

## Verification

`src/cloud/__tests__/conflict-recovery.integration.test.ts` exercises actual
Convex handlers through `convex-test`, with real CAD-engine transactions,
injected identities and fault-injected responses. It covers creation and append
response loss, 52-edit resume, client reconstruction, post-write rollback, seed immutability, invalid
requests with no writes, authorization, prefix ancestry, reused IDs, selected
branches, malformed receipts, local continuity and human/agent edits arriving
during recovery. It is local integration proof, not production deployment proof.

```sh
npm run test:cloud -- --maxWorkers=2 --testTimeout=30000
npm test -- --maxWorkers=2 --testTimeout=30000
npm run lint
npm run typecheck:convex
npm run typecheck:functions
npm run build
```
