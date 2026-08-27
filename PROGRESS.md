# Brickwright implementation progress

**Updated:** 2026-08-27 (productionization pass 1)
**Current state:** browser CAD system on the real compiled catalog, with an exact-transform kernel, 6-DOF snapping, persistent connection edges and triangle-confirmed collision

## Phase status

| Phase | Status | Implemented evidence | Missing before production |
| --- | --- | --- | --- |
| A — Data compiler | **Working** | Real compilation of LDraw 2026-07 + LDCad Shadow Library + Rebrickable bulk CSV: 22,941 identities, 324,331 connectors, 322 colours, 1,150 renames resolved, per-file licence capture, content-hashed manifests, measured coverage report, deterministic fixture in CI | Thumbnail generation; BVH serialization; wider geometry pack; ShareAlike/TOS review before public redistribution |
| A2 — Geometry compiler | **Working** | Full `.dat` dependency flattening with BFC `CERTIFY`/`CW`/`CCW`/`INVERTNEXT`, matrix-handedness winding, colour 16/24 inheritance, quad splitting, type-2 hard edges, 35° crease smoothing, SHA-256-named binary container, 0 unresolved references across 500 parts | Texture/printed-part material slots; decimated LOD for very large panels |
| B — CAD kernel | **Working** | Pure TS document in LDraw's native frame with **exact matrix bases** (Euler demoted to a UI affordance); orthonormal-and-clean basis enforced on ingest; schema-2 migration from Euler documents; atomic operations, monotonic revisions, stale-write rejection, protected regions, connector-derived stacking planes | Patch-based transactions, IndexedDB history, named checkpoints/branches, multi-document tabs |
| C — Renderer | **Working slice** | Three.js WebGL rendering real compiled meshes, shared geometry per definition, per-slice materials for baked colours, LDraw hard edges, transparent/metallic finishes from `LDConfig.ldr`, shadows, selection, ghosts, camera views | Batched/instanced production path; section/explode render modes; thumbnail cache for the palette |
| D — Human editor | **Working slice** | Search across all 22,941 identities, placeable/all toggle, place/select/multi-select/subassembly-select/move/rotate/recolour/duplicate/delete/connect/lock | Marquee selection, palette drag-and-drop positioning, array/mirror UI, complete keyboard map |
| E — Connections | **Working** | **Full 6-DOF frame solver** (`Tm = Tt·Ft·C·Fm⁻¹`): studs-not-on-top, right-angle Technic and hinge halves solve through the same expression as stacking. Per-family joint freedoms with closed-form continuous parameters, axial flip where insertion is two-sided, orientation-independent target discovery, axis-alignment requirement for a mate, occupancy exclusion, multi-match scoring, Connect-tool pinning. Classification grounded in measured Shadow Library conventions. **Persistent `ConnectionEdge`** records carrying joint, revision and provenance | Articulated manipulation UI driving the joint graph; per-family regression fixtures across the whole library |
| F — Collision | **Working** | Box broad phase → mated-connector clearance → **`three-mesh-bvh` triangle-pair confirmation**, with per-verdict certainty (`exact` / `clearance-subtracted` / `unknown`) surfaced in the UI. Eliminates the axis-aligned-box false positives that dominate rotated parts. Per-definition BVH cache | Penetration-depth discrimination inside the narrow phase; measured per-connector mating volumes replacing the family-level allowance; offline BVH serialization into the asset |
| G — Structural graph | **Working** | Connection graph from coincident compatible connectors with axis alignment, memoized per revision and shared by solver/validation/viewport; persisted edges with joint types; component count, loose groups, weak single-connector attachments | Rigid-component collapse and articulation graph, cut-set analysis |
| H — Transactions | **Working slice** | Shared human/agent history, undo/redo, proposals, provenance, optimistic concurrency | Checkpoint UI, branches, transaction-log persistence beyond the current snapshot |
| I — WebMCP | **Working slice** | Dynamic 12/17-tool inventories, compact reads, catalog coverage reporting, preflight/apply, render capture, feedback, capability virtualization, kernel-side refusal of unplaceable parts | Native ChatGPT desktop acceptance run; tool-result compatibility audit against the shipping WebMCP build |
| J — Agent UX | **Working slice** | Inspect/Propose/Build modes, visible ghosts, activity history, notes, locked cockpit | Transaction-wave assembly animation, anchored 3D note authoring, autonomous hierarchical planning |
| K — Output | **Working slice** | `.ldr` and `.mpd` export with `STEP` and one submodel per subassembly; import flattens nested submodels and reports unplaceable references; exact IDs/transforms; BOM CSV | BrickLink XML; step reassignment on import |
| L — Instructions | **Prototype** | Step-aware document, timeline, animated build playback | Dependency-based step generation, editable steps/submodels, printable instructions |
| M — Polish | **Strong slice** | Deliberate industrial CAD UI, responsive desktop layout, catalog boot/failure screens, deterministic browser acceptance run | Onboarding, accessibility pass, high-part-count profiling, deployment/CDN |

## Verified now

`npm run check` — **86 tests**, strict TypeScript, production Vite build. The compiler is
driven in-process against committed fixtures, so CI asserts its semantics — colour crosswalk,
snap-grid expansion, measured bounds, hashed files, determinism — not just that it exits zero.

`npm run test:e2e` — real Chromium/WebGL run asserting relationships rather than magic numbers:

```json
{
  "catalog":  { "identities": 22941, "placeable": 500, "colors": 322 },
  "coverage": { "authoritativeConnections": 17364, "connectors": 324331,
                "compiledMeshes": 500, "triangles": 453624 },
  "showcase": { "parts": 31, "connections": 204, "collisions": 0,
                "unverifiedCollisions": 0 },
  "rotatedBoxProbe": "triangle confirmation cleared the box overlap",
  "meshAssetsFetched": 9,
  "refusedUnplaceableIdentity": "15208",
  "exportType1Lines": 33
}
```

The run also confirms: the placeable set is a strict subset of the catalog; compiled
`.bwmesh` assets actually reach the GPU; leaving Build mode revokes write tools; preflight
does not mutate; acceptance is exactly one revision; an unplaceable identity is refused with
`GEOMETRY_UNAVAILABLE`; a stale plan is refused with `STALE_DOCUMENT`; a 12 LDU
bounding-box overlap between a rotated brick and its neighbour is cleared by triangle
confirmation; and the export's type-1 line count matches the document.

The opening document is a 31-part rover with **204 mated connectors, 0 collisions and 1
connected component**, verified by a unit test so the invariant cannot regress.

## Productionization pass 1

Worked in the order the productionization plan sets out, on the grounds that a wrong
snap/collision layer only makes an agent produce incorrect work faster.

1. **Exact transforms.** Euler degrees are no longer persistent truth. The document stores
   an orthonormal row-major basis — the same nine numbers an LDraw type-1 line carries — so
   an arbitrary off-axis rotation and a mirrored reference round-trip exactly. This also
   fixed a latent export defect: decomposition was previously lossy for anything that was
   not a quarter turn.
2. **Persistent connection edges.** `document.connections` records each mated pair with its
   joint freedom, the revision it appeared at and its provenance, so the structural graph
   survives save, load and export instead of being re-inferred anonymously.
3. **6-DOF snapping.** The solver composes connector frames rather than translating, so it
   derives orientation. A brick now lands correctly on the sideways stud of a headlight
   brick or bracket — 36 such parts are in the pack — which the previous translation-only
   solver could not express at all. Continuous joint parameters are solved in closed form.
4. **Collision narrow phase.** `three-mesh-bvh` triangle confirmation behind the box phase
   and the mating-clearance layer, with certainty on every verdict.

Two bugs surfaced and were fixed while doing this: target discovery depended on cursor
*orientation*, hiding every sideways-stud target; and `bvhcast` candidate pairs were being
depth-tested before being intersected.

## Honest evidence boundary

**What changed since the last update:** the browser no longer renders generated stand-in
geometry. Every visible part is compiled LDraw geometry with LDCad connection metadata, and
the procedural fallback catalog has been deleted rather than kept as a safety net.

**What is still bounded:**

- **Geometry pack, not the whole library.** 500 of 22,941 identities have compiled geometry.
  The remaining 22,441 are searchable and inspectable but not placeable, and the kernel says
  so explicitly. Widening the pack is a compiler flag and a bandwidth decision, not new work.
- **Collision is broad-phase.** Box overlap minus a family-level mating allowance. It catches
  real interpenetration and does not flag correct stacking, but it is not triangle-exact, and
  the insertion allowance for pin/axle/bar/ball pairs is deliberately permissive.
- **Snapping solves poses but does not yet drive articulation.** Joints are classified and
  their freedoms recorded on each edge, and the solver resolves the free parameter from
  operator intent. What is missing is the manipulation side: rotating a hinge assembly about
  its own axis, or sliding an axle within its range, is not yet an editor gesture.
- **Collision does not discriminate touching from interpenetrating at the triangle level.**
  The mating-clearance layer handles the legal-stacking case, and the triangle phase removes
  box false positives, but a contact whose depth is zero is not distinguished from a shallow
  one inside the narrow phase itself.
- **Transactions still clone whole documents.** History stores before/after snapshots rather
  than patches, and persistence is still `localStorage` rather than IndexedDB. Fine at the
  current scale; the wrong complexity profile for thousands of parts.
- **The renderer is still one scene object per part.** Instancing and batching are not in
  place, so large-model performance is bounded by object count rather than geometry.
- **Identity coverage is partial and labelled.** 5,465 exact external identity matches and
  5,727 heuristic base-design matches out of 22,941. Heuristic matches inherit category only,
  never colour evidence, and every record reports which it is.
- **WebMCP is verified in Chromium, not in ChatGPT.** The dynamic tool lifecycle is exercised
  through the fallback bridge. Native Site Tools registration still needs a run inside an
  eligible ChatGPT desktop build.
- **Instruction playback replays authored steps.** It does not yet synthesize a build order
  from the dependency graph.

## Ordered next work

Continuing down the same critical path:

1. **Patch-based transactions and IndexedDB persistence.** Replace whole-document clones with
   forward/inverse patches, add checkpoints plus a transaction log, and move projects out of
   `localStorage`. This is the next item that blocks scale rather than correctness.
2. **Incremental validation.** Operations already report what they touched; feed that into
   dirty-region collision and connectivity instead of revalidating the whole document.
3. **Renderer batching.** Replace per-part scene objects with definition/colour instanced and
   batched meshes, keeping selection, ghost and connector overlays separate. Benchmark
   1k/5k-part fixtures against a committed budget.
4. **Articulated manipulation.** Drive hinge, axle and ball edges from their recorded joint
   freedoms so mechanisms move as mechanisms.
5. **Penetration depth in the narrow phase**, plus measured per-connector mating volumes to
   replace the family-level allowance.
6. **Schema-driven WebMCP contracts.** One runtime schema source deriving both TypeScript
   types and JSON Schema, a versioned tool profile hash, and a centralized sanitized error
   envelope.
7. **Widen the geometry pack**, add compiler thumbnails and offline BVH serialization.
8. Native ChatGPT Site Tools acceptance; instruction steps from the dependency graph;
   BrickLink XML.
9. Complete the licence review: ShareAlike scope for the normalized connector dataset, and
   Rebrickable redistribution terms for the compiled derivative.
