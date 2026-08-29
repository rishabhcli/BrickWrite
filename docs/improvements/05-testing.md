# Testing and quality assurance

Ten findings. The suite is large and genuinely good in places — 1,946 unit tests
across 131 files, plus five browser suites — so these are about *where it is
pointed*, not its size.

**Verified by hand:** `convex/` contains 3,531 lines across 18 files and **zero
test files**. `src/cloud/__tests__/fakeBackend.ts` is 1,740 lines.
`tools/e2e-smoke.mjs` holds 204 `assert()` calls in one file. There is no
`fast-check`, no `pixelmatch`, no `@playwright/test`, and no
`src/cad/connections.test.ts`.

> **Read finding 1 next to `04-security.md` findings 5 and 9.** Security found
> real authorisation gaps in `convex/` — anonymous identities accepted, unbounded
> `.collect()` reads. Testing explains why they survived: that code has no tests,
> and the 1,946 that exist assert against a hand-written reimplementation of it.

---

## 1. Test Convex authorisation against the real handlers, not a hand-written fake

**Evidence:** `convex/` — 18 files, 3,247 lines of handlers plus `model/` — has **zero** `.test.ts` files and no `convex-test` dependency. The security-critical `authoriseProject` gate (`convex/model/auth.ts:79-108`, with its NOT_FOUND-vs-FORBIDDEN split at `:15-19`) is never imported by any test. Instead `src/cloud/__tests__/fakeBackend.ts` (1,740 lines) independently re-implements the same rationale (`:337-341`, `:223-231`), and every `src/cloud/__tests__/*.test.ts` asserts against that fake.
**Why it matters:** A mutation that forgets to call `authoriseProject`, a wrong capability string, an inverted role check — all ship silently, because the tests exercise a parallel implementation that matches the *intent* of the server code and never the code itself. This is precisely the bug class that leaks a private project to a stranger.
**Change:** Add `convex-test` (or Convex's local backend harness) and write handler-level tests for `projects.ts`, `transactions.ts`, `members.ts`, `invitations.ts`, `comments.ts` that call the real `mutation`/`query` functions against an in-memory schema, asserting the NOT_FOUND/FORBIDDEN split and role checks directly.
**Effort:** L    **Risk:** Low, additive — the real risk is discovering the fake and the real implementation already disagree, forcing a fix.

## 2. Give the `emails.test.ts` browser-guard test a realistic timeout

**Evidence:** `src/platform/emails.test.ts:58-67` calls `vi.resetModules()` then `await import('./server/emails.server')`, forcing a cold uncached evaluation of `@hexclave/react` (117MB in `node_modules`, bundling Stripe/Radix/rrweb/ai-sdk per `vite.config.ts:46-53`). Measured in isolation on an idle machine: **1,494ms**, against 0–1ms for the file's other four tests. No `testTimeout` override exists, so it runs under Vitest's default 5,000ms.
**Why it matters:** Under parallel workers doing similar heavy transform work, that cost multiplies with CPU contention and intermittently crosses 5s — a false failure unrelated to the guard being tested. *(Observed twice during this session: failed in a full run, passed 5/5 in isolation in 2.37s.)* It erodes trust in a red CI and trains reviewers to re-run rather than investigate.
**Change:** Give this specific `it(...)` an explicit longer timeout (third argument, ~15,000ms), and/or move it to its own file so the `resetModules()` cost isn't shared with sibling parallelism.
**Effort:** S    **Risk:** Minimal — raising one test's timeout doesn't mask a hang in the other four.

## 3. Split `tools/e2e-smoke.mjs` so one failure doesn't hide the rest

**Evidence:** 1,797 lines, **204 `assert()` calls** across ~40 unrelated feature sections (landing routing, welcome dialog, catalog tiers, WebMCP surface, transform gizmo, collision kernel, export round-trip, accessibility, contrast, reduced motion — markers at `:58-1569`), all inside one `try { … } finally { server?.kill() }` (`:40-1795`) driving a single page. Contrast `tools/e2e/run-all.mjs:57-70`, which already runs sibling suites as isolated child processes with per-suite PASS/FAIL.
**Why it matters:** A regression in section 5 aborts every later assertion, so a run reports one red/green bit for ~40 independent product surfaces. Two simultaneous regressions look identical to one, and CI cannot say what else broke.
**Change:** Break it into independently-runnable sections (or files under `tools/e2e/`) that `run-all.mjs` already knows how to isolate, each wrapping its own try/catch that records pass/fail without aborting the rest.
**Effort:** M    **Risk:** Sections currently share sequential page state — each depends on the prior section's committed document — so splitting needs either strict ordering with shared setup, or independently seedable sections.

## 4. Port the software-rasteriser detection into `e2e-smoke.mjs` to restore real gating

**Evidence:** `tools/e2e/renderer.mjs:61` defines `SOFTWARE_RASTERISER` and skips only hardware-timing assertions under it (`:73-81`), keeping everything else enforced. `tools/e2e-smoke.mjs` has **zero** matches for it. Its own heavy section (`:1126-1183`) already asserts *relational* draw-call/triangle deltas rather than raw FPS — most of its 204 assertions are hardware-independent. Yet `.github/workflows/ci.yml` sets `continue-on-error: true` for the whole `acceptance-gpu` matrix.
**Why it matters:** The blanket `continue-on-error` was applied at suite level because *some* interactions blow wall-clock under a 9.6s/frame rasteriser — but it discards enforcement of the ~180 assertions that don't depend on timing at all, leaving the deploy gate blind to genuine functional regressions in the editor.
**Change:** Apply the detect-and-skip pattern to `e2e-smoke.mjs`: detect the rasteriser, widen timeouts for known-heavy operations only, and move the suite back into the blocking `acceptance` job. Reserve a real-GPU runner for the FPS budgets `renderer.mjs` measures.
**Effort:** M    **Risk:** Skip logic that is too broad re-masks a real perf regression; widen timeouts, never delete assertions.

## 5. Add visual regression testing for the renderer and share cards

**Evidence:** 22 `.screenshot()` calls across the suites, all written to `artifacts/` for human inspection on failure only. Zero occurrences of `pixelmatch`, `toMatchSnapshot`, `toHaveScreenshot` or any visual-diff tool. The project depends on raw `playwright` (`package.json:57`), not `@playwright/test`, so even the built-in screenshot assertion is unavailable. `src/features/share/render/*.test.ts` and `src/cad/{raster,thumbnail}.test.ts` verify encoding and *self-relative* properties ("pixels differ after a camera move") but never compare against a reference image.
**Why it matters:** A wrong material, broken lighting, bad camera framing or a regressed instruction booklet ships undetected unless a human opens the artifact. **For a product whose entire value proposition is visual correctness, this is the single largest blind spot.**
**Change:** Adopt `@playwright/test`'s `toHaveScreenshot()` (or add `pixelmatch` to the existing harness) for a small set of deterministic scenes — the showcase model at a fixed camera, a share card, a build-guide page — with checked-in baselines and a documented tolerance.
**Effort:** M    **Risk:** Font and anti-aliasing differences between CI SwiftShader and a local GPU produce noisy diffs; needs a tolerant threshold and CI-only baselines.

## 6. Add property-based testing to the geometry and connector kernel

**Evidence:** No `fast-check` or equivalent anywhere. `src/cad/math.ts` (356 lines: basis/rotation/transform), `collision.ts` (409), `snapping.ts` (571) and `connections.ts` (331, the mating solver) are covered only by hand-picked examples.
**Why it matters:** Floating-point transform composition, orthonormalisation and mating solving are exactly where example-based tests miss edge cases — near-degenerate bases, extreme coordinates, numerically adjacent rotation angles. The team already worries about basis shear (`tools/e2e-smoke.mjs` asserts `orthonormalityError < 1e-9`) but checks it for one hand-picked input.
**Change:** Add `fast-check`; write invariants for `math.ts` (round-trip and orthonormality under random transforms) and `collision.ts`/`connections.ts` (symmetry and commutativity of `connectorsCompatible`, no false-negative mating under random poses).
**Effort:** M    **Risk:** Fuzzing can surface a backlog of pre-existing edge-case failures that block CI until triaged; pin seeds for reproducibility.

## 7. Directly unit-test the connector-compatibility matrix

**Evidence:** `src/cad/connections.ts` (331 lines) has **no test file**. Of its 7 `COMPATIBLE_PAIRS` (`:40-47`), `snapping.test.ts` exercises only stud/anti-stud, axle/axle-hole, pin/pin-hole and generic/generic (`:140-177`). **`ball:socket` and `bar:clip` are never exercised by any test.** `connectorsCompatible` (`:66`), `allowsAxialFlip` (`:83`), `isExclusiveFamily` (`:62`) and `dedupe` (`:287`) are never called directly.
**Why it matters:** Ball-and-socket and bar-and-clip are common real LDraw mechanisms — minifig hands gripping bars, ball-jointed limbs. A regression in their compatibility or axial-flip rule (wrongly letting a bar flip like a symmetric pin) places parts in kinematically invalid configurations with nothing to catch it.
**Change:** Direct unit tests for `connectorsCompatible`, `allowsAxialFlip` and `isExclusiveFamily` across all 7 pairs plus rejected pairs; extend `enumerateMatings` coverage to ball/socket and bar/clip.
**Effort:** S    **Risk:** None — purely additive.

## 8. Add tests for the production API entrypoint

**Evidence:** `server/index.ts` (95 lines) — the Node process serving `/api/*` — has no test file. It contains silent route-discovery failure (`catch { continue }`, `:39-41`), a try/catch that swallows the cause and returns a generic 500 (`:67-79`), a `headersSent` branch, `/api/health` (`:60-64`) and a 404 fallback (`:83`). None of this dispatch or error logic is exercised.
**Why it matters:** This layer decides whether a broken or missing route silently degrades to an empty `routes: []` versus surfaces a 500 with a leaked stack — exactly the code determining whether an operator finds out the assistant API stopped working.
**Change:** Add `server/index.test.ts` starting the server on an ephemeral port with stub route modules; assert health shape, 404 for unclaimed paths, 500-without-stack-leak when a route throws, and correct behaviour when `headersSent` is already true.
**Effort:** S    **Risk:** May need `loadRoutes` refactored into an injectable seam to avoid real filesystem `stat()` calls.

## 9. Cover the edge proxy beyond the single assistant route

**Evidence:** Of `functions/`'s ~1,037 lines of route and middleware code, only `functions/api/[[route]].ts` has a test. Untested: `_middleware.ts` (the security-header floor on every response), `publications/[[route]].ts` (**244 lines — a full write API**: publish/revoke/access/token-mint), `share/[slug]/[[rest]].ts` (116 lines, serves cards under token and visibility checks), `share/[slug].ts`, `embed/[slug].ts`, and all of `_lib/` (332 lines).
**Why it matters:** This is the untrusted-input-facing public surface fronting the domain. The helper libraries are unit-tested, but the *route wiring* that calls `authorizeWrite` before a mutation is exactly where a helper-is-correct-but-route-forgot-to-call-it bug lives — and `04-security.md` finding 1 is that bug.
**Change:** Route-level tests for `publications/[[route]].ts` (auth gate enforced and bypassed) and `share/[slug]/[[rest]].ts` (token, visibility, card-not-found), following the pattern already in `functions/api/proxy.test.ts`.
**Effort:** M    **Risk:** Low; Pages Functions context needs light stubbing, and the proxy test shows the pattern.

## 10. Unit-test the transport error classification

**Evidence:** `src/cloud/convexClient.ts:156-172` defines `transportFailure`, which regex-matches a caught error's message to classify `OFFLINE` vs `TRANSPORT_FAILED` — documented as load-bearing at `:157-159` ("the outbox branches on the code, so an offline failure has to arrive as `OFFLINE`… or a lost connection would look permanent"). Called from `ask` and `tell` (`:194`, `:205`). No test calls it; `sync.test.ts` only exercises the `unconfigured` branch.
**Why it matters:** String-matching over a third-party SDK's error text breaks silently when Convex changes wording. A real outage then misclassifies as permanent instead of retryable, corrupting offline-sync retry behaviour with nothing to catch the drift.
**Change:** Direct unit tests over representative Convex and fetch error messages asserting the resulting code. It is a pure function needing no mocking.
**Effort:** S    **Risk:** None — additive and cheap.
