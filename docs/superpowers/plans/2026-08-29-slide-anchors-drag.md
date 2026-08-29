# Slide to remaining clutch, legal drags, and copy-pasteable alternate anchors

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** When a face still has free studs, land on those studs instead of refusing the click; when it does not, name occupied vs tile; never show a drag ghost that cannot be committed; give the assistant a concrete next anchor with free studs.

**Architecture:** Placement searches the *hit part only*, then widens to that part’s full footprint so remaining free studs are visible. Drag preview uses the same clutch/rest gates as commit. Occupied supports are `CONNECTOR_OCCUPIED` in the engine. Scene overview and occupied refusals list `placeableAnchors`; next-step args can be a real `preflight_placement` onto one of them.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant tools (`src/agent`), Vitest.

**Spec:** Operator instruction: build like LEGO, do not let you build where it cannot be built, better builds, an AI agent must not be confused. Continue beyond occupancy codes, snap-under filtering, stacked-seam ranking, and `nextArgs`.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- No fake testimonials. Landing CTAs unchanged.
- Undo/redo stay on `replay`, not the commit gates.
- Bulk wall/flap transactions skip single-brick floating/rest gates.
- Two buildings on the table remain legal.
- Do not invent part ids or XYZ for the agent; alternate anchors must be ids that exist.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/placement.ts` | Target-restricted mate search; widen to remaining free studs; `reason` on `ResolvedPlacement`. |
| `src/cad/validation.ts` | `poseRefusal` for a single-part preview pose; rest support ids. |
| `src/cad/engine.ts` | Unclutched rest → `CONNECTOR_OCCUPIED` when the support had studs that are all taken. |
| `src/cad/snapping.ts` | `placeableAnchors` — unlocked parts with free on-top studs. |
| `src/editor/CadViewport.tsx` | Placement reason; drag ghost hidden when `poseRefusal` is set; skip illegal drag commit. |
| `src/editor/workbench/useWorkbench.ts` | Occupied vs tile toast; `onPlace` reason. |
| `src/agent/guidance.ts` | Occupied + known free anchor → `preflight_placement` with that id. |
| `src/agent/tools.ts` | Same mate search as placement; `placeableAnchors` on overview and occupied details. |

## Task 1 — Slide to remaining free studs

Clicking the occupied end of a plate that still has free studs must clutch those studs (LEGO: you shift). Snap is restricted to the hit part so a tile click cannot steal a neighbour’s studs from underneath.

## Task 2 — Refusal reason in the viewport

`legal: false` distinguishes `occupied` / `absent`. Toast `[CONNECTOR_OCCUPIED]` vs `[NO_COMPATIBLE_CONNECTOR]`.

## Task 3 — Drag ghost matches commit

A translate drag that would hover or rest unclutched shows no ghost and does not dispatch. Engine still gates any path that bypasses the viewport.

## Task 4 — Engine occupancy code

Newly introduced unclutched rest on a support whose on-top studs are all taken is `CONNECTOR_OCCUPIED`; a tile remains `NO_COMPATIBLE_CONNECTOR`.

## Task 5 — Agent alternate anchors

`scene_overview.placeableAnchors`. Occupied preflight details include them. If one exists, `nextArgs` is `preflight_placement` on that id with the same identity.

## Out of scope

Flexible hoses, BrickLink pack floors, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques.
