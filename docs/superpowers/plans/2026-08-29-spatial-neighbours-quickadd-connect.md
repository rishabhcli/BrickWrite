# Spatial neighbours, legal quick-add/connect, hit-face approaches, 1-stud ranking

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** A hovering brick reports nearby parts by distance, not only graph edges. Palette `+` and Connect commit the same legal mates as click-to-place. Side clicks classify a face. Generated 1×1 stacks rank worse. The agent mates an existing floating part with `connect_parts` instead of inventing a new brick.

**Architecture:** Nearby search is AABB separation in `geometry.ts`. Placeable neighbour lookup stays next to `placeableAnchors`. Placement owns hit-face classification, quick-add, and legal connect poses. `connect_parts` reuses `searchMateOnTarget` so occupancy and collision codes match the rest of the kernel. Agent `scene_query` publishes `nearby` beside graph `connectedTo`.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant (`src/agent`), generation (`src/generation`), Vitest.

**Spec:** Build like LEGO. Do not let you build where it cannot be built. Better builds. An AI agent must not be confused. Continue beyond collision-aware ghosts, clutch ranking, and the repair loop break.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- No fake testimonials. Landing CTAs unchanged.
- Undo/redo stay on `replay`, not the commit gates.
- Bulk wall/flap transactions skip single-brick floating/rest gates.
- Two buildings on the table remain legal.
- Do not invent part ids or XYZ.
- Do not auto-reject colliding `duplicate_selection` waves — Propose may show a colliding ghost; Apply still refuses.
- Collision policy stays in `collisionGate.ts`, not `collision.ts`.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/geometry.ts` | `aabbSeparation`, `nearbyParts`. |
| `src/cad/snapping.ts` | `nearestPlaceableNeighbour`. |
| `src/cad/placement.ts` | `hitApproach`, `resolveQuickAdd`, `legalConnectCandidates`, `firstLegalSnap`, `searchMateBetween`. |
| `src/cad/capabilities.ts` | `connect_parts` uses `searchMateBetween`; `COLLISION` / `CONNECTOR_OCCUPIED`. |
| `src/editor/workbench/useWorkbench.ts` | `addPart` via `resolveQuickAdd`; `handleTransform` via `firstLegalSnap`; single-part `commitTransforms` gated. |
| `src/editor/workbench/ConnectPanel.tsx` | Rank only `legalConnectCandidates`. |
| `src/agent/guidance.ts` | Floating next-step is `connect_parts` when both ids are measured. |
| `src/agent/tools.ts` | `scene_query.nearby`; live situation fills floating/nearby ids; placement preview collisions fail. |
| `src/refinement/topology.ts` | `oneStudStackCount`. |
| `src/generation/score.ts` | Rank fewer 1×1 stacks after clutch. |

## Task 1 — Spatial neighbours

A hovering brick has no connection edges, so `connectedTo: []`. `nearbyParts` lists other parts by AABB distance. `scene_query` with `includeNeighbours` returns both `connectedTo` and `nearby` (id, distanceLdu, approaches).

`nearestPlaceableNeighbour` walks nearby ids and returns the first `placeableAnchors` hit.

## Task 2 — Agent mates the hovering brick

`DISCONNECTED` with `floatingPartId` + `nearbyAnchorId` → `preflight_capability` `connect_parts` `{ movingPartId, targetPartId }`. Without a nearby id, `scene_query` is scoped to `{ includeNeighbours: true, partIds: [floatingPartId] }`. Grounding and overview fill those ids from the live document.

## Task 3 — connect_parts and Connect panel

`searchMateBetween` tries on-top, then other faces, skipping colliding poses. Failures: `COLLISION`, `CONNECTOR_OCCUPIED`, `NO_COMPATIBLE_CONNECTOR`. Connect panel filters candidates with `poseRefusal`.

## Task 4 — Quick-add, hit face, numeric snap

`resolveQuickAdd` is `resolvePlacement` on the selection’s top centre (or a ground rest beside the model). `hitApproach` picks the closest AABB face; side clicks try that face then fall back to on-top. `handleTransform` walks snap candidates like the gizmo. Single-part inspector nudges refuse `poseRefusal`.

## Task 5 — Placement preflight does not leave a colliding ghost

If `preflight_placement` proposes a wave whose preview has collisions, reject the wave and fail `COLLISION`. Do not apply this to `preflight_capability` in general.

## Task 6 — Better generated builds

`oneStudStackCount`: slim footprint (≤ 1.25 studs on X and Z) stacked on another slim part. Ranked after `meanExclusiveMates`. Not a hard gate.

## Out of scope

Flexible hoses, BrickLink pack floors, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques, SNOT catalog completeness.
