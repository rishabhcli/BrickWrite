# Accessibility

Ten findings against WCAG 2.2 AA.

**Contrast independently recomputed.** Every token was re-measured from the sRGB
relative-luminance formula rather than taken on trust:

| token | on `--void` #06090a | on `--panel` #0d1315 | AA (4.5:1) |
|---|---|---|---|
| `--faint` #526368 | 3.18 | 2.98 | **no** |
| `--muted` #8a9ba0 | 6.92 | 6.49 | yes |
| `--ink` #f0f5f6 | 18.17 | 17.03 | yes |
| `--cyan` #83e7ee | 13.92 | 13.05 | yes |
| `--orange` #f5a33f | 9.70 | 9.09 | yes |

`--faint` is the only failure, and it is the one used for nearly every micro-label.

---

## 1. Raise `--faint` so micro-labels clear 4.5:1

**Evidence:** `src/styles.css:7-9`. Computed: **3.18:1** on `--void`, **2.98:1** on `--panel`. Used 92 times in `src/styles.css` and 40+ times across `src/features/**/*.css` via the identical `--bw-faint` (`src/features/landing/surface.css:52`), almost always on 7.5–9.5px text — `.eyebrow` (`styles.css:97-104`, 9.5px), `.project-identity small` (`:153`, 7.5px), `.legal-trademark` (`:231`, 9.5px).
**Why it matters:** None of this qualifies as large text (needs ≥18.66px bold or ≥24px regular), so **WCAG 1.4.3 Contrast (Minimum), AA** requires 4.5:1. At 2.98 it misses even the 3:1 floor for non-text. Eyebrows, timestamps, hints and legal copy across the whole app are sub-threshold.
**Change:** `#6f8085` — computed here as the *minimum* value on the existing hue that clears AA on both surfaces (**4.55** on panel, **4.85** on void). Note the researcher proposed `#7c8d92`, which reaches 5.43 on panel; that overshoots and worsens the hierarchy risk below. `#6f8085` keeps a **1.94-point** gap to `--muted` where `#7c8d92` leaves only 1.06.
**Effort:** S    **Risk:** `--faint` is relied on to recede relative to `--muted`; the value above is chosen specifically to preserve that gap, but it still needs a visual pass.

## 2. Give the 3D viewport a keyboard path for core CAD operations

**Evidence:** `src/editor/CadViewport.tsx:990-1010` mounts `<Canvas>` with no `tabIndex` on `gl.domElement`; `OrbitControls` (`:636`) has no `listenToKeyEvents`; the placement raycast handler (`:280-300`) is pointer-only. No arrow-key handling exists under `src/editor/CadViewport.tsx` or `src/cad/`.
**Why it matters:** Orbit, pan, zoom, click-to-select, click-to-place, gizmo drag and the Connect tool's picks have **no keyboard equivalent**, and the canvas is not in the tab order. A direct **WCAG 2.1.1 Keyboard (A)** failure on the product's primary surface. Only the side-panel numeric X/Y/Z fields offer any non-pointer path.
**Change:** Make the canvas focusable (`tabIndex=0`, visible ring, `aria-describedby` operating hint), wire `OrbitControls.listenToKeyEvents`, and add arrow-key nudge plus Tab-cycle-through-parts so selection, placement and transform work without a pointer.
**Effort:** L    **Risk:** Collides with the global `keydown` handler in `Workbench.tsx` (tool shortcuts, Escape chain) and drei's own bindings; must keep `isTypingTarget` so catalog search isn't hijacked.

## 3. Add real dialog semantics to ProjectMenu and ExportCenter

**Evidence:** `src/editor/ProjectMenu.tsx:162,276` and `src/editor/ExportCenter.tsx:162` all use `role="dialog"` with **no `aria-modal`, no focus moved in, and no Tab trap** — only Escape and outside-pointerdown. Inconsistent with `src/platform/auth/AccountMenu.tsx:57`, `src/cloud/VersionHistory.tsx:38` and `src/cloud/ProjectsPanel.tsx:463`, which all use the shared `useFocusTrap` (`src/platform/a11y.ts:47`).
**Why it matters:** A keyboard user who opens Projects, Data & licences or Deliverables is never moved into the dialog and can Tab straight past it into the toolbar behind, while the announced role promises modal behaviour the code does not deliver. **WCAG 4.1.2 (A)**, and breaks expected 2.4.3 focus order.
**Change:** Wrap each panel root with the existing `useFocusTrap(open, { onEscape, restoreTo })` and add `aria-modal="true"`.
**Effort:** M    **Risk:** Low — wiring an already-shipped hook; confirm initial focus doesn't fight `ExportCenter.tsx:63-77`.

## 4. Trap Tab inside WelcomeGuide and the gallery Report dialog

**Evidence:** `src/editor/WelcomeGuide.tsx:98` sets `role="dialog" aria-modal="true"` and manages initial focus/Escape (`:74-93`) but its handler only checks Escape — no Tab interception. `src/features/gallery/GalleryPage.tsx:350` (`ReportDialog`) declares `aria-modal="true"` with **no focus management at all** — no `useRef`, no `useEffect`, no Escape.
**Why it matters:** WelcomeGuide is the first thing a new user sees; the report flow is the moderation path. Both claim `aria-modal="true"` — telling AT the rest of the page is inert — while focus can still reach content behind the backdrop.
**Change:** Reuse the Tab-trap idiom already implemented five times here (`ShortcutGuide.tsx:48-65`, `CommandDeck.tsx:326-340`, `CommandPalette.tsx:100-121`, `ObjectivesDialog.tsx:49-64`, `CompareDialog.tsx:63-76`).
**Effort:** S/M    **Risk:** Minimal; verify the trap still lets `ReportDialog`'s `<select>`/`<textarea>` type normally.

## 5. Expose the active autonomy mode to assistive tech

**Evidence:** `src/editor/workbench/AutonomySwitch.tsx:6-13` — three mode buttons whose selected state is communicated only by `className`; no `aria-pressed`, `aria-checked` or `aria-current`, and the wrapper has no `role="radiogroup"`.
**Why it matters:** This sets how much unattended authority the agent has over the model — **arguably the most consequential toggle in the app** — yet a screen-reader user gets three identical state-less buttons with no indication which is active. **WCAG 4.1.2 (A)**.
**Change:** `role="radiogroup"` on the container, `role="radio" aria-checked={value === mode}` on each button, matching the pattern already correct in `Toolbar.tsx`.
**Effort:** S    **Risk:** Negligible; purely additive.

## 6. Remove the conflicting `role="radio"` + `aria-pressed` pairing on tool buttons

**Evidence:** `src/editor/workbench/Toolbar.tsx:176-180` sets `role="radio"`, `aria-checked` **and** `aria-pressed` on the same button. `aria-pressed` is supported only on toggle-button roles, not `role="radio"`.
**Why it matters:** Two conflicting state models on one element is an ARIA authoring error (**4.1.2**); implementations differ on which they honour, so Select/Move/Rotate/Connect risk inconsistent announcement.
**Change:** Drop `aria-pressed`, keep `role="radio"` + `aria-checked`.
**Effort:** S    **Risk:** Check `panels.test.tsx` doesn't assert the removed attribute.

## 7. Make dock sections real headings inside real landmark regions

**Evidence:** `src/editor/workbench/Dock.tsx:150` renders every section title as `<span>` inside a button — no heading element anywhere in the dock chrome. The docks are plain `<div>`s carrying only `aria-label` (`Workbench.tsx:297,346`); a bare `<div>` does not become a landmark from `aria-label` alone, it needs `role="region"`.
**Why it matters:** Screen-reader users navigate dense UI by heading or landmark. Here there is neither, despite the visual design clearly treating these as named sections. **WCAG 1.3.1 (A)** — visual structure not programmatically exposed.
**Change:** Give each `DockSection` an `<h3>` labelling the toggle text, and add `role="region"` to the two dock containers.
**Effort:** M    **Risk:** Nesting a heading inside a disclosure button can double-announce; check levels against the `<h1>` in `ViewportStage.tsx:105`.

## 8. Let the editor reflow below 1024px instead of clipping

**Evidence:** `src/styles.css:46` sets `overflow: hidden` on `html, body, #root`; `:48-49` sets `body { min-width: 1024px }`. The marketing surfaces carve out an escape hatch (`body:has(.bw-surface) { min-width: 0; overflow: visible }`, `surface.css:9-13`); the workbench does not.
**Why it matters:** **WCAG 1.4.10 Reflow (AA)** requires usability at 320px equivalent. Because overflow is `hidden` rather than `auto`, anything narrower than 1024px is not merely scrollable — it is **clipped and unreachable**, including text-only surfaces (Shortcut Guide, licence panel, Export Center) that have no 2D-layout justification for the exemption.
**Change:** At minimum switch to `overflow: auto` below the breakpoint so content is reachable; ideally a compact stacked layout for the chrome, reserving the fixed-width exemption for the canvas itself.
**Effort:** M (scroll fallback) / L (responsive layout)    **Risk:** The grid in `styles.css:71-82` assumes the 1024px floor; a real redesign touches `src/editor/workbench/layout.ts`.

## 9. Announce route changes: update the title and move focus

**Evidence:** `document.title` is never assigned anywhere in `src/`; `<title>` stays the static `"Brickwright / Build Console"` from `index.html:8` on every route. `src/platform/AppFrame.tsx:88` defines `<main id="pf-main" tabIndex={-1}>` and a skip link (`:56-58`), but nothing calls `.focus()` on it when the router location changes.
**Why it matters:** Landing → Gallery → Explore → Account are all client-side navigations inside one persistent frame. Without a title update or focus move, screen-reader users get **no signal the page changed** (**2.4.2 Page Titled, A**) and focus stays on the nav link (**2.4.3, A**).
**Change:** In `AppShell.tsx`, set `document.title` per route on navigation and move focus to `#pf-main`, which is already `tabIndex={-1}` and ready.
**Effort:** S    **Risk:** Gate on pathname changes only so it doesn't steal focus on hash jumps.

## 10. Fix the toast live-region timing and mount pattern

**Evidence:** `src/editor/workbench/Workbench.tsx:502` mounts `role="status"` only when a toast exists — region and text arrive in the same paint. `src/editor/workbench/useWorkbench.ts:143-146` force-closes after 3600ms with no pause-on-hover/focus.
**Why it matters:** Freshly-mounted `role="status"` nodes are a known failure mode for AT that only observes mutations to already-registered regions — risking silent failure to announce "Autosave failed" (**4.1.3 Status Messages, AA**). A fixed non-extendable 3.6s window is a **2.2.1 Timing Adjustable (A)** gap, and this is the app's only feedback channel for command and save errors.
**Change:** Keep one persistent empty `role="status"` container mounted and update its contents; pause and reset the timer on `pointerenter`/`focusin`.
**Effort:** S    **Risk:** Low; confirm no test asserts the toast node is absent when idle.
