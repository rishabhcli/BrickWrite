# Brickwright implementation progress

**Updated:** 2026-08-27
**Current state:** browser CAD system running on the real, compiled LDraw + LDCad + Rebrickable catalog

## Phase status

| Phase | Status | Implemented evidence | Missing before production |
| --- | --- | --- | --- |
| A — Data compiler | **Working** | Real compilation of LDraw 2026-07 + LDCad Shadow Library + Rebrickable bulk CSV: 22,941 identities, 324,331 connectors, 322 colours, 1,150 renames resolved, per-file licence capture, content-hashed manifests, measured coverage report, deterministic fixture in CI | Thumbnail generation; BVH serialization; wider geometry pack; ShareAlike/TOS review before public redistribution |
| A2 — Geometry compiler | **Working** | Full `.dat` dependency flattening with BFC `CERTIFY`/`CW`/`CCW`/`INVERTNEXT`, matrix-handedness winding, colour 16/24 inheritance, quad splitting, type-2 hard edges, 35° crease smoothing, SHA-256-named binary container, 0 unresolved references across 500 parts | Texture/printed-part material slots; decimated LOD for very large panels |
| B — CAD kernel | **Working slice** | Pure TS document in LDraw's native frame, atomic operations, monotonic revisions, stale-write rejection, protected regions, connector-derived stacking planes | Durable migrations, named checkpoints/branches, multi-document tabs |
| C — Renderer | **Working slice** | Three.js WebGL rendering real compiled meshes, shared geometry per definition, per-slice materials for baked colours, LDraw hard edges, transparent/metallic finishes from `LDConfig.ldr`, shadows, selection, ghosts, camera views | Batched/instanced production path; section/explode render modes; thumbnail cache for the palette |
| D — Human editor | **Working slice** | Search across all 22,941 identities, placeable/all toggle, place/select/multi-select/subassembly-select/move/rotate/recolour/duplicate/delete/connect/lock | Marquee selection, palette drag-and-drop positioning, array/mirror UI, complete keyboard map |
| E — Connections | **Working slice** | Normalized LDCad features with orientation matrices; classification grounded in measured Shadow Library conventions so Technic bores read as pin holes rather than anti-studs, cross axles stay keyed, and named interfaces (hinges, doors, turntables, crane arms) are group-gated; spatial hash, occupancy exclusion, exact alignment, multi-match scoring, Connect-tool connector pinning | Articulated DOF derivation from connector orientation; per-family regression fixtures across the whole library |
| F — Collision | **Working slice** | Deterministic AABB broad phase with mating-clearance subtraction so legitimate stud engagement is not a false positive; insertion allowance for pin/axle/bar/ball pairs; clickable issue entities | `three-mesh-bvh` narrow phase; measured per-connector mating volumes instead of a family-level allowance |
| G — Structural graph | **Working slice** | Connection graph from coincident compatible connectors, component count, loose-group reporting, weak single-connector attachment detection, connected selection substrate | Persisted `ConnectionEdge` records, articulation graph, cut-set analysis |
| H — Transactions | **Working slice** | Shared human/agent history, undo/redo, proposals, provenance, optimistic concurrency | Checkpoint UI, branches, transaction-log persistence beyond the current snapshot |
| I — WebMCP | **Working slice** | Dynamic 12/17-tool inventories, compact reads, catalog coverage reporting, preflight/apply, render capture, feedback, capability virtualization, kernel-side refusal of unplaceable parts | Native ChatGPT desktop acceptance run; tool-result compatibility audit against the shipping WebMCP build |
| J — Agent UX | **Working slice** | Inspect/Propose/Build modes, visible ghosts, activity history, notes, locked cockpit | Transaction-wave assembly animation, anchored 3D note authoring, autonomous hierarchical planning |
| K — Output | **Working slice** | `.ldr` and `.mpd` export with `STEP` and one submodel per subassembly; import flattens nested submodels and reports unplaceable references; exact IDs/transforms; BOM CSV | BrickLink XML; step reassignment on import |
| L — Instructions | **Prototype** | Step-aware document, timeline, animated build playback | Dependency-based step generation, editable steps/submodels, printable instructions |
| M — Polish | **Strong slice** | Deliberate industrial CAD UI, responsive desktop layout, catalog boot/failure screens, deterministic browser acceptance run | Onboarding, accessibility pass, high-part-count profiling, deployment/CDN |

## Verified now

`npm run check` — **51 tests**, strict TypeScript, production Vite build. The compiler is
driven in-process against committed fixtures, so CI asserts its semantics — colour crosswalk,
snap-grid expansion, measured bounds, hashed files, determinism — not just that it exits zero.

`npm run test:e2e` — real Chromium/WebGL run asserting relationships rather than magic numbers:

```json
{
  "catalog":  { "identities": 22941, "placeable": 500, "colors": 322 },
  "coverage": { "authoritativeConnections": 17364, "connectors": 324331,
                "compiledMeshes": 500, "triangles": 453624 },
  "showcase": { "parts": 31, "connections": 204, "collisions": 0 },
  "meshAssetsFetched": 9,
  "refusedUnplaceableIdentity": "15208",
  "exportType1Lines": 33
}
```

The run also confirms: the placeable set is a strict subset of the catalog; compiled
`.bwmesh` assets actually reach the GPU; leaving Build mode revokes write tools; preflight
does not mutate; acceptance is exactly one revision; an unplaceable identity is refused with
`GEOMETRY_UNAVAILABLE`; a stale plan is refused with `STALE_DOCUMENT`; and the export's
type-1 line count matches the document.

The opening document is a 31-part rover with **204 mated connectors, 0 collisions and 1
connected component**, verified by a unit test so the invariant cannot regress.

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
- **Snapping is translation-only.** Connector orientation matrices are compiled, stored and
  rendered, and families are classified from LDCad's own section conventions, but candidate
  generation aligns positions and keeps the moving part's rotation. Hinges, axles and ball
  joints therefore snap by position without deriving their rotational freedom.
- **Identity coverage is partial and labelled.** 5,465 exact external identity matches and
  5,727 heuristic base-design matches out of 22,941. Heuristic matches inherit category only,
  never colour evidence, and every record reports which it is.
- **WebMCP is verified in Chromium, not in ChatGPT.** The dynamic tool lifecycle is exercised
  through the fallback bridge. Native Site Tools registration still needs a run inside an
  eligible ChatGPT desktop build.
- **Instruction playback replays authored steps.** It does not yet synthesize a build order
  from the dependency graph.

## Ordered next work

1. Add BVH narrow-phase collision with measured per-connector mating volumes, replacing the
   family-level allowance.
2. Derive rotational and sliding freedom from compiled connector orientation so hinge, clip,
   axle and ball placements snap with the correct DOF.
3. Widen the geometry pack and add compiler thumbnail generation so the palette shows real
   part previews instead of derived footprint glyphs.
4. Replace per-part scene objects with definition/colour batches; benchmark 1k/5k-part
   fixtures against the interaction budget.
5. Persist `ConnectionEdge` records in the document so the graph survives save/load and can
   carry joint types.
6. Run native ChatGPT Site Tools acceptance and freeze compatible tool/result contracts.
7. Generate instruction steps from the connection dependency graph; add BrickLink XML output.
8. Complete the licence review: ShareAlike scope for the normalized connector dataset, and
   Rebrickable redistribution terms for the compiled derivative.
