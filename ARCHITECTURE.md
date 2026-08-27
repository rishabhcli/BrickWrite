# Brickwright architecture

## One document, two expert operators

```text
Human input ─┐
             ├─> CommandBus ─> CadEngine ─> ModelDocument (revision N)
WebMCP ──────┘                    │   │   │
                                  │   │   └─> shared history / proposals
                                  │   └─────> validation / connection graph
                                  └─────────> React snapshot ─> Three.js viewport
```

`src/cad/engine.ts` is deliberately unaware of React and Three.js. UI code dispatches
`CadOperation[]`; WebMCP normalizes tool payloads into the same operations. A successful
batch produces exactly one revision and one transaction.

## Kernel invariants

1. `ModelDocument.revision` only increases, including undo/redo.
2. An agent mutation must match the exact revision it read.
3. Agent writes cannot cross a protected part or locked-subassembly boundary.
4. Only parts with compiled geometry can be placed; catalog-only identities are refused
   with `GEOMETRY_UNAVAILABLE` rather than rendered as a guess.
5. Preflight creates a preview document but does not replace the live document.
6. Proposal application is rejected if its base revision changed or it contains collisions.
7. The Three.js object tree is disposable; the CAD document can rebuild it at any time.
8. There is no procedural fallback catalog. If the compiled assets are missing the
   application refuses to start.

## Coordinate system and transforms

The kernel stores geometry in **LDraw's own frame**: LDU units, Y increasing *downward*,
and each part positioned at its native LDraw origin. One stud is 20 LDU horizontally, a
plate is 8 LDU tall and a brick is 24 LDU.

Orientation is an orthonormal **row-major 3×3 basis**, not Euler angles:

- An LDraw type-1 reference already carries a translation plus a 3×3 matrix, so import and
  export are lossless with no decomposition step. An arbitrary off-axis rotation and a
  mirrored reference both round-trip exactly.
- Connector metadata is also expressed as frames, so the snap solver composes frames
  directly instead of routing orientation through angles.
- Euler decomposition is ambiguous at gimbal poses and cannot represent a mirrored basis.

Euler degrees survive only as a UI affordance — the inspector decomposes the basis for
editing and recomposes on commit — and as the migration path for schema-1 documents.

Two invariants are enforced on ingest by the engine rather than trusted from callers: every
stored basis is orthonormal, and near-integer entries are cleaned. Without the first,
repeated composition slowly shears a part; without the second, `cos 90° = 6·10⁻¹⁷` leaks
into exported matrices and makes transform comparison and content hashing meaningless.

The display frame is produced by exactly one node in the scene graph:

```text
<group rotation={[π, 0, 0]} scale={1/20}>   ← the only conversion in the renderer
  <group matrix={sceneMatrix(part.transform)} …>   ← raw LDU, straight from the document
```

Because that node is a proper rotation, `TransformControls` hands matrices back already in
document space, and face winding is preserved.

Part origins are **not** uniformly at the top or bottom of a shape — a 2×4 brick has its
origin on the stud plane with the underside 24 LDU below, while a curved 2/3-height brick
has its origin *at* the underside. Stacking therefore reads the mating plane off the
compiled connectors (`underPlaneLdu` / `studPlaneLdu` in `src/cad/catalog.ts`) instead of
assuming a nominal height. This is what makes slopes, curved elements, grille tiles and
the windscreen land on the planes a physical build would use.

## Main modules

| Module | Responsibility |
| --- | --- |
| `src/cad/types.ts` | Stable document, part, connector, transaction, proposal, and validation contracts |
| `src/cad/assembly.ts` | Parametric assembly solver: bonded walls, interlocking storeys, cross-bonded decks, seated window and door frames |
| `src/cad/modules.ts` | Reusable named sub-builds: capture into a local frame, stamp with rotation and repetition |
| `src/cad/statics.ts` | Mass from measured volume, centre of mass, support polygon, tipping margin, hanging loads |
| `src/editor/environment.ts` | Generated studio environment map, so plastic reflects something without fetching an HDR |
| `src/cad/catalog.ts` | Compiled catalog registry, colour table, tiered ranked search, stacking planes |
| `src/cad/placement.ts` | Resolves where an armed part lands, from a ray hit to a connector-solved pose |
| `src/cad/catalog-loader.ts` | Fetches and installs the compiled catalog; hard-fails when absent |
| `src/cad/mesh.ts` | `.bwmesh` decoder and the shared, content-addressed geometry cache |
| `src/cad/math.ts` | Rigid-transform algebra: bases, composition, orthonormalization, pose distance |
| `src/cad/connections.ts` | Connector compatibility, joint freedoms, mating-transform enumeration |
| `src/cad/collision.ts` | Broad phase, mating clearance, BVH triangle confirmation |
| `src/cad/engine.ts` | Command execution, guards, revisions, preflight, atomic apply, shared undo/redo |
| `src/cad/snapping.ts` | World connector transforms, spatial hash, compatibility, occupancy, multi-match scoring |
| `src/cad/validation.ts` | Connection graph, mating-aware collision, components, colour evidence, constraints |
| `src/cad/ldraw.ts` | `.ldr` / `.mpd` serialization and import with an explicit coverage report |
| `src/cad/bom.ts` | Exact part/colour aggregation and CSV export |
| `src/webmcp/adapter.ts` | Dynamic native WebMCP registration and browser development bridge |
| `src/editor/CadViewport.tsx` | Derived Three.js scene, transform controls, grid, ghosts, camera capture |
| `src/editor/PartVisual.tsx` | Real compiled geometry, per-slice materials, LDraw hard edges |
| `tools/ldraw-mesh.mjs` | Offline LDraw geometry compiler (BFC, colour inheritance, packing) |
| `tools/catalog-compiler.mjs` | Offline LDraw/LDCad/Rebrickable canonical catalog compilation |

## Catalog: two tiers, explicit provenance

```text
LDraw complete library ─┐
LDCad Shadow Library ───┼─> canonical manifest + search index + colours + licenses
Rebrickable bulk CSV ───┘                        + packed geometry assets
```

The runtime holds three deliberately distinct tiers:

| Tier | Contents | Count | Capability |
| --- | --- | ---: | --- |
| **`placeable`** | compiled geometry and LDCad connectors | 900 | placeable, snappable, validatable |
| **`modelled`** | every other official LDraw part and shortcut | 22,041 | searchable, inspectable, **not** placeable |
| **`catalogued`** | Rebrickable identities LDraw does not model | 58,833 | searchable by identity only |

Keeping them separate is what lets Brickwright distinguish *"this part exists but I cannot
build with it yet"* from *"I have never heard of that part"*, instead of implying uniform
coverage in either direction. `catalog_search` reports `tier` per result, facet counts across
all three, and `matched.cataloguedTierSearched` so a zero is never read as a fact when the
wider index simply is not resident. `part.add` on a non-placeable identity returns
`GEOMETRY_UNAVAILABLE` with a repair hint.

The `catalogued` tier ships as its own manifest-hashed payload
(`catalog/<version>/search-external.json`, 7 MB) and is fetched the first time a search asks
past the modelled library, so an editing session never pays for it. `src/cad/catalog.ts`
precomputes a lowercase haystack per identity at install time and ranks in one pass: exact
part number, then name-start, then measured-envelope match for a dimension token like `2x4`,
then word-start, then substring, with official-set frequency breaking ties. Every token must
land somewhere, so narrowing a query can only shrink the result set.

Every compiled record carries field-level provenance: which dataset supplied the geometry,
the connectors, the identity (and whether that identity match was exact or heuristic), and
the colour evidence. The compiler also writes `coverage.json` with measured — not
asserted — coverage numbers.

## Geometry compilation

`tools/ldraw-mesh.mjs` flattens a part's entire `.dat` dependency tree offline:

```text
type-1 sub-file references     → resolved against p/, parts/, root, models/
BFC CERTIFY CW/CCW, CW/CCW     → per-instruction declared winding
BFC INVERTNEXT                 → inverts exactly one following reference
negative matrix determinant    → compensating winding flip
colour 16 / 24                 → inherited surface and edge colour
type 4 quads                   → split into two triangles
type 2 lines                   → hard-edge outline buffer
crease-angle smoothing (35°)   → rounds cylinders, keeps box corners sharp
```

The result is packed into a versioned little-endian container named by the SHA-256 of its
own bytes, so cached assets can never be stale and two catalog revisions that share a part
share its asset:

```text
u32 magic "BWM1" · u32 version · f32×6 bounds · u32 vertexCount · u32 indexCount
u32 edgeVertexCount · u32 sliceCount · u32 reserved
slice[] { u32 ldrawColour, u32 indexStart, u32 indexCount }
f32[] positions · f32[] normals · u32[] indices · f32[] edge segments
```

A slice whose colour is `16` is painted with the part instance's colour; any other value is
a colour baked into the part itself, such as a black rubber tyre or a printed face.
`src/cad/mesh.test.ts` compiles synthetic LDraw sources with the real compiler and decodes
them with the real runtime decoder, so the two ends cannot drift.

## Connector snapping

Part definitions own normalized `ConnectionFeature` records compiled from the LDCad Shadow
Library. By LDCad convention a connector's axis is its frame's local **+Y**, and a mated
pair brings the two frames into coincidence — verified against the library itself, where
`p/stud.dat` declares a male Y-axis cylinder at the stud primitive's origin and
`parts/s/3001s01.dat` declares the matching female tubes at `pos=0 24 0`.

The solver therefore works in frames, not offsets. For a moving connector frame `Fm`, a
target part `Tt` with connector frame `Ft`, and a mating transform `C` drawn from the pair's
retained freedom:

```text
Tm = Tt · Ft · C · Fm⁻¹
```

This yields translation **and** rotation together. Studs-not-on-top placement, Technic pins
at right angles and hinge halves all fall out of the same expression as ordinary stacking,
rather than needing special cases — a translation-only solver cannot express them at all.

`C` comes from the joint the pair retains, derived from the connector families plus the
slide/rotate flags the compiler carried across:

| Interface | Freedom | Candidates offered |
| --- | --- | --- |
| stud ↔ anti-stud | revolute, quarter-turn lattice | 4 quarter turns, no flip |
| pin ↔ pin-hole | revolute, continuous | exact best-fit angle + quarter turns, flip allowed |
| axle ↔ axle-hole | cylindrical, keyed | quarter turns + axial offset, flip allowed |
| bar ↔ clip | cylindrical, free rotation | best-fit angle + axial offset, flip allowed |
| hinge ↔ hinge | revolute, continuous | best-fit angle |
| ball ↔ socket | spherical | best-fit rotation |
| grouped generic | unknown | identity only, reported as `unknown` |

A continuous parameter is solved in closed form, not sampled: for rotation about the
connector axis the trace of `Rᵀ·M` is maximized at `atan2(M₀₂ − M₂₀, M₀₀ + M₂₂)`.

Around that core:

1. Targets are gathered **once**, around the part's cursor-space bounds centre with the
   radius widened by the part's own reach. Querying per connector instead would make
   discovery depend on cursor *orientation*: a brick dragged into place but not yet rotated
   has its anti-stud 24 LDU the wrong way, hiding every sideways-stud target.
2. Candidates are filtered by family, opposing gender and — for `generic` connectors — a
   matching LDCad group, so a turntable and a door hinge of similar size never mate.
3. Exclusive connectors already carrying a part are excluded as occupied.
4. Each candidate pose is rescanned for additional simultaneous mates, which is what makes
   a 2×4 brick settle onto all eight studs instead of balancing on one.
5. A mate requires coincident positions **and** parallel axes. Without the axis test a stud
   pointing sideways counts as mated with an anti-stud it merely passes through. Rotation
   *about* the shared axis is ignored, because that is the freedom the joint retains.

Manual **Connect** uses the same solver pinned to a chosen connector pair.

## Derived world state

`deriveConnections(document)` builds the connector index, the occupancy set and the mated
pair list in one pass, memoized on document identity in a `WeakMap`. Documents are immutable
per revision, so solver, validation and viewport share a single derivation instead of each
rebuilding the graph, with no manual invalidation path to get wrong.

Committed edges are then **persisted** in `document.connections`, carrying the joint freedom,
the revision they appeared at and their provenance (`snap`, `explicit-connect`,
`import-inferred`). An edge that survives a transaction keeps its original revision, so
"when did this connection appear, and who made it" stays answerable.

## Collision

Two phases, because neither alone is correct:

```text
world AABB overlap                 → candidate pairs, cheap
mated-connector clearance          → legal engagement removed
BVH triangle-pair confirmation     → does the geometry actually meet?
```

The clearance layer is not an optimization but a requirement: a brick stacked on another
legitimately intersects it by the full stud height, so an unqualified intersection test
reports every correct build as a collision.

The triangle phase runs as a **confirmation** of a box-phase candidate rather than as the
sole authority. Its job is to eliminate the false positives axis-aligned boxes produce in
abundance: a 45°-rotated 2×4 brick has a box far larger than the brick, so a box-only test
reports a confident 12 LDU collision against a neighbour sitting in the empty corner of that
box. Note that `bvhcast` yields pairs whose *bounds* overlap, so triangles must be
intersected before anything is concluded from them.

Every verdict carries its own certainty, and the validation panel shows it:

| Certainty | Meaning |
| --- | --- |
| `exact` | confirmed against triangles, no allowance applied |
| `clearance-subtracted` | confirmed against triangles, with a mated-connector allowance |
| `unknown` | geometry was not resident; only bounding boxes were compared |

Distinguishing *touching* from *interpenetrating* at the triangle level is deliberately left
to the clearance layer. Doing it in the narrow phase requires penetration depth local to
each contact — a brick's top face is a single large triangle, so the depth of its farthest
vertex behind a neighbouring plane says nothing about whether the solids overlap. That is
real work, not a tolerance to tune, and is tracked as follow-up rather than approximated.

BVHs are built once per part definition and cached; brick geometry never deforms, so a
definition's hierarchy is valid for the session and shared by every instance.

## Validation

Connectivity is computed from the **connection graph** — coincident compatible connectors
with aligned axes — not from geometric proximity.

| Check | Basis |
| --- | --- |
| Collisions | box broad phase → mating clearance → triangle confirmation, with certainty |
| Connections | count of mated connector pairs |
| Components / loose groups | connected components of the connection graph |
| Weak attachments | parts with exactly one connected neighbour |
| Colour evidence | observed official-set appearances; unknown pairings are *virtual*, not illegal |
| Constraints | envelope, piece budget, palette, locked regions |

A virtual colour does not make a document unhealthy — it is legal to build and export. A
**hard** palette constraint is the mechanism that turns colour choice into a failure, and it
is enforced in the kernel.

## WebMCP lifecycle

Read tools remain registered for the page lifetime. A mode-specific `AbortController` owns
proposal/write registrations:

```text
Inspect  = read tools
Propose  = read + preflight/proposal tools
Build    = read + preflight/proposal + mutation/history tools
```

Changing autonomy aborts the old registrations before installing the new inventory. The
fallback bridge mirrors this lifecycle so behaviour can be tested in Chromium before native
Site Tools are available. Annotations are hints only — revision checks, protected-region
enforcement, geometry availability, colour policy and collision rejection all live in the
kernel.

## Performance direction

Geometry is shared per definition and content-addressed, so a thousand 2×4 bricks cost one
vertex buffer. Definition/colour groups render through `InstancedMesh`; hard edges are merged
once per batch, while selection, ghost, warning and transform overlays remain independent.
The browser acceptance run proves the architectural property rather than a screenshot: a
400-part stress batch adds 14 draw calls, not one object tree per brick.

Collision uses per-definition `three-mesh-bvh` instances after the scene broad phase. The
remaining renderer scaling boundary is picking: instanced intersections still flow through
the React event system. A dedicated GPU ID pass and serialized offline BVHs are the next
large-model optimizations; neither changes the canonical document or command contracts.
