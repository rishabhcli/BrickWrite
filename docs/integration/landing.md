# Workstream 10 — Landing, Explore and the curated demos

Owns `src/features/landing/**`, `src/features/explore/**`, `src/demos/**`,
`public/demos/**`, `tools/build-demos.mjs` and `tools/e2e/landing.mjs`.

Two public surfaces and the data behind them: a landing page that demonstrates
the product with real documents, an explorer that takes one apart, and six
curated builds that were authored against the real catalog and put through the
kernel's own gates before they were allowed to ship.

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
`explore: 'catalog'`) are correct and neither surface needs more than `none` —
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
query string: `/explore?demo=heron-sculpture&step=4`. The shell's router matches
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

Six builds, one per discipline, authored programmatically in
`tools/build-demos.mjs` against catalog `2026-07` and the real assembly
planners:

| Demo | Discipline | Parts | Mates | Steps | Mass | Tipping margin |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Courtyard terrace | Architecture | 142 | 1016 | 13 | 374 g | 139.9 LDU |
| Ridgeline hauler | Vehicle | 33 | 136 | 7 | 45 g | 40.0 LDU |
| Heron | Creature | 32 | 108 | 7 | 39 g | 73.5 LDU |
| Shutter bay | Mechanism | 56 | 270 | 9 | 91 g | 78.5 LDU |
| Draughting desk | Furniture | 36 | 188 | 7 | 82 g | 40.0 LDU |
| SNOT kiosk | Advanced technique | 32 | 258 | 5 | 75 g | 59.0 LDU |

The terrace, the shutter bay, the desk and the kiosk are laid by
`planEnclosure`, `planWall`, `planBrickField` and `planHingedFlap`; the hauler
and the heron are hand-placed against the compiled connectors; the kiosk's
facade tiles are posed by `bestSnapTransform`, the same 6-DOF solver a drag in
the editor runs through.

### The gates

A demo that fails any of these is **not written to the manifest**. The build
exits non-zero and the committed assets keep their previous contents.

1. every part is in the catalog, is its canonical id, and has compiled geometry;
2. triangle-confirmed collision, run twice, with **no** `unknown` verdicts;
3. exactly one connected component over the derived connection graph;
4. a derived build order that re-verifies against its own guarantee, covering
   every part, with no unsupported island;
5. measured statics: full mass coverage, centre of mass inside the support
   polygon, no group over its clutch capacity, and every part reached by the
   load path from the ground — except where the demo declares a
   `tensionAllowance` and says why (the shutter's hinge, the kiosk's SNOT
   facade);
6. a **measurably worse** first candidate, so the refinement the landing page
   shows is a real comparison and not a story.

`src/demos/manifest.test.ts` re-derives the connection graph, the build order
and the statics report from the committed documents and asserts the same
properties, plus every asset's byte length and SHA-256 against the manifest.

### Rebuilding

```bash
node tools/build-demos.mjs            # authors, gates, renders, writes
node tools/build-demos.mjs --check    # rebuilds into a temp tree and diffs
node tools/build-demos.mjs --only=heron-sculpture   # one demo, no manifest write
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
download the catalog or the Three.js renderer, and 140 correctly-occluded boxes
read as the model far better than a spinner. Both surfaces label it *envelope
view* and point at the editor for the compiled geometry. The thumbnails and
social cards *are* real renders, rasterized offline from the compiled triangles.

The hero replays one real piece of work in four stages — brief, candidate,
refinement, validated — from two published documents (`rough.json` and
`document.json`) and the two validation reports that gated them. There is no
scripted transcript. Every stage is reachable from the stage track as a real
tab, so the story does not depend on an animation running.

---

## 5. Measured results

Command: `node tools/e2e/landing.mjs` (also run by `tools/e2e/run-all.mjs`,
which supplies `BRICKWRIGHT_E2E_URL`).

### Boot budget, on the integrated shell

Loading `/` from the application served by `run-all.mjs`, **63 requests, zero
forbidden**: no `catalog/`, no `.bwmesh`, no `src/App.tsx`, no `src/editor/**`,
no `src/webmcp/**`, no `src/cad/{catalog,catalog-loader,engine,session,
collision,snapping,mesh}.ts`, no Three.js.

`src/features/landing/imports.test.ts` asserts the same property against the
static import graph, in milliseconds, without a browser — that is the version
that will fail the moment somebody adds the import.

### Delivery

Measured against a **production build of the landing and explore surfaces as
their own entry** (`src/features/landing/standalone.tsx`), served statically
with SPA fallback, at 4× CPU throttling and Fast 3G (1.6 Mbit/s down, 150 ms
RTT):

| Metric | Measured | Budget |
| --- | ---: | ---: |
| LCP | **2284 ms** | 2500 ms |
| CLS | **0.063** | 0.1 |
| Requests | 16 | — |

The 16 requests, in order:

```
200  document      /
200  stylesheet    /assets/standalone-*.css
200  script        /assets/standalone-*.js
200  image         /demos/courtyard-terrace/thumb.png
200  image         /demos/ridgeline-hauler/thumb.png
200  image         /demos/heron-sculpture/thumb.png
200  image         /demos/shutter-bay/thumb.png
200  font          /assets/chakra-petch-latin-600-normal-*.woff2
200  fetch         /demos/courtyard-terrace/rough-preview.json
200  font          /assets/chakra-petch-latin-500-normal-*.woff2
200  fetch         /demos/courtyard-terrace/preview.json
200  font          /assets/manrope-latin-wght-normal-*.woff2
200  image         /demos/draughting-desk/thumb.png
200  image         /demos/snot-kiosk/thumb.png
200  script        /assets/projection-*.js
200  script        /assets/EnvelopeView-*.js
```

No compiled catalog, no `.bwmesh`, no thumbnails from `assets/thumb/`. Every
JavaScript file in that log is read back off disk and searched for fingerprints
of Three.js (`WebGLRenderer`), the catalog loader (`CatalogUnavailableError`),
the kernel (`STALE_DOCUMENT`) and the WebMCP adapter — chunk *names* are a
bundler detail, so the check reads the bytes.

The last two scripts are the envelope renderer, fetched **after** the hero
stage scrolls into view, which is why they are behind the fonts and the images.

**Why its own entry.** `src/main.tsx` mounts these inside the platform shell,
whose entry statically imports the Hexclave account SDK — around twenty chunks
that neither surface uses. An LCP measured against that answers a question about
the account layer, not about this page. The boot-budget figures above *are*
measured on the integrated shell; the LCP and CLS are measured on the page
itself. `standalone.tsx` is also a standing proof that neither surface depends
on the shell.

**One thing this could not prove.** A production build of the *whole*
application currently throws `TypeError: k is not a function` from
`assets/hexclave-*.js` before React mounts, so nothing renders. It reproduces
with `npx vite build && npx vite preview` and is unrelated to these surfaces —
the development server is fine and every behavioural check above passes against
it — but it means an integrated production LCP could not be taken. That belongs
to the account layer (workstream 7) or to the manual chunk groups in
`vite.config.ts`.

### Layout shift, and what fixed it

The first measurement was **CLS 0.354**, from a single shift when the web fonts
swapped in. Chakra Petch sets text about 22% wider than the condensed system
face it fell back to, and Manrope 3.1% wider than a generic sans, so every
headline and paragraph re-wrapped and the whole document moved.
`src/features/landing/surface.css` now declares two metric-matched fallback
faces (`size-adjust`, `ascent-override`, `descent-override`) built from fonts
the browser already has. Measured again: **0.063**.

### Responsive

Full-page captures at 1440×900, 834×1112 and 390×844 for both surfaces, plus
the reduced-motion landing and the production build, in `artifacts/landing/`:

```
landing-desktop.png   landing-tablet.png   landing-mobile.png
explore-desktop.png   explore-tablet.png   explore-mobile.png
landing-reduced-motion.png   landing-production.png   report.json
```

Horizontal overflow is **0 px at every viewport, on both surfaces** — asserted,
not eyeballed.

### Accessibility

Asserted in the acceptance run: exactly one `h1`, exactly one banner and one
main landmark (both from `AppFrame` — the surfaces deliberately emit neither),
every section labelled, every image described, the model canvas `aria-hidden`
inside a labelled `role="img"` wrapper with arrow-key orbit, 60 tab stops with
no focus trap, and the demo cards reachable by keyboard. The build sequence is
also published as a visually-hidden ordered list, so the model is not
canvas-only. Unit tests cover heading order and the absence of duplicate
landmarks.

Reduced motion is a complete alternative, not a disabled one: reveals start
shown, the hero does not auto-advance, and its four stages remain selectable as
tabs. The refinement sweep renders at a fixed mid-point, so both the candidate
outlines and the resolved geometry are visible at once. Exercised in
`landing.test.tsx` and again in the acceptance run under
`reducedMotion: 'reduce'`.

### Behaviour

All ten behavioural checks pass against the shared server: deep links
(`?demo=&step=`), demo switching, browser back and forward, step scrubbing into
the URL, the anonymous fork (a real IndexedDB project with all 142 parts and its
own id), **canonical-demo immutability** (the served snapshot's SHA-256 is
unchanged after a fork and matches the manifest), the editor handoff (the editor
boots its kernel and reports 142 parts), and the authenticated-fork adapter path
(the adapter receives the demo id, the catalog version and the snapshot digest
as provenance, and its project id is what the handoff link points at).

---

## 6. What is not claimed

- The interactive views are envelope views. They are not the compiled mesh, and
  both surfaces say so on screen.
- The hero's brief is a real request with the fields a deterministic compiler
  read out of it. No model ran; nothing here calls a provider.
- Mass runs 8–15% heavy and clutch capacity is an assumption at 100 gf/stud.
  Both are stated in the explorer, in the words the statics report uses.
- Two of the terrace's part/colour pairings have no observed official-set
  appearance. They are reported as *colours without set evidence*, which is what
  the kernel calls them; they are legal to build and export.
