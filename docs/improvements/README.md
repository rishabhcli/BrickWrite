# 100 improvements

Ten domains, ten findings each, produced by ten parallel read-only research
passes over the repository at commit `2fe8bbc`.

Every finding carries file:line evidence, the consequence, a specific change, an
effort estimate and what could break. Nothing here is a style opinion.

| # | Domain | File |
|---|---|---|
| 01 | Architecture and code health | [01-architecture.md](01-architecture.md) |
| 02 | Performance | [02-performance.md](02-performance.md) |
| 03 | Accessibility | [03-accessibility.md](03-accessibility.md) |
| 04 | Security and privacy | [04-security.md](04-security.md) |
| 05 | Testing and QA | [05-testing.md](05-testing.md) |
| 06 | UX and information architecture | [06-ux-information-architecture.md](06-ux-information-architecture.md) |
| 07 | CAD and domain capability | [07-cad-capability.md](07-cad-capability.md) |
| 08 | Cloud, collaboration and data | [08-cloud-collaboration.md](08-cloud-collaboration.md) |
| 09 | AI and agent capability | [09-ai-agent.md](09-ai-agent.md) |
| 10 | Developer experience and operations | [10-devex-operations.md](10-devex-operations.md) |

## How to read this

Findings were produced by research agents and then **spot-verified by hand**.
Where verification changed a claim, the document says so rather than quietly
correcting it. Three examples, so you can calibrate how much to trust the rest:

- **07 finding 2** — the researcher wrote "no moment term anywhere in the file."
  There are five. They compute a *centre of mass*, not a bending moment. The
  conclusion survived; the evidence sentence was rewritten.
- **08 finding 1** — "zero callers of any of the four" was loose:
  `executeConflictFork` *is* called, but only from inside `resolveDivergence`,
  which nothing calls. Restated precisely.
- **03 finding 1** — the proposed contrast fix overshot to 5.43:1, worsening the
  hierarchy risk the same finding raised. Replaced with the computed minimum
  that clears AA (`#6f8085`, 4.55:1).

Unverified claims are the ones with no "verified by hand" note at the top of
their document. Treat those as leads, not facts.

## State of the codebase

~87k lines of source across thirteen areas, 24k lines across 131 unit test
files, 14 runtime and 14 dev dependencies.

| area | lines | | area | lines |
|---|---|---|---|---|
| src/editor | 15,668 | | src/intelligence | 4,595 |
| src/features | 10,636 | | convex | 3,531 |
| src/cad | 9,827 | | src/platform | 3,017 |
| tools | 8,982 | | server | 2,354 |
| src/cloud | 8,231 | | functions | 1,328 |
| src/refinement | 7,619 | | | |
| src/generation | 6,997 | | | |
| src/agent | 4,651 | | | |

## The five things I would do first

Chosen for consequence per unit of effort, not for how interesting they are.

**1. Fix the two lying CTAs.** (`06` findings 1–2, effort M each)
"Start a blank build" loads a 35-part showcase model and autosaves it as the
user's project; "Describe a build" generates `?intent=describe`, which **zero
code reads**. These are the first two things a new visitor touches.

**2. Close the Convex authorisation gaps.** (`04` findings 5, 7 — one is `S`)
`server/security/auth.ts` refuses anonymous and restricted identities; the
database layer never checks, so **the two gates disagree**. Separately, publishing
a model currently also publishes your member roster and a live feed of
collaborators' cursors, because implicit `viewer` carries `member.list` and
`presence.publish`.

**3. Get the auth SDK off the landing critical path.** (`02` finding 1, effort M)
`/` ships **579 KiB gzip**, of which **477 KiB is Hexclave** — on a page that
authenticates nobody. Keep the chunk whole when you move it; splitting it blanked
production once already.

**4. Add production error tracking.** (`10` finding 1, effort M)
`grep -rn "console\." server/ functions/ convex/ api/` returns **zero**. There is
no logging, no aggregation, no alerting. Today an outage is discovered by a user
complaining.

**5. Make sync recoverable.** (`08` finding 1, effort M)
Conflict recovery is written and tested with **no UI path to any of it**.
`syncReadout.ts:86` tells users to "reconcile the divergence" — there is no
control that does. One conflict on one project permanently halts sync for every
project in that browser.

## Recurring themes

Four patterns showed up independently in several domains, which is usually a
better signal than any single finding.

**Built but unreachable.** Conflict recovery, presence, sharing, roles,
invitations, `verifyPublicationIntegrity`, `registerGalleryRoute` — all
implemented, tested, and called by nothing. This is the dominant pattern in
`08`, and it appears in `01` and `04` too. The backend of this product is
substantially further along than the surface that would let anyone use it.

**Gates that measure the machine, not the code.** The renderer suite asserted
30 FPS on a GPU-less runner; the LCP budget drifted 260 ms between machines; the
landing byte budget measures a build that is never deployed. `05` and `02` both
land here. A gate that cannot pass, or that passes for the wrong reason, is worse
than no gate because it teaches people to ignore red.

**Two implementations of one rule.** `src/cloud/__tests__/fakeBackend.ts` is
1,740 lines re-implementing authorisation that `convex/`'s 3,531 lines actually
enforce — and `convex/` has **zero tests**. Same shape in `01`: two hand-rolled
NDJSON readers, `clamp` defined six times. When the copy and the original
disagree, the tests agree with the copy.

**Honest about limits, in prose.** This codebase documents its assumptions
unusually well — and then those documents go stale, unasserted. The `ci.yml`
asset-pack comment was wrong by 19 MB. `cloud-projects.md` says Convex was never
deployed live while `deployment.md` names the deployment. `07` finding 6 records
a pack-selection bug that already happened. **Turn the prose into assertions.**

## Method and its limits

Ten agents, one domain each, read-only, with a fixed output contract. Roughly
1.6M tokens of research.

What this did not do: run the app against real user data, review the ~57 MB
compiled catalog for correctness, audit third-party code, or attempt any fix.
Effort estimates are relative, not calendar time. Several findings interlock —
`08`/1 and `08`/10 share a root cause, `09`/5 and `04`/3 are the same rate
limiter — so treating all 100 as independent work items will overcount.
