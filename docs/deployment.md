# Deploying Brickwright

Production is `https://brickwrite.tech`. Three services carry it, and each one
holds a different kind of thing: static bytes, a secret-bearing process, and the
collaboration database.

| Service | What it holds | Where it comes from |
|---|---|---|
| Cloudflare Pages, project `brickwright` | `dist/` plus everything in `functions/` | `.github/workflows/ci.yml`, `deploy` job |
| Vercel, project `brickwrite` | `api/[...route].ts` — the assistant and generation routes, which carry model keys | Vercel's own Git integration |
| Convex, deployment `tangible-toucan-87` | `convex/**` — projects, versions, comments, presence | `npx convex deploy` |

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
