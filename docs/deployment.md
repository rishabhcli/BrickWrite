# Deploying Brickwright

Production is `https://brickwrite.tech`. Three services carry it, and each one
holds a different kind of thing: static bytes, a secret-bearing process, and the
collaboration database.

| Service | What it holds | Where it comes from |
|---|---|---|
| Cloudflare Pages, project `brickwright` | `dist/` plus everything in `functions/` | `.github/workflows/ci.yml`, `deploy` job |
| Vercel, project `brickwrite` | `api/[...route].ts` — the assistant and generation routes, which carry model keys | Vercel's own Git integration |
| Convex, deployment `tangible-toucan-87` | `convex/**` — projects, versions, comments, presence | `npx convex deploy` |

The Convex URL is baked into production builds and a signed-in Hexclave session
has been verified against that deployment. A signed-in Convex **write** (claim,
append, checkpoint) is still unrecorded in this repo — see
`docs/integration/cloud-projects.md`.

Hexclave (project `e997643f-407a-48f8-beb5-9ba042d28b00`) is the identity plane
for all three.

## The request path

The browser only ever talks to `brickwrite.tech`. `functions/api/[[route]].ts`
is a same-origin edge proxy: it rate-limits the paid paths at the edge, then
forwards to `BRICKWRIGHT_API_ORIGIN` with `x-brickwright-proxy-key`. The Vercel
handler rejects anything that does not present that key, so the model API has no
public front door of its own — `https://brickwrite.vercel.app/api/health`
answers `403 proxy_required` by design, and
`https://brickwrite.tech/api/health` answers `200`.

That is the fastest end-to-end health check there is: if the second one returns
`503 api_unavailable`, the Pages project has lost `BRICKWRIGHT_PROXY_SECRET`
or `BRICKWRIGHT_API_ORIGIN`.

## AI request lifetimes

Assistant and generation timeout settings now bound the whole Node handler,
including uploads and corrective attempts, rather than granting each attempt a
fresh deadline. Defaults are 120 seconds server-side and 180 seconds in browser
transports; keep them below the platform request limit. The Pages proxy forwards
cancellation, and streaming responses send blank-line heartbeats. Deploy Node
and Pages/frontend together for the complete behavior; no database migration is
needed. See [AI stream reliability](ai-stream-reliability.md) for error contracts,
client completion rules, limits, and local verification coverage.

## What CI does, and what it deliberately does not

`verify` runs on every push and pull request: catalog integrity, the unit suite,
strict TypeScript for all three programs and the production build. The browser
suites under `tools/e2e/` then run one runner per suite, split across two jobs
by a single question — **does this suite need a GPU?**

`acceptance` holds `landing`, `production` and `share`. Nothing they assert
changes with the machine: a byte budget, whether the built bundle executes,
whether publication works. A red leg is a real regression, and `deploy` waits on
it.

`acceptance-gpu` holds `e2e-smoke` and `renderer`, and is `continue-on-error`.
A GitHub-hosted runner has no graphics hardware, so Chromium rasterises WebGL
through SwiftShader: 3.16 M triangles cost about 9.6 s a frame, the renderer
suite measured 0.1 FPS against a 30 FPS target, and the editor suite's project
fork blew a 90-second budget that is already ten times what a laptop needs.
Every hosted run failed for that reason and no other. Raising individual
timeouts does not fix it — `tools/e2e-smoke.mjs` has roughly a hundred
assertions and any of them is the next to time out.

**So CI promises less than it looks like it does, on purpose.** The real
enforcement for those two suites is `npm run verify:all` on a machine with a
GPU. `tools/e2e/renderer.mjs` detects the software rasteriser and prints, per
gate, which targets it did not enforce, so a hosted run can never be mistaken
for a full one. If they should block again, the answer is a runner with a GPU,
not a longer timeout.

The acceptance split is not premature parallelism. `run-all.mjs` deliberately
boots one server for every suite, which is right on a workstation — a full pass
on an M3 Max is about seven minutes. A hosted runner has no GPU, so every WebGL
frame goes through SwiftShader and `e2e-smoke` alone takes twenty minutes; run
sequentially, the pass exceeded the job timeout and was killed mid-suite,
reporting nothing. The matrix in `ci.yml` lists the suite names that
`run-all.mjs` accepts as argv filters, and **that list is where a new suite has
to be registered** — a suite added to `tools/e2e/` but not to the matrix still
runs locally and is simply not gated.

The build step passes `VITE_HEXCLAVE_PROJECT_ID` and `VITE_CONVEX_URL` — both
are public browser configuration, but the project id lives in Actions secrets so
it has one source of truth with Hexclave. **A build made without them produces a
working CAD editor with no account layer and no cloud projects**, which is a
supported mode (`src/platform/config.ts` and `src/cloud/convexClient.ts` render
it honestly) and therefore fails silently rather than loudly. If production ever
shows "no Hexclave project configured", check those two values before anything
else.

Repository secrets required: `CLOUDFLARE_API_TOKEN` (scoped to *Cloudflare
Pages: Edit*), `CLOUDFLARE_ACCOUNT_ID`, `HEXCLAVE_PROJECT_ID`,
`HEXCLAVE_SECRET_SERVER_KEY`.

## Hexclave: trusted domains are environment config, not branch config

Every post-authentication redirect — the OAuth callback, magic links, password
resets — is validated against the project's trusted-domain list. An origin that
is missing fails closed with `REDIRECT_URL_NOT_WHITELISTED`, which is what a
freshly deployed custom domain looks like: sign-in appears to work right up
until the provider hands the user back, and then a Hexclave-hosted error page
appears instead of the application.

This cannot be fixed from `hexclave.config.ts`. That file is pushed to the
**branch** config layer, and `domains.allowLocalhost` / `domains.trustedDomains`
live in the **environment** layer — `hexclave config push` rejects them with
`400 domains contains unknown properties`. Set them through the dashboard, or
from the CLI:

```bash
npx @hexclave/cli login   # requires HEXCLAVE_SECRET_SERVER_KEY to be unset
npx @hexclave/cli exec --cloud-project-id <project-id> '
  await hexclaveServerApp._interface.updateConfigOverride("environment", {
    "domains.trustedDomains.production": { baseUrl: "https://brickwrite.tech" },
  })'
```

`updateConfigOverride` is a merge, not a replace, so it will not disturb the
rest of the environment layer. Verify with the public project endpoint, which
should list the domain under `config.domains`:

```bash
curl -s https://api.hexclave.com/api/v1/projects/current \
  -H "X-Hexclave-Access-Type: server" \
  -H "X-Hexclave-Project-Id: $HEXCLAVE_PROJECT_ID" \
  -H "X-Hexclave-Secret-Server-Key: $HEXCLAVE_SECRET_SERVER_KEY"
```

`allowLocalhost` stays `true` so `npm run dev` needs no per-developer entry.

## Convex

For the complete-history change, deploy Convex before the frontend: the new client
uses `transactions:history` and the additive `snapshots.by_branch_kind_revision`
index. No stored history is rewritten. See [cloud history](cloud-history.md) for
the paging contract, recovery behavior, and regression tests.

The save-integrity change also requires backend-first rollout: `projects:create`
accepts `resumeExisting`, and `projects.creation` is an optional immutable receipt
used to resume an exact interrupted claim. Existing rows are preserved without
migration; ambiguous or legacy retries remain explicit refusals. See
[cloud save integrity](cloud-save-integrity.md) for validation and retry boundaries.

Batched synchronization also needs Convex deployed first: the new frontend calls
`transactions:appendBatch` for claims and offline catch-up. The endpoint needs no
schema migration and preserves the old single-edit API. Deploying only the
frontend leaves multi-edit uploads retrying until that endpoint is available;
local work is retained. See [batched sync](cloud-batched-sync.md) for batch limits,
atomicity and acknowledgement recovery.

Transaction integrity adds shared structural validation to saves, history reads,
outbox sends and conflict recovery. Deploy both Convex and frontend for full
coverage; no API or schema migration is needed. Existing malformed logs are
refused, not rewritten or deleted. See [transaction integrity](cloud-transaction-integrity.md)
for compatibility, recovery and validation boundaries.

Deploy the additive `branches.by_recovery` index and optional recovery receipt
fields with `versions:createBranch` before releasing the retry-safe recovery
client. Existing branches require no backfill. See
[conflict recovery](cloud-conflict-recovery.md) for restart, authorization and
local-finalization boundaries.

Invitation delivery requires backend-first rollout of the optional delivery
metadata/statuses, `invitations.by_project_email_status_expiry`, and
`invitations:retryDelivery`. Existing tokens and rows need no backfill. Native
Hexclave email uses the Convex deployment's `HEXCLAVE_PROJECT_ID`,
`HEXCLAVE_SECRET_SERVER_KEY`, and `INVITATION_LINK_ORIGIN`; these secrets must
never be bundled into Vite. Existing custom endpoint variables remain an
explicit override. Provider acceptance is reported as queued, not as verified
inbox delivery. See [invitation lifecycle](cloud-invitation-lifecycle.md) for
configuration, retry ambiguity, and legacy-worker boundaries.

`convex/auth.config.ts` reads `HEXCLAVE_PROJECT_ID` from the *deployment*
environment and throws when it is absent, so a deployment cannot come up
accepting tokens for an accidental project. Set it before the first push:

```bash
npx convex env set --prod HEXCLAVE_PROJECT_ID <project-id>
npx convex deploy -y
```

## Verifying a release

`npm run verify:all` is what CI runs. Two of its suites exist specifically for
this deployment shape:

- `tools/e2e/production.mjs` serves the built `dist/` — not Vite's development
  graph — and executes both the landing page and the CAD editor. It exists
  because a chunking regression once split Hexclave's mutually dependent modules
  across max-size subchunks, broke their ESM initialization order, and left the
  production root blank while every development-server check stayed green. The
  `hexclave` group in `vite.config.ts` must remain one chunk.
- `tools/e2e/landing.mjs` holds the landing performance budget, including LCP.
  It preloads the display font exactly as `index.html` does, so the measurement
  reflects what a first-time visitor gets. Its CPU throttle is **calibrated, not
  fixed**: `Emulation.setCPUThrottlingRate` scales the host, so a hard-coded
  multiplier measures a different device on every machine — the same commit came
  back 2348 ms locally and 2608 ms on a runner, against 150 ms of headroom. The
  suite times a fixed workload unthrottled and picks the multiplier that reaches
  a constant reference device, then reports the median of three loads with every
  sample printed. That removed the CPU-bound part and moved LCP by about 20 ms:
  the load is bandwidth-bound, and a host-dependent floor of roughly 200 ms
  survives calibration. So the gate that actually catches a delivery regression
  is the **render-critical byte budget** — document plus stylesheet plus script,
  which bytes make identical on every machine — and LCP is a loose ceiling
  beside it. If you change either budget, change it because the page changed;
  the per-sample numbers will tell you whether it did.

After a deploy, the four things worth checking by hand:

```bash
curl -sI https://brickwrite.tech/            # 200, and the security headers
curl -s  https://brickwrite.tech/api/health  # {"ok":true,...}
curl -s  https://brickwrite.tech/assets/<entry>.js | grep -c convex.cloud   # env baked in
```

and one real sign-in, because it is the only thing that exercises the trusted
domain list.

## Distribution budgets

`npm run build` ends with `tools/check-dist-budget.mjs`. It fails before deploy
when `dist/` exceeds 160 MiB total, 16,000 files, or 20 MiB for one file. The
file-count and single-file budgets deliberately retain headroom below
Cloudflare Pages' current Free-plan limits of 20,000 files and 25 MiB per file;
the total-size ceiling is Brickwright's own delivery/operability budget because
Pages publishes no aggregate-byte limit. Override values only for a deliberate,
reviewed migration using the `DIST_*` variables documented in `.env.example`.

The total was raised from 100 MiB when the demo collection was rebuilt around a
few large sets rather than many small ones. Each set ships 10-15 MiB and the
catalogue alone is ~69 MiB. Nearly all of a set's bytes are its stored
connection graph — the tower's is 10.9 MiB of an 11.2 MiB document, against 1.1
MiB of parts — so the cheapest future saving is there rather than in the
collection's size.

## Rollback

1. Identify the last known-good Git tag and its exact commit. Never roll back
   Convex data by deleting rows or redeploying an older schema blindly.
2. In Cloudflare Pages, promote the previous successful `main` deployment (or
   redeploy the known-good tag) so static bytes and Pages Functions move
   together. Verify `/`, `/editor`, `/api/health`, and response headers.
3. In Vercel, promote the matching previous production deployment for the Node
   API. The Pages proxy and Vercel origin must continue to share the same
   `BRICKWRIGHT_PROXY_SECRET`.
4. Convex code may be redeployed from the known-good tag only when its schema is
   backward-compatible with current stored data. For a data/schema incident,
   stop writes first, export a backup, and apply a forward repair migration.
5. Record the incident and deployed commit in `CHANGELOG.md`, then run the
   post-deploy verification above. A UI rollback is not complete while API or
   data-plane versions remain incompatible.
