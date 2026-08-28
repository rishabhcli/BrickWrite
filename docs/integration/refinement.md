# Workstream 4 — Refinement ("Design Doctor")

Owns `src/refinement/**`. Imports the CAD kernel (`src/cad/*`) and
`src/platform/contracts.ts`; imports nothing from another feature directory.

Refinement is the second half of the build loop. Something rough exists, a region
of it is selected, and a change is asked for in words. This module turns that into
located, measured findings; generates alternatives; scores every one of them on a
complete objective vector; and hands back ranked ghost proposals that have already
passed every check the kernel would apply. It mutates nothing until
`applyRefinement` is called, and that call goes through `commandBus.dispatch` with
the proposal's own base revision.

**It exports data, not components.** The viewport gets an overlay instruction list;
the agent workbench gets the same proposals and metric vectors. Neither imports the
other. The eventual review panel mounts through
`src/editor/workbench/ExtensionRegistry.tsx`, using the shapes below.

---

## 1. The flow

```ts
import {
  analyseRegion, createScope,          // 1. what is wrong
  proposeRefinements,                   // 2. ranked ghosts, mutates nothing
  applyRefinement,                      // 3. one atomic transaction
} from '../refinement'

const scope = createScope({ partIds: selection, protectedPartIds, boundaryPartIds })
const analysis = analyseRegion(document, scope)          // typed, located issues

const proposals = proposeRefinements(
  {
    version: 1,
    id: 'req_1',
    scopePartIds: selection,
    protectedPartIds,
    boundaryPartIds,
    baseRevision: document.revision,
    instruction: 'make the roof lower and cleaner',
    seed: 7,
  },
  document,
)

// proposals[0].overlay -> paint the heatmap
// proposals[0].metrics  -> show the full before/after vector, regressions included
const result = applyRefinement(proposals[0], 'human')     // CommandResult<Transaction>
```

Off the main thread:

```ts
import { runRefinementJob, refinementWorkerAvailable } from '../refinement'
const job = await runRefinementJob(request, document, { catalogBaseUrl: '', signal })
job.ranOn // 'worker' | 'inline' — never claims a thread it did not get
```

With a model (optional, never required):

```ts
import { proposeRefinementsWithModel } from '../refinement'
const run = await proposeRefinementsWithModel(request, document, { provider })
```

---

## 2. Public exports

All from `src/refinement/index.ts`.

### Pipeline
| Export | Shape | Notes |
|---|---|---|
| `proposeRefinements(request, document, options?)` | `RefinementProposalV1[]` | Ranked. **Mutates nothing** — not the document, not the engine. |
| `runRefinement(request, document, options?)` | `RefinementRun` | Same work plus `analysis`, `goal`, `report`. |
| `proposeRefinementsWithModel(request, document, options?)` | `Promise<RefinementRun>` | Model may set weights and ordering only. |
| `applyRefinement(proposal, actor?, bus?)` | `CommandResult<Transaction>` | Dispatches through `commandBus`; refuses rejected/empty proposals before reaching it. |
| `busFor(engine)` | `RefinementBus` | Test seam for an isolated `CadEngine`. |
| `compileRequest(input)` | `RefinementRequestV1` | Zod parse + defaults; throws `RefinementRequestError`. |
| `buildOverlay(before, after, candidate)` | `OverlayInstruction[]` | Exposed so a caller can rebuild a heatmap from any two documents. |
| `metricsFor(document, request)` | `MetricVector` | The vector a document scores under a request's scope. |

### Analysis
`analyseRegion`, `createScope`, `mutablePartIds`, `partsWithinBounds`,
`analysePalette`, `analyseSymmetry`, `findMicroRuns`, `rarityOf`,
`RARITY_REFERENCE_FREQUENCY`, types `RegionAnalysis`, `SymmetryReport`,
`RarityEntry`, `VarietyEntry`, `PaletteEntry`, `MicroRun`.

### Objectives
`OBJECTIVES`, `objectiveList`, `measureAll`, `deltaOf`, `improvementOf`,
`regressionsOf`, `scoreOf`, `resolveWeights`, `defaultWeights`, `MAX_WEIGHT`.

### Strategies
`STRATEGIES`, `STRATEGY_IDS`, `strategyById`, `strategiesFor`, and each generator
(`restack`, `substitute`, `reinforce`, `smooth`, `symmetrize`, `simplify`,
`detail`) as a pure `(document, scope, rng) => CadOperation[][]`.

### Search
`searchRefinements`, `buildCandidateDocument`, `candidateId`, `referenceFor`,
types `SearchBudget`, `SearchCandidate`, `SearchReport`, `SearchRejection`.

### Guards
`guardCandidate`, `assertScopeIsolation`, `checkProtection`,
`checkKernelValidity`, `checkSilhouette`, `heldPartIds`, `componentsOf`,
`addedPartIds`, `removedPartIds`, `modifiedPartIds`, `ScopeViolationError`.

### Worker
`runRefinementJob`, `refinementWorkerAvailable`, `handleRefinementWorkerMessage`,
`installRefinementWorker`, `inWorkerScope`, and the message types.

### Topology / silhouette / mirror
`extractRows`, `extractSeams`, `findStackedSeams`, `countSeams`, `findStepEdges`,
`findFreeStuds`, `matedLocalFeatures`, `definitionFeatureKeys`, `exposedStudPlane`,
`placedParts`; `captureSilhouette`, `silhouetteIou`, `silhouetteDrift`,
`silhouetteArea`, `silhouetteFrame`, `boundsOfParts`, `SILHOUETTE_WIDTH/HEIGHT`;
`mirrorTransform`, `canMirror`, `mirrorPlaneFor`.

### Schemas and constants
`refinementRequestSchema`, `refinementProposalSchema`, `refinementOperationSchema`,
`overlayInstructionSchema`, `metricVectorSchema`, `silhouetteSchema`,
`objectiveIdSchema`, `OBJECTIVE_IDS`, `ISSUE_KINDS`, `CHANGE_KINDS`,
`REJECTION_CODES`, `isApplicable`.

---

## 3. The overlay shape the UI consumes

`proposal.overlay` is the changed-part heatmap, one entry per touched part,
**sorted hottest first** so a viewport can truncate the list and still be showing
the biggest changes.

```ts
interface OverlayInstruction {
  partId: string
  changeKind: 'added' | 'removed' | 'moved' | 'recolored' | 'substituted' | 'reassigned'
  /** Absolute 0–1. Not a confidence, not a share of the proposal. */
  magnitude: number
  /** Document-space anchor for a marker or label, in LDU. */
  atLdu: [number, number, number]
  /** One sentence, already written for a person. */
  detail: string
}
```

`magnitude` is **absolute**, not normalised within the proposal:

| `changeKind` | `magnitude` | Anchor (`atLdu`) |
|---|---|---|
| `added` | `1` | centre of the new part |
| `removed` | `1` | centre of the part that was there |
| `substituted` | `1` | centre of the replacement |
| `moved` | `clamp(distanceLdu / 80, 0.15, 1)` | centre after the move |
| `recolored` | `0.4` | centre |
| `reassigned` | `0.2` | centre |

Absolute rather than normalised, because normalising would make a proposal that
recolours two bricks paint as hot as one that rebuilds a wall.

Guarantees asserted in `fixtures.test.ts` for every ranked proposal of every
fixture: one entry per part, no duplicates, the id set equals
`proposal.changedPartIds`, every `atLdu` finite, every `magnitude` in `(0, 1]`,
and the list sorted descending by magnitude.

For a "ghost" preview, `buildCandidateDocument(document, proposal.operations)`
returns the document the proposal would produce, with its connection graph rebuilt
— the same function the search scores against, so the ghost and the score cannot
disagree.

---

## 4. Objectives — definitions and directions

Every proposal carries a **complete** vector at `metrics.before`, `metrics.after`
and `metrics.delta` (`after − before`, sign preserved). A missing number would hide
a regression, so the vector is complete by construction.

`scale` is the amount of change that counts as one unit of improvement; the
weighted score adds comparable quantities rather than adding grams to pixels.

| id | Direction | Unit | Scale | Default weight | Definition |
|---|---|---|---|---|---|
| `silhouetteFidelity` | higher | IoU 0–1 | 0.05 | 2 | IoU of the model outline against the reference, rasterised from compiled part **bounds** through the booklet camera (`frameScene`/`renderScene`). 1 when no reference was given. |
| `supportMargin` | higher | LDU | 20 | 1 | `analyseStatics().support.marginLdu` — centre of mass to the edge of the support polygon. Negative means it tips. |
| `weakConnections` | lower | parts | 1 | 1.5 | Region parts held by exactly one connection (`findWeakAttachments`). |
| `seamBonding` | higher | fraction | 0.1 | 1 | Share of interior joints that do **not** run through two courses. 1 when there are no interior joints. |
| `symmetryError` | lower | fraction | 0.1 | 1 | Share of the region with no counterpart across its best mirror plane, ignoring the request's exceptions. Unmirrorable parts count as unmatched. |
| `partCount` | lower | parts | 4 | 0.5 | Elements in the region. |
| `distinctElements` | lower | types | 1 | 0.5 | Distinct part designs in the region. |
| `rarityScore` | lower | fraction | 0.05 | 0.5 | Mean `1 − log10(freq+1)/log10(30001)` over the region, from official-set appearance counts. |
| `paletteConformance` | higher | fraction | 0.1 | 0.5 | Share of the region inside the declared/inferred palette **and** observed on that element in a real set. |
| `buildOrderComplexity` | lower | steps + islands | 1 | 0.25 | `computeBuildOrder` steps + 5 per part that begins a new island. |
| `overhangLoad` | lower | grams over capacity | 50 | 1 | Hanging mass beyond assumed clutch capacity, from `computeOverloads`. |
| `steppedEdges` | lower | exposed treads | 1 | 0.5 | Outside faces where a part's top is left uncovered by ≥ 1 stud. |
| `exposedStuds` | lower | studs | 4 | 0.25 | Upward free studs on top of the region — the surface-finish axis. |

The brief specified the first ten. `overhangLoad`, `steppedEdges` and
`exposedStuds` are **additions**, each measured from real kernel output, added
because "strengthen the overhang", "round this off" and "add surface detail" have
no honest target among the first ten. They are flagged here rather than folded
silently into `partCount`.

### There is no cost objective

The compiled catalog carries **no price data of any kind** — `PartDefinition` has
no price field and neither does any payload the compiler emits. `rarityScore`
carries that intent instead, from set-appearance frequency, which *is* measured.
`RegionAnalysis.costBasis` is the literal string `'unavailable-no-price-data'`,
and `analyse.test.ts` asserts no compiled part record has a price-like key.

### Weighting

`resolveWeights` starts from the defaults and clamps every override to
`[0, MAX_WEIGHT = 8]`. The clamp is a safety property, not tidiness: weights can
come from a language model, and an unbounded weight on one objective is
indistinguishable from switching the others off.

---

## 5. Request and proposal

```ts
interface RefinementRequestV1 {
  version: 1
  id: string
  scopePartIds: string[]            // explicit ids, never a spatial query
  protectedPartIds: string[]        // held even inside the scope
  boundaryPartIds: string[]         // seam with the rest of the model
  symmetryExceptionPartIds: string[]
  objectiveWeights: Partial<Record<ObjectiveId, number>>
  baseRevision: number
  instruction: string               // free-form
  referenceSilhouette: SilhouetteV1 | null
  seed: number
  budget: { maxIterations: number; wallClockMs: number }   // default 400 / 2000 ms
  silhouetteToleranceFraction: number                       // default 0.12
  maxProposals: number                                      // default 6
}
```

```ts
interface RefinementProposalV1 {
  version: 1
  id: string                        // content hash of {requestId, strategy, operations}
  requestId: string
  baseRevision: number
  strategy: string                  // 'restack' | 'restack+detail' | 'guard' | ...
  label: string
  operations: RefinementOperation[] // strict subset of CadOperation
  changedPartIds: string[]
  metrics: { before: MetricVector; after: MetricVector; delta: MetricVector }
  score: number                     // weighted improvement; higher is better
  regressions: ObjectiveId[]        // named, never aggregated away
  warnings: string[]
  overlay: OverlayInstruction[]
  provenance: Provenance
  status: 'ranked' | 'rejected'
  rejection: { code: RejectionCode; reason: string; partIds: string[] } | null
}
```

`RefinementOperation` is deliberately narrower than `CadOperation`:
`part.add`, `part.remove`, `part.transform`, `part.recolor`,
`part.assign-subassembly`. Refinement changes bricks. It cannot rename the
document, delete a constraint, unlock a subassembly or rewrite the note thread,
because the parser has no shape for it.

`RejectionCode`: `PROTECTED_PART`, `BOUNDARY_MOVED`, `COLLISION`, `DISCONNECTED`,
`CONSTRAINT_VIOLATION`, `BUILD_ORDER`, `SILHOUETTE_DRIFT`, `NO_IMPROVEMENT`,
`STALE_REVISION`, `EMPTY`.

Rejected proposals are returned **alongside** the ranked ones. "I did not change
the cockpit" and "I could not change the cockpit" are different answers and the
operator asked for one of them.

---

## 6. Guards — what a refinement is not allowed to spend

A search that optimises a weighted score finds whatever the score does not forbid,
so every invariant is enforced structurally rather than priced in.

**Throws** (generator bug):
- `assertScopeIsolation` — every pre-existing part outside `scope` is byte-identical
  afterwards, compared by canonical serialisation so a new `PartInstance` field is
  covered without anyone remembering to extend it. Protected and boundary parts
  inside the scope are held to the same test.

**Verdicts** (legitimate attempt, refused with a reason):
- Additions must connect back to the region (or, when the plan replaced its whole
  scope, to what the scope was attached to before).
- `checkProtection` — protected/locked parts byte-identical, **and** every
  connector mate a boundary part held before is still held. A boundary part can
  sit perfectly still while the thing it was mated to is deleted from under it;
  that severs the seam just as surely as moving it.
- `checkKernelValidity` — differential against the base document: no *new*
  collisions (`findCollisions`), no more components (`connectedComponent`), no
  newly-failing constraint (`evaluateConstraints`), and `verifyBuildOrder` valid.
- `checkSilhouette` — outline drift as a fraction of the reference outline's area,
  against `request.silhouetteToleranceFraction`.

`proposeRefinements` offers nothing that has not passed all of these, and
`applyRefinement` refuses a rejected proposal without reaching the bus.

---

## 7. Search

Deterministic, bounded, interruptible.

- **Stops.** The budget is checked before every evaluation and between every
  generator. On expiry it returns the best found so far and `report.budgetExhausted`
  says which happened. `AbortSignal` is honoured at the same checkpoints.
- **Repeats.** Same `{document, request, seed}` ⇒ identical ranked proposal ids and
  operations. Generators are pure, the order is the registry's, ties break on
  content hashes, and every generated part id is a content hash
  (`ref_<hash>_<hash>`). There is no `Math.random` and no `crypto.randomUUID`
  below `search.ts` — a UUID would make two identical plans compare unequal.
- **Composes.** A second pass runs the other generators against the leading
  candidates, with the scope extended by exactly what the leader created. Depth
  stops at two: a third pass multiplies the branch factor for changes an operator
  can no longer read as one edit.
- **Diversifies.** The shortlist takes one slot per generator first, then score
  order. A straight top-six returned six variants of the same re-lay and silently
  dropped the element swap the request was actually about.

`SearchReport` carries `evaluated`, `generated`, `elapsedMs`, `aborted`,
`budgetExhausted`, `strategiesRun`, `strategiesSkipped`, `baseMetrics`, `weights`,
`reference`.

---

## 8. Worker

`worker.ts` is the protocol and the client; `worker.entry.ts` is the module a
`new Worker(new URL('./worker.entry.ts', import.meta.url), { type: 'module' })`
points at.

- The worker **loads its own catalog** via `loadCompiledCatalog(catalogBaseUrl)` —
  a worker starts with an empty module registry, so the main thread's installed
  catalog is not there. Only the document, the request and the answer cross
  `postMessage`, all structured-cloneable (asserted).
- Cancellation is real: each job holds an `AbortController` the search polls, and
  the handler yields once before starting so a cancel posted in the same tick can
  land.
- Where `Worker` does not exist (jsdom under Vitest, any Node consumer) the client
  runs the identical `runRefinement` inline and reports `ranOn: 'inline'`. It never
  claims a background thread it did not get.

Messages: `{kind:'search'|'cancel'}` in; `{kind:'result'|'error'|'cancelled'}` out.

---

## 9. Optional model assistance

A `ModelProvider` may propose **goals** (objective weights, which generators to
try) or **rank** already-guarded alternatives. It can never waive collision,
connectivity, protection or a hard constraint — enforced structurally:

- A goal is a weight vector over a fixed enum plus a subset of a fixed generator
  registry. `sanitizeGoal` drops unknown objective ids, unknown generator ids,
  non-finite weights and every extra key, and clamps to `[0, 8]`. **There is no
  representable value that would waive a check.**
- A ranking is a *permutation*. Returned ids are matched by identity against
  already-guarded proposals; invented ids resolve to nothing, omitted proposals are
  appended rather than deleted, and a rejected proposal cannot be promoted into the
  ranked positions.

`llm.test.ts` runs a hostile provider — `{waiveCollision: true, skipGuards: [...],
allowProtectedEdits: true, weights: {seamBonding: 1e9, __not_an_objective__: 99},
strategies: ['__delete_everything__']}` — and asserts every returned proposal still
passes triangle-collision, build-order and connectivity checks.

With no provider configured the deterministic reading of the instruction is the
default path, not a degraded one: a small inspectable cue table plus weights
implied by what the region measurably has wrong with it.

---

## 10. Fixtures and measured improvements

`src/refinement/__fixtures__/` builds **20** documents programmatically from the
real compiled catalog. Every one loads, validates healthy, has zero collisions,
zero virtual colours, exactly one connected component and a verified build order
(asserted per fixture).

Each names a `targetObjective` — the claim that its defect is measurable and the
engine measurably reduces it. Numbers below are the actual test output
(`npx vitest run src/refinement/fixtures.test.ts --reporter=verbose`), seed 7.

| Fixture | Class | Instruction | Target objective | Before → after | Won by |
|---|---|---|---|---|---|
| `seam-wall` | aesthetic | remove stacked seams from this wall | seamBonding ↑ | 0.333 → **1.000** | restack |
| `seam-tower` | aesthetic | the courses are not bonded — stagger them | seamBonding ↑ | 0.333 → **1.000** | restack |
| `tipping-mast` | structural | this mast feels flimsy — bond the courses | seamBonding ↑ | 0.250 → **1.000** | restack |
| `micro-run-deck` | aesthetic | simplify this — fewer pieces | partCount ↓ | 8 → **2** | simplify |
| `micro-run-plates` | aesthetic | consolidate these plates | partCount ↓ | 8 → **2** | simplify |
| `stepped-shelf` | silhouette | round these edges off — make it cleaner | steppedEdges ↓ | 2 → **0** | detail |
| `roof-steps` | silhouette | make the roof lower and cleaner | steppedEdges ↓ | 8 → **0** | detail + simplify |
| `nose-round` | silhouette | round this nose without changing the wheelbase | steppedEdges ↓ | 2 → **0** | detail + simplify |
| `rare-hull` | rarity | reduce rare pieces — I want to source this | rarityScore ↓ | 0.142 → **0.052** | substitute |
| `variety-sprawl` | rarity | use fewer different elements here | distinctElements ↓ | 3 → **2** | substitute |
| `palette-noise` | palette | fix the colour on this panel | paletteConformance ↑ | 0.909 → **1.000** | restack + simplify |
| `symmetric-antenna` | structural | make this symmetric except for the antenna | symmetryError ↓ | 0.250 → **0.000** | symmetrize + detail |
| `weak-antenna` | structural | these will fall off — tie them in | weakConnections ↓ | 4 → **2** | reinforce |
| `overhang-shelf` | structural | strengthen the overhang | weakConnections ↓ | 2 → **0** | detail |
| `floating-ledge` | structural | the corner plates are loose | weakConnections ↓ | 3 → **2** | reinforce |
| `tile-recess` | silhouette | add surface detail while preserving the silhouette | exposedStuds ↓ | 8 → **0** | detail |
| `mechanism-hinge-deck` | mechanism | tile the deck but do not touch the hatch | exposedStuds ↓ | 14 → **0** | detail |
| `mechanism-hinge-wall` | mechanism | stagger the courses, leave the hatch alone | seamBonding ↑ | 0.500 → **1.000** | restack + detail |
| `locked-cockpit` | protection | clean up this section | seamBonding ↑ | 0.500 → **1.000** | restack |
| `protected-cap` | protection | clean up these edges | steppedEdges ↓ | 2 → **0** | detail |

Classes covered: structural, aesthetic, palette, rarity, silhouette, mechanism,
protection. Whole suite: 20 fixtures, 3–54 candidates scored each, 7–1200 ms per
fixture.

### Metric-vector honesty, measured

The `tile-recess` surface-finish proposal, printed by `search.test.ts`:

```
[metric honesty] detail: weakConnections 0.000→2.000, partCount 1.000→3.000,
  distinctElements 1.000→2.000, rarityScore 0.180→0.135, exposedStuds 8.000→0.000;
  regressions: weakConnections, partCount, distinctElements
```

It removes every bare stud and pays for it in three other objectives. All five
moved numbers are in the returned vector, all three regressions are named in
`proposal.regressions`, and the test asserts the sign of each against its declared
direction. Nothing is hidden behind the aggregate score.

---

## 11. Test coverage of the acceptance gates

`npx vitest run src/refinement` — **8 files, 242 tests, 0 failures.**

| Gate | Where | What it asserts |
|---|---|---|
| 1. ≥ 15 fixtures, all valid | `fixtures.test.ts` | 20 fixtures; each loads, validates, zero collisions, zero virtual colours, one component, verified build order. All seven classes present, ids unique. |
| 2. ≥ 1 ranked proposal, target improves | `fixtures.test.ts` | Per fixture: ranked ≥ 1, best gain > 0 in the declared direction, `delta` equals `after − before`. Prints before/after. |
| 3. **Scope isolation** | `fixtures.test.ts`, `guards.test.ts`, `strategies.test.ts` | Every part outside `scope`, for **every proposal of every fixture**, `stableStringify`-identical before and after; plus no pre-existing changed part outside the scope. Also asserted for every raw generator batch, and the deliberate violations throw `ScopeViolationError`. |
| 4. Protection | `guards.test.ts` | Moving a `protected` part refuses with `PROTECTED_PART` naming it; deleting a boundary part's *mate* refuses with `BOUNDARY_MOVED` naming the boundary part; the locked-assembly selection returns a rejected proposal whose reason names the locked parts, while the rest of the region is still refined. |
| 5. Kernel validity | `fixtures.test.ts` | Per ranked proposal: zero triangle-confirmed collisions and no increase in total, no increase in component count, additions reachable from the scope, no newly-failing constraint, `verifyBuildOrder` valid. |
| 6. Rejection ⇒ no transaction | `pipeline.test.ts` | Applying a rejected proposal returns `INVALID_OPERATION`; `cadEngine` revision and transaction count unchanged. |
| 7. Stale revision | `pipeline.test.ts` | An interleaved edit advances the engine; the proposal then fails with the kernel's `STALE_DOCUMENT`, parts byte-identical, transaction count unchanged. |
| 8. Bounded budget | `search.test.ts` | 50 ms budget ⇒ `budgetExhausted`, fewer evaluations than a generous run, returns in < 5 s; exact iteration ceiling with an injected clock; pre-aborted signal settles in < 1 s with `aborted: true` and 0 evaluations. |
| 9. Determinism | `search.test.ts` | Same document/request/seed ⇒ identical proposal ids, operations, metrics and full `stableStringify`. `candidateId` reproduces each id; ids are not UUIDs. Generators re-run identically per fixture. |
| 10. Metric honesty | `search.test.ts` | A proposal that improves one objective and regresses three reports all four; every regression visible in `delta` with the correct sign; complete vector on every proposal. |

Additional: `analyse.test.ts` (28) covers located/typed issues per fixture class,
the specific defect being found where it was built, the no-price-data fact,
mirroring refusing off-lattice orientations, and silhouette IoU edge cases.
`worker.test.ts` (7) covers the protocol, cancellation, structured-cloneability
and the inline fallback. `llm.test.ts` (20) covers cue reading, sanitation and the
hostile provider. `strategies.test.ts` (51) covers generator purity, determinism,
vocabulary and content-derived ids.

---

## 12. What I could not prove

Stated rather than papered over.

1. **`supportMargin` is measured but no generator targets it.** Tipping is fixed by
   widening the footprint or moving mass, and none of the seven generators does
   either. It is reported on every proposal (and never silently regressed — that
   would show as a named regression), but no fixture claims an improvement in it.
   A `widen-base` or `ballast` generator is the honest follow-up.

2. **`overhangLoad` is measured but never triggered by a fixture.** The kernel's
   clutch assumption is 100 gf per stud (`DEFAULT_CLUTCH_GRAMS`), so an overload
   needs more than ~100 g of genuinely *hanging* mass on one stud — around 19
   stacked 4 × 8 plates. Every fixture at that size stopped being reviewable by
   hand, which is the property the fixtures exist for. The reasoning that
   `reinforce` would clear such an overload (a second spacer doubles the assumed
   capacity) is argued, not demonstrated. "Strengthen the overhang" is covered
   operationally by `weakConnections` on `overhang-shelf`.

3. **The silhouette is a box hull, not a mesh.** Compiled meshes stream per part and
   are not resident during analysis; measured bounds always are. So the outline is
   exact for a brick and generous for a wheel, a slope or a windscreen. The bias is
   one-directional: a drift it *reports* is real; a small drift it fails to report
   may not be. Both directions are stated in `silhouette.ts` rather than tuned away.

4. **Collision certainty in the test environment is `unknown`, not triangle-exact.**
   `residentGeometryProvider` returns null without streamed meshes, so
   `findCollisions` decides on bounding boxes. The suite asserts *zero
   triangle-confirmed* collisions and no increase in the total — which is what can
   be asserted without a geometry pack. In the browser, with meshes resident, the
   same guard runs triangle-exact.

5. **`smooth` is out-ranked by `detail` on the stepped-edge fixtures.** Both close
   a stepped edge and both are offered; a tile on the tread scores higher than a
   slope substitution because it costs less silhouette drift. The slope proposals
   are present in the ranked list (`strategiesRun` includes `smooth`), but the
   table above records what actually won.

6. **`steppedEdges` treats "closed" as a category test.** A 45° slope's bounding box
   still covers the full footprint, so no box-level measurement can distinguish it
   from the brick it replaced. A step therefore counts as closed when the part
   providing the tread is in an LDraw `Sloped`/`Curved` category. That matches how
   builders talk about it, and it is a category lookup, not a measurement.

7. **The real `Worker` path is not exercised by the suite.** jsdom implements no
   `Worker`, so the tests drive `handleRefinementWorkerMessage` directly (which is
   the worker's entire body) and the inline fallback. Spawning an actual module
   worker, and the catalog fetch inside it, are only exercised in a browser.

8. **Composition depth is 2.** Requests needing three coordinated moves are not
   reachable in one proposal. This is a deliberate bound, not an oversight — but it
   is a bound.
