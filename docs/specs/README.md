# Implementation specs

**Snapshot.** Written 2026-08-28 against the tree at that date. Spec 02 step 1
(`CloudProjectsContribution` in `src/App.tsx`) has shipped; conflict recovery,
batched sync and invitation delivery have backend contracts documented in
`docs/cloud-*.md`. These five files remain the original how-to-build notes.
They are not a checklist of what is still missing.

Where [`docs/improvements/`](../improvements/README.md) says *what* is wrong across
100 findings, these say *how* to fix one thing, in enough detail to build from:
exact current-state code, the design, API and schema deltas with real signatures,
enumerated edge cases with expected behaviour, named tests, and what could break.

| # | Spec | Effort | Blocked by |
|---|---|---|---|
| 01 | [BrickLink export and project archive](01-bricklink-export-and-archive.md) | M + L | two identifier prerequisites |
| 02 | [Sharing, roles and invitations](02-sharing-roles-invitations.md) | L | spec 03 |
| 03 | [Sync conflict recovery](03-sync-conflict-recovery.md) | M | — |
| 04 | [Keyboard-operable viewport](04-keyboard-operable-viewport.md) | L | — |
| 05 | [Cantilever moment analysis](05-structural-analysis-depth.md) | M | — |

## What the research changed

Each spec was written from a dedicated deep research pass, then hand-verified.
Four of the five came back with something that changed the shape of the work —
which is the argument for specifying before building rather than after.

**01 — the feature has two prerequisites nobody knew about.** `bricklinkIds: []`
is written unconditionally at `tools/catalog-compiler.mjs:726`. Measured: **0 of
900** parts carry a BrickLink id, so the column the BOM currently labels
"BrickLink ID" always contains the *Rebrickable* number. Separately, no
LDraw→BrickLink colour mapping exists anywhere — BrickLink colour 11 is Black,
LDraw colour 0 is Black, and the codes do not correspond. Writing `colorCode`
into `<COLOR>` would put a wrong integer into a purchase order.

**02 — the highest-leverage line in the codebase.** `src/App.tsx` mounts **no
cloud contribution at all**. Sync status, the projects panel and version history
are all built, registered, tested — and unreachable. `src/cloud/index.ts:192-204`
documents the intended wiring in prose; the line was never added.

**03 — "permanent" does not mean inert.** The comment at `outbox.ts:333` says
*"The queue stops rather than skipping."* It doesn't. `startAutoDrain` re-enters
every 2 seconds and neither the `STALE_DOCUMENT` nor the permanent branch ever
pushes `nextAttemptAt` forward, so **the same refused request goes to the
deployment every ~2 seconds indefinitely.**

**04 — the fix already exists in this repo.** `src/features/share/viewer/ModelCanvas.tsx`
is fully keyboard-operable: `tabIndex`, `role`, `aria-label`, arrow-key orbit,
`+`/`-` zoom, `0` reset, Shift for a coarser step, and a visible hint. The editor
canvas has zero `tabIndex`. The interaction contract transfers directly.

**05 — half the feature should not be built.** The research was asked for *real
measured* per-family clutch figures with sources. It found one credible
measurement (Liu et al., arXiv:2402.10711 — 0.98 N, which is exactly the 100 gf
the code already assumes) and **nothing at all for pin, axle, bar/clip or
ball/socket**. A per-family table would be four invented numbers in the one
module that has been scrupulous about separating measured from assumed. The
cantilever/moment half is well-founded and is what the spec builds.

## Verification

Claims were checked by hand rather than taken on trust, and the specs say so
where verification changed something. Two examples:

- A researcher wrote *"zero callers of any of the four"* recovery functions.
  `executeConflictFork` **is** called — from inside `resolveDivergence`, which
  nothing calls. Restated precisely in spec 03.
- Another wrote that `statics.ts` has *"no moment term anywhere in the file."*
  There are five. They compute a centre of mass, not a bending moment. The
  conclusion held; the evidence sentence was rewritten (spec 05 §2).

Two errors in `docs/improvements/` were found this way and corrected in place:
the BrickLink coverage figure (`07-cad-capability.md`) and the claim that a
parked sync queue is never retried (`08-cloud-collaboration.md`).

## Suggested order

**Start with spec 02, step 1.** One line in `src/App.tsx` lights up three
finished surfaces. Ship and verify it alone.

**Then spec 03, steps 2–3.** Suppressing the retry storm and un-swallowing
`OUTBOX_FULL` are independent of any UI and stop a live problem today.

**Then spec 04, steps 1–2.** `tabIndex` plus camera keys closes the most visible
part of a WCAG Level A failure and is small.

Specs 01 and 05 are feature work rather than repair, and 02's own UI depends on
03 shipping first — role changes can strand a collaborator's queue with no way
out until conflict recovery is reachable.
