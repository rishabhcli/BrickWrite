# Performance

Ten findings. The renderer itself is genuinely fast — 5,000 parts at 120 FPS on
an M3 Max, 126 draw calls, ~1.2 ms median picking. The costs are on the delivery
and boot paths.

**Measured by hand.** What `dist/index.html` actually loads at `/`, gzipped:

| chunk | gzip |
|---|---|
| `hexclave-DZ9JmxYU.js` | **476,960 B** |
| `react-pgYNVrsg.js` | 55,245 B |
| `index-BTgoayZr.css` | 32,026 B |
| `index-nWY2ed79.js` | 23,161 B |
| `rendering-3V3UBfyh.js` | 5,400 B |
| `rolldown-runtime-hePW80VL.js` | 459 B |
| **total render-critical** | **593,251 B ≈ 579 KiB** |

**The auth SDK is 80% of the landing page's critical payload.**

> **Scope note on the byte gate.** `CRITICAL_PATH_BUDGET_BYTES` in
> `tools/e2e/landing.mjs:88` measures a *separate* build of
> `src/features/landing/standalone.tsx` (`:232-243`), not `dist/`. That scope is
> deliberate and recorded in `artifacts/landing/report.json`, and it is the right
> way to measure the surfaces' own code — but it means **the gate cannot see the
> 477 KiB Hexclave chunk**. Finding 1 is about closing that gap.

---

## 1. Keep the account SDK off the landing critical path, and measure what ships

**Evidence:** `public/_redirects:2` serves the single `dist/index.html` for every route. That file `modulepreload`s `hexclave-DZ9JmxYU.js` (476,960 B gzip) alongside the entry, because the entry statically imports the account layer. Meanwhile `tools/e2e/landing.mjs:232-243` builds and measures a throwaway standalone entry that never touches Hexclave, React-DOM or rendering — the 386 KiB in `artifacts/landing/report.json`.
**Why it matters:** A visitor to `/` pays ~579 KiB gzip before the headline paints, ~80% of it an authentication SDK the marketing page never uses. And no CI gate would ever report it, because the budget is measured against an artifact that is not deployed.
**Change:** Two halves, and both are needed. (a) Make the account layer dynamically imported so it leaves the entry chunk — `src/platform/AppShell.tsx:57` already registers `/account` lazily, so the static import to break is the provider wiring. (b) Add a second budget in `landing.mjs` measured against the real `dist/index.html`, so what is gated and what is shipped are the same artifact.
**Effort:** M    **Risk:** The Hexclave group must stay one chunk (`vite.config.ts:46-53`) — splitting its interdependent modules broke ESM init order and blanked the production root once already. Move it off the critical path; do not subdivide it.

## 2. Split the editor's CSS out of the always-loaded stylesheet

**Evidence:** `src/main.tsx:7` imports `./styles.css` (1,508 lines) and `src/platform/AppShell.tsx:27` imports `platform.css` (553 lines) — the only component CSS in the static entry graph. No file under `src/editor/workbench` imports its own CSS. Built output confirms it: `index-BTgoayZr.css` (32,026 B gzip) is the only stylesheet in `<head>`, and the lazily-loaded editor bundle has **no** matching CSS chunk — while `agent`, `generation`, `refinement`, `LandingPage` and `ExplorePage` each do get one.
**Why it matters:** A visitor who never opens `/editor` still downloads and renders dock, gizmo-panel and command-palette CSS, render-blocking, before the landing `<h1>` paints — and every future editor style grows the landing page's critical CSS permanently.
**Change:** Move workbench styles into per-component CSS imported by their `.tsx` files, exactly as `agent`/`generation`/`refinement` already do, so Rolldown's CSS splitting places them in the `App` chunk.
**Effort:** M    **Risk:** A single global file's cascade order and shared custom properties break subtly once split; needs a visual pass across docks and panels.

## 3. Stop scanning every saved project to find the newest one

**Evidence:** `src/cad/session.ts:71-83` runs at editor boot and calls `listProjects()` → `src/cad/persistence.ts:237-248`, which does `driver.all<StoredCheckpoint>('checkpoints')` — an IndexedDB `getAll()` deserializing **every** stored project's complete document, all parts and connections, purely to read `projects[0].projectId`. `session.ts:86` then re-fetches that same checkpoint separately.
**Why it matters:** Boot cost for `/editor` scales with the total size of every project ever saved in that browser, not the one being opened. A dozen saved builds means deserializing all twelve on every start, before the kernel mounts — and the newest is fetched twice.
**Change:** Maintain a summary record (id, name, revision, savedAt, partCount) in the `meta` table alongside each `saveCheckpoint`, and have `listProjects()` read that instead.
**Effort:** M    **Risk:** Needs a `SCHEMA_VERSION` bump and a migration that backfills summaries without dropping pre-existing checkpoints.

## 4. Move catalog JSON parsing off the boot-blocking path

**Evidence:** `src/cad/catalog-loader.ts:71-76` fetches `parts.json` (2,461,298 B) and `search.json` (3,453,610 B) — **5.9 MB combined** — each through `fetchVerifiedJson` (`:36-48`), which runs `JSON.parse(new TextDecoder().decode(buffer))` synchronously on the main thread. `src/platform/boot.ts:98-113` awaits this before session restore and geometry preload, gating first paint of `/editor`.
**Why it matters:** 5.9 MB of synchronous `JSON.parse` on the main thread on **every** `/editor` boot, not just the first visit. `search.json` backs search and browse — it is not needed to paint an already-restored document's geometry, yet it blocks the same gate.
**Change:** Parse in a Worker, or at minimum defer `search.json` behind the load-on-first-use pattern already proven for `search-external.json` (`:106-140`) and the semantic index.
**Effort:** M    **Risk:** A worker crosses a structured-clone boundary; anything relying on reference identity in `CatalogPayload` needs auditing.

## 5. Give the workbench a reason not to re-render on every commit

**Evidence:** `src/editor/useCad.ts:5` subscribes via `useSyncExternalStore(...)` with **no selector**. `cadEngine.emit()` (`src/cad/engine.ts:521-527`) replaces the snapshot wholesale on every commit, including pure selection changes (`:563-566`). `useWorkbench()` is called once in `Workbench.tsx:74` and threads its ~70-field return into every child panel. `grep -rn "React.memo\|memo(" src/editor --include=*.tsx` returns **zero matches**.
**Why it matters:** Selecting a part, nudging a slider, or a toast timer firing re-renders every dock and panel — Toolbar, TopBar, StatusBar, TimelinePanel, InspectorPanel, PalettePanel — regardless of relevance.
**Change:** Adopt a selector-based subscription (`useSyncExternalStoreWithSelector`, already reachable via the react vendor chunk) so panels read only their slice, and/or wrap panels in `React.memo`.
**Effort:** L    **Risk:** A selector missing a field causes stale-prop bugs in the command path; needs per-panel coverage first.

## 6. Cover the semantic index with the immutable cache rule its neighbours get

**Evidence:** `public/_headers:9-13` gives `/assets/*` and `/catalog/2026-07/*` a one-year immutable policy (mirrored in `vercel.json:19-31`). `public/semantic-index.2026-07.bin` (3,987,924 B) sits at the site root, matches neither prefix, and falls through to the generic `/*` block, which sets **no `Cache-Control` at all** — despite its filename being version-pinned exactly like the catalog files.
**Why it matters:** The one file with a purpose-built lazy-load path specifically to avoid a 4 MB tax per session (`src/intelligence/parts/semantic.ts:346-352`) re-validates or re-downloads on every return visit anyway.
**Change:** Add a `/semantic-index.*` rule, or move the files under `/catalog/2026-07/`, in both `public/_headers` and `vercel.json`.
**Effort:** S    **Risk:** The filename carries the catalog version but no content hash, so a rebuild changing vectors without bumping the version would serve stale data for a year.

## 7. Warm the identity pass before the operator's first click

**Evidence:** `artifacts/renderer/measurements.json` — `picks.firstMs: 48.2` against `meanMs: 1.998` and `p50Ms: 1.2`. A **24–40× spike on pick #1**, against a 50 ms target. `src/editor/render/idPass.ts:289-317` allocates the render target and its `ShaderMaterial` (`:208-245`) lazily on the first `pick()`; there is no construction-time warm-up.
**Why it matters:** Nearly the whole pick-latency budget is spent by whichever click happens to be first — typically the very first thing an operator does after the model appears.
**Change:** Fire one throwaway `idPass.pick(camera, -1, -1, { radius: 0 })` once the first beauty frame is up and the browser is idle, so shader compilation and target allocation are paid before the real click.
**Effort:** S    **Risk:** A warm-up timed before geometry and materials are ready could itself drop a frame right as the model appears.

## 8. Give instanced batches slack capacity instead of an exact-size key

**Evidence:** `src/editor/PartBatch.tsx:184-187` keys on `` `${descriptor.key}:${descriptor.members.length}` ``, commented "InstancedMesh capacity is fixed at construction" — forcing a full unmount and remount (new mesh, new materials `:127-138`, a fresh `setMatrixAt` loop `:143-147`, a merged-edge rebuild `:275-284`) whenever a batch's member count changes **by one**. Yet `:146` already sets `mesh.count = descriptor.members.length`, proving the code tolerates count ≤ capacity.
**Why it matters:** Adding or removing a single brick from a common part/colour combination tears down and rebuilds that batch's GPU buffers, instead of writing one matrix into slack — exactly the pattern interactive placement and the agent flows produce.
**Change:** Construct with capacity rounded up (next power of two, or +25%), key on the rounded capacity, and re-key only when membership exceeds it.
**Effort:** M    **Risk:** Unused slack instances must be reliably zeroed or stale geometry renders.

## 9. Bound the geometry cache before the catalog outgrows it

**Evidence:** `src/cad/mesh.ts:166-253` — `GeometryCache` has `get`/`load`/`preload`/`residentCount` but **no eviction**; `states` is a plain `Map` held for the tab's lifetime. `public/catalog/2026-07/manifest.json` reports `coverage.geometryBytes: 47682588` (~48 MB) for today's 900-part pack, and `.github/workflows/ci.yml:152-155` records the intent to widen toward ~900 MB.
**Why it matters:** Today's ceiling is modest but is reached and permanently retained the moment a session touches a representative slice of demos, and never released regardless of what is later open. The stated direction turns a bounded cost into an unbounded one unless eviction exists first.
**Change:** Add LRU or reference-counted eviction sized to a byte budget, evicting definitions absent from both the current document and a small recently-used set.
**Effort:** M    **Risk:** Evicting geometry still needed by an in-flight batch plan or an about-to-reapply undo would show blank parts; must coordinate with `preloadDocumentGeometry` and the undo stack.

## 10. Batch the stale-transaction cleanup into one IndexedDB transaction

**Evidence:** `src/cad/persistence.ts:187-202` deletes stale log entries with `Promise.all(stale.map(entry => this.driver.delete(...)))`. Each goes through `IndexedDbDriver.run()` (`:127-135`), which opens a **new** `database.transaction(table, mode)` per call — up to `CHECKPOINT_INTERVAL` (50, `:20`) concurrent read-write transactions for one checkpoint.
**Why it matters:** This runs every 50 committed edits during any active session (`:272-304`), not just at boot — a recurring steady-state cost, with per-transaction overhead and lock contention against the concurrent `put('checkpoints', …)` in the same method.
**Change:** Add `deleteMany(table, keys)` to `StorageDriver` so one transaction covers every stale key.
**Effort:** S    **Risk:** Other `StorageDriver` implementers (the cloud relay outbox, `:336-343`) must implement it too.
