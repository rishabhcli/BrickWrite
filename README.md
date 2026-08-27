# Brickwright

**Agent-native 3D CAD for physically buildable brick models.** Humans and Codex operate the
same revisioned document, catalog, command bus, constraint kernel, proposals, validation,
viewport and undo stack.

![Brickwright CAD console](docs/assets/brickwright-console.png)

This repository is a working vertical slice, not a mock chat interface. You can search the
real LDraw library, place real parts, select, transform, rotate, recolour, connect, protect,
duplicate, validate, undo, export and replay the model manually. A WebMCP adapter exposes
those same semantics as dynamic Site Tools.

## Run it

```bash
nvm use                 # Node 24
npm install
npm run dev             # http://localhost:4173
```

The compiled catalog is committed, so a fresh clone runs immediately. Open the page in the
ChatGPT desktop app's built-in browser to make native Site Tools discoverable. In a normal
browser the same tools are exposed as a deterministic development bridge:

```js
await window.brickwright.invoke('workspace_get', {})
await window.brickwright.invoke('catalog_search', { text: 'slope 45', requireGeometry: true })
await window.brickwright.invoke('render_capture', { view: 'front', mode: 'beauty' })
```

## The catalog is real, and it says what it does not know

`tools/catalog-compiler.mjs` compiles three independently licensed datasets into immutable
runtime assets. Measured output of the committed build (`catalog/2026-07`):

| Measurement | Value |
| --- | --- |
| LDraw catalog identities | **22,941** (17,982 parts + 4,959 shortcuts) |
| …of which LDraw `~` helper parts, hidden from default search | 2,741 |
| Retired part numbers resolved to their replacement | **1,150** (e.g. `3023` → `3023b`) |
| Parts with authoritative LDCad connection metadata | **17,364** (75.7%) |
| Normalized connectors compiled | **324,331** |
| LDraw colours from `LDConfig.ldr` | **322** |
| Parts with official-set colour production evidence | 5,119 |
| Parts with a resolved category | 11,192 |
| Identity crosswalk to Rebrickable | 5,465 exact (136 of them via an LDraw rename) · 5,727 heuristic base-design |
| Parts with compiled geometry (the runtime pack) | **500** · 453,624 triangles · 22.7 MB |
| Unresolved LDraw references during geometry compilation | **0** |
| LDraw source licensing observed | 22,941 files CC BY 4.0 |

Those two tiers are deliberately distinct. Every catalog identity is searchable and
inspectable; only the pack is placeable. Asking the agent to place a search-only part
returns a teaching error rather than a guess:

```text
[GEOMETRY_UNAVAILABLE] Part 3023 (Plate 1 x 2) exists in catalog 2026-07 but has no
compiled geometry in this build.
Repair: call catalog_search with requireGeometry=true and choose a part that can be placed.
```

There is no procedural fallback catalog. If the compiled assets are missing, Brickwright
refuses to start and says so, because *"is this a real LEGO part?"* must always have a
defensible answer.

LDraw renames parts across updates and leaves the retired number behind as an alias file.
Those numbers stay in circulation for years, so a rename is treated as an authoritative
statement that two numbers denote the same element: lookups and searches follow it, and a
live record with no identity of its own adopts the retired number's external identity,
colour evidence and set frequency.

### Recompiling from source

```bash
npm run catalog:sources   # LDraw complete.zip + LDCad Shadow Library + Rebrickable CSV → .sources/
npm run catalog:build     # → public/catalog/<version>/ + public/assets/geometry/<sha256>.bwmesh
npm run catalog:test-fixture   # refresh the 40-part slice the unit tests run against
```

The compiler resolves LDraw type-1 dependency trees, honours `BFC CERTIFY`/`INVERTNEXT` and
matrix handedness, inherits colour 16/24, splits quads, captures type-2 hard edges, applies
crease-angle smoothing, and packs each part into a SHA-256-named binary container. It parses
and expands LDCad `SNAP_CYL`/`CLP`/`FGR`/`GEN`/`SPH` with `SNAP_INCL`, `SNAP_CLEAR` and grid
expansion, inherits subpart connectors through type-1 transforms, and joins Rebrickable
identities, categories, colour evidence and set-appearance frequency. `npm run
catalog:fixture` verifies the whole pipeline against committed deterministic fixtures.

## What works today

- **Pure TypeScript CAD document** in LDraw's native frame, storing orientation as an exact
  orthonormal basis rather than Euler angles — the same nine numbers an LDraw type-1 line
  carries, so arbitrary rotations and mirrored references round-trip exactly. Three.js and
  React are derived views, never the source of truth.
- **Real compiled LDraw geometry** streamed as content-addressed binary meshes, shared per
  definition, with per-slice materials for colours baked into a part.
- **Authoritative connection semantics** from the LDCad Shadow Library — including details a
  nominal model would miss, such as the centre tube on a 2×2 brick.
- **Data-derived stacking** — mating planes come from each part's own connectors, so slopes,
  curved bricks, grille tiles and windscreens land correctly.
- **Shared command bus** — human and agent edits create the same atomic `Transaction` records.
- **Optimistic concurrency** — every mutation checks `expectedRevision`; stale plans fail
  with repair guidance.
- **Kernel protection** — agent edits cannot mutate protected parts or locked subassemblies.
- **6-DOF connector snapping** — the solver composes connector frames
  (`Tm = Tt·Ft·C·Fm⁻¹`), so it derives orientation as well as position. Studs-not-on-top
  placement, right-angle Technic and hinge halves fall out of the same expression as
  ordinary stacking. Continuous joint parameters are solved in closed form; a mate requires
  aligned axes, not merely coincident points.
- **Persistent connection edges** — each mated pair is recorded with its joint freedom,
  the revision it appeared at and its provenance, so the structural graph survives save,
  load and export.
- **Articulated mechanisms** — hinges, pins, axles, bars and ball joints can be driven from
  the inspector or by the agent, carrying everything rigidly attached to the moving side.
  Stud connections are treated as rigid, because a built brick wall does not hinge.
- **Triangle-confirmed collision** — box broad phase, then a mated-connector clearance
  allowance, then `three-mesh-bvh` triangle-pair confirmation. Every verdict carries its
  certainty (`exact`, `clearance-subtracted`, `unknown`) and the UI shows it, so a result
  reached from bounding boxes alone never reads like a verified one.
- **Connection-graph connectivity** — components, loose groups and weak single-connector
  attachments come from actual mated connectors.
- **Preflight + ghost proposals** — dry-run edits stay visible without mutating the document;
  collision-free proposals apply atomically.
- **Dynamic WebMCP surface** — Inspect, Propose and Build modes register different tool
  inventories, revoked through `AbortSignal`.
- **Agent perception** — `render_capture` returns live PNG pixels plus revision, camera,
  bounds, count and selection metadata.
- **Colour honesty** — 322 real LDraw colours; part/colour pairings with no observed
  official-set appearance are reported as *virtual*, not illegal.
- **Derived build order** — sequencing is a precedence problem over the connection graph, so
  steps are generated with the checkable guarantee that every part attaches to structure
  placed earlier, or is reported as beginning a separately-built subassembly.
- **Interoperability** — `.ldr` and `.mpd` export with `STEP` boundaries and one submodel per
  subassembly; import flattens nested submodels and reports every reference it could not
  place. BOM CSV carries exact LDraw and external identities.
- **Instanced rendering** — parts sharing a definition and colour render as one
  `InstancedMesh`, with each batch's hard edges merged into a single buffer. Measured in the
  browser: 400 extra parts cost 14 extra draw calls, against 810 before merging.
- **Durable local-first projects** — every committed transaction is appended to an IndexedDB
  log on top of a periodic checkpoint, so reopening replays forward from the checkpoint.
  Replay stops at a revision gap rather than applying a log out of order, and the save
  indicator reports whether persistence is durable, memory-only or failing.
- **Enforced agent contract** — one Zod declaration produces both the JSON Schema each tool
  advertises and the validation the gateway applies, so they cannot drift. Errors pass through
  a single redactor that strips credentials, signed URLs, blobs and filesystem paths and never
  relays a stack trace. A versioned tool profile hash lets a plan be refused when the surface
  it was made against no longer exists.

## Tool surface

| Always readable | Propose mode | Build mode |
| --- | --- | --- |
| `workspace_get` | `build_preflight` | `build_apply` |
| `catalog_search` | `proposal_create` | `builder_feedback_respond` |
| `part_inspect` |  | `undo_edit` / `redo_edit` |
| `scene_query` |  | `action_mutate` |
| `render_capture` |  |  |
| `validate_model` |  |  |
| `builder_feedback_get` |  |  |
| `capabilities_search` / `capabilities_help` / `action_read` |  |  |

Behind `action_read` / `action_mutate`: LDraw and MPD export, BOM, catalog coverage, weak
attachments, duplicate, mirror and note responses. Annotations are hints only — revision
checks, protected-region enforcement, geometry availability, colour policy and collision
rejection live in the CAD kernel.

## Verification

```bash
npm run check            # 157 deterministic tests + strict TS + production build
npx playwright install chromium
npm run test:e2e         # real WebGL browser run: catalog load, mesh streaming, WebMCP, export
```

The browser run asserts relationships rather than magic numbers: that the placeable set is a
strict subset of the catalog, that compiled `.bwmesh` assets actually reach the GPU, that
preflight does not mutate, that acceptance is one revision, that an unplaceable identity is
refused, that a stale plan is rejected, and that the export's type-1 line count matches the
document.

Architecture and data-flow details are in [ARCHITECTURE.md](ARCHITECTURE.md); remaining
production work is in [PROGRESS.md](PROGRESS.md).

## Dataset attribution

Brickwright's code is separate from the datasets it compiles. The compiler writes
`catalog/<version>/licenses.json` recording, per dataset, what attribution redistribution
requires.

- **LDraw Parts Library** — geometry, part identity and the LDraw colour table. Every part
  file in the committed build is licensed CC BY 4.0; the compiler records observed licences
  per file rather than assuming one. LEGO® is a trademark of the LEGO Group, which does not
  sponsor, endorse or authorise LDraw or Brickwright.
- **LDCad Shadow Library** (Roland Melkert) — connection metadata, licensed CC BY-SA 4.0.
  Whether the normalized connector dataset constitutes a ShareAlike adaptation needs a
  focused licence review before public redistribution.
- **Rebrickable bulk catalog** — names, categories, colour production evidence and set
  frequency, fetched for local compilation. Redistribution rights for compiled derivatives
  are unspecified and must be reviewed against current Rebrickable terms before deployment.

This repository is an engineering artefact, not legal advice.
