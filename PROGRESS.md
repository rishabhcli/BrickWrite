# Brickwright implementation progress

**Updated:** 2026-08-27 (productionization pass 8)
**Current state:** browser CAD system on the real compiled catalog, with an exact-transform kernel, 6-DOF snapping, persistent connection edges, triangle-confirmed collision and self-contained build-guide output

## Phase status

| Phase | Status | Implemented evidence | Missing before production |
| --- | --- | --- | --- |
| A — Data compiler | **Working** | Real compilation of LDraw 2026-07 + LDCad Shadow Library + Rebrickable bulk CSV: 22,941 identities, 324,331 connectors, 322 colours, 1,150 renames resolved, **900 compiled meshes and 900 rendered thumbnails**, per-file licence capture, content-hashed manifests, measured coverage report, deterministic fixture in CI | BVH serialization into the asset; full-library geometry behind lazy per-part fetch; ShareAlike/TOS review before public redistribution |
| A2 — Geometry compiler | **Working** | Full `.dat` dependency flattening with BFC `CERTIFY`/`CW`/`CCW`/`INVERTNEXT`, matrix-handedness winding, colour 16/24 inheritance, quad splitting, type-2 hard edges, 35° crease smoothing, SHA-256-named binary container, 0 unresolved references across 900 parts; runtime byte/hash/layout checks before decode | Texture/printed-part material slots; decimated LOD for very large panels |
| B — CAD kernel | **Working** | Pure TS document in LDraw's native frame with **exact matrix bases**; orthonormal-and-clean basis enforced on ingest; schema-2 migration; **patch-based transactions** with forward/inverse mutations and structural sharing; monotonic revisions, stale-write rejection, protected regions, connector-derived stacking planes | Named checkpoints/branches, multi-document tabs, operation-level schema validation |
| C — Renderer | **Working** | **Instanced batching** by part/colour with merged per-batch hard edges: 400 extra parts cost 14 extra draw calls, measured in the browser. Real compiled meshes, shared geometry per definition, per-slice materials for baked colours, transparent/metallic finishes from `LDConfig.ldr`, shadows, selection and ghost overlays outside the batches, camera views | GPU picking pass for very large models; section render mode; thumbnail cache for the palette |
| D — Human editor | **Working slice** | Search across all 22,941 identities, placeable/all toggle, place/select/multi-select/subassembly-select/move/rotate/recolour/duplicate/delete/connect/lock; human-accessible render diagnostics, working command shortcuts and a discoverable command map | Marquee selection, palette drag-and-drop positioning, array/mirror UI, accessibility audit |
| E — Connections | **Working** | **Full 6-DOF frame solver** (`Tm = Tt·Ft·C·Fm⁻¹`): studs-not-on-top, right-angle Technic and hinge halves solve through the same expression as stacking. Per-family joint freedoms with closed-form continuous parameters, axial flip where insertion is two-sided, orientation-independent target discovery, axis-alignment requirement for a mate, occupancy exclusion, multi-match scoring, Connect-tool pinning. Classification grounded in measured Shadow Library conventions. **Persistent `ConnectionEdge`** records carrying joint, revision and provenance | Articulated manipulation UI driving the joint graph; per-family regression fixtures across the whole library |
| F — Collision | **Working** | Box broad phase → mated-connector clearance → **`three-mesh-bvh` triangle-pair confirmation**, with per-verdict certainty (`exact` / `clearance-subtracted` / `unknown`) surfaced in the UI. Eliminates the axis-aligned-box false positives that dominate rotated parts. Per-definition BVH cache | Penetration-depth discrimination inside the narrow phase; measured per-connector mating volumes replacing the family-level allowance; offline BVH serialization into the asset |
| G — Structural graph | **Working** | Connection graph from coincident compatible connectors with axis alignment, memoized per revision and shared by solver/validation/viewport; persisted edges with joint types; **rigid-component collapse and articulated joint driving** for hinges, pins, axles, bars and ball joints; component count, loose groups, weak single-connector attachments | Cut-set analysis, load-path tracing |
| H — Transactions | **Working** | Patch-based history: every transaction carries forward and inverse mutations plus the entity set it touched, so undo applies an inverse rather than restoring a document copy. **IndexedDB persistence** with periodic checkpoints, an append-only transaction log, replay on open, gap detection, legacy-`localStorage` migration, save-state reporting, project switching and safe forks | Named branches, project archives and a transaction compaction policy |
| I — WebMCP | **Working** | Dynamic 12/17-tool inventories; **schema-driven contracts** where the advertised JSON Schema is derived from the same Zod declaration the gateway enforces; a versioned tool profile with a drift-detecting hash; a **centralized sanitized error envelope** that redacts credentials, signed URLs, data blobs and filesystem paths and never relays a stack trace; bounded batch sizes; compact reads; catalog coverage; preflight/apply; render capture; capability virtualization | Native ChatGPT desktop acceptance run; cancellation propagation into asset fetches and workers |
| J — Agent UX | **Working slice** | Inspect/Propose/Build modes, visible ghosts, activity history, notes, locked cockpit | Transaction-wave assembly animation, anchored 3D note authoring, autonomous hierarchical planning |
| K — Output | **Working slice** | `.ldr` and `.mpd` export with `STEP` and one submodel per subassembly; import flattens nested submodels and reports unplaceable references; exact IDs/transforms; BOM CSV | BrickLink XML; step reassignment on import |
| L — Instructions | **Working slice** | **Build order derived from the connection graph**, independently verifiable reachability, step-aware timeline/playback, and a printable offline HTML booklet with fixed-camera assembly renders, highlighted new parts, BOM, warnings and provenance | Technique-aware grouping, hiding internals until they matter, automatic sub-model selection |
| M — Polish | **Strong slice** | Deliberate industrial CAD UI, responsive desktop layout, catalog boot/failure screens, project/release surfaces, keyboard guide, dynamic document identity and deterministic browser acceptance including reload/restore and guide export | Formal accessibility audit, deployment/CDN |

## Verified now

`npm run check` — **212 tests across 26 files**, strict TypeScript, production Vite build. The compiler is
driven in-process against committed fixtures, so CI asserts its semantics — colour crosswalk,
snap-grid expansion, measured bounds, hashed files, determinism — not just that it exits zero.

`npm run test:e2e` — real Chromium/WebGL run asserting relationships rather than magic numbers:

```json
{
  "catalog":  { "identities": 22941, "placeable": 900, "colors": 322 },
  "coverage": { "authoritativeConnections": 17364, "connectors": 324331,
                "compiledMeshes": 900, "triangles": 961732 },
  "showcase": { "parts": 33, "connections": 207, "collisions": 0,
                "unverifiedCollisions": 0 },
  "rotatedBoxProbe": "triangle confirmation cleared the box overlap",
  "meshAssetsFetched": 11,
  "interface": { "modalShortcutsBlocked": true, "focusRestored": true },
  "refusedUnplaceableIdentity": "61072",
  "contractEnforcement": { "profile": "brickwright.tools/2",
                           "malformedBatch": "INVALID_INPUT",
                           "shearedBasis": "INVALID_INPUT",
                           "staleProfile": "STALE_TOOL_PROFILE" },
  "renderScale": { "partsAfterBatch": 435, "drawCallsBefore": 226,
                   "drawCallsAfter": 240, "drawCallsAddedBy400Parts": 14,
                   "trianglesAfter": 472452 },
  "delivery": { "mpdFileBlocks": 5, "guideSteps": 6,
                "guideImages": 36, "guideBytes": 507999 },
  "reloadRestored": { "revision": 8, "parts": 35, "name": "Survey rover" },
  "exportType1Lines": 35
}
```

The same acceptance flow also passes against the production preview. The run confirms: the
placeable set is a strict subset of the catalog; compiled
`.bwmesh` assets actually reach the GPU; leaving Build mode revokes write tools; preflight
does not mutate; acceptance is exactly one revision; an unplaceable identity is refused with
`GEOMETRY_UNAVAILABLE`; a stale plan is refused with `STALE_DOCUMENT`; a 12 LDU
bounding-box overlap between a rotated brick and its neighbour is cleared by triangle
confirmation; the shortcut dialog blocks model commands and restores focus; and the export's
type-1 line count matches the document.

The opening document is a 33-part rover with **207 mated connectors, 0 collisions and 1
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

## Productionization pass 2

Continuing in plan order: transactions, persistence, incremental validation.

**Patch-based transactions.** A transaction now carries forward and inverse
mutation lists instead of before/after document copies. Untouched parts are
shared by reference, so an edit to one brick no longer deep-copies the model.
Granularity follows cardinality: parts, subassemblies and connection edges are
patched per entity; steps, notes and constraints are replaced wholesale because a
document holds a handful and index bookkeeping would cost more than it saves.

**IndexedDB persistence.** Projects are stored as a periodic checkpoint plus the
transaction log that follows it, so write cost is proportional to the edit rather
than to the model, and reopening replays forward from the checkpoint. Replay
stops at a revision gap rather than applying a log out of order. A document
written by the previous `localStorage` build is migrated rather than discarded.
The save indicator distinguishes durable, memory-only and failed.

**Incremental revalidation.** Three changes, measured on a 1,000-part lattice:

| | before | after |
| --- | ---: | ---: |
| 1,000 sequential commits | 10,415 ms | **549 ms** |
| per commit | 10.4 ms | **0.55 ms** |
| full validation | — | 41 ms |
| revalidation after one part moves | — | 45 ms |
| snap query in a dense model | — | 23 ms |

- Validation is **lazy**: `EngineSnapshot.validation` is a memoizing getter, so
  the many commits whose intermediate report is never read stop paying for one.
- Collision has a **uniform-grid broad phase**, replacing the O(n²) pairwise
  loop, and only pairs involving a touched part are rechecked — previous
  verdicts about untouched pairs carry forward.
- The **connector index is maintained across revisions**, withdrawing and
  reinserting only touched parts instead of rebuilding per commit.

Each of those is an optimization, so each is paired with an equivalence test: the
incremental collision result must match a from-scratch pass, and the persisted
connection graph must match a full derivation after a run of adds, moves,
removals, undo and redo. An optimization that changes answers is a defect.

## Productionization pass 3

**Instanced rendering.** Parts sharing a definition and a colour differ only by
transform, so they now render as one `InstancedMesh` per group. Selected,
flagged and gizmo-attached parts stay outside the batches, since pulling an
instance out to highlight it would rebuild the batch on every hover.

Measuring it exposed a second problem the first fix had hidden. With surfaces
batched, per-part hard edges became the dominant cost: a 400-part batch added
**810** draw calls. Line geometry has no instanced equivalent without a custom
shader, so each batch's edges are now merged into a single buffer with member
transforms baked in, rebuilt on commit rather than per frame. Result, measured in
the browser with the renderer's own counters:

| | draw calls |
| --- | ---: |
| 33-part showcase | 198 |
| after a 400-part batch | **212** |

That is +14 for 400 parts, against +810 before merging, while rendering 463,572
triangles — the counters are sampled across full frames with `autoReset` off,
because the gizmo helper draws in its own pass and a naive sampler sees only
whichever pass finished last.

**Schema-driven WebMCP contracts.** Operation payloads were previously advertised
as an array of bare objects and validated nowhere; each handler did its own
coercion. Now one Zod declaration produces both the JSON Schema the tool
advertises and the validation the gateway enforces, so the two cannot drift. The
operation vocabulary is a real discriminated union, batches are bounded, and a
sheared rotation matrix is refused rather than silently normalized.

**Sanitized error envelope.** A tool error is model input, so all of them now pass
through one redactor: bearer tokens, `api_key=`-style pairs, signed URLs, base64
data URLs, long opaque blobs and local filesystem paths are stripped, messages
are length-capped, and a stack trace never reaches the agent. Staleness codes are
marked retryable so an agent knows to reread rather than give up.

**Tool profile hash.** `workspace_get` returns a versioned profile and a hash over
the exposed tool names plus the catalog revision. A mutation may pin it, and a
plan made against a surface that has since changed is refused with
`STALE_TOOL_PROFILE` instead of executing against a contract the agent never saw.

## Productionization pass 4

**Articulated manipulation.** The connection graph already recorded a joint
freedom on every edge, but that freedom conflated two different things, and the
distinction turned out to be the whole problem:

- *Placement* freedom is what the snap solver uses. A round stud admits any
  rotation about its axis, which is why a 1×1 plate can be turned on its stud.
- *Articulation* freedom is what a built model retains. A stud connection is
  rigid once assembled — friction holds it, and nothing about a finished brick
  wall hinges. Only interfaces designed to move articulate.

Treating stud connections as rigid for articulation is what makes "rotate this
hinge" carry the whole flap rather than peeling one plate off the assembly. The
moving side is the selection's rigid group; everything else anchors it. A joint
whose two sides land in the *same* rigid group is skipped, because a closed loop
cannot articulate without deforming.

Limits are enforced in the kernel, not the UI, so an agent call is clamped the
same way: a keyed axle only seats at quarter turns, a prismatic joint respects its
axial range, and a joint whose freedom is unmodelled drives nothing rather than
guessing.

The showcase now contains a hinged rear hatch, so the model carries a real
mechanism instead of only rigid connections. Placing it surfaced two things worth
recording. The hinge top plate has no anti-studs at all, so deriving its origin
from a surface plane is meaningless — it belongs wherever its hinge connector
coincides with its counterpart's, which needed an explicit placement path. And
hinge halves interleave their fingers, so two correctly hinged parts share a
substantial bounding volume; the collision clearance had to recognize that.

The colour-evidence check also did its job unprompted: the hatch was first built
in the rover's orange accent, and part 3938 has no observed official-set
appearance in orange. It is white.

![Driving the hinged hatch](docs/assets/brickwright-articulation.png)

## Productionization pass 5

**Derived build order.** Instruction steps are not a cosmetic grouping: a step is
only meaningful if everything it introduces can actually be attached to what is
already in front of the builder. That makes sequencing a precedence problem over
the connection graph, not a spatial sort.

Growth is frontier-first — at each point the candidates are the unplaced parts
that already touch placed structure — with ties breaking downward, because LDraw
is Y-down and building bottom-up is both what a person does and what keeps a step
reachable. On the showcase this produces 7 steps covering all 35 parts with no
warnings.

The guarantee is deliberately narrow and independently checkable: **every part
after the first step connects to structure placed earlier, unless it begins a new
independent subassembly**, which is reported rather than glossed over.
`verifyBuildOrder` checks that property against any sequence, including one a
human reordered by hand, and a test asserts it catches a deliberately broken
order. Producing genuinely *good* instructions — grouping by technique, hiding
internals until they matter, choosing where to sub-model — is a larger problem and
is not claimed.

## Productionization pass 6

**Rendered part thumbnails.** The palette showed a derived footprint glyph — a
proportionally-correct rectangle with the right stud count, but not the part. It
now shows the part.

The renderer is a software rasterizer in the compiler, not a headless browser:
the catalog build has to run under bare `node` in CI, output bytes have to be
reproducible because asset hashes depend on them, and a palette preview needs a
clean orthographic three-quarter view rather than a photoreal render. Nine
hundred parts take a few seconds. PNG rather than WebP because Node ships zlib
but no WebP encoder, and adding a native dependency to the catalog build for a
2 KB preview is a poor trade.

The output is deliberately **colour-independent**: RGB carries shading and alpha
carries coverage, so the runtime tints one asset with any of the 322 LDraw
colours by masking a coloured layer with the alpha and multiplying the shading
over it. Baking colour in would have meant 900 parts × hundreds of colours of
assets to show a brick in the colour the operator actually selected.

Rendering the previews immediately caught a sign error worth recording: with
LDraw's Y-down convention the first camera looked *up* at every part, so the
palette showed hollow undersides and anti-stud tubes instead of studs.

**Wider geometry pack.** 500 → **900** placeable parts, 47.7 MB of geometry plus
2.0 MB of thumbnails.

![Palette with rendered previews](docs/assets/brickwright-palette.png)

## Productionization pass 7

**Projects, checkpoints and a visible restore report.** The persistence layer
had supported multiple projects, explicit checkpoints and log replay since pass
3, but the editor exposed none of it — the header's project chevron was a dead
affordance. It is now a switcher.

The interesting part is not the list, it is what a switch has to guarantee.
Autosave is a serialized queue, so at the moment an operator clicks another
project there may be appends still in flight. `session.openProject` therefore
awaits the queue *and* writes a checkpoint for the outgoing project before
anything replaces the document — leaving is not allowed to be a way to lose the
last edit. Two consequences are asserted rather than assumed: reopening a
project needs zero replay because it was checkpointed on the way out, and a
transaction committed in the same tick as the switch is still there when the
project is reopened.

Forking is a new project id, a fresh checkpoint and an empty log, so two designs
can never replay into each other. The id is disambiguated against the projects
that already exist rather than assumed unique, because the name slug collides the
second time the same fork name is used and a collision here would silently
overwrite somebody's work. Deleting the open project is refused: autosave would
recreate its checkpoint moments later, so the delete would appear to work and
then undo itself.

The restore report is now shown instead of inferred. The browser acceptance run
reads it back: after a reload the panel says *"Restored from a checkpoint, 7
transactions replayed"*, which is the crash-and-reopen path stated in the UI
rather than claimed in a document.

![Project switcher and restore report](docs/assets/brickwright-projects.png)

**Attribution is now in the product.** The catalog compiler had been writing a
per-dataset licence manifest — observed per-file licences, attribution strings,
and explicit review-required flags — into a build artefact nobody could see.
Attribution that only exists in a build artefact is not attribution. The panel
lists all three datasets with their licences, shows the two outstanding review
requirements in warning colour rather than burying them, carries the LEGO
trademark disclaimer, and copies the whole attribution block to the clipboard.
The acceptance run asserts the datasets, the review flags and the disclaimer are
all present in the DOM.

![Data and licences](docs/assets/brickwright-licences.png)

## Productionization pass 8

**A delivery center, not a row of file buttons.** The toolbar now keeps the fast
one-click LDR path and opens a compact release surface for hierarchical MPD, BOM,
import and a printable build guide. It states the exact source revision, part and
connection counts, collision state and local-only data boundary before anything
leaves the editor. Diagnostic render modes are now available to the human, the
project name in the viewport is real rather than hard-coded showcase copy, `⌘K`
actually focuses part search, `F` really reframes an unchanged view, and `?` opens
a keyboard map. The duplicated articulation inspector block and nested interactive
catalog-card markup found during the audit were removed.

**Self-contained printable instructions.** The build guide is one offline HTML
file: cover, verification status, BOM, fixed-camera step renders, saturated and
outlined new parts, washed existing structure, explicit missing-geometry warnings,
dataset attribution and no remote dependencies. A deterministic software rasterizer
runs independently of WebGL so pixel behaviour can be unit-tested. The browser
acceptance generated the real rover guide with **6 steps, 36 embedded PNGs and
507,999 bytes**, reopened it, and found no broken images.

**Assets are verified before they become CAD input.** The runtime now checks the
declared byte length and SHA-256 of all four catalog payloads and every fetched mesh.
The binary decoder checks its exact layout, finite ordered bounds, triangle/edge
cardinality, slice ranges, finite positions/normals and index bounds before creating
Three.js geometry. `npm run bootstrap` performs the same verification over the whole
committed 900-part pack and its thumbnails; the current run checked **1,786 unique
immutable assets**. Runtime and WebMCP identifiers now use `crypto.randomUUID()`, and
package versions plus the Node/npm range are exact rather than floating on `latest`.
The Vite 8 build now separates React, rendering, contracts and UI with Rolldown's
native code-splitting groups: the largest emitted JavaScript chunk is **373.57 kB**
uncompressed, and the production build completes without a chunk-size warning.

## Productionization pass 9

**Hard design constraints are enforced by the kernel, for every actor.** The `hard`
flag on a constraint had been carried through the schema, the WebMCP contract and
the capability registry without ever changing what `execute` does. It does now: a
transaction that would *newly* break a hard constraint is refused with
`CONSTRAINT_VIOLATION`. The refusal is not actor-scoped, because a design limit is
the operator's own declared intent rather than a physical fact discovered about the
model — which is the opposite of how collisions are treated, and deliberately so.

Three properties make the gate usable rather than merely strict, and each is now a
test rather than an intention:

- **Only newly introduced failures refuse.** A constraint that is already failing
  must not lock the document, or tightening a budget below the current build would
  make every subsequent repair impossible.
- **Declaring is not violating.** A constraint the transaction itself introduces or
  rewrites is skipped, so an operator can state a target the build has not reached
  yet. Without this the refusal message's own advice — soften or remove the
  constraint — was a dead end, because softening is itself a `constraint.set`.
- **Advisory constraints report and never block**, which is the whole difference
  between `hard: true` and `hard: false`.

**The gate cost nothing to add and nearly everything to run.** Enforcing it had been
written as two full `validateDocument` passes per commit, hoisted out of the
`actor === 'agent'` branch that previously contained them. Validation runs collision
detection, so every human edit began paying for a whole verification sweep: the
1,000-part commit benchmark went from a measured 0.55 ms/commit to **14.7 ms**, and
the unit suite from 2.5 s to 16.2 s. Constraints need only the part list and the
document envelope, so they now read a scoped `evaluateConstraints` — shared with
`validateDocument` so the two cannot drift — and a document declaring no hard
constraint skips the gate entirely.

| | per commit | unit suite |
| --- | ---: | ---: |
| gate as written | 14.7 ms | 16.22 s |
| gate scoped to constraints | **0.55 ms** | **2.43 s** |

**The human surface caught up with the agent's.** `SHARED_MUTATION_CAPABILITIES`
advertises `parity: { human: true, agent: true }` on every entry, but the four
constraint capabilities — size envelope, piece budget, palette, remove — were absent
from the Command Deck's group order and unhandled in its argument builder, so they
were invisible to the human and would have run with no arguments. They are wired up,
including an enforcement toggle that says which of the two things `hard` means. The
acceptance run now compares the deck's rendered command count against the registry
the agent queries, instead of against a literal that had been written to match the
incomplete state.

## Honest evidence boundary

**What changed since the last update:** printable output is now a tested product path rather
than backlog text, the human-facing CAD controls expose the diagnostic modes that already
existed for the agent, and catalog/geometry hashes are enforced at runtime rather than only
written by the compiler.

**What is still bounded:**

- **Geometry pack, not the whole library.** 900 of 22,941 identities have compiled geometry.
  The remaining 22,041 are searchable and inspectable but not placeable, and the kernel says
  so explicitly. Widening further is a compiler flag and a repository-size decision, not new
  work — the committed assets are already 57 MB, so the full library belongs behind a lazy
  per-part CDN fetch rather than in the repository.
- **Connector clearance remains family-level.** Candidate collision pairs are confirmed
  against triangles, but the legal insertion subtraction still uses a family-level allowance
  rather than a measured mating volume for every connector profile.
- **Articulation is driven by stepped controls, not dragging.** Joints can be rotated and slid
  from the inspector and from the agent surface, but there is no direct-manipulation gizmo
  constrained to the joint axis.
- **Joint limits are not published by the source data.** LDCad does not record angular stops,
  so a hinge can be driven past where the physical part would bind; the collision kernel is
  what catches the result.
- **Collision does not discriminate touching from interpenetrating at the triangle level.**
  The mating-clearance layer handles the legal-stacking case, and the triangle phase removes
  box false positives, but a contact whose depth is zero is not distinguished from a shallow
  one inside the narrow phase itself.
- **Picking still goes through the React event system.** Instanced meshes report an
  `instanceId`, which is enough today, but there is no dedicated GPU ID pass, so selection on
  a very large model will degrade before rendering does.
- **Hard edges still cost memory proportional to brick count.** Draw calls are flat, but the
  merged per-batch buffers are not free; above 6,000 parts edges are dropped outright, and a
  single batch past 600k edge vertices renders without them.
- **Projects are local and unnamed after creation.** The switcher can create, fork, open and
  delete projects, but a document cannot be renamed once made — a fork is the only way to
  choose a name — and there is no export/import of a project archive, so work does not move
  between browsers.
- **Validation is only incremental in its collision phase.** Connectivity, components,
  bounds and constraints still run a full pass per read; they are cheap relative to
  collision, but they are not scoped.
- **Identity coverage is partial and labelled.** 5,465 exact external identity matches and
  5,727 heuristic base-design matches out of 22,941. Heuristic matches inherit category only,
  never colour evidence, and every record reports which it is.
- **WebMCP is verified in Chromium, not in ChatGPT.** The dynamic tool lifecycle is exercised
  through the fallback bridge. Native Site Tools registration still needs a run inside an
  eligible ChatGPT desktop build.
- **The build order is reachable, not well-designed.** It guarantees each step can be
  attached, which is the property that makes a sequence usable at all. It does not group by
  technique, defer internals, or decide where a sub-model would help — the things that
  separate a workable sequence from a good instruction booklet.

## Ordered next work

Continuing down the same critical path:

1. **GPU picking pass**, so selection scales with the renderer rather than with the React
   event system.
2. **BrickLink XML and project archives**, so a verified design can move between browsers and
   into a purchasing workflow without manual CSV conversion.
3. **Joint-axis drag gizmo**, so articulation is direct manipulation rather than stepped
   buttons.
4. **Penetration depth in the narrow phase**, plus measured per-connector mating volumes to
   replace the family-level allowance.
5. **The full library behind a lazy per-part fetch**, with BVH serialized into the asset so
   first collision does not pay for a build.
6. **Native ChatGPT Site Tools acceptance run**, which needs an eligible ChatGPT desktop
   build and cannot be done from here.
7. Complete the licence review: ShareAlike scope for the normalized connector dataset, and
   Rebrickable redistribution terms for the compiled derivative. Both requirements are now
   stated in the product; what remains is the legal answer.
