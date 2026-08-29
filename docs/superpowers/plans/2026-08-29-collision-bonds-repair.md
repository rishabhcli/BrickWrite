# Collision-aware ghosts, clutch ranking, and a repair path that does not loop

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** A click or drag that would interpenetrate two unconnected parts never looks legal. When remaining free studs exist beside a colliding pose, land on those studs. Generated candidates with more exclusive mates rank higher. After `repair_suggest`, the next tool is a measured query or preflight — never `repair_suggest` again.

**Architecture:** Collision introduction is one function shared by the engine, placement, and drag preview. Unverified box overlaps between *unconnected* parts refuse (a brick slid into another brick). Unverified overlaps between *already mated* parts stay allowed (hinge flaps). Mate search walks snap candidates and skips colliding poses. Agent collision next-steps are copy-pasteable.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant (`src/agent`), generation (`src/generation`), Vitest.

**Spec:** Build like LEGO. Do not let you build where it cannot be built. Better builds. An AI agent must not be confused. Continue beyond occupancy codes, target-restricted slide, `poseRefusal` hover/rest, and occupied `preflight_placement` next-steps.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- No fake testimonials. Landing CTAs unchanged.
- Undo/redo stay on `replay`, not the commit gates.
- Bulk wall/flap transactions skip single-brick floating/rest gates.
- Two buildings on the table remain legal.
- Hinge / pin / axle motion that box-overlaps a *mated* partner remains legal when certainty is `unknown`.
- Do not invent part ids or XYZ. Alternate anchors must exist.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/collision.ts` | `introducedCollisions`, `partPoseCollides`. Unconnected unverified overlap blocks. |
| `src/cad/engine.ts` | Commit path uses `introducedCollisions`. Transform into an unconnected brick is `COLLISION`. |
| `src/cad/placement.ts` | Mate search walks candidates, skips collisions; `reason: 'collision'`. Ground snap that collides falls back to a second building. |
| `src/cad/validation.ts` | `poseRefusal` returns `COLLISION`. |
| `src/editor/CadViewport.tsx` | Drag walks snap candidates; first pose `poseRefusal` allows. |
| `src/editor/workbench/useWorkbench.ts` | Collision toast; `handleTransform` does not dispatch a refused pose. |
| `src/agent/guidance.ts` | `seenRepair` breaks the repair loop; `NO_COMPATIBLE_CONNECTOR` can preflight a measured free anchor. |
| `src/agent/tools.ts` | Preflight fails `COLLISION` when every mate collides; `repair_suggest` sets `seenRepair`. |
| `src/generation/score.ts` | `meanExclusiveMates`; rank more clutch after stacked-seam. |

## Task 1 — Shared introduced-collision filter

Done. `src/cad/collisionGate.ts`. `part.add` still refuses unverified overlaps. Single-part `part.transform` refuses unverified overlaps between unconnected parts. Multi-part motion (hinge flaps) keeps the old unknown-overlap allowance.

## Task 2 — Placement slides around collisions

Done. `searchMateOnTarget` walks snap candidates, skips `partPoseCollides`. `reason: 'collision'` when every candidate collides. Ground snap that collides falls back to a second building.

## Task 3 — Drag and numeric transform match commit

Done. Gizmo walks snap candidates; `poseRefusal` includes `COLLISION`. `handleTransform` toasts and does not dispatch. Click-to-place toasts `[COLLISION]`.

## Task 4 — Agent does not loop repair_suggest

Done. `seenRepair` on `repair_suggest` results. Tile refusals with a measured free anchor copy the occupied preflight next-step. Preflight fails `COLLISION` when every mate collides.

## Task 5 — Better generated builds

Done. `meanExclusiveMates` ranked after stacked seams. Not a hard gate.

## Out of scope

Flexible hoses, BrickLink pack floors, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques.
