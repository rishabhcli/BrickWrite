# Bulk clutch gates, one-transaction nudge, collision-aware generation snaps

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** Multi-part moves keep clutch (keyboard nudge is one transaction). Align/lift cannot newly hover or rest unclutched. Generated attachments skip colliding snap poses. Duplicate/array copies that float are refused. Agents get a next `connect_parts` target when a mate fails.

**Architecture:** Engine pose integrity applies to every *moved* part, not only single-brick edits. Walls stay bulk-add exemptions. Keyboard nudge goes through `commitTransforms`. Generation walks snap candidates like click-to-place. Planner copies are previewed for floating/rest before they become a wave.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant (`src/agent`), generation (`src/generation`), Vitest.

**Spec:** Build like LEGO. Do not let you build where it cannot be built. Better builds. An AI agent must not be confused. Continue beyond spatial neighbours, legal quick-add/connect, hit-face approaches, and 1-stud stack ranking.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- Undo/redo stay on `replay`.
- Bulk *adds* (walls, storeys, fields) still skip single-brick floating/rest gates.
- Two buildings on the table remain legal.
- Hinge flaps remain legal (moved parts stay clutched via the joint).
- Do not invent part ids or XYZ.
- Collision policy stays in `collisionGate.ts`.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/engine.ts` | Floating/rest gates on every moved part. Repair copy mentions `connect_parts`. |
| `src/cad/capabilities.ts` | Duplicate/array copies that float or rest unclutched refuse. `connect_parts` details include another nearby id. |
| `src/editor/workbench/useWorkbench.ts` | `nudgeSelection` one transaction. |
| `src/editor/CadViewport.tsx` / `ViewportKeyboard.tsx` | Multi-select arrows call `nudgeSelection`. |
| `src/editor/workbench/TransformPanel.tsx` | Snap seats filtered by `poseRefusal`. |
| `src/generation/realize.ts` | Walk snap candidates; skip colliding poses. |
| `src/refinement/strategies/support.ts` | `snapOnto` skips `partPoseCollides`. |
| `src/agent/tools.ts` | Capability refusals attach copy-pasteable `next`. `selection_geometry` includes spatial `nearby`. |
| `src/refinement/topology.ts` / `src/generation/score.ts` | `maxOneStudColumnHeight` ranking. |

## Out of scope

Flexible hoses, BrickLink, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques.

## Policy

### Engine pose integrity

Gate **every moved** part for new floating / new unclutched rest.

Gate **added** parts only when it is a single add (`addedIds.length === 1 && movedIds.length === 0`).

Many adds (walls, storeys, fields) still skip. Hinge flaps are multi-move but stay clutched via the joint.

Lifting the entire document together is still legal: `floatingPartIds` measures ground as the lowest brick in the scene, so a remaining grounded brick is required to refuse a bulk lift.

### Keyboard nudge

`ViewportKeyboard` used sequential `onTransform` per part. A clutched stack could lose clutch after the first brick moved.

When `selection.length > 1`, call `nudgeSelection(dx, dz)` → `commitTransforms` as one transaction.

Single-part arrows still go through `handleTransform` (connector snap + poseRefusal).

### Copies

`duplicate_selection` / `linear_array` preview the added parts. If a new id is floating or newly unclutched, throw `DISCONNECTED` / rest codes at plan time.

Do **not** refuse colliding `duplicate_selection` waves (`offset [0,0,0]`): Propose may show a colliding ghost; Apply still refuses COLLISION.

### Generation snaps

`realize` walks `findSnapCandidates` and skips poses `rejectionFor` refuses.

`snapOnto` skips `partPoseCollides`.

### Agent next

`connect_parts` failures include `nearbyPartId` (not the failed target). `preflight_capability` attaches `next` as `connect_parts` with those ids.

`selection_geometry` returns spatial `nearby` with approaches, same shape as `scene_query`.

### Ranking

`maxOneStudColumnHeight` after `oneStudStackCount`. Not a hard gate.

## Tasks

1. Engine: pose integrity on every moved part. Repair copy mentions `connect_parts`.
2. Keyboard multi-nudge as one transaction. TransformPanel legal seats.
3. Duplicate/array refuse floating or unclutched copies.
4. Realize and snapOnto skip colliding poses.
5. `connect_parts` next + `selection_geometry` nearby.
6. `maxOneStudColumnHeight` ranking.
7. Tests: engine stack-nudge / bulk-lift, capabilities hover-copy / connect nearby, tools nearby + next, panels keyboard nudge, score ranking, topology column height, hinge/wall still pass.

## Verification

```
npx vitest run src/cad/engine.test.ts src/cad/capabilities.test.ts src/cad/articulation.test.ts src/cad/assembly.test.ts src/agent/tools.test.ts src/editor/workbench/panels.test.tsx src/generation/score.test.ts src/refinement/analyse.test.ts src/refinement/strategies.test.ts src/generation/pipeline.test.ts src/webmcp/surfaces.test.ts
```

Do not commit or push.
