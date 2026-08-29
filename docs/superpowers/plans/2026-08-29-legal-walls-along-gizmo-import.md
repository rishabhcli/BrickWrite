# Legal walls, measured copy pitch, rigid multi-gizmo, import clutch report

> **For agentic workers:** Execute inline on dirty `main`. Do not commit or push unless the operator asks. Do not ask the operator questions.

**Goal:** Generated walls, storeys, floors and buildings clutch or rest like a single brick. Agents copy an id or a direction (`along`), not XYZ. A multi-part gizmo drag is one rigid motion. An LDraw import says when parts hover or collide. Generated regions that would hover next to an existing building are not kept.

**Architecture:** Reuse `refuseIllegalAdds` and `seatStampOnAnchor` on parametric assemblies. Compute duplicate/array offsets from measured bounds. Group gizmo applies the same world delta/yaw the keyboard nudge and quarter-turn already use. Import reports kernel measurements; it does not auto-repair. Realiser `rejectionFor` hard-gates floating and unclutched rest the same way scoring already does.

**Tech Stack:** Existing TypeScript kernel (`src/cad`), workbench (`src/editor`), assistant (`src/agent`), generation (`src/generation`), Vitest.

**Spec:** Build like LEGO. Do not let you build where it cannot be built. Better builds. An AI agent must not be confused. Continue beyond rigid quarter-turn, legal stamps, repair without XYZ, and floating hard-gates.

## Global Constraints

- Dirty `main`; no commit/push unless asked.
- Hexclave stays off the `/` static graph.
- Undo/redo stay on `replay`.
- Engine still skips single-add floating/rest on *bulk add transactions*; the *planner* refuses hovering/unclutched assemblies before they become a wave.
- Two buildings on the table remain legal (`floatingPartIds` is empty for them). A wall in mid-air *beside* a grounded brick is not.
- Hinge flaps remain legal.
- Do not invent part ids or XYZ.
- Collision policy stays in `collisionGate.ts`.
- Do not hard-gate stacked seams or 1-stud techniques.
- Do not auto-reject colliding `duplicate_selection` waves.
- Do not auto-repair imported LDraw.
- User instructions override skill approval gates for this turn.

## Files

| File | Responsibility |
|---|---|
| `src/cad/capabilities.ts` | Assembly clutch gates; stud-plane origin; `anchorPartId` + seat; `along`; mirror `about`. |
| `src/agent/schemas.ts` | Optional `anchorPartId` / `along` / `about` matching advertised input. |
| `src/agent/toolschemas.ts` | Copy-pasteable ids and `along`; do not invent originLdu. |
| `src/generation/realize.ts` | `rejectionFor` floating + unclutched rest; extra host-stud lattice offsets. |
| `src/generation/repair.ts` | Merge extra host offsets into region attempts. |
| `src/cad/ldraw.ts` | Import report includes floating / unclutched / collision counts. |
| `src/editor/workbench/transform.ts` | `planTranslateSelection` / `applyRigidMotion`. |
| `src/editor/CadViewport.tsx` | Multi-select gizmo as one rigid drag. |
| `src/editor/workbench/useWorkbench.ts` | Commit group gizmo through `commitTransforms`. |

## Out of scope

Flexible hoses, BrickLink, Hexclave, landing, commits, hard-gating stacked seams or 1-stud techniques, rewriting `planWall` itself, auto-deleting illegal imported parts.

## Policy

### Assemblies clutch or they are refused

`build_wall`, `build_enclosure`, `build_field`, `build_hinged_flap`, and `build_structure` run `refuseIllegalAdds` after planning.

Empty plate + wall at `[0,0,0]`: legal (first building).

Grounded brick already present + wall at `[0,-200,0]`: `DISCONNECTED`.

Wall on a tile with no clutch: rest codes, same as a single brick.

### Measured origin, not AABB top or invented XYZ

`assemblyOrigin` uses the selection/anchor **stud plane** (`studPlaneLdu`) and snapped min X/Z — the same corner `stampOriginOnAnchor` uses — not the AABB `min` Y (stud tips).

If `anchorPartId` is a current part, origin is that part’s stud-plane corner, then `seatStampOnAnchor` rigidly seats every added part. The agent copies an id.

If the operator has a selection and omits `originLdu`, origin is the selection’s stud-plane corner and the first selected part is the seat target.

Explicit `originLdu` still works for the command deck. It is not seated unless `anchorPartId` is also set.

### Duplicate / array without invented pitch

`along: 'x' | 'z' | 'on-top'` measures the selection AABB (or stack pitch for `on-top`) and uses that as the copy vector. `offsetLdu` remains for humans who typed a vector.

`linear_array` requires `offsetLdu` **or** `along`.

### Mirror about the selection

`about: 'world' | 'selection'`, default `world` (plane `x = axisLdu`, default 0). `selection` uses the selection’s measured centre X so a clutched group reflects in place.

### Generation regions

`rejectionFor` fails when any new part is in `floatingPartIds` or newly in `unclutchedRestPartIds`.

Region attempts include whole-stud offsets from remaining free host connectors relative to the primary host — slide to remaining studs, not only ±1/±2.

### Import report

`parseLDraw` measures the imported document. `describeLDrawImport` mentions hovering parts, unclutched rest, and collisions. The file is still imported.

### Rigid multi-gizmo

Two or more selected parts: gizmo at the selection centre. Translate applies one world delta (grid-snapped) to every part. Rotate applies world yaw about that centre. One `commitTransforms` transaction. No per-part connector snap (that walks a stack off its studs). Single-part gizmo unchanged.

## Tasks

1. Failing tests: hovering wall beside a building; wall onto `anchorPartId`; `along` duplicate; import report; hovering generated region; rigid translate preserves offset.
2. Implement assemblies + schemas + toolschemas.
3. Implement generation rejection + host slides.
4. Implement import report.
5. Implement `planTranslateSelection` + viewport group gizmo.
6. Run cad/agent/generation/editor tests. Fix fallout.

## Verification

```
npx vitest run src/cad/capabilities.test.ts src/cad/assembly.test.ts src/cad/ldraw.test.ts src/editor/workbench/transform.test.ts src/generation/pipeline.test.ts src/generation/score.test.ts src/agent/schemas.test.ts src/agent/tools.test.ts
```

Do not commit or push.
