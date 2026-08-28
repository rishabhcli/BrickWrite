# Workstream 8 — Cloud projects

Owns `convex/**` and `src/cloud/**`. Published entry point: `src/cloud/index.ts`.

## Shape of the thing

Three planes, and each one owns exactly one thing.

- **Hexclave is the identity plane.** It mints the access token. Ownership and
  membership are keyed on the Hexclave user id — the token's `sub`, exposed by
  Convex as `ctx.auth.getUserIdentity()`. An email address appears in one table,
  `invitations`, because an invitation has to be delivered somewhere. It is
  never an authorisation key and never reaches an audit event.
- **IndexedDB is the durable store.** `src/cad/persistence.ts` is unchanged and
  still authoritative: a transaction is committed to the local log *before* the
  cloud is consulted, so an edit is durable whatever the network is doing.
- **Convex is the data plane.** It holds an outbox-synced replica advanced by
  optimistic concurrency control on the revision. A write whose `baseRevision`
  is not the current head is refused with `STALE_DOCUMENT`. There is no
  last-write-wins path anywhere in this workstream.

Signed-out, offline and unconfigured are first-class states with reasons
attached. In all three the editor works normally against local storage.

## Public exports — `src/cloud/index.ts`

| Group | Exports |
|---|---|
| Integration seam | `attachCloudSync`, `settled`, `AttachCloudSyncOptions`, `CloudSyncHandle` |
| Permissions | `CAPABILITY_MATRIX`, `CAPABILITIES`, `ROLES`, `capabilitiesFor`, `roleAllows`, `roleAtLeast`, `refusalReason`, `isCloudRole`, `Capability`, `CloudRole` |
| Stores | `LocalProjectStore`, `CloudProjectStore`, `MirroredProjectStore`, `ProjectLinks`, `ProjectStore`, `StoredProjectSummary`, `StoredLoadedProject`, `AppendOutcome`, `CheckpointOutcome`, `ProjectLink`, `DivergenceOutcome` |
| Sync | `Outbox`, `startAutoDrain`, `UNCONFIGURED_SYNC_STATE`, `OUTBOX_CAPACITY`, `RETRY_BASE_MS`, `RETRY_CEILING_MS`, `SyncState`, `SyncStatus`, `OutboxEntry`, `OutboxPayload` |
| Divergence | `planRebase`, `executeConflictFork`, `scopeOf`, `overlapOf`, `isDisjoint`, `RebasePlan`, `RebaseInput`, `ConflictFork`, `TouchedScope`, `ScopeOverlap`, `GlobalScope` |
| Claim | `claimLocalProject`, `claimIntegrityReport`, `provenanceOf`, `transactionIds`, `ClaimArgs`, `ClaimOutcome`, `ClaimIntegrityReport` |
| Versions | `diffDocuments`, `compareToVersion`, `restorePlan`, `summariseDiff`, `DocumentDiff`, `CollectionDiff`, `RestorePlan`, `VersionComparison` |
| Comments | `anchorFor`, `resolveAnchor`, `resolveAnchors`, `threadsOf`, `anchorSummary`, `AnchorReport`, `AnchorState`, `CommentThread` |
| Presence | `PresenceSession`, `presenceView`, `PresencePeer`, `PresenceView`, `PresenceSessionOptions` |
| Client | `createConvexCloud`, `convexUrlFromEnv`, `hexclaveTokenSource`, `ConvexCloudBackend`, `ConvexCloudResult`, `ConvexCloudReady`, `ConvexCloudUnconfigured`, `AccessTokenSource`, `ConvexCloudOptions` |
| Serialization | `snapshotUploadFor`, `documentChecksum`, `transactionChecksum`, `poseChecksumOf`, `canonicalJson`, `checksumOf`, `checksumOfText`, `chunkText`, `utf8Bytes` |
| Protocol | `CloudBackend`, `CloudResult`, `CloudErrorShape`, `CloudErrorCode`, every `Cloud*Record` type, the arg types, the limits (`MAX_SNAPSHOT_BYTES`, `MAX_TRANSACTION_BYTES`, `MAX_COMMENT_BYTES`, `SNAPSHOT_CHUNK_BYTES`, `PRESENCE_TTL_MS`) |
| React | `useSyncState`, `useProjectList`, `useAnchorReports`, `ProjectListState` |
| Function refs | `refs` |

**No page UI is exported.** This workstream owns synchronisation and the
collaboration data model; the surfaces that render projects belong to the
workstreams that own those routes.

## Convex schema — `convex/schema.ts`

Ten tables. Every access path used by a query is indexed.

| Table | Purpose | Indexes |
|---|---|---|
| `projects` | Owner (Hexclave subject), name, visibility, `localProjectId`, `defaultBranchId`, `schemaVersion`, `catalogVersion`, soft-delete marker | `by_owner`, `by_owner_local`, `by_visibility` |
| `branches` | `headRevision` (the compare-and-advance target), `baseRevision`, kind, optional merge proposal | `by_project`, `by_project_name` |
| `transactions` | The log: payload, checksum, bytes, base/result revision, author subject | `by_client_txn` (project + branch + client id), `by_branch_revision`, `by_project_revision` |
| `snapshots` | Checkpoint and version documents, chunked below the 1 MiB document cap | `by_group`, `by_project_kind_revision`, `by_project_revision` |
| `versions` | Immutable labelled points, pointing at a snapshot group | `by_project_created`, `by_project_revision`, `by_project_label` |
| `members` | Subject → role. The only authorisation source | `by_project`, `by_project_subject`, `by_subject` |
| `invitations` | Email, token, status, delivery status and reason | `by_project`, `by_token`, `by_email_status` |
| `presence` | Ephemeral cursors, selection, follow target, expiry | `by_project_expiry`, `by_project_session`, `by_project_subject` |
| `comments` | Body plus a `{partId, revision, poseChecksum}` anchor | `by_project_created`, `by_project_status`, `by_project_anchor` |
| `auditEvents` | Action, actor subject, timestamp, redacted scalar detail | `by_project_at`, `by_actor_at` |

`schemaVersion` and `catalogVersion` are stored on `projects`, `transactions`
and `snapshots`, so a replica written by a build with a different catalogue is
readable and identifiable as such.

## Convex functions

Every public function resolves identity from `ctx.auth.getUserIdentity()` and
authorises against the `members` table via `convex/model/auth.ts`. None of them
accepts a subject, an owner or a role as an argument.

```
projects:list              query      projects this identity is a member of
projects:get               query      one summary, including the caller's own role
projects:branches          query      branches of a project
projects:create            mutation   project + main branch + owner membership, atomically
projects:rename            mutation
projects:setVisibility     mutation   private | unlisted | public
projects:remove            mutation   soft delete
projects:saveCheckpoint    mutation   chunked snapshot write
projects:latestCheckpoint  query      newest checkpoint at or below a revision, branch-scoped
projects:auditTrail        query      owner-only

transactions:append          mutation  THE critical mutation — see below
transactions:listSince       query     ordered log after a revision
transactions:findByClientId  query     reconcile one outbox entry

versions:create         mutation   immutable version + snapshot group
versions:list           query
versions:document       query      reassembles the pinned document
versions:createBranch   mutation   optional `atRevision` for a conflict fork
versions:proposeMerge   mutation   editor may propose
versions:decideMerge    mutation   owner may land; author may withdraw

members:capabilities  query     the matrix, for an accurate role picker
members:list          query
members:myRole        query
members:setRole       mutation  owner-only; the owner cannot be demoted
members:remove        mutation  leaving is always allowed

invitations:list             query           gated on `member.invite` — it carries emails
invitations:create           mutation        schedules delivery
invitations:revoke           mutation
invitations:accept           mutation        by token, redeemed by the invitee's own identity
invitations:deliveryContext  internalQuery   email + token; no public URL
invitations:markDelivery     internalMutation
invitations:deliver          internalAction  the only place an email is sent

comments:list       query
comments:forPart    query
comments:add        mutation
comments:setStatus  mutation

presence:heartbeat  mutation   touches the `presence` table and nothing else
presence:list       query      expired rows are not returned
presence:leave      mutation
```

### `transactions:append`

One Convex mutation, which Convex runs serializably, doing all of this
atomically:

1. authorise the caller for `transaction.write`;
2. reject a missing client id, a revision that does not advance by exactly one,
   a document-schema mismatch, an oversized payload, or a checksum that does not
   match the payload;
3. resolve the branch;
4. **idempotency** — if `(projectId, branchId, clientTransactionId)` is already
   stored with the same checksum, return the original outcome with
   `applied: false`. The same id with *different* content is refused as
   `INVALID_ARGUMENT`: that is two edits claiming one identity, not a retry;
5. **compare-and-advance** — if `branch.headRevision !== baseRevision`, refuse
   with `STALE_DOCUMENT` and hand back the head to rebase onto;
6. insert the transaction, advance the head, write a redacted audit event.

Idempotency is checked before the head comparison on purpose: a retry of an
already-applied transaction is stale by definition, and answering
`STALE_DOCUMENT` would send the client rebasing work the server already has.

## Required integration edits

I do not own `src/cad/session.ts` or `src/cad/persistence.ts`. The cloud layer
wraps them from outside and needs exactly one thing from them: the
`StorageDriver`. The outbox and the project links live in the existing `meta`
object store, so **no IndexedDB schema change is needed** — `TABLES` already
contains `meta`, and `IndexedDbDriver` already creates it. Nothing about the
local-first behaviour changes: `ProjectAutosave` remains the only writer of the
local checkpoint and log.

**Status: applied.** As of this pass the change is present in the tree —
`src/cad/persistence.ts` exports `createDriver()` and `Session` exposes
`readonly driver`. The diff is kept below as the record of exactly what the
cloud layer needs from the kernel; if either file is ever reverted, this is what
has to go back. Confirm in one line:

```
grep -n 'export const createDriver' src/cad/persistence.ts
grep -n 'readonly driver: StorageDriver' src/cad/session.ts
```

Verified two ways: `git apply --check` against the pre-patch tree, and a
typecheck of the wiring snippet below against the real `src/cad/session.ts`,
`src/cad/engine.ts` and `src/hexclave/client.ts` — it compiles with no errors.

```diff
--- a/src/cad/persistence.ts
+++ b/src/cad/persistence.ts
@@ -333,5 +333,15 @@
   }
 }
 
-export const createRepository = () =>
-  new ProjectRepository(indexedDbAvailable() ? new IndexedDbDriver() : new MemoryDriver())
+/**
+ * The storage driver this environment can back.
+ *
+ * Split out of `createRepository` because the cloud layer keeps its sync queue
+ * and its project links in the same `meta` object store, and two IndexedDB
+ * connections to one database is a race nobody needs.
+ */
+export const createDriver = (): StorageDriver =>
+  indexedDbAvailable() ? new IndexedDbDriver() : new MemoryDriver()
+
+export const createRepository = (driver: StorageDriver = createDriver()) =>
+  new ProjectRepository(driver)
--- a/src/cad/session.ts
+++ b/src/cad/session.ts
@@ -1,11 +1,13 @@
 import { catalog } from './catalog'
 import { cadEngine } from './engine'
 import {
+  createDriver,
   createRepository,
   indexedDbAvailable,
   ProjectAutosave,
   type ProjectRepository,
   type ProjectSummary,
+  type StorageDriver,
 } from './persistence'
 import { createBlankDocument } from './sample'
 import { loadLocalDocument, clearLocalDocument } from './storage'
@@ -44,7 +46,9 @@
 }
 
 class Session {
-  private repository: ProjectRepository = createRepository()
+  /** Shared with `src/cloud`, which keeps its sync queue in the same store. */
+  readonly driver: StorageDriver = createDriver()
+  private repository: ProjectRepository = createRepository(this.driver)
   private autosave = new ProjectAutosave(this.repository)
   private restore: SessionRestore | null = null
   private detach: (() => void) | null = null
```

That is the whole required change: `createRepository()` keeps working for every
existing caller, and `session.driver` becomes readable.

### Wiring it up

Nothing else in the kernel changes. `attachCloudSync` subscribes to
`cadEngine.onCommit` alongside the session's own listener and **only queues** —
`ProjectAutosave` still owns every local write, so there is no second writer on
the log. In `src/main.tsx` or wherever the shell boots:

```ts
import { cadEngine } from './cad/engine'
import { session } from './cad/session'
import { attachCloudSync, createConvexCloud, hexclaveTokenSource } from './cloud'
import { getHexclaveClientApp } from './hexclave/client'

const account = getHexclaveClientApp()
const cloud = createConvexCloud({
  tokenSource: account.status === 'ok' ? hexclaveTokenSource(account.data) : undefined,
})

// `unconfigured` is a supported way to run: local projects keep working.
export const cloudSync =
  cloud.status === 'ready'
    ? attachCloudSync({ driver: session.driver, backend: cloud.backend, onCommit: cadEngine.onCommit })
    : null
```

`useSyncState(cloudSync?.store ?? null)` returns `UNCONFIGURED_SYNC_STATE` when
that is null, so a status line needs no special case.

`hexclaveTokenSource` is structurally typed against `{ getAccessToken(): Promise<string | null> }`,
so `src/cloud` never imports `src/hexclave` and the two can move independently.

### Required tsconfig change

`convex/**` is not compiled by `tsconfig.app.json` or `tsconfig.node.json`, and
it must not be: those modules run in the Convex runtime, not in the browser and
not in Node. `convex/tsconfig.json` (checked in, and the file `npx convex dev`
uses) is their project. To have CI typecheck it, add a script — do **not** add
`convex` as a project reference, because project references require
`composite: true`, which conflicts with the `noEmit: true` Convex's config sets:

```diff
--- a/package.json
+++ b/package.json
   "scripts": {
+    "typecheck:convex": "tsc -p convex/tsconfig.json",
-    "check": "npm run test && npm run build",
+    "check": "npm run test && npm run typecheck:convex && npm run build",
```

`src/cloud/**` needs no tsconfig change: it lives under `src` and is already
covered. It reaches into `convex/model/*` for the five dependency-free modules
that must not be duplicated — the capability matrix, the wire protocol, the
checksum algorithm, the payload limits and the audit redaction filter. Those
files import nothing from `convex/server`, so nothing server-side is dragged
into the browser bundle.

## Environment variables

### Browser (Vite, `VITE_` prefix — these are public)

| Variable | Required | Effect when unset |
|---|---|---|
| `VITE_CONVEX_URL` | for cloud features | `createConvexCloud()` returns `{status:'unconfigured', reason}`. The editor runs local-only. Nothing throws. |

`HEXCLAVE_PROJECT_ID` is already injected by `hexclave dev` (see the `dev`
script) and is consumed by `src/hexclave/client.ts`, not by this workstream.

### Convex deployment (`npx convex env set …` — never checked in)

| Variable | Required | Effect when unset |
|---|---|---|
| `HEXCLAVE_JWKS_ISSUER` | yes | `convex/auth.config.ts` trusts no issuer, so every function answers `UNAUTHENTICATED`. A closed door, not an open one. |
| `HEXCLAVE_PROJECT_ID` | yes | as above — it is the token audience |
| `INVITATION_EMAIL_ENDPOINT` | for invitation email | invitations are stored with `deliveryStatus: 'not-configured'` and a reason naming the missing variables. Nothing reports a send that did not happen. |
| `INVITATION_EMAIL_TOKEN` | for invitation email | as above |
| `INVITATION_LINK_ORIGIN` | for invitation email | as above |

The delivery contract is an outbound `POST` from the `invitations:deliver`
internal action, with `Authorization: Bearer $INVITATION_EMAIL_TOKEN` and body
`{ to, subject, projectName, role, invitationUrl }`. Point it at the Hexclave
emails app or any transactional provider. It is an internal action, so it has no
public URL and the credential never enters the browser bundle.

## Deployment steps — a human has to run these

1. **Log in and create the deployment.**
   ```
   npx convex login
   npx convex dev            # provisions a dev deployment and watches convex/
   ```
   This overwrites `convex/_generated/{api,dataModel,server}.ts` with real
   codegen. The hand-written stand-ins are shaped exactly like the generated
   files, so nothing downstream changes. Once codegen has run, the client can
   optionally be switched off `src/cloud/functionRefs.ts` and onto the generated
   `api` object — see the note at the top of that file.

2. **Point the browser at it.** `npx convex dev` writes `CONVEX_URL` to
   `.env.local`; add the Vite-visible copy:
   ```
   VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
   ```

3. **Configure Hexclave → Convex auth.** Read the issuer and audience off the
   running Hexclave project (`hexclave dev` prints the project id; the issuer is
   the base URL its access tokens carry in `iss`, and its JWKS lives at
   `<issuer>/.well-known/jwks.json`). Then:
   ```
   npx convex env set HEXCLAVE_JWKS_ISSUER https://<issuer>
   npx convex env set HEXCLAVE_PROJECT_ID  <hexclave-project-id>
   ```
   Verify with a signed-in browser: `projects:list` must return `ok: true` with
   an empty array, not `UNAUTHENTICATED`.

4. **Optionally configure invitation email.**
   ```
   npx convex env set INVITATION_EMAIL_ENDPOINT https://…
   npx convex env set INVITATION_EMAIL_TOKEN    …
   npx convex env set INVITATION_LINK_ORIGIN    https://…
   ```

5. **Apply the integration diff above** and wire `attachCloudSync` into the
   shell.

6. **Production.** `npx convex deploy`, then set the same deployment variables
   on the production deployment and `VITE_CONVEX_URL` in the hosting
   environment.

## NOT_COMPLETE — live deployment

**No Convex account is logged in on this machine, so no live deployment was
ever exercised.** `npx convex dev`, `npx convex codegen` and `npx convex deploy`
have not been run; no schema has been pushed; no function has been executed by
the Convex runtime; no Hexclave token has been validated by Convex. Steps 1–4
above are unperformed, and this workstream is **NOT_COMPLETE** until somebody
with credentials runs them.

What *is* proven, locally and reproducibly:

- `convex/**` typechecks under the same `convex/tsconfig.json` the Convex CLI
  uses (`npx tsc -p convex/tsconfig.json`), including the schema, the generated
  shims and every function module.
- The full acceptance suite runs against `src/cloud/__tests__/fakeBackend.ts`,
  an in-process implementation of the same mutation semantics — it shares the
  deployment's own capability matrix, wire protocol, payload limits, snapshot
  validation, checksum algorithm and audit redaction filter, and reproduces the
  handlers' check order. It is a faithful double of the backend; **it is not the
  backend.** Nothing here demonstrates that Convex's own serializable execution,
  index behaviour, argument validators or auth verification work as assumed.

## Acceptance gates and where they are proven

| Gate | File |
|---|---|
| Cross-account denial on every function | `src/cloud/__tests__/authorisation.test.ts` |
| Capability matrix, every role × every mutation | `src/cloud/__tests__/authorisation.test.ts` |
| Concurrency: one success, one `STALE_DOCUMENT` | `src/cloud/__tests__/concurrency.test.ts` |
| Idempotent replay | `src/cloud/__tests__/concurrency.test.ts` |
| Offline survives reload, reconciles losslessly | `src/cloud/__tests__/sync.test.ts` |
| Local-only path never throws, state `unconfigured` | `src/cloud/__tests__/sync.test.ts` |
| Disjoint auto-rebase / overlapping conflict fork | `src/cloud/__tests__/rebase.test.ts` |
| Lossless claim | `src/cloud/__tests__/claim.test.ts` |
| Version immutability | `src/cloud/__tests__/collaboration.test.ts` |
| Presence never document truth | `src/cloud/__tests__/collaboration.test.ts` |
| Comment anchoring across revisions | `src/cloud/__tests__/collaboration.test.ts` |
| Payload ceilings | `src/cloud/__tests__/limits.test.ts` |
| Audit redaction | `src/cloud/__tests__/limits.test.ts` |
| Integration seam queues without writing the local log | `src/cloud/__tests__/attach.test.ts` |
| Published surface matches this document | `src/cloud/__tests__/entrypoint.test.ts` |

## Design decisions worth knowing

- **A non-member of a private project gets `NOT_FOUND`, not `FORBIDDEN`.**
  `FORBIDDEN` would confirm the project exists. Members who merely lack a
  capability do get `FORBIDDEN`, because for them that is not a secret.
- **Outbox backpressure refuses the newest entry, never drops the oldest.**
  Ordering is load-bearing — every later entry builds on the earlier one's
  revision. Refusing is safe because the local log is complete: `backfill()`
  re-derives whatever the cloud is missing.
- **A permanently refused entry parks the queue rather than being skipped.**
  Skipping would produce a replica silently missing a transaction the local log
  still has. `discardHead()` is the explicit way past it.
- **Rebase only when provably disjoint.** `patch.touched` covers parts and
  subassemblies; the scope check extends it with connection ids and the
  whole-document collections (`steps`, `notes`, `constraints`, `modules`, the
  document name) read off `patch.forward`. Two part *additions* therefore count
  as overlapping, because both rewrite the step list.
- **A conflict fork branches at the divergence revision** and is seeded with a
  checkpoint of the document as it was there, so the losing tail replays
  unchanged — same ids, same revisions, same order. Nothing is renumbered to
  make it fit, and `main` is untouched.
- **Idempotency is scoped to the branch**, which is what lets a conflict fork
  keep the same transaction ids without the deployment mistaking the replay for
  a retry.
- **Deletion is a soft delete.** An owner deleting a shared project removes
  everybody else's access to work they contributed to; that has to be
  recoverable by a human on the deployment.
