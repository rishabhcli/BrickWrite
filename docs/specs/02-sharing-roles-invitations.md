# Spec 02 — Sharing, roles and invitations

**Status:** proposed
**Touches:** `src/App.tsx` (one line), `src/cloud/contributions.tsx`, `src/cloud/projectStore.ts`, `src/cloud/protocol.ts`, a new `src/cloud/MembersPanel.tsx`, `src/cloud/cloud.css`, `src/cloud/__tests__/fakeBackend.ts`
**Depends on:** nothing. Every Convex function this needs already exists and is tested.

> **Naming.** This codebase has two unrelated things called "share".
> `src/features/share/**` is public *publication* — immutable snapshots, unlisted
> links, OG cards. This spec is about **collaborator roles on a live, editable
> project** and touches none of it.

---

## 1. Why

A project can be created and synced, but **cannot be shared with anyone through
the product.** No invite dialog, no member list, no role picker, no visibility
toggle. Verified: zero `.tsx` callers of `listMembers`, `setMemberRole`,
`removeMember`, `listInvitations`, `createInvitation`, `revokeInvitation`.

Every role mechanism the workstream built — owner, editor, commenter, viewer,
across 18 capabilities — is unreachable.

### 1a. The precondition nobody has noticed

**`src/App.tsx` mounts no cloud contribution at all.**

```ts
const CONTRIBUTIONS = [AgentWorkbenchContribution, GeneratePanelContribution, RefinePanelContribution]
```

Zero occurrences of "cloud" in the file. `CloudProjectsContribution` is exported
from `src/cloud/index.ts:199-204`, exercised by
`src/cloud/__tests__/contributions.test.tsx`, and referenced by nothing outside
`src/cloud/`.

So the sync-status indicator, the cloud projects panel and version history are
**also** unreachable — not just sharing. `src/cloud/index.ts:192-204` documents
the intended wiring in prose:

> so `src/App.tsx` lists `CloudProjectsContribution` and nothing else in the
> editor changes

That line was never added. **Adding it is step 1, it is one line, and it lights
up three finished surfaces before this spec's own work begins.**

---

## 2. Backend surface (exists, tested, unchanged by this spec)

### `convex/members.ts`

| Function | Args | Capability | Returns |
|---|---|---|---|
| `capabilities` | — | none | the whole `CAPABILITY_MATRIX` |
| `list` | `{ projectId }` | `member.list` — **every role** | `CloudResult<CloudMemberRecord[]>`, unbounded |
| `setRole` | `{ projectId, subject, role }` | `member.setRole` — owner only | `CloudResult<CloudMemberRecord>` |
| `remove` | `{ projectId, subject }` | **conditional** — see below | `CloudResult<{ removed: boolean }>` |
| `myRole` | `{ projectId }` | signed-in only | `CloudResult<CloudRole \| null>` |

`role` is `assignableRole = 'editor' | 'commenter' | 'viewer'`. **Owner is not
assignable and there is no ownership-transfer mutation anywhere in `convex/`.**

`remove` is deliberately not gated on one fixed capability
(`convex/members.ts:81-87`): leaving is always permitted, so self-removal
authorises against `project.read` while removing someone else needs
`member.remove`. It also deletes the target's `presence` rows in the same
mutation (`:118-126`), so a removed collaborator's cursor disappears immediately
rather than at heartbeat expiry.

### `convex/invitations.ts`

| Function | Args | Capability | Notes |
|---|---|---|---|
| `list` | `{ projectId }` | **`member.invite`, not `member.list`** | The invitee list is the one view containing email addresses (`:40-41`) |
| `create` | `{ projectId, email, role }` | `member.invite` | Validates shape, refuses duplicate *pending* invites with `NAME_TAKEN` |
| `revoke` | `{ projectId, invitationId }` | `member.invite` | Idempotent: already-resolved → `{ revoked: false }`, not an error |
| `accept` | `{ token }` | **none** — caller isn't a member yet | Only mutation here that takes no `projectId` |

`INVITATION_TTL_MS` is 14 days. Audit events record `{ role }` only — the address
is stripped by the redactor (`:98-99`), so the trail records *that* someone was
invited, never who.

### `convex/projects.ts` — `setVisibility`

Gated on **`project.delete`**, not a visibility capability (`:222-240`):
publishing is an ownership decision of the same irreversible class. Practically:
the same `refusalReason(role, 'project.delete')` string serves both the delete
button and the visibility toggle.

### Capability matrix, sharing rows only

```
owner      all 18 capabilities
editor     member.list          (no invite / setRole / remove / audit.read)
commenter  member.list
viewer     member.list
```

---

## 3. Client plumbing — what exists, and two real gaps

### Exists

`CloudBackend` (`src/cloud/protocol.ts:141-165`) declares all eight methods, and
both implementations are complete: `ConvexCloudBackend`
(`src/cloud/convexClient.ts:308-348`) and `FakeConvexBackend`. A panel can call
`snapshot.backend.*` directly, exactly as `ProjectsPanel.tsx:216` already does
for `getProject`.

`src/cloud/permissions.ts` is the capability mirror, built for precisely this
UI — its docstring says so at `:17-22`. **No `.tsx` file has ever called it.**
This panel would be its first consumer.

### Gap A — `ProjectStore` has no invitation methods

`ProjectStore` declares only the three members methods. Verified: zero
occurrences of `listInvitations`, `createInvitation`, `revokeInvitation` or
`myRole` anywhere in `projectStore.ts`'s 1,038 lines.

Two options, both consistent with existing code:

1. **Add them**, mirroring the members trio exactly — `localOnly('Invitations')`
   stub in `LocalProjectStore`, `resolveId` pass-through in `CloudProjectStore`,
   `cloudDelegate` wrapper in `MirroredProjectStore`. Keeps invitations
   symmetrical with members inside the abstraction.
2. **Bypass the store** — resolve the `ProjectLink` via `snapshot.links.get(documentId)`
   and call `snapshot.backend.listInvitations({ projectId: link.cloudProjectId })`.
   No store changes; matches what `ProjectsPanel` already does for backend reads.

**Recommend option 1.** The asymmetry is the kind of thing that decays — the next
person adding a members feature will find three of five methods on the store and
guess wrong about where the others live.

### Gap B — `role` is `null` on every row of the natural list

`MirroredProjectStore.listProjects()` (`:731-750`) builds rows from
`LocalProjectStore.listProjects()`, whose private `summarise()` hard-codes
`role: null` (`:186`). `MirroredProjectStore` overwrites `origin` when a link
exists but **never overwrites `role` or `visibility`.**

So the role for the open project must come from `backend.myRole({ projectId })`
or `cloud.getProject(...)`, not from the list the projects panel already reads.
This is a trap worth stating in the spec because the wrong source silently
returns `null`, which `refusalReason` renders as *"You are not a member of this
project"* — a confusing lie for an owner.

---

## 4. Where the panel attaches

`src/editor/workbench/Workbench.tsx:319-332` renders `panel-left` as a `Slot`
whose `wrap` gives every contribution its own `DockSection`, with open/closed
state persisted by `id`. **A new contribution needs zero edits to
`Workbench.tsx`.**

Registration follows `src/cloud/contributions.tsx` exactly:

```tsx
export function CloudMembersPanelContribution({ runtime }: { runtime?: CloudRuntime } = {}) {
  const resolved = useCloudRuntimeInstance(runtime)
  useRegisterContribution({
    id: 'cloud.members',
    slot: 'panel-left',
    priority: 120,
    title: 'Share',
    icon: <Users size={11} />,
    render: (api: WorkbenchApi) => (
      <CloudSyncProvider runtime={resolved} lifecycle={false}>
        <CloudMembersPanel api={api satisfies CloudWorkbenchApi} />
      </CloudSyncProvider>
    ),
  })
  return null
}
```

The inner `CloudSyncProvider` re-wrap is required, not redundant — the shell
draws a slot's content where the slot lives, so a provider mounted at the
contribution site would not be an ancestor of what the slot renders
(`contributions.tsx:20-24`).

---

## 5. House pattern the panel must follow

From `src/cloud/VersionHistory.tsx` and `ProjectsPanel.tsx`.

**Gate before fetching, in this order.** Not a spinner over content — a sequence
of honest states:

1. `configuration.status === 'unconfigured'` → `EmptyReason` explaining what still works locally
2. `!canReachCloud(identity)` → `EmptyReason` for sign-in
3. `link === undefined` → `<p role="status">Checking…</p>` (the tri-state while resolving)
4. `link === null || !store` → `EmptyReason` with a "Save to cloud" call to action
5. only then fetch

**Fetch with a staleness guard.** Every fetch in this module uses
`let live = true; …; return () => { live = false }`, keyed on
`[store, documentId, nonce]`, with `Promise.all` for parallel reads and
*independent* error state per call so a partial failure doesn't blank data that
did load. `refresh()` is a `useReducer` counter bumped in `finally`.

**Mutations through a `run()` wrapper** (`VersionHistory.tsx:186-202`) that sets
busy, catches, converts a `CloudResult` failure via `noticeFor`, and always
refreshes in `finally`.

**Busy state should be per-row here, not panel-wide.** `VersionHistory` uses a
single `busy` boolean; `ProjectsPanel` uses `useState<string | null>` keyed by row
id. A member list has many independent per-row actions — copy `ProjectsPanel`.

**Reuse existing CSS.** `import './cloud.css'`; the primitives already exist:
`.bw-cloud-notice[data-tone]`, `.bw-cloud-btn[data-variant]`, `.bw-cloud-field`,
`.bw-cloud-badge[data-origin]` (already used for a role pill at
`ProjectsPanel.tsx:340-343`), `.bw-cloud-list`, `.bw-cloud-confirm[role=alertdialog]`,
`.bw-cloud-inline-form`, `.bw-cloud-empty`, `.bw-cloud-scroll`. The one genuinely
new thing is a role `<select>` — no styled select exists yet.

---

## 6. Edge cases

| Case | Behaviour | Where enforced |
|---|---|---|
| Owner demotes themselves | Refused: *"The owner's role cannot be changed."* Fires even for the owner acting on themselves. **`refusalReason` cannot predict this** — `roleAllows('owner','member.setRole')` is `true`; it's a business rule in the mutation body. Check `subject === ownerSubject` client-side. | `members.ts:46-53` |
| Owner leaves | Impossible. The owner guard runs after the capability check regardless of which path allowed the caller in. Don't offer "Leave" on the owner's row. | `members.ts:~100` |
| Invite an address that is already a member | **Succeeds.** `create` only checks other *pending* invites; it never reads `members`, and structurally cannot — emails aren't stored on member rows. On accept, the already-a-member branch consumes the token and returns the **existing** role unchanged, never lowering it. The panel cannot pre-validate this; state the behaviour in a hint. | `invitations.ts:52-106`, `:182-190` |
| Accept an expired invitation | Lazily expired: the first `accept` after TTL flips the row and refuses. **Nothing sweeps on a timer**, so `list` keeps reporting it `pending`. The panel must compare `expiresAt` client-side and badge it itself. | `invitations.ts:158-165` |
| Revoke an already-resolved invitation | `{ revoked: false }`, not an error. Idempotent. | `invitations.ts:108-132` |
| Role change while target is live-editing | Presence is untouched — their cursor keeps broadcasting. Their **next** write re-authorises fresh and returns `FORBIDDEN`. **See §7.** | `model/auth.ts:86-110` |
| Non-member of a private project | `NOT_FOUND`, never `FORBIDDEN` — `FORBIDDEN` is reserved for a real member lacking a capability. | `model/auth.ts` |

### `refusalReason` output, computed against the real matrix

| Capability | `refusalReason('editor', …)` |
|---|---|
| `member.list` | `null` — never refused for any member |
| `member.invite` / `setRole` / `remove` / `audit.read` | `"Only owner can do that; you are editor."` |
| `project.delete` (visibility) | `"Only owner can do that; you are editor."` |
| any, `role === null` | `"You are not a member of this project."` |

Note it never names the action — it says "do that". The control's own label must
supply the verb.

> **Raw `FORBIDDEN` must never reach the screen.** `model/auth.ts:104` builds
> `` `A ${role} may not ${capability.replace('.', ' ')} on this project.` `` — which
> renders literally as **"A editor may not member setRole on this project."** Gate
> with `refusalReason` up front so this string is unreachable.

---

## 7. The interaction that matters most

**Demoting a collaborator mid-edit can permanently halt their entire outbox.**

`FORBIDDEN` is not in the outbox's `TRANSIENT` set
(`src/cloud/outbox.ts:110` — `new Set(['OFFLINE', 'TRANSPORT_FAILED'])`). The
drain loop's handling of any non-transient, non-`STALE_DOCUMENT` error is
(`:333-338`):

```ts
// Permanent: too large, refused, malformed. The queue stops rather than
// skipping, because every later entry is built on this one's revision.
await this.persist(entry)
this.publish({ status: 'error', reason: error.message, lastError: error })
return this.getState()
```

So a demotion doesn't merely refuse the demoted user's next save — once that
refusal lands, **every later queued entry for every project in that browser is
stuck behind it**, with no automatic retry.

Two consequences for this spec:

1. **Confirm before demoting**, naming the effect: *"Bob will not be able to save
   changes he has not yet synced."*
2. **This spec should not ship before [spec 03](03-sync-conflict-recovery.md)**,
   which gives the demoted user a way to recover. Shipping role changes first
   adds a new way to strand someone's work with no repair path.

There is no presence-aware "is this person editing right now" signal available
to the panel today — presence is built but unmounted (§1a), so a
warn-if-active affordance would have to query `listPresence` itself.

---

## 8. Tests

**Already proven server-side** by `src/cloud/__tests__/authorisation.test.ts` —
the capability sweep at `:309-387` probes `setMemberRole`, `removeMember`,
`createInvitation`, `listInvitations` for every role, and `:401-428` covers
owner-demotion refusal and leave-without-permission. **The UI suite should not
re-derive these**, only assert the panel surfaces them.

**New — `src/cloud/__tests__/membersPanel.test.tsx`**, mirroring
`versionHistory.test.tsx`'s `mount()` helper:

- `renders the four gate states before fetching` — unconfigured, signed-out, checking, unclaimed
- `disables invite for a viewer with the refusal reason` — assert the exact `refusalReason` string
- `offers no role picker on the owner's row`
- `offers no leave control on the owner's row`
- `badges an invitation past expiresAt as expired even while the server says pending`
- `confirms before demoting, naming the sync consequence`
- `keeps other rows interactive while one row is busy` — the per-row busy requirement
- `surfaces delivery status when email is not configured` — `deliveryStatus: 'not-configured'` is the default with no env vars set

**Existing files needing updates:**
- `contributions.test.tsx` — its `expect(registry.all()).toHaveLength(3)` becomes `4`; add the new id to the `panel-left` list assertion
- `fakeBackend.ts` — **parity gap:** `acceptInvitation` (`:1491-1532`) never reads `expiresAt`; it accepts any `pending` row regardless of age. The real mutation does check. Add the same guard before writing an expiry test against it.

**Harness available:** `src/cloud/__tests__/harness.ts` provides `ALICE`/`BOB`/`CAROL`
and `addMember(deployment, ownerBackend, projectId, invitee, role)` — which
deliberately creates and redeems a *real* invitation rather than inserting a
members row, so the authorisation gates pass against a membership a real user
could actually obtain. `uiHarness.tsx` provides `makeUiHarness`, `withRuntime`,
`fakeWorkbenchApi`, `overrideBackend` (a `Proxy` letting one method fail while
the rest stay real) and `unreachableBackend`.

---

## 9. Work breakdown

1. **Mount the cloud contributions.** One line in `src/App.tsx`. Lights up sync status, projects panel and version history. Ship and verify this alone first.
2. Extend `ProjectStore` with the four missing methods (Gap A, option 1).
3. Fix `role: null` in `LocalProjectStore.summarise` / `MirroredProjectStore.listProjects`, or document that `myRole` is the only source (Gap B).
4. `src/cloud/MembersPanel.tsx` — gate states, member list, role picker, remove with confirm.
5. Invitation list, create form, revoke, client-side expiry badge.
6. Visibility toggle, gated on `project.delete`.
7. Register the contribution; add to `CloudProjectsContribution`'s provider list.
8. Fake-backend expiry parity fix; tests alongside each step.

**Step 1 is independently valuable and should not wait for the rest.**

---

## 10. Open questions

1. Should ownership transfer exist? Three separate refusals point at it (`"Transfer ownership first"`) and no mutation implements it.
2. `panel-left` alongside Projects, or `panel-right`? Left groups it with project management; right is where per-document context lives.
3. Should the panel warn when inviting an address that may already be a member, given it cannot check?
4. Should demoting be blocked entirely while the target has unsynced work, rather than merely warned?
