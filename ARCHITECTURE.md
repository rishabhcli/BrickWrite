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

## Coordinate system

The kernel stores geometry in **LDraw's own frame**: LDU units, Y increasing *downward*,
and each part positioned at its native LDraw origin. One stud is 20 LDU horizontally, a
plate is 8 LDU tall and a brick is 24 LDU.

Keeping the native frame means `.ldr` export is a direct write of the stored position and
the stored rotation matrix, with no conversion step that could drift. The display frame is
produced by exactly one node in the scene graph:

```text
<group rotation={[π, 0, 0]} scale={1/20}>   ← the only conversion in the renderer
  <group position={part.transform.position} …>   ← raw LDU, straight from the document
```

Because that node is a proper rotation, `TransformControls` hands positions back already
in LDU, and face winding is preserved.

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
| `src/cad/catalog.ts` | Compiled catalog registry, colour table, search, stacking planes |
| `src/cad/catalog-loader.ts` | Fetches and installs the compiled catalog; hard-fails when absent |
| `src/cad/mesh.ts` | `.bwmesh` decoder and the shared, content-addressed geometry cache |
| `src/cad/math.ts` | Euler/matrix helpers shared by kernel, solver and serializer |
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

The runtime holds two deliberately distinct tiers:

| Tier | Contents | Capability |
| --- | --- | --- |
| **Search** | every official LDraw part and shortcut | searchable, inspectable, **not** placeable |
| **Pack** | parts with compiled geometry and connectors | placeable, snappable, validatable |

Keeping them separate is what lets Brickwright answer *"this part exists but I cannot build
with it yet"* instead of implying uniform coverage. `catalog_search` reports
`placeable` per result, and `part.add` on a search-only identity returns
`GEOMETRY_UNAVAILABLE` with a repair hint.

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
Library. At runtime:

1. Local connector frames are transformed into model space with the full rotation matrix.
2. Static connectors are inserted into 20-LDU spatial cells.
3. Nearby candidates are filtered by compatible family and opposing gender; `generic`
   connectors additionally require a matching LDCad group name.
4. Exclusive connectors already carrying a part are excluded as occupied.
5. Exact translations align the primary frame pair.
6. The transformed moving part is rescanned for additional simultaneous matches.
7. Candidates score multi-point matches far above incidental one-point matches.

Manual **Connect** uses the same solver pinned to a chosen connector pair. Transform-control
release uses the same solver near the dropped grid position.

## Validation

Connectivity is computed from the **connection graph** — coincident compatible connectors —
not from geometric proximity. Collision runs a box broad phase and then subtracts allowed
mating volumes, which is required rather than optional: a brick stacked on another
legitimately overlaps it by exactly the stud height, so an unqualified intersection test
would flag every correct build as a collision.

| Check | Basis |
| --- | --- |
| Collisions | AABB overlap minus stud-engagement or insertion clearance for mated pairs |
| Connections | count of mated connector pairs |
| Components / loose groups | connected components of the connection graph |
| Weak attachments | parts held by exactly one connector |
| Colour evidence | observed official-set part/colour appearances; unknown pairings are reported as *virtual*, not illegal |
| Constraints | envelope, piece budget, palette, locked regions |

A virtual colour does not make a document unhealthy — it is legal to build and export. A
**hard** palette constraint is the mechanism that turns colour choice into a failure, and
it is enforced in the kernel.

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
vertex buffer. The next step is to replace per-part scene objects with definition/colour
batches while keeping selection, ghost, warning and connector overlays separate, and to add
serialized triangle BVHs after the AABB broad phase. Neither change alters the document or
command contracts.
