# Complete cloud history

Cloud project downloads and conflict recovery now reconstruct a complete history, not
the first page of a log. The local IndexedDB persistence format is unchanged.

## Guarantees

- Opening a project without a branch ID selects **main**, not whichever branch most
  recently saved a checkpoint. An explicit branch must belong to that project.
- Checkpoint selection uses a branch-specific index before limiting results. Hundreds
  of newer snapshots on sibling branches cannot hide the requested checkpoint.
- A branch inherits its parent's edits **only through its fork revision**. Nested
  branches keep the same rule. Existing branches with an older copied checkpoint also
  benefit: history reads follow their stored ancestry without rewriting transactions.
- Reads pin one head revision and fetch all pages to that head. Later appends do not
  make a read chase a moving target. Transaction IDs and original author/branch
  provenance are preserved.
- A missing transaction, invalid envelope, unsupported patch kind, checksum mismatch,
  or non-advancing page returns a typed failure. No partially replayed model is returned
  as success. Failed conflict recovery leaves the local document and outbox untouched.
- Append rejects mismatched transaction IDs, revisions and replay patches before
  advancing the branch. This is structural validation, not server-side CAD geometry or
  collision validation; the CAD kernel still owns those semantics.
- Branch creation validates the source checkpoint before inserting a branch or writing
  its success audit event. Incomplete/corrupted source chunks cannot create a ghost
  branch. A conflict branch may still start without a checkpoint so the existing
  conflict-fork workflow can seed its common ancestor.

## API for agents and other clients

`transactions:history` is an authenticated Convex query. It uses the existing Hexclave
identity and project read permissions; this feature adds no new keys or public access.
`ConvexCloudBackend.readHistory()` exposes it through the application's typed API.

```ts
const first = await backend.readHistory({
  projectId,
  branchId, // optional: defaults to main
  sinceRevision: checkpoint.revision,
  limit: 200,
})
```

Successful pages contain:

```ts
{
  ok: true,
  value: {
    branchId,
    headRevision, // fixed read target
    transactions,
    nextRevision, // exclusive cursor for the next call
    done,
  },
}
```

Until `done`, send the returned `branchId`, `nextRevision` as `sinceRevision`, and
**the first page's `headRevision` as `throughRevision`**. Records may report an ancestor
`branchId`; that is their original provenance, not an invitation to change the cursor's
branch. Stop on any error and keep the local copy.

`readCompleteHistory(backend, args)` is exported from `src/cloud/index.ts` for callers
that need the whole tail. It verifies checksums, contiguity, branch identity, and cursor
progress across pages. `CloudProjectStore.loadProject()` and
`MirroredProjectStore.resolveDivergence()` both use it.

Limits: 200 records by default, 500 maximum per page, at most 2 MiB of serialized
transaction records per page, and at most 64 ancestry branches per page. Very deep or
damaged ancestry fails explicitly rather than returning partial history. A complete
checkpoint at the desired revision avoids replaying older ancestry.

`INCOMPLETE_HISTORY` includes recovery guidance. `CHECKSUM_MISMATCH`, `SCHEMA_MISMATCH`,
`INVALID_ARGUMENT`, `STALE_DOCUMENT`, and existing authorization errors retain their
usual meanings. The old `transactions:listSince` remains a branch-local, bounded log
listing for compatibility; do not use one call to it to reconstruct a whole model.

## Verification and rollout

```bash
npm run test:cloud
npm run check
```

`src/cloud/__tests__/history.integration.test.ts` runs the actual Convex queries and
mutations against `convex-test` in the edge runtime, not a rewritten backend double.
It covers long histories, nested forks, concurrent appends during pagination, byte
limits, hidden checkpoints, corruption, access controls, and failure atomicity.
Client/recovery and existing UI tests also run through `test:cloud`.

Deploy **Convex first**, then the frontend. The schema change adds only the
`snapshots.by_branch_kind_revision` index; existing rows and history are preserved.
Old clients remain compatible with the new backend. New clients require
`transactions:history`, so deploying the frontend alone will produce a visible
transport error rather than a fabricated successful load.

These automated tests do not establish a production deployment or a live authenticated
Hexclave-to-Convex round trip. Verify those separately during release.
