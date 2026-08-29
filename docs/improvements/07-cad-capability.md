# CAD and domain capability

Ten findings about the product's central claim — that a model which renders is
not the same as a model that stands up. The kernel is unusually honest about its
own limits (README and PROGRESS both label assumptions as assumptions), so
several of these are about closing gaps the project has already named.

Each is marked **missing** (the capability does not exist) or **shallow** (it
exists but is coarser than a real builder needs).

**Verified by hand:** `DEFAULT_CLUTCH_GRAMS = 100` and `capacity = studs * clutchGrams`
with no lever arm; `mirrorTransformAcrossX` with both call sites passing
`axisLdu: 0`; `EDGE_RENDER_BUDGET = 6000`; exactly two collision clearance
constants; `src/cad/ldraw.ts` exports only `exportLDraw`, `exportMpd` and
`parseLDraw`.

---

## 1. Model flexible parts instead of rigid transforms only — **missing**

**Evidence:** `src/cad/types.ts:13-25` — `ConnectionFamily` has exactly 12 members, mirrored by `COMPATIBLE_PAIRS` (`src/cad/connections.ts:40-48`). Every placed part carries one `transform: Transform` (`types.ts:236-246`), a single orthonormal basis plus position. A repo-wide search for `flexible|hose|rubber band|caterpillar tread` across `src/cad`, `tools/*.mjs` and all three docs returns nothing.
**Why it matters:** Rubber bands (catapults, suspension), flex and pneumatic hoses (engine detail), rubber tracks and string or chain (cranes, pulleys) are staples of intermediate-to-advanced MOCs. None can be represented: there is no spline part class and no joint kind for continuous bend. These parts are **unbuildable in this tool**, not merely shallow.
**Change:** A deformable part class (control-point path, segment count resolved from measured length) with its own connector family for hose and band ends, plus a renderer path that tessellates a tube along the spline.
**Effort:** L    **Risk:** New document schema alongside `PartInstance`, new patch/persistence shape, LDraw translation, and collision can no longer rely on one cached per-definition BVH for a deforming body.

## 2. Weight clutch capacity by connector type and lever arm — **shallow**

**Evidence:** `src/cad/statics.ts:58` — `DEFAULT_CLUTCH_GRAMS = 100` is the only strength figure in the module. `computeOverloads` tallies `studs` once per mated pair **without reading `pair.a.family`/`pair.b.family`** (`:262-269`), then at `:338` computes `capacity = studs * clutchGrams` and flags `grams > capacity`.
*(Precision note: the word `moment` does appear at `:130-148`, but that is the first moment of mass used to derive a centre of mass — there is no bending-moment or lever-arm term in the overload check itself.)*
**Why it matters:** A stud, a Technic pin, a bar-and-clip and a hinge have very different real pull-apart strength. And a cantilever fails from torque long before hanging mass exceeds a flat clutch budget — **a light part at the end of a long beam stresses its root connector far more than the same mass one stud out, yet this report scores them identically.** A builder trusting "0 overloaded" can still watch a cantilever twist off.
**Change:** Scale `capacityGrams` per connector family, and add a moment check: hanging mass × horizontal distance of its centroid from the anchoring connectors, against a capacity-times-arm threshold.
**Effort:** M    **Risk:** Changes overload counts, so `statics.test.ts` fixtures need new expectations; per-family constants without published data reintroduce the "assumption, not measurement" caveat this module otherwise guards carefully.

## 3. Generalise mirroring across any axis, and flag chirality — **shallow + missing**

**Evidence:** `mirrorTransformAcrossX` (`src/cad/capabilities.ts:173`) reflects only through the plane x = axis, and both call sites hardcode `axisLdu: 0` (`TransformPanel.tsx:371`, `commands.ts:82`). Separately, `mirror` appears nowhere in `types.ts`, `catalog.ts` or `tools/catalog-compiler.mjs` — **no part carries a known mirrored counterpart.**
**Why it matters:** Builders mirror front-to-back at least as often as left-to-right, so most real symmetry work needs an axis this tool never exposes. More seriously, mirroring a moulded asymmetric part produces a negative-determinant placement that renders fine but **may match no purchasable real part** — exactly the renders-vs-stands-up gap this project exists to catch, except here it passes straight into the BOM and the export.
**Change:** Parameterise the mirror plane in the UI and schema; separately source a mirror-pair table (LDraw's own naming already distinguishes many left/right files) and warn in validation when a negative-determinant instance has no known counterpart.
**Effort:** S for the axis; L for chirality data.    **Risk:** Axis change is plumbing; chirality data risks false positives if incomplete, so it must warn rather than block.

## 4. Source part price and current availability — **missing**

**Evidence:** No `price`, `cost` or `availability` field exists anywhere in `tools/catalog-compiler.mjs`. `BomLine` (`src/cad/bom.ts:4-12`) carries only ids, name, colour and quantity, and `exportBomCsv` (`:37-41`) emits exactly those. The README's "colour honesty" feature is about whether a colour was ever seen on an official set — **historical evidence, not purchasability.**
**Why it matters:** A BOM is what a builder uses to actually acquire parts. Without price or stock signal, "not virtual" only means a colour existed once on a retail set — there is no way to budget a build or notice a real-but-discontinued colour before committing.
**Change:** Record a per-part/colour price and availability signal in the compiler beside the existing colour evidence, and add a price column plus total to the CSV and the delivery-centre view.
**Effort:** M    **Risk:** Price goes stale immediately, unlike geometry — needs an explicit "as of" timestamp or a live-fetch path, or it becomes a new undisclosed inaccuracy in a codebase that otherwise labels every assumption.

## 5. Add BrickLink XML export and a real project archive — **missing**

**Evidence:** `src/cad/ldraw.ts` exports exactly `exportLDraw` (`:43`), `exportMpd` (`:76`) and `parseLDraw` (`:157`); `bom.ts` exports CSV only. No file under `src/cad/` mentions BrickLink XML or wanted lists. `PROGRESS.md`'s own "ordered next work" item 2 states it: *"BrickLink XML and project archives, so a verified design can move between browsers and into a purchasing workflow without manual CSV conversion."*
**Why it matters:** BrickLink's wanted-list XML is the standard path from a validated model to an actual multi-store order with quantities and colours pre-filled. And because history, notes and constraints do not travel with `.ldr`/`.mpd`, **a "verified buildable" document loses its verification trail the moment it leaves the browser.**
**Change:** `exportBrickLinkXml(document)` reusing the aggregation `bom.ts` already computes; plus a JSON project archive (document + transaction log) importable through the existing session layer.
**Effort:** M (XML) / L (archive round-trip).    **Risk:** **No part carries a BrickLink id at all.** `tools/catalog-compiler.mjs:726` writes `bricklinkIds: []` unconditionally — measured: 0 of 900 compiled parts. (An earlier revision of this line cited "5,465 of 22,941"; that is `README.md:56`'s crosswalk to *Rebrickable*, a different identifier. The correction matters, because it turns this from a coverage caveat into a prerequisite.) There is also no LDraw→BrickLink *colour* mapping anywhere in the repo. Both gaps must be closed before an export can emit a correct `<ITEMID>` or `<COLOR>`. See [specs/01-bricklink-export-and-archive.md](../specs/01-bricklink-export-and-archive.md).

## 6. Harden geometry-pack selection beyond popularity ranking — **shallow**

**Evidence:** `tools/catalog-compiler.mjs:794-799` selects the runtime pack by `sort((a,b) => b.frequency - a.frequency)` over official-set appearance frequency, with a hand-maintained `packExtra` override (`:790,798`) as the only backstop. **`PROGRESS.md` documents this already failing:** *"Recompiling against a refreshed LDraw library reshuffled the frequency ranking… and the showcase rover's windscreen fell out of it"* — fixed by hand-pinning that one part. Coverage is 900 of 22,941 modelled shapes (~3.9%).
**Why it matters:** A ranking that already silently dropped a part the project's own showcase depends on will as easily drop an uncommon-but-structurally-important part a real design needs — and unlike the showcase, **nobody is watching to pin it back.** Most non-showcase MOCs will hit `GEOMETRY_UNAVAILABLE` on ordinary parts.
**Change:** Add category and connector-family floor guarantees to pack selection so a minimum survives ranking per family and category; keep `packExtra` for showcase pins but stop relying on it as the correctness backstop.
**Effort:** M    **Risk:** Floors grow the compiled asset (already 47.7 MB for 900 parts) and compile time — a size-budget decision the project already flags as pending.

## 7. Verify build steps are physically insertable, not just graph-reachable — **shallow**

**Evidence:** `computeBuildOrder` (`src/cad/instructions.ts:59-116`) picks the next part purely by connection-graph adjacency with a height tie-break, and `verifyBuildOrder` (`:177-197`) only checks that each part's neighbour was placed earlier. **Nothing inspects the direction a part must travel or whether that path is blocked.** The module's own comment (`:12-16`) says the guarantee is about attachment, not good instructions.
**Why it matters:** A sequence can satisfy "everything connects to something placed earlier" while being physically impossible — an interior mechanism sequenced after the shell that encloses it, or a part needing to slide through a gap an earlier wall has closed. **A "verified" sequence can still leave a builder holding a part with nowhere to put it.**
**Change:** Add an insertion-direction check: test whether a part's final pose is reachable by translating in from outside the partial assembly's envelope (or along its connector axis) without intersecting placed parts, and report a new warning code when connectivity passes but insertability does not.
**Effort:** L    **Risk:** A real motion-planning problem; a coarse swept-volume test against existing BVHs is the cheapest approximation but will have false negatives and positives — ship as a warning, never a hard refusal.

## 8. Report dropped LDraw import metadata instead of discarding it — **shallow**

**Evidence:** `parseLDraw`'s loop (`src/cad/ldraw.ts:190-247`) recognises only `0 STEP` (`:192`) and lines starting with `1 ` (`:199`). Every other `0`-prefixed line — `0 GROUP`, `0 !LEOCAD GROUP_BEGIN`, `0 !LDCAD GROUP_DEF`, `0 !LPUB`, local `0 !COLOUR` palettes — falls through unrecorded. `ImportReport` (`:118-124`) tracks placed, submodels, steps, unknown parts and missing geometry, but nothing for ignored metadata. Yet `ExportCenter.tsx:209` tells the operator *"Unknown and uncompiled references are reported, never silently dropped"* — true only of part references.
**Why it matters:** The tool most real MOC designers use is BrickLink Studio, and Studio's logical grouping lives in exactly the meta-commands this parser skips. **Importing a real Studio file collapses all grouping into one flat subassembly with zero warning** — contradicting the product's own stated promise one layer above where it is enforced.
**Change:** Track unrecognised `0`-prefixed meta lines in `ImportReport` (count plus sample keywords) and surface it beside the existing warnings.
**Effort:** S (reporting) / L (reconstructing groups as subassemblies).    **Risk:** Reporting-only is near risk-free; it only adds visibility.

## 9. Degrade large-model edge rendering gracefully — **shallow**

**Evidence:** `src/editor/PartBatch.tsx:64` — `EDGE_RENDER_BUDGET = 6000`, documented at `:56` as "Above this many batched parts, hard edges are dropped entirely." `:71` — `MERGED_EDGE_VERTEX_BUDGET = 600_000`, past which a batch "renders without them." No LOD path exists anywhere in the renderer.
**Why it matters:** Hard edges are what make a render or a build-guide screenshot read as bricks rather than smooth grey masses. Large real builds — modular buildings, big Technic, fleets — routinely exceed 6,000 parts, well within reach of this project's own generators (a four-building block already reached 1,304 parts). **Exactly the large-model class this tool targets is the one that loses its outlines, all at once rather than gradually.**
**Change:** Replace the binary cutoff with distance or silhouette-priority edge culling (near and silhouette edges kept, interior and occluded dropped first), or decimate the merged edge buffer rather than omitting it.
**Effort:** M    **Risk:** Any LOD adds per-frame or per-camera-move cost to a path that currently rebuilds only on commit — needs re-profiling against the regressions pass 14 already fixed.

## 10. Measure per-connector collision clearance — **shallow**

**Evidence:** `src/cad/collision.ts:340,343` defines exactly two constants — `STUD_CLEARANCE_LDU = 4.05` and `INSERTED_CLEARANCE_LDU = 26`. `matingAllowance` (`:374-380`) picks between them based only on whether either family is in `INSERTED_FAMILIES` (`:353-368`, eight families including the catch-all `generic`). **A shallow accessory clip and a deep pin-in-hole joint both receive the identical 26 LDU allowance.**
**Why it matters:** The blind spot is concentrated on shallow-insertion connectors — accessory clips and SNOT brackets — the same category finding 2 flags as the likeliest source of real structural failure, because an under-inserted shallow connector can hide inside an allowance sized for a much deeper one.
**Change:** Compute actual mutual insertion depth per connector pair at compile time from the `axial` extent already on `ConnectionFeature`, and use that measured value instead of a two-bucket constant.
**Effort:** M    **Risk:** LDCad's `axial` data is only 75.7% authoritative, so some pairs still need a documented fallback rather than silently defaulting to zero allowance.
