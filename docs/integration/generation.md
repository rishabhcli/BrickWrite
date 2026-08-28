# Generation

Workstream 3. Turns a natural-language request into an editable, physically
valid assembly.

Owns `src/generation/**` and `server/generation/**`. Imports the CAD kernel
(`src/cad/*`) and `src/platform/contracts.ts`; imports nothing from another
feature directory. Nothing under `src/` imports anything under `server/`.

---

## The idea in one paragraph

A candidate is never a list of guessed world coordinates. It is a **build
graph**: nodes are part or region *intents*, edges are connector-to-connector
*attachments*. The model proposes structure in that space; the deterministic
realiser turns each attachment into a pose by running the kernel's own snap
solver (`findSnapCandidates`), and verifies every placement against collision,
connectivity, statics and build order before keeping it. An attachment that
cannot be realised is repaired or rejected **with a reason** — never retained
because the model asked for it. No coordinate in the output was ever proposed by
a model.

Bulk fill is delegated to the parametric planners in `src/cad/assembly.ts`
(`planWall`, `planEnclosure`, `planBrickField`) rather than solved joint by
joint. A wall's correctness is a property of the *bond* — staggered seams, exact
coverage, interlocked corners — which is a global constraint over a course, not
a local one over a joint, and those planners solve it exactly. What the realiser
owns is where a region starts and whether it actually attached; both are
verified here against the kernel's connection graph rather than assumed.

---

## Public exports

Everything is re-exported from `src/generation/index.ts`.

### `brief.ts` — prose to a `DesignBrief`

| Export | Purpose |
|---|---|
| `compileBrief(text, options)` | Compiles a request. Returns `DesignBriefResult`. |
| `briefOnly(text, options)` | The `DesignBrief` alone. |
| `compileBriefDeterministically(text)` | The rule-based compiler, no provider. |
| `classifySubject(text)` | Vehicle / building / furniture / creature / mechanism / sculpture. |
| `matchColours(text)` | Colour words resolved against the compiled LDraw table. |
| `amendBrief(brief, patch, reason)` | Operator edits, keeping the evidence trail. |
| `DESIGN_BRIEF_SCHEMA`, `BRIEF_COMPILER_VERSION` | Wire schema and version stamp. |

**Signature note.** `compileBrief` returns `{ brief, provenance, method, usage,
notes }` rather than a bare `DesignBrief`. This is a deliberate deviation from
the literal brief: `DesignBrief` has nowhere to carry provenance, so a caller
receiving only a brief cannot tell a rule-based reading from a model's judgement
— which is exactly what "degrade to a deterministic compiler and say so in
provenance" requires it to be able to do. `briefOnly` gives the bare contract
value for callers that already know.

Every populated field records the phrase behind it in `evidence`. Contradictions
go to `conflicts` and are never resolved silently — `"A micro-scale but large red
castle"` yields a `scale` conflict rather than a choice.

### `graph.ts` — the build graph

`BuildGraph`, `BuildNode`, `BuildEdge`, `PartIntent`, `RegionIntent`,
`ConnectorRef`, `ConnectorPick`.

| Export | Purpose |
|---|---|
| `validateGraph(graph)` | Structural invariants; returns `GraphViolation[]`. |
| `topologicalOrder(graph)` | Placement order, ties broken by node id. |
| `subgraph(graph, rootIds)` | Everything reachable downward. |
| `structuralHash(graph)` | 64-bit hash of *shape*, node ids relabelled away. |
| `mergeProtected(graph, ids, present)` | Folds approved parts in as fixed inputs. |
| `familiesCanMate(a, b)` | Family-level compatibility, pre-catalog. |

Invariants enforced: unique node ids, known endpoints, no self-edges, **exactly
one incoming edge per placed node**, no cycles, roots carry an anchor, no edge
writes to a protected node, and edge families that can actually mate.

Single-parent is the one that carries the most weight. A node's pose comes from
exactly one solved attachment; two incoming edges would be two independent claims
on the same six degrees of freedom. Extra contact is not lost by this rule — the
snap solver *discovers* every simultaneous mate at the solved pose and the kernel
records all of them, so a brick landing on eight studs is joined to all eight
regardless of which one the graph named.

### `realize.ts` — the deterministic realiser

| Export | Purpose |
|---|---|
| `realizeGraph(graph, base, options)` | Graph in, `CadOperation[]` + preview document out. |
| `GraphRealizer` | The same, kept alive across phases so each node is placed once. |
| `resolvePartIdentity(intent)` | Catalog identities, `placeable` tier only. |
| `orderFeatures(definition, ref)` | Every connector a reference could mean, best first. |
| `measuredExtentStuds(document)`, `realizedParts(result)` | Measurement helpers. |
| `GenerationAbortedError` | Thrown when an `AbortSignal` fires mid-realisation. |

Per-node and per-edge outcomes are `realized | repaired | rejected | skipped`,
each carrying a reason and an `attemptLog`. The log exists because reporting only
the *last* failure is actively misleading: repair walks outward, so the final
message is usually "it left the envelope four studs away" when the thing that
actually went wrong was the first attempt's collision.

### `repair.ts` — constrained repair

`enumerateAttachmentAttempts(input)` and `enumerateRegionAttempts(input)` return
a bounded, deterministic attempt sequence in order of increasing damage to what
was asked for:

1. **another connector pair** — same two parts, joined elsewhere;
2. **another compatible part** — same place, different identity;
3. **a small lattice offset** — same part, moved by whole studs (and, for a
   region, a reduced footprint as the last resort).

Default budget 24 attempts. The seed rotates the *alternatives* only, never the
primary, so a graph always tries what it asked for first. "Keep it anyway" is not
on the list.

### `phases.ts` — the four-phase pipeline

`runPipeline(brief, options) → Candidate`, emitting a `PhaseEvent` per phase.

| Phase | Question it answers | What it places |
|---|---|---|
| `massing` | What volume is this, and how does it break into boxes? | One deck per storey. |
| `skeleton` | What holds it up? | The perimeter of each box, full height, one stud thick. |
| `packing` | Fill, with a real bond. | Interior bracing, laid by the parametric planners. |
| `detail` | Surface. | Accents and greebles, each solved through the snapper. |

Phases only ever *add* to the graph, so silhouette coverage is monotonic and a
failing phase leaves the previous candidate intact and inspectable. Cancellable
between phases and between nodes.

Also exported: `STRATEGIES` (`framed-shell`, `stacked-slab`, `spine-and-ribs`),
`layoutStoreys`, `fitBoxHeights`, `clampBoxes`, `volumeFor`, `constraintsFor`,
`MASSING_SCHEMA`, `DEFAULT_PART_BUDGET` (420), `HARD_PART_CEILING`
(`MAX_GENERATED_PARTS`, 4000).

### `score.ts` — the metric vector

`scoreDocument(document, brief, options) → MetricVector` with 26 axes:
`partCount`, `distinctElements`, `commonness`, `rarePartCount`,
`paletteConformance`, `virtualColourCount`, `collisionCount`,
`unverifiedCollisionCount`, `componentCount`, `largestComponentFraction`,
`weakAttachmentCount`, `massGrams`, `massCoverage`, `supportMarginLdu`,
`overloadedJointCount`, `unsupportedPartCount`, `buildOrderValid`,
`buildOrderViolations`, `buildStepCount`, `buildOrderIslands`, `silhouetteIou`,
`silhouettePerView`, `extentStuds`, `withinEnvelope`, `withinBudget`,
`budgetUsed`.

The vector is reported, never collapsed. `evaluateHardGates` separates the axes
that are gates (collisions, build order, budget, envelope, palette) from the ones
that are preferences — a model that interpenetrates itself is not a worse
candidate, it is not a candidate. `diffMetrics` / `metricDistance` compare two
candidates axis by axis and deliberately return no verdict: which direction
counts as better is a question about the brief.

### `silhouette.ts` — reference conditioning

`rasteriseSilhouette`, `maskFromEnvelope`, `maskFromBounds`, `maskFromBitmap`,
`compareMasks`, `referencesFromEnvelope`, `silhouetteScore`, `frameForBounds`,
`frameForEnvelope`, `maskToText`.

Front / side / top orthographic occupancy, with IoU, coverage and spill. Two
masks must share a `SilhouetteFrame` or `compareMasks` throws — an IoU between
masks in different frames is a meaningless number that still looks like a valid
one.

### `engine.ts` — candidates

| Export | Purpose |
|---|---|
| `GenerationEngine` | `generate(brief, options) → GenerationRun`. |
| `describeRun(brief, options)` | The five values a run is reproducible from. |
| `candidateOperations(candidate)` | Operations plus the derived `steps.replace`. |
| `applyCandidate(candidate, target, revision)` | Commits through `commandBus` **or** a `CadEngine`. |
| `compareCandidates(a, b)` | Number of metric axes separating two candidates. |
| `GENERATION_VERSION` | `'generation/1'`. |

Rejected candidates are kept and reported with their failures rather than
discarded: "we generated three and are showing you none" and "we generated
nothing" are different situations.

### `provider.ts` — the browser client

`createGenerationProvider(options) → ModelProvider` and
`compileBriefViaServer(text, options)`. Speaks HTTP to `server/generation`,
reads the newline-delimited event stream, and **never holds a credential**. A
server 503 with `model_provider_unavailable` becomes a
`ModelProviderUnavailableError`.

### `testing.ts` — the in-test double

`createTestModelProvider(options)` and `doubleMassing(prompt)`. A *double*, not a
fallback: nothing in the runtime path constructs one. Its decomposition is
derived from the prompt and is deliberately unlike any built-in strategy, so the
model path is not exercising the deterministic path under another name.

---

## Server route contract

`server/generation/index.ts` exports `route: RouteModule` — `{ prefix: '/api/',
handle(request, response, url) }` — discovered by `server/index.ts`.

```
$ npm run serve:api
[api] listening on http://127.0.0.1:8787 with 2 route module(s): /api/assistant, /api/

$ curl -s http://127.0.0.1:8787/api/health
{"ok":true,"routes":["/api/assistant","/api/"]}
```

### `POST /api/generate`

```jsonc
// request
{ "system": "...", "prompt": "...", "schema": { /* JSON Schema */ }, "maxTokens": 1500 }
```

Responds `200 application/x-ndjson`, one event per line, last line terminal:

```jsonc
{"type":"accepted","requestId":"gen_..."}
{"type":"progress","stage":"calling model"}
{"type":"progress","stage":"retrying after a schema violation"}
{"type":"result","requestId":"gen_...","value":{...},"provenance":{...},"usage":{"inputTokens":1652,"outputTokens":1088},"attempts":2}
```

or, terminally, `{"type":"error","error":"<code>","detail":"<one sentence>"}`.

### `POST /api/brief`

```jsonc
{ "text": "Build a small red house 12 x 10 studs, 10 studs tall, under 300 pieces, with doors that open" }
```

Same stream shape; `value` is a version-1 `DesignBrief` with the palette resolved
to LDraw codes from the compiled catalog on disk. When that catalog is not
present the palette comes back empty and `notes` says so — it is never guessed.

### Status and error codes

| Situation | HTTP | Code |
|---|---|---|
| No `ANTHROPIC_API_KEY` | 503 (before the stream opens) | `model_provider_unavailable` |
| Credential rejected (401/403) | in-stream error | `model_provider_unavailable` |
| Malformed body / missing field | 400, or in-stream | `bad_request` |
| Non-POST | 405 | `method_not_allowed` |
| Schema violated twice | in-stream | `schema_violation` |
| Upstream 429 | in-stream | `rate_limited` |
| Any other upstream failure | in-stream | `model_error` |
| Client hung up | in-stream | `aborted` |

Nothing forwards a stack or an SDK error body. Everything bound for a client goes
through `redact`, which blanks anything shaped like an Anthropic key or a bearer
token. A client that goes away aborts the model call — the abort listener is on
the **response**, not the request, because a request with a body has already
emitted `close` by the time its body has been read.

### The JSON Schema subset the endpoint actually accepts

Established by probing the live API, not assumed. `output_config.format.schema`
**rejects**:

- `minItems` / `maxItems` on arrays (any value; `minItems` even at 2),
- `minimum` / `maximum` on integers and numbers,
- `additionalProperties: <object>` (open-ended maps).

It **accepts** `type: ['integer','null']`, `anyOf`, `enum`, and `minLength` /
`maxLength` on strings.

Two consequences are visible in the wire schemas and are intent, not workaround:
a box's position travels as `atXStuds` / `atZStuds` scalars rather than a
two-element array, and a brief's envelope travels as three nullable scalars with
evidence as a list of `{field, phrase}` pairs. The endpoint constrains the
*shape*; the zod schemas in `server/generation/schema.ts` constrain the *values*,
and a violation of either takes the corrective retry.

### Validation, retry, refusal

The answer is validated by zod even though the API was told the schema — a
structured-output guarantee is a property of one provider's endpoint, and
trusting it without validating would turn a provider change into a silent change
of contract. On violation the failing answer *and the validator's complaints* go
back as another turn, which is the difference between asking again and asking
better. Two attempts is the ceiling.

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Absent, every generation route answers 503 `model_provider_unavailable`. Read **only** in the API process. |
| `BRICKWRIGHT_GENERATION_MODEL` | `claude-sonnet-5` | Model id. |
| `BRICKWRIGHT_GENERATION_TIMEOUT_MS` | `120000` | Per-request ceiling. |
| `BRICKWRIGHT_API_PORT` | `8787` | Port for `server/index.ts`. |
| `BRICKWRIGHT_GENERATION_PORT` | `8788` | Port when running `server/generation/serve.ts` alone. |
| `BRICKWRIGHT_LIVE_TESTS` | unset | `1` enables the live smoke test. |

Sonnet 5 is the default because the task is a bounded, schema-constrained
decomposition rather than open-ended reasoning, and it sits on the request path
of an interactive editor. `temperature` is deliberately never sent: sampling
parameters are rejected outright by this model family, and reproducibility here
comes from the seeded kernel rather than from asking a model to repeat itself.

---

## Provenance and reproducibility

`GenerationEngine.describeRun(brief, options)` returns the five values a run is
reproducible from:

```ts
{
  promptHash,  // hash32(stableStringify({ brief, settings, version }))
  provider,    // 'anthropic' | 'deterministic'
  model,       // 'claude-sonnet-5' | null
  version,     // 'generation/1'
  settings,    // { candidates, repairBudget, strategies, constraints }
  seed,        // root seed
}
```

Each candidate's own seed is derived — `hash32(promptHash|strategy|rootSeed|index)`
— rather than incremented, so two candidates of the same strategy in different
runs cannot coincide and the sequence does not depend on how many candidates were
asked for. Every random choice downstream goes through `mulberry32(seed)`.
Generated part ids are `<idPrefix>_NNNN` with `idPrefix` derived from the prompt
hash; the parametric planners' `createId` values are replaced index-by-index,
because `createId` is random by design and reproducibility here is a hard
requirement.

`Provenance` reports `provider: 'deterministic'`, `model: null` whenever no model
ran, so a rule-based reading is never presented as a model's judgement.

---

## Measured numbers

All figures from this repository, `catalog.fixture.json` (58 placeable
identities), Node 26, on the deterministic in-test provider double unless stated.

### Golden briefs — 21 briefs × 3 candidates

| | |
|---|---|
| Briefs | 21 across vehicle (4), building (4), furniture (4), creature (3), mechanism (3), sculpture (3) |
| Candidates generated | 63 |
| Parts placed | 6,695 |
| Collisions (`findCollisions` + `residentGeometryProvider`) | **0** |
| Build orders verified (`verifyBuildOrder`) | **63 / 63 valid, 0 violations** |
| Connected components | **1 for all 63** |
| Identities at tier `placeable` | **100%** |
| Briefs yielding 3 distinct structural hashes | **21 / 21** |
| Parts per candidate | min 45, median 88, mean 106.3, max 223 |
| Distinct elements per candidate | 7 – 15 |
| Wall clock | 9,186 ms for 63 candidates — **146 ms per candidate** |

Per-brief part counts range from `furniture-armchair` at 45/46/48 to
`building-gatehouse` at 217/223/223.

### Silhouette IoU, massing → detail

Brief: *"Build a light bluish grey tower 10 x 10 studs, 14 studs tall, under 400
pieces"*, reference = the requested envelope in all three views.

| Strategy | massing | skeleton | packing | detail |
|---|---|---|---|---|
| `framed-shell` | 0.5095 (64p) | 0.8667 (130p) | 0.8667 (146p) | **0.8738** (149p) |
| `stacked-slab` | 0.5952 (92p) | 0.9524 (156p) | 0.9524 (181p) | **0.9619** (184p) |
| `spine-and-ribs` | 0.4524 (46p) | 0.8286 (112p) | 0.8286 (136p) | **0.8286** (139p) |

Monotonic non-decreasing in every case, with a strict increase from massing to
detail. `packing` does not raise IoU because interior bracing sits inside cells
the shell already covers — the parts it adds show up in the stability and
connectivity axes instead, which is the argument for reporting a vector.

### Diversity

Brief `building-gatehouse`, seed 11:

```
stacked-slab   = a604f15a4c073115
spine-and-ribs = 1aa5147f77c2371e
framed-shell   = 6147cda5d1c8c184
```

Pairwise metric-vector differences: 3, 5 and 5 axes.

### Live provider

Real key, real model, real route, real kernel:

```
[live] model=claude-sonnet-5 route=http://127.0.0.1:59524
[live] brief subject="small red house" envelope=[12,10,10] budget=300 palette=[4] functions=["doors that open"]
[live] brief usage={"inputTokens":1235,"outputTokens":316} attempts=1
[live] massing boxes proposed by the model: [
         {"id":"base","role":"tower_shell_lower","atStuds":[0,0],"widthStuds":12,"depthStuds":10,"courses":3,"level":0,"fill":"shell"},
         {"id":"upper","role":"tower_shell_upper","atStuds":[1,1],"widthStuds":10,"depthStuds":8,"courses":3,"level":1,"fill":"shell"},
         {"id":"observation","role":"observation_deck","atStuds":[2,2],"widthStuds":8,"depthStuds":6,"courses":1,"level":2,"fill":"solid"}]
[live] candidate strategy=framed-shell parts=137 distinct=15 collisions=0 components=1 buildOrderValid=true steps=20
[live] mass=246.8g supportMargin=98.98ldu overloaded=0 extent=12.0 x 11.2 x 10.0 studs
[live] gates=all passed
[live] provenance={"provider":"anthropic","model":"claude-sonnet-5","promptHash":"9a870e5f","seed":3,"createdAt":"2026-08-28T14:23:01.051Z"}
```

The corrective retry has also been observed against the live model — a `curl` to
a running `npm run serve:api` returned `"attempts":2` after a
`retrying after a schema violation` progress event, and the second answer was
accepted.

### Test suite

```
$ npx vitest run src/generation server/generation
 Test Files  4 passed (4)
      Tests  56 passed | 1 skipped (57)
   Duration  11.85s
```

The skip is the live smoke test, which requires `BRICKWRIGHT_LIVE_TESTS=1`.

---

## Running the live smoke test

```bash
export ANTHROPIC_API_KEY=sk-ant-...
BRICKWRIGHT_LIVE_TESTS=1 npx vitest run server/generation/live.test.ts --reporter=verbose
```

Two model calls, a handful of cents. It starts the real route on an ephemeral
port, compiles a brief through `POST /api/brief`, drives the whole four-phase
pipeline through `POST /api/generate` with `createGenerationProvider`, and then
asserts the resulting document through the kernel: zero collisions, a verified
build order, a measured mass. Without the opt-in it is skipped and says so —
a suite that quietly substituted a double here would report a green live test
having never made a request.

`server/generation/serve.ts` runs the generation routes alone
(`node server/generation/serve.ts`), which is what the tests bind and is useful
when the rest of the API process is not the thing being checked.

---

## What I could not prove

Stated plainly, because each of these is a real limit on the claims above.

1. **Collision verdicts in the test suite are `unknown` certainty, not
   triangle-exact.** `findCollisions` is called with `residentGeometryProvider`,
   which reads the runtime mesh cache; in a headless test run no mesh has
   streamed in, so verdicts come from measured world bounding boxes with the
   mating-clearance allowance subtracted. **Zero contacts is a stronger result
   than "no confirmed collisions"** — a box test over-reports rather than
   under-reports, so a clean box pass means no triangle pass could find more —
   but it is not the same as having run the narrow phase. Proving the exact
   verdict needs the committed `.bwmesh` pack decoded into the suite, the way
   `src/cad/collision.test.ts` does it.

2. **Silhouettes are bounding-box projections, not rendered outlines.**
   `silhouette.ts` deliberately does not use `src/cad/raster.ts`, which needs
   per-part triangle arrays that are streamed assets and absent headlessly. A
   slope, a wheel or a windscreen therefore reads slightly larger than it is. The
   error is uniform across phases, which is what the massing→detail comparison
   needs, but the absolute IoU against a *photographic* reference is not
   validated — only against envelope masks.

3. **The 21 golden briefs run against the model double, not the live model.**
   The live path is proven once, end to end, by `live.test.ts`. Running all 63
   candidates live would cost real money on every `npm test` and make the suite
   depend on a network.

4. **The catalog fixture is 58 placeable identities, not the 900-part pack.**
   Part selection, family libraries and identity resolution are exercised against
   a real slice of the compiled catalog, but the behaviour of `resolvePartIdentity`
   over the full library — and whether the detail phase would pick better parts
   from it — is untested here.

5. **`server/**` is not covered by `npx tsc -b`.** `tsconfig.node.json` includes
   `src` and `tools` but not `server`, and the tsconfigs are integration-owned.
   The server module typechecks under an equivalent ad-hoc invocation
   (`npx tsc --ignoreConfig --noEmit --target ES2022 --module ESNext
   --moduleResolution Bundler --strict --types node,react
   server/generation/*.ts`, exit 0) and is compiled by vitest on every run, but a
   project-level reference would be better and is the integrator's call.

6. **Regions are axis-aligned in document space.** The parametric planners run
   along X or Z and lay rectangles; a rotated region is not expressible and is
   not pretended to be. Single parts are fully 6-DOF through the snap solver.

7. **Functional requirements are only partly honoured.** A brief asking for doors
   or windows produces real seated frames and glazing through `planEnclosure`
   openings. A brief asking for wheels that turn, a roof that lifts off or a
   winch is recorded in `brief.functions` and surfaced, but no articulated
   mechanism is generated — `planHingedFlap` exists in the kernel and is not
   wired in.

8. **The detail phase does not consult the model.** `server/generation/schema.ts`
   carries a validated `detail` payload kind and the route will serve it, but
   `phases.ts` builds the detail delta deterministically. Massing is the phase the
   model actually drives.

9. **`fitBoxHeights` reserves a flat 4 LDU for the topmost studs.** That is the
   LDraw stud height and is correct for studded courses; a build topped by tiles
   loses 4 LDU of usable envelope it could have had.

10. **No UI.** This workstream publishes an API. Nothing here renders, and the
    editor integration is another workstream's.

### Also worth flagging to the integrator

`server/assistant/provider.ts` uses a TypeScript **parameter property**
(`constructor(readonly code: ...)`), which Node's strip-only loader rejects with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. It broke `npm run serve:api` for the whole
process until it was fixed; the same pattern was removed from
`server/generation/anthropic.ts` for the same reason. Anything under `server/**`
has to avoid parameter properties.
