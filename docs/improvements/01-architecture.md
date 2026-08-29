# Architecture and code health

Ten findings. The codebase is ~87k lines of source across thirteen areas with a
deliberate workstream-ownership model (`docs/integration/README.md`); most of
these are about that model eroding at the edges.

**Verified by hand:** `tsconfig.node.json` does include `"src"` wholesale, and
the two projects check **731** and **839** files under `src/` respectively — the
application is type-checked twice on every build. `registerGalleryRoute` and
`registerShareRoute` both still exist with **zero call sites**.

---

## 1. Stop routing two workstreams' model providers through an unpublished internal

**Evidence:** `src/agent/provider.ts:2,121,212` and `src/generation/provider.ts:9,168` both import `hexclaveAuthorizationHeader` from `../hexclave/authorization` — a deep import into workstream 7's internals. `src/hexclave/` has no `index.ts`, and `src/platform/index.ts` (workstream 7's documented public surface) exports `hexclaveUrlOptions` at `:53` but never this.
**Why it matters:** `docs/integration/README.md:6-9` states a workstream may only reach another through its published entry point. Two workstreams depend on an internal file of a third. If Hexclave's client wiring changes internally, both providers break with no contract to warn either team, and the rule the project sets for itself goes unenforced.
**Change:** Re-export `hexclaveAuthorizationHeader`/`AuthorizationHeaderSource` from `src/platform/index.ts` and repoint both providers to `'../platform'`.
**Effort:** S    **Risk:** Low, mechanical; verify no circular import (platform must not import agent/generation).

## 2. De-duplicate the two independent NDJSON stream readers

**Evidence:** `src/agent/provider.ts:58` and `src/generation/provider.ts:217` both hand-roll the same algorithm — `getReader()`, `TextDecoder({ stream: true })`, manual buffer with `indexOf('\n')`, trailing flush — independently, in two workstreams, with no shared utility.
**Why it matters:** The buffering and decoding is the hard part to get right (partial UTF-8 sequences split across chunks, split lines, tail handling), and a fix has to be found and applied twice.
**Change:** Extract `readNdjsonLines(stream, onLine)` into `src/platform/contracts.ts`, which both files already import, and let each caller layer its own event parsing on top.
**Effort:** M    **Risk:** The two differ in error handling — agent emits a typed error event and continues, generation throws and aborts. The shared helper must preserve both.

## 3. Break up the 904-line `useWorkbench` hook

**Evidence:** `src/editor/workbench/useWorkbench.ts` is 904 lines in a single exported function (`:108`) with 16 `useState`, 37 `useCallback`, 7 `useMemo`, 6 `useEffect`, returning an object literal (`:824-903`) with **76 properties** spanning camera, placement, selection, transform prefs, saved selections, connect-flow, articulation and viewport hints.
**Why it matters:** Every consumer of the workbench depends on this one undifferentiated surface. Any change to the editor's interaction model touches this file, making it the highest-risk merge point for workstream 5 and the hardest file to review or test in isolation.
**Change:** Split by concern into composable hooks (`useCameraState`, `usePlacementFlow`, `useSelectionVisibility`, `useConnectFlow`) that `useWorkbench` composes.
**Effort:** L    **Risk:** High blast radius — the 76-key return is consumed widely, and splitting must preserve referential stability of callbacks that consumers hold in dependency arrays.

## 4. Split `ViewportControls.tsx`'s single 915-line function

**Evidence:** `src/editor/render/ViewportControls.tsx` is 1,035 lines and the exported component runs `:117-1032` — one function body with 12 `useCallback`, 10 `useEffect`, 8 `useMemo`, 5 `useRef` and 142 nested declarations.
**Why it matters:** This is the renderer's core interaction surface (drag, joint manipulation, picking, section handles). Concentrating the subsystem in one closure makes it hard to reason about which nested handler closes over which ref, and makes the file's own documented invariant — "exactly one call into `commandBus`… on release" (`docs/integration/renderer.md:8-10`) — harder to verify by inspection than if that call site were isolated.
**Change:** Extract cohesive lifecycles (pointer/drag, joint-drag, picking) into named module-level functions or sub-hooks.
**Effort:** L    **Risk:** R3F ref closures break subtly during extraction (stale closures, ref timing); run the renderer suite after each step.

## 5. Stop type-checking all of `src/` twice on every build

**Evidence:** `tsconfig.node.json:11-21` includes `"src"` alongside `api`, `tools`, `server`, even though `tsconfig.app.json:18-19` already includes it. Measured: `tsc -p tsconfig.app.json --listFilesOnly` reports **731** files under `src/`; `tsc -p tsconfig.node.json --listFilesOnly` reports **839**. `src/App.tsx` and all 18 `.test.tsx` files appear in both.
**Why it matters:** Nearly the whole application is checked twice on every `tsc -b` — so every `npm run build`, every `npm run check`, every CI run — roughly doubling that cost for no benefit. Worse, `tsconfig.node.json` adds `"types": ["node"]`, so the same browser source is checked once *with* Node's ambient globals available and once without, an inconsistency that can mask errors depending on which project surfaces them first.
**Change:** Remove the blanket `"src"` from `tsconfig.node.json`'s `include`. TypeScript still resolves the genuine `server/**` → `src/**` cross-imports transitively without `src` being a root entry.
**Effort:** S    **Risk:** Low; confirm `npm run check` still passes, since `server/assistant/provider.ts:6-7` and `server/generation/anthropic.ts:2` do legitimately import from `src/`.

## 6. `ModelDocument.parts[id]` is typed as always-defined; it isn't

**Evidence:** `src/cad/types.ts:314` declares `parts: Record<string, PartInstance>`, indexed by string id at dozens of sites (`useWorkbench.ts:136`, `TransformPanel.tsx:76-77`, `ConnectPanel.tsx:20-21`, `src/webmcp/adapter.ts:205`). Neither tsconfig sets `noUncheckedIndexedAccess`, so every lookup types as `PartInstance`, never `| undefined` — despite a stale or unknown id being an ordinary runtime occurrence, as the defensive `.filter(Boolean)` after some lookups shows.
**Why it matters:** The compiler silently asserts a guarantee that isn't true, across the most-indexed structure in the kernel. `strict: true` is on but does not cover this — it is a separate opt-in — so a stale part id flowing through as if defined is caught nowhere but by manual discipline.
**Change:** Enable `noUncheckedIndexedAccess` and triage, or at minimum fix the highest-traffic sites explicitly.
**Effort:** L    **Risk:** Turning it on globally surfaces many strict-null errors at once; adopt per-directory rather than in one sweep.

## 7. Move collision math off Three.js onto the kernel's own math module

**Evidence:** `src/cad/collision.ts:1` imports `* as THREE from 'three'` and uses `Matrix4`, `Vector3`, `Line3` for pure transform and closest-point math (`:97-165`), even though `src/cad/math.ts:43-350` already implements a dependency-free equivalent. This is not renderer-local: `src/generation/{score,engine,realize,phases}.ts` all import `findCollisions` from it, so the generation pipeline's headless collision checks transitively depend on all of three.js.
**Why it matters:** The project's own docstrings state generation must work headless — "CI, a worker, a server". Yet the kernel's collision math pulls in a rendering library for what its own math module already does. The supposedly render-agnostic kernel is coupled to `three`.
**Change:** Reimplement the point/segment math using `src/cad/math.ts` primitives and drop the `three` import.
**Effort:** M    **Risk:** Collision detection is safety-relevant to physical buildability; the port must be verified numerically equivalent against `src/cad/collision.test.ts` (which itself imports `three` and needs updating).

## 8. De-duplicate the `clamp` helper reinvented inside the kernel

**Evidence:** The identical one-liner is defined verbatim in `src/cad/articulation.ts:188` and `src/cad/connections.ts:178` — and both already import from `./math` for other helpers, but `src/cad/math.ts` exports no `clamp`. Reinvented four more times outside the kernel (`features/explore/projection.ts`, `features/share/render/presets.ts`, `features/share/viewer/state.ts`).
**Why it matters:** This is the shared kernel every workstream imports — the one place duplication is least defensible, since both files were already reaching into the shared math module for everything else.
**Change:** Export `clamp` from `src/cad/math.ts` and remove the private copies.
**Effort:** S    **Risk:** Negligible.

## 9. Delete the dead `registerGalleryRoute` / `registerShareRoute` exports

**Evidence:** `src/features/gallery/index.ts:32` and `src/features/share/index.ts:203` export these with docstrings claiming they are how the platform registry points at each page. **Neither is called anywhere** — confirmed zero call sites across `src/`, `server/`, `convex/`, `functions/`, `tools/`. `src/main.tsx:30-31` instead calls `registerRoute` directly with literal dynamic imports.
**Why it matters:** Two workstreams each built and documented what they believed was the integration seam, and the integrator uses neither. The docstrings describe a boot sequence that is not what happens.
**Change:** **Delete both exports and their docstrings.** Note the researcher offered "either delete them, or wire `main.tsx` to call them" — the second option is wrong. `main.tsx` was deliberately moved off those barrel imports because importing the barrels made the landing page download the CAD mesh decoder, Three.js and the publication renderer before it painted; the comment at `src/main.tsx:25-29` records exactly that. Wiring them back would reintroduce the regression.
**Effort:** S    **Risk:** None — zero call sites.

## 10. Reconcile the ownership table with `src/webmcp/**`

**Evidence:** `docs/integration/README.md:14` lists workstream 2 as owning `src/agent/**` and `server/assistant/**` only. But `docs/integration/agent-workbench.md:7-8` claims it also owns "the per-capability schema extension inside `src/webmcp/**`", and that doc's section 6 (`:224-243`) describes `src/webmcp/adapter.ts` as its work.
**Why it matters:** The README is "the contract between" the ten workstreams; a reader relying on it alone concludes `src/webmcp/**` is unowned. This is precisely the ownership drift the integration map exists to prevent.
**Change:** Add `src/webmcp/**` to workstream 2's row.
**Effort:** S    **Risk:** None — documentation only.
