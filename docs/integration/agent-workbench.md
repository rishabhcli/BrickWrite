# Workstream 2 — Agent workbench

An embedded, grounded design partner. A person talks normally; the assistant
reads the model through tools, plans in the shared capability vocabulary, and
proposes **waves** that a person reviews one at a time. Nothing it produces
reaches the document without passing the kernel's revision check.

Owned paths: `src/agent/**`, `server/assistant/**`, and the per-capability
schema extension inside `src/webmcp/**`.

---

## 1. Architecture in one paragraph

The model loop runs in the API process, because that is where
`ANTHROPIC_API_KEY` lives. The tools run in the browser, because that is where
the document lives. One `POST /api/assistant` is one model turn: the server
streams the reply, and if the model asked for tools the leg ends with
`stop: "tool_use"`, the browser executes them against `cadEngine`, and posts the
next leg with the results appended. The server keeps no session state — the
transcript travels in the request — and it enforces the tool-turn budget, the
timeout and the byte ceilings so the browser cannot raise them.

```
browser                                   API process              Anthropic
───────                                   ───────────              ─────────
AgentSession.send()
  └─ grounding from cadEngine ──────────► POST /api/assistant ───► messages.stream
                                          (key, system prompt,
                                           tool schemas, budget)
     NDJSON events ◄─────────────────────  start/text/tool_call/turn/usage/done
  └─ ToolHost.execute() → cadEngine
  └─ next leg ─────────────────────────►  …
WaveLedger.apply() ─► commandBus.dispatch (expectedRevision)
```

### How a leg is laid out for the cache

A leg is one model call and the browser posts the whole transcript back for the
next one, so what the request costs is decided by which parts of it can be read
from cache. Prompt caching is a prefix match over `tools → system → messages`,
and a block that changes every leg makes everything after it uncacheable.

```
tools ─────────────────┐
system: SYSTEM_PROMPT  ├─ [breakpoint] stable while the autonomy mode holds
messages: transcript   ─── [breakpoint] stable for the life of the conversation
messages: grounding    ──  changes every leg, so it goes last
```

Changing autonomy mid-conversation swaps the tool array, which sits at position
zero, so it invalidates both breakpoints. That is inherent to the mode being
structural rather than advisory, and it costs one uncached leg.

The grounding block is the volatile half — revision, part count, selection,
validation, `NEXT` — and it used to be a second `system` segment, which put it
*ahead of the whole transcript*. `buildChatMessages` in
`server/assistant/handler.ts` appends it after the history instead and marks the
block it follows. Steady state per leg is then: read everything accumulated so
far, write only the last turn's delta, pay full price for the grounding alone.

It is a text block rather than a `role: "system"` message because
mid-conversation system messages are not available on `claude-sonnet-5`, this
route's default model. Assistant turns are never marked: they are replayed from
the opaque `raw` list, and this process does not inspect it.

**The model has no commit tool in any mode.** Its entire surface is reads and
preflights. The only path to `commandBus` is `src/agent/modes.ts`, invoked when
a person accepts a wave (or, in Build mode, by the session — through the same
function, with the same re-check).

---

## 2. Public exports — `src/agent/index.ts`

| Export | What it is |
|---|---|
| `AgentWorkbench`, `AgentWorkbenchProps` | The composer panel. Takes an optional `session`; creates its own otherwise. |
| `AgentWorkbenchContribution` | Zero-prop component that registers the panel with the editor's extension registry. |
| `AgentSession`, `SessionState`, `SessionOptions`, `TranscriptMessage`, `SessionStatus`, `SendOptions` | The conversation loop and its observable state. |
| `WaveLedger`, `Wave`, `WaveResult`, `WaveFailure`, `WaveStatus`, `AgentMode`, `ModeCapabilities`, `capabilitiesFor`, `currentMode`, `setMode` | Reviewable waves and the autonomy gate. |
| `TraceLedger`, `TraceEntry`, `TraceKind`, `TraceStatus` | The activity ledger. |
| `compileBrief`, `editBrief`, `resolveConflict`, `refineBriefWithModel`, `briefProvenance`, `briefGrounding`, `BriefRefinementSchema` | The `DesignBrief` compiler. |
| `parseReferenceTokens`, `resolveReference`, `resolveMessageReferences`, `describeScope`, `expandToConnectedIsland`, `SpatialReference`, `ViewportPin`, `ReferenceContext`, `ReferenceScope` | Spatial reference resolution. |
| `createToolHost`, `ToolHost`, `ToolHostOptions`, `ToolFailure`, `ToolMesh`, `verifyIdentities`, `verifyDefinition`, `TOOL_NAMES` | Browser-side tool execution. |
| `ASSISTANT_TOOLS`, `ASSISTANT_TOOL_NAMES`, `toolsForMode`, `toolJsonSchema` | The grounded tool surface (Zod-only module; the API process imports it too). |
| `capabilitySchema`, `mutationSchema`, `capabilityJsonSchema`, `parseCapabilityArgs`, `advertisedFields`, `CAPABILITY_IDS` | Per-capability runtime schemas. |
| `HttpModelProvider`, `createAssistantTransport`, `assistantHealth`, `AssistantTransportError`, `AgentModelTransport`, `StreamHandlers` | The browser client. Holds no credential. |
| `ASSISTANT_PROTOCOL`, `ASSISTANT_ENDPOINT`, `ASSISTANT_EVENT_TYPES`, `isAssistantEvent`, and the wire types | The protocol, restated on the browser side. |

### Files

`src/agent` — 22 files, ~7,200 lines including tests and fixtures.
`server/assistant` — 11 files, ~2,200 lines including tests.

---

## 3. Mounting it — the exact snippet

The registry contract is `docs/integration/workbench-ui.md` §1. The integrator
lists the contribution component in the `CONTRIBUTIONS` array in `src/App.tsx`.
**This is already wired** — the entry below is the live one, reproduced here so
the contract is readable without opening the composition root:

```tsx
// src/App.tsx — live composition root
const CONTRIBUTIONS = [
  AgentWorkbenchContribution,
  GeneratePanelContribution,
  RefinePanelContribution,
  CloudProjectsContribution,
]

export default function App() {
  return <Workbench contributions={CONTRIBUTIONS} />
}
```

That is the whole integration. `AgentWorkbenchContribution` creates one
`AgentSession` per mount, registers into the `panel-right` slot at priority 120
(after the shell's own panels), and withdraws on unmount. The session lives
above the panel, so the conversation survives the dock collapsing.

To mount it somewhere else, or to own the session lifetime, use the panel
directly:

```tsx
import { useRegisterContribution } from './editor/workbench'
import { AgentSession, AgentWorkbench } from './agent'

const session = new AgentSession({ pins: viewportPins, view: cameraView })
useRegisterContribution({
  id: 'agent.workbench',
  slot: 'panel-right',
  priority: 120,
  title: 'Design partner',
  render: () => <AgentWorkbench session={session} />,
})
```

`AgentSession` accepts a `render` option (`{ geometry, encode, canvas }`) that
wires the renderer's compiled meshes into `render_capture`. Without it the tool
still returns exact framing, bounds and part counts and says plainly that no
pixels are available — see §8.

---

## 4. Server route contract

`server/assistant/index.ts` exports `route: RouteModule` (`{ prefix, handle }`),
discovered by `server/index.ts`. Run it with `npm run serve:api`.

### `GET /api/assistant/health`

```json
{ "ok": true, "protocol": "brickwright.assistant/1", "model": "claude-sonnet-5",
  "configured": true, "maxToolTurns": 8, "timeoutMs": 120000 }
```

`configured` says whether a credential exists. Nothing about the credential —
not its length, not its prefix — ever appears in a response.

### `POST /api/assistant`, `kind: "chat"`

Request: `{ protocol, kind: "chat", mode, grounding, messages, model?, effort?, maxToolTurns? }`.
Response: `200 application/x-ndjson`, one JSON object per line.

| Event | Payload |
|---|---|
| `start` | `requestId`, `model`, `toolTurn`, `maxToolTurns` |
| `text` | `text` — one delta |
| `tool_call` | `call: { id, name, input }` |
| `turn` | `raw` — the model's own content blocks, replayed verbatim next leg |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadInputTokens?`, `cacheCreationInputTokens?` |
| `done` | `stop: end_turn \| tool_use \| max_tokens \| refusal \| aborted \| error` |
| `error` | `code`, `message`, `retryable` |

`inputTokens` is not a total. The provider reports four classes of input token
and excludes both cache classes from it, so a reader adding up what a leg cost
has to add all four. The spend meter does.

There is deliberately **no `thinking` event**. The workbench's pending state is
driven by the real stream lifecycle, so a stalled or failed request can never be
presented as deliberation.

Pre-stream failures are HTTP status codes with a JSON envelope
(`{ ok: false, error: { code, message, retryable } }`): `400` bad request or
foreign protocol, `405` wrong method, `409` `TOOL_TURN_LIMIT`, `413` body over
8 MB, `503` `MODEL_PROVIDER_UNAVAILABLE`. Once the stream has started, failures
are `error` events followed by `done`.

### `POST /api/assistant`, `kind: "structured"`

The `ModelProvider` contract across the process boundary. Request carries
`system`, `prompt`, `schema` (JSON Schema), `maxTokens?`, `temperature?`;
response is `{ ok, value, provenance, usage }`. `HttpModelProvider.complete`
runs the caller's `parse` on the returned value, so a Zod violation still throws
in the caller.

### Env

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Read in exactly one module, `server/assistant/provider.ts`. |
| `BRICKWRIGHT_ASSISTANT_MODEL` | `claude-sonnet-5` | Model id. |
| `BRICKWRIGHT_ASSISTANT_MAX_TOOL_TURNS` | `8` | Tool rounds per conversation. |
| `BRICKWRIGHT_ASSISTANT_TIMEOUT_MS` | `120000` | Per-request wall clock. |
| `BRICKWRIGHT_ASSISTANT_MAX_TOKENS` | `8192` | Output ceiling per leg. |
| `BRICKWRIGHT_API_PORT` | `8787` | Owned by `server/index.ts`. |

Verified on this machine:

```
$ npm run serve:api
[api] listening on http://127.0.0.1:8787 with 2 route module(s): /api/assistant, /api/

$ curl -s http://127.0.0.1:8787/api/health
{"ok":true,"routes":["/api/assistant","/api/"]}

$ curl -s http://127.0.0.1:8787/api/assistant/health
{"ok":true,"protocol":"brickwright.assistant/1","model":"claude-sonnet-5","configured":true,"maxToolTurns":8,"timeoutMs":120000}
```

`server/assistant` uses explicit `.ts` extensions on relative imports and avoids
constructor parameter properties, because `node server/index.ts` runs under
Node's strip-only TypeScript mode with no build step.

---

## 5. The grounded tool surface

Declared once in `src/agent/toolschemas.ts` (Zod, no kernel imports). The API
process derives the advertised JSON Schema from it; the browser parses incoming
arguments with the same objects. There is no second declaration to drift.

| Tool | Mode | What it grounds |
|---|---|---|
| `scene_overview` | all | revision, autonomy, counts, bounds, assemblies, constraints, modules, validation |
| `scene_query` | all | placed parts, optionally with their connection neighbours |
| `selection_geometry` | all | measured bounds, stud sizes, top mating plane, neighbours, protection |
| `catalog_search` | all | every catalogued identity with its tier |
| `capability_search` | all | the shared vocabulary **and each capability's enforced JSON Schema** |
| `notes_read` | all | spatial builder notes |
| `render_capture` | all | framing, bounds, coverage; pixels when a renderer or encoder is wired |
| `validate_model` | all | collisions, connectivity, colour evidence, constraints |
| `generation_compile` | all | a sentence → a `DesignBrief`, with the evidence for every field. `useModel: false` compiles from rules in the browser with no model call |
| `generation_set` | all | prompt, candidate count, brief fields, conflict resolutions |
| `generation_run` | all | runs the four-phase pipeline and scores the candidates |
| `generation_state` | all | the shared generation session — the Generate panel's session, not a copy |
| `generation_cancel` | all | stops an in-flight run |
| `generation_preview` | propose, build | stages one generated candidate as a single reviewable wave |
| `preflight_capability` | propose, build | plans one shared capability into a reviewable wave |
| `preflight_placement` | propose, build | places **one** part against an anchor and a face; the connector solver computes the pose |
| `repair_suggest` | all | measured overlap and a clearance, protected owners, weak attachments, stale waves |

Inspect mode omits the preflight tools from the array entirely, so there is
nothing to refuse. No mode contains a tool that writes — including generation,
which has no apply tool in any mode.

`preflight_placement` is why the model does not guess coordinates: it names a
`definitionId`, an `anchorPartId` and an approach (`on-top`, `underneath`,
`beside-x`, …), and `bestSnapTransform` solves the mating pose from the compiled
connector frames.

### Generate first

The tool that places one brick used to be the most described thing on the
surface, so a model asked to "build a harbour tower" placed one brick — and then
another, against a budget of eight tool turns and sixteen calls each, which
cannot reach a model of a few hundred parts. Three things changed:

- **The kernel says so.** `nextAgentAction` classifies the builder's last
  message with the brief compiler's own subject keywords. On an empty document
  with a subject named, `nextTool` is `generation_compile`; with no subject —
  "just a blank plate" — it is still `capability_search` for `build_field`.
  While a generated candidate is staged, it is `generation_state`, because
  building on top of a wave somebody is reviewing changes what they are
  reviewing.
- **The prompt says so.** `server/assistant/prompt.ts` opens the tool section
  with the scale decision — generate, parametric capability, or single part —
  and states plainly that a building, a vehicle, a mechanism or a set is never
  laid brick by brick.
- **The tool says so.** `preflight_placement`'s own description says it places
  ONE part onto an existing anchor and names `generation_compile` and
  `build_structure` as what to use instead.

`src/agent/session.test.ts` and `src/generation/eval/archetype.test.ts` hold
that behaviour: a scripted "Build a harbour control tower with a crane and a
metro station" against an empty plate is grounded with
`nextTool: generation_compile`, and the whole compile → run → preview path
produces exactly one pending wave with the document still empty.

The generation tools reach `src/generation/host.ts` through a dynamic
`import()`, so a conversation that never generates does not load the pipeline.
See `docs/integration/generation.md` for the session, the massing strategies and
the continuation contract.

---

## 6. Per-capability schemas (the `src/webmcp` extension)

`src/agent/schemas.ts` declares one strict Zod object per entry in
`SHARED_CAPABILITIES` — all 35, reads included. `src/webmcp/adapter.ts` now:

- returns `argsSchema` from `capabilities_help` (derived from the enforced schema),
- advertises `action` as an enum of the mutation ids,
- parses `args` with `parseCapabilityArgs` **before** `planSharedMutation`.

Previously `action_mutate` advertised `args: { type: 'object' }` and the planner
coerced whatever arrived with its own helpers, so a misspelled field silently
became a default. It is now an `INVALID_INPUT` naming the field.

`schemas.test.ts` asserts, for every capability: a runtime schema exists; the
JSON Schema is a strict object; every field named in the prose contract is
enforced; nothing is enforced that is not advertised; and requiredness agrees in
both directions (a field described as "optional" or carrying a "default" is
optional, everything else is required).

All 24 pre-existing `src/webmcp` tests still pass.

---

## 7. The twelve workflows — `src/agent/session.test.ts`

Each drives the real session loop, the real tool host, the real planner and the
real kernel. Only the model is scripted, through
`src/agent/__fixtures__/scriptedTransport.ts` (test-only; `boundary.test.ts`
asserts no production module can reach it).

| # | Workflow | Result |
|---|---|---|
| 1 | Inspection | Reads `scene_overview` + `validate_model` at r1, answers from measured counts, revision unchanged, no waves. A `preflight_*` call in Inspect returns `READ_ONLY_MODE`. |
| 2 | Local edit | `selection_geometry` then `preflight_placement` (`3001` under `part_0001`); the solver returns a pose; wave pending at r1; accept → r2, 34 parts, transaction author `human`. |
| 3 | Generator use | Model notices the hard 10 × 14 envelope, widens it with `set_dimension_limit`, then `build_wall` 8 × 3 at `[400,0,400]`; report shows 3 courses and a running bond; `acceptAll` → r3. |
| 4 | Refinement request | `@selection` arrives in the grounding already resolved to `['part_0001','part_0002']`; `create_subassembly` wave accepted; the assembly exists. |
| 5 | Impossible part | `catalog_search` finds nothing; `preflight_placement` with `sarlacc-9000` returns `PART_DEFINITION_NOT_FOUND`; `cadEngine.preflight` was never called; no wave. |
| 6 | Ambiguous request | Brief conflicts travel in `grounding.brief.conflicts`; the model asks which of car/truck; no wave; revision unchanged. |
| 7 | Cancellation mid-stream | `cancel()` during the hold → status `cancelled`, transcript entry `cancelled` with the reason, **zero pending trace entries**, no waves. |
| 8 | Stale revision | Two waves at r1; a human deletes `part_0003`; the rebasable wave is re-planned at r2 and still applies, the other goes `stale` naming `part_0003`; accepting it fails loudly and posts a notice. |
| 9 | Protected region | `create_subassembly` over `part_0023` → `PROTECTED_REGION` at proposal time; `cadEngine.execute` never called. |
| 10 | Collision repair | `duplicate_selection` at offset `[0,0,0]` previews collisions; accept refused with `COLLISION`; `repair_suggest` reports the pair, the measured overlap and a clearance; the retried wave at `[0,-400,0]` is clean and lands at r2. |
| 11 | Rejected proposal | `feedback(waveId, reason)` rejects the wave, leaves r1 untouched, and sends the reason as the next user turn — asserted present in the outgoing transcript. |
| 12 | Multi-wave accept | Three waves proposed in one leg; `acceptAll` applies them in order, rebasing between each; r1 → r4 with all three effects present. |

Plus, in the same file: hallucinated part / assembly / note / constraint / module
ids all refused before `commandBus`; a misspelled capability argument refused;
transport failure → error state → `retry()` recovers; the tool budget stops the
loop; `replan()` withdraws pending waves; Build mode auto-commits through the
same `WaveLedger.apply`.

### The named gates

| Gate | Where | Result |
|---|---|---|
| ≥ 30 prompt fixtures, stable and editable | `__fixtures__/prompts.json`, `brief.test.ts` | 40 prompts, 12 ambiguous. Each compiles identically twice; ambiguous ones populate `conflicts` with details > 20 chars; unambiguous ones have none. |
| Propose is mutation-free | `modes.test.ts` | 35 proposals in a row leave revision, name, colour and the transaction list untouched. |
| No hallucinated identity reaches the kernel | `session.test.ts` | `vi.spyOn(cadEngine, 'preflight' \| 'execute')` — neither called; the error names the id and the revision. |
| One undoable history | `modes.test.ts` | human → agent → human → agent interleaved, then four undos and four redos walk across both authors. |
| Capability-schema parity | `schemas.test.ts` | 44 assertions across all 35 capabilities. |
| Existing `src/webmcp` tests | `npx vitest run src/webmcp` | 24 passed. |
| Component + accessibility | `AgentWorkbench.test.tsx` | 18 tests: empty, streaming, pending, cancel, error alert, wave review, accept, reject, accept-all, tool outcomes, reference chips, mode switch, trace, collapse/expand with focus restore, `hidden` when collapsed, labels and live regions, keyboard send/Escape, `prefers-reduced-motion`. |
| Live provider | `server/assistant/live.test.ts` | Ran for real — output in §9. |

---

## 8. Honest limits — things this does *not* claim

- **`render_capture` returns pixels only when something can produce them.**
  With `render` wired it rasterises through `src/cad/raster.ts` and reports
  measured `coverage`; with a live canvas it reads the viewport; with neither it
  returns exact framing, bounds, stud sizes and part counts together with
  `pixelsAvailable: false` and the reason. It never describes an image it does
  not have. The test-suite path is the third one.
- **Waves are planned against one revision.** Two waves proposed in the same
  turn do not see each other's changes. Accepting one rebases the rest by
  re-running preflight; a wave that no longer applies is marked `stale` with the
  kernel's own message rather than left with a button that silently fails.
- **Structured-output schemas are pruned before they are advertised.** The API
  rejects `minimum`/`maximum` on numbers and `minItems`/`maxItems` on arrays
  (measured, not assumed — `minLength`, `maxLength`, `pattern` and `enum` are
  accepted). `pruneToSupportedSchema` removes those keywords from the advertised
  schema. They are still enforced: `ModelRequest.parse` runs on every attempt,
  and a violation costs one correction then a rejection.
- **"Retried once" is split across the boundary for the browser path.** The API
  process can only apply a shallow structural check to a caller-supplied JSON
  Schema (root type and required keys), because it has no JSON Schema validator;
  that shallow check is what earns the free retry. The authoritative Zod parse
  runs in the caller and throws. A server-side caller — including the live smoke
  test — passes a real Zod parse, so its retry-once path is fully Zod-validated.
- **`server/assistant/**` is not in any `tsconfig` include list.** It is
  type-checked with an explicit invocation (§10); the integrator may want to add
  it to `tsconfig.node.json`.
- **The panel is wired into `src/App.tsx`.** §3 is the live composition root;
  this workstream still must not edit files it does not own, but the integrator
  has listed the contribution.
- **Not proven here:** behaviour under a real network partition mid-stream
  (simulated only, by aborting the fake), and multi-user concurrency — the
  document is single-writer within a browser session, and cloud collaboration
  belongs to workstream 8.

---

## 9. Live provider smoke test

```bash
npm run test:live:assistant
# = BRICKWRIGHT_LIVE_TESTS=1 vitest run server/assistant/live.test.ts --reporter=verbose
```

Gated on an explicit opt-in **and** the credential:
`BRICKWRIGHT_LIVE_TESTS === '1' && ANTHROPIC_API_KEY`. A developer shell usually
carries a model key for the running application, and `npm test` must not turn
that ambient credential into a paid, nondeterministic network test. When the
suite is skipped it says so through a companion test that asserts the reason,
rather than vanishing from the report.

Actual output, run on 2026-08-28 against `claude-sonnet-5`:

```
[live] model: claude-sonnet-5

[live] structured value: {
  "summary": "A standard LEGO 2x4 brick measures 2 studs wide by 4 studs long.",
  "studsPerBrickLength": 4,
  "confident": true
}

[live] provenance: {
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "promptHash": "fnv1a:f4efdf01",
  "seed": 4204170187,
  "createdAt": "2026-08-28T14:23:45.570Z"
}

[live] usage: { "inputTokens": 383, "outputTokens": 58 }
 ✓ satisfies the ModelProvider contract against the real API 2726ms

[live] event types: [ "start", "turn", "tool_call", "tool_call", "usage", "done" ]

[live] tool calls: [
  { "id": "toolu_018SXJsoBpxwiRBRAeuGHoJ1", "name": "scene_overview", "input": {} },
  { "id": "toolu_01UEoq8qjg5cjGfg5Stp9ow4", "name": "scene_query",
    "input": { "partIds": ["part_0001"] } }
]

[live] usage: { "inputTokens": 312, "outputTokens": 222 }

[live] stop: { "type": "done", "stop": "tool_use" }
 ✓ streams a grounded turn through the real route and asks for a real tool 2952ms

 Test Files  1 passed (1)
      Tests  2 passed | 1 skipped (3)
```

The point of the second test is the `stop: "tool_use"`. Asked what is in the
chassis and what is selected, the model reached for `scene_overview` and
`scene_query` instead of answering from the grounding block it had already been
given. That is the behaviour the system prompt is written to produce, and it is
the difference between a partner that reads the model and one that guesses about
it.

An earlier run of the same test showed the model asking for
`scene_query { subassemblyId: "Chassis" }` — the display name rather than the id
`chassis`. The tool would have returned zero matches and the model would have
had to correct itself. The tool descriptions could name that distinction more
sharply; recorded here rather than papered over.

Also measured live: a first pass failed with
`output_config.format.schema: For 'integer' type, properties maximum, minimum
are not supported`. That is what produced `pruneToSupportedSchema` (§8) — the
supported keyword set was established by probing the API, not by guessing.

## 10. Verification

```
$ npx tsc -p tsconfig.app.json --noEmit 2>&1 | head -30
(no output)

$ npx vitest run src/agent src/webmcp 2>&1 | tail -30
 Test Files  10 passed (10)
      Tests  282 passed (282)

$ npx vitest run server/assistant
 Test Files  6 passed (6)
      Tests  50 passed | 2 skipped (52)

$ npm run test:live:assistant
 Test Files  1 passed (1)
      Tests  2 passed | 1 skipped (3)

$ npx tsc --noEmit --ignoreConfig --target ES2022 --module ESNext \
    --moduleResolution Bundler --lib ES2022,DOM --strict --skipLibCheck \
    --esModuleInterop --allowImportingTsExtensions --resolveJsonModule \
    --types node,react server/assistant/index.ts
(no output)

$ npm run serve:api & curl -s http://127.0.0.1:8787/api/health
[api] listening on http://127.0.0.1:8787 with 2 route module(s): /api/assistant, /api/
{"ok":true,"routes":["/api/assistant","/api/"]}
```

In the default `npx vitest run server/assistant` the two skips are the live
tests, held back by `BRICKWRIGHT_LIVE_TESTS`; in `npm run test:live:assistant`
the one skip is the companion that documents why they would be held back. Both
reports name the reason rather than quietly omitting the suite.
