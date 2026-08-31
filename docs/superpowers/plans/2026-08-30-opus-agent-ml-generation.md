# Agent-native ML generation (stop brick-by-brick)

> **Assigned agent:** Claude Opus 5
> **Sibling plans (run in parallel, do not execute them):**
> - GPT 5.6 Sol (1) — [`2026-08-30-sol1-cad-fluidity-mechanisms.md`](./2026-08-30-sol1-cad-fluidity-mechanisms.md)
> - GPT 5.6 Sol (2) — [`2026-08-30-sol2-liquid-glass-showcases.md`](./2026-08-30-sol2-liquid-glass-showcases.md)
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a builder (or an attached agent) says “build a tower / freighter / clock palace,” Brickwright runs the generation pipeline — brief → massing → bonded assembly → kernel-verified candidate — as one reviewable wave, instead of placing 2×4s one at a time through `preflight_placement`.

**Architecture:** The in-editor Design Partner (`POST /api/assistant` + `ASSISTANT_TOOLS`) currently cannot see the generation surface. Generation already exists as a four-phase kernel-backed pipeline and as WebMCP tools (`generation_compile` / `generation_run` / `generation_preview` / `generation_apply`), but the chat agent is steered toward single-part placement and bulk walls. This plan welds those two surfaces together, teaches the model when to generate vs. when to place, and extends massing so vehicles, mechanisms, and landmarks are not forced into three axis-aligned building boxes.

**Tech Stack:** Existing TypeScript — `src/agent`, `src/generation`, `server/assistant`, `server/generation`, `src/intelligence`, `src/refinement` (strategies only), Zod, Vitest. No new native ML runtime in the browser. Optional later: BrickGPT-style validity-rollback as a *pattern*, not a dependency on Llama-3.2-1B.

**Spec:** This document. Sibling plans own CAD interaction and chrome/demos. Read both before editing any file on a shared-contract list.

## Global Constraints

- Dirty tree is fine; do not commit or push unless the operator asks.
- Hexclave stays off this workstream. Do not touch `hexclave.config.ts`, `src/platform/auth/**`, or landing CTAs.
- The kernel remains the only writer. Generation still produces `CadOperation[]`; `commandBus` still checks revision, collisions, clutch, constraints.
- Do not invent XYZ. Graphs stay connector-relative. Massing boxes / hull regions are intents; the realiser still snaps.
- Do not copy official LEGO set inventories or Star Wars / LEGO City IP into prompts, fixtures, or golden briefs. Original subjects only (“saucer freighter”, “harbour control tower”, “lattice observation tower”, “west-end clock palace”).
- Do not edit CSS. Do not restyle docks, buttons, or the workbench chrome. Sol (2) owns appearance.
- Do not rewrite camera, gizmos, `CadViewport.tsx`, or `src/editor/render/**`. Sol (1) owns those.
- Additive-only on `src/cad/capabilities.ts` and `src/cad/assembly.ts` (see Shared contracts).
- Undo/redo stay on `replay`. Bulk generation is one transaction (or a named sequence of waves), never a hidden stream of un-undoable adds.
- User instructions override skill approval gates for this turn.

---

## Why this workstream exists (pain, measured)

The operator’s pain: the app is not smart enough for an agent to *use the ML / generation flow* to build. Agents grind through single bricks.

That is not a missing kernel. The kernel already has:

| Layer | What it already does | Why the agent still brick-lays |
|---|---|---|
| `src/cad/assembly.ts` | `planWall`, `planEnclosure`, `planBrickField`, `planHingedFlap` — hundreds of bonded parts per instruction | The Design Partner is not *forced* onto these; `preflight_placement` is the easy, always-visible tool |
| `src/cad/capabilities.ts` | `build_wall`, `build_enclosure`, `build_field`, `build_structure`, `build_hinged_flap`, `stamp_module`, `stack_selection`, `linear_array` | `capability_search` is opt-in. Guidance for a non-empty document often returns `preflight_placement` |
| `src/generation/**` | Brief compiler, build graph, snap realiser, four-phase pipeline, 26-axis scorer | **Not in `ASSISTANT_TOOLS`.** Only WebMCP (`src/webmcp/surfaces/generation.ts`) exposes it |
| `server/assistant/prompt.ts` | “If empty, `build_field` / `build_structure`, not `preflight_placement`” | Empty-doc path is parametric walls, not “compile this sentence into a candidate.” Non-empty path is still one brick on one face |
| `src/agent/guidance.ts` | Kernel-authored next tool after a refusal | After success, next step is another placement. There is no “you asked for a building — run generation” branch |
| Tool-turn budget | 8 tool turns, 16 calls/turn (`server/assistant/protocol.ts`) | A 200-part model at 1 part/wave is structurally impossible inside one conversation |

The generation pipeline’s own docs admit the intelligence gap: **massing is the only phase that consults a model.** Skeleton, packing, and detail are deterministic. Detail **hard-codes** `tile 1 x 2 with groove` for every subject (`docs/integration/generation.md`, `src/generation/phases.ts` `detailDelta`). A castle and a spaceship get the same greeble.

Default footprints (`phases.ts` `DEFAULT_FOOTPRINT`) are toy-scale: vehicle `14×8×8` studs, building `16×14×12`. `DEFAULT_PART_BUDGET` is **420**. `MAX_GENERATED_PARTS` is **4000** per command (`src/cad/assembly.ts`). Harbour Street (3,041), Meridian Tower (4,767) and Illinois Main Quad (11,473) exist as *authored demos*, not as something `/api/generate` can emit from a sentence.

Two agent channels, unjoined:

```
Design Partner (this workstream)          WebMCP (already exists)
─────────────────────────────────          ──────────────────────
scene_overview                             generation_compile
scene_query                                generation_compile_local
selection_geometry                         generation_set
catalog_search                             generation_run
capability_search                          generation_state
preflight_capability  ← walls, not NL      generation_preview
preflight_placement   ← ONE brick          generation_apply
repair_suggest                             generation_cancel
render_capture
```

An in-editor Claude talking through `AgentSession` **cannot call `generation_run`**. An external MCP client can. That is the product lying to itself: “agent-native CAD” whose native agent cannot generate.

---

## Shared contracts (read before every edit)

### Exclusive ownership (this agent)

You may create and freely edit:

- `src/agent/**` (TypeScript/TSX **logic**. Do not restyle `workbench.css` beyond a className the glass plan already documents.)
- `server/assistant/**`
- `src/generation/**` except `src/generation/panel.css`
- `server/generation/**`
- `src/intelligence/**` except `src/intelligence/ui/find-parts.css`
- `src/refinement/strategies/**`, `src/refinement/llm.ts`, `src/refinement/session.ts`, `src/refinement/worker.ts`, `src/refinement/topology.ts` (logic). Do not restyle `src/refinement/panel.css` or `ObjectivesDialog.tsx` chrome.
- `src/webmcp/surfaces/generation.ts`
- `src/webmcp/surfaces/intelligence.ts`
- Tests matching those trees
- `docs/integration/generation.md`, `docs/integration/agent-workbench.md`, `docs/integration/part-intelligence.md`, `docs/integration/refinement.md` (append; do not rewrite unrelated sections)

### Forbidden (other agents)

| Path | Owner |
|---|---|
| `src/editor/CadViewport.tsx`, `src/editor/render/**`, `src/editor/PartBatch.tsx`, `src/editor/PartVisual.tsx`, `src/editor/environment.ts`, `src/editor/useCad.ts` | Sol (1) |
| `src/cad/articulation.ts`, `src/cad/collision.ts`, `src/cad/snapping.ts`, `src/cad/placement.ts`, `src/cad/statics.ts`, `src/cad/connections.ts` | Sol (1) |
| All `*.css`, `src/features/**`, `src/editor/workbench/Workbench.tsx`, `Dock.tsx`, `TopBar.tsx`, `Toolbar.tsx`, `layout.ts`, `tools/build-demos.mjs`, `public/demos/**`, `src/demos/**` | Sol (2) |
| `src/platform/auth/**`, Hexclave, Convex auth | nobody in this trio |

### Additive seams

**`src/cad/capabilities.ts`** — append only, after the existing array, using this marker:

```ts
// === AGENT-ML-OWNED (Opus) ===
```

Allowed new capability ids (do not reuse Sol (1) names):

- `generate_from_brief` — mutate, group `assemble`. Input: `{ prompt: string, candidateCount?: 1-6, useModel?: boolean, partBudget?: number }`
- `generate_region` — mutate. Input: `{ prompt: string, anchorPartId?: string, envelopeStuds?: [w,h,d] }` (fill a measured box without wiping the document)

Do **not** change the shape of `build_wall` / `build_structure` / `build_hinged_flap`. Sol (1) may append `// === CAD-MECHANISM-OWNED ===` entries (`plan_crane`, `plan_lattice`, `plan_gear_train`, `plan_clock_faces`). When those exist, **call them from generation**; do not reimplement.

**`src/cad/assembly.ts`** — you may *import and call* new planners Sol (1) adds (`planLattice`, `planCrane`, `planSnotHull`, `planClockMechanism`). If they are not on `main` yet, fall back to `planEnclosure` / `planHingedFlap` / `planBrickField` and record the fallback in the candidate notes. Do not edit `planWall` / `planEnclosure` / `planBrickField` / `planHingedFlap` signatures.

**`src/cad/types.ts`** — if the build graph needs a new node kind, add it as a new exported type in `src/generation/graph.ts` first. Only touch `types.ts` if a persisted document field is required; prefer generation-only graph fields that never hit the document.

**`src/agent/schemas.ts`** — must stay in lockstep with `SHARED_CAPABILITIES`. When you add a capability, add its Zod schema in the same commit.

**`src/webmcp/adapter.ts`** — do not restructure the gateway. If the Design Partner needs generation, **duplicate the semantic into `ASSISTANT_TOOLS`** (browser `ToolHost`) rather than making the chat loop call `window.brickwright`. The assistant already executes tools in-page against `cadEngine`.

**`src/generation/GeneratePanel.tsx` / `BriefEditor.tsx` / `CompareDialog.tsx`** — you own behaviour (wire `intent=describe`, expose progress, show why generation was chosen). Sol (2) owns classes and glass wrappers. If you need a new DOM node, give it a stable `className` / `data-generation-*` hook and leave styling.

---

## Current system (files an executor must actually open)

### Generation pipeline

- `src/generation/brief.ts` — prose → `DesignBrief`. Evidence per field. Conflicts never auto-resolved. `classifySubject` keyword lists: vehicle / building / furniture / creature / mechanism / sculpture. Missing keywords for this product: `falcon`, `eiffel`, `big ben`, `clock tower`, `skyscraper` is present, `freighter`, `saucer`, `metro`, `minifig`. Add original-subject keywords only (`freighter`, `saucer`, `lattice`, `belfry`, `clockface`, `observation deck`, `boarding ramp`).
- `src/generation/graph.ts` — single-parent DAG. Invariants: unique ids, no cycles, one incoming edge per placed node, roots anchored, no writes to protected nodes.
- `src/generation/realize.ts` — `GraphRealizer` + `findSnapCandidates`. Outcomes: `realized | repaired | rejected | skipped` with `attemptLog`.
- `src/generation/repair.ts` — 24 attempts: other connector, other part, lattice offset.
- `src/generation/phases.ts` — `massing` (model or `STRATEGIES`) → `skeleton` → `packing` → `detail`. `STRATEGIES`: `framed-shell`, `stacked-slab`, `spine-and-ribs`. All three emit **axis-aligned rectangular boxes**. `MASSING_SYSTEM` forbids parts/colours/connections and caps **1–8 boxes**. That cannot describe a saucer, a lattice, or a clock tower with flying buttresses.
- `src/generation/score.ts` — 26 axes including `silhouetteIou`, `stackedSeamCount` (recent), statics, collisions.
- `src/generation/engine.ts` — **sequential** `for` loop over candidates (up to 12). Finding in `docs/improvements/09-ai-agent.md` #6.
- `src/generation/session.ts` — UI session: compile, run, ghost, apply via `commandBus` with source `'generation_apply'`.
- `src/generation/mcpHost.ts` — WebMCP host over that session.
- `src/generation/testing.ts` — golden briefs; live model is opt-in (`docs/integration/generation.md`: 21 briefs × 3 candidates not run live in CI).

### Assistant loop

- `src/agent/toolschemas.ts` — Zod-only; API process imports this. **This is where generation tools must be declared** so both sides share one schema.
- `src/agent/tools.ts` — `createToolHost`; implements each tool against `cadEngine`. `preflight_placement` is the single-brick path. Repeat fingerprint → `REPEAT_REFUSED`.
- `src/agent/guidance.ts` — `nextAgentAction(situation)`. Empty document → `capability_search` `build_field`. Never generation.
- `src/agent/session.ts` — multi-leg chat; serial `toolHost.execute` (09-ai-agent #7). Preflights are not pure reads.
- `src/agent/modes.ts` — Inspect / Propose / Build. **No commit tool.** Waves go through `commandBus.preflight` then human accept (or auto-accept in Build after re-check).
- `server/assistant/prompt.ts` — standing instructions. Must be rewritten so “build me X” means generate.
- `server/assistant/handler.ts` / `provider.ts` — streaming NDJSON. Cache `system` as content blocks on the chat path already; generation Anthropic path still sends bare string (`09-ai-agent.md` #1).
- `server/generation/anthropic.ts` — massing structured output. Same cache miss.

### Intelligence / refinement (use, don’t rebuild)

- `src/intelligence/parts/*` — hybrid catalog rank, 0.9 top-5 recall gate. Detail-phase part choice should go through this, not a hardcoded tile.
- `src/refinement/strategies/restack.ts` and friends — post-hoc topology. Generation scoring already uses stacked-seam topology. Prefer generating a bonded wall over refining a stacked one.

---

## Unfiltered research dump (generation / agents / ML)

Nothing below is an instruction to vendor the code. It is the complete lead list gathered for this workstream. Evaluate license, scope, and whether Brickwright’s kernel already covers the idea.

### Brickwright-internal (already in-repo — prefer these)

1. **Build graph + snap realiser** (`src/generation/graph.ts`, `realize.ts`) — the correct abstraction. Extend node kinds; do not replace with voxel-LLM brick dumping.
2. **Parametric assembly** (`src/cad/assembly.ts`) — running bond, exact coverage, corner interlock, openings, hinged flap. Generation should emit *region intents* that call these, not N `part.add` from the model.
3. **Shared capabilities** — `build_structure` already raises a multi-storey glazed building in one transaction. The chat agent under-uses it.
4. **WebMCP generation surface** — working compile/run/preview/apply. Mirror into `ASSISTANT_TOOLS`.
5. **Refinement strategies** — restack, etc. Candidate ranking, not the primary builder.
6. **Part intelligence eval** — pattern for a generation eval (`09-ai-agent.md` #4).
7. **Wave ledger** — generation apply must remain a wave, so Propose mode still reviews a 4,000-part candidate as one ghost.
8. **Golden briefs** in `src/generation/testing.ts` / integration doc — extend with vehicle / mechanism / landmark briefs; do not delete building briefs.
9. **Anthropic structured massing** — clamp-and-fallback (`parseMassing` / `clampBoxes`) is the proven safety pattern. Reuse for detail proposals and for non-box massing.
10. **`docs/improvements/09-ai-agent.md`** — ten findings: prompt cache, context management, refusal fallbacks, live eval, spend budget, parallel candidates, parallel tools, strict tool-use, summarised thinking, model-driven detail. This plan takes #4, #6, #8, #10, and the “agent cannot generate” hole. Spend budget and Hexclave metering are out of scope.

### Open-source / academic ML for bricks (do not silently depend)

11. **BrickGPT / LegoGPT** — https://github.com/AvaLovelace1/BrickGPT — ICCV 2025 Best Paper (Marr Prize), CMU. Fine-tuned Llama-3.2-1B-Instruct. Dataset StableText2Brick (~47k structures, 21 categories). **Hard limits:** 20×20×20 grid, 1-unit-tall cuboid bricks only. Categories: basket, bed, bench, birdhouse, bookshelf, bottle, bowl, bus, camera, car, chair, guitar, jar, mug, piano, pot, sofa, table, tower, train, vessel. MIT weights on Hugging Face `AvaLovelace/BrickGPT`. **Use:** validity-check + physics-aware *rollback during autoregression* (prune illegal next-brick, roll back to last stable prefix). **Do not use:** as the Brickwright generator. A UCS-class freighter or Eiffel lattice is outside its universe. Running Llama in the browser is also out of scope for this plan.
12. **StableText2Brick** — Hugging Face `AvaLovelace/StableText2Brick` — captions + brick sequences. Could fine-tune later; not this sprint.
13. **brickbuilderai** — https://github.com/jjohnson5253/brickbuilderai — image/text → Trellis or SAM-3D voxels → brick packing → LDR/MPD. Stack: React/Three/FastAPI/Open3D. **Use:** the *voxel → brick covering* idea for sculpture/organic subjects. Hosting SAM-3D on RunPod is not this sprint. Do not pull Trellis into the Vite app.
14. **LEGOGEN** (Devpost) — Vue + FastAPI; Meshy mesh + inventory-from-photo; heuristic voxel fill. Commercial Meshy dependency. Idea only: inventory-constrained generation (Brickwright has no user inventory yet).
15. **Image2Lego / LEGO-Maker** (papers) — autoencoders / tokenizers from 2D images. Research; no production kernel.
16. **Wave Function Collapse** (Maxim Gumin, MIT-licensed WFC) — good for facades, tiled streets, ironwork lattices with local constraints. Could drive `detailDelta` or a lattice fill. Not a replacement for clutch physics.
17. **Exact cover / Dancing Links (Knuth)** — brick packing of a voxel occupancy grid with a part library (1×1, 1×2, 2×4, …) is an exact-cover problem. Brickwright’s `planBrickField` already does staggered covering for rectangles. For irregular hulls (saucer, mandible), implement a bounded exact-cover or greedy largest-first packer in `src/generation` that still emits graph nodes the realiser seats.
18. **OR-Tools CP-SAT** (Apache 2.0) — overkill in-browser; if used, keep it in a worker or Node generate path only. Prefer a few hundred lines of greedy packer first.
19. **Hierarchical task networks / LLM planners** — “subgoal: chassis; subgoal: hull; subgoal: turret” maps cleanly onto `BuildGraph` subgraphs and `create_subassembly`. The model should output a *tree of region intents*, not a brick list.
20. **Tool-use papers / Anthropic tool-use best practices** — strict schemas, `strict: true` (`09-ai-agent.md` #8), cache_control on stable system text (#1), `clear_tool_uses` (#2). Do #1 and #8 in this plan; #2 if cheap.
21. **Refusal fallbacks** (`09-ai-agent.md` #3) — “turret”, “cannon”, “siege” trip classifiers. Out of critical path but one afternoon: `fallbacks` beta on both Anthropic call sites.

### LEGO data (read-only; do not ship official inventories as demos)

22. **Rebrickable API v3** — https://rebrickable.com/api/v3/docs/ — sets, parts, minifigs, themes. No prices. Requires API key. Brickwright already compiles Rebrickable into the catalog (`tools/catalog-compiler.mjs`). Do not fetch live in the generate hot path.
23. **Rebrickable downloads** — full CSVs; already used at compile time.
24. **LDraw parts library** — already the geometry source. CCAL 2.0.
25. **LDCad Shadow Library** — already used for connectors.
26. **OMR (LDraw Official Model Repository)** — community recreations of retail sets. Licenses mixed; many files are “unofficial recreation.” **Do not import a 75192 / 10307 / 10253 / 60473 MPD as a Brickwright demo.** Sol (2) authors original demos. You may use OMR *technique notes* (SNOT hulls, lattice angles) as comments in strategies.
27. **BrickLink catalog / wanted-list XML** — CAD-capability finding (`07-cad-capability.md` #5). Out of this plan unless generation needs BrickLink ids; it does not.
28. **Brickognize** — photo → part id. Not generation.

### Complexity targets (what “smart enough” must eventually express)

These are **capability classes**, not copy-the-set tickets. Sol (2) builds the showcases; you make `/api/generate` and the Design Partner able to *attempt* the class.

29. **Saucer freighter (Millennium Falcon class)**
    - UCS 75192: 7,541 pieces (2017); play: boarding ramp, gun turrets, landing gear, interior corridors, dejarik, escape pods.
    - Midi 75375: 921 pieces (2024); display-only, stand, no interior. Not the bar.
    - Techniques generation must learn: SNOT plates for curved hull, mandible gap, offset cockpit tube, dish on a clip/bar, hinged ramp (`build_hinged_flap` exists), turret on a pin (`articulate_joint` exists), landing-gear prismatic joints (Sol (1) may deepen).
    - Default 14×8×8 vehicle footprint is a joke against this class. Add `scale: large` envelopes: e.g. 48×16×48 studs, partBudget 2500–4000, multi-wave if over ceiling.
30. **City play-tower (LEGO City 60473 The City Tower, June 2025)**
    - 1,941 pieces, ~49×48×44 cm, $209.99. Second-biggest City set after 60380 Downtown.
    - Features: metro station + tracks, police and fire stations with vehicle bays, working **string crane** (rotate + raise/lower + extend), skate ramp, rooftop **spaceship launch pad**, 3 residential floors with rearrangeable furniture, 7 minifigs, combinable with City road plates and train tracks.
    - Generation needs: mixed program in one envelope (not one `build_structure`), hinged/slide mechanisms, a crane region (depends on Sol (1) `planCrane` or approximate with `build_hinged_flap` + winch placeholder), interior furniture as stampable modules (`capture_module` / `stamp_module` already exist).
31. **Lattice landmark (Eiffel Tower 10307)**
    - 10,001 pieces, ~149 cm. Ironwork at non-orthogonal angles; three platforms; tricolor mast. LDraw OMR thread notes 4–5 decimal rotation precision and flex parts.
    - Generation today cannot emit non-axis-aligned boxes. Need a `lattice` region fill (Sol (1) planner) or a graph of bar/clip beams. `HARD_PART_CEILING` 4000 means a 10k model is **multiple generate_region waves** or a raised ceiling for demo compilation only.
32. **Clock palace (Big Ben / Palace of Westminster 10253)**
    - 4,163 pieces (retired Creator Expert). Clock faces, interior, tower + palace massing, microfig-scale.
    - Generation needs: landmark silhouette (clock stage, spire), printed-or-tiled clock faces (tile mosaic via `planBrickField` + colour), interior void with stairs.

### Prompting / agent UX research

33. **Cursor / Claude tool-use:** models place one brick when the tool that places one brick is the most described. Fix: make `preflight_placement` description say “ONE part onto an existing anchor. Never use this to construct a building, vehicle, or set. Use generate_from_brief or build_structure.”
34. **Progressive disclosure of tools:** Anthropic allows many tools; quality drops as the list grows. Prefer one `generate_from_brief` plus existing capabilities, rather than eight new micro-tools.
35. **Grounding NEXT line** currently pushes placement after errors. After a successful wall, it should push “ask whether to generate the rest” or continue the brief, not another 1×1.
36. **`?intent=describe`** is generated by landing (`src/features/landing/navigation.ts`) and **read by zero editor code** (`06-ux-information-architecture.md` #2). Sol (2) may style the panel; **you must honour the query param** in `GeneratePanel` / session boot: expand Generate, focus textarea. Landing files themselves are Sol (2); reading `window.location.search` from `src/generation/contribution.tsx` or `session.ts` is yours.
37. **Autonomy:** generation_apply is already Build-only in WebMCP (`webmcp/surfaces.test.ts`). Mirror that: Propose → ghost wave; Build → apply after re-preflight; Inspect → compile/run/state only.

### Cost / latency (do not ignore)

38. Sequential candidates × full system prompt = billed N times (`09-ai-agent.md` #1, #6). Parallelise candidates with a pool of 2–3. Cache `MASSING_SYSTEM` and `BRIEF_SYSTEM` with `cache_control: ephemeral`.
39. A Design Partner turn that runs generation may exceed `timeoutMs: 120000`. Raise assistant timeout for legs that called `generate_from_brief`, or run generation as a job the chat polls (`generation_state`) so the HTTP turn returns.
40. `DEFAULT_PART_BUDGET` 420 vs demos at 3k–11k. Expose budget in the brief UI (already a field) and bump defaults by archetype: mechanism 800, building 1200, vehicle 1500, landmark 3000, still clamped to `MAX_GENERATED_PARTS`.

### What not to do (seen in the wild)

41. Do not have the LLM emit world-space coordinates. BrickGPT does that on a tiny grid; Brickwright’s whole point is the opposite (`docs/integration/generation.md`: “No coordinate in the output was ever proposed by a model”).
42. Do not stream `part.add` into the document as the model talks. Ghost the whole candidate.
43. Do not replace `STRATEGIES` with BrickGPT weights in CI.
44. Do not add Python to the Vite app.
45. Do not call Meshy / commercial mesh APIs from the core generate path.

---

## Design (the thing to build)

### 1. One generate tool on the Design Partner

Add to `ASSISTANT_TOOLS` (and implement in `ToolHost`):

| Tool | Kind | Behaviour |
|---|---|---|
| `generation_compile` | read | Same as MCP: prompt → brief via `/api/brief` with local fallback |
| `generation_run` | read (no document write) | Runs pipeline; stores candidates on the generation session |
| `generation_preview` | preflight | Ghosts selected candidate as a **wave** (operations + label), same as `preflight_capability` |
| `generation_apply` | *not a tool* | Human / Build mode already applies waves through `modes.ts`. Do not add a commit tool. If Build auto-accepts, reuse `WaveLedger` |

Also add shared capability `generate_from_brief` that **internally** compile+run+preview so a model that only knows capabilities still hits the pipeline:

```
preflight_capability { capability: "generate_from_brief", args: { prompt, useModel: true, candidateCount: 3 } }
→ operations for the winning candidate
→ one wave labelled from the brief.subject
```

Deterministic path `useModel: false` must work in tests without network.

### 2. Policy: when to generate vs place vs assemble

Encode in `server/assistant/prompt.ts` **and** `nextAgentAction`:

| Builder intent (from the user message + situation) | Tool |
|---|---|
| Empty document + design request (“build a …”, “make a …”, “a tower that …”) | `generate_from_brief` / `generation_compile` |
| Empty document + “blank plate” / “just a base” | `build_field` |
| Existing model + “add a wall / floor / storey” | `build_wall` / `build_enclosure` / `build_structure` |
| Existing model + “put a 2×4 on that” / named part | `preflight_placement` |
| Existing model + “fill this wing / add a ramp / add a crane” | `generate_region` or `build_hinged_flap` / future Sol (1) planners |
| Refusal | `repair_suggest` then the nextArgs it returns |

`preflight_placement` description must state it is illegal to use it to construct a set.

Guidance: if `partCount === 0` and `failureCode` is empty, **do not** default to `build_field` when the last user text classifies as a subject (`classifySubject` ≠ unknown). Call generate.

### 3. Massing beyond three building strategies

Keep `framed-shell` / `stacked-slab` / `spine-and-ribs`. Add:

| Strategy id | Archetype | What it emits |
|---|---|---|
| `play-program` | building + functions (metro, bays, interiors) | Multiple boxes with **roles**: `plinth`, `bay-left`, `bay-right`, `shaft`, `crown`, `pad` — still AABB, but 4–8 boxes with named programs, not 3 identical storeys |
| `hull-and-keel` | vehicle | Keel slab + port/starboard SNOT regions + cockpit box + engine box. Until Sol (1) `planSnotHull` exists, realise SNOT regions as plate fields on edge (`family: plate`, rotated via existing quarter-turn bases) |
| `tower-stages` | landmark | Stacked diminishing footprints (clock stage, belfry, spire) with a `void` fill (skeleton only, no packing) for interiors |
| `machine-frame` | mechanism | Base + mast + boom boxes; boom realised via `planHingedFlap` or `planCrane` |

Raise `MASSING_SYSTEM` box cap from 8 to **16**. Keep clamp-and-fallback.

Model-driven massing schema: add optional `role` enum including the names above so the LLM can pick program without inventing parts.

### 4. Model-driven detail (09-ai-agent #10)

`detailDelta` today hard-codes groove tiles.

Add `DETAIL_SCHEMA`: array of `{ regionId, query, color?, countMax }` max 12. Run through `src/intelligence` resolver (`placeable` only). Each placement still goes through the snapper. If parse/clamp/realize fails, fall back to current tiles and set `notes` accordingly.

Do not let the model choose illegal identities; `resolvePartIdentity` already has a placeable tier.

### 5. Hierarchical graphs / subassemblies

After realisation, group parts by massing `role` into subassemblies (`create_subassembly` operations appended). The agent can then lock a floor and generate_region on another. Caps: one subassembly per massing box, names from roles.

### 6. Multi-wave generation over the 4000 ceiling

If the brief’s envelope × packing estimate exceeds `MAX_GENERATED_PARTS`, the engine must:

1. Generate the **core** (e.g. plinth + first storeys) as wave 1.
2. Return `continuation: { remainingRoles, suggestedPrompt }` in the tool result.
3. Prompt the model to call `generate_region` for the rest.

Do not silently raise `MAX_GENERATED_PARTS` globally; Sol (1)/demos may need the same ceiling. If you must raise it, export a named `MAX_GENERATED_PARTS_GENERATION` override **only** for the realiser and document it. Prefer multi-wave.

### 7. Parallel candidates + prompt cache

- `engine.ts`: pool of 3 concurrent `runPipeline` calls; `onPhase` events must include `candidateId` so the UI can interleave (GeneratePanel already has candidate cards).
- `server/generation/anthropic.ts` and brief compiler: `system` as `[{ type: "text", text, cache_control: { type: "ephemeral" } }]`.

### 8. Eval

Add `src/generation/eval/archetype.test.ts` (deterministic, no live model):

- Brief “a three-storey shop with a door” → `build_structure` or generate candidate with `componentCount === 1`, `collisionCount === 0`, `partCount > 40`.
- Brief “a saucer freighter with a boarding ramp” → strategy `hull-and-keel` or model massing with a hinge flap in the graph; **must not** be a `framed-shell` box that looks like a house.
- Empty-doc Design Partner simulation: scripted user text “Build a clock tower with a belfry” → first preflight is `generate_from_brief` or `generation_compile`, **not** `preflight_placement`.

Live-model eval (`09-ai-agent.md` #4) as `npm run test:live:generation` extension, not default `npm test`.

### 9. Session / MCP parity

`generation_*` tools in the Design Partner must call the same `GenerationSession` as the panel and as WebMCP (`mcpHost.ts`). One session per workbench mount. If the human typed in the Generate panel, the agent sees that brief via `generation_state`. If the agent compiled, the panel shows it. Sol (2) will restyle the panel; keep the state contract.

Honour `?intent=describe` in `src/generation/contribution.tsx`: on mount, if search contains `intent=describe`, call workbench API to expand the Generate section and focus the prompt. Do not edit `Hero.tsx`.

---

## File map (create / modify)

| File | Action |
|---|---|
| `src/agent/toolschemas.ts` | Add generation tool Zod schemas; rewrite `preflight_placement` description |
| `src/agent/tools.ts` | Implement generation tools via `src/generation/mcpHost.ts` (or a shared `src/generation/host.ts` extracted from mcpHost so tools.ts does not import webmcp) |
| `src/agent/guidance.ts` | Empty+subject → generate; successful generate → stop, don’t place |
| `src/agent/guidance.test.ts` | Cover new branches |
| `src/agent/tools.test.ts` | Generate on empty doc; placement description/policy tests |
| `src/agent/session.test.ts` | Scripted “build a tower” does not call `preflight_placement` first |
| `server/assistant/prompt.ts` | Policy table in prose; generate-first |
| `server/assistant/tools.ts` | `strict: true` if schemas allow (`09` #8) |
| `server/generation/anthropic.ts` | cache_control system blocks |
| `src/cad/capabilities.ts` | Append `generate_from_brief`, `generate_region` |
| `src/agent/schemas.ts` | Zod for those ids |
| `src/generation/host.ts` | **Create** — session helpers used by mcpHost + ToolHost |
| `src/generation/mcpHost.ts` | Delegate to host.ts |
| `src/generation/phases.ts` | New strategies; box cap 16; detail schema |
| `src/generation/engine.ts` | Concurrency pool; continuation metadata |
| `src/generation/brief.ts` | Keywords; larger default envelopes for `large` scale |
| `src/generation/graph.ts` | Optional `role` / `regionKind: 'aabb' \| 'hull' \| 'lattice' \| 'mechanism'` on nodes |
| `src/generation/realize.ts` | Dispatch regionKind to assembly planners (including Sol (1) exports if present) |
| `src/generation/contribution.tsx` | `intent=describe` |
| `src/generation/session.ts` | Continuation; share state |
| `src/generation/pipeline.test.ts` / new eval tests | See Task list |
| `src/webmcp/surfaces/generation.ts` | Keep names; point at host.ts |
| `docs/integration/generation.md` | Append “Design Partner tools” section |
| `docs/integration/agent-workbench.md` | Append generate-first policy |

Extract `host.ts` so `src/agent/tools.ts` never imports `src/webmcp/**`.

---

## Task list

### Task 1: Extract a generation host both surfaces can call

**Files:**
- Create: `src/generation/host.ts`
- Modify: `src/generation/mcpHost.ts`
- Test: `src/generation/transport.test.ts` or new `src/generation/host.test.ts`

**Interfaces:**
- Consumes: existing `GenerationSession` API (`compileBriefFromServer`, `compileBriefLocal`, `setGeneration`, `run`, `preview`, `apply`, `getState`, `cancel`)
- Produces:

```ts
export function getGenerationHost(): {
  compileFromServer(prompt?: string): Promise<unknown>
  compileLocal(prompt?: string): unknown
  set(input: unknown): unknown
  run(input: { useModel?: boolean }): Promise<unknown>
  state(): unknown
  cancel(): unknown
  preview(candidateId: string): unknown
  apply(expectedRevision?: number): unknown
}
```

- [x] Move the bodies from `mcpHost.ts` into `host.ts` without behaviour change.
- [x] `mcpHost.ts` re-exports and still registers the surface snapshot.
- [x] Run `npm test -- src/webmcp/surfaces.test.ts src/generation` — expect PASS.
- [x] Do not commit unless asked.

### Task 2: Declare generation tools on the Design Partner

**Files:**
- Modify: `src/agent/toolschemas.ts`, `src/agent/tools.ts`, `src/agent/index.ts` if needed
- Test: `src/agent/tools.test.ts`, `src/agent/schemas.test.ts`

**Interfaces:**
- Consumes: `getGenerationHost()`
- Produces: `ASSISTANT_TOOLS` entries `generation_compile`, `generation_compile_local`, `generation_set`, `generation_run`, `generation_state`, `generation_cancel`, `generation_preview` with the same Zod as `src/webmcp/surfaces/generation.ts` (copy schemas into `toolschemas.ts`; do not import webmcp).

`generation_preview` kind is `preflight`: it must call `WaveLedger` / the same path as `preflight_capability` so Propose mode shows a ghost. Reuse `cadEngine.preflight` with operations from the generation host’s preview document diff.

- [x] Rewrite `preflight_placement` description to: single part onto an existing anchor; forbidden as a way to construct a building, vehicle, or set.
- [x] Inspect mode: generation compile/run/state allowed; preview refused like other preflights.
- [x] Tests: empty plate, deterministic `generation_run` with `useModel: false` and a tiny prompt that `compileBriefDeterministically` understands; preview creates a wave; apply is still not a tool.
- [x] Run `npm test -- src/agent src/webmcp/surfaces.test.ts`.

### Task 3: Shared capability `generate_from_brief` / `generate_region`

**Files:**
- Modify: `src/cad/capabilities.ts` (append after `// === AGENT-ML-OWNED (Opus) ===`), `src/agent/schemas.ts`, `src/cad/capabilities` planner switch in `planSharedMutation`
- Test: existing capability tests plus new cases in `src/agent/schemas.test.ts` and a generation integration test

`planSharedMutation('generate_from_brief', args)` must:

1. `compileBriefDeterministically` or async model compile — **planSharedMutation is sync today.** If you cannot make it async, have the capability require a brief already sitting on `getGenerationHost().state()`, and have the tool `preflight_capability` path: if no brief, return a structured repair “call generation_compile first.” Better UX: implement generate_* only as assistant tools (Task 2) and make `generate_from_brief` a thin alias that the prompt prefers. **Pick this:** assistant tools are the real path; `generate_from_brief` in SHARED_CAPABILITIES calls a **sync** deterministic generate (`useModel: false`) so kernel tests stay sync. Model-backed generate stays on `generation_run`.

- [x] Sync deterministic `generate_from_brief` for tests and capability_search discoverability.
- [x] `generate_region` takes `anchorPartId` + prompt, compiles a brief with envelope from measured neighbour bounds (read via kernel), realises with `mergeProtected` so existing parts stay.
- [x] Refuse if operations empty; report notes.

### Task 4: Prompt + guidance policy (this is the behaviour change the operator asked for)

**Files:**
- Modify: `server/assistant/prompt.ts`, `src/agent/guidance.ts`, `src/agent/protocol.ts` / `server/assistant/protocol.ts` if grounding needs `subjectHint`
- Test: `src/agent/guidance.test.ts`, `src/agent/session.test.ts`

Grounding: pass `lastUserText` or a `classifiedSubject` into `groundingBlock`. `nextAgentAction` signature may grow:

```ts
nextAgentAction(situation: AgentSituation & { subject?: SubjectArchetype; userWantsGenerate?: boolean })
```

- [x] Empty + subject → `generation_compile` / `generate_from_brief`, never `preflight_placement`, never default `build_field` unless subject is unknown and the user said “baseplate”.
- [x] Session test: scripted user “Build a harbour control tower with a crane and a metro” → first tool is generation, not placement.
- [x] Prompt: explicit forbidden pattern “Do not lay a building brick by brick.”
- [x] Run `npm test -- src/agent server/assistant`.

### Task 5: Massing strategies for play-program, hull-and-keel, tower-stages, machine-frame

**Files:**
- Modify: `src/generation/phases.ts`, `src/generation/brief.ts`
- Test: `src/generation/pipeline.test.ts`

- [x] `classifySubject` keywords: freighter, saucer, hull, belfry, clock tower, lattice, observation, metro, hangar, ramp (ramp already in mechanism).
- [x] Select default strategy from archetype: building→framed-shell or play-program if functions include metro/crane/interior; vehicle→hull-and-keel; mechanism→machine-frame; sculpture/landmark words→tower-stages.
- [x] Box cap 16; update `parseMassing`.
- [x] Default footprints for `scale: large`: vehicle `[48, 16, 40]`, building `[32, 40, 32]`. Keep micro/minifig as now.
- [x] Deterministic tests: known seeds, snapshot structuralHash **or** assert role set and partCount bounds, not exact ids if too brittle.
- [x] `hull-and-keel` must call `planHingedFlap` for a ramp when functions mention ramp/boarding; if catalog hinge missing, note and skip (do not fail the whole candidate).

### Task 6: Model-driven detail with intelligence fallback

**Files:**
- Modify: `src/generation/phases.ts`, `server/generation/anthropic.ts` or a new `detail.ts`
- Test: `src/generation/pipeline.test.ts` with a fake `ModelProvider` returning a legal detail payload and an illegal one

- [x] Illegal detail → fallback tiles, `notes` include `detail:fallback`.
- [x] Legal detail → `catalog_search`/resolver placeable only; each node through realiser.
- [x] Prompt cache on massing **and** detail system strings.

### Task 7: Parallel candidates + continuation over 4000 parts

**Files:**
- Modify: `src/generation/engine.ts`, `src/generation/session.ts`, host tool results

- [x] `Promise` pool size 3; abort still cancels all.
- [x] Interleaved `onPhase` must not assume candidate order; include `candidateId`.
- [x] If packing would exceed ceiling, stop packing, emit `continuation` with remaining box ids; candidate still validates.
- [x] Test with a stub planner or a tiny `MAX` injected via options (`RealizeConstraints.partCeiling`) rather than mutating the global constant if you can. If you must, add `options.partCeiling` to `runPipeline` defaulting to `MAX_GENERATED_PARTS`.

### Task 8: Subassemblies from massing roles

**Files:**
- Modify: `src/generation/realize.ts` or a post-pass in `engine.ts`

- [x] After a successful candidate, append `create_subassembly` / `assign_subassembly` operations grouped by role.
- [x] Unlock by default so the human can edit. Do not lock.
- [x] Test: two-box massing → two non-empty subassemblies, all parts assigned.

### Task 9: `intent=describe` boot

**Files:**
- Modify: `src/generation/contribution.tsx` (and `GeneratePanel.tsx` if focus lives there)

- [x] Read `intent=describe` from `window.location.search` (or a workbench API if one exists — prefer not editing `useWorkbench.ts` if Sol (1) is in it; `contribution.tsx` can read the URL itself).
- [x] Expand Generate dock section via whatever registry API already opens sections; if the only API is in `layout.ts` (Sol (2) owned), dispatch a custom event `brickwright:intent-describe` that Sol (2) is documented to honour. **If you cannot open the dock without touching Sol (2) files, fire the event and document it in both plans; still focus the textarea if the panel is mounted.**
- [x] Test with jsdom: mock `window.location.search`.

### Task 10: Docs + eval floor

**Files:**
- Modify: `docs/integration/generation.md`, `docs/integration/agent-workbench.md`
- Create: `src/generation/eval/archetype.test.ts`

- [x] Document generate-first, tool map, continuation, strategy table.
- [x] Eval tests from Design §8.
- [x] Run `npm test -- src/generation src/agent server/assistant`.
- [x] Run `npm run lint` on touched files.

---

## Verification (this agent)

```sh
npm test -- src/generation src/agent src/webmcp/surfaces.test.ts src/intelligence server/assistant server/generation --maxWorkers=2
```

Live (optional, costs money):

```sh
npm run test:live:generation
```

Manual: `/editor?intent=describe` → Generate focused; Design Partner “build a three-storey glazed workshop with a roll-up bay” in Propose → **one** ghost of many parts, not a 2×4; accept → undo removes the whole candidate.

Do not claim CAD camera or glass UI is fixed. That is the other agents.

---

## Success criteria

1. A Design Partner session can compile, run, preview a generated candidate without WebMCP.
2. Scripted tests prove a design-request on an empty document does not call `preflight_placement`.
3. `preflight_placement` is documented and tested as single-part-only.
4. At least one non-building strategy (`hull-and-keel` or `machine-frame`) produces a candidate that uses a hinge or a non-house massing role.
5. Detail phase can take a model proposal and falls back safely.
6. Candidates run with concurrency ≤ 3.
7. Generation panel and chat share one session.
8. No CSS, camera, or demo-manifest edits in this agent’s diff.

---

## Coordination log (paste into PRs)

- Sol (1): if `planCrane` / `planLattice` / `planSnotHull` / `planClockMechanism` export from `assembly.ts`, call them from `realize.ts` regionKind dispatch.
- Sol (2): listen for `brickwright:intent-describe`; glass-wrap Generate/Agent panels without changing session types; demos should be original MOCs that *exercise* generate-first in screenshots, not official set copies.
