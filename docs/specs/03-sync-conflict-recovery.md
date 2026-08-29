# Spec 03 — Sync conflict recovery and outbox repair

**Status:** proposed
**Touches:** `src/cloud/outbox.ts`, `src/cloud/projectStore.ts`, `src/cloud/syncReadout.ts`, `src/cloud/VersionHistory.tsx`, `src/cloud/attach.ts`, `src/cloud/runtime.ts`
**Blocks:** [spec 02](02-sharing-roles-invitations.md) — role changes can strand work with no repair path until this ships

---

## 1. Why

`syncReadout.ts:86` tells the user:

> Reconcile the divergence: the local tail is kept and replays onto a fork.

**There is no control that does this.** The machinery exists and is unit-tested —
`executeConflictFork` (`rebase.ts:244`), `resolveDivergence` (`projectStore.ts:884`),
`backfill` (`:837`), `discardHead` (`outbox.ts:400`) — and no `.tsx` file calls any
of them. `resolveDivergence` and `discardHead` have **zero callers anywhere**;
`executeConflictFork` is reached only from inside `resolveDivergence`.

### 1a. "Permanent" does not mean what the code comments imply

The comment at `outbox.ts:333` reads *"The queue stops rather than skipping."* It
does not stop.

- `startAutoDrain(outbox, intervalMs = 2_000)` (`outbox.ts:447`) — and production
  never overrides it. `browserRuntime.ts:98` passes `overrides.autoDrainMs`,
  `undefined` for every real caller, so the 2-second default applies.
- `drain()` nulls `this.draining` in `.finally()`, so every tick is a fresh `runDrain()`.
- The `STALE_DOCUMENT` branch persists, publishes and returns — **never touching
  `nextAttemptAt`**. Its own comment says the entry "stays queued, untouched."
- The permanent branch does the same.
- Only the `TRANSIENT` branch sets `nextAttemptAt = now + backoff`.

`nextAttemptAt` was set to `now()` at enqueue (`:225`), so the skip guard
`entry.nextAttemptAt > this.now()` is never true for a parked head.

**Net effect: the identical doomed request is re-sent every ~2 seconds, forever**,
incrementing `attempts` with no backoff and no change of outcome. Permanent means
*self-identical and non-self-healing*, not *inert*. Any fix must address the retry
storm as well as the missing controls.

> One accidental consequence: `UNAUTHENTICATED` sometimes "recovers" on its own,
> because a later `setIdentity` refreshes the token and the next storm tick
> happens to succeed. That is not a designed path and should not be relied on.

---

## 2. The state machine

### Where `runDrain` stops, and what it leaves behind

| # | Trigger | Published state | Entry mutation | Retries? |
|---|---|---|---|---|
| 1 | Queue empty | `idle` | — | — |
| 2 | Head's `nextAttemptAt` in the future | `offline` | — | after backoff |
| 3 | `STALE_DOCUMENT` | `conflict` + `{headRevision, branchId}` | `attempts++`, `lastError` | **every 2s, forever** |
| 4 | `TRANSIENT` (`OFFLINE`, `TRANSPORT_FAILED`) | `offline` | `attempts++`, `nextAttemptAt = now + backoff` | correctly backed off |
| 5 | **anything else** | `error` | `attempts++`, `lastError` | **every 2s, forever** |
| 6 | Loop exhausted | `idle` | — | — |

`TRANSIENT` is exactly two of fifteen codes (`outbox.ts:110`). Row 5 does not
discriminate at all among `FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `SCHEMA_MISMATCH`,
`UNAUTHENTICATED`, `CHECKSUM_MISMATCH`, `NOT_FOUND`, `INVALID_ARGUMENT`,
`NAME_TAKEN`, `INCOMPLETE_SNAPSHOT` — all produce identical machine state,
distinguishable only by reading `lastError.code` out of band.

### Which recovery applies to which code

| Code | Origin | Correct recovery | Function |
|---|---|---|---|
| `STALE_DOCUMENT` | `convex/transactions.ts:142-153` | Rebase if disjoint, fork if overlapping | **`resolveDivergence`** |
| `FORBIDDEN` | `convex/model/auth.ts:101-108` | A human raises the role, out of band | `discardHead` — the only mechanical fit |
| `PAYLOAD_TOO_LARGE` | `transactions.ts:82-91`, `model/limits.ts:29-55` | The payload must shrink | **none.** `discardHead` unblocks the queue but a later `backfill` re-discovers the same oversized transaction from the intact local log |
| `SCHEMA_MISMATCH` | `transactions.ts:71-78` | Reload so both sides agree — but **no mutation anywhere updates a stored project's `schemaVersion`** | **none** |
| `UNAUTHENTICATED` | `model/auth.ts:46-50` | Re-authenticate and retry the identical send | **none of the four** — needs `setIdentity`, not a rebase |
| `OUTBOX_FULL` | `outbox.ts:203-212` (client-side only) | Clear the head blocker **first**, then `backfill` | `backfill`, but see §3 |

**Two codes have no correct recovery among the four.** That is a gap the spec must
name rather than paper over.

---

## 3. `OUTBOX_FULL` is a symptom, not a cause

The queue can only fill because it is not draining, and it can only not be
draining because its head is parked on one of the other codes. **Calling
`backfill()` while the head is still stuck queues more work behind a head that
still cannot move.** The correct sequence is always: clear the blocker, then
backfill.

### A silent failure worth fixing alongside

Neither `MirroredProjectStore.appendTransaction` (`:757-772`) nor `saveCheckpoint`
(`:774-780`) nor `attach.ts`'s commit relay (`:85-106`) checks the result of
`outbox.queueTransaction`. **An `OUTBOX_FULL` refusal during a live commit is
swallowed** — the caller is told the edit succeeded (the local append did), and
the only trace is the outbox flipping to `status: 'error'` from inside `enqueue`.

---

## 4. Head-of-line blocking, and a misattributed status bar

The outbox is **per-runtime, not per-project**. `browserCloudRuntime()` is a
module-level singleton (`browserRuntime.ts:85-105`), `attachCloudSync` constructs
exactly one `Outbox` (`attach.ts:72-76`), and `entries` is one flat array shared
by every claimed project in the tab.

`runDrain` always inspects `entries[0]` — the *global* head — regardless of which
project it belongs to. So:

- Every other project's queued work is **never attempted**, not even tried and
  rejected, until the head clears.
- New commits to unrelated projects still enqueue, piling up behind the blocker
  and pushing the runtime toward `OUTBOX_FULL`.
- **The status bar lies about which project is broken.** `useSyncReadout`
  (`SyncStatus.tsx:59-69`) scopes only `linked` to the open document; the `sync`
  field is the runtime-wide state. Switch to a healthy Project B and it still
  reads "Conflict" — because that is Project A's stuck head.

---

## 5. Design

### 5.1 Suppress the retry storm

Independent of any UI, and shippable first.

In the `STALE_DOCUMENT` and permanent branches, set
`entry.nextAttemptAt = Number.POSITIVE_INFINITY` (or a `parked: true` flag) so the
existing guard at row 2 short-circuits without a send. Introduce an explicit
`retryHead()` that clears the park, for use after re-auth or an out-of-band fix.

This changes the comment at `:333` from aspiration to fact, and stops an
indefinite stream of identical refused requests at the deployment.

**`reconnected()` must clear the park too** — today its loop only rewrites
`nextAttemptAt` for entries where `nextAttemptAt > at`, which after this change
becomes exactly the parked ones. That is the desired behaviour (a reconnect is new
information), but it must be deliberate rather than incidental.

### 5.2 Expose the error code to the readout

`SyncReadout` does not carry `lastError.code` at all — branch 2b's copy is
identical for every permanent code. Add `code: CloudErrorCode | null` to
`SyncReadout` so a repair control can choose the right function without reaching
past `useSyncReadout` into `snapshot.sync.lastError?.code`.

### 5.3 The repair control

`VersionHistory.tsx` is the natural home: `CloudSyncStatus`'s only affordance
already opens it (`SyncStatus.tsx:19-50`), and `ClaimedHistory` already holds
`store`, `link`, and the `run(work)` busy/notice wrapper (`:186-202`) that
`compare`/`restore`/`saveVersion`/`makeBranch` all use.

It also already renders a conflict banner (`:357-368`) that is **purely
informational** — the place a button belongs.

| State | Control | Calls |
|---|---|---|
| `conflict` | **Reconcile** | `store.resolveDivergence(documentId)` |
| `error` + `FORBIDDEN` | **Discard this change** (confirm) | `outbox.discardHead()` then `drain()` |
| `error` + `PAYLOAD_TOO_LARGE` | **Discard this change** (confirm), with copy saying it will return unless the edit is split | `discardHead()` |
| `error` + `UNAUTHENTICATED` | **Sign in and retry** | re-auth, then `retryHead()` |
| `error` + `SCHEMA_MISMATCH` | Explain and offer reload. **No repair function applies.** | — |
| after any clear | **Backfill** | `store.backfill(documentId)` |

`discardHead` publishes `idle` optimistically without re-draining, so **every
caller must `drain()` immediately** or the UI shows a false healthy state until
the next tick.

### 5.4 Scope the readout to the open project

Fixing §4 properly means per-project queues, which is a larger change. The
minimum honest fix: when the parked head belongs to a different project, the
status bar should say so — *"Sync is blocked by another project"* with the name —
rather than describing the open document as conflicted.

---

## 6. Two bugs found while researching

### 6a. `resolveDivergence`'s conflict-fork branch leaves the outbox dirty

The `rebase` branch calls `outbox.clearProject()` before re-queueing
(`projectStore.ts:924`). **The `conflict-fork` branch does not.** Verified:
`clearProject` has exactly two call sites — `:787` (`deleteProject`) and `:924`
(rebase).

So after a fork resolves, the original `STALE_DOCUMENT`-parked entry is still in
the queue carrying its pre-fork `baseRevision`, even though its content was
already appended to the new branch. `OutboxEntry` has no `branchId` and `send()`
never passes one (`:366-375`), so the next drain resends it to **main**. Convex
idempotency is scoped per branch (`transactions.ts:110-118`), so it is not
deduplicated — it is refused again with `STALE_DOCUMENT`, re-publishing `conflict`
for a conflict that was already fully resolved.

**Status: static analysis, not execution-confirmed.** `rebase.test.ts`'s
conflict-fork test (`:253-304`) never inspects outbox state afterward — unlike the
rebase test, which does (`:237-238`). **Write that assertion first**; it either
confirms the bug or refutes it before any fix is attempted.

### 6b. `backfill` assumes an uncontested head

It reads only the remote `headRevision`, never the remote transactions, and
implicitly assumes the cloud tail is a strict prefix of the local log. If another
member wrote in the meantime, the transactions it queues carry `baseRevision`s
that no longer match, and the next drain answers `STALE_DOCUMENT`.

**`backfill` is not a substitute for `resolveDivergence`.** It is correct only
when this browser had uncontested ownership of the head while the queue was full.
The UI must not offer it as a generic "fix sync" button.

---

## 7. Tests

Every mechanical property is already covered. **What is untested is the seam**
between "the outbox is parked" and "a human triggers a recovery" — because that
seam does not exist yet.

Two existing tests stop exactly one call short:

- `sync.test.ts:218-238` — *"parks a permanently refused entry instead of skipping past it"*. Advances the head out from under two entries, drains, asserts `conflict` with both still queued. Stops there.
- `syncStatus.test.tsx:145-174` — drives a real `PAYLOAD_TOO_LARGE` through an overridden backend and asserts `outbox.pending` still has length 1 ("Parked, never skipped"). Stops there.

**New tests:**

- `does not resend a parked entry on the next tick` — the §5.1 fix; step the injectable clock past several intervals and assert the backend saw one send, not many
- `clears the park on reconnect`
- `resolves a conflict from the version history dialog` — extend `syncStatus.test.tsx`'s conflict setup with a click, assert `idle` and the fork exists
- `re-drains after discardHead rather than reporting idle optimistically`
- `refuses to offer backfill while the head is still parked`
- `leaves no queued entry for the forked project after a conflict-fork resolution` — **§6a; write this first, before any fix**
- `reports which project is blocking when it is not the open one` — §5.4

**Harness:** `sync.test.ts` already demonstrates the injectable clock pattern for
backoff timing (`:89-111`); `syncStatus.test.tsx` demonstrates `overrideBackend`
for forcing a specific error code.

---

## 8. Work breakdown

1. **Write the §6a assertion.** Confirm or refute the conflict-fork outbox bug before designing around it.
2. **Suppress the retry storm** (§5.1). Independent, shippable, and stops an indefinite stream of refused requests today.
3. Check the `queueTransaction` result in `appendTransaction`/`saveCheckpoint` so `OUTBOX_FULL` is not swallowed (§3).
4. Add `code` to `SyncReadout` (§5.2).
5. Repair controls in `VersionHistory` (§5.3), one code at a time — `conflict` first, it is the one the existing copy already promises.
6. Fix §6a if step 1 confirmed it.
7. Scope the readout to the open project (§5.4).
8. Per-project queues — larger, deferred, only if §4 proves painful in practice.

**Steps 2 and 3 are worth shipping on their own** even if the UI work is deferred.

---

## 9. Open questions

1. Should a parked `PAYLOAD_TOO_LARGE` entry be splittable in place rather than only discardable?
2. `SCHEMA_MISMATCH` has no remediation path at all. Does a `schemaVersion` migration mutation belong in this spec or its own?
3. Per-project queues: worth the complexity, or is "name the blocking project" enough?
4. Should `discardHead` require typing the project name, given it is the only irreversible control here?
