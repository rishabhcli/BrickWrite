# AI and agent capability

Ten findings. The autonomy model (inspect / propose / build, with every edit
validated by the kernel) is the strongest idea in the product; most of these are
about the API surface underneath it being used at maybe 60% of its capability.

Two themes recur: **cost is left on the table** (findings 1, 2, 5) and **the
model is under-used exactly where it would add most value** (findings 4, 10).

---

## 1. Cache the system prompt in both structured-completion paths

**Evidence:** `server/assistant/provider.ts:195` and `server/generation/anthropic.ts:209` both send `system` as a bare string on every request. Only the chat leg (`server/assistant/handler.ts:255-259`) wraps it in a content block with `cache_control: { type: 'ephemeral' }`. The generation pipeline calls the model once per candidate (`src/generation/phases.ts:828`, using the fixed `MASSING_SYSTEM` at `:713`), and one `/api/generate` request produces 3 candidates by default and up to 12 (`src/generation/engine.ts:108`) — all within one request, well inside the cache TTL.
**Why it matters:** Every one of those 3–12 sequential calls re-sends and re-bills identical system text at full input price instead of ~10% cached. **The highest-leverage zero-behaviour-risk cost lever available**, and it compounds with brief compilation sharing `BRIEF_SYSTEM` (`server/generation/index.ts:44-54`).
**Change:** Emit `system` as a content-block array with a `cache_control` breakpoint on the stable text, mirroring the pattern already working in `handler.ts`.
**Effort:** S    **Risk:** Low; verify the `output_config.format` + array-`system` combination is accepted for non-streaming calls.

## 2. Add context management to the assistant chat loop

**Evidence:** The protocol allows 120 messages (`server/assistant/protocol.ts:171`), tool results up to 60,000 characters each (`:124`), 16 tool calls per turn and 8 tool turns (`:30`). The full transcript is resent every leg — the API process "holds no session state" (`:8-15`). A repo-wide grep for `context_management`, `clear_tool_uses` and compaction returns **zero matches**.
**Why it matters:** A design conversation that uses its full tool budget can approach ~1MB of resent tool-result text before the 8-turn ceiling even triggers, rebilled as input on every subsequent leg. Cost grows roughly quadratically with turn count for no reason other than nothing prunes it.
**Change:** Add `context_management.edits: [{ type: 'clear_tool_uses_20250919' }]` (or beta compaction) to `streamChat`, replaying whatever block the API returns through the existing opaque `raw` passthrough (`:148-156`), which exists for exactly this kind of verbatim replay.
**Effort:** M    **Risk:** Confirm the block round-trips through `raw: z.array(z.unknown())` and its 64-entry cap.

## 3. Recover from refusals instead of only reporting them

**Evidence:** `stop_reason === 'refusal'` is detected and turned into a terminal error in three places — `provider.ts:214-220`, `handler.ts:308-315`, `anthropic.ts:160-164` — but a repo-wide grep for `fallbacks` returns nothing.
**Why it matters:** This is a LEGO CAD assistant that will routinely handle "cannon", "gun turret", "sword", "castle siege" — exactly the vocabulary that trips spurious safety classifiers. Today any such refusal dead-ends the user's turn with no retry path, even though the request was benign. **The code already does the work of classifying the refusal, then throws it away.**
**Change:** Add the server-side `fallbacks` parameter (with its beta header) at both call sites, pointed at a peer model, echoing `fallback` blocks per the documented contract.
**Effort:** S–M    **Risk:** Fallback calls bill at the fallback model's rate and change `provenance.model` reporting; surface that in telemetry.

## 4. Build an eval proving model-driven generation actually helps

**Evidence:** `docs/integration/generation.md:472-475` says outright: "The 21 golden briefs run against the model double, not the live model… Running all 63 candidates live would cost real money on every `npm test`." Contrast `src/intelligence/parts/evaluation.test.ts`, which runs 129 hand-labelled queries against the real catalog and gates CI on `RECALL_FLOOR = 0.9` top-5 recall (`:34,79`). No analogous gate compares model-proposed massing (`phases.ts:828`) against the three deterministic `STRATEGIES` (`:95-183`) it can override.
**Why it matters:** The part-search half of the product has a numeric, CI-enforced quality bar. The generation half does not. **Nobody can currently say whether spending a model call on massing produces a better `silhouetteIou`/`supportMargin` than the free deterministic strategy it replaces** — and the docs admit it.
**Change:** A small, explicitly budgeted live-model suite (nightly or on-demand, not on every `npm test`) scoring model-proposed vs deterministic massing on the existing metrics across the 21 golden briefs, with a committed floor.
**Effort:** L    **Risk:** Real API spend; needs a separate rate-limited job.

## 5. Add a real per-user spend budget, not just a rate limiter

**Evidence:** `functions/api/[[route]].ts:13-14` caps paid routes at 20 requests / 60s, keyed on a hash of IP + auth header. `server/security/auth.ts` identifies `userId` but only gates sign-in and restriction status — it never meters. Grepping where `usage.input_tokens` is read shows it only ever flows into the transient NDJSON response; **it is never persisted anywhere**.
**Why it matters:** 20 requests/minute is generous when each can be an `xhigh` chat leg with an 8192-token ceiling, or a `/api/generate` fanning out to 12 model calls. There is no mechanism *even in principle* to cap what one signed-in user spends in a day, because the usage numbers the API already returns are discarded.
**Change:** Persist usage per `userId` (a KV counter keyed like the existing rate-limit key suffices) and enforce a daily or monthly ceiling in `authorizePaidRoute` or at the edge.
**Effort:** M    **Risk:** Needs a durable store; decide deliberately whether a metering outage fails open or closed.

> Read alongside `04-security.md` finding 3 — that rate limiter is also **not
> atomic**, so the 20/60s ceiling does not actually hold under concurrency. The
> two findings compound: no working rate limit *and* no spend ceiling.

## 6. Parallelise independent candidate generations

**Evidence:** `src/generation/engine.ts:158-185` runs candidates in a plain `for` loop — `await runPipeline(...)` at `:178` — sequentially, for up to 12 candidates. Each has its own `idPrefix` (`:169`) and an independent `GraphRealizer`, so nothing but the loop shape forces serialisation.
**Why it matters:** Each candidate's massing phase is an independent round-trip; running them one at a time multiplies user-perceived latency by the candidate count, in an interactive editor where the project's own comment says "latency is part of the product" (`anthropic.ts:31-33`).
**Change:** Run the loop body under `Promise.all` or a small concurrency pool, keeping the per-candidate abort checks.
**Effort:** S–M    **Risk:** Bursts N concurrent API requests instead of 1; `onPhase`/`onCandidate` callbacks are ordered today and must tolerate interleaving.

## 7. Execute a turn's tool calls concurrently

**Evidence:** `src/agent/session.ts:520-525` awaits `this.toolHost.execute(call)` once per call in a `for` loop. The parallel-tool-use contract expects concurrent execution with all `tool_result` blocks returned together — which this code does correctly — but execution itself is strictly serial.
**Why it matters:** The model is explicitly encouraged to plan multi-tool turns (`scene_overview` + `selection_geometry` + `catalog_search` before a placement), and each is genuinely async — catalog search touches the hybrid resolver in `src/intelligence`, `render_capture` encodes pixels. Serial execution turns one round-trip's wall-clock into N.
**Change:** `await Promise.all(toolCalls.map(call => this.toolHost.execute(call)))`, preserving pairing by `id`.
**Effort:** S    **Risk:** **`preflight_*` tools are not pure reads** — they add ghost waves to the `WaveLedger` and check document revision. Concurrent preflights against a mutating revision need a race check before this is safe.

## 8. Turn on strict tool-use validation

**Evidence:** Every tool input schema in `src/agent/toolschemas.ts` already uses `z.strictObject` (11 of them), which is most of what the API's `strict: true` mode requires. But `server/assistant/tools.ts:17-22` maps only `name`, `description` and `input_schema` — `strict` is never set.
**Why it matters:** A malformed `tool_use.input` is currently caught after the fact by `safeParse` (`src/agent/tools.ts:831`), spending a full tool turn out of the 8-turn budget on a round trip the API would have prevented entirely.
**Change:** Add `strict: true` in `anthropicTools()`; audit the 11 schemas' optional fields against strict mode's requirements (all keys generally in `required`, optionality via nullable unions).
**Effort:** S    **Risk:** Strict mode may reject a currently-valid partial shape; audit per tool rather than flipping blindly.

## 9. Surface summarised thinking for propose-mode transparency

**Evidence:** `server/assistant/provider.ts:279-283` sets `thinking: { type: 'adaptive' }` with no `display`, defaulting to omitted. The protocol documents this as intentional — "There is no 'thinking' event… so a stalled or failed stream can never be presented as deliberation" (`protocol.ts:217-222`) — and the prompt instructs "Do not narrate deliberation" (`prompt.ts:35`).
**Why it matters:** The whole autonomy model is "the model proposes reviewable waves, a human accepts or rejects" (`prompt.ts:18`). **That review is currently blind:** the operator sees a ghost wave and a one-line label, never *why* the model chose a given anchor or face over an alternative — especially after a `repair_suggest` detour. Thinking is billed identically regardless of display, so this is free.
**Change:** Set `display: 'summarized'` and add a collapsed "why" affordance on the wave review UI, without relaxing the "never narrate in the reply" rule.
**Effort:** S    **Risk:** Adds streamed volume; needs a UX decision so it isn't confused with the assistant's own voice.

## 10. Give the model a bounded role in the detail phase

**Evidence:** `docs/integration/generation.md:502-505`, in the project's own "what I could not prove" list: "**The detail phase does not consult the model.** … Massing is the phase the model actually drives." Confirmed: `decompose()` (`phases.ts:809-859`) is the only phase taking a `ModelProvider`; `skeletonDelta`, `packingDelta` and `detailDelta` (`:491,533,583`) take none, and `detailDelta` **hard-codes `part: { query: 'tile 1 x 2 with groove' }`** at `:624` and `:641` for every generated model.
**Why it matters:** The product is pitched as coarse-to-fine *assembly generation*, but three of four phases are fully deterministic — and the phase best suited to open-ended brief-driven judgement (surface style, accents, greebles) is the one guaranteed to look identical across every subject from "castle" to "spaceship".
**Change:** Extend the clamp-and-fallback pattern already proven safe for massing (`parseMassing`/`clampBoxes`, `:727-807`) to a schema-constrained detail proposal, falling back to today's deterministic tiles when a proposal fails validation.
**Effort:** L    **Risk:** Detail placements must still pass the snap-solver and hard gates so a bad suggestion degrades to current behaviour rather than a broken document.
