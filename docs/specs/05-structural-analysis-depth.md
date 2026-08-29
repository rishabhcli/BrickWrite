# Spec 05 — Cantilever moment analysis (and why per-family clutch is not a physics feature)

**Status:** proposed, **with one half recommended against**
**Touches:** `src/cad/statics.ts`, `src/cad/statics.test.ts`, and five downstream consumers
**Depends on:** nothing

---

## 1. What was asked, and what the evidence supports

The improvement as originally framed had two halves:

1. Scale clutch capacity per connector family (a stud, a pin, a clip and a ball hold differently)
2. Add a cantilever/moment check (a light part far out stresses its anchor more than the same mass close in)

**Half 2 is well-founded and should be built.** Every input already exists in
memory at the exact line where it is needed, and the physics is a lever arm, not
a fudge factor.

**Half 1 is not, and this spec recommends against shipping it as a physics
claim.** Research for published per-family measurements found:

| family | public quantitative figure | best source | confidence |
|---|---|---|---|
| stud / anti-stud | yes, conflicting | Liu et al., *StableLego*, arXiv:2402.10711 — **0.98 N** per contact, self-measured | low–medium |
| Technic pin | **none absolute** | ramblingbrick.com lever test — *relative* only (p = 0.0302 between two pin generations) | none |
| axle | **none** | qualitative only (keyed sliding fit, centre stop) | none |
| bar / clip | **none** | none found | none |
| ball / socket | **none** | generic non-LEGO patents only | none |

Two things follow.

**The one real measurement confirms the number already in the code.** 0.98 N is
exactly 100 gf. `statics.ts:50-58` already says:

> Independent measurements of LEGO clutch power cluster around 1–2 N for a single
> stud in good condition. 100 gf (≈ 0.98 N) is the conservative end of that range.
> It is an assumption, it is reported as one, and it is the only number in this
> module that is not measured.

An independent robotics group solving the same block-stacking problem measured
the same value. That is corroboration, not new information.

**A per-family table would be four invented numbers wearing a lab coat.** This
module's whole character is that it separates measured from assumed —
`volumeLdu3` comes from the divergence theorem over a closed mesh; unmeasurable
parts are "reported as unmeasured rather than estimated." Adding
`pin: 140, clip: 60, ball: 80` with no source would put fabricated precision
inside the one module that has been scrupulous about not doing that.

There is a further problem. The one comparative study found Technic pin retention
differs *significantly between part generations of the same pin* — so a
family-wide "pin" constant is a **coarser** approximation than the existing
single stud constant, not a finer one.

### What to do with half 1 instead

Three honest options, in order of preference:

1. **Don't.** Keep the single assumption. It is corroborated for the family that
   dominates real models.
2. **Ship relative multipliers, labelled as ordinal, not measured** — e.g. "a
   clip grips less than a stud" — with `assumptions` carrying per-family
   provenance strings and the UI never printing a Newton figure per family.
3. **Measure it.** A jig and a force gauge across five families would be a
   genuine contribution; nobody appears to have published one.

The rest of this spec builds half 2.

---

## 2. Current state

### `computeOverloads` (`statics.ts:231-355`)

```ts
const derived = deriveConnections(document)
const neighbours = new Map<string, Map<string, number>>()
for (const pair of derived.pairs) {
  const a = neighbours.get(pair.a.partId)
  if (a) a.set(pair.b.partId, (a.get(pair.b.partId) ?? 0) + 1)
  …
}
…
const grams = cluster.reduce((sum, id) => sum + (partMassGrams(document.parts[id]) ?? 0), 0)
const capacity = studs * clutchGrams
if (grams > capacity) { … }
```

**Everything needed is present and thrown away at one line.** `derived.pairs` is
`MatedPair[]`, each carrying two `WorldConnector`s with:

- `frame.position` — the connector's exact **document-space** `Vec3`
- `family` — the connector family
- `feature.axial` — the axial extent, where declared

The reduction into `Map<string, Map<string, number>>` keeps only an integer count.
By the time `studs` is summed, a stud, a pin and a ball joint are each worth
exactly 1, and every position is gone.

**Consequence:** a 50 g part 4 LDU from its anchor and the same part 400 LDU out
on a beam produce byte-identical output.

### What already exists that a moment check can reuse

| Primitive | Where | Note |
|---|---|---|
| Measured mass per part | `partMassGrams`, `:109` | exact volume × density, never estimated |
| Cluster centroid math | `partCentre` / `computeMass`, `:120-150` | exists, but never called restricted to a hanging cluster |
| Ground-up "carried" BFS | `:275-301` | already separates compression from tension |
| Anchor set per cluster | `:311-333` | already computed |
| Distance-to-segment | `distanceToSegment`, `:192` | already in this file for the support polygon |

> **Terminology trap.** `moment` at `:130-148` is Σmᵢ·xᵢ divided by total mass —
> a *first moment of mass*, i.e. a centre of mass. It is not a bending moment and
> has no torque semantics. Do not reuse the name.

---

## 3. Design

Insert immediately after `if (!studs) continue` (`statics.ts:335`), where
`cluster`, `anchors` and `grams` are all already in scope.

```ts
/** Where a hanging cluster's weight acts, and where it is held. */
const loadCentre = centroidOf(cluster, document)          // partCentre, restricted
const anchorPoints = derived.pairs
  .filter(p => bridges(p, cluster, anchors))
  .map(p => p.a.frame.position)                            // document space, already computed

/**
 * The horizontal throw from the anchors to the load.
 *
 * Gravity acts on -Y (LDraw's Y is down), so only the XZ displacement produces
 * a bending moment about the attachment. A load directly beneath its anchor has
 * a zero arm no matter how heavy it is — which is correct: that is tension, and
 * the existing force check already covers it.
 */
const armLdu = horizontalDistance(loadCentre, centroidOf(anchorPoints))
const momentGramLdu = grams * armLdu
```

### The capacity side

A moment capacity needs a **resisting arm** — how far apart the anchoring
connectors are. Two anchors 40 LDU apart resist rotation far better than two
1 LDU apart, at identical force capacity.

```ts
const spanLdu = maxPairwiseDistance(anchorPoints)   // 0 for a single anchor
const momentCapacity = studs * clutchGrams * Math.max(spanLdu, MIN_RESISTING_ARM_LDU) / 2
```

`MIN_RESISTING_ARM_LDU` acknowledges that even a single stud resists some
rotation through its own diameter (a stud is 12 LDU across). **This constant is an
assumption and must be reported as one**, alongside `clutchGramsPerStud`.

### Report shape

Additive. Do not replace the existing force check — a cantilever can fail in
tension *or* rotation, and they are different diagnoses.

```ts
export interface OverhangIssue {
  readonly partIds: string[]
  readonly grams: number
  readonly studs: number
  readonly capacityGrams: number
  readonly severity: 'over-capacity' | 'marginal'
  readonly message: string
  /** Present only when the cluster's weight acts away from its anchors. */
  readonly leverage?: {
    readonly armLdu: number
    readonly spanLdu: number
    readonly momentGramLdu: number
    readonly capacityGramLdu: number
    readonly severity: 'over-capacity' | 'marginal'
  }
}
```

Message, when leverage dominates:

> 3 parts weighing 48 g hang 96 LDU out from 4 studs spanning 20 LDU. The weight
> is within what those studs can hold, but the leverage is not — bring the load
> back over a support, or widen the attachment.

That distinction is the point of the feature: **the current report tells someone
their cantilever is fine right up until it twists off.**

---

## 4. Blast radius

`StaticsReport` is read by field name in five places. All must move together:

| File | Reads | Effect |
|---|---|---|
| `src/webmcp/adapter.ts:384-405` | pipes `report.assumptions` verbatim to the agent; takes `{ clutchGramsPerStud? }` | agent gains leverage data for free; **cannot express a per-family override** — another argument against half 1 |
| `src/editor/workbench/InspectorPanel.tsx:37-42, :396` | hardcodes an `EMPTY_STATICS` placeholder; renders `${n} over ${assumptions.clutchGramsPerStud} g/stud` | needs a leverage row |
| `src/refinement/analyse.ts:232-244` | `overhang.grams - overhang.capacityGrams` as a penalty | should incorporate leverage or explicitly not |
| `src/refinement/objectives.ts:225-236` | same, in the `overhangLoad` objective | same |
| `src/generation/score.ts:137-170` | `overloaded.length` as `overloadedJointCount` | count changes if leverage adds issues |

Keeping `leverage` optional means all five keep compiling; each can adopt it
deliberately.

---

## 5. A data gap worth knowing about (but not blocking on)

`ConnectionFeature.axial` is populated on **59 of 10,402 connectors (0.57%)**,
and **every one is a clip**. Zero pins, zero axles, zero bars, zero studs, zero
balls.

The cause is recoverable. `tools/catalog-compiler.mjs` already parses LDCad's
`secs` descriptor into `{shape, radius, length}` triples — a 3673 pin's shaft
reads `R 6 16`, a 3705 axle reads `A 6 80` — but `classify()` inspects only
`section.shape` to choose a family and **discards the lengths**. `axialRange`
(`:329`) is populated only from a literal `[length=…]` attribute, present on just
2.3% of snap lines. `trimConnector` (`:621`) then ships `axial` only from
`axialRange`; the parsed `profile` string never leaves the compiler.

This does **not** block the moment check, which needs positions (100% coverage),
not insertion depths. It is recorded here because any future work on insertion
depth — including `07-cad-capability.md` finding 10 on collision clearance —
starts by wiring `parseSections`' existing output through to `trimConnector`.

---

## 6. Tests

**`computeOverloads` has no direct unit tests.** It appears zero times in
`statics.test.ts`'s imports; all coverage is indirect through
`analyseStatics(...).overloaded`. **Add direct tests before changing it.**

Every existing capacity fixture uses `definitionId: '3001'`, whose 16 connectors
are exclusively stud/anti-stud. **No test anywhere exercises a pin, axle, bar,
clip, hinge or ball** — a second, independent reason half 1 would ship untested.

### New

- `a load directly beneath its anchor has no leverage` — arm ≈ 0, no `leverage` field
- `the same mass further out reports a larger moment` — the core property, two fixtures identical but for X offset
- `widening the anchor span raises the moment capacity` — same load, anchors 4 LDU vs 40 LDU apart
- `a cluster within force capacity but over moment capacity is reported as leverage` — the case that motivates the feature
- `a single anchor uses the minimum resisting arm` — assumption is applied, not divided by zero
- `leverage is absent on pure compression` — a stack reports nothing

### Existing that must be preserved

- `statics.test.ts:165-169` asserts `assumptions.clutchGramsPerStud === 250` — a **shape** assertion. It survives adding fields; it breaks if the scalar is replaced by a map. Another cost of half 1.
- `:171-176` asserts monotonicity: stricter assumption ⇒ same or more overloads. The leverage check must preserve this.
- The tipping fixture at `:110-121` is a genuine cantilever but exercises `computeSupport` (global tip-over), not `computeOverloads`. It should stay untouched — and it is worth noting that today **the only cantilever in the test suite is tested for tipping and not for the connector load it hangs from.**

---

## 7. Work breakdown

1. **Direct unit tests for `computeOverloads` as it stands.** It has none, and it is about to change.
2. Add `centroidOf(partIds)` and `horizontalDistance` helpers — both trivial over existing `partCentre`.
3. Thread `derived.pairs` into the cluster loop so positions and families survive the `neighbours` reduction.
4. Compute `armLdu`, `spanLdu`, `momentGramLdu`; add the optional `leverage` field.
5. Report `minResistingArmLdu` in `assumptions`, with the same "this is an assumption" language the clutch constant uses.
6. Adopt `leverage` in `InspectorPanel`, then in the refinement objectives, deliberately and separately.
7. **Do not build the per-family table.** If it is wanted anyway, ship it as ordinal multipliers with per-family provenance strings, never as Newton figures.

---

## 8. Open questions

1. Is `MIN_RESISTING_ARM_LDU` better expressed as a stud diameter (12 LDU) or measured from connector geometry?
2. Should `leverage` feed the refinement optimiser's penalty immediately, or be observed first?
3. Should a leverage failure be its own severity tier rather than reusing `over-capacity`/`marginal`?
4. Is anyone willing to measure the four unmeasured families? It would be a real contribution, and it is the only thing that would make half 1 honest.
