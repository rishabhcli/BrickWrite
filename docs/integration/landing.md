# Workstream 10 — Landing, Explore and the curated demos

Owns `src/features/landing/**`, `src/features/explore/**`, `src/demos/**`,
`public/demos/**`, `tools/build-demos.mjs` and `tools/e2e/landing.mjs`.

Two public surfaces and the data behind them: a landing page that demonstrates
the product with real documents, an explorer that takes one apart, and **ten**
curated megabuilds that were authored against the real catalog and put through
the kernel's own gates before they were allowed to ship. Every published set has
at least 1,000 editable parts.

---

## 1. Route registration

`src/main.tsx` already carries these two lines; they are recorded here because
this file is the contract for them:

```ts
registerRoute('landing', () => import('./features/landing/LandingPage'))
registerRoute('explore', () => import('./features/explore/ExplorePage'))
```

Both modules default-export their component, so no adapter is needed. The
declared boot stages in `src/platform/routes.ts` (`landing: 'none'`,
`explore: 'none'`) are correct and neither surface needs more than `none` —
the explorer draws from published preview geometry, not from the catalog.

Alternatives, for a host that builds its registry elsewhere:

```ts
import { registerLandingRoutes } from './features/landing'
import { registerRoute } from './platform'

const detach = registerLandingRoutes(registerRoute)   // returns an undo function
```

`registerLandingRoutes()` with no argument looks for
`globalThis.__brickwrightRegisterRoute` and does nothing if it is absent, so
importing `src/features/landing` is always safe.

### Navigation

Both surfaces address each other by **path**, and keep their own state in the
query string: `/explore?demo=blue-whale-monument&step=4`. The shell's router matches
`/explore`; the surface reads the rest. Cross-surface links are real document
navigations unless the shell claims them:

```ts
import { setLandingNavigator } from './features/landing'

setLandingNavigator((target, href) => {
  navigate(href)      // your router
  return true         // claimed; false falls back to a document navigation
})
```

`parseRoute` also accepts the fragment form (`#/explore/<id>?step=N`) so a
pasted link from a static host still resolves. It is read, never written.

### Analytics

The landing surfaces emit their own closed vocabulary — `landing.viewed`,
`landing.cta_selected`, `demo.viewed`, `demo.step_scrubbed`,
`demo.view_changed`, `demo.part_inspected`, `demo.fork_started`,
`demo.fork_completed`, `demo.fork_failed`, `editor.opened` — because
`src/platform/analytics.ts` owns a closed vocabulary of its own and these are
not in it. Every string field is an enum or a published demo id; there is no
free-text field, so nothing a visitor typed can leave this way.

Bridge them with either of:

```ts
import { setLandingAnalyticsSink } from './features/landing'
setLandingAnalyticsSink(({ event, at }) => yourSink(event, at))
```

```ts
window.addEventListener('brickwright:analytics', (event) => yourSink(event.detail))
```

Until a sink is registered, events are buffered (bounded at 100) and
`landingAnalyticsStatus()` returns `buffered-no-sink`. **No count, testimonial
or usage figure appears anywhere on either surface**, because there is no
measurement behind one.

### Cloud projects

"Edit this build" copies the immutable snapshot into a project the visitor owns.
Signed out, that is a local IndexedDB project. Signed in, it goes through an
adapter the deployment registers — there is no import of `src/cloud` here,
because that directory belongs to another workstream and may be absent:

```ts
import { registerCloudProjectAdapter } from './features/explore'

registerCloudProjectAdapter({
  id: 'convex',
  isSignedIn: () => Boolean(session),
  async createProject({ name, document, source }) {
    // source: { kind: 'demo', demoId, catalogVersion, sha256 }
    const projectId = await createCloudProject({ name, document, source })
    return { projectId, url: `/editor?project=${projectId}` }
  },
})
```

`window.brickwrightCloudProjects` works too, for a host that cannot import.
With no adapter registered, a signed-in visitor gets a local project and the
result panel says so rather than implying a sync that is not running.

---

## 2. Public exports

### `src/demos`

| Export | Shape |
| --- | --- |
| `DEMOS` | `readonly DemoEntry[]` — metadata only, a few KB |
| `DEMO_MANIFEST` | the whole manifest, including the gates each entry cleared |
| `getDemo(id)`, `heroDemo()` | lookup |
| `loadPreview(demo, variant?, signal?)` | envelope geometry, digest-verified, memoised |
| `loadDocumentText(demo, variant?, signal?)` | the `ModelDocument` snapshot as verified text |
| types | `DemoEntry`, `DemoManifest`, `DemoPreview`, `DemoValidationSummary`, `DemoStaticsSummary`, `DemoRefinementDelta`, `DemoBrief`, `DemoCamera`, `DemoProvenance`, `DemoAssets`, … |

### `src/features/landing`

`LandingPage` (default), `Hero`, `registerLandingRoutes`,
`LANDING_ROUTE_LOADERS`, `hrefFor`, `navigate`, `parseRoute`,
`useLandingRoute`, `setLandingNavigator`, `NAVIGATION_EVENT`, `useReveal`, and
the analytics surface above.

### `src/features/explore`

`ExplorePage` (default), `EnvelopeView`, `useReducedMotion`, `useOnScreen`,
`forkDemo`, `registerCloudProjectAdapter`, `cloudProjectAdapter`, and the
projection maths: `cameraBasis`, `fitScene`, `project`, `visibleFaces`,
`buildScene`, `explodeOffsets`, `pointInPolygon`, `shadeHex`, `PART_FIELDS`.

---

## 3. The demos

Ten megabuilds, authored programmatically in `tools/build-demos.mjs` against
catalog `2026-07` and the real assembly and mechanism planners. Counts are from
`public/demos/manifest.json` (the kernel's own validation of the committed
documents). The six toy sets this table used to list are gone.

The landing hero is forced to **Blue Whale Monument**; the manifest marks
**Illinois Main Quad campus** `hero: true` for collection metadata.

| Demo | Discipline | Parts | Mates | Steps | Mass | Tipping margin |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Blue Whale Monument | Large animal sculpture | 6,534 | 8,296 | 69 | 3.22 kg | 293 LDU |
| Sunline Suspension Bridge | Landmark infrastructure | 4,295 | 9,170 | 46 | 2.56 kg | 340 LDU |
| Copper Canyon Mammoth | Large animal sculpture | 4,458 | 5,924 | 48 | 2.20 kg | 314 LDU |
| Colossal Duck Float | Playful public art | 4,975 | 6,397 | 55 | 2.45 kg | 334 LDU |
| Iron Lattice Lookout | Landmark ironwork | 1,118 | 6,588 | 19 | 1.88 kg | 320 LDU |
| Harbour Control Tower | Play set | 1,080 | 10,991 | 19 | 3.28 kg | 352 LDU |
| Saucer Freighter | Vehicle and mechanism | 2,268 | 9,123 | 42 | 2.16 kg | 319 LDU |
| Harbour Street | Modular architecture | 3,061 | 10,882 | 45 | 3.63 kg | 276 LDU |
| Meridian Tower | Modular architecture | 4,767 | 28,196 | 68 | 9.82 kg | 300 LDU |
| Illinois Main Quad campus | Campus architecture | 11,493 | 26,496 | 185 | 7.90 kg | 784 LDU |

Structure is laid by `planEnclosure`, `planWall`, `planBrickField` and the
mechanism planners (`build_crane`, `build_lattice`, `build_snot_hull`,
`build_clock_faces`) where the brief asks for them; voxel sculptures are
column-placed against the compiled connectors. Every mate still goes through
`bestSnapTransform`, the same 6-DOF solver a drag in the editor runs through.

### The gates

A demo that fails any of these is **not written to the manifest**. The build
exits non-zero and the committed assets keep their previous contents.

1. every part is in the catalog, is its canonical id, and has compiled geometry;
2. **at least 1,000 editable parts** (the collection floor that retired the toy demos);
3. triangle-confirmed collision, run twice, with **no** `unknown` verdicts;
4. exactly one connected component over the derived connection graph;
5. a derived build order that re-verifies against its own guarantee, covering
   every part, with no unsupported island;
6. measured statics: full mass coverage, centre of mass inside the support
   polygon, no group over its clutch capacity, and every part reached by the
   load path from the ground — except where the demo declares a
   `tensionAllowance` and says why (hangers, glazing seated in frames, lattice
   decks that rest on columns);
7. a **measurably worse** first candidate, so the refinement the landing page
   shows is a real comparison and not a story.

`src/demos/manifest.test.ts` re-derives the connection graph, the build order
and the statics report from the committed documents and asserts the same
properties, plus every asset's byte length and SHA-256 against the manifest.

### Rebuilding

```bash
node tools/build-demos.mjs            # authors, gates, renders, writes
node tools/build-demos.mjs --check    # rebuilds into a temp tree and diffs
node tools/build-demos.mjs --only=blue-whale-monument   # one demo, no manifest write
```

Output:

- `public/demos/<id>/document.json` — the canonical `ModelDocument` snapshot
- `public/demos/<id>/rough.json` — the candidate it replaced
- `public/demos/<id>/preview.json`, `rough-preview.json` — envelope geometry
- `public/demos/<id>/thumb.png` (720×450), `social.png` (1200×630) — rendered
  offline by `src/cad/raster.ts`, no browser
- `public/demos/manifest.json` and `src/demos/manifest.generated.ts`

Determinism: every timestamp is the fixed `AUTHORED_AT`, part ids are assigned
in plan order rather than minted, JSON keys are sorted and deflate runs at a
fixed level. `--check` builds into the OS temp directory and byte-compares:

```
determinism check: a fresh build is byte-identical to the committed assets
```

The tool loads the TypeScript kernel through Vite's own module runner, so it
sees byte-for-byte the same kernel the browser does.

---

## 4. What the surfaces draw

The explorer and the landing hero draw **each part's measured LDraw envelope at
its exact document transform**, in its real LDraw colour, with its real stud
positions — not its compiled mesh. That is deliberate: neither route may
download the catalog or the Three.js renderer, and thousands of correctly-occluded
boxes still read as the model far better than a spinner. Both surfaces label it *envelope
view* and point at the editor for the compiled geometry. The thumbnails and
social cards *are* real renders, rasterized offline from the compiled triangles.

Landing calls to action (live copy in `LandingPage.tsx`):

| CTA | Target |
| --- | --- |
| Explore the megabuilds | `/explore` |
| Start from scratch | `/editor?doc=blank` |
| Open this build | `/explore?demo=<spotlight>` |
| Open the editor | `/editor` (restores the newest local project, or a blank) |
| Describe another idea | `/editor?doc=blank&intent=describe` — blank project, Generate panel revealed |

`?intent=describe` is read by the workbench. The editor's empty viewport then
offers a starter brick and the first three megabuilds as one-click forks.

The hero replays one real piece of work in four stages — brief, candidate,
refinement, validated — from two published documents (`rough.json` and
`document.json`) and the two validation reports that gated them. There is no
scripted transcript. Every stage is reachable from the stage track as a real
tab, so the story does not depend on an animation running.

---

## 5. Measured results

Command: `node tools/e2e/landing.mjs` (also run by `tools/e2e/run-all.mjs`,
which supplies `BRICKWRIGHT_E2E_URL`). Hosted CI runs this suite on the
blocking `acceptance` matrix.

### Boot budget, on the integrated shell

Loading `/` from the application served by `run-all.mjs` must contain **zero
forbidden** requests: no `catalog/`, no `.bwmesh`, no `src/App.tsx`, no
`src/editor/**`, no `src/webmcp/**`, no `src/cad/{catalog,catalog-loader,engine,session,
collision,snapping,mesh}.ts`, no Three.js.

`src/features/landing/imports.test.ts` asserts the same property against the
static import graph, in milliseconds, without a browser — that is the version
that will fail the moment somebody adds the import.

### Delivery

The gate that actually catches a regression is **bytes**, not LCP.
`tools/e2e/landing.mjs` currently holds:

| Gate | Budget |
| --- | ---: |
| Render-critical path (document + stylesheet + entry script) | **450 KiB** |
| Gzip of assets referenced from shipped `dist/index.html` head | **220 KiB** (Hexclave must not be among them) |
| LCP | **3,000 ms** ceiling (host-sensitive; median of three calibrated samples) |
| CLS | **0.1** |

CPU throttle is **calibrated, not a hard-coded 4×** — see `docs/deployment.md`.
A request log that still names `courtyard-terrace` or `heron-sculpture` is from
the retired six-demo era; the live collection is the ten megabuilds above.

**Why its own entry.** `src/main.tsx` mounts these inside the platform shell,
whose entry statically imports the Hexclave account SDK — around twenty chunks
that neither surface uses. An LCP measured against that answers a question about
the account layer, not about this page. The boot-budget figures above *are*
measured on the integrated shell; the LCP and CLS are measured on the page
itself. `standalone.tsx` is also a standing proof that neither surface depends
on the shell.

### Behaviour

The acceptance run still checks deep links (`?demo=&step=`), demo switching,
browser back and forward, step scrubbing into the URL, the anonymous fork (a
real IndexedDB project whose part count matches the published snapshot),
**canonical-demo immutability** (the served snapshot's SHA-256 is unchanged
after a fork and matches the manifest), the editor handoff (`/editor?project=`
opens that copy), and the authenticated-fork adapter path (the adapter receives
the demo id, the catalog version and the snapshot digest as provenance).

Reduced motion is a complete alternative, not a disabled one. Font metric
overrides on the landing stylesheet exist so a webfont swap does not shove the
headline; the CLS budget is 0.1.

---

## 6. What is not claimed

- The interactive views are envelope views. They are not the compiled mesh, and
  both surfaces say so on screen.
- The hero's brief is a real request with the fields a deterministic compiler
  read out of it. No model ran; nothing here calls a provider.
- Mass runs 8–15% heavy and clutch capacity is an assumption at 100 gf/stud.
  Both are stated in the explorer, in the words the statics report uses.
- Some part/colour pairings have no observed official-set appearance. They are
  reported as *colours without set evidence*, which is what the kernel calls
  them; they are legal to build and export.
- The landing hero is the whale even though the manifest's `hero` flag is on
  the campus set. That is a product choice, not a compiler bug.
