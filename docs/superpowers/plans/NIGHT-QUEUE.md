# Night queue — Opus, 2026-08-30 overnight

Two sibling agents (GPT 5.6 Sol 1 and Sol 2) stopped before finishing. This is
the durable work queue for picking their plans up and carrying on. The plan
files' own checkboxes are the source of truth for what is done; this file is the
order to do the rest in, and why.

**Where things stand.** All three plans are at zero unchecked items. Nothing is
committed — the tree is dirty by design. `npm run check` exits 0 (190 files,
2,910 tests) and all six browser suites pass.

**If you read only part of this file**, the entries worth knowing about are the
ones that changed behaviour rather than adding it:

- The Mirror command was not a mirror — it composed the reflection on the wrong
  side, so an off-axis part came back rotated, and it emitted unbuildable
  negative-determinant placements.
- The Workspace menu was completely unclickable at every window width, from a
  CSS pair (`overflow-x: auto; overflow-y: visible`) that silently means
  something else.
- Candidate generation was 61–91% one memoization miss; a detail-heavy brief went
  from 9.2 s to 1.8 s.
- An unlisted share token could reach the edge log drain.
- A model built from parts outside this catalog pack was reported as a *broken
  model* rather than a gap in the pack.
- `npm run check` — the command CI runs — was losing ten tests to an unbounded
  worker pool, while the documented workaround lived in this file's own rules.

**On timing-sensitive gates.** The renderer suite's sustained-frame-rate gate
failed during the night and passes again once the machine is quiet — 45.7 FPS p5
at 5,000 parts against a 30 FPS target, re-run at 07:08. It was never the code:
established by reverting the change in flight and watching it fail identically,
with the drained renderer cost unchanged at 10.8–11.7 ms throughout. Treat a red
timing gate as a question about the machine before a question about the diff.

**Standing rules for every item here**
- Never commit, never push. Dirty tree is expected.
- `npx tsc -p tsconfig.app.json --noEmit` and **`npm run lint`** stay clean. Use
  the npm script, not `npx eslint src tools server`: the narrow form is what let
  a lint failure in `.superpowers/` go unnoticed for a whole session, because CI
  runs `eslint .` over everything.
- Tests run with `npx vitest run … --maxWorkers=2`. The env-var prefix that used
  to be required here is genuinely gone: under `VITEST`, `vite.config.ts` points
  `envDir` at a directory with no `.env` files *and* strips every `VITE_*` key
  from `process.env`, so neither a developer's `.env.local` nor a shell export
  can decide whether the cloud suite passes. Both halves were needed; the first
  alone was not enough. (The e2e suites still take the prefix — they run a real
  dev server, not vitest.)
- No worker flag needed any more. `vite.config.ts` caps `maxWorkers` at `'25%'`,
  so a bare `npx vitest run` and `npm run check` get the same pool as CI. The
  `--maxWorkers=2` that used to be required here was a workaround for a real
  problem in the wrong place — see the entry below.
- **Run one browser suite at a time, and never alongside vitest.** Confirmed
  twice tonight. `npm run test:e2e:all` already covers every suite, so invoking
  `cad-editing` or `renderer` again afterwards is not a second opinion — it is a
  second run against state the first one left, and it fails. Worse, a vitest run
  in parallel takes enough GPU away that Chromium falls back to SwiftShader
  mid-suite; the smoke suite then reports *"software rasteriser detected"* and
  spends minutes on widened waits before timing out. A red suite under
  contention is not evidence of anything.
- No official LEGO set inventories, no Star Wars / Disney IP. Original subjects only.

## Done

- [x] **P0** `src/editor/CommandDeck.tsx` `argsFor()` — my two generate capability
      ids broke the exhaustive switch (TS2366). Fixed with a real prompt field,
      not a stub, so a builder can run generation from the deck.
- [x] **P0** `tools/e2e/cad-editing.mjs` dead `gpu` initializer failing `eslint`.

## Queue, in order

1. ~~**Sol 1 Task 7**~~ — interpolation done (adaptive sweep budget, measured).
   The winch is deferred with cause, written up in Sol 1's plan: joint freedoms
   are *derived* from connector families with no authored channel, and no real
   sliding joint has a usable stroke either (all 59 axial connectors in the
   production catalog are clips with ±4 LDU of grip slop). Doing it properly
   means an authored-freedom override map on the document — see item 7.

2. ~~**Generation: upper storeys are never realised.**~~ **Fixed.**
   `GraphRealizer.extend` now retries nodes whose failure was transient (hover,
   unclutched rest, host not yet placed) and leaves terminal ones (collision,
   missing identity, envelope, spent budget) refused once. `NodeOutcome.retryable`
   carries the distinction. The default part budget now derives from a stated
   envelope, because 420 became the binding constraint the moment upper storeys
   started building. Measured, deterministic path:

   | Brief | Before | After |
   | --- | --- | --- |
   | three-storey shop 20 × 16 × 18 | 115 parts, 1 storey | 326, base + storey1 + storey2 |
   | saucer freighter 40 × 16 × 24 | 360, keel only | 908, keel + port + starboard + cockpit + engine |
   | lattice spire 20 × 20 × 44 | 399, base only | 839, base + clock-stage + belfry + spire |
   | harbour control tower 24 × 24 × 40 | — | 1,072, plinth + two bays + shaft + crown |

   All collision-free, single-component. Guarded by
   `src/generation/eval/archetype.test.ts`.

3. ~~**Sol 2 Tasks 7–9 — the demos.**~~ **Done — three new gated sets.**

   - **Harbour Control Tower** (Task 7) — 1,078 parts, 19 steps, 3.24 kg. A
     quayside play set: two full-height drive-in vehicle bays cut through the
     podium, a covered metro platform along the seaward edge, a control shaft
     built as four separable storeys, a quayside warehouse, and a crane on the
     podium roof from Sol 1's `planCrane` with a real luffing hinge.
   - **Saucer Freighter** (Task 8) — 726 parts, 17 steps, 1.36 kg. Original
     planform: centred cockpit between twin booms on a stepped lozenge hull,
     with `planSnotHull` for the sideways-stud skin and two `planHingedFlap`
     mechanisms (dorsal turret, boarding ramp). No copied silhouette.
   - **Iron Lattice Lookout** (Task 9) — 1,118 parts, 19 steps, 1.87 kg. An
     arched masonry plinth under two tiers of open lattice stepping inward,
     topped by a clock stage with four independently hinged hands. Uses
     `planLattice` and `planClockFaces`, which existed and had no demo calling
     them — the collection was shipping planners it never demonstrated.

   Both pass every compiler gate — triangle-confirmed collision, connection
   graph, derived build order, catalog membership, statics — and the build is
   byte-for-byte deterministic (`node tools/build-demos.mjs --check`).

   The manifest's substance gate was reworked while doing this. It asserted
   `partCount > 1000`, a threshold calibrated against three
   modular-architecture stacks; it passed a 1,200-part single-subassembly blob
   and failed a 700-part ship that comes apart into hull, booms, cargo and a
   ramp. It now checks a part floor (>500, still far above the thirty-part
   shapes it was written against) **and** that a demo separates into more than
   two assemblies **and** has more than three build steps — stricter where it
   matters — plus a new test that the collection shows more than one
   discipline, which was the operator's actual complaint.

4. ~~**Sol 2 Task 5**~~ — done. Two of the three items were already satisfied
   and simply never ticked: both project delete paths confirm before deleting
   (`ProjectsPanel` with a trapped sub-dialog, `ProjectMenu` with a two-click
   confirm), and `ShortcutGuide` / `CompareDialog` both hand-roll Tab traps.
   The genuinely missing one — `GlassPanel` wrappers on the Agent, Generate and
   Refine panels — is now done, classNames and structure only, no session calls
   touched.

5. ~~**Sol 2 Task 6 / `?intent=describe`**~~ — mostly already done by Sol 2:
   `Workbench.tsx` honours `?doc=blank` and `?intent=describe`, the brand is a
   link, and the Codex copy is gone. One real defect fixed: the shell reads
   `intent=describe` **and consumes it from the address bar**, while my Generate
   contribution read the same parameter independently — which only worked
   because React happens to run child effects before the parent's async effect.
   The shell now announces `brickwright:intent-describe` (the seam Sol 2's plan
   documented and nothing dispatched) and the panel listens for it, so there is
   one owner of the URL and no ordering hazard.

6. ~~**Sol 1 Task 10 / Sol 2 Task 10 — e2e**~~ **Done: 23/23.**
   `BRICKWRIGHT_E2E_URL=http://localhost:5175 node tools/e2e/cad-editing.mjs`
   against `npx vite` on an Apple M3 Max. Two notes for whoever runs it next:

   - It must run against the **dev server**, not `vite preview`. The suite
     resolves the kernel with
     `performance.getEntriesByType('resource') … '/src/cad/engine.ts'`, which is
     a dev-server URL; against a production bundle that lookup returns
     `undefined` and the run dies with `Cannot read properties of undefined`.
   - Run it **once at a time**. Two concurrent runs against one dev server fail
     the autosave-reload check, because they share the persisted local project.

   This also clears the blocker Sol 1 recorded in their own notes — their run
   failed on shared CSS putting the Inspector over the palette. Sol 2's
   stylesheet split fixed it.

   **Sol 1 success criterion 6 was not met, and now is.** The suite reported a
   first-pick latency of 60.1 ms against a 2.9 ms steady state on the 11k model,
   after waiting for `identityWarmupComplete` — so the warm-up was completing
   and the cliff was still there. Cause: `IdPass.warm` rendered the *full frame*
   and read back one pixel, but `pick` renders through `setViewOffset` and reads
   a `patch × patch` block out of the target's corner. The warm-up was compiling
   a neighbouring path, not the one a click takes. `warm` now exercises both.
   Measured after: **60.1 ms → 4.3 ms**, against a 3.1–4.9 ms steady state.

7. **Both plans are now closed except two items, each deferred with a reason.**
   - Sol 1: the `winch` freedom (needs an authored-joint channel the kernel does
     not have — measured and written up in their plan).
   - Sol 2: collapsing landing's `--bw-*` token set into the shared one. The
     substantive requirements are met (shared tokens load app-wide, no display
     face on body copy, contrast fixed and guarded); what is left is renaming
     ~200 declarations across eight stylesheets with no automated visual check
     to catch a mistake. Worth doing deliberately, in daylight, not overnight.

8. **Ongoing** — improvements beyond both plans, cheapest-first, each with a
   test: see "Found along the way" below.

## Found along the way

Defects noticed while working, each verified rather than asserted.

### Fixed

- ~~**Unattributed 1 x 1 filler parts.**~~ **Attributed and fixed, and the
  cause was bigger than the symptom.** `familyLibrary` selected structural
  identities by measured height, depth and connector families — which does not
  identify a *plain rectangular block*. Against the production catalog it chose
  `Plate Special 1 x 1 with Tooth` and `Plate Round 1 x 1 with Solid Stud` as
  deck fillers, `Brick Sloped 45°` as the one-stud brick at depth 2, and
  `Technic Brick 1 x 16 with Holes` as the sixteen-stud wall brick. All of them
  measure correctly and none of them stack.

  **It was invisible to the test suite by construction.** Every assembly test
  runs against `src/cad/__fixtures__/catalog.fixture.json`, which holds **58**
  placeable identities; the shipped catalog holds **900**. The parts that broke
  the demos are not in the fixture to be picked, so outcome-based tests passed
  while the product failed. Selection now requires the plain `Bricks` /
  `Plates` / `Tiles` categories, and `src/cad/stackedField.test.ts` asserts the
  *rule* — that shaped categories are considered and rejected — rather than
  looking for parts the fixture does not contain.

  **The divergence is now covered where it matters.**
  `src/cad/assembly.production.test.ts` installs the shipped catalog through the
  existing `installRealCatalog()` helper — the same stance
  `src/intelligence/parts/__fixtures__/real-catalog.ts` already took for the
  part ranker, and for the same reason: a chooser tested against 58 candidates
  proves nothing about choosing. It asserts both the rule (no shaped category is
  ever selected) and the behaviour (decks stack, enclosures stand, walls lay
  without collisions or floating parts) against the real field of 900.

  Verified by reverting the fix: 8 of its 17 tests fail, naming `3703`
  (Technic Brick 1 x 16) and `3040b` (Brick Sloped 45°) directly, and the
  behavioural cases fail on real collisions — so the guard catches the defect
  rather than merely restating it.

  The curated fixture is left broadly alone deliberately. It is the right stub
  for geometry and connector behaviour, its contents are commented with the
  reason each group is present, and widening it would perturb every test that
  asserts a bill of materials against it.

- **`familyLibrary` chose parts by measurement, not shape.** It selected
  structural identities on height, depth and connector families, which does not
  identify a plain rectangular block. Against the shipped catalog it picked
  `Plate Special 1 x 1 with Tooth` as a deck filler, `Brick Sloped 45 deg` as
  the one-stud brick, and `Technic Brick 1 x 16 with Holes` as the sixteen-stud
  wall brick. All measure correctly; none stack. Selection now requires the
  plain `Bricks` / `Plates` / `Tiles` categories.

- **The whole assembly suite tested a library the app never uses.** Every
  assembly test ran against a 58-identity fixture; the shipped catalog has 900.
  The parts that broke the demos were not in the fixture to be picked, so the
  tests passed while the demo compiler rejected the output.
  `src/cad/assembly.production.test.ts` now judges selection against the real
  field, and reverting the fix fails 8 of its 17 tests — including behavioural
  ones, on real collisions.

- **`--faint` failed AA on `--panel-2`** (4.28:1, floor is 4.5:1) in both
  `src/styles.css` and the landing's own `--bw-faint`. The glass tokens had a
  passing value but only behind `html[data-theme='dark']`, set on mount, so the
  failing value was live at first paint. Both fixed; `contrast.test.ts`
  computes the ratios and asserts the two token sets cannot drift apart.

- **The focus ring was square on every rounded control.** The base
  `:focus-visible` rule forced `border-radius: 2px`, so a 14px capsule got a 2px
  box drawn round it. Removed; an outline follows the element's own radius.

- **`IdPass.warm` warmed the wrong path.** It rendered the full frame while a
  click renders through `setViewOffset` and reads a patch, so the first pick on
  the 11k model cost 60.1ms against a 2.9ms steady state — with the warm-up
  reported complete. Now warms both: 60.1ms to 4.3ms.

- **`src/webmcp/imports.test.ts` could not see multi-line imports.** Its regex
  stopped at the first newline, so the lazy-chunk guard reported a graph smaller
  than reality and would have excused anything reachable only that way.

- **`RealizeConstraints.protectedPartIds` was declared and never read.** Wired
  to `mergeProtected`, which `validateGraph` actually enforces.

- **The brief compiler dropped named features.** "with a boarding ramp" never
  reached `brief.functions`, so nothing downstream could build it.

- **Joint freedoms could not be authored, only derived.** `jointFor` maps a
  connector pair to a freedom and the derivation reruns on every edit, so a
  mechanism whose behaviour is a matter of intent had nowhere to live — a winch
  drum is an axle in an axle-hole, and so is a plain axle. Added
  `ModelDocument.jointOverrides?` with a `joint.override` operation and a patch
  inverse, applied by *both* edge builders (missing the incremental one would
  have reverted a winch to an axle on the next edit). The `winch` freedom itself
  turns drum rotation into load travel along a separate payout axis, clamped to
  the cable. `findArticulatedJoints` treats an asserted freedom as drivable
  regardless of connector family and excludes it from rigid adjacency — both
  were needed, and the tests caught both. This closed Sol 1's last open item.

- **No sliding joint was testable at all.** `jointFor` reads a joint's axial
  range from the connectors, and across the whole compiled catalog only *some
  clips* declare one — the fixture carried none of them. The largest derivable
  slide range in the test catalog was **0 LDU**, so every prismatic and
  cylindrical freedom clamped to zero and `articulate`'s translation path was
  never once exercised with a real value. Added `60897` (Plate 1 x 1 with Clip
  Vertical, `axial: 8`) to `tools/make-test-fixture.mjs`, which makes a
  `bar:clip` cylindrical joint derivable, and covered the arithmetic and the
  clamp. Nothing else moved: the clip is `Plates Special`, so the structural
  selector ignores it.

- **The brief compiler reported one requirement as two, one of them nonsense.**
  The general "<something> that <verb>s" rule captured whatever preceded
  `that`, so "a shop with doors that open" produced *"A shop with doors opens"*
  alongside the correct "doors open". `brief.functions` is not decoration — it
  selects the massing strategy, decides whether the detail phase builds a real
  hinge, and is read back to the model in the grounding block — so a malformed
  entry was noise in three places. A connective now splits the phrase rather
  than being trimmed from its front ("a shop with doors" is about the doors),
  the specific rules run before the catch-all so their better wording wins, and
  functions dedupe by subject. Also taught it that a tower can have a clock.

- **Generated buildings had no windows or doors at all.** Measured across five
  briefs: every model came back as Bricks, Plates and exactly six Tiles, with
  the `Windows and Doors` category absent — including for prompts that said
  "with a door" and "with windows". Two causes, both real:

  1. `openingsFor` keys on `brief.functions`, and plain naming never reached it
     — the motion patterns need "doors that *open*". Doors and windows are now
     recorded as named features, which is how the opening system becomes
     reachable from ordinary phrasing at all.
  2. The catalog's only door element is six courses tall and a framed-shell
     storey is five, so `chooseElement` returned nothing, the wall was cut
     anyway, and no frame arrived. The build passed every gate, because a hole
     is structurally sound. Openings are now checked against the element
     library before being cut, and windows repeat along the run on every
     storey rather than appearing once on the ground floor.

  Measured after — farmhouse 4 → **38** seated frames and panes, tower 0 → 22,
  a tall shop 0 → 20 including the door; all collision-free and
  single-component, and a short shop honestly gets none rather than a hole.

- **Adjacent colour words in a list were silently dropped.** `matchColours`
  claimed the spaces *around* a name as well as the name, so two colour words
  sharing the single space between them collided — `" tan "` at 2..7 against
  `" white "` at 6..13. Longest-first then meant "white" took the space and
  "tan" vanished without a word, so "a tan, white and dark bluish grey tower"
  compiled to a two-colour brief. The span now covers the name only; the
  longest-name-wins rule is unaffected ("dark tan and white" still resolves both
  correctly, and "a grey tower" still resolves to nothing because no LDraw
  colour is named plain "Grey").

- **A brief naming five colours produced a model in one.** Every structural
  phase read `baseColour`, so walls, decks and bracing all took `palette[0]`
  and only the six detail greebles took `palette[1]` — the rest were never
  placed. Colour is now assigned by role (deck, wall, brace, detail) drawn
  strictly from the stated palette, which is never widened: a builder who names
  one colour still gets one colour, and the existing contract that no part falls
  outside `brief.palette` is asserted as before. Measured: a three-colour tower
  went from 909/6/0 to 504/292/119.

- **Surface detail was a constant six tiles on one face.** Regardless of model
  size, the deterministic detail phase placed 2–6 elements on a single host —
  the highest placed node — so a four-storey tower carried six tiles on its
  crown and nothing elsewhere, and a 24 x 24 deck carried the same six as a
  4 x 4 one. Detail now spreads over every placed surface and scales with each
  one's footprint (6 → 21–24 on a large model), bounded so it stays in
  proportion to the structure it decorates.

- **Narrow viewports were clipped, not just unscrollable.** `html, body, #root`
  are `overflow: hidden` so the editor grid owns the viewport, and `body` has a
  hard `min-width: 1024px`. Together that meant anything past 1024px on a
  narrower window was **unreachable** — including the text-only surfaces
  (Shortcut Guide, licence panel, Export Center) that have no 2D-layout reason
  for the exemption. Now `overflow: auto` below the breakpoint, so content is at
  least reachable. Full reflow (WCAG 1.4.10) needs a responsive grid and is a
  redesign; the marketing surfaces keep their existing, more specific opt-out.

  **Audited the rest of `03-accessibility.md` while there** and most of it is
  already done, largely by Sol 2 without ticking anything: the `role="radio"` /
  `aria-pressed` conflict is gone (two separate components now), dock sections
  have real `<h3>` headings inside `role="region"` containers, autonomy exposes
  `radiogroup` + `aria-checked`, toasts have live regions, and route changes set
  `document.title` *and* move focus to `#pf-main` — correctly skipping the
  editor, where stealing focus mid-build would be wrong.

- **`jointFor` had no direct coverage.** It is the whole of the kernel's
  opinion about whether a built mechanism can move — `findArticulatedJoints`
  reads it to decide what to offer, `articulate` to decide what to drive, the
  manipulator to decide which handles to draw — and it was the one function in
  `connections.ts` its test file never called. Two behaviours added tonight
  (authored freedoms, sliding joints) rest on it. Now covered across all seven
  pairs plus the rejected ones, including the distinction that is easiest to
  erode: a stud pair is a *keyed* revolute, because a round stud is
  geometrically free to spin but a built wall does not hinge.

  A curiosity found while writing it: an undeclared axial extent yields
  `minLdu: -0`, and `Object.is(-0, 0)` is false, so the obvious assertion fails.
  The test asserts the travel *width* instead, which is the thing that matters.

  **Audited `05-testing.md` while there.** Several findings are stale: it says
  `connections.ts` has no test file and `server/index.ts` has none — both exist
  now. The live gaps in that list are the cloud/e2e ones (Convex authorisation
  against real handlers, edge-proxy coverage, visual regression), which need
  deployed infrastructure rather than a local run.

- **The Mirror command was not a mirror.** `capabilities.ts` carried its own
  reflection helper, separate from the correct one in `src/refinement/mirror.ts`,
  and it composed the reflection on the wrong side — `B · M` instead of
  `M · B · M`. Right-multiplying reflects in the *part's own* frame, so any part
  not already square to the mirror plane came back **rotated rather than
  reflected**. A brick standing a quarter-turn off axis is not an edge case; it
  is most of a vehicle. Measured with a marker point: a part at 90° about Y
  mirrored across x=0 landed at z=+20 where the reflection is z=−20.

  It also emitted a **negative-determinant** basis — the "renders fine but may
  match no purchasable part" gap this doc's finding 3 names, passing straight
  into the BOM and the export.

  Both were invisible because the one existing test compared *positions only*,
  and every implementation agrees about where the origin goes.

  Fixed by deleting the duplicate: the arithmetic and the connector-symmetry
  chirality test moved to `src/cad/mirror.ts`, and `src/refinement/mirror.ts` is
  now a re-export, so the shipped command and the refinement search cannot
  disagree about what a mirror is. Every emitted basis keeps a positive
  determinant; where a part's connectors are not symmetric about the plane, the
  pose is still placed — the count is preserved — and the summary names the
  parts that need a hand change instead of quietly shipping an element nobody
  sells. Generalised to X, Y and Z while there: the command was X-only, and
  builders mirror front-to-back as often as left-to-right. Exposed in the
  Transform panel, the Command Deck and ⇧M.

  Nine kernel tests plus four capability tests, and the composition test was
  checked against a deliberately broken implementation to confirm it fails.

- **The cloud suite passed or failed depending on the developer's `.env.local`.**
  Six test files assert the *unconfigured* path — the honest local-only mode a
  visitor with no deployment gets — and one of them says in a comment that this
  checkout has no `VITE_CONVEX_URL`. With a real deployment configured, three of
  them fail. So the tests most likely to break belonged to whoever was actually
  working on the cloud path, and they were green in CI the whole time.

  `test.env` did not fix it and `vi.stubEnv` could not: measured, `process.env`
  took the pin and `import.meta.env` kept the file's value, because that object
  is assembled from the `.env` files at config time. Pointing `envDir` at a
  directory with no env files under `VITEST` clears the files.

  **That was half the fix, and I reported it as the whole one.** `envDir` governs
  `.env` files only; Vite also exposes any *shell* variable matching `envPrefix`,
  so `VITE_CONVEX_URL=… npx vitest run src/cloud` still failed the
  unconfigured-path tests afterwards — measured, not assumed. `vite.config.ts`
  now also deletes every `VITE_*` key from `process.env` when `VITEST` is set,
  which works because that module runs before Vite resolves the env it hands to
  `import.meta.env`. Nothing legitimate is lost: no test can rely on a `VITE_*`
  value in `import.meta.env` anyway, since `test.env` reaches only `process.env`
  and `vi.stubEnv` reaches neither — injection goes through
  `createConvexCloud({ url })`, which is how the configured-path tests already
  work.

  Verified both ways: with a shell export *and* a real `.env.local` present, all
  504 cloud tests pass; without them, the same.

  **Audited `07-cad-capability.md` while there.** Findings 2 (lever arm), 5
  (BrickLink export and archive), 8 (dropped import metadata) and most of 10
  (measured per-connector clearance) are already implemented — `statics.ts` has
  `momentGramLdu` and a per-family `CLUTCH_FAMILY_WEIGHT`, `bricklink.ts` and
  `archive.ts` exist, `ImportReport.ignoredMeta` is tracked and surfaced. The
  live ones are 1 (flexible parts), 4 (price and availability), 6 (pack-selection
  floors), 7 (insertability) and 9 (edge LOD).

- **The geometry cache was a leak on both sides.** `GeometryCache.states` was a
  plain `Map` held for the tab's lifetime with no eviction and no `dispose()` —
  so the decoded buffers accumulated on the heap and their uploaded copies stayed
  on the GPU, and a long session got heavier the longer it ran and never
  recovered. Today's pack is 48 MB compiled for 900 parts; CI already records the
  plan to widen it toward ~900 MB.

  Bounded now, with the failure mode that matters guarded structurally rather
  than by convention: evicting geometry something is still drawing empties the
  viewport, so callers that hold a `PartGeometry` past the call that returned it
  `retain` it, and only unretained entries are candidates. Least recently used
  first, only far enough to get back under budget. Sizes are measured from the
  actual buffers, not the asset's packed file size, because what a session
  accumulates is the decoded form.

  The two renderer hooks were byte-identical copies of each other, so unifying
  them into `usePartGeometry` put the retention in one place instead of two. The
  exporter needed it too and did not obviously look like it: it loads every
  definition in a loop and *then* renders, so without a hold a large enough model
  would evict the parts loaded first before the booklet read them — and its
  `geometry()` callback answers null for a missing part, which would have
  printed a guide with holes rather than failed. Where an export's own working
  set exceeds the budget, the budget yields.

  The default is 192 MB, which does not bite on the current catalog. That is the
  intent: bound the growth, don't evict what fits.

  **Audited `01-architecture.md`, `02-performance.md` and parts of `06`.** Nearly
  all of it is already done — the boot-path project scan, the batched IndexedDB
  cleanup, instanced-batch slack capacity, selector-based subscriptions,
  `clamp` in `math.ts`, the dead route exports, delete confirmations, the
  "Codex" naming. Two corrections worth recording:

  - **Finding 7 of `01` is misdiagnosed.** It says collision math uses
    `THREE.Matrix4/Vector3/Line3` for what `src/cad/math.ts` already does, effort
    M. Those uses are incidental; the load-bearing dependency is `MeshBVH` from
    `three-mesh-bvh` on line 2, which the finding never mentions and which
    *requires* `THREE.BufferGeometry`. Dropping the import means reimplementing
    BVH triangle-pair intersection in safety-relevant code — not M, and not worth
    it. Measured: `src/generation/engine.ts` reaches `three` via
    `collision.ts → mesh.ts`, and three's core imports fine without a DOM, so
    "generation must work headless" holds; the cost is bundle size in a worker,
    not brokenness.
  - **Finding 6 of `01` costs 1,518 errors.** Measured with
    `noUncheckedIndexedAccess` on: 254 in `features`, 213 in `cad`, 210 in
    `editor`, 135 in `refinement`. Mechanically silencing those with `!` would
    hide the bugs it exists to find, so it stays open as written — the doc's own
    "adopt per-directory" advice is right.

- **Presence was built, tested, and rendered nowhere.** `src/cloud/presence.ts`,
  `convex/presence.ts`, `PresenceSession`, `presenceView`, follow-mode and the
  behind/ahead derivation were all complete and covered; no component mounted
  any of it, so two people editing the same project had zero visibility into
  each other. Shipped the roster half — who is here, their colour, whether they
  are ahead of or behind you, what they have selected, and a follow toggle that
  jumps to their selection. Viewport cursors are the other half and belong to
  the renderer.

  Every failure on that path degrades to "You are the only one here" rather than
  to an error surface. That is not laziness about error handling: presence is
  the one thing in this workstream allowed to be lost, and from the roster's
  point of view "the deployment is unreachable" and "nobody else is here" are
  genuinely the same fact. The Share panel already owns the explanations and the
  repairs.

  **Writing the test found a real bug in the reducer's clock.** `presenceView`
  compares a server-issued `expiresAt` against the browser's own `Date.now()`.
  A machine thirty seconds fast shows an empty room; one thirty seconds slow
  keeps ghosts. The TTL *is* thirty seconds, and browser clocks are routinely
  off by more than that, so it is not hypothetical. The panel now reconstructs
  the server's clock from the newest `expiresAt` in each response and advances
  it with local *elapsed* time — only differences in the browser's clock are
  trusted, which is the one thing it is reliably good at. It errs toward keeping
  a peer a moment longer, which is the right direction for a roster.

  A test premise was wrong too, and correcting it clarified the design: I first
  asserted the client drops a peer the server still returns. It should not —
  while the deployment is answering, its word is final. The client-side expiry
  exists for the *offline* case, a held list ageing out, and that is what the
  test now covers.

  **Audited `08-cloud-collaboration.md`.** Findings 4 (byte-accurate chunking),
  5 (branch-scoped snapshot index and seeded checkpoints), 6 (no unbounded
  `.collect()` left in `convex/`) and 9 (the members and invitations UI) are all
  already done.

- **Keyboard camera commands were a frame behind, only when motion is off.**
  `camera-controls` records a target and lets the next frame interpolate toward
  it. With animation on that is the point; with it off there is nothing to
  interpolate, yet `camera.zoom` still does not move until something renders.
  `ViewportControls` already forces `control.update(0)` on the named-view path
  for exactly this reason — the keyboard path made the same promise and did not
  keep it, so a keyboard zoom or orbit was a no-op for one frame and anything
  reading the camera in between saw the old pose.

  Found by the e2e suite failing on "keyboard zoom changes orthographic scale",
  which had passed twenty minutes earlier — a race, not a regression from the
  change I happened to make in between. Worth recording how it was diagnosed,
  because two of my first three hypotheses were wrong: I blamed the new presence
  panel (removing it changed nothing), then inherited browser state (the harness
  opens a fresh context at `?doc=blank`). Instrumenting instead of guessing gave
  it away in one run — `before` and `after` were bit-identical and `distance`
  was pinned at its clamp, which is not what a partly-applied animation looks
  like. My first instrumentation was also useless: I sampled `document.activeElement`
  *before* calling the helper that sets focus, and read `defaultPrevented` from a
  window capture listener that runs before the canvas handler could set it.

- **The Workspace menu was completely unclickable.** `.toolbar-island .toolrail`
  set `overflow-x: auto; overflow-y: visible`, which does not mean what it reads
  as: when one axis is `visible` and the other is not, CSS computes the `visible`
  one to `auto`. The rail became a scroll container on *both* axes and clipped
  its own popover, which is absolutely positioned inside it. Measured with
  `elementFromPoint`: every sample from the top of the menu to the bottom
  returned the canvas, so Command deck, Keyboard shortcuts, render mode and the
  Export Center were all unreachable at every window width.

  Fixed by not clipping at all and letting the groups shrink instead — measured
  at 1024, 1280 and 1600px, `scrollWidth === clientWidth` at each, so the
  horizontal scroll the declaration was reaching for was never load-bearing.

  This is the second bug tonight caused by a CSS pair that silently does
  something other than what it says; the first was the focus ring's forced
  `border-radius`. Worth remembering that a stylesheet has no type checker.

- **The e2e suites had rotted, and were hiding real behaviour.** Running them
  found seven distinct problems. Three were live app defects (the clipped
  Workspace menu above; keyboard camera commands a frame behind, recorded
  earlier; `workspace_reveal('inspector')` landing on whatever tab was last
  used, so an agent got a different answer depending on history it could not
  see — `'health'` set its own view and `'inspector'` did not).

  The rest were stale tests asserting a world that had changed:

  - `.viewport-title-block p` — the title block now renders a *button* naming
    the selection and only falls back to a `<p>` when nothing is picked, so the
    selector returned nothing exactly when a selection existed. Four sites in
    `renderer.mjs`, three in `e2e-smoke.mjs`.
  - `getByRole('button', { name: 'Undo' })` matched two elements once the
    history timeline held a transaction *labelled* "Undo: Transform part".
    Accessible-name matching is substring-based, so the locator was capturable
    by document content. Scoped to `.history-tools`.
  - `.placement-hud` renders nowhere — it existed only in CSS and the e2e, at
    HEAD too, so that assertion had been dead for a while. Pointed at
    `.placement-bar`, which is what `PlacementBar.tsx` actually draws, and
    deleted the 82 lines of dead CSS that were still shipping.
  - Generate/Refine/Agent now default to open; the smoke still asserted the old
    "starts collapsed" decision.
  - A diagnostic `pick()` after a click reported the *next* thing behind what
    the click chose, because `pick` deliberately cycles through depth and the
    click had already advanced it.
  - `screenPositionOf` sampled mid-animation, because the test never called
    `settle()` — which the API's own docstring tells you to do. Measured: the
    flap projected to y = −845 in a 712px canvas.

  **The most interesting one.** A numeric-transform check moved a part by an
  arbitrary `+60` LDU, and the kernel refused it three times in a row as I
  chased it — hovering with no clutch, then interpenetrating another part, then
  breaking the hard 10 × 14 stud envelope. Every refusal was *correct*. The test
  now derives its target from the document: step inward one stud at a time and
  take the first unoccupied cell, so all three refusals are ruled out by
  construction rather than by hoping. A test that asserts a hardcoded coordinate
  is legal is really asserting that the model never changes.

  I also got two diagnoses wrong before measuring, and both are worth recording
  as method: I blamed the presence panel for the camera failure (removing it
  changed nothing), and I "fixed" the cycling pick with a `resetCycle()` that
  turned out not to be the cause — though it was needed anyway, for the reason
  I had guessed rather than confirmed.

- **12.8 KB of dead CSS deleted, with proof.** `workbench.css` carried 87 rules
  and one `@keyframes` for UI that no longer exists — the old validation and
  statics panels (replaced by `ModelHealthPanel`), the viewport chrome that was
  deliberately stripped, the old boot screen, proposal cards, render and grid
  pickers. 8,687 → 8,058 lines, 187,787 → 175,018 bytes, and it ships on the
  editor's critical path.

  Recorded mostly for the *method*, because a naive sweep would have broken the
  UI. Three passes were needed:

  1. Textual: 30 of 368 classes have no reference in any component.
  2. But `view-compact`, `tier-catalogued` and `tier-modelled` are built by
     fragment — `` `parts-grid view-${view}` `` — so their names appear nowhere as
     literals and a sweep cannot see them.
  3. Scanning for *every* hyphen-before-interpolation in `src` then found a
     fourth prefix I had asserted did not exist: `` `dock-scroll right-dock-${rightTab}` ``
     in `Workbench.tsx`. So `.right-dock-design` and `.right-dock-object` were
     two more live classes one step from deletion. My "only `view-` and `tier-`"
     claim was wrong, and only the exhaustive scan caught it.

  The apparent "references" in the first check were all stale `.vercel` build
  output, docs, and my own queue note listing the candidates. The build-output
  hits are in fact *evidence of death*: a class compiled into an older bundle but
  absent from current source means the component that used it was removed.

  Verified by screenshotting five editor states with the WebGL canvas masked,
  before and after: byte-identical every time, through both passes. That is the
  check this needed, and it is repeatable rather than a matter of someone's eye.

- **Single-part placement asked the whole document three times.** `rejectionFor`
  called `floatingPartIds`, `airbornePartIds` and `unclutchedRestPartIds`, each
  of which answers for every part in the model, and then checked membership for
  the one part just placed. `airbornePartIds` walked a connected component *per
  part* while doing it. Measured on a 924-part document with a fresh object per
  call, warmed and alternated so neither path paid for the other's cold start:
  **26.4 ms → 14.5 ms**, and twenty parts now cost 15.5 ms rather than twenty
  times one, because the derivation, the bounds pass, the ground plane and each
  island walk are shared.

  `hoverVerdictFor(document, partIds)` is defined as the same answer restricted
  to those parts, and that is *checked* rather than asserted:
  `validation.scoped.test.ts` runs both paths over eight documents — a grounded
  stack, a brick hanging in air, a self-clutched island beside a grounded one, a
  brick resting on a studless tile, a part with no compiled geometry, the
  showcase model — and requires them to agree part by part, both all-at-once and
  one at a time.

  That test immediately earned its keep: it found that **the two existing
  functions disagree with each other** about a part with no compiled geometry.
  `floatingPartIds` excuses it (`if (!box.measured) return false`);
  `airbornePartIds` iterates every part and so accuses it, because an unmeasured
  part cannot be in the grounded set. I reproduced the inconsistency rather than
  fixing it: a performance change that quietly redefined what counts as
  unsupported would be indistinguishable from a bug in the realiser. It is its
  own finding, below.

  Guarded by a *ratio* in `performance.test.ts`, not a millisecond ceiling —
  that file already records two CI failures caused by absolute budgets measuring
  the runner instead of the code. Measured ~0.55 scoped against ~1.0 unscoped,
  so 0.85 discriminates on either machine; verified non-vacuous by making the
  function do the whole-document work and watching the guard fail.

  **The proof that mattered:** `node tools/build-demos.mjs --check` reports *a
  fresh build is byte-identical to the committed assets* across all six demos,
  726 to 11,493 parts. 22,245 parts of generated model reached exactly the same
  acceptance decisions through the collision, disconnected and unsupported
  gates. That is a stronger statement than any unit test in this repo.

- **Candidate generation was 61–91% one memo miss. Detail-heavy briefs went
  from 9.2 s to 1.8 s.** The whole story here is a correction, and the wrong
  turns are the useful part.

  I started from the queue's own note, which said the cost was three
  whole-document validation calls in `rejectionFor`. Scoping them to the placed
  part measured 26.4 ms → 14.5 ms *in isolation*, which looked like the win.

  Then I ablated the verdict inside a real candidate and got 29–45% of wall
  clock, and reported that. **That number was wrong.** Stubbing a function that
  *gates acceptance* does not only remove its cost — nothing is rejected, so
  nothing is retried, and the build takes a shorter path. I had measured a
  behaviour change and called it a cost.

  Instrumenting instead of ablating gave the real split: the verdict was **1–2%**.
  It looked cheap because `findCollisions` runs first in `rejectionFor` and
  derives connections for the same document object, so the verdict was getting a
  memo hit the whole time. Measuring *inside* `findCollisions` found it:
  `deriveConnections` was **8,361 ms of a 9,161 ms candidate** across 403 calls,
  while the broad phase was 178 ms and the narrow phase never ran.

  So the derivation was the target after all — but its consumer was the collision
  check, not the verdict. `findCollisions` now accepts pre-derived `mates`, the
  realiser maintains one `IncrementalConnectorWorld` synced only to the parts
  that just landed, and **both** consumers are fed from the same overlay. Feeding
  only one moves the cost rather than removing it, because it is the same
  derivation — which is why I reverted the adjacency work once, before finding
  the collision call, and then restored it.

  Measured after: farmhouse 1243 → 901 ms, big tower 2343 → 1782 ms, detail-heavy
  shop **9161 → 1790 ms (5.1×)**.

  Multi-part placements deliberately keep the full derivation. Mates *among* the
  new parts are not in the committed index yet, so an overlay would report a
  bonded wall's own stud overlaps as collisions and throw it away. A region
  amortises a derivation over hundreds of parts; a single detail part cannot.

  **Verified:** `hoverVerdictFor` and `findCollisions` give identical answers
  supplied as derived, on three real generated models; two independent realisers
  produce byte-identical operations and structural hashes; a bulk-fill brief
  still reports zero collisions. And the bar that actually settles it —
  `tools/build-demos.mjs --check` reports *byte-identical to the committed
  assets* across all six demos, 22,245 parts.

- **A model using elements this pack does not carry read as a broken model.**
  `airbornePartIds` accused any part whose geometry is not compiled: it cannot be
  in the grounded set, and having no compiled connectors either it forms an island
  of one, so it came out "airborne". `floatingPartIds` excused exactly the same
  part. The two disagreed, and `rejectionFor` ORs them.

  What made it worth fixing rather than noting is what sits on top.
  `describeLDrawImport` says *"N hovering parts with no clutch"*, and
  `modelHealth` offers *"exact connection graph and measured bounds"* as its
  evidence — for parts that have no measured bounds. So importing a real model
  built from parts outside this 900-identity pack reported it as full of
  hovering bricks, which is a claim about the model when the truth is a gap in
  the catalog. That is the one thing this project is careful never to do:
  elsewhere an unverifiable collision is reported as `unknown` certainty rather
  than as a fault.

  Now only measurable parts are accused, in all three verdicts. A genuinely
  airborne island is still reported — by its measured members, which is also the
  only useful answer for a viewport that has no mesh to highlight for the rest.
  No existing test depended on the old behaviour, which is itself the finding:
  the disagreement had never been pinned either way, so the new rule is asserted
  explicitly rather than left implied by an equality check.

- **Nothing was watching the pack for dropped parts.** `07-cad-capability.md`
  finding 6 says the runtime pack is chosen by how often a part appears in
  official set inventories, that the ranking has already failed once — a
  recompile against a refreshed LDraw library reshuffled it and the showcase
  rover's windscreen fell out, fixed by pinning that one part by hand — and that
  "unlike the showcase, nobody is watching to pin it back."

  Checked, and that is literally true. `manifest.test.ts` installs the full pack
  and compares `catalogVersion`, which passes whether or not the pack still
  carries what the demos reference, because it compares a version *string*. And
  the demo builder, which would catch it, **does not run in CI** — grepping the
  workflow for it finds nothing. So a reshuffle that dropped a structurally
  important part would ship as a showcase full of `GEOMETRY_UNAVAILABLE` holes
  and be found by a visitor.

  Added the watcher: every `definitionId` in every committed demo document must
  resolve in the compiled pack. It distinguishes the two failures that need
  different fixes — modelled by LDraw but outside this pack (a ranking accident,
  one line in `packExtra`) versus not in the catalog at all — and names the
  instance count and which demos break, so the failure message is the whole
  diagnosis.

  Verified by pretending the pack had dropped the part the demos use most:
  *"3005: 854 placements in iron-lattice-lookout, harbour-control-tower,
  harbour-street, illinois-main-quad — modelled by LDraw but not in this pack;
  pin it in packExtra"*. A guard that cannot fail is not a guard.

  This does not implement finding 6's proposed fix (category and family floors in
  the compiler, which needs a recompile against the full 22,941-identity library
  I cannot run here). It closes the hole the finding is actually worried about.

- **Deleted `EDGE_RENDER_BUDGET`.** Finding 9's binary edge cutoff is gone —
  `EdgeLod.tsx` budgets edge vertices by projected screen size and frustum
  visibility instead. The old constant survived as an `@deprecated` export with
  zero readers, which is worse than no constant: it is the first thing a grep
  finds, and it describes behaviour the renderer no longer has.

- **The demo determinism gate now runs in CI.** It existed and never ran. The
  showcase is *generated*, not authored, and 46 MB of it is committed, so "the
  generator still produces exactly this" is a property no unit test can assert:
  `manifest.test.ts` re-validates the committed documents against the kernel,
  which catches a hand-edited asset, but it reads the files rather than
  rebuilding them, so it cannot catch the generator drifting away from what was
  published.

  It is the check I leaned on three times tonight to prove the realiser rewrite
  changed nothing — which is exactly the argument for it being a gate rather than
  something I happened to remember to run. `--check` builds into a temporary tree
  and diffs, so it cannot dirty a checkout, and it needs only the catalog assets
  the preceding step already verifies. Measured: 11 s.

  **Audited the rest of the workflow against `package.json`.** Everything else
  that is missing is missing on purpose: `test:live:*` need API keys,
  `verify:all` is the GPU machine's job as its own comment says, `catalog:*` are
  authoring tools. One genuine gap remains, below.

- **`npm run check` — the command CI runs — was losing 10 tests.** This file's
  own standing rules told me to pass `--maxWorkers=2`, and that is exactly why
  nobody noticed: the workaround was in the instructions rather than in the
  project, so the command everyone actually runs, including CI, used vitest's
  default pool. On a 14-core machine that spawned enough workers to time out ten
  tests, with `import` alone at 290 s — several suites load the shipped 48 MB
  catalog *per worker*, so the ceiling is memory and import bandwidth, not cores.

  Measured, not guessed: default → 10 failures; `maxWorkers=7` → 3; `4` → all
  2,906 pass in 208 s, which is also **faster** than the `--maxWorkers=2` that
  had been used as the workaround all night. Slower is not safer here; the
  workaround was over-correcting.

  Now `maxWorkers: '25%'` in `vite.config.ts`. A percentage so it scales *down*
  to a two-core runner rather than over-subscribing it, and in the config rather
  than an npm script so `npx vitest run` — what anyone debugging one file types
  — gets the same pool as the gate.

  **Four of the ten were my own test.** `realize.incremental.test.ts` realises
  real models, which is seconds of work, against vitest's 5 s default. It passed
  alone and failed whenever the pool was busy — the worst kind of test, because
  it reads as flake and gets re-run rather than fixed. The heavy cases now carry
  explicit 60 s allowances, which is what the archetype eval already does for
  exactly this reason.

- **The edge-budget tests covered the abandoned allocator, not the shipped one.**
  `quality.ts` had two: `allocateEdgeBudget`, all-or-nothing per batch, and
  `allocateEdgeVertexCounts`, which grants a partial vertex count.
  `EdgeLodProvider` — the thing that decides whether a model shows outlines at
  all — calls the second. The first had **no production caller** and **four
  passing tests**; the second had **none**.

  That is worse than untested code, because the four green tests read as coverage
  of "the edge budget" and are the reason nobody looked. Same shape as the
  `jointFor` gap found at the start of the night: a file with tests, but not for
  the function that matters.

  The dead one is deleted, its four behaviours re-asserted against the live one,
  and the two properties only the live one has are now covered:

  - **Partial grants.** The old allocator *skipped* any batch bigger than the
    whole budget, so the largest thing on screen was the one thing with no
    outlines. Asserted: a 4,000,000-vertex batch against a 1,000,000 budget gets
    1,000,000, and five 400k batches split as 400k/400k/200k/0/0 — nearest first,
    total exactly the budget, rather than everyone getting a slice too thin to
    read.
  - **Whole line segments only.** The count goes to `setDrawRange`, which counts
    *vertices*, and an edge is two of them. An odd grant would draw a line from a
    real corner to nowhere. Asserted: 999 vertices against a 501 budget yields
    500, not 501.

  Also documented a behaviour *difference* the swap introduced: where the old
  allocator chose `near` and dropped `far` entirely, the new one gives `far` the
  100,000-vertex remainder. That is the intended improvement, and now something
  says so.

- **The screen-extent measurement over-reported by exactly 2×.** Found by
  sweeping tonight's new modules for exported functions referenced only by their
  own tests — 20 candidates, most of them legitimate reset helpers, but
  `screenExtentPixels` in `quality.ts` had two passing tests and no production
  caller, while `EdgeLod.tsx` computed the same quantity inline.

  My first framing was wrong and measuring fixed it: they are not two different
  algorithms. The helper is the closed form of the inline projection, and against
  a known frustum the two agreed *exactly* — at **214.5 px for a sphere whose
  true extent is 107.2**. NDC runs from −1 to 1, so the viewport is two units
  tall, and both multiplied an NDC delta by the full viewport height.

  A constant factor is invisible to the tests that existed ("grows with world
  size and shrinks with distance"), which is the general lesson: a test that
  only checks the direction of a change cannot see a wrong unit.

  Replaced by `ndcHeightToPixels`, which divides by two, is called by the
  renderer, and is asserted on exact values. The perspective-only helper is
  deleted — it would have been wrong for the orthographic camera the editor
  actually has, where apparent size does not fall off with distance at all.
  `minScreenPixels` went 18 → 9 in the same change, so the correction is a change
  of *units* and not of behaviour: 18 old units and 9 new ones are both nine real
  pixels. Verified behaviourally — the 11k-part model still retains its edges.

- **`checkCaptureSet` encoded a capture rule the acceptance run had already
  disproved.** It required all six render modes to produce distinct pixel hashes,
  including `violations` — which draws *collisions*, so on a clean model it has
  nothing to add and is **correctly identical to `beauty`**. Requiring it to
  differ is requiring the diagnostic to invent something.

  `tools/e2e/renderer.mjs` had worked that out and encoded the correction inline,
  with a good comment explaining it. The shared helper never learned it, and
  nothing called the shared helper — so the wrong rule sat there passing its own
  tests. Its fixture happened to give `violations` its own hash, which is exactly
  how a wrong rule survives: the test never exercised the case that disproves it.

  The rule now lives in one place and cuts both ways — `violations` **may** match
  `beauty` at zero collisions and **must not** when collisions exist, because
  then a match means the overlay is not drawing at all. It is held out of the
  generic distinctness pass in both directions so a reader gets one precise
  message instead of two overlapping ones.

  The acceptance run imports the function directly now. Node 26 executes the
  TypeScript source, so there was never a reason for two copies; verified against
  a real browser, which reports *"violations matches beauty, which is correct: the
  model has no collisions to flag."*

- **The tested-but-uncalled sweep, and where it ran out.** A script over `src`
  found 20 exported functions referenced only by their own tests. Two were real
  defects, already recorded above (the 2× screen-extent units, the wrong capture
  rule). The rest resolved as:

  - **Legitimate test-only helpers**, correctly exported: `resetChrome`,
    `clearCollisionGeometryCache`, `resetEmailTransport`,
    `resetRouteAnnouncement`, `resetHexclaveClientApp`, `geometryFromArrays`.
    Reset and fixture seams are supposed to look like this.
  - **`applyExclusiveDock`** — genuinely dead, and a trap. It collapsed a
    *restored* layout to a single sheet, folding over all of
    `DOCK_FOCUS_SECTIONS`, which includes the three Design sheets the default
    layout deliberately opens. Reviving it would have quietly closed two of them.
    Deleted with its test, and the reason noted next to the constant.
  - **`bestSnapTransform`** — a one-line pass-through over
    `findSnapCandidates(...)[0]`. Dead API surface, but its six tests do exercise
    the real ranking through it, so rewriting them buys nothing. Left alone.
  - **`saveLocalDocument`** — the pre-IndexedDB localStorage *writer*. Dead:
    `session.ts` imports only `loadLocalDocument` and `clearLocalDocument`, so a
    legacy document is read once and cleared and never written again. Its only
    other mention is a share-viewer test asserting the viewer does not reference
    it, and `cad/storage` is already forbidden there as a whole module, so the
    symbol check is redundant. Left for now: deleting it is right but it is
    entangled with that guard, and the guard is the part that matters.

  **A method note, because I got it wrong mid-sweep.** I briefly concluded that
  `chrome.ts` held a whole dead parallel dock-reveal implementation contradicting
  the live one — from a `grep … | head -8` whose truncation hid the two
  `Workbench.tsx` call sites. `applyDockFocus` and `applyChromeReveal` are both
  live, and `applyWorkbenchReveal` already exempts the Design sections
  explicitly, which is exactly the reconciliation I thought was missing. Never
  reason about absence from a truncated list.

- **An unlisted share token could reach the edge log drain.** `tokens.ts` claims
  *"Tokens never appear in analytics or logs. `redactShareUrl` is applied at
  every boundary that could echo a URL."* The analytics half is true and better
  than the claim — `assertEventVocabulary` rejects any string outside a closed
  allow-list, so a URL cannot enter an event at all without throwing. The logging
  half had a hole.

  `functions/_lib/log.ts` ran `redactEdgeText` over `detail` and `cause` and
  wrote **`path` verbatim**, and `redactEdgeText` had no rule for `?t=` at all —
  its patterns cover `sk-ant-`, `sk-`, `Bearer`, JWTs and the proxy secret. So a
  share token was redacted by nothing on this path. It was safe only because both
  call sites happen to pass `URL.pathname`, which drops the query: safe by
  circumstance rather than construction, in the one file whose entire job is not
  leaking secrets.

  `respond.ts` states the stake in its own docstring — *"A stack trace or a log
  line carrying `?t=<secret>` hands out a working unlisted link"* — and applies
  `redactShareUrl` to every echoed request path. The log boundary simply had not
  been given the same treatment.

  Both now: `path` goes through `redactShareUrl`, and `redactEdgeText` gained a
  `?t=` rule so a token arriving inside a message or a thrown cause is caught
  too. Four tests in a new `functions/_lib/log.test.ts` — the first tests this
  file has ever had — including that redaction does not eat the rest of the
  diagnostic, since a log line scrubbed into uselessness is its own failure.
  Verified by reverting: two of the four fail.

- **The statics report printed binary-floating-point tails at the operator.**
  `studs` is a stud-*equivalent* total, because families do not hold equally — a
  pin counts 1.4, a bar-and-clip 0.7. Three clips therefore total `0.7 * 3`,
  which is `2.0999999999999996`, and that went straight into the sentence beside
  a capacity of `209.99999999999997` g. A model-health report showing seventeen
  decimal places has undermined itself before it reaches the advice, and this is
  the module whose whole job is being trusted.

  The naming was wrong as well: *"2.1 studs"* describes something that does not
  exist, since what the model has is three clips. A fractional total now reads
  "2.1 stud-equivalents" and a whole one still reads "2 studs" — renaming every
  count would be its own inaccuracy. `capacityGrams` is rounded to whole grams,
  the precision the 100 g assumption it derives from actually supports.

  **I wrote a vacuous test first, and caught it the same way as before.** The
  original asserted over `analyseStatics(...).overloaded` for a clip fixture that
  produces *no* overload, so the loop body never ran and it passed with the fix
  reverted. Every fixture in this suite that reliably overloads does so through
  plain stud stacking, where the count is a whole number, so the integration path
  cannot reach this defect at all. The test now drives the formatting unit
  directly with the raw float sums, and fails when reverted. Second time tonight
  that "assert inside a loop over a computed list" hid an empty list; worth
  treating as a habit to distrust.

- **Every whole-document extent helper was an argument spread, which is both
  16× slower and a hard ceiling.** `getDocumentBounds` and the three ground-plane
  scans were written as `Math.max(...bounds.map(…))` — one argument per part.

  Measured on 11,493 parts: **0.587 ms against 0.036 ms** for a single-pass loop,
  identical result, because the spread form walks the array six times and
  allocates six argument arrays. `checkEnvelope` calls `getDocumentBounds` on
  *every* generation placement, so that cost is paid thousands of times per
  candidate.

  The ceiling is the more serious half. `Math.max(...a)` throws
  `RangeError: Maximum call stack size exceeded` past roughly 100,000 arguments —
  measured on this engine, between 100,000 and 125,000. Nothing reaches it today
  (the largest demo is 11,493 parts), but the failure mode if anything did is the
  *kernel* throwing during validation, taking the editor with it, in response to
  nothing worse than a large imported model. Generation is bounded by
  `MAX_GENERATED_PARTS = 4000`; import and duplication are not.

  Replaced in `geometry.ts`, `capabilities.ts`, `validation.ts` and `statics.ts`,
  including the ground-plane scans on the commit path. `src/cad/scale.test.ts`
  builds a **130,000-part** document — not a performance target, just the
  smallest size that proves the ceiling is gone — and fails with the exact
  `RangeError` when one spread is restored. `describeSupport`'s spread is left
  alone: it walks a convex hull, not the part list.

- **Regression guards for the two fixes that had none.** Most of tonight's
  changes came with tests; two did not, and both had failure modes nobody would
  notice quickly.

  **The overflow footgun, guarded at the CSS source.** There is no cheap runtime
  check — jsdom implements no layout, so only a real browser can observe the
  clipping — so `src/editor/workbench/overflow.test.ts` scans the declarations
  across five stylesheets for any rule setting one overflow axis `visible`
  against a clipping other. It catches the class, not just the one rule.

  **My first version reported the broken file as clean.** Two causes, both found
  by reintroducing the defect: the rule now carries a comment *quoting* the
  offending pair, and comment text was read as declarations; and the property
  matcher required a `;` immediately before the property, so a declaration
  following a newline or a `{` was invisible. Third time tonight that "prove the
  guard fires" caught a guard guarding nothing — it is not an optional step.

  **Test-environment hermeticity, asserted directly.** `src/test/environment.test.ts`
  requires that no `VITE_*` variable reaches `import.meta.env` or `process.env`
  and that `convexUrlFromEnv()` is null. Both halves of that fix were
  non-obvious, and its failure mode was that only the person working on the cloud
  path would ever see it break. Verified by removing the strip and running with a
  shell export: all three fail.

  **One fix left with only an e2e guard, deliberately.**
  `workspace_reveal('inspector')` resetting to the Object tab lives inside a
  1,000-line component, and `tools/e2e-smoke.mjs` already covers it — its
  `.selection-identity` wait only succeeds on that tab. Mounting the whole
  workbench for one assertion is worse than a precise comment, so the coupling is
  now documented at the line instead.

- **Removed the last dead function, `saveLocalDocument`.** The pre-IndexedDB
  localStorage *writer*, with no caller: `session.ts` imports only
  `loadLocalDocument` and `clearLocalDocument`, so a document left by an older
  build is migrated once and the key cleared. Keeping the writer implied the app
  still kept a copy there.

  I had deferred it as "entangled with a guard", and checked properly rather than
  leaving that standing. The share-viewer test named the symbol *and* banned the
  whole `cad/storage` module; with no `src/cad` barrel to re-export through, a
  reference is impossible without the module, so the symbol assertion was
  redundant. Both removed, and `storage.ts` now opens by stating what it is — a
  key read once and retired.

### Open

- **The renderer acceptance gate is failing on sustained frame rate, and it is
  the machine, not the code.** `tools/e2e/renderer.mjs` wants 30 FPS p5 at 5,000
  parts and is measuring 20–27. Established by reverting my edge change and
  re-running: it fails at 27.0 FPS p5 *without* it. The renderer's own cost is
  unchanged — 10.8–11.7 ms drained, against 8.8–11.7 ms in runs hours earlier —
  so what has collapsed is the presentation loop, on a machine that has been
  running browsers and test suites continuously since 22:00 (15-minute load
  average 6.9, no thermal warning recorded).

  This suite is deliberately **not** in CI for exactly this reason; the workflow's
  own comment says the timing targets belong to `npm run verify:all` on a machine
  with a GPU. It passed repeatedly earlier tonight at p5 55–104. Worth re-running
  on a rested machine before believing anything about it either way.

- **`format:check` is decorative: it fails on 435 files.** The repo declares
  Prettier, ships `npm run format:check`, and the code does not satisfy it — so
  it can never be a gate, and anyone who runs `npm run format` produces an
  unreviewable diff. Measured by sampling 25 files (792 changed lines, ~32 per
  file) across the 329 failing `.ts`/`.tsx` files: a full reformat is on the
  order of **10,000 lines**.

  The config itself is not the problem — 120 columns, no semicolons, single
  quotes, trailing commas, and the files written tonight pass it untouched. The
  history simply was not written through it.

  Not doing the reformat: it would bury every real change in churn, and that is
  the operator's stated preference. The useful fix is probably a
  `format:changed` script over `git diff --name-only`, so a contributor can
  format what they touched without rewriting the repo — but adding a workflow
  script is a call for whoever owns the contribution guide, not something to
  slip in at 4am.

- **`01-architecture.md` finding 5's fix does not work, and the finding is
  otherwise right.** It says `tsconfig.node.json` blanket-includes `"src"`
  alongside `tsconfig.app.json`, so nearly the whole app is type-checked twice on
  every `tsc -b`. Verified: 802 `src` files in the app project, **773** in the
  node one. Its worse half is also real — node adds `"types": ["node"]`, so
  browser source is checked once *with* Node's ambient globals in scope.

  Its one-line remedy — "TypeScript still resolves the genuine `server/**` →
  `src/**` cross-imports transitively without `src` being a root entry" — is
  false for a `composite` project. Removing the entry gives **TS6307**: *"File
  'src/platform/contracts.ts' is not listed within the file list of project
  tsconfig.node.json. Projects must list all files or use an 'include'
  pattern."* Composite projects must enumerate every file they compile;
  transitive discovery is exactly what they forbid.

  The proper composite answer is for node to *reference* the app project and
  consume its declarations — but both projects set `noEmit: true`, so there are
  no declarations to consume, and turning that on means emitting `.d.ts` output
  the repo does not currently produce. Enumerating the needed `src` subtrees
  instead is 487 files by transitive closure, which is most of `src` again with a
  maintenance burden attached.

  Measured what the fix would have bought if it worked: `tsc -b` CPU 12.45 s →
  8.14 s, about **1 second of wall clock** on this machine. Not worth emitting
  declarations for. The double-check is the price of two `noEmit` composite
  projects sharing a source tree, and that is worth writing down so the next
  person does not spend the same twenty minutes discovering TS6307.

- **Three more absolute claims checked; all three hold.** Worth recording that
  the audit is not only a defect-finder — for a security claim, "verified true" is
  the useful outcome.

  - *"Tokens never appear in analytics"* (`tokens.ts`) is enforced more strongly
    than the sentence suggests: `assertEventVocabulary` rejects any string field
    whose value is outside a closed allow-list, so a URL cannot enter an event at
    all without throwing. Structural, not redaction.
  - *"`tok:<id>` — the hash only, never a secret"* (`kv-store.ts`) is enforced by
    the type: `ShareTokenRecord` carries `secretHash` and has no field a
    plaintext secret could occupy.
  - *"Every method returns a `CloudResult` and never throws"* (`convexClient.ts`)
    holds on both paths. `ask`/`tell` convert throws to typed transport failures,
    and the seven list methods that instead go through `collectCloudPages` are
    covered by *its* top-level catch — which also has a `finally` that clears its
    deadline timer, refuses a malformed page, detects a stalled cursor and a
    repeated identity, and will not return the successfully read prefix as if it
    were the whole list.
  - *"The live camera is never mutated"* (`idPass.ts`) holds: `preparePatchCamera`
    only reads `source`, and every write lands on a reused clone.

- **`01-architecture.md` finding 6 is about type honesty, not a lurking crash.**
  Its 1,518 errors are real (measured earlier), but the finding's framing — "a
  stale part id flowing through as if defined is caught nowhere but by manual
  discipline" — suggested live crash paths worth hunting individually, and the
  four sites it names are stale line references that have since moved.

  So I scanned for the pattern instead: `parts[expr].member`, an index result
  dereferenced with no guard. **37 sites, all safe.** Most take ids from the same
  document (`Object.keys(document.parts)`, `regionPartIds`), and the ones that
  take an id from outside are guarded — `selection_geometry` gates on
  `else if (document.parts[token])` before naming the definition, `commitTransforms`
  short-circuits on `!snapshot.document.parts[op.partId] ||`, and
  `mirror_selection` goes through `scopedPartIds`, which throws `PART_NOT_FOUND`
  for an unknown id.

  That is worth writing down because it re-prices the finding. Turning the flag on
  would make the compiler agree with what the code already does; it would not fix
  a bug, and mechanically silencing 1,518 errors with `!` would *remove* the
  discipline that is currently keeping this correct. Still worth doing eventually,
  as a soundness change with a careful triage — not as a defect hunt.

### Considered and deliberately left alone

- **The security corpus** (`docs/improvements/04-security.md`) has Critical and
  High findings, and the header ones (CSP, `X-Frame-Options`, HSTS, COOP in
  `public/_headers` and `vercel.json`) look inviting because they are config.
  They are **not verifiable locally**: neither `vite dev` nor `vite preview`
  applies platform headers, so a change there could only be checked in
  production. Shipping unverifiable security config unattended is a worse trade
  than leaving it. The rest of that list — per-owner authorisation, server-side
  publication re-derivation, an atomic rate limiter — touches deployed auth and
  storage and wants a person watching.

- **Collapsing landing's `--bw-*` token set into the shared one.** ~200
  declarations across eight stylesheets with no automated visual check. The
  measurable half (contrast) is fixed and guarded; the rest is daylight work.

- **Widening the fixture broadly**, sampling a part from every category. It is
  the right stub for geometry and connector behaviour, its contents are
  commented with the reason each group is present, and a broad widening would
  perturb every test asserting a bill of materials. Adding one part to close a
  proven, specific hole is a different thing and was done above.

- **Vite's `INEFFECTIVE_DYNAMIC_IMPORT`** for `src/platform/not-installed.tsx`
  is not a defect. `routes.ts` documents the trade-off: the dynamic form keeps
  React out of that module's import graph, which `import-graph.test.ts` asserts
  and which lets the route table be read by tests without pulling the component
  tree. It buys no separate chunk, the build says so, and the code agrees.

- **Widening a prose-stated palette.** "A red farmhouse" means red *walls* to a
  person, not red windows — but `generation.test.ts` asserts no part falls
  outside `brief.palette`, and that contract is deliberate. Whether a colour
  named in prose is a preference or a constraint is a product decision, not one
  to change unattended.
