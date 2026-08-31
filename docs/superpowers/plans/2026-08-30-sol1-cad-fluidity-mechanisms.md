# CAD fluidity, controls, and moving parts

> **Assigned agent:** GPT 5.6 Sol (1)
> **Sibling plans (run in parallel, do not execute them):**
> - Claude Opus 5 — [`2026-08-30-opus-agent-ml-generation.md`](./2026-08-30-opus-agent-ml-generation.md)
> - GPT 5.6 Sol (2) — [`2026-08-30-sol2-liquid-glass-showcases.md`](./2026-08-30-sol2-liquid-glass-showcases.md)
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 3D CAD feel like a single instrument — damped camera, one pointer pipeline, gizmos that always hit, placement ghosts that interpolate, joints that drag without hitching — and extend the kernel so play features (crane, ramp, turret, lattice, clock) are first-class, not a pile of unarticulated bricks.

**Architecture:** Keep the kernel as the only document writer. Replace drei `OrbitControls` with `camera-controls` (already how `@react-three/drei` `CameraControls` is implemented). Collapse overlapping pointer owners (placement raycaster, `ViewportControls`, `TransformControls`, joint manipulators, section handles) behind one dispatcher. Deepen articulation and add assembly planners the other two agents consume. Fix the re-render storm (`useCad` has no selector; zero `React.memo` in `src/editor`).

**Tech Stack:** three 0.185, `@react-three/fiber` 9.7, `@react-three/drei` 10.7 (already depends on `camera-controls` transitively — **add `camera-controls` as a direct dependency**), `three-mesh-bvh` 0.9 (already direct). Vitest + existing e2e `tools/e2e/cad-editing.mjs`.

**Spec:** This document. Opus owns generation/agent policy. Sol (2) owns CSS and demos. You own how the model *moves on screen* and how mechanisms exist in the kernel.

## Global Constraints

- Dirty tree is fine; do not commit or push unless the operator asks.
- Hexclave, landing copy, and glass tokens are out of scope.
- Do not edit `*.css` (including `src/styles.css`). HUD must keep existing class names (`viewport-quick-controls`, `viewport-control-row`). Sol (2) restyles them.
- Do not change `ASSISTANT_TOOLS`, `server/assistant/prompt.ts`, or generation phases. Opus owns those. You **may** append mechanism capabilities (see seams).
- Do not author `public/demos/**` or `tools/build-demos.mjs`. Export planners demos will call.
- Renderer still never writes the document except on a committed drag (`docs/integration/renderer.md`).
- LDraw +Y down; keep `ROOT_MATRIX` / `sceneMatrix` as the only frame conversion.
- `prefers-reduced-motion` already flows into `MotionController`. New camera flights must honour it (instant jump).
- User instructions override skill approval gates for this turn.

---

## Why this workstream exists (pain, measured)

The operator’s pain: the interface is glitchy; there is no fluidity or smoothness; CAD controls are a mess. Building is not enjoyable.

Evidence already in the repo:

| Symptom | Where | What is actually happening |
|---|---|---|
| Camera feels dead / snappy | `CadViewport.tsx` `OrbitControls` `dampingFactor={0.08}` | OrbitControls damping is a lerp on spherical coords. No `setLookAt` easing, no truck, no dolly-to-cursor, no `restThreshold`. Named views (`isometric`, `front`, …) snap. Dock resize rewrites camera with a one-shot scale (`CadViewport.tsx` ~760–771) |
| Controls fight each other | PlacementController + ViewportControls + TransformControls + JointManipulators + section handles + OrbitControls | Each registers `pointerdown/move/up`. TransformControls **disables OrbitControls** while dragging; Escape synthesizes `pointerup` because otherwise orbit stays dead (`CadViewport.tsx` 227–229). Placement sets `enabled: false` on ViewportControls “while a placement ghost owns the pointer” |
| Gizmo “missing” or tiny | `SelectionManipulator` comment: gizmo inside 1/20 scale root was 20× too small | Workaround: proxy in scene space. Still `size={1.05}` with no min pixel size. Probe `__brickwrightGizmo` exists because this failed in QA |
| Every click re-renders the world | `src/editor/useCad.ts` `useSyncExternalStore` **no selector**; `cadEngine.emit()` replaces the whole snapshot; **zero** `React.memo` in `src/editor` (`docs/improvements/02-performance.md` #5) | Selection, toast, or slider = Toolbar + TopBar + docks + canvas props churn. Feels like hitching even when GPU is fine (5k parts @ 120 FPS when *not* React-thrashing) |
| First click ~48 ms | `idPass` lazy-allocates RT + shader (`02-performance.md` #7) | 24–40× vs later 1.2 ms picks |
| Large models lose brick edges | `EDGE_RENDER_BUDGET = 6000` hard cutoff (`PartBatch.tsx`; `07-cad-capability.md` #9) | Illinois demo is 11,473 parts — outlines vanish. Looks “glitchy” / like a grey mass |
| Quick controls vs toolbar vs Transform panel vs gizmo vs keyboard | `ViewportQuickControls.tsx`, `Toolbar.tsx`, `TransformPanel.tsx`, `shortcuts.ts`, `G`/`R`/`V`/`C`, `R` also rotates placement | Same actions, three places, conflicting `R` |
| Joints hitch | `findArticulatedJoints` once rebuilt adjacency **7.2 s** on a stamped city (`articulation.ts` comment). WeakMap cache fixed that | Sweep collision still on a throttle (~11 Hz comment in ViewportControls). Preview can lag the pointer |
| Mechanisms are thin | `ARTICULATED_FAMILIES`: hinge, pin, pin-hole, axle, axle-hole, bar, clip, ball, socket | No gears (mesh coupling), no string/winch, no flex hose, no pneumatic, no turntable as a typed joint, no lattice at arbitrary angles. `build_hinged_flap` is the only parametric mechanism |
| Keyboard CAD is incomplete | `03-accessibility.md` #2 originally claimed no arrows; `ViewportKeyboard.tsx` now exists | Still easy to desync from OrbitControls; canvas focus vs workbench shortcuts |

`docs/cad-editing.md` describes a precise, professional tool. The implementation is several overlapping tools. This plan makes the described tool the only one.

---

## Shared contracts

### Exclusive ownership (this agent)

- `src/editor/render/**`
- `src/editor/CadViewport.tsx`
- `src/editor/PartBatch.tsx`
- `src/editor/PartVisual.tsx`
- `src/editor/environment.ts`
- `src/editor/useCad.ts`
- `src/cad/articulation.ts`
- `src/cad/assembly.ts` — **append new planners only**; do not change `planWall` / `planEnclosure` / `planBrickField` / `planHingedFlap` signatures (Opus and Sol (2) call them)
- `src/cad/collision.ts`, `snapping.ts`, `placement.ts`, `statics.ts`, `connections.ts`, `geometry.ts`, `math.ts` (kernel behaviour)
- `src/editor/workbench/transform.ts`, `transform.test.ts`
- `src/editor/workbench/commands.ts` (CAD commands only)
- `src/editor/workbench/ViewportQuickControls.tsx` (behaviour / aria; class names stay)
- `src/editor/workbench/TransformPanel.tsx` (behaviour)
- `src/editor/workbench/placement-workflow.test.tsx`, `editing.test.tsx`
- `tools/e2e/cad-editing.mjs` if gestures change
- `docs/integration/renderer.md`, `docs/cad-editing.md` (append)

### Forbidden

| Path | Owner |
|---|---|
| `src/agent/**`, `server/assistant/**`, `src/generation/**`, `server/generation/**`, `src/intelligence/**` | Opus |
| `*.css`, `src/features/**`, `Workbench.tsx`, `Dock.tsx`, `TopBar.tsx`, `Toolbar.tsx`, `layout.ts`, `tools/build-demos.mjs`, `public/demos/**` | Sol (2) |
| Hexclave / auth | nobody |

**Toolbar.tsx** is Sol (2) chrome. If you need a camera control moved off the toolbar, **leave the buttons working** (same `w.setCameraView` handlers) and add a note in the coordination log. Do not delete toolbar camera buttons in a CSS-owned file.

**`src/cad/capabilities.ts`** — append only after:

```ts
// === CAD-MECHANISM-OWNED (Sol-1) ===
```

Allowed new ids: `build_crane`, `build_lattice`, `build_snot_hull`, `build_clock_faces`, `build_gear_mesh`, `build_turntable`. Wire `planSharedMutation` to new `assembly.ts` exports.

**`src/cad/types.ts`** — you may add `JointFreedom` variants (e.g. `winch`, `gear`) **additively**. Do not rename existing families. Opus’s graph stays valid.

**`src/cad/engine.ts`** — only if a new operation type is required. Prefer composing existing `part.add` / `part.transform` / `connection` ops like `planHingedFlap` does.

**`useWorkbench.ts`** — shared with Sol (2) (layout) and Opus (intent). **Avoid editing it** if possible. Camera/placement APIs already exist (`setCameraView`, `fitView`, `focusSelection`, `placeArmed`). If you must, touch only camera/gizmo/placement fields and tell Sol (2) in the coordination log.

**`package.json`** — adding `camera-controls` is allowed. Do not bump three/fiber/drei majors. Do not add Tailwind, Rapier, or postprocessing without a note — bloom on the CAD view is a Sol (2) call.

**Catalog pack** — if a planner needs a part not in the 900-part pack, **append** its id to `packExtra` in the `catalog:build` script in `package.json` (append-only, coordinate with Sol (2) demo pins). Do not reshuffle the frequency ranking (`07-cad-capability.md` #6).

---

## Current control surface (read these files first)

- `CadViewport.tsx` (~1,600 lines) — scene, cameras, OrbitControls, TransformControls, placement, batches, HUD overlays. **This file is the mess.** Split as you go: `CameraRig.tsx`, `SelectionManipulator` already inner; move manipulator to `render/SelectionManipulator.tsx`.
- `render/ViewportControls.tsx` (~1,100 lines) — GPU pick, marquee, lasso, joints, sections, quality, capture. Pointer listeners on window.
- `render/ViewportKeyboard.tsx` — lives in R3F tree “so it can reach OrbitControls”.
- `render/Manipulators.tsx` — joint + section handles (R3F pointer events converted to canvas coords at bottom of ViewportControls).
- `render/jointDrag.ts`, `sweep.ts`, `motion.ts`, `quality.ts`, `idPass.ts`, `framing.ts`
- `workbench/transform.ts` — `planGizmoTransforms`, snap-on-delta, locks, frames
- `workbench/ViewportQuickControls.tsx` — two `<select>` + ortho/frame/snap
- `cad/articulation.ts` — rigid groups vs articulated families; `articulate_joint` capability
- `cad/assembly.ts` — `planHingedFlap` uses hinge 3937/3938
- `docs/integration/renderer.md` — imperative `RendererControlSurface` on `window.__brickwrightRenderer`
- `docs/cad-editing.md` — operator-facing contract; **keep it true** after you change gestures

---

## Unfiltered research dump (CAD / 3D / mechanisms / OSS)

Evaluate license and bundle size. Brickwright is AGPL-3.0-only; prefer MIT/Apache/Unlicense.

### Camera / navigation (priority)

1. **camera-controls** (MIT) — https://github.com/yomotsu/camera-controls — npm ~3.8M weekly. Smooth `setLookAt`, `truck`, `dolly`, `rotateTo`, `fitToBox`, `rest()`, `moveTo`, pointer + touch + wheel with inertia. **drei `CameraControls` wraps this.** Replace OrbitControls. Honour orthographic (supported).
2. **three OrbitControls** (current) — damping only; no interpolations API. Keep as fallback behind a flag for one release if needed, then delete.
3. **three MapControls** — not a brick CAD; skip.
4. **drei `CameraControls`** — https://drei.docs.pmnd.rs/controls/camera-controls — R3F-ready. Prefer this over raw camera-controls unless you need an API drei hides.
5. **drei `PresentationControls` / `Stage`** — marketing; not for CAD.
6. **CAD conventions:** Blender (MMB orbit, shift-MMB pan, wheel dolly, numpad views, `.` frame), Studio/LeoCAD (RMB pan often), Fusion (orbit modifier). Brickwright today: LMB orbit (OrbitControls default), RMB pan (`cad-editing.md`: “Right-drag still pans”). **Preserve RMB pan and selection LMB.** camera-controls `mouseButtons` must be mapped explicitly.
7. **Dolly-to-cursor** — camera-controls `dollyToCursor`. Makes zoom feel “into the brick under the mouse.” Enable.
8. **View cube** — drei `GizmoHelper` + `GizmoViewport` already imported in CadViewport. Keep; drive `setLookAt` instead of slamming quaternion.
9. **Framing** — `render/framing.ts` `boundsFrame` already aspect-correct. Plug into `fitToBox` / `setLookAt` with 0.4–0.6s smoothTime unless reduced motion.

### Gizmos / manipulators

10. **drei `TransformControls`** (current) — known issues: orbit disable, scale inheritance, `onObjectChange` every pointer move (you already resolve snaps there — **expensive**). Throttle snap resolve to animation frames; show a cheap preview matrix every move, legal snap on rAF.
11. **drei `PivotControls`** — on-object, more “spatial.” Consider for joints; keep TransformControls for move/rotate tools so the mental model stays CAD.
12. **drei `DragControls`** — too free-form for clutched bricks.
13. **three-viewport-gizmo** / custom view gizmo — optional; GizmoHelper may suffice.
14. **Min pixel size** — scale gizmo so helper projected size ≥ 96 px (`__brickwrightGizmo` already measures this). Clamp `size` by camera distance.
15. **Blender-style axis keys** during grab (`X`/`Y`/`Z`, Shift to invert) — TransformPanel already has locks; bind keys only when tool is move/rotate and canvas focused.

### Pointer / gesture OSS

16. **@use-gesture/react** — not required if camera-controls owns the canvas; using both causes fights. **Do not add** unless you remove camera-controls listeners.
17. **Pointer capture** — ViewportControls already window-listens. Prefer `setPointerCapture` on the canvas for drags (Dock splitter already does this well in `Dock.tsx` — copy that pattern, don’t edit Dock).
18. **CLICK_SLOP_PX = 4`** — keep; use for orbit vs click-select disambiguation (camera-controls `rest` + distance).

### Performance / hitching

19. **`useSyncExternalStoreWithSelector`** — from `use-sync-external-store/with-selector` or React 19 `useSyncExternalStore` + manual snapshot compare. Split: `useCadSelection()`, `useCadDocumentRevision()`, `useCadValidation()`. Panels should subscribe narrowly. **This is the #1 fluidity fix that is not GPU.**
20. **React.memo** on PartBatch, Toolbar is Sol (2); you memo `CadViewport` inner scene pieces.
21. **InstancedMesh + BVH** — already. `02-performance.md` #8: slack capacity on instance buffers so add/remove doesn’t reallocate every brick. Do it.
22. **three-mesh-bvh** — already a dep. Use for sweep if not already.
23. **Edge LOD** — replace binary 6000 cutoff with `allocateEdgeBudget` in `quality.ts` (already exists conceptually). Distance / silhouette first. `07` #9.
24. **Warm idPass** — idle `requestIdleCallback` after first beauty frame (`02` #7).
25. **r3f-perf** — dev-only overlay. Fine behind `?debug=perf`. Do not ship in prod bundle.
26. **instanced-mesh2** — probably unnecessary.
27. **meshoptimizer** — skip unless edge buffers blow memory.
28. **WebGL2 `EXT_color_buffer_float`** — idPass already custom; don’t switch to GPU picking libraries.

### Physics / joints (preview only)

29. **@react-three/rapier** — **do not** make Rapier the source of truth. Kernel clutch ≠ game physics. Optional later for “wiggle the crane.” Out of this plan.
30. **Existing `sweep.ts`** — keep swept collision as the legality oracle during joint drag.
31. **Gear coupling** — not in `ConnectionFamily`. Implement as a **derived constraint** in articulation: when two `axle` parts have gears in mesh (detect via nearby axle-hole parts with known tooth counts if catalog data exists; otherwise a capability `build_gear_mesh` that records a `gear` joint pair with ratio). Driving one axle `articulate_joint`s the other. Start with 8t/24t if those parts are in the pack; otherwise document missing pack ids.
32. **Winch / string** — `07-cad-capability.md` #1 flexible parts are **missing**. Full spline hoses are a large kernel change. For City-Tower-class crane: **kinematic fake** — a `winch` joint (revolute) maps rotation → prismatic hook translation along boom axis, with a line renderer (drei `Line`) for the cable. Not a simulated catenary. Collision: hook as a part; cable is visual-only and labelled as such in statics (does not carry load).
33. **Turntables** — parts 48452 / 18938 etc. If compiled, treat as revolute with `continuous: true`. Capability `build_turntable`.
34. **Technic pins vs friction pins** — `INSERTED_CLEARANCE_LDU = 26` vs `STUD_CLEARANCE_LDU = 4.05` (`07` #10). Per-family insertion depth is a kernel improvement; do if you touch collision anyway.
35. **Clutch × lever arm** — `07` #2. Out of critical path; don’t block fluidity.

### Assembly planners to add (Sol (2) demos + Opus generate will call)

36. **`planCrane({ originLdu, boomStuds, color })`** — mast enclosure + boom as hinged flap or pin joint + hook brick + winch mapping. Uses 3937/3938 or Technic pin if available.
37. **`planLattice({ widthStuds, depthStuds, heightCourses, bayStuds, color })`** — repeating X-bracing on stud lattice. True Eiffel angles need non-90 transforms; v1 can be ortho lattice (plates on edge / clips) that **looks** like ironwork at display scale. v2: `rotateWorld` by `atan(1/2)` with 4-decimal LDU (OMR Eiffel thread: 4–5 decimal places).
38. **`planSnotHull({ widthStuds, depthStuds, layers, color })`** — plates on edge around a keel (`originForSurface` already in catalog). This is how Falcon-class hulls work. v1: rectangular doughnut of SNOT; not a perfect saucer.
39. **`planClockFaces({ diameterStuds, originLdu })`** — four (or four-sided) tile mosaics + hinge-free cylinder of bricks. Clock hands as bar-clip, `articulate_joint` revolute.
40. **`planGearTrain({ stages, originLdu })`** — if gears not in pack, skip with a thrown `SharedCapabilityError` naming the missing definition ids.

### Open-source LEGO CAD (steal ideas, not code dumps)

41. **LeoCAD** (GPLv2) — hierarchical models, snap, camera. UX: piece chooser + view cube.
42. **LDCad** — connector engine Brickwright already shadows. Don’t vendor C++.
43. **BrickLink Studio** — closed; gold standard smoothness. Notes: MMB/RMB conventions, collision colour, hide connectors toggle, flexible hose editor.
44. **buildinginstructions.js** (Unlicense) — https://github.com/LasseD/buildinginstructions.js — step playback. Brickwright has `instructionPlayback` in `ViewportAnimation`. Make it smooth with `MotionController` (already).
45. **qk-lego** — https://github.com/skasriel/qk-lego — React/Three/LDraw. Clone/place UX.
46. **gr8brik** — Three LDrawLoader + TransformControls. Same stack, rougher.
47. **LDraw OMR** — technique reference for lattice angles and flex; **do not import official-set MPDs**.

### LEGO sets as mechanism requirements (not as models to copy)

48. **60473 City Tower (2025)** — string crane (rotate, luff, hoist), metro (prismatic along rails), skate ramp (static geometry), launch pad (maybe hinge), garages (hinged doors = `planHingedFlap`), modular interiors (subassemblies). **Your crane + hinge planners unblock Sol (2).**
49. **UCS Millennium Falcon 75192** — ramp (revolute), turrets (revolute), landing gear (prismatic or revolute). Midi 75375 has **none** of these — do not use it as the bar.
50. **10307 Eiffel Tower** — lattice + small flex; 10k parts → edge LOD + selector subscriptions are mandatory or the demo will feel broken.
51. **10253 Big Ben** — clock hands.

### A11y / keyboard (stay compatible with Sol (2) chrome)

52. Focusable canvas, `aria-describedby` cheat sheet (`03` #2). `ViewportKeyboard.tsx` — connect to CameraControls `setLookAt` for view keys (`⌥1` etc. already in Toolbar — don’t break).
53. Nudges already in cad-editing.md (arrows in move/rotate, PageUp/Down). Verify after pointer rewrite.

### What not to do

54. Do not enable CSS `backdrop-filter` on the WebGL canvas parent in this agent (you shouldn’t touch CSS anyway).
55. Do not add Rapier, Cannon, or ammo.
56. Do not auto-orbit (`turntable`) in the editor default; keep it as the existing optional `ViewportAnimation`.
57. Do not change LDU scale or Y-down.
58. Do not implement full deformable hoses in this pass unless leftover time after fluidity (it is a schema change; `07` #1). Winch line renderer is enough.

---

## Design

### A. Single pointer dispatcher

Introduce `render/pointerRouter.ts`:

```ts
export type PointerOwner = 'none' | 'orbit' | 'select' | 'marquee' | 'placement' | 'gizmo' | 'joint' | 'section'

export function classifyPointerDown(event: PointerEvent, ctx: HitContext): PointerOwner
```

Rules (highest wins):

1. Placement armed → `placement` (existing PlacementController)
2. Hit gizmo / joint / section handle → that owner; camera-controls `enabled = false` until pointerup
3. Shift+drag empty → marquee (existing)
4. Left drag on part with slop → select vs orbit: if movement < slop on button-up, select; else orbit
5. Right drag → pan (truck)
6. Wheel → dollyToCursor

Camera-controls must not see pointer events while owner ≠ orbit/none. Set `.enabled` accordingly; do not synthesize fake pointerup unless the library requires it (prefer `.cancel()`).

### B. Camera rig

New `render/CameraRig.tsx` (inside Canvas):

- `CameraControls` from drei, `makeDefault`
- `mouseButtons: { left: ACTION.ROTATE, middle: ACTION.DOLLY, right: ACTION.TRUCK, wheel: ACTION.DOLLY }` — confirm against current UX (no middle-button requirement on laptops: wheel dolly is enough)
- `smoothTime={0.35}` (or library equivalent), `draggingSmoothTime` lower
- `minDistance={1}` `maxDistance={100000}` keep
- Named views: `controls.setLookAt(...)` from `boundsFrame` + canonical yaw/pitch, `enableTransition`
- `F` / `Shift+F` / fit on load: `fitToBox` on model bounds
- Orthographic: CameraControls supports it; keep existing camera switch
- Reduced motion: `smoothTime = 0`
- Expose `frameParts(ids)` on `RendererControlSurface` via the same rig (already in the interface)

Dock-resize camera compensation must go through the rig, not raw position multiply.

### C. Gizmo

- Move `SelectionManipulator` out of CadViewport.
- `size` adaptive: `size = clamp(96 / projectedHandlePx, 0.6, 2.4)` using the existing probe math each frame while visible, not only for tests.
- Snap solve on rAF; pointer move only updates proxy matrix.
- On commit, existing `planGizmoTransforms` + `poseRefusal`.
- Escape: `controls.cancel()` / reset proxy; camera-controls `.enabled = true` in `finally`.

### D. React subscription split

`useCad.ts`:

```ts
export function useCadSnapshot<T>(selector: (s: EngineSnapshot) => T, isEqual?: (a: T, b: T) => boolean): T
```

Default workbench may still take a wide snapshot **once** if Sol (2) hasn’t memoized panels — you still prevent CadViewport from receiving a new `document` object identity when only selection chrome changed. **Critical:** `CadViewport` props `document` should be the kernel document; selection changes must not clone the document. If `emit()` clones today, fix engine to keep document identity when only selection changes (`engine.ts` — allowed, it’s kernel).

Read `src/cad/engine.ts` `emit` / selection path before changing.

### E. Edges + picking + instances

- Warm idPass after first frame.
- Edge budget from `quality.ts` `allocateEdgeBudget` as a function of part count and tier, never a cliff at 6000.
- Instance buffer slack (`02` #8).

### F. Motion / placement ghosts

- Placement preview: lerp ghost opacity; illegal pose stays red (`cad-editing.md`) but **does not jitter** (quantize to grid in the preview path — already snapped).
- Proposal reveal already in `motion.ts` — keep.
- Joint drag: run sweep every rAF, not 11 Hz, **if** sweep is cheap on the neighbourhood (`sweepNeighbourhood`). If not, keep throttle but interpolate the visual.

### G. Mechanism planners + capabilities

Implement in `assembly.ts` with the same `AssemblyPlan` `{ operations, partIds, report }` pattern as `planHingedFlap`.

Wire capabilities. Opus will call them from generation when present; Sol (2) will call them from `build-demos.mjs`.

If a required definition is not placeable, throw `SharedCapabilityError` with `GEOMETRY_UNAVAILABLE` and the id — do not emit floating approximations.

### H. ViewportQuickControls

Behaviour only: camera `<select>` should call the rig’s named-view transition (through existing `w.setCameraView`, which you implement as smooth). Do not restyle the selects.

Optional: add `data-camera-live="true"` so Sol (2) can glass them.

---

## Task list

### Task 1: Document identity vs selection emit

**Files:** `src/cad/engine.ts`, tests under `src/cad/engine.test.ts` / session tests

- [x] When selection changes, `document` object identity is stable; snapshot.selection is new.
- [x] CadViewport `React.memo` with compare on `document`, `selection` (shallow), `tool`, `gridLdu`, `cameraView`, `renderMode`, `placement`.
- [x] `npm test -- src/cad src/editor/useCad.ts` (add selector tests).

### Task 2: `useCadSnapshot` selector

**Files:** `src/editor/useCad.ts`

- [x] Selector hook with `Object.is` default.
- [x] CadViewport parent uses revision+document+selection slices rather than the 70-field workbench object **if** that parent is `ViewportStage.tsx` (owned? ViewportStage is workbench — **Sol (2) file**). Then subscribe inside `CadViewport` via `useCadSnapshot` directly so you don’t edit ViewportStage.
- [x] Tests for selector not firing on unrelated toast/status if those live on the snapshot — skip fields CadViewport doesn’t need.

### Task 3: CameraControls rig

**Files:** Create `src/editor/render/CameraRig.tsx`; modify `CadViewport.tsx`, `ViewportKeyboard.tsx`, `framing.ts`, `controlSurface.ts`

- [x] Add dependency `camera-controls` matching drei’s nested version (read `node_modules/@react-three/drei/package.json`).
- [x] Replace `OrbitControls`.
- [x] Named views + F / Shift+F / cameraResetKey use transitions.
- [x] Reduced motion: instant.
- [x] RMB pan, LMB orbit, wheel dolly-to-cursor.
- [x] Update `docs/cad-editing.md` camera paragraph if any binding changes.
- [x] Unit-test framing math; e2e later.

### Task 4: Pointer router

**Files:** Create `src/editor/render/pointerRouter.ts` + test; modify `ViewportControls.tsx`, PlacementController in CadViewport

- [x] Table-driven tests for owner classification (synthetic events).
- [x] Gizmo/joint/section disable camera-controls.
- [x] Escape always restores camera-controls.enabled.
- [x] No synthetic pointerup unless a test proves the library still needs it.

### Task 5: Gizmo hit target + rAF snap

**Files:** Extract `src/editor/render/SelectionManipulator.tsx`; `transform.ts`

- [x] Min projected size 96 px.
- [x] Snap on rAF.
- [x] Existing transform tests still pass (`src/editor/workbench/transform.test.ts`).
- [x] `__brickwrightGizmo` probe still works for e2e.

### Task 6: idPass warm-up + edge LOD + instance slack

**Files:** `idPass.ts`, `PartBatch.tsx`, `quality.ts`, `CadViewport.tsx`

- [x] Warm pick on idle after first frame.
- [x] No binary drop at 6000; budget function; test at 7000 members still has some edges.
- [x] Instance arrays have spare capacity; test that adding one part doesn’t throw / reallocates only past slack.

### Task 7: Joint drag smoothness + winch kinematic

**Files:** `jointDrag.ts`, `ViewportControls.tsx`, `articulation.ts`, `Manipulators.tsx`

- [x] Visual interpolation; sweep neighbourhood.
- [x] Optional `winch` freedom: rotation → slide on a named axis; cable line in Manipulators (no CSS). **Done, via an authored-freedom channel — see below.**
- [x] Tests in `jointDrag.test.ts`.

### Task 8: Assembly planners + capabilities

**Files:** `assembly.ts`, `assembly.test.ts`, `capabilities.ts` (append marker), `schemas.ts` is **Opus-owned**.

**Conflict:** `src/agent/schemas.ts` must learn new capability ids or `schemas.test.ts` fails (it asserts every SHARED_CAPABILITY has a schema).

**Resolution:** Add a **minimal** Zod `z.record` / dedicated schema **only for the new ids** at the bottom of `schemas.ts`, or export schemas from `src/cad/capabilitySchemas.ts` (create) and have `schemas.ts` import them. Creating `src/cad/capabilitySchemas.ts` keeps Opus’s file from growing; add one import line in `schemas.ts` — that’s a one-line merge conflict risk. Prefer **new file** `src/cad/mechanismSchemas.ts` imported from `schemas.ts`. If `schemas.test.ts` auto-discovers via `SHARED_CAPABILITIES`, your import must run first. Coordinate: a one-line import is acceptable.

- [x] `planCrane`, `planLattice` (ortho v1), `planSnotHull`, `planClockFaces`.
- [x] Tests: collision-free, connected, at least one articulated edge for crane and clock hands.
- [x] Capabilities `build_crane`, `build_lattice`, `build_snot_hull`, `build_clock_faces`.
- [x] Missing geometry → clear error, no ghost bricks.

### Task 9: Keyboard + control surface

**Files:** `ViewportKeyboard.tsx`, `controlSurface.ts`

- [x] Canvas `tabIndex={0}` on the gl dom element (CadViewport Canvas `onCreated`).
- [x] View keys drive CameraRig.
- [x] `RendererControlSurface.frameParts` uses smooth fit.
- [x] `docs/integration/renderer.md` note CameraControls.

### Task 10: E2E + docs

- [x] `BRICKWRIGHT_E2E_URL=... node tools/e2e/cad-editing.mjs` — 23/23 against `vite dev` on Apple M3 Max.
- [x] `npm test -- src/editor src/cad/assembly.test.ts src/cad/articulation.ts`
- [x] Append `docs/cad-editing.md` with camera-controls bindings.
- [x] Coordination log for Opus/Sol (2).

---

## Verification

```sh
npm test -- src/editor src/cad --maxWorkers=2
```

Manual (required by operator rules for UI):

- Orbit inertia; dolly toward cursor; named view eases.
- Arm a part, click-place, Escape cancels, orbit still works.
- Move gizmo: handles large enough; snap; Escape; orbit works.
- Drag a hinged flap; release; undo.
- Open Illinois demo (11k): edges still visible at quality auto; selection doesn’t hitch the camera.

If browser tools are available, do this. If not, say so and rely on e2e + tests.

---

## Success criteria

1. One pointer owner at a time; no “orbit stuck off” after gizmo/Escape/placement.
2. Camera transitions are interpolated unless reduced motion.
3. Gizmo projected size ≥ 96 px in the default desktop layout.
4. Selection-only updates do not rebuild PartBatch (document identity stable).
5. Edge rendering degrades, not dies, above 6000 parts.
6. First pick after idle warm-up is in line with later picks (no 48 ms cliff) — measure with existing renderer benchmark if possible.
7. `planCrane` and `planSnotHull` exist and pass kernel gates, ready for demos/generation.
8. No CSS, no generation prompt, no demo JSON in this diff.

---

## Coordination log

- Opus: `realize.ts` may import `planCrane`, `planLattice`, `planSnotHull`, `planClockFaces` from `assembly.ts`. If missing, they fall back.
- Sol (2): class names on quick controls unchanged; glass them. Demos must call the new planners; don’t duplicate crane math in `build-demos.mjs`.
- Sol (2): do not put `backdrop-filter` on the canvas element; frost docks only.
- Opus: `schemas.ts` may gain an import from `src/cad/mechanismSchemas.ts`.

#### Task 7 completion notes (Opus, picking this up)

**Visual interpolation — done.** `sweepJoint` now reports its own `elapsedMs`,
and `ViewportControls` rations the sweep against a half-frame budget: the
preview transform is recomputed on every pointer sample unconditionally (it is
`articulate` over the island, a few dozen matrix multiplies, and it is what the
hand feels), while the swept-collision oracle re-runs only when the last one
says it fits, or once its own measured cost has elapsed. On a small model that
is still every sample; dragged through a dense region of the 11k model it
degrades to about a 50% duty cycle instead of owning the frame. Nothing is lost
by skipping — `endJoint` re-sweeps unconditionally before committing, so what
reaches the document is always fully checked.

**Winch — deferred, and here is the measurement.** The plan proposes a
kinematic winch: a revolute freedom mapping rotation to hook translation. Two
findings say it cannot be done without a kernel change larger than this task:

1. **Joint freedoms are derived, not authored.** `jointFor(a, b)` in
   `connections.ts` maps a *pair of connector families* to a freedom, and
   `deriveConnectionEdges` recomputes every edge from geometry. There is no
   channel through which a planner can say "this particular axle is a winch
   drum". A new `JointFreedom` variant would be unreachable — dead code.
2. **No real sliding joint has a usable stroke either.** The obvious
   alternative — build the hoist as a genuine `bar:clip` or `axle:axle-hole`
   cylindrical joint and drag it — fails on data. Across the whole production
   catalog exactly 59 connectors carry an `axial` range and every one of them is
   a `clip` with `axial: 8`, i.e. ±4 LDU of grip slop. `axle` and `bar`
   connectors carry no axial extent at all, so `jointFor` clamps their range to
   `[0, 0]` and they rotate without translating. A hoist built this way would
   have a stroke of zero.

The honest fix was an authored-freedom channel on the document, and it has now
been built:

- `ModelDocument.jointOverrides?` — optional, on the same terms as `modules`, so
  every document written before it still loads. Keyed by `{partId, featureId}`
  pairs rather than edge id, because edge ids are derived too.
- A `joint.override` operation, with a patch inverse, so asserting a freedom is
  undone by replay like any other edit. Asserting the same joint twice replaces
  rather than appends: two freedoms for one joint is not a state the kernel
  should be able to hold.
- Both edge builders apply it — the bulk `deriveConnectionEdges` and the
  incremental diff in `engine.ts`. Missing the second would have meant a winch
  reverting to a plain axle the next time anything near it moved, which is the
  first thing the tests check.
- A `winch` variant on `JointFreedom`: the drum turns about `axis`, the load
  travels along `payoutAxis`, `drumRadiusLdu` converts between them, and the
  travel clamps to the cable's length. The load translates and does not spin.
- `findArticulatedJoints` treats an asserted freedom as drivable regardless of
  connector family, and excludes it from the rigid-group adjacency. Both were
  needed: without the first the joint is filtered out; without the second its
  two sides land in one rigid group and it is not offered at all.
- `Manipulators.tsx` draws the payout line over the joint's declared range, in
  model units rather than inside the screen-scaled handle group. An affordance,
  not a catenary, and it carries no load.

Covered by `src/cad/jointOverride.test.ts` (11 tests). The two measurements that
motivated the original deferral still stand and are still the reason this could
not be done any other way: `jointFor` derives from connector families with no
authored channel, and no real sliding joint has a usable stroke — all 59 axial
connectors in the production catalog are clips with ±4 LDU of grip slop.

### Sol-1 live integration notes (2026-08-30)
- `camera-controls@3.1.2` promoted from drei transitive dependency; MIT, no additional control-library copy. Existing toolbar and quick-control handlers remain live; class names unchanged.
- New planner exports are in `assembly.ts`; `mechanismSchemas.ts` imported/registered in `schemas.ts`. Minimal `CommandDeck.tsx` exhaustive argument cases were necessary when adding capability ids; no chrome/layout edits.
- Planner v1 limits are explicit: crane has a real luffing hinge but no hoist/cable; lattice is orthogonal columns/decks; hull is connected side-stud skins; clock provides four independently hinged plate hands, not timekeeping/gearing.
- No Sol-1 changes to CSS, generation policies, demo JSON/build script, Hexclave, or landing copy. No commit/push.
- Integration QA: all 747 editor/kernel tests passed on Node 24; original 15-check CAD editing browser run passed. Renderer benchmark measured 5k p95 picks 5ms and draw-call delta 0 for +400 parts, but legacy renderer suite then stops at its removed `.viewport-title-block p` HUD selector (sibling chrome). Extended CAD suite uses current production surface instead.
- Opus coordination: new generation shared capability ids also require exhaustive `src/editor/CommandDeck.tsx argsFor()` cases; Sol-1 added only its four mechanism defaults. Any generation defaults should be added by Opus (not guessed here).
- Sol (2) coordination at latest rerun: shared live CSS currently places Inspector over the palette and collapses the canvas (see `artifacts/cad-editing/failure.png`), so first Add click is intercepted by generation textarea. No CSS workaround made by Sol-1. Will rerun after the stylesheet split settles.
