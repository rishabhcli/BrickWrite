# Safe cloud saves and interrupted claims

Project creation, checkpoints and versions share a server-side snapshot validator.
The editor's **Claim in cloud** action uses the same authenticated API as other
clients and agents; no new service, permission, API key or public access is added.

## Save guarantees

- A rejected initial upload leaves **no project, branch, membership, snapshot or
  success audit event**. Expected errors are checked before inserting any rows.
  Unexpected failures after writes throw, so Convex rolls back the mutation.
- Checksums alone are not enough. The backend validates JSON, schema-2 document
  structure, finite transforms/numbers, collection shapes and unique IDs, entity
  keys, and the revision/schema/catalogue envelope. Snapshots must carry this
  project's local document ID, not another model's ID.
- Chunk count (64 maximum), individual chunk bytes (800,000 maximum), actual total
  bytes (8 MiB maximum), and nesting (128 levels maximum) are bounded independently
  of caller-declared sizes. Use the standard 400,000-byte serializer chunks.
- A checkpoint cannot run ahead of its branch's transaction log. Upload edits
  first; `STALE_DOCUMENT` reports the stored head when transactions are missing.
  Delayed checkpoints at older revisions remain valid and cannot hide newer ones.
- Named versions may intentionally capture unsynced local work ahead of the cloud
  head. They are immutable saved documents, **not** checkpoints that advance or
  replace the branch log. Invalid versions do not consume their labels.
- Reads validate stored shapes too, including project identity and bounded chunk
  metadata. Invalid stored documents return `INCOMPLETE_SNAPSHOT`, not an object
  that later crashes the editor or an agent. Existing data is never rewritten.
- Optional modules and unknown JSON extension fields are preserved, not defaulted
  or stripped. A newer catalogue can be saved to an existing schema-compatible
  replica; each snapshot still records its own actual catalogue.

These are storage-integrity checks, **not geometric certification**. Unfinished or
physically invalid builds remain saveable. CAD collision checks, reference/constraint
semantics and catalogue availability are still the kernel's responsibility. A valid
checkpoint envelope does not prove its content was derived from the branch's edits;
authorized writers remain responsible for sending the right document for that branch.

## Retrying a claim

`projects:create` / `CloudBackend.createProject()` accepts an optional flag:

```ts
await backend.createProject({
  localProjectId: originalDocument.id,
  name: originalName,
  visibility: originalVisibility,
  schemaVersion: originalDocument.schemaVersion,
  catalogVersion: originalDocument.catalogVersion,
  snapshot: snapshotUploadFor(originalDocument),
  resumeExisting: true,
})
```

New projects retain an immutable creation receipt pointing to their original seed.
For the same authenticated owner and local project ID, an explicit retry succeeds
only if the original name, visibility and seed document match. The seed comparison
uses the complete canonical document, not just the non-cryptographic checksum.
Chunk boundaries and JSON key order do not have to match.

A successful retry returns the **current** project and branch head. It does not
reset the head, overwrite later snapshots, restore the old name/visibility, add a
membership, or create another success audit event. Transaction uploads then reuse
their existing IDs: already-committed edits are acknowledged, not duplicated.

`claimLocalProject()` opts into this behavior automatically. It validates the local
seed and contiguous log before sending a create, stops on the first failed append,
and checks the final remote head before reporting success. The mirrored store records
its local/cloud link only on success. `transactionsUploaded` counts newly applied
transactions in this attempt, not acknowledged duplicates.

Consequently, retrying **Claim in cloud** after a dropped create response or a partial
log upload can finish the original claim instead of getting stuck on `NAME_TAKEN`.
Neither the local document nor its transaction log is modified by this process.

### Deliberate refusal boundaries

- Without `resumeExisting`, duplicate creation still returns `NAME_TAKEN`.
- A changed seed (including a newer local checkpoint), changed creation options,
  unseeded creation, or legacy project without a receipt is not an exact retry.
  Open/reconcile the existing cloud project instead; do not silently overwrite it.
- An already-linked local project uses ordinary sync, not the claim path.
- If another writer advances the cloud beyond the captured local history, claiming
  returns `STALE_DOCUMENT` without linking the divergent local copy.
- A claim is a snapshot of the local checkpoint and log captured at its start, not
  a lock on future local editing. No old ghost project is automatically repaired or
  removed, and there is no background retry loop added by this feature.

## Verification and rollout

```sh
npm run test:cloud
npm run typecheck:convex
npm run lint
npm run build
```

`src/cloud/__tests__/snapshot-integrity.integration.test.ts` exercises the actual
Convex functions with `convex-test`, including server writes that commit before the
client loses the response. `snapshot-validation.test.ts` covers the shared decoder's
malformed-input and compatibility boundaries. Existing cloud UI and sync tests remain
part of `test:cloud`.

Deploy **Convex before the frontend**. The only new persistent field for this feature
is optional `projects.creation`; old rows need no migration, and old clients need not
send the retry flag. Older backends do not recognize the new optional argument.
Automated local tests are not evidence of a production deployment or a live
Hexclave-authenticated round trip.
