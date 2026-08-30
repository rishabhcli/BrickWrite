# Validated cloud transaction histories

Human and agent edits share one persisted CAD transaction format. A matching
checksum establishes that bytes arrived intact; it does not establish that those
bytes describe a usable edit. The backend now checks the complete stored shape
before saving or returning transactions, and cloud clients repeat that check
before replaying a history or using it for conflict recovery.

## What is checked

`validateTransactionPayload(unknown)` is shared by the Convex backend and browser,
and exported from `src/cloud`. It returns `CloudResult<Transaction>` without
normalizing the input or stripping extension fields. It has no runtime dependency
on the CAD engine, catalogue, renderer or a model provider.

- Required transaction identity, human/agent authorship, label, timestamp,
  operations, forward/inverse patches and change-tracking arrays.
- Non-negative safe-integer revisions, exactly one revision of advancement, and
  agreement between the transaction and patch base revision. Existing wire ID,
  revision-envelope, schema and checksum checks still apply.
- Every supported operation and mutation kind, with complete nested part,
  transform, subassembly, connection/joint, step, note, constraint and module
  shapes. Snapshots and transactions use the same entity schemas.
- Finite coordinates/numbers, correct vector and matrix lengths, safe IDs,
  entity-key/value-ID agreement, unique IDs in replaced collections, and unique
  IDs in tracking arrays.
- One inverse target for each distinct forward target, and no unrelated or
  duplicate inverse targets. Repeated writes to the same target in a forward
  patch remain valid: their inverse restores the state before the whole edit.
- Part and subassembly mutations must be included in the appropriate touched
  sets; changed parts must also appear in `affectedPartIds`. Conservative extra
  tracked IDs are allowed. An omitted changed entity must not falsely make two
  histories look disjoint.
- Bounded data traversal before recursive canonicalization/schema parsing:
  128 levels and one million visited values, no cycles, non-finite numbers,
  unsafe object keys, accessors, non-JSON objects, sparse/extended arrays or
  non-enumerable/symbol-keyed data. Shared references are allowed. Undefined
  optional object properties remain compatible with the existing serializer,
  which omits them; undefined array entries are refused.

Optional `kind` and `sourceTool` remain optional. Known-shape transactions can
carry additional safe JSON fields, including nested extensions; the validator
returns the original object, not Zod's parsed/stripped copy. Checksums retain
their existing format. Existing count and byte ceilings are unchanged.

## Boundaries and recovery

| Boundary                                              | Behavior on malformed transaction data                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transactions:append` / `appendBatch`                 | `INVALID_ARGUMENT`; no writes for the rejected batch. Schema field paths are bounded, and per-edit failures retain batch index/revision details.                  |
| `transactions:history`, `listSince`, `findByClientId` | `INCOMPLETE_HISTORY` rather than a successful response containing unusable stored data. Existing rows are not modified.                                           |
| Complete-history client                               | Revalidates every record, including responses from custom/older hosts; never returns a partially replayed project as successful.                                  |
| Local claim                                           | Validates the local log before project creation or upload; a malformed log cannot create a cloud shell.                                                           |
| Outbox send                                           | Checks the bounded outgoing prefix before checksumming/sending. Valid leading edits can drain; a malformed item remains parked and persisted for explicit repair. |
| Conflict recovery                                     | Checks the local tail before planning a rebase or clearing/replacing local history. Invalid change-tracking data leaves the original log and queue intact.        |

Error responses carry a field path and repair guidance, not the invalid values,
model contents, Zod diagnostic dump or a stack trace. Checksum failures retain
their distinct error code. There is no automatic deletion, repair, coercion or
truncation of existing history.

This is **structural integrity, not geometric or semantic certification**. It
does not check collisions, catalogue availability, protected-region permissions,
cross-entity references, whether operations explain the patch, or whether an
inverse contains the correct previous values. Those need document/kernel context.
For example, a well-formed inverse targeting the correct part can still contain
the wrong prior pose. No claim of cryptographic authenticity is added; the
existing authenticated project/capability gates remain authoritative.

Local-only `ProjectRepository` persistence is not migrated or rewritten. These
checks guard cloud saves, cloud reads and synchronization/recovery boundaries.

## Verification and rollout

```sh
npm run test:cloud -- --maxWorkers=2 --testTimeout=30000
npm test -- --maxWorkers=2 --testTimeout=30000
npm run lint
npm run typecheck:convex
npm run typecheck:functions
npm run build
```

`transaction-integrity.integration.test.ts` invokes actual Convex functions using
`convex-test`, with injected identities and no live deployment. Its original six
regressions demonstrated successful writes of malformed part/inverse/tracking/
operation data and successful reads of malformed stored undo data. Coverage now
includes scalar/batch refusal, no partial writes, legacy lookup endpoints,
custom-host responses, claim refusal, queued corruption/reload and conflict
recovery without local data loss.

`transaction-validation.test.ts` checks malformed nested values, bounded JSON,
tracking and inverse coverage, extension preservation, all current operation
kinds emitted by the real engine, human/agent authorship, connected geometry,
and undo/redo compatibility. Existing snapshot, cloud history, batch sync,
authorization and UI suites remain part of the regression run.

No new service, dependency, table, field or data migration is needed. Deploy the
Convex validation changes and the frontend together for both protections. New
backends can serve old clients; new clients also reject malformed replies from
old backends. Older malformed stored rows may now refuse to load: keep local
copies and use a complete saved version or a reviewed repair instead of erasing
history to make the check pass. Local test results are not live deployment proof.
