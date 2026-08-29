# Developer experience, operations and observability

Ten findings. The single most important one is the first, and it is a plain
absence rather than a defect.

**Verified by hand:** `dist/` is **76MB across 1,904 files**, largest
`catalog/2026-07/search-external.json` at **7.4MB** — the `ci.yml` comment
claimed ~57MB / 1.66MB / ~1,800 files, wrong on all three counts. *(Corrected in
place while writing this; the stale figures had been edited around earlier today
without being checked.)* `.github/workflows/hexclave-config-sync.yml:57` does run
`@hexclave/cli@latest`.

---

## 1. There is no production error tracking, structured logging or alerting

**Evidence:** `grep -rn "console\." server/ functions/ convex/ api/` returns **zero matches**. A repo-wide search for `sentry|opentelemetry|datadog|honeycomb|bugsnag|rollbar|newrelic|prometheus|pagerduty` finds nothing but LEGO part-name false positives. `server/index.ts:72-79` catches every route failure and writes to `process.stderr` with a comment claiming "the process log keeps the detail an operator needs" — but nothing collects, ships or alerts on it. `functions/api/[[route]].ts:67,107` swallow the origin-parse and upstream-fetch failures with bare `catch {}`.
**Why it matters:** If the Vercel API throws, or the model provider starts failing, **the only way anyone finds out is by manually curling `/api/health`.** No dashboard, no aggregation, no alert. An outage is discovered by a user complaint.
**Change:** Wire a minimal error-tracking SDK into `server/index.ts`, `functions/*` and Convex actions, routed through the existing redaction logic so telemetry cannot leak `ANTHROPIC_API_KEY` or `BRICKWRIGHT_PROXY_SECRET`. Add a synthetic uptime check against `/api/health`.
**Effort:** M    **Risk:** Must reuse the existing redactor — bolting on telemetry without it leaks exactly the secrets this codebase is otherwise careful about.

## 2. Assert the asset-pack size instead of asserting it in prose

**Evidence:** `.github/workflows/ci.yml:152-154` carried a hand-maintained claim that was wrong by 19MB on total size and 4.6× on largest file. Measured: 76MB, 1,904 files, 7.4MB largest.
**Why it matters:** This comment was the only written record of the "safely inside Cloudflare Pages' limits" claim. Still true today, but nobody would learn otherwise from a future catalog rebuild, because the number is prose rather than an assertion.
**Change:** After `npm run build`, measure `dist/` size, file count and largest file, and fail or warn when any approaches the Pages caps.
**Effort:** S    **Risk:** Low; threshold choice is the only judgement call.

## 3. There is no linter or formatter at all

**Evidence:** `package.json` devDependencies list `typescript`, `vitest`, `playwright`, `jsdom` and testing-library — **no `eslint`, no `prettier`, no `@typescript-eslint/*`**. A repo-wide find for `*eslint*`, `.prettierrc*`, `prettier.config*` returns nothing. `npm run check` is `test && typecheck:convex && typecheck:functions && build` — strict `tsc` only.
**Why it matters:** Unused variables, accidental `any`, dead code and formatting drift have no automated gate across six source roots (`src/`, `server/`, `functions/`, `convex/`, `tools/`, `api/`). Consistency rests entirely on `tsc --strict` and review.
**Change:** Add ESLint with `@typescript-eslint` plus Prettier, wire a `lint` script into `npm run check` and the `verify` job.
**Effort:** M    **Risk:** The first pass surfaces a large pre-existing diff; land warn-only, then flip to blocking.

## 4. Ship a single `.env.example`

**Evidence:** No `.env*` template is tracked. A repo-wide scan finds **27 distinct `process.env.*` variables** across `server/`, `functions/`, `convex/`, `tools/`, plus the browser-visible `VITE_*` pair. Their authoritative descriptions are scattered across `docs/deployment.md` and four separate `docs/integration/*.md` files.
**Why it matters:** A new contributor or deployer must cross-reference five documents to discover what a given surface needs, and several features **fail silently** when misconfigured — by design, which makes a checklist more valuable, not less.
**Change:** A root `.env.example` enumerating every variable with a one-line comment and a pointer to the owning doc; keep the "why" in the workstream docs.
**Effort:** S    **Risk:** None; commit placeholders only.

## 5. Reconcile the contradictory Convex readiness claims

**Evidence:** `docs/integration/cloud-projects.md:349-355`, under a heading literally reading "NOT_COMPLETE — live deployment", states "No Convex account is logged in on this machine, so no live deployment was ever exercised… no Hexclave token has been validated by Convex." But `docs/deployment.md:11` names deployment `tangible-toucan-87` as provisioned, and `ci.yml:176` bakes `VITE_CONVEX_URL: https://tangible-toucan-87.convex.cloud` into every production build. Both are committed at HEAD.
**Why it matters:** A reader cannot tell whether auth-gated Convex sync has ever been proven end to end in production, or whether `cloud-projects.md` is simply stale. That ambiguity leads someone to assume a feature works when it has never been verified live.
**Change:** Confirm real status against `tangible-toucan-87`; delete the `NOT_COMPLETE` section or add the same caveat to `docs/deployment.md`. *(Note: production now bakes the Convex URL into the bundle and a signed-in session was verified end to end, so the deployment half is real — but a signed-in **Convex write** has still not been demonstrated in this repo's records.)*
**Effort:** S    **Risk:** If `cloud-projects.md` is the accurate one, the collaboration path in production is unverified.

## 6. Convex is 14 minor versions behind, with no update automation

**Evidence:** `npm outdated` — `convex 1.31.0 → 1.45.0`; also `@hexclave/* 1.0.106 → 1.0.108`, `zod 4.4.3 → 4.5.2`, `lucide-react 1.34.0 → 1.35.0`. Every dependency is pinned **exactly** (no `^`/`~`), so "wanted" always equals "current" and updates never happen without a manual bump. No `dependabot.yml`, no `renovate.json`.
**Why it matters:** Convex is the data plane and the gap can widen indefinitely with no signal.
**Change:** Enable Dependabot or Renovate for `dependencies`; schedule a deliberate Convex bump and retest.
**Effort:** S (bot) / M (the bump)    **Risk:** 14 minor releases may include behaviour changes worth testing against the cloud suite.

## 7. Pin the Hexclave CLI in the config-sync workflow

**Evidence:** `.github/workflows/hexclave-config-sync.yml:57` runs `npx --yes @hexclave/cli@latest config push` against **production identity configuration** — OAuth providers, trusted domains, email theme — on every push to `main` touching `hexclave.config.ts`, with no approval gate. Contrast `ci.yml:182-186`, which pins `wranglerVersion: '4.127.1'` with the comment "Pinned to the version this deployment was proven against. The action otherwise floats."
**Why it matters:** The repo already argues, in its own CI file, why floating a deploy-critical CLI is unsafe — then floats one for the workflow that pushes production auth config. **Two live consequences:** a CLI release could silently change what gets pushed, and an unreviewed edit to `hexclave.config.ts` mutates production identity settings automatically.
**Change:** Pin to the `devDependencies` version (`1.0.106`) and bump deliberately alongside the SDK.
**Effort:** S    **Risk:** None; purely increases reproducibility.

> **Related gotcha, learned the hard way.** `domains.trustedDomains` cannot be
> pushed through this workflow at all — it is *environment*-level config and
> `config push` writes the *branch* level, rejecting it with
> `400 domains contains unknown properties`. See `docs/deployment.md`.

## 8. Establish versioning, a changelog and a rollback runbook

**Evidence:** `package.json:4` has read `"version": "0.1.0"` across the repo's entire history. `git tag -l` is empty. No `CHANGELOG.md`. `grep -rniE "rollback|revert"` across `docs/`, `README.md`, `ARCHITECTURE.md`, `PROGRESS.md` finds nothing relevant. The `deploy` job pushes straight to Pages on every green push to `main`, with Vercel deploying separately via its own Git integration — no canary, no manual gate, no documented recovery.
**Why it matters:** `docs/deployment.md` covers verifying a release thoroughly but says nothing about what to do when one fails *after* it is live — no mention of Pages' or Vercel's rollback-to-previous-deployment, and no Convex schema/data guidance.
**Change:** Bump and tag per release, keep a lightweight changelog, and add a rollback section covering all three services.
**Effort:** M    **Risk:** None to add; the risk is entirely in not having it.

## 9. Make the README's headline command the one CI exercises

**Evidence:** `README.md:15-21` tells every new contributor to run `npm run bootstrap && npm run dev`, where `dev` wraps `hexclave dev`. Grepping `tools/e2e/` and `tools/e2e-smoke.mjs` for `hexclave` returns **zero matches**, and no CI job invokes `npm run dev` or `hexclave dev`. The credential-free `dev:inner` is mentioned only as a secondary aside.
**Why it matters:** The first command a new contributor runs is exercised by no automation, so nothing guarantees it works non-interactively — if `hexclave dev` prompts for a CLI login on a machine with no prior session, a first-timer hits that with no warning in the quick start.
**Change:** Either add a CI smoke step running `hexclave dev` non-interactively, or lead the quick start with `dev:inner` and present the wrapper as the opt-in "with accounts" step.
**Effort:** S    **Risk:** Low; if the smoke test reveals interactive login is required, that is worth knowing.

## 10. Add dependency vulnerability scanning

**Evidence:** `grep -n "audit" package.json .github/workflows/*.yml` returns nothing. No Dependabot, Renovate or CodeQL config anywhere. Combined with finding 6 — exact pins, no update automation — a dependency with a known CVE can sit in the lockfile indefinitely.
**Why it matters:** This is a secret-bearing, internet-facing application (the Vercel API holds `ANTHROPIC_API_KEY`; Convex holds user data) with **zero automated signal** for known vulnerabilities. `04-security.md` finding 10 confirms 8 open advisories today, 2 high.
**Change:** Add `npm audit --audit-level=high` as a CI step, or enable Dependabot security updates, gated to allow triage of pre-existing advisories before becoming blocking.
**Effort:** S    **Risk:** The first run surfaces existing advisories needing triage before the gate can block.
