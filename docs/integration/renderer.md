# Renderer integration

The CAD viewport, its GPU picking pass, its visibility and section tooling, its
direct joint manipulation and its motion policy. This document is the contract
between `src/editor/render/**` and everything that mounts it.

Two rules govern the whole subsystem and are worth stating before the API:

1. **The renderer never writes the document except on a committed drag.** A
   drag produces a transform *map*, handed back for drawing. There is exactly
   one call into `commandBus` in the entire subsystem
   (`ViewportControls.endJoint`), and it runs once, on release.
2. **Every capability is reachable without the UI.** The workbench draws
   whatever controls it likes; the behaviour lives here and is published as an
   imperative surface, so a panel, an agent and the acceptance run all drive the
   same code path.

---

## `CadViewport` props

The **existing** props are unchanged and remain the supported way to mount the
viewport:

```tsx
<CadViewport
  document selection proposals tool gridLdu
  cameraView cameraResetKey renderMode placement
  onSelect onSelectMany onClearSelection onTransform onPlace onCanvasReady
/>
```

Everything below is **new and optional**. Omitting all of them reproduces the
previous behaviour, with the exception noted under *Selection* — picking is now
resolved on the GPU rather than by CPU raycast, which is a behavioural
improvement, not a contract change.

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `visibility` | `VisibilityState` | uncontrolled | Isolation, ghosting and explicit hiding. Controlled when supplied. |
| `onVisibilityChange` | `(next) => void` | — | Fires when the surface or a manipulator changes visibility. |
| `sectionPlanes` | `readonly SectionPlane[]` | uncontrolled | Clipping/section planes, in **document space** (LDU). |
| `onSectionPlanesChange` | `(next) => void` | — | Fires on add, remove and every frame of a handle drag. |
| `environment` | `EnvironmentName` | `'studio'` | `studio` · `softbox` · `daylight` · `night`. |
| `reducedMotion` | `boolean \| null` | `null` | Overrides `prefers-reduced-motion`; `null` returns control to the media query. |
| `animation` | `ViewportAnimation` | `{}` | `proposalReveal` (default on), `turntable`, `instructionPlayback`. |
| `quality` | `number \| 'auto'` | `'auto'` | Pin a tier index, or govern from measured frame time. |
| `onRendererReady` | `(surface) => void` | — | Receives the imperative control surface once the renderer is live. |
| `onSweep` | `(result \| null) => void` | — | Live swept-collision result during a joint drag. |
| `onJoints` | `(joints) => void` | — | Articulated joints available for the current selection. |

`visibility` and `sectionPlanes` are **optionally controlled**: when the prop is
absent the viewport keeps its own state so the imperative surface still works,
and when it is present the parent owns it. `environment`, `quality` and
transmission additionally accept overrides from the surface, which the viewport
prefers until the corresponding prop changes.

## New exports

From `src/editor/CadViewport.tsx`: `ViewportAnimation`, and the pre-existing
`EditorTool`, `CameraView`, `RenderMode`, `PlacementRequest`, `MarqueeRect`.

From `src/editor/PartBatch.tsx`: `buildMergedEdgeGeometry(members, edges, budget?)`
— the merged hard-edge buffer builder, extracted so the benchmark builds its
scene from the same code the viewport does. `PartBatch` gains optional `idBase`
and `ghostOpacity` props.

From `src/editor/PartVisual.tsx`: `setTransmissionEnabled(enabled)`,
`isTransmissionEnabled()`, `TRANSMISSION_DRAW_BUDGET`, `cachedMaterialCount()`,
and a `fade` prop on `PartVisual`. `surfaceMaterialFor` gains a third optional
`{ fade }` argument.

From `src/editor/environment.ts`: `createEnvironment(renderer, name)`,
`EnvironmentName`, `ENVIRONMENT_INTENSITY`. `createStudioEnvironment` is
retained under its original name.

From `src/editor/render/`:

| Module | Exports |
| --- | --- |
| `ids.ts` | `encodeId`, `decodeId`, `PickRegistry`, `NO_ID`, `MAX_ID` |
| `idPass.ts` | `IdPass`, `OcclusionCycle`, `registerPickable`, `unregisterPickable`, `PICK_LAYER`, `PICK_RADIUS_PX` |
| `regionSelect.ts` | `regionBounds`, `rasterizeRegion`, `coverageInRegion`, `nearestIdInPatch`, `pointInPolygon`, `centresInRegion`, `RegionShape` |
| `visibility.ts` | `isolateByHops`, `resolveVisibility`, `connectionAdjacency`, `NamedViewStore`, `DEFAULT_VISIBILITY` |
| `sectionPlanes.ts` | `SectionPlane`, `createSectionPlane`, `signedDistance`, `boxClipState`, `intersectPlane`, `projectRayOntoAxis`, `offsetPlaneFromDrag`, `rotatePlaneFromDrag`, `bearingInPlane` |
| `jointDrag.ts` | `handlesFor`, `beginJointDrag`, `updateJointDrag`, `jointOperations`, `previewTransforms`, `jointCommitLabel`, `trackballPoint`, `bearingAboutAxis`, `perpendicularTo` |
| `sweep.ts` | `sweepJoint`, `sweepNeighbourhood`, `describeSweep`, `SweepResult` |
| `motion.ts` | `MotionController`, `Tween`, `ease`, `MOTION_DURATIONS`, `staggeredProgress`, `playbackStepAt`, `turntableAngle`, `prefersReducedMotion` |
| `quality.ts` | `QualityController`, `QUALITY_TIERS`, `allocateEdgeBudget`, `screenExtentPixels` |
| `resources.ts` | `ResourceRegistry`, `rendererResources`, `disposeOwnedTree` |
| `capture.ts` | `hashPixels`, `hashDataUrl`, `captureWarnings`, `checkCaptureSet`, `CaptureMetadata` |
| `derived.ts` | `DerivedRunner`, `computeDerived`, `graphOf` |
| `frame.ts` | `lduToScene`, `sceneToLdu`, `sceneMatrix`, `documentRayFromCanvas`, `projectLdu`, `ROOT_MATRIX` |
| `benchmark.ts` | `prepareCatalog`, `buildBenchmarkScene`, `measureFrames`, `measureRenderCost`, `measurePicks`, `layoutBlock`, `populateBatches` |
| `controlSurface.ts` | `RendererControlSurface` and its result types |

## The imperative control surface

Installed on `window.__brickwrightRenderer`, alongside the existing
`__brickwrightRenderStats` and `__brickwrightGizmo` probes, and also delivered
through `onRendererReady`.

**The object is stable for the lifetime of the viewport.** Everything volatile —
the camera, the viewport size, the current joint list — is read through a ref, so
a caller that holds a reference never finds itself calling a snapshot from three
selections ago.

```ts
interface RendererControlSurface {
  version: 1

  pick(x, y, { radius?, cycle? }): { partId, id, latencyMs, cycleDepth }
  pickRegion(shape, { minPixels? }): { partIds, pixels, latencyMs, centreRuleWouldSelect }
  resetCycle(): void
  screenPositionOf(partId): { x, y, behindCamera } | null
  projectPoint(pointLdu): { x, y, behindCamera }
  frameParts(partIds): boolean

  setVisibility(patch): Promise<VisibilityReport>
  getVisibility(): VisibilityReport

  saveView(name) / restoreView(name) / listViews() / removeView(name)

  addSectionPlane('x'|'y'|'z') / listSectionPlanes() / removeSectionPlane(id)
  beginSectionDrag(id, 'offset'|'rotate', x, y) / updateSectionDrag(x, y) / endSectionDrag()

  listJoints(): JointSummary[]
  beginJointDrag(edgeId, handle, x, y) / updateJointDrag(x, y)
  cancelJointDrag() / commitJointDrag() / jointDragState()

  setReducedMotion(boolean | null) / motionPolicy() / settle()
  setEnvironment(name) / setQuality(index | 'auto') / setTransmission(enabled)

  capture(): Promise<CaptureMetadata & { dataUrl }>
  stats(): RendererStats
  resources(): ResourceCounts
  loseContext() / restoreContext()
}
```

`pickRegion` returns `centreRuleWouldSelect` alongside its own answer. That is
deliberate: it lets a caller — and the acceptance run — observe the *difference*
between covered-pixel selection and the projected-centre rule it replaced,
rather than take the new rule's word for itself.

---

## Picking priority — the documented rules

The id pass draws the scene a second time into an off-screen buffer where each
part writes its own 24-bit identity instead of its shaded colour, then reads back
only the pixels in question. It reuses the very same instanced batches through
`scene.overrideMaterial`, so it costs the same draw calls as the beauty pass and
a fraction of the fragment work.

1. **Depth wins.** A single pick returns the identity nearest the camera at that
   pixel. There is no size, order or type preference: what is in front is what is
   picked.
2. **Exact hit first, then nearest within the pick radius.** The centre pixel is
   tested alone before any neighbour, so a direct hit is never overridden by a
   larger part one pixel away. Only if the centre is background does the search
   expand outward ring by ring, stopping at the first ring containing anything.
   The default radius is 4 CSS pixels.
3. **Region selection counts covered pixels, not centres.** An identity is
   selected when at least `minPixels` (default 1) of its pixels lie inside the
   region. The id pass is drawn without antialiasing precisely so that one pixel
   is a genuine cover rather than a blend of two neighbours. Results are ordered
   by coverage.
4. **Only visible surfaces participate.** Ghosted, hidden and clipped-away
   geometry is left out of the pass entirely — it is given no identity range — so
   it can be neither picked nor region-selected. What you cannot see, you cannot
   select. Section planes are installed as *global* renderer clipping planes, so
   the same cut applies to the identity pass.
5. **Cycling is strictly monotonic in depth.** Clicking again within 3 px and
   1.4 s returns the next identity *behind* the last one, by discarding the
   already-walked identities in the fragment shader rather than by moving the
   camera. When the stack is exhausted — or after 8 steps, which is the shader's
   slot count — the cycle restarts at the frontmost, so the interaction loops
   rather than dead-ending.
6. **Ties are impossible.** Every identity is unique per draw and the depth
   buffer resolves coincident surfaces exactly as the beauty pass does.

Interaction bindings, for the workbench's reference: click selects, shift-click
adds, **shift-drag** is a box region, **alt-drag** is a lasso, double-click
selects the subassembly. A drag of more than 4 px is never a click, so orbiting
and gizmo drags do not select.

---

## Measured performance

Measured by `node tools/e2e/renderer.mjs` on an **Apple M3 Max**, headless
Chromium reporting `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max)`. Real
compiled LDraw geometry, real materials, real environment and shadows, at
1600 × 1000 with the default quality tier.

| Parts | Mean | p50 | **Sustained (p5)** | Worst frame | Draw calls | Triangles | Uncapped ceiling |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 119.2 FPS | 120.5 | **112.4 FPS** | 56.5 FPS | 126 | 1,263,520 | 414 FPS (2.42 ms/frame) |
| 5,000 | 120.0 FPS | 120.5 | **112.4 FPS** | 96.2 FPS | 126 | 3,160,768 | 346 FPS (2.89 ms/frame) |

Target: ≥ 30 FPS sustained at 5,000 parts. **Measured 112.4 FPS (p5).**

Across repeated runs the sustained figure at 5,000 parts ranged from 100.0 to
112.4 FPS and the uncapped ceiling from 300 to 346 FPS. The 56.5 FPS worst frame
in the 2,000-part row is a single outlier over 358 frames — one compositor or
collection hitch, not a sustained cost; the 5,000-part run's worst frame in the
same session was 96.2 FPS. Both are reported rather than smoothed away.

Two figures are reported because one alone would be misleading. The
`requestAnimationFrame` figures are what an operator experiences and are capped
by the 120 Hz display — a scene costing 2 ms and one costing 8 ms both read as
120 FPS. The *uncapped ceiling* drives the same scene as fast as it will go and
forces a real GPU sync each frame by reading one pixel back, so it says how much
headroom is left. `glFinish` alone is not sufficient on ANGLE/Metal: it returned
in under 0.2 ms for a three-million-triangle frame, which is a queue submission,
not a frame time.

**Sustained** is the 5th percentile of instantaneous rate — the slow frames,
which are what stutter — not the mean, which can hide a stutter entirely.

| Gate | Target | Measured |
| --- | --- | --- |
| Pick latency, 5,000-part scene | p95 < 50 ms | **p50 1.40 ms · p95 2.10 ms** over 240 picks |
| First pick of a session | — | 6.6 ms (compiles the identity shader, allocates the target) |
| Draw calls, +400 parts | near-flat | **126 → 126, delta 0** (triangles 378,720 → 632,288) |
| Resource growth over 100 picks | none | registry 5 → 5, GPU geometries 39 → 39 |

Draw calls are flat because the id pass reuses the beauty pass's batches and the
plan is rebuilt as a whole on commit: 400 more parts in the same part/colour
combinations join existing `InstancedMesh` instances and existing merged edge
buffers rather than adding their own.

---

## Capture metadata guarantees

`capture()` returns `CaptureMetadata & { dataUrl }` and guarantees:

- **Settled.** Motion is suppressed for the read (reference-counted, so
  overlapping captures cannot un-suppress each other) and every tween is at its
  target. `settled: false` in the metadata is a defect, and `captureWarnings()`
  reports it rather than letting it pass silently.
- **Revision-exact.** `documentRevision` is read from the same snapshot the
  drawn frame came from.
- **Deterministically framed.** A capture request always reframes the named
  view. Reframing only when the *view changes* was not enough: a capture
  sequence that visited the exploded view and returned to beauty left the camera
  wherever the explode had put it, so two "isometric beauty" captures of one
  revision produced different pixels. Framing is now a function of (view,
  bounds) alone.
- **Distinguishable.** `pixelHash` is a two-lane FNV-1a over the drawing buffer,
  sampled every seventh byte — coprime with the four-byte stride, so the walk
  visits all channels. Measured hashes for revision 5 of the showcase:

  | Mode | Hash |
  | --- | --- |
  | `beauty` | `56e64be54f46fa27` |
  | `orthographic` | `ede992e69616d0a6` |
  | `silhouette` | `beb97a803e87c1d6` |
  | `connections` | `7c7296d73d94d9cd` |
  | `exploded` | `c4a2b135b24705f7` |
  | `violations` | `56e64be54f46fa27` |
  | `beauty` (again) | `56e64be54f46fa27` |

  The two `beauty` captures are identical, which is the reproducibility
  guarantee. `violations` matching `beauty` is **correct**, not a collision: the
  showcase has zero collisions, so the diagnostic has nothing to draw. The
  acceptance run asserts inequality only when the kernel reports collisions, and
  requires the five modes that always show different things to be pairwise
  distinct.

A 32-bit digest was rejected: over a two-megapixel image, birthday collisions at
2¹⁶ samples are already about a percent, and the question being asked is "did
anything change".

---

## Materials and lighting

- **ABS.** A satin dielectric at roughness 0.28 with a thin clearcoat at 0.42
  supplying the second, tighter specular that polished ABS has. Roughness varies
  ±12 % over roughly half a stud, injected through `onBeforeCompile` from world
  position rather than through a `roughnessMap`: compiled LDraw geometry carries
  no texture coordinates, so a map would sample one texel for the whole model.
  The variation is quantised into cells, so it reads as surface rather than as
  shimmer under motion.
- **Metallics** are three distinct materials, not one: chrome is a near-mirror
  conductor (roughness 0.07, metalness 1), metallic paint is rougher (0.2 / 0.9),
  and pearl is a dielectric with a thin interference film over it —
  `iridescence` at 0.35 with a 180–420 nm thickness range — which is what makes
  pearl gold read as pearl rather than as flat gold.
- **Transparent elements** use true `transmission` with polycarbonate's index of
  refraction (1.52), thickness and attenuation, **within a budget**. Physical
  transmission renders the scene again into a transmission target for every
  transmissive draw; on a glazed building that took a 1,464-part model from 106
  draw calls a frame to 3,278. The viewport counts the transparent batches it is
  about to issue and enables transmission only at or below
  `TRANSMISSION_DRAW_BUDGET` (6), falling back to alpha with a strong clearcoat
  otherwise. `setTransmission(enabled)` overrides the budget.
- **Environments** are generated, never fetched: four recipes prefiltered
  through `PMREMGenerator` at 64 × 32, each with its own intensity baked in so
  that switching environment does not also change exposure. The key emitter sits
  at the same bearing as the viewport's key light in every recipe — when shading
  and reflection disagree about where the light is, plastic reads as painted.

---

## Scale

- **Adaptive quality.** `QualityController` measures frame time and steps a
  five-rung ladder (dpr, edges, shadow map size, contact shadows, environment
  intensity, antialias) with hysteresis: demote below 30 FPS, promote only above
  52, with a 1.2 s dwell and the sample window cleared on every change so the
  governor cannot ring. Ordered cheapest-sacrifice-first; edges go before
  shadows, because losing contact shadows makes a model appear to float, which
  is a spatial misreading rather than a cosmetic one. No tier substitutes
  geometry: the tool may render a model cheaply, never as the wrong shape.
- **Edge budget.** `allocateEdgeBudget` spends a global merged-edge vertex
  budget on the batches with the largest apparent size, so a model past the
  budget loses its distant background's edges rather than an arbitrary subset.
- **Worker.** `DerivedRunner` runs hop-distance and component labelling off the
  main thread over a structured-cloneable projection (part ids and connection
  endpoints only). The fallback is the *same function*, so the two cannot
  diverge; `VisibilityReport.derivedOn` reports which ran. Measured as `worker`
  in the acceptance run.
- **Disposal.** Every render target, environment texture and merged edge buffer
  is registered against a named scope in `rendererResources` and released in the
  effect that created it. `resources()` reports live counts per scope so a leak
  names its owner. Measured flat across 100 picks.
- **Context loss.** `webglcontextlost` is `preventDefault`-ed, and
  `webglcontextrestored` rebuilds the prefiltered environment and the identity
  target from their own sources and marks every material for recompilation.
  Restoration goes through the renderer's cached `WEBGL_lose_context` object:
  asking a *lost* context for the extension again does not reliably return the
  instance that lost it, and the restore is then silently ignored.

---

## Motion

One controller owns whether the viewport may animate, so "settled" is a single
question with a single answer. `prefers-reduced-motion` is honoured by jumping
to the settled state, not by running the same animation faster. A capture
outranks the preference in both directions.

Channels: selection cross-fade (110 ms), camera flights (520 ms, eased, used by
named views and framing resets), proposal reveal wave (14 ms stagger / 260 ms
fade, compressed past a 1.4 s cap so a 500-part proposal does not take seven
seconds), exploded transition (620 ms), instruction playback (720 ms/step),
turntable (9 s/revolution, phase-zero at t = 0 so a capture is deterministic).

---

## What is *not* proven

Stated explicitly, because an unproven claim in a tool like this is worse than
an absent one.

- **The performance numbers are one machine's.** M3 Max, headless Chromium,
  ANGLE/Metal. Nothing here establishes behaviour on an integrated GPU, on
  Windows/D3D, or under SwiftShader. The harness is committed and prints the GPU
  string, so the measurement is reproducible elsewhere — but it has not been run
  elsewhere.
- **The benchmark scene is favourable to instancing.** It is a stacked block in
  seven part/colour combinations. That is genuinely what a large model looks
  like — a building is a few dozen combinations repeated thousands of times —
  but a model with 5,000 *distinct* part/colour pairs would produce 5,000 draw
  calls and is not covered by any measurement here.
- **Vsync bounds the headline figure.** 120 FPS is the display, not the ceiling.
  The uncapped column is the honest capability number.
- **`gl_InstanceID` requires WebGL2.** The id pass has no WebGL1 fallback. Every
  supported browser provides WebGL2; a context that does not would lose picking
  entirely rather than degrade.
- **Occlusion cycling is 8 deep.** The shader carries eight hidden-identity
  slots. Past eight coincident surfaces at one pixel the cycle wraps instead of
  continuing.
- **The swept check is sampled, not solved.** 12 coarse samples plus 6
  bisections. A collision confined to a window narrower than 1/12 of the
  requested motion *and* missed by the bisection can be stepped over. An exact
  swept-volume test is real work, not a tolerance to tune.
- **The sweep runs on the main thread.** Only its *scope* is bounded — the
  moving island plus the parts inside its swept envelope. Moving it to a worker
  would mean shipping geometry and BVHs across the boundary, which costs more
  than it saves.
- **Transmission is budgeted, not free.** Above six transparent draws the
  viewport silently uses the alpha approximation. It is reported through
  `isTransmissionEnabled()` but there is no UI surfacing it.
- **Section-plane capping is declared but not drawn.** `SectionPlane.capped` is
  carried through the model and honoured by nothing yet: a cut currently shows
  the interior of a hollow shell rather than a solid face.
- **LOD is quality-tier and edge-budget based.** There is no per-part geometric
  LOD — no decimated meshes, no instance-level distance culling. Batch geometry
  is always the full compiled mesh.
- **No leak test spans hours.** Disposal is asserted flat across 100 picks and
  one context loss, not across a long session.

---

## Running the acceptance suite

```bash
npx tsc -p tsconfig.app.json --noEmit
npx vitest run src/editor/render
node tools/e2e/renderer.mjs          # or: node tools/e2e/run-all.mjs renderer
```

`tools/e2e/renderer.mjs` honours `BRICKWRIGHT_E2E_URL` so `run-all.mjs` can boot
one server for every suite; run alone, it starts its own on port 4176.
Screenshots and a machine-readable `measurements.json` land in
`artifacts/renderer/`.

The benchmark runs on its own page — an HTML shell served by intercepting a path
on the dev server's origin, importing `src/editor/render/benchmarkEntry.ts` — so
a frame time is attributable to the renderer rather than to the renderer plus a
React tree, a catalogue panel and a command palette.

---

## Camera and interaction update (August 2026)

`render/CameraRig.tsx` now owns drei CameraControls, backed by the direct MIT-licensed `camera-controls@3.1.2` dependency (the same version already used by drei). This supersedes the earlier fixed-duration camera-flight description: named views, `frameParts`, keyboard camera input and resize corrections use the control's damped transitions (`smoothTime=0.35`, `draggingSmoothTime=0.06`, `restThreshold=0.002`). Reduced-motion policy sets both smoothing times to zero and settles pending motion. `settle()` also flushes CameraControls to its target. Optional turntable playback uses the rig; it remains off by default.

`frameParts` starts a transition rather than awaiting its completion. Capture/tests requiring the destination synchronously must call `settle()` or enable reduced motion. The root LDraw-to-scene conversion is unchanged. Keyboard and imperative clients use the same target, distance and orthographic zoom state as pointer clients. `cameraPose()` additionally reports target, zoom, enabled state and pointer owner for diagnostics.

`render/pointerRouter.ts` is the canvas arbiter. Placement outranks handles; left handles outrank modifier selection; ordinary left presses are provisional selections until 4 px of movement; right/middle presses remain native camera input. CameraControls is cancelled and disabled while another owner holds the pointer. A document-capture guard rejects secondary IDs before native TransformControls can consume them, while camera-owned multi-touch remains unfiltered. There are no replayed pointer events. The only deferred event is the macOS right-click **contextmenu**, delivered after a stationary release rather than opening during a pan.

SelectionManipulator stays outside the scaled model root and resolves snaps once per animation frame, flushing at commit. PlacementGhost interpolates only a render pose, owns/disposes its cloned materials, and never supplies its interpolated pose as kernel truth. Joint previews coalesce pointer samples to frames, sweep each sample, and rerun the final sweep before dispatch. Document writes still occur only on committed edits, never camera motion or preview frames.

### Selection and large-model cost

- `useCadSnapshot(selector, isEqual = Object.is)` and convenience selection/revision/validation hooks coexist with `useCad()`. Validation is cached by immutable document identity and invalidated with derived state. The memoized viewport scene uses stable callback bridges; unrelated chrome updates need not rebuild it.
- Select/Connect keep base batches stable and render selection as a nonpickable overlay. Move/Rotate temporarily exclude selected parts for transform previews. Render-only PartObject/PartBatch components have **no** R3F pointer handlers, so GPU-only picking does not also trigger instance-wide CPU raycasts.
- InstancedMesh buffers use power-of-two high-water capacity (minimum 32), growing only past capacity and not shrinking with ordinary removals.
- Each merged batch retains at most 600,000 sampled edge vertices. At 5 Hz the edge allocator ranks visible batches by projected extent and updates draw ranges without React state. Global drawn batch-edge budgets are 2.4 million vertices at ultra/high, 1.2 million balanced, 400,000 fast and 120,000 minimum. These are draw budgets, **not aggregate retained-memory limits**; individual, nonbatched PartVisual edges are outside that allocator. No per-part geometric/silhouette LOD is claimed.
- After a drawable beauty frame, idle warm-up renders real visible identity geometry and reads one pixel. The previous off-canvas pick could frustum-cull everything and leave shaders cold. This reduces the initial compilation cliff, but does not promise zero allocation cost after every new geometry, context or size change.

`stats()` now includes drawn `edgeVertices`, `batchEdgeVertices` (excluding helpers/grid), pickable `instanceBuffers` (`objectId`, count, capacity), and `identityWarmupComplete`. Warm-up resets on camera, document-id and viewport-size changes. Completion means a warm pass returned, not that every subsequently loaded geometry variant is warm. The CAD editing suite checks real pointer gestures, interpolation, selection-buffer identity, a crane hinge commit/undo and the existing 11k-part Illinois model. It requests hardware acceleration like the renderer benchmark and records the actual GPU; SwiftShader remains a fallback, not a performance-equivalent backend. These are local browser/kernel checks, not cloud or cross-device performance guarantees.
