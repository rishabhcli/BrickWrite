# Overhaul — the remaining improvements

Operator asked for all of them, after the night's audit closed 41 findings. This
is the working plan and its order. Same standing rules: never commit, never push;
`npm run check` and all six browser suites stay green between items.

**Sequencing principle.** Capability first, soundness second, formatting last.
The formatting pass rewrites ~10,000 lines across 435 files and would bury every
other diff in this tree, so it goes at the end where it can be discarded with one
`git checkout` if the operator wants it separate.

## Order

- [x] **1. Insertability warnings** — done. See below.
- [ ] ~~1.~~ **Insertability warnings** (`07-cad-capability` #7). A build sequence can
      satisfy "everything attaches to something earlier" and still be physically
      impossible — an interior mechanism sequenced after the shell that encloses
      it. Warning, never a refusal, per the finding's own risk note.
- [ ] **2. Project export** (`08-cloud-collaboration` #7, export half only). A
      user closing their account cannot get their data out in one action.
      Deliberately *not* the hard-delete half: destructive, needs a grace period,
      and not something to add unprompted.
- [ ] **3. Presence cursors** (`08` #8, second half). The roster shipped
      overnight; cursors are what make co-editing legible.
- [x] **4. Per-user spend budget** (`09-ai-agent` #5) — done. A rate limiter
      bounds requests per minute, not money. `server/security/budget.ts`, weighted
      output tokens, fails *closed* on a configured-but-unreadable meter.
- [ ] **5. Enforce CSP** (`04-security` #4). Report-only today. The three CI
      browser suites load real pages, so breakage is observable rather than
      hypothetical.
- [ ] **6. `noUncheckedIndexedAccess`** (`01-architecture` #6). 1,518 errors,
      measured. Per-directory, kernel first. Triaged, not silenced with `!` —
      the audit found the code already guards correctly, so the flag has to agree
      with the guards rather than paper over them.
- [ ] **7. Flexible parts** (`07` #1). New deformable part class: hoses, bands,
      chain. The largest item, and the only one that touches the document schema.
- [ ] **8. Prettier** (`10-devex` #3 / `format:check`). Last, for the reason above.

## Not in scope, with reasons

- **Hard delete** (`08` #7) — destructive and irreversible; wants an explicit
  decision and a grace period.
- **Price and availability** (`07` #4) — needs a data source this repo does not
  have. Price also goes stale immediately, so it needs an "as of" or a live fetch.
- **Pack selection floors** (`07` #6) — needs a recompile against the full 22,941
  identity LDraw library, which is not present here. The watcher added overnight
  closes the hole the finding actually worries about.
- **Live-API items** (`09` #2 context management, #3 refusal fallbacks) — both
  need real model calls to verify. Shipping unverifiable protocol code is worse
  than leaving the finding open.
- **Error tracking** (`10` #1) — needs a service and a DSN. An SDK with no
  destination is worse than nothing.


---

## 1. Insertability — done

`findBlockedInsertions(document, steps)` in `src/cad/instructions.ts`, surfaced as
a `BLOCKED_INSERTION` build-order warning. At the moment a step introduces a
part, the part's box is retracted a stud at a time along each of the six axes
against everything already placed; if every direction is closed, a builder would
be holding that piece with nowhere to put it.

**Warning, never a refusal**, per the finding's own risk note — it works on
bounding boxes along axis-aligned approaches, so false positives are the expected
error.

Three things worth recording.

**Supports are transparent at the pose and opaque beyond it.** The first version
excluded a part's mates from the whole sweep, which declared a fully walled-in
core insertable *straight down through its own floor*. A mate is now ignored only
for the first 26 LDU of travel — the deep-insertion allowance `collision.ts` uses
— and blocks after that.

**One spatial query per part, not per probe.** Every swept box lies inside the
part's box grown by the travel distance, so all twenty-four probes share one
candidate list. Querying per probe meant 275,832 grid lookups on the campus demo,
each allocating a set and cell keys; the churn slowed the whole vitest worker
enough to time out unrelated tests in the same file. 14,452 ms → **234 ms**, a
62× improvement.

**Off by default.** It is a reporting check, and generation walks
`computeBuildOrder` once per candidate — enabling it there pushed two strategy
tests past a thirty-second budget. `tools/build-demos.mjs` opts in explicitly,
because a published demo carries instructions a person will follow.

**Zero false positives on 22,245 shipped parts**, locked in by
`src/cad/insertability.demos.test.ts`. And the numbers turned out to be
independent evidence for something the demos already claim: every *final*
document is clean, while every deliberately-worse *rough* first candidate is not
— the saucer-freighter's rough has 21 blocked insertions and 130 collisions.
