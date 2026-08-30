# Core CAD editing

## Everyday workflow

- Pick a part from the library to place repeatedly; **R** turns the preview and **Escape** cancels it. The card’s **+** adds immediately. Changing colour updates the armed preview.
- **G** opens Move and its exact transform controls; **R** opens Rotate when no part is armed. These tools also work in orthographic projection.
- Use the viewport’s quick controls for six camera directions, parallel projection, framing, grid increments and connector snapping. Front/back/side are true elevation views, not elevated perspectives.
- **Ctrl/Cmd+C**, **X**, **V** copy, cut and paste parts. This is an **editor-local clipboard**, not the operating system’s text clipboard. It lasts while the editor remains mounted. Copies preserve relative poses and colours. Repeated paste finds a clear lane beside the model; the first paste after a cut restores the original location when possible. Kernel constraints still apply.
- **Ctrl/Cmd+Z** undoes; **Ctrl/Cmd+Shift+Z** redoes. Restored parts are selected for further editing. Native text editing retains its own copy/paste, undo and select-all.

## Precise transforms

- Numeric fields commit on Enter or blur, once. Escape discards a draft; empty/invalid values restore the actual pose. An unchanged value does not create a history entry. Numeric coordinates are exact and do not get silently moved to a nearby connector.
- Multi-selection position fields show its measured centre and translate all members together. Rotation steppers and the gizmo preserve the group as a rigid body.
- Gizmos honour the chosen world/local/connector frame, pivot, axis locks, connector snap toggle and rotation increment. All three rotation axes are supported, including turns greater than 90 degrees.
- Translation snapping applies to the **movement delta**, keeping an already seated part’s off-grid height intact. Escape during a drag restores the starting pose without a transaction.
- In Move/Rotate, arrows nudge horizontally and Page Up/Down raise/lower; Shift takes a coarser step. Axis locks affect nudges. In Select, arrows orbit and Page Up/Down zoom. **+/-** zoom in either mode, including orthographic.
- **Ground** / **Shift+D** puts the selection’s lowest measured point on the ground, preserving its internal arrangement. Collisions, connector requirements and hard project constraints can refuse the operation.
- **Ctrl/Cmd+A** selects visible parts, respecting hidden/isolation state. **H** hides, **Shift+H** restores visibility, **F** frames the model and **Shift+F** focuses selection without temporarily hiding other parts.

## Regression checks

Use Node 24 (the repository runtime). With the development server running:

```sh
npm test -- src/editor --maxWorkers=2
BRICKWRIGHT_E2E_URL=http://127.0.0.1:4174 node tools/e2e/cad-editing.mjs
```

The browser suite drives actual controls and pointer gestures, checks document revisions/poses, reloads to verify local persistence, and writes screenshots/results under `artifacts/cad-editing/`. It is also discovered by `test:e2e:all`. No cloud delivery is exercised by this local editor suite.
