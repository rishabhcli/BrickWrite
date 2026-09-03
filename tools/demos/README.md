# Authoring a demo

One demo is one module in this directory. It exports its own metadata *and* its
author function as a single default export, so the copy that describes a model
and the model itself cannot drift apart, and two people can rewrite two demos
without touching the same file.

```
tools/build-demos.mjs      the pipeline: gates, preview, renderer, manifest
tools/demos/kernel.mjs     the CAD kernel, loaded once through Vite's runner
tools/demos/kit.mjs        Build, colours, the planners, shared scene elements
tools/demos/sculpt.mjs     voxelSculpture — 3D solids compiled to bonded brick
tools/demos/<demo-id>.mjs  one demo: its metadata and its author function
```

## Building

Iterate locally on the Node in `.nvmrc`; on this machine that is:

```sh
/opt/homebrew/opt/node@24/bin/node tools/build-demos.mjs --only=<demo-id>
```

`--only` builds a subset and leaves the manifest alone, which is what you want
while iterating — about ten seconds a demo.

**Commit assets built the way CI reads them.** PNG bytes come from whichever
zlib the running Node was linked against, and the manifests record their hashes,
so the platform matters as much as the version — a full rebuild on macOS is
rejected by `demos:check` on Linux even at the identical Node version. For the
full collection, and for anything you intend to commit:

```sh
docker run --rm --platform linux/amd64 -v "$PWD":/w -v /w/node_modules \
  -w /w node:24.19.0 bash -c "npm ci && node tools/build-demos.mjs"
```

Add `--check` to diff a fresh build against the committed tree instead of
writing it.

Then **look at the render**: `public/demos/<demo-id>/social.png` is 1200 × 630
from the offline rasterizer, and it is what the landing page and the explorer
show. A model that measures beautifully and reads as a grey lump has failed.

## The gates

Every demo clears all of these or the build fails and nothing is written:

- at least 1,000 parts, all in the catalog with compiled geometry
- zero collisions, twice, triangle-confirmed — no bounding-box verdicts
- **exactly one connected component** over the derived connection graph
- a derived build order that re-verifies against its own guarantee, with no
  step that begins an unsupported island
- statics: full mass coverage, centre of mass inside the support polygon, and
  the load path from the ground reaching every part bar `tensionAllowance` of
  them (raise that number only with a `tensionReason` that is actually true)
- the rough candidate must be **measurably worse** than the published one on
  components, loose parts, unsupported parts or collisions

Connectivity is the one that catches people out. Studs only mate vertically, so
two bricks side by side in a course are not connected to each other — they are
connected because something below spans them both. That is why every scene has
a cross-bonded plinth under a one-piece-per-stud finish layer.

## The `Build` API

```js
const build = new Build({ subassemblies: [{ id, name, accent, locked? }, …] })
```

The first subassembly is the default. An empty one is dropped from the document.

- `build.place(id, colour, xLdu, zLdu, surfaceY, { sub, rotY, label })` rests a
  part on `surfaceY` and returns the stud plane it exposes. **Up is −Y.**
- `build.placeAt(id, colour, x, y, z, opts)` places at an explicit origin.
- `build.snap(id, colour, cursorPosition, { rotY, radiusLdu, targetPartIds })`
  asks the connector solver for the full 6-DOF pose that mates the part with
  something already placed — this is how a tile lands on a vertical stud
  without anyone working out the quarter turn.
- `build.row(id, colour, xs, zs, surfaceY, opts)` for a grid of one part.
- `build.addPlan(plan, { sub })` absorbs a parametric plan (below).
- `build.lastPartId()` names the part you just placed, to aim a later solve.

`place` **refuses an off-grid placement**. Stud centres are odd multiples of
10 LDU: a part centres on a multiple of 20 along an axis it spans an even number
of studs on, and on an odd multiple of 10 where it spans an odd number.
`studCentre(n)` gives the centre of stud `n`. Pass `offGrid: true` only for a
part that genuinely does not sit on studs.

Constants: `STUD_LDU` 20, `PLATE_LDU` 8, `BRICK_LDU` 24.

### Planners

`planWall`, `planEnclosure`, `planBrickField`, `planLattice`, `planClockFaces`,
`planHingedFlap`, `planCrane`, `planSnotHull` — wrap the spec in `spec({ … })`
so it carries the actor and subassembly. These solve real bonded brickwork; a
wall you lay by hand will be worse than one of these unless you have a reason.

### Scene elements

`addTree`, `addLamp`, `addPlanter` take `{ x, z, surfaceY, sub, height,
variant }` in stud coordinates. They place ordinary catalogue parts, so they can
be selected and rebuilt like everything else.

## `voxelSculpture` — for shapes, not boxes

In `sculpt.mjs`. Give it a `solid(x, y, z)` that answers which colour occupies a
cell — `x`/`z` in studs across the scene, `y` in brick courses up from the
field — and it lays the result course by course as cross-bonded brickwork in
eleven footprints, dropping nothing on the floor.

```js
voxelSculpture(rough, {
  id, title,
  width, depth, roughWidth, roughDepth,   // scene footprint in studs
  height,                                  // courses to read
  plinthColor, fieldColor(x, z, w, d),
  fieldName, fieldAccent, bodyName, bodyAccent, accentName, accentColor,
  solid(x, y, z, { width, depth, height, rough }),   // colour | {color,accent} | null
  trees: [[x, z, height], …], lights: […], planters: [[x, z], …],
  detail(build, { fieldTop, courseTop, occupiedCells, C }),   // optional
})
```

Because occupancy is a function of all three axes it can carve the gap under a
belly, cantilever a trunk past the feet and taper a fluke to nothing. A height
map cannot — it only knows how tall each column is, which is exactly why the
earlier candidates for these builds read as a lump with a colour change on it.

**The one rule.** A brick may only go where at least one of its studs stands
over a cell the course below actually carries. So an overhang has to be earned:
extend it by a few studs a course, from cells that reach back over solid work,
and it will be laid; ask for a slab hanging in the air and those cells are
dropped and counted in the plan warnings. Colour matters too — a brick covers
cells of **one** colour, so an orange bill cannot borrow support from a yellow
head unless the orange region itself reaches back over the head.

`largeSculpture` in the same file is the older height-map driver. Prefer
`voxelSculpture` for anything with a silhouette.

## Parts

All 900 catalogue identities have compiled geometry, including 45 sloped bricks,
44 curved, 24 wedged, 30 wedge plates and 28 dishes. Regenerate the inventory
with:

```sh
node -e "const r=require('./public/catalog/2026-07/parts.json');\
for(const p of r) console.log(p.canonicalId, p.name, JSON.stringify(p.dimensions.studs))" | sort -k2
```

`dimensions.studs` is `[x, height-in-plates, z]` at `rotY: 0`, so "Brick 2 x 4"
reports `[4, 3.5, 2]`. Stacked 1 × 1 bricks are the tell of a model nobody
shaped; slopes, curves and wedges are what make a silhouette read.

## Sharp edges

Three things in the shared layer will silently produce a rejected demo if you
assume otherwise. All three were found the hard way.

**`planBrickField` lays at most two layers.** `layers` is clamped to `[1, 2]` —
its job is a cross-bonded *slab*, not a column. Ask for nine and you get two,
and whatever you built on top of the ninth course floats. Anything taller is
laid as successive bonded pairs, each resting on the one below; see the
`block()` helper in `sunline-suspension-bridge.mjs`.

**`planHingedFlap` will not reach past two studs.** The leaf is laid with
`layField`, which tiles in rows two studs deep, so `reachStuds: 3` puts an outer
plate row entirely past the hinge tops with nothing under it. It is a loose
part, and the connectivity gate is right to reject it. Use `reachStuds: 2`.

**A course and a beam cannot claim the same slice.** If you lay a column through
a run of courses and then lay a beam across the same footprint at one of those
heights, the two occupy the same cells and the collision gate reports every one
of them. Build the column in runs that stop below each beam and resume above it.
