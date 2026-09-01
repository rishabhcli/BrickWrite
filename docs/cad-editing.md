# Core CAD editing

## Everyday workflow

- Pick a part from the library to place repeatedly; **R** turns the preview and **Escape** cancels it. The card’s **+** adds immediately. Drag a card into the viewport to place. Changing colour updates the armed preview.
- An empty document shows **Start with a brick** plus one-click forks of the first three published megabuilds. **New** in the project menu still creates a blank project.
- **M** picks up the selected brick for click-to-reseat. Its original pose is only ghosted, not deleted: a legal click creates one move transaction; **Escape** puts it back without an edit. Use the gizmo for multi-part moves.
- **B** builds another of the selected brick with the same colour and full orientation. **Keep building** chooses continuous or single placement; the rotation buttons and **Shift+R** turn the held brick backwards. **Done** leaves placement mode.
- Right-click a part, open **Selection actions**, or press **Shift+F10** in the canvas for a keyboard-navigable menu of part operations. Right-drag still pans.
- Placement ghosts remain visible in red when blocked, with a reason and live coordinates. Previews ignore their own meshes, check collisions with hidden parts, and reject ground snaps below the floor. Enter observes the same legality as clicking.
- **G** opens Move and its exact transform controls; **R** opens Rotate when no part is armed. These tools also work in orthographic projection.
- Use the viewport’s quick controls for six camera directions, parallel projection, framing, grid increments and connector snapping. Front/back/side are true elevation views, not elevated perspectives.
- **Ctrl/Cmd+C**, **X**, **V** copy, cut and paste parts. This is an **editor-local clipboard**, not the operating system’s text clipboard. It lasts while the editor remains mounted. Copies preserve relative poses and colours. Repeated paste finds a clear lane beside the model; the first paste after a cut restores the original location when possible. Kernel constraints still apply.
- **Ctrl/Cmd+Z** undoes; **Ctrl/Cmd+Shift+Z** redoes. Restored parts are selected for further editing. Native text editing retains its own copy/paste, undo and select-all.
- The Export Center can write a **project archive** (JSON with history, notes and constraints) as well as LDR, MPD, BOM and the printable guide. Importing an archive restores that project rather than flattening it to parts.

## Precise transforms

- Numeric fields commit on Enter or blur, once. Escape discards a draft; empty/invalid values restore the actual pose. An unchanged value does not create a history entry. Numeric coordinates are exact and do not get silently moved to a nearby connector.
- Multi-selection position fields show its measured centre and translate all members together. Rotation steppers and the gizmo preserve the group as a rigid body.
- Gizmos honour the chosen world/local/connector frame, pivot, axis locks, connector snap toggle and rotation increment. All three rotation axes are supported, including turns greater than 90 degrees.
- Translation snapping applies to the **movement delta**, keeping an already seated part’s off-grid height intact. Escape during a drag restores the starting pose without a transaction.
- In Move/Rotate, arrows nudge horizontally and Page Up/Down raise/lower; Shift takes a coarser step. Axis locks affect nudges. In Select, arrows orbit and Page Up/Down zoom. **+/-** zoom in either mode, including orthographic.
- **Ground** / **Shift+D** puts the selection’s lowest measured point on the ground, preserving its internal arrangement. Collisions, connector requirements and hard project constraints can refuse the operation.
- Camera fitting accounts for all eight bounds corners and the viewport aspect ratio. **F** keeps the current viewing direction; resizing docks preserves framing without resetting the orbit.
- **Ctrl/Cmd+A** selects visible parts, respecting hidden/isolation state. **H** hides, **Shift+H** restores visibility, **F** frames the model and **Shift+F** focuses selection without temporarily hiding other parts.

## Regression checks

Use Node 24 (the repository runtime). With the development server running:

```sh
npm test -- src/editor --maxWorkers=2
BRICKWRIGHT_E2E_URL=http://127.0.0.1:4174 node tools/e2e/cad-editing.mjs
```

The browser suite drives actual controls and pointer gestures, checks document revisions/poses, reloads to verify local persistence, and writes screenshots/results under `artifacts/cad-editing/`. It is also discovered by `test:e2e:all`. No cloud delivery is exercised by this local editor suite.

## Fluid camera and pointer ownership (August 2026)

- A left click selects; a left drag becomes orbit after **4 px**. Right-drag pans, middle-drag dollies, and the wheel zooms toward the cursor (also in orthographic projection). Right-click still opens the part menu, but a pan does not.
- Named directions, framing and dock-resize adjustments now use the same damped CameraControls rig. Reduced motion jumps directly to the destination. Escape stops camera motion as well as cancelling an active edit.
- Placement, move/rotate gizmos, joints, section handles and marquee selection have exclusive pointer ownership. A second finger cannot finish the first finger's edit; camera-owned gestures retain native multi-touch. Pointer cancellation and loss of window focus cancel edit previews without committing them.
- Move/rotate handles adapt toward a 112 px projected extent (at least 96 px in the tested desktop layout). Snapping and placement sampling are coalesced to animation frames; the final pointer position is resolved synchronously before committing. A placement ghost interpolates its display pose only: the kernel still decides legality at the actual candidate pose.
- Joint dragging sweeps each rendered sample and checks the final pose again before one undoable transaction. There is no physics simulation or new winch/cable joint in this version.
- Large models no longer lose all batch edges at 6,000 parts. Edges are sampled and assigned a quality-dependent, projected-size budget; selection highlights do not recreate the unselected instance buffers in Select/Connect mode.

### Mechanism planner scope

The shared capabilities `build_crane`, `build_lattice`, `build_snot_hull` and `build_clock_faces` use ordinary kernel transactions and real compiled connector geometry. Missing required geometry is an explicit `GEOMETRY_UNAVAILABLE` error, not a placeholder brick.

- **Crane:** four-course mast with a real luffing hinge and bonded boom. No hoist, hook, cable, counterweight or load rating.
- **Lattice:** orthogonal columns and bonded decks, not diagonal X-bracing.
- **SNOT hull:** rectangular bonded deck with real side-stud skins, not a curved saucer.
- **Clock faces:** an open square frame with four independently hinged plate hands. No finished tile-mosaic dials, numerals, gear train or timekeeping.
