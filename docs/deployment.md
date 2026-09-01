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

## Spend controls, and the bindings they need

Two ceilings sit in front of the model provider key. Both are **off** until the
deployment gives them somewhere to count, and both say so rather than pretending
otherwise — `curl -s https://brickwrite.tech/api/health` reports
`"metering": "ready"` or `"metering": "unconfigured"`.

### The edge request limiter — Cloudflare `[[ratelimits]]`

`functions/api/[[route]].ts` caps paid paths at 20 POSTs per 60 seconds. It
prefers the native rate-limiting binding, which is atomic:

```toml
[[ratelimits]]
name = "API_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
```

Already in `wrangler.toml`. `namespace_id` must be unique per account, and
`period` accepts only `10` or `60`. Two bindings sharing a `namespace_id` share
counters, which is occasionally what you want and never what you want by
accident.

If the binding is absent the Function falls back to the `RATE_LIMIT_KV` counter,
which is `get` then `put` — two operations with a gap, against an eventually
consistent store that throttles repeated writes to one key. The ceiling then
holds on average rather than exactly. Keep the KV namespace bound; it is the
fallback, and with the binding present it is never read.

**Failure direction: closed.** A limiter that cannot answer refuses the request.
An unparseable KV counter reads as over-limit, not as a fresh allowance.

### The per-account token ceiling — an atomic counter

The edge bounds *frequency*. It does not bound *money*: one request can be an
`xhigh` chat leg, and `/api/generate` fans out to a dozen model calls.
`server/security/budget.ts` meters weighted tokens per Hexclave account per UTC
day, defaulting to 2,000,000 (output weighted ×5).

It needs a counter with an atomic increment. `server/security/budgetStore.ts`
speaks the Upstash REST protocol — no client library, and Redis `INCRBY` is the
primitive `BudgetStore.increment` is defined in terms of. Set both variables on
the **Vercel** project:

```
BRICKWRIGHT_BUDGET_REDIS_URL=https://<your-counter>.upstash.io
BRICKWRIGHT_BUDGET_REDIS_TOKEN=<rest-token>
```

Half-configured is treated as not configured, deliberately: a URL without its
token would fail every read, and `checkBudget` fails closed on a *configured*
store — so a half-configured meter would refuse all paid traffic rather than
none.

**Failure direction: split, on purpose.** A configured meter that cannot be
*read* refuses the request, because an unknown balance is not an allowance. A
metering *write* that fails never fails the request — the answer was already
produced and paid for; the next call is the one that gets refused. Losing a write
undercounts by one call, losing a read would uncap the account.

Verify: `curl -s https://brickwrite.tech/api/health | jq .metering`.

## Publication ownership

Writes to `/publications/*` used to be gated by `SHARE_PUBLISH_TOKEN` alone —
one deployment-wide bearer, with no per-caller identity — so any principal
holding it could revoke, retarget or mint links against any publication.

A publication now records `ownerSubject`, and every mutation compares the caller
against it. Two principals can write:

- **A verified Hexclave session.** `functions/_lib/session.ts` checks the ES256
  signature against the project's published JWKS — the same key set
  `convex/auth.config.ts` hands Convex. Requires these on the **Pages** project:

  ```
  HEXCLAVE_PROJECT_ID=<project-id>
  HEXCLAVE_API_URL=https://api.hexclave.com   # optional; this is the default
  ```

  Without `HEXCLAVE_PROJECT_ID` no session can be verified and only the operator
  secret works — the pre-ownership behaviour, which is the safe direction to
  degrade in.

- **The operator secret**, `SHARE_PUBLISH_TOKEN`, which now identifies *an
  operator* rather than everyone. It is what `tools/e2e/share.mjs`,
  `functions/_dev/*` and migration scripts authenticate as, and it stores
  `ownerSubject: "@operator"`.

### Grandfathering existing records

**No migration is required, and none is provided.** Publications written before
this carry no `ownerSubject`, and those are administrable by the operator secret
only — a narrower door than the one they were created through, never a wider
one. A session cannot claim one, because there is nothing to compare it against.

To hand a legacy publication to its real owner, set the field with the operator
credential and that account's Hexclave subject:

```bash
# Read the record, add ownerSubject, write it back. Do this with the operator
# bearer; there is no endpoint that reassigns ownership, deliberately.
npx wrangler kv key get --binding SHARE_KV "pub:slug:<slug>" > /tmp/pub.json
jq '.ownerSubject = "<hexclave-subject>"' /tmp/pub.json > /tmp/pub.owned.json
npx wrangler kv key put --binding SHARE_KV "pub:slug:<slug>" --path /tmp/pub.owned.json
```

A non-owner attempting a write gets `404`, not `403`: for a `private` or
`unlisted` publication, confirming that a slug exists is exactly the fact its
publisher chose not to disclose.

### Unlisted links are exchanged for a cookie

`?t=<secret>` is now a bootstrap. On first presentation of a token that actually
grants access, `/share/:slug` responds `303` to the clean path and sets
`bw_share_link_<slug>` — `HttpOnly; Secure; SameSite=Lax`, scoped by `Path` to
that one publication. A query string ends up in Cloudflare's access log, the
visitor's history and session restore, and every proxy in between; `redactShareUrl`
reaches none of those.

Both credentials are accepted, URL first, so a stale `?t=` in someone's history
cannot lock them out of a publication they already hold a working cookie for.
`SameSite=Lax` is deliberate: third-party framing is what `/embed/:slug` is for,
and widening the cookie to `None` would make every embed a carrier for the
secret.

## Invitation links expire in 72 hours

Down from 14 days. An invitation is a bearer credential that sits in an inbox, a
shared mailbox or a mail archive for its whole lifetime. Owners will need to
resend more often; that is the trade, and it is the one worth making.

Acceptance is still keyed on the token plus a signed-in identity, not on an
email claim — `convex/invitations.ts` explains why. What is new is that a
**verified** address which contradicts the invited one is refused, so a
forwarded invite does not transfer access. An absent or unverified claim accepts
exactly as before, so this cannot lock out a provider that does not assert
addresses.

## Where the logs go

All three surfaces emit one JSON object per failure, in the same shape —
`ts`, `level`, `service`, `message`, `cause` — so a single aggregator query
finds a failure wherever it happened:

| Surface | Emitter | Sink |
|---|---|---|
| Vercel Node API | `server/log.ts` → stdout/stderr | Vercel log drain |
| Cloudflare Functions | `functions/_lib/log.ts` → `console.error` | Pages Logpush |
| Convex | `convex/model/log.ts` → `console.*` | `npx convex logs`, or a Convex log stream |

Each has its own redactor, and each is tested. Model keys, proxy secrets,
bearer tokens and JWTs are matched by shape; the Convex one additionally strips
anything email-shaped, because that deployment stores an address in exactly one
table and a log line is a copy.

**Nothing subscribes to any of these yet.** Configuring a drain, a Logpush job,
a Convex log stream and a synthetic check against `/api/health` is the remaining
work, and it is deployment configuration rather than code.

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
