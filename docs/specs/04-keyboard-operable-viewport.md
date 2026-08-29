# Spec 04 — A keyboard-operable 3D viewport

**Status:** proposed
**Touches:** `src/editor/CadViewport.tsx`, `src/editor/render/controlSurface.ts`, `src/editor/render/ViewportControls.tsx`, `src/editor/workbench/ViewportStage.tsx`, `src/editor/workbench/ConnectPanel.tsx`, `src/editor/workbench/shortcuts.ts`, `src/styles.css`, `tools/e2e-smoke.mjs`
**Standard:** WCAG 2.2 — this closes a **Level A** failure

---

## 1. Why

Every interaction in the CAD viewport is pointer-only, and the canvas is not in
the tab order at all. `grep -c tabIndex src/editor/CadViewport.tsx` → **0**.

**WCAG 2.1.1 Keyboard (Level A):**

> All functionality of the content is operable through a keyboard interface
> without requiring specific timings for individual keystrokes, except where the
> underlying function requires input that depends on the path of the user's
> movement and not just the endpoints.

None of the interactions below qualify for the path-dependence exception — that
covers freehand drawing, not "orbit a camera" or "pick a brick".

### 1a. The fix already exists in this repository

`src/features/share/viewer/ModelCanvas.tsx` — the read-only viewer on published
model pages — is already fully keyboard-operable:

```tsx
<canvas tabIndex={0} role="img" aria-label={label} onKeyDown={onKeyDown} … />
<p className="bw-share-canvas-hint">
  Drag or use the arrow keys to orbit · scroll or +/− to zoom · 0 to reset
</p>
```

```ts
const step = event.shiftKey ? 45 : 5
ArrowLeft  → orbit −step yaw     ArrowUp   → orbit +step pitch
ArrowRight → orbit +step yaw     ArrowDown → orbit −step pitch
'+' / '='  → zoom +0.12          '-'       → zoom −0.12       '0' → reset
```

Its own docstring states the principle:

> an orbit control that only responds to a pointer is an orbit control half the
> audience cannot use.

**The interaction contract transfers directly** — focusable canvas, Shift for a
coarser step, a permanently visible textual hint. The camera math does not (that
viewer has no `THREE.Camera`), and it has no selection, tools, gizmo or Connect
flow. So it solves the camera slice and nothing else — but it settles the design
questions of *what keys*, *what step sizes*, and *how to advertise them*.

---

## 2. What needs a keyboard path

| # | Interaction | Where | Mutates |
|---|---|---|---|
| 1 | Camera orbit / pan / zoom | `CadViewport.tsx:636` `<OrbitControls>` | camera + `controls.target` |
| 2 | Single selection (click) | `CadViewport.tsx:92-107`; batched path via `ViewportControls.tsx:632-691` | `cadEngine.setSelection` |
| 3 | Shift-drag marquee / Alt-drag lasso | `ViewportControls.tsx:574-712` | `setSelection` |
| 4 | Placement (click-to-place) | `CadViewport.tsx:263-345`, its own listener set | `part.add` |
| 5 | Transform gizmo drag | `CadViewport.tsx:123-253` (drei `TransformControls`) | `part.transform` |
| 6 | Joint manipulation | `Manipulators.tsx:160-261` → `ViewportControls.tsx:330-418` | `part.transform` |
| 7 | Section plane handles | `Manipulators.tsx:59-142` → `ViewportControls.tsx:441-514` | viewport state |
| 8 | Connect source/target picking | rides #2 via `useWorkbench.ts:258-273` | connect flow state |

Items 5–7 are WebGL meshes with no DOM presence, no role and no accessible name
— a screen reader cannot know they exist.

### Three findings that make this far cheaper than it looks

**`OrbitControls.listenToKeyEvents` gives pan, not orbit.** The class exposes it
and defaults `keys` to the four arrows, but `handleKeyDown` only ever calls
`pan(...)`. Enabling it buys keyboard *panning* and nothing else — it is not the
fix for #1. (It does respect `scope.enabled`, which `ViewportControls` already
flips off during marquee/joint/section drags, so it composes safely if wanted
alongside a real orbit implementation.)

**Joint math is already ray-free.** `JointDragRequest` in `render/jointDrag.ts:68-72`
is `{ rotateDegrees, slideLdu, axis? }` — a plain parameter object — and both
`jointOperations()` and `previewTransforms()` consume it with **no ray involved**.
Only the `ViewportControls` wrappers force canvas coordinates. A keyboard "nudge
this joint ±N°" can call the domain functions directly.

**Section-plane rotation is already ray-free too.** `rotatePlaneFromDrag(plane, ringAxis, radians)`
takes a plain number. Only *offset* is ray-bound, and its keyboard equivalent is
three lines using the already-exported `add`/`scale`.

So #6 and #7 — which look like the hardest — are the easiest.

---

## 3. Constraints from the existing keyboard system

### Tab is contractually reserved

`shortcuts.ts:37` — `RESERVED_CHORDS = ['escape', 'enter', 'tab', 'shift+tab']`,
explicitly un-rebindable "so an operator cannot lock themselves out of a modal."

**A "Tab cycles through parts" design is therefore not available.** It would also
risk **WCAG 2.1.2 No Keyboard Trap**, which requires focus to be movable away
using standard keys, or the user to be told the exit method.

### The chord space that is free

No `WORKBENCH_COMMANDS` entry uses an arrow key, an unmodified digit, or a Page
key. Completely open: `ArrowUp/Down/Left/Right`, `PageUp/PageDown`, `+ - =`,
`Home/End`, `Space`, and the bare letters `a b d e i j m n o q s t u w x y z`.

Already taken (44 chords) include `v g r c` (tools), `f` (frame), `h` (hide),
`l p k`, and every `mod+`/`alt+`/`shift+` combination listed in `shortcuts.ts:39-102`.

### The global handler already fires regardless of focus

`Workbench.tsx:172-241` listens on `window` and only bails inside text fields
(`isTypingTarget`, which does not match `<canvas>`). So tool shortcuts already
work while the canvas has focus — that continuity is desirable and must be
preserved. New canvas-scoped handling should live in the canvas's own
`onKeyDown` and coordinate rather than adding a third global listener.

> **There are already two uncoordinated `window` Escape listeners** —
> `Workbench.tsx:196-216` and `ViewportControls.tsx:422-438` — and neither calls
> `stopImmediatePropagation`. During a joint or section drag, Escape cancels the
> drag *and* falls through to the Workbench branch that rejects a pending
> proposal and resets tool and render mode. Do not add a third; fix the ordering
> while here.

---

## 4. Design

### 4.1 Make the canvas a focus stop

```tsx
<canvas
  tabIndex={0}
  role="application"
  aria-label="CAD viewport"
  aria-describedby="viewport-keys"
  aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home"
  onKeyDown={onViewportKey}
/>
```

`role="application"` rather than `img` — unlike the share viewer, this canvas is
interactive and owns its arrow keys.

**Focus styling is missing and must be added.** `styles.css:60-64` scopes the
cyan focus ring to `button, input, select, textarea` only — not `canvas`, not
`[tabindex]`. The precedent is `DockSplitter`, which needed the same and got its
own rule at `styles.css:1092-1093`. Add the canvas equivalent, or **WCAG 2.4.7
Focus Visible (AA)** fails the moment the canvas becomes focusable.

### 4.2 Camera — adopt the share viewer's contract

| Key | Action | Step | Shift |
|---|---|---|---|
| ArrowLeft / Right | orbit yaw | 5° | 45° |
| ArrowUp / Down | orbit pitch | 5° | 45° |
| PageUp / PageDown | dolly | 0.12 | — |
| Home | frame the model | — | — |

`CameraRig`'s turntable (`CadViewport.tsx:484-491`) already does spherical
positioning; extend it to vary polar angle. `Home` maps to the existing
`frameParts()` on the control surface — no new camera math.

Clamp pitch as the share viewer does (`[-80, 80]`) so the camera cannot invert.

### 4.3 Selection without a pointer

Tab is unavailable (§3), so use bracket keys on the focused canvas:

| Key | Action |
|---|---|
| `[` / `]` | previous / next part in order |
| `Shift` + `[` / `]` | extend selection |
| `Enter` | act on the focused part per the active tool (Connect: set source, then target) |
| `\` | cycle occlusion at the current selection — maps to the existing `pick(…, { cycle: true })` / `resetCycle()` |

**Ordering is the real design decision** and bears on **WCAG 2.4.3 Focus Order
(A)**, which requires an order that "preserves meaning and operability."

| Candidate | Ready? | Problem |
|---|---|---|
| `Object.keys(document.parts)` | yes — already the canonical walk order in `visibility.ts`, `instructions.ts`, `selection.ts` | arbitrary relative to what is on screen; reflects import/placement order |
| Build order — `document.steps.flatMap(s => s.partIds)` | yes | **not kept live** — new parts append to the last step (`useWorkbench.ts:345,594`); only a full `regenerateBuildOrder()` re-derives it |
| Per-subassembly, then part | yes | good two-level scheme; pairs with the existing `alt+m` "select whole module" |
| Spatial / screen order | **no — does not exist** | would need building from `screenPositionOf()`, and would reorder on every camera move, which is itself a 2.4.3 problem |

**Recommend build order, falling back to document order**, with a note that
freshness depends on resequencing. It is the only ordering that means something
to a builder.

Candidates must be filtered through the same visibility the pick path uses —
`resolveVisibility(...).hidden`/`.ghosted` — not a third notion of visible.
Note there are already **two** `VisibilityState` shapes (`render/visibility.ts:102-109`
and `workbench/selection.ts:141-148`); use the render one, since that is what
picking respects.

### 4.4 Manipulation

| Key | Action | Implementation |
|---|---|---|
| Arrows *while a transform tool is active* | nudge selection by `translateStep` | existing `handleTransform` |
| `Shift` + arrows | nudge by a coarse step | same |
| `,` / `.` | rotate joint −/+ step | **`jointOperations()` directly** — already ray-free |
| `Shift` + `,` / `.` | slide joint | `JointDragRequest.slideLdu` |
| `;` / `'` | section plane offset −/+ | 3 lines using exported `add`/`scale` |

Tool-modal arrows conflict with camera arrows, so: **arrows orbit the camera
unless a transform tool is active with a non-empty selection**, in which case they
nudge. Announce the mode change (§4.5) so the switch is never silent.

### 4.5 Announcements

There is **no `announce()` helper anywhere** — `src/platform/a11y.ts` contains
only `useFocusTrap`. The house idiom is a `role="status"` element.

**Do not reuse the status bar.** `StatusBar.tsx:47` is one live region already
carrying tool, selection count, viewport hint and Escape affordance; adding
per-keystroke output would re-announce all of it on every arrow press.

Follow `AgentWorkbench.tsx:181` instead — a dedicated visually-hidden
`role="status" aria-live="polite"` span owned by the viewport, using the existing
`.visually-hidden` class from `styles.css:1046-1049`. (That utility is currently
duplicated three times across the codebase; use the shared one.)

Announce: focused part name and id, selection size on change, mode switches
(orbit ↔ nudge), and commit results.

---

## 5. A UI lie to fix while here

`useWorkbench.ts:806` sets the Connect status hint to:

> Review the mate · **Tab cycles** · **Enter commits**

`ConnectPanel.tsx` has **zero** `onKeyDown` handlers. `cycle()` is wired only to
the "Solution N of M" button's `onClick`; `commit()` only to the CONNECT button's.
Tab does ordinary DOM traversal; "Enter commits" is true only by accident when
focus happens to sit on the commit button.

`tools/e2e-smoke.mjs:600-625` confirms it — the test commits via
`.connect-commit` **click**, never a key.

**Either implement the hint or change the copy.** Implementing is small and in
scope: `onKeyDown` on the panel root, Tab → `cycle()` with `preventDefault`,
Enter → `commit()`. But note Tab is reserved (§3) — scoping it to the panel is
acceptable since focus is already inside a bounded control group, but the hint
should then also say how to leave.

---

## 6. Tests

### Existing coverage, and the one-line gap

`tools/e2e-smoke.mjs:1444-1466` — *keyboard reachability* — presses Tab 60 times
from `.brand-lockup`, records what receives focus, and asserts >20 controls, the
tool rail, and a text field. **It does not assert the canvas is reachable.** That
is why this gap has never been caught: the assertion is a whitelist of things
that must be present, not a map of what is expected.

`tools/e2e-smoke.mjs:496-516` is labelled *"find → place, from the keyboard
alone"* and proves `ArrowDown` + `Enter` arms a part from the catalog — then drops
it with `page.locator('canvas').click(...)`. **Even the workflow explicitly
labelled keyboard-only bottoms out at a pointer click.**

`tools/e2e-smoke.mjs:1468-1488` is the in-repo template to copy: focus the
`DockSplitter`, assert `document.activeElement`, press ArrowRight ×2, assert the
dock grew. Same shape works for orbit and nudge.

### New

- `the viewport canvas is reachable by Tab` — add `reached.some(e => e.startsWith('canvas'))` to the existing sweep
- `arrow keys orbit the camera when the canvas has focus` — assert camera azimuth changed via the control surface
- `shift+arrow takes a coarser step`
- `bracket keys walk the selection in build order`
- `arrows nudge instead of orbiting while a transform tool is active`
- `the mode switch is announced` — assert the live region's text
- `the canvas shows a visible focus indicator` — extend the contrast sweep at `:1490-1539`, which currently samples **no focus-ring colour at all**
- `Tab still leaves the canvas` — WCAG 2.1.2
- `Connect: Tab cycles candidates and Enter commits` — §5, only if the hint is implemented rather than reworded

---

## 7. Work breakdown

1. **`tabIndex` + `role` + `aria-label` + focus CSS.** The canvas becomes reachable; the reachability test gets its one-line assertion. Nothing else changes.
2. **Camera keys**, ported from `ModelCanvas.tsx`'s contract, plus the visible hint.
3. **Live region** — dedicated, visually hidden, viewport-owned.
4. **Selection walking** in build order, filtered by render visibility.
5. **Nudge mode** and the arrow-key arbitration with camera.
6. **Joint and section nudges** — cheapest of all, the domain functions are already parameter-native.
7. **Fix the Connect hint** (§5) — implement or reword.
8. **Placement from the keyboard** — hardest, needs a crosshair or "place at focused part's face" concept. Defer.
9. Fix the double-Escape ordering (§3) while in the area.

**Steps 1–2 close the most visible part of the Level A failure and are small.**

---

## 8. Related, and deliberately out of scope

**WCAG 2.5.7 Dragging Movements (AA, new in 2.2):**

> All functionality that uses a dragging movement for operation can be achieved
> by a single pointer without dragging, unless dragging is essential…

Every drag in §2 — gizmo, joints, section handles, marquee, lasso — is subject to
this. It is a *separate obligation* about pointer alternatives, not keyboard, and
it is not solved by this spec. Worth a follow-up.

---

## 9. Open questions

1. Build order or document order for selection walking, given build order can drift between resequences?
2. Should arrows orbit-by-default and nudge-on-tool, or the reverse?
3. Is `role="application"` right, or should the canvas expose per-part focus targets (the `@react-three/a11y` model)? The latter would make every part a real focus stop but would land ~900 hidden DOM nodes in the accessible tree — and would be swept by the existing accessible-name test at `:1416-1442`.
4. Implement the Connect keyboard hint, or reword it?
