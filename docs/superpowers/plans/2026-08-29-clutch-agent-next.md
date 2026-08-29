# Clutch, bond quality, and copy-pasteable agent next-steps

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** Refuse every remaining illegal single-part placement an operator or agent can still perform, rank generated builds by real brickwork (not only tipping), and give the assistant structured next-tool arguments so it cannot invent a plan.

**Architecture:** The kernel stays the only writer. Placement legality (`legal` on `resolvePlacement`) is wired into the viewport so a click cannot look successful and then fail. Occupied studs are a different refusal from a tile (`CONNECTOR_OCCUPIED` vs `NO_COMPATIBLE_CONNECTOR`). Generation scores stacked seams through the same topology refinement already uses. Agent tools return `next.args` — JSON the model can resend unchanged.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), generation (`src/generation`), assistant tools (`src/agent`), workbench (`src/editor`), Vitest.

**Spec:** Operator instruction: build like LEGO, do not let you build where it cannot be built, better builds, an AI agent must not be confused. Continue beyond collision/hover/tile-rest/`REPEAT_REFUSED`.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- No fake testimonials. Landing CTAs unchanged.
- Undo/redo stay on `replay`, not the commit gates.
- Bulk wall/flap transactions skip single-brick floating/rest gates.
- Two buildings on the table remain legal.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/snapping.ts` | Occupied-vs-absent stud counts already in `connectorAvailability`. |
| `src/cad/placement.ts` | `legal` already computed; viewport must honour it. |
| `src/cad/engine.ts` | Existing DISCONNECTED / NO_COMPATIBLE_CONNECTOR gates stay. |
| `src/editor/CadViewport.tsx` | Preview and commit only legal poses; refuse clicks on tiles. |
| `src/editor/workbench/useWorkbench.ts` | `placeArmed(transform, legal)` toasts without dispatching illegal poses. |
| `src/generation/score.ts` | `stackedSeamCount`; rank on it. |
| `src/agent/guidance.ts` | `args` on `AgentNextStep`; floating → `scene_query` first. |
| `src/agent/protocol.ts` / `server/assistant/protocol.ts` | `nextTool`, `nextArgs` on grounding. |
| `src/agent/tools.ts` | Occupied vs tile refusal; alternatives; scene_query approaches; nextArgs. |
| `server/assistant/prompt.ts` | NEXT_TOOL / NEXT_ARGS lines; CONNECTOR_OCCUPIED. |

## Task 1 — Viewport honours `legal`

Click-to-place currently previews and commits unmated poses on a part; the kernel toasts after the fact. The ghost must not look placeable, and the click must toast `[NO_COMPATIBLE_CONNECTOR]` without a failed commit.

- [x] PlacementController stores `{ transform, legal }`.
- [x] `onPreview(legal ? transform : null)`.
- [x] `onPlace(transform, legal)` — workbench toasts and returns when `legal === false`.
- [x] Keyboard Enter uses the preview; illegal preview is null so it cannot place.

## Task 2 — Occupied studs ≠ tile

`preflight_placement` today returns `NO_COMPATIBLE_CONNECTOR` for both “this is a tile” and “every stud is taken”. Agents retry the same face. Return `CONNECTOR_OCCUPIED` when the anchor has studs but none are free; include `openApproaches`, `occupiedExclusive`, and placeable alternative identities.

Done. Snap-under on an occupied or tile face is rejected via `poseMatchesApproach` before the occupancy code is chosen.

## Task 3 — Structured next args

Done. Grounding carries `nextTool` + `nextArgs`. Prompt: call `nextTool` with `nextArgs` unchanged.

## Task 4 — scene_query approaches

Done. Each listed part includes `approaches` (and `occupiedExclusive`) from one connection derivation.

## Task 5 — Better generated builds

Done. `stackedSeamCount` from `extractRows` + `findStackedSeams`. Rank fewer stacked seams after overload. Not hard-gated.

## Out of scope

Flexible hoses, BrickLink pack floors, catalog pack floors, Hexclave, landing motion, commits.
