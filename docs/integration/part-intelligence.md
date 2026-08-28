# Workstream 1 - Part intelligence

Free-form language in, explained catalog identities out. A builder or an agent
asks for "a transparent windscreen about six studs wide" or "the mirrored
counterpart of wedge 41747" and gets ranked identities, a calibrated
confidence, a one-line reason, and an explicit list of the conditions the
answer does *not* meet.

Owned paths: `src/intelligence/**`, `tools/semantic-index.mjs`, this file.
Published entry point: `src/intelligence/index.ts`.

---

## 1. Shape of the thing

Four retrieval stages feed one scorer. Nothing here replaces
`CatalogRegistry.search` - that is still the right tool for a facet-filtered
browse - this is the layer that answers a sentence.

```
parseQuery              structured intent: sizes, colours, connector families,
  (query.ts)            axis direction, relation, availability, unmatched terms
       |
       +--> exact identifiers  ---+
       +--> derived relations  ---+
       +--> BM25F over names   ---+---> rankCandidate ---> explainMatch
       +--> footprint index    ---+      (rank.ts)         (explain.ts)
       +--> latent similarity  ---+           |
            (semantic.ts)                     v
                                       PartIntentResult
```

Two rules run through all of it.

**Nothing disappears.** Every word is consumed into a slot, recognised as a
stop word, known to the catalog's vocabulary, or reported in
`interpretation.unmatchedTerms`. A stated constraint that no returned match
satisfies is reported there too, per constraint: "a 64 stud long 1 x 1 round
brick" answers with the 1 x 1 round brick and names `64 studs` as unmet, rather
than blending the two into one verdict and losing the impossible half.

**Nothing is promised that cannot be delivered.** `tier` and `placeable` are
read off `geometryStatus`, never asserted. A `modelled` identity comes back
findable and not placeable; a `catalogued` identity comes back with the
explanation "catalogued only: the wider LEGO catalogue records it and nothing
else is known". No procedural stand-in geometry exists anywhere in this
workstream.

## 2. Public exports - `src/intelligence/index.ts`

| Group | Exports |
|---|---|
| Resolver | `resolvePartIntent`, `resolvePartIntentSync`, `warmPartIntelligence`, `residentPartIntelligence`, `resetPartIntelligence`, types `PartIntelligence`, `ResolveOptions` |
| Query parsing | `parseQuery`, types `PartQuery`, `QueryContext`, `RelationIntent` |
| Corpus | `loadPartCorpus`, `CorpusUnavailableError`, types `CorpusDocument`, `CorpusLoadOptions`, `PartCorpus` |
| Semantic index | `loadSemanticIndex`, `residentSemanticIndex`, `residentSemanticManifest`, `resetSemanticIndex`, `SemanticIndexError`, types `SemanticIndexManifest`, `SemanticLoadOptions` |
| Relations | `RelationIndex`, `connectorSimilarity`, types `BridgeCandidate`, `InterfaceMatch`, `MirrorRelation` |
| Lexical | `LexicalIndex`, type `IdentityKind` |
| Ranking | `calibrateConfidence`, types `RankedCandidate`, `SignalDetail` |
| Geometry assets | `GeometryAssetProvider`, `catalogGeometryDescriptors`, types `GeometryAssetProviderOptions`, `GeometryAssetResult`, `GeometryDescriptor`, `GeometryDescriptorSource`, `GeometryUnavailableCause` |

`resolvePartIntent(query, options?)` returns the `PartIntentResult` declared in
`src/platform/contracts.ts`, unchanged. `resolvePartIntentSync` answers from
whatever is already resident; with nothing resident it falls back to the
registry's own ranked search for candidates, scores them through the same
fusion, and says so in the explanation ("semantic index not resident, so this
is a lexical match only").

Typical use:

```ts
import { resolvePartIntent, warmPartIntelligence } from '../intelligence'

await warmPartIntelligence()                       // symbolic indexes only
const result = await resolvePartIntent('clip that holds a bar', { limit: 5 })
for (const match of result.matches) {
  if (!match.placeable) continue                   // never place a modelled id
  console.log(match.canonicalId, match.confidence, match.explanation)
}
console.log(result.interpretation.unmatchedTerms)  // what it could not meet
```

Options worth knowing: `semantic: false` answers without touching the latent
index (a cold first keystroke); `includeCatalogued: true` folds in the 58,833
catalogue-only identities behind their own lazy 7 MB fetch; `tier` restricts
results to one knowledge tier; `signal` cancels the underlying fetches.

## 3. Signals and weights

Weights live as named constants in `src/intelligence/parts/rank.ts`, each with
a comment stating what evidence it pays for.

| Signal | Weight | What it is |
|---|---|---|
| `exactId` | 6.0 | Canonical, LDraw, retired, Rebrickable, design, element or BrickLink number. Not evidence - an answer. |
| `relation` | 3.4 | Derived mirror / interface / variant / bridging relationship, scaled by the strength of the derivation. |
| `lexical` | 2.2 | BM25F over name (3.0), identifiers (2.5), category (1.2), LDraw kind (0.4), with plural folding and prefix expansion. |
| `dimensional` | 2.2 | Measured envelope, or the size the part name states, per constraint. |
| `semantic` | 1.5 | Cosine in the shipped latent space. Below lexical on purpose: it generalises past vocabulary, so it also generalises past precision. |
| `axis` | 1.2 | Connector axis direction, measured from the compiled LDCad orientation. |
| `connector` | 0.9 | Requested connector families present. |
| `color` | 0.5 | Observed official-set colour evidence. |
| `frequency` | 0.55 | Set-inventory appearances, log-scaled. A prior, not evidence about the request. |
| `placeable` | 0.25 | Tiebreaker towards what this build can actually place. |

Penalties: `wrongSize` 1.6 (charged per unmet size constraint), `unknownTerm`
1.6 (per share of the request this build has never indexed), `decoration` 1.4
(LDraw carries roughly ten printed variants per popular design, all sharing its
name), `wrongAxis` 1.2, `forbiddenConnector` 1.1, `missingConnector` 0.7,
`wrongColor` 0.5, `helper` 2.5.

Confidence is a fitted logistic over the fused score, not a normalised rank:
`slope 0.6125, intercept -3.1016`, clamped to [0.01, 0.97]. It is fitted by
batch gradient ascent on every ranked candidate of every evaluation query,
labelled by whether that candidate is an acceptable answer.
`src/intelligence/parts/rank.test.ts` refits the same objective from scratch
and fails if the baked constants have drifted, then checks the property that
matters: within each confidence band, roughly that fraction of matches really
are correct.

## 4. The semantic index

A truncated SVD of the catalog's TF-IDF matrix, computed offline and shipped
quantised to int8. There is no model server and no network call at query time.

**Analyzer.** Word unigrams plus in-word character trigrams at weight 0.5,
sublinear term frequency, BM25-form IDF, L2 normalised. Vocabulary is filtered
to document frequency in [3, 50% of the corpus] - 6,088 terms over 22,941
identities. A part's document text is its name, category, connector families
and compiler-emitted tags.

**Decomposition.** Randomized subspace iteration for the leading right-singular
subspace (Gaussian sketch seeded from the catalog identity, 3 power iterations,
24 oversampled dimensions, modified Gram-Schmidt), then a cyclic Jacobi
eigendecomposition of the small Gram matrix rotates that subspace onto the
singular directions. Implemented in plain JS with no dependencies.

**What ships.** The term-side projection `V` (6,088 x 128 int8 with a per-term
float scale) and the document side `X.V` (22,941 x 128 int8, direction only -
row norms are recomputed at load, which is all cosine needs). The query is
folded through the *same* projection in the browser, so query and document live
in one space.

**Cross-language safety.** The builder is `.mjs` and the runtime is TypeScript,
so the analyzer exists twice. The container header carries a hash of a fixed
probe string's feature list; `SemanticIndex.decode` recomputes it and throws
`SemanticIndexError` on disagreement. Analyzer drift is a hard failure, not a
silent ranking regression.

**Determinism.** Seeded sketch, fixed reduction order, canonicalised
singular-vector signs, and `builtAt` records the *catalog's* build stamp rather
than wall-clock time. Two runs over the same input produce byte-identical
`.bin` and `.json`. Asserted by
`src/intelligence/parts/index-builder.test.ts`, which drives the CLI twice and
compares the files.

### Build and regenerate

```bash
# full catalog, writing public/semantic-index.<version>.{bin,json}
node tools/semantic-index.mjs --catalog public --out public

# the small fixture catalog CI can build from scratch
npm run catalog:fixture
node tools/semantic-index.mjs --catalog .catalog-fixture --out .catalog-fixture

# any in-memory payload, e.g. a checked-in test fixture
node tools/semantic-index.mjs --input src/cad/__fixtures__/catalog.fixture.json --out /tmp/idx
```

Flags: `--catalog <dir>` (a directory laid out like `public/`), `--version`
(defaults to the pointer in `catalog/latest.json`), `--input <payload.json>`,
`--out <dir>`, `--dims` (default 128), `--quiet`.

**Regenerate the index whenever the catalog is recompiled.** The runtime looks
for `semantic-index.<catalogVersion>.json` beside `catalog/`, verifies the
binary against the SHA-256 and byte length in that manifest, and fails with the
exact command above when it is absent. A stale index cannot be served silently:
the manifest names the catalog version it was built for and the loader refuses
a mismatch.

## 5. Measured numbers

Measured on the shipped 2026-07 catalog (22,941 modelled identities, 900
compiled meshes, 322 colours, 1,150 renames), Node 26, Apple silicon.

| Measurement | Value |
|---|---|
| Evaluation queries | 129 hand-written (119 answerable, 10 impossible) |
| **Top-5 recall** | **95.0%** (113/119), floor 0.90 |
| ... by class | identifier 12/12, dimension 20/20, shape 25/25, relation 15/15, connector 14/15, color 11/12, function 16/20 |
| **Warm semantic query p95** | **4.6 ms** over 200 queries (p50 3.4 ms, max 12.4 ms), budget 150 ms |
| Cold first query | ~180 ms, dominated by decoding the 4 MB index |
| Confidence calibration | 1,146 samples, expected calibration error 0.0636 |
| Index build time | 2.7 s for 22,941 identities |
| Index size | 3,987,924 bytes (3.99 MB), 128 dims, 6,088 terms |
| Variance retained by the truncation | 94.6% |
| Suite | 88 tests across 10 files |

The p95 is roughly thirty times inside budget because the expensive part is a
single dense scan of a 22,941 x 128 int8 matrix, which is a few milliseconds;
the 150 ms budget was set against a network round trip that no longer happens.

## 6. The evaluation set

`src/intelligence/parts/__fixtures__/evaluation.json` - 129 requests spanning
identifier, dimension, shape, function, colour and finish, connector, derived
relation, and impossible. Acceptable answers were chosen from catalog facts
(LDraw names, measured envelopes, connector multisets, LEGO numbering, LDCad
connector orientations) rather than from resolver output.

The fixture is rebuilt from the catalog by
`node src/intelligence/parts/__fixtures__/build-evaluation.mjs`, which holds the
predicate behind every accept set and fails if any id it names has been renamed
out of the catalog. Read that file to audit the grading, not the JSON.

Recall is measured over the 119 answerable queries. The 10 impossible ones are
scored separately and on a different property: their pass condition is not a
part number but that the top confidence stays below 0.35 *and* the resolver
names the condition it could not meet. Rolling them into the recall denominator
would have capped the metric at 92% by construction and told you nothing about
whether the resolver was honest.

Six functional paraphrases still miss, and they share one shape: the request
and the answer have no vocabulary in common and the association is not
recoverable from part names alone ("something that lets two plates pivot" ->
Hinge Plate; "something to make a smooth finished surface" -> Tile). The latent
space is built from LDraw names, categories and connector families, and LDraw
never writes down what a part is *for*. Closing these needs a functional
vocabulary the catalog does not contain, not a weight change.

## 7. Geometry asset provider

`src/intelligence/assets/geometryProvider.ts` fetches individually
content-addressed meshes for identities outside the bundled pack. Its contract
is mostly about what it refuses to do: SHA-256 and byte length are verified
before anything may be decoded, and a missing, unpublished, corrupt,
unreachable or cancelled asset yields `{ status: 'unavailable', reason, cause }`
with `cause` in `unpublished | offline | network | corrupt | aborted`. No
generated shape is ever substituted.

Behaviour worth knowing: a digest mismatch is retried once with `cache:
'reload'`, because a content-addressed URL serving the wrong bytes is almost
always a poisoned intermediary; a 404 is not retried at all; retries back off
exponentially; concurrent callers share one transfer, reference counted so the
last caller to abort cancels the socket; the LRU is byte-budgeted and an asset
larger than the whole budget is served without being retained; while offline,
resident assets are served and cold ones refused immediately.

This build publishes no index of out-of-pack geometry, so
`catalogGeometryDescriptors` returns `null` for the 22,041 modelled identities
with no compiled mesh and the provider reports `unpublished`. A caller holding
such an index supplies descriptors through `provider.register(id, descriptor)`;
they are verified like any other.

## 8. Dataset attribution

The compiled assets this workstream reads are governed by
`public/catalog/<version>/licenses.json`, emitted by
`tools/catalog-compiler.mjs`. The semantic index is a derived work of all three
and inherits their terms.

- **LDraw Parts Library** - part geometry, part identity, colour definitions.
  Licensed per file; all 22,941 files in this build are CC BY 4.0 (the compiler
  also recognises CC BY 2.0 and CC0 headers). Required attribution: *"This
  software uses the LDraw Parts Library. LEGO is a trademark of the LEGO Group,
  which does not sponsor, endorse or authorize LDraw or Brickwright."*
- **LDCad Shadow Library** - connection and snap metadata, CC BY-SA 4.0.
  Required attribution: *"Connection metadata derived from the LDCad Shadow
  Library by Roland Melkert, licensed CC BY-SA 4.0."* The share-alike obligation
  is flagged `shareAlikeReviewRequired` in `licenses.json` and has not been
  reviewed here.
- **Rebrickable bulk catalog** - part names, categories, colour production
  evidence, usage frequency. Redistribution rights for compiled derivatives are
  unspecified and are flagged `redistributionReviewRequired`. The semantic index
  embeds Rebrickable-sourced names and categories, so it carries the same
  unresolved question and must be reviewed against current Rebrickable terms
  before public deployment.

## 9. What could not be proved here

- **BrickLink numbers never fire in production.** The identifier index resolves
  them and `resolve.test.ts` covers the path, but `tools/catalog-compiler.mjs`
  writes `identity.bricklinkIds: []` unconditionally (line 726), so the register
  is empty in the shipped catalog. The test installs the real BrickLink numbers
  for two parts to exercise the code. Until the compiler populates the field,
  this capability is untested against production data.
- **`identity.baseRebrickableId` is null for every pack part**, so the
  printed-variant relation runs entirely on the LDraw decoration-suffix
  convention (`3069bp73` decorates `3069b`) and on `variantOf` from the
  catalogued tier. Both are real and tested; the Rebrickable-sourced path is
  not exercised because the data is absent.
- **Semantic coverage stops at the modelled tier.** The index holds the 22,941
  identities LDraw models. Adding the 58,833 catalogue-only identities would
  take the artefact past 10 MB, so those are reached lexically and symbolically
  only. A catalogued identity therefore never receives a `semantic` signal.
- **Connector-axis questions only work for the compiled pack.** Orientation
  comes from LDCad matrices, which exist for 900 of 22,941 identities. Outside
  the pack the signal reports itself untestable rather than guessing.
- **Colour evidence covers 900 parts.** For everything else `colorSignal` is
  `testable: false`, and the explanation says "no colour evidence in this build,
  so a transparent finish is unverified" rather than implying a check happened.
- **Determinism is proved on one platform.** The rebuild is byte-identical on
  Node 26 / arm64 macOS. The float64 reductions are order-fixed and the sketch
  is seeded, so it should hold across platforms, but that has not been run on a
  second architecture.
- **The p95 is a Node/jsdom measurement**, not a browser one. The hot loop is
  plain typed-array arithmetic with no DOM involvement, so the browser number
  should be close, but it has not been measured under a real engine.
