# Rigid quarter-turn, legal stamps, repair without XYZ, floating hard-gate

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** A multi-part quarter-turn keeps clutch (rigid rotate about the selection centre). Stamps and stacked storeys that hover or rest unclutched are refused. `repair_suggest` never tells the model to invent XYZ. Generated candidates with hovering bricks are not offered.

**Architecture:** Toolbar/shortcut rotate uses the same `rotatePose` + shared pivot the Transform panel already has. Stamp/stack reuse `refuseIllegalAdds`. Repair reports measured overlaps as facts and a copy-pasteable `next`. Generation hard-gates `floatingPartCount` the same way it already hard-gates unclutched rest.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant (`src/agent`), generation (`src/generation`), Vitest.

**Spec:** Build like LEGO. Do not let you build where it cannot be built. Better builds. An AI agent must not be confused. Continue beyond bulk clutch, one-transaction nudge, collision-aware snaps, and 1×1 column ranking.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- Undo/redo stay on `replay`.
- Bulk *adds* (walls, storeys, fields) still skip the engine’s single-add floating gate; the *planner* still refuses hovering stamp/stack copies.
- Two buildings on the table remain legal (`floatingPartIds` is empty for them).
- Hinge flaps remain legal.
- Do not invent part ids or XYZ.
- Collision policy stays in `collisionGate.ts`.
- Do not hard-gate stacked seams or 1-stud techniques.
- Do not auto-reject colliding `duplicate_selection` waves.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/editor/workbench/transform.ts` | `planRotateSelection`: one part about its origin; many parts about the selection centre. |
| `src/editor/workbench/useWorkbench.ts` | Quarter-turn commits that plan as one transaction. |
| `src/cad/capabilities.ts` | `stamp_module` / `stack_selection` `refuseIllegalAdds`. Optional `anchorPartId` for stamp. |
| `src/agent/schemas.ts` | Optional `anchorPartId` on `stamp_module`. |
| `src/agent/tools.ts` | `repair_suggest` does not recommend invented XYZ; includes floating + `next`. |
| `src/generation/score.ts` | `floatingPartCount` hard gate. |

## Out of scope

Flexible hoses, BrickLink, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques, rewriting wall planners, import-time LDraw repair.

## Policy

### Rigid quarter-turn

One selected part: local 90° about its own origin (the brick-turn a builder means).

Two or more: world 90° about the selection’s measured centre. Relative clutch is a rigid motion, so a stack stays a stack. Sequential per-origin rotates are what used to pull a wall apart.

Commit through `commitTransforms` so a single illegal brick is toasted with `poseRefusal` and a multi-part turn is one revision.

### Stamps and storeys

`refuseIllegalAdds` already refuses hovering duplicate/array copies. Apply it to `stamp_module` and `stack_selection`.

If `anchorPartId` is a current part, stamp `atLdu` is that part’s measured top-min corner (`getPartBounds`.min). The agent copies an id; it does not invent XYZ. Explicit `atLdu` still works for the human command deck.

### Repair

`suggestedClearanceLdu` stays a measured overlap. The `suggestion` sentence must not say “move by these coordinates”. `next` is the tool to call. Floating ids go on the payload so `connect_parts` is copy-pasteable.

### Generation

A hovering brick is not a candidate. `floatingPartCount > 0` fails `evaluateHardGates`. Two grounded buildings have `floatingPartCount === 0`.

## Tasks

1. `planRotateSelection` + tests (relative offset preserved).
2. Workbench quarter-turn uses it; one transaction.
3. Stamp/stack refuse illegal adds; stamp `anchorPartId`.
4. `repair_suggest` without XYZ instructions; floating `next`.
5. `floatingPartCount` metric + hard gate.
6. Tests: cad/agent/editor/generation. Fix fallout.

## Verification

```
npx vitest run src/editor/workbench/transform.test.ts src/editor/workbench/panels.test.tsx src/cad/engine.test.ts src/cad/capabilities.test.ts src/cad/assembly.test.ts src/agent/tools.test.ts src/agent/session.test.ts src/generation/score.test.ts src/webmcp/surfaces.test.ts
```

Do not commit or push.
