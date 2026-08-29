# Cloud, collaboration and data

Ten findings, weighted toward anything that can lose or strand a user's work.

The pattern across this whole layer: **the backend is built and tested; the UI
that would reach it does not exist.** Conflict recovery, presence, sharing,
roles and invitations are all implemented server-side with passing tests and
zero call sites in any `.tsx` file.

> ### Correction, added after deeper research
>
> The root cause is narrower and more fixable than these ten findings imply.
> **`src/App.tsx` mounts no cloud contribution at all** — its `CONTRIBUTIONS`
> array is `[AgentWorkbenchContribution, GeneratePanelContribution,
> RefinePanelContribution]`, with zero occurrences of "cloud" in the file.
> `CloudProjectsContribution` is exported from `src/cloud/index.ts`, exercised by
> `src/cloud/__tests__/contributions.test.tsx`, and referenced by **nothing
> outside `src/cloud/`**.
>
> So it is not only sharing and presence that have no UI. The sync-status
> indicator, the cloud projects panel and version history are all built,
> registered and tested — and none of them is reachable by opening the
> application. `src/cloud/index.ts:192-204` even documents the intended wiring
> ("so `src/App.tsx` lists `CloudProjectsContribution` and nothing else in the
> editor changes"); that line was never added.
>
> Adding it is one line, and it is the precondition for findings 1, 8, 9 and 10.
> See [specs/02-sharing-roles-invitations.md](../specs/02-sharing-roles-invitations.md).

**Verified by hand:** zero `.tsx` callers of `executeConflictFork`,
`resolveDivergence`, `backfill` or `discardHead`. Zero `.tsx` callers of
`listMembers`, `setMemberRole` or `createInvitation`.

---

## 1. Wire the conflict recovery path into the running app

**Evidence:** `src/cloud/rebase.ts:244` (`executeConflictFork`), `src/cloud/projectStore.ts:884` (`resolveDivergence`), `:837` (`backfill`) and `src/cloud/outbox.ts:408` (`discardHead`) are implemented and unit-tested. **No UI reaches any of them.** `executeConflictFork` is called from exactly one place — inside `resolveDivergence` — and `resolveDivergence` has no callers at all, so the chain terminates before anything can start it. `src/cloud/attach.ts:32-57` exposes only `claim`, `listProjects`, `reconnected`, `flush`, `detach`.
Meanwhile `src/cloud/outbox.ts:277-339` drains one **global** FIFO shared by every local project (`attach.ts:75`), and on `STALE_DOCUMENT` (`:304`), any permanent error (`FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `SCHEMA_MISMATCH`, `UNAUTHENTICATED` — none in the `TRANSIENT` set at `:110`), or `OUTBOX_FULL` (capacity 500, `:101`), it stops and returns. Nothing ever resumes it, not even on re-sign-in (`runtime.ts:265-272` never re-drains). `syncReadout.ts:86` tells the user "Reconcile the divergence: the local tail is kept and replays onto a fork" — **a repair instruction with no corresponding control.**
**Why it matters:** The one write path this workstream is built around has no way to resolve its own designed failure mode. The first conflict, oversized checkpoint, expired token or full queue on **any** project halts sync for **every** local project in that browser. Local IndexedDB stays intact, but the cloud replica never catches up again.

> **Correction.** I first wrote that the queue halts "silently" and that "nothing
> ever resumes it." The second half is wrong, in a direction that makes this
> worse. `startAutoDrain` re-enters every **2 seconds** (`outbox.ts:447`, and
> production never overrides the default), and neither the `STALE_DOCUMENT`
> branch nor the permanent branch ever pushes `nextAttemptAt` forward — only the
> `TRANSIENT` branch does. Since `nextAttemptAt` was set to `now()` at enqueue,
> the skip guard never fires. **The identical refused request is re-sent to the
> deployment every ~2 seconds indefinitely**, incrementing `attempts` with no
> backoff. "Permanent" means self-identical and non-self-healing, not inert. See
> [specs/03-sync-conflict-recovery.md](../specs/03-sync-conflict-recovery.md) §1a.
**Change:** Add a Resolve action in the sync-status/version-history UI calling `resolveDivergence`; call `discardHead` with confirmation for permanently refused entries; call `backfill` on reconnect and identity change; consider per-project queues so one stuck project cannot block the rest.
**Effort:** M    **Risk:** Touches the core sync state machine; must not regress OCC or idempotency (existing `concurrency.test.ts` / `rebase.test.ts` scaffolding helps).

## 2. Make claiming a project resumable after a partial failure

**Evidence:** `src/cloud/claim.ts:70-95` uploads the local transaction log one `appendTransaction` round trip at a time and "stops at the first refusal" (`:83`). `convex/projects.ts:122-136` refuses a second `create` for the same `(ownerSubject, localProjectId)` with `NAME_TAKEN`, and no path detects a partial project and resumes into it. `src/cloud/projectStore.ts:806-827` writes the local `link` record only `if (claimed.ok)` — so a partial failure leaves the browser with **no memory** that a half-uploaded cloud project exists. `claim.test.ts:159-169` tests only "claiming twice after success is refused"; retry-after-partial-failure is untested.
**Why it matters:** A large model's history is thousands of sequential calls. Any transient failure partway leaves an orphaned incomplete cloud project the browser does not know about, and **every retry dead-ends on `NAME_TAKEN` forever.** That project can never be saved to the cloud through the product again — only someone with Convex dashboard access could clear it.
**Change:** Have `projects.create` return the existing partial project for the same `localProjectId`, and have `claimLocalProject` resume from `existing.headRevision`; batch multiple transactions per mutation to cut round trips.
**Effort:** M    **Risk:** Changes `create`'s atomicity contract; preserve idempotency-by-`clientTransactionId` when resuming.

## 3. Build a migration path before the next document-schema change

**Evidence:** `project.schemaVersion` is set once at creation (`convex/projects.ts:145`) and patched nowhere. `convex/transactions.ts:71-78` permanently refuses any append whose `schemaVersion` differs — and `SCHEMA_MISMATCH` is not in the outbox's `TRANSIENT` set, so it parks the queue exactly as finding 1 describes. `src/cad/session.ts:147` hardcodes `document.schemaVersion !== 2`. The only migration code, `src/cad/storage.ts:34-53` (1→2), is scoped to the old single-document `localStorage` format and is never invoked by `src/cad/persistence.ts` — the multi-project IndexedDB repository the cloud mirrors has no migration mechanism at all.
**Why it matters:** The schema has already changed once. Next time, nothing can upgrade a stored cloud project's payloads and nothing bumps `schemaVersion`, so **every existing cloud project is stranded at schema 2 the moment a schema-3 client ships**, and any user with a queued edit gets their whole outbox parked with no self-service way out.
**Change:** A Convex-side migration runner that rewrites `transactions`/`snapshots` payloads and bumps `schemaVersion`, plus migrate-on-load in `persistence.ts`.
**Effort:** L    **Risk:** Touches every stored document; a wrong migration is itself a data-loss vector.

## 4. Chunk snapshot uploads by byte length, not character count

**Evidence:** `convex/model/checksum.ts:93-109` slices at `cursor + chunkSize` using **UTF-16 code units** (its own surrogate-pair check at `:100-101` confirms), called as `chunkText(text, SNAPSHOT_CHUNK_BYTES)` (`src/cloud/serialize.ts:33`) with `SNAPSHOT_CHUNK_BYTES = 400_000` — a name promising bytes. The server then validates **actual UTF-8 byte length** against `MAX_CHUNK_BYTES = 800_000` (`convex/model/limits.ts:20,48`). 400,000 code units of Cyrillic, Hebrew, Arabic or CJK measures 800,000–1,200,000 bytes — at or over the cap. `limits.test.ts` uses only `'x'.repeat(...)`; **no multi-byte character appears in any payload test.**
**Why it matters:** A project whose notes or names contain substantial non-Latin text gets a spurious permanent `PAYLOAD_TOO_LARGE` while well under the real 8 MiB ceiling — and per finding 1 that is a permanent-class outbox error, jamming that project's and every other project's sync.
**Change:** Cut chunks by measured UTF-8 byte length (or raise the multiplier to ≥4× and rename the constant honestly); add a CJK/emoji fixture to the limits tests.
**Effort:** S    **Risk:** Self-contained, but changes chunk boundaries for anything near the edge.

## 5. Seed a checkpoint for every new branch, and scope `latestCheckpoint` to it

**Evidence:** `convex/schema.ts:152-154`'s snapshot index is `['projectId','kind','revision']` — **not branch-scoped**. `convex/projects.ts:307-334` takes 256 rows across the whole project (`:324`) then filters client-side for `branchId` (`:328-330`); with enough chunks ahead of it the scan exhausts its budget and wrongly returns "no checkpoint". Separately `convex/versions.ts:131-198` (`createBranch`) never calls `writeSnapshot` — only `executeConflictFork` seeds one. The "Make branch" button in `VersionHistory.tsx` produces exactly this unseeded kind.
**Why it matters:** `loadProject` (`projectStore.ts:421-429`) returns `null` when `latestCheckpoint` finds nothing, indistinguishable from "empty project". **Every named branch created through the shipped button is permanently unopenable** — there is no fallback to the parent's checkpoint.
**Change:** Add `branchId` to the index so the query is exact, and have `createBranch` seed a checkpoint from the parent at the fork revision as conflict forks already do.
**Effort:** M    **Risk:** Index addition needs a schema migration; seeding adds a bounded write per branch creation.

## 6. Bound and paginate the list queries

**Evidence:** `convex/versions.ts:107`, `comments.ts:43,47,66`, `projects.ts:98`, `invitations.ts:47` all `.collect()` with no cap — contrast `transactions.ts:219` (capped) and `projects.ts:345` (capped). No retention or purge exists; there is no `crons.ts` under `convex/`.
**Why it matters:** These are the tables that grow unboundedly over a project's life — review comments, pinned versions, and (per finding 2's orphaned retries) accumulating conflict branches. Past Convex's read ceiling `.collect()` **throws rather than truncating**, so version history goes from slow to completely broken for exactly the long-lived collaborative projects the feature exists to serve.
**Change:** `.take()` with a sane default plus cursor pagination, updating callers in lockstep.
**Effort:** S/M    **Risk:** Callers assume complete lists; partial data shown as complete is worse than an error.

## 7. Give owners a real export and a real permanent delete

**Evidence:** `convex/projects.ts:249-265` is a **soft delete only** (`deletedAt`), by design (`schema.ts:51-52`), with no scheduled purge and no hard-delete mutation. There is no export mutation anywhere in `convex/**` or `src/cloud/**`. `ProjectsPanel.tsx:213-238` only pulls the current snapshot back into the same app's IndexedDB — no comments, versions, branch history or audit trail, and no portable file.
**Why it matters:** A user closing their account cannot get their data out in one action, and cannot make deletion final. Soft-deleted content — **including free-text comment bodies** — lives in Convex indefinitely, retrievable by anyone with dashboard access.
**Change:** A project-level export bundling document, versions, comments and audit trail; plus an explicit confirmed hard-delete distinct from the soft delete.
**Effort:** L    **Risk:** Hard delete removes the recoverable-by-an-admin safety net; needs a grace period so it is not itself a new way to lose work.

## 8. Ship the presence UI the backend already supports

**Evidence:** `convex/presence.ts` and `src/cloud/presence.ts` (`PresenceSession`, `presenceView`, follow-mode, behind/ahead indicators) are fully implemented and tested. Grepping all of `src/**` outside the cloud module and its tests for presence returns **nothing**. `src/cloud/contributions.tsx:29-35` mounts three surfaces — sync status, projects panel, version history — and no presence contribution exists.
**Why it matters:** Two people editing the same project have **zero visibility into each other**: no cursors, no selection highlighting, no "who's here", no follow mode — despite all of it being built and tested. Combined with finding 1, simultaneous editing is both invisible and, when it collides, silently stuck.
**Change:** Add a presence contribution — avatar stack plus live cursors and selection in the viewport — instantiating `PresenceSession` and rendering `presenceView()`.
**Effort:** L    **Risk:** Mostly additive; watch heartbeat/render frequency, already rate-limited by `PRESENCE_TTL_MS`.

> Pair with `04-security.md` finding 7 before shipping this: `presence.publish`
> and `member.list` are currently granted to the implicit `viewer` role on public
> projects, so a presence UI would broadcast collaborators' cursors and the team
> roster to any signed-in stranger.

## 9. Build the sharing, roles and invitation UI

**Evidence:** `convex/members.ts` and `convex/invitations.ts` fully implement listing, role changes, removal, invite create/revoke/accept and email delivery; `src/cloud/protocol.ts:142-177` and `projectStore.ts:1002-1036` plumb all of it to the client. `convex/projects.ts:222-240` (`setVisibility`) has no caller. **Zero `.tsx` files call `listMembers`, `setMemberRole`, `removeMember`, `listInvitations`, `createInvitation` or `revokeInvitation`.**
**Why it matters:** A project can be created and synced but **can never actually be shared with anyone** through the shipped product: no invite dialog, no member list, no role picker, no visibility toggle. Every role mechanism this workstream built — owner, editor, commenter, viewer — is unreachable.
**Change:** A members/sharing panel (invite by email, role picker, remove, revoke) plus a visibility toggle, backed by the existing tested functions.
**Effort:** L    **Risk:** Low functionally — the server enforces capabilities regardless; the risk is under-gating so a low-role user sees controls that then fail (see finding 10).

## 10. Enforce the client capability mirror in the UI

**Evidence:** `src/cloud/permissions.ts` exists specifically so "the client… can render an accurate role picker" and grey out actions in advance (its own docstring `:17-22`), but grepping `src/cloud/*.tsx` and `src/features/projects/*.tsx` for `refusalReason`, `roleAtLeast` or `capabilitiesFor` returns **nothing**. `VersionHistory.tsx`'s Save/Branch/Restore and `ProjectsPanel.tsx`'s Delete/Rename never read `myRole`.
**Why it matters:** Every collaborator sees fully-enabled controls regardless of role and discovers the restriction only after a round trip ending in a generic error. Worse, per finding 1 that `FORBIDDEN` is a permanent-class outbox error — **so a viewer who is merely allowed to *try* an edit can jam their own and everyone else's sync.**
**Change:** Fetch `myRole` in these panels and use `refusalReason`/`roleAllows` to disable controls, surfacing the reason as a tooltip.
**Effort:** S    **Risk:** Purely presentational; keep it in sync with `CAPABILITY_MATRIX`.
