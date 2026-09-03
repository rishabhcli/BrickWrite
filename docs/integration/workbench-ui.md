# Workstream 5 — Workbench UI

The editor shell: docks, palette, transform controls, selection, command palette,
Connect, and the extension registry the other workstreams mount into.

Everything below lives under `src/editor/workbench/`, with `src/App.tsx` reduced
to a composition root.

---

## 1. Extension registry — the contract

`src/editor/workbench/ExtensionRegistry.tsx`

Other workstreams add surfaces to the editor **without editing any file this
workstream owns**. The shell publishes named slots; you register into them.

### Slots

| Slot | Where it draws | Shape expected |
|---|---|---|
| `toolbar` | tool rail, after the built-in groups | small icon buttons, ~32 px |
| `panel-left` | left dock, as a stacked collapsible section | full-width panel content |
| `panel-right` | right dock, as a stacked collapsible section | full-width panel content |
| `inspector` | inside the inspector Object tab, below the built-in sections | `<section className="property-section">` |
| `status` | **Unmounted.** `StatusBar.tsx` still renders a bottom strip and this slot is what it would host (cloud sync readout, layout preset). Nothing in `Workbench.tsx` mounts it. Registering here currently draws nowhere. Layout presets auto-pick from window width. | one short inline readout |
| `modal` | full-screen dialog; only the modal opened via `api.openModal(id)` renders | own backdrop + `role="dialog"` |
| `overlay` | absolutely positioned over the viewport | positioned element |

Ordering inside a slot is `priority` ascending, then registration order.
Built-in surfaces occupy priority `0–99`; contributions default to `100`.

### Registering

```tsx
import { useRegisterContribution, type WorkbenchApi } from '../editor/workbench'

export function AgentChatContribution() {
  useRegisterContribution({
    id: 'agent.chat',            // unique within the slot
    slot: 'panel-right',
    priority: 120,
    title: 'Assistant',          // shown in the dock section header
    icon: <Sparkles size={13} />,
    when: (api) => api.snapshot.autonomy !== 'inspect',   // optional guard
    render: (api: WorkbenchApi) => <AgentChatPanel api={api} />,
  })
  return null
}
```

Mount `<AgentChatContribution />` anywhere inside the workbench tree — the
simplest place is a slot contribution of your own, or via the `contributions`
prop on `<Workbench>` (see §1.4). The registration is withdrawn automatically
when your component unmounts. There is also a declarative form:

```tsx
<Contribution id="share.button" slot="toolbar" priority={110} render={() => <ShareButton />} />
```

### `WorkbenchApi`

The single object passed to `render` and `when`, also available via
`useWorkbenchApi()` anywhere below the provider:

```ts
interface WorkbenchApi {
  readonly snapshot: EngineSnapshot          // live kernel state
  readonly selection: readonly string[]
  readonly tool: EditorTool                  // 'select' | 'move' | 'rotate' | 'connect'
  readonly activeColor: number               // LDraw colour code
  readonly renderMode: RenderMode
  readonly cameraView: CameraView
  readonly placement: PlacementRequest | null
  readonly online: boolean
  readonly hiddenPartIds: ReadonlySet<string>
  readonly activeModal: string | null

  select(partIds: readonly string[]): void
  setTool(tool: EditorTool): void
  setActiveColor(colorCode: number): void
  setRenderMode(mode: RenderMode): void
  setCameraView(view: CameraView): void
  frameSelection(): void
  armPart(definitionId: string): boolean               // false if no compiled geometry
  runCapability(id: SharedMutationId, args?): boolean   // same planner the agent uses
  execute(label: string, operations: CadOperation[]): boolean
  notify(notice: { kind: 'success'|'error'|'info'; title: string; detail: string }): void
  openModal(contributionId: string | null): void
}
```

Rules the registry enforces so you do not have to:

- **Clean unmount.** `useRegisterContribution` withdraws on unmount; a replaced
  registration's cleanup cannot delete its successor.
- **Duplicate ids.** Last registration wins and a `console.error` names the
  collision, rather than one panel silently never appearing.
- **Error isolation.** Each contribution renders inside an error boundary. A
  throw shows a named in-place failure; it does not discard the operator's
  unsaved model.
- **Exclusive modals.** Only `api.activeModal` renders from the `modal` slot.

### 1.4 Mounting contributions

`<Workbench contributions={[AgentChatContribution, ShareContribution]} />` — each
entry is a zero-prop component rendered inside the provider. This is the
integration point `src/App.tsx` uses; other workstreams export their
contribution component from their own `index.ts` and the integrator lists it.

---

## 2. Feature-parity checklist

The overhaul moved 893 lines of `App.tsx` into `src/editor/workbench/`. This is
every capability that existed before, and where it lives now. Nothing was
dropped; five rows are marked **extended**, meaning the old behaviour is intact
and something was added around it.

### 2.1 Shell, identity and persistence

| Capability (before) | Where it lives now | Reachable via |
|---|---|---|
| Brand lockup | `TopBar.tsx` | always visible |
| `ProjectMenu` — projects, restore report, checkpoint, rename, fork, new, open, delete, licences, attribution copy | `TopBar.tsx` → `src/editor/ProjectMenu.tsx` (unchanged) | project name button in the top bar |
| Save-state indicator (durable / in-memory / failed, with revision) | `TopBar.tsx` | top bar right |
| Codex/WebMCP status (native, tool count, autonomy, catalog version) | `TopBar.tsx` | top bar right |
| `AutonomySwitch` inspect / propose / build | `workbench/AutonomySwitch.tsx`, rendered by `TopBar` | top bar right |
| `webMcpAdapter.start()` / `stop()` lifecycle | `useWorkbench.ts` mount effect | — |
| `session.status` polling on autonomy/document change | `useWorkbench.ts` effect | — |
| `window.__brickwrightCanvas` handoff for `render_capture` | `ViewportStage.tsx` `onCanvasReady` | — |
| `brickwright:set-camera-view` → `brickwright:capture-ready` two-frame handshake | `useWorkbench.ts` (verbatim) | agent perception capture |

### 2.2 Tools, toolbar and camera

| Capability (before) | Where it lives now | Reachable via |
|---|---|---|
| Select / Move / Rotate / Connect tool buttons | `Toolbar.tsx` `.primary-tools` | click, `V` `G` `R` `C` |
| Duplicate selection | `Toolbar.tsx` + `TransformPanel` Clone | `⌘D`, `edit.clone` |
| Quarter turn | `Toolbar.tsx` + `TransformPanel` turn steppers | `⇧R`, `edit.quarter-turn` |
| Protect selection from agent edits | `Toolbar.tsx` + `InspectorPanel` lock control | `L`, `edit.protect` |
| Remove selection | `Toolbar.tsx` | `Delete`, `edit.delete` |
| Snap grid picker (stud / half-stud / fine LDU) | `Toolbar.tsx` `.grid-picker` | toolbar |
| Camera: isometric / front / top / fit | `Toolbar.tsx` `.camera-tools` | `⌥1` `⌥2` `⌥3` `F` |
| Camera: rear / left / right (agent-driven views) | `useWorkbench.setCameraView`, `WorkbenchApi.setCameraView` | `render_capture`, extensions |
| Render mode: beauty, orthographic, connections, violations, silhouette, exploded | `Toolbar.tsx` `.render-picker` | dropdown, `⌥B` `⌥N` `⌥X` `⌥E` |
| Undo / Redo with the last transaction's label | `Toolbar.tsx` | `⌘Z` / `⇧⌘Z` |
| Command deck button | `Toolbar.tsx` | `⌘/` |
| Keyboard shortcuts button | `Toolbar.tsx` | `?` |
| `ExportCenter` — LDR, MPD, BOM, printable build guide, import, release readiness | `Toolbar.tsx` → `src/editor/ExportCenter.tsx` (unchanged) | toolbar right |

### 2.3 Viewport

| Capability (before) | Where it lives now |
|---|---|
| `CadViewport` with document, selection, proposals, tool, grid, camera, render mode, placement | `ViewportStage.tsx` — props unchanged, renderer untouched |
| Corner ticks, assembly breadcrumb, title block, revision | `ViewportStage.tsx` |
| Metrics: parts / connections / collisions | `ViewportStage.tsx` |
| Live-kernel status strip with the next-click hint | `ViewportStage.tsx`. The status-bar extension of this strip is **not mounted**. |
| Diagnostic legend per render mode, with the colour key and "back to beauty" | `ViewportStage.tsx` (`RENDER_MODE_COPY` verbatim) |
| Placement HUD with part name, R to turn, Esc to cancel | `ViewportStage.tsx` |
| Empty-build state with "Start with a brick" and megabuild forks | `states.tsx` `EmptyBuildState`, rendered by `ViewportStage` |
| Agent-workflow suggestion button (ghost reinforcement proposal) | `ViewportStage.tsx` `.agent-suggest` |
| Build-playback overlay with step index and stop | `ViewportStage.tsx` |
| Proposal overlay with accept / reject | `ViewportStage.tsx` |
| Marquee box selection (shift-drag) | unchanged in `CadViewport`; handled by `useWorkbench.handleSelectMany` |

### 2.4 Palette (was `CatalogPanel`)

| Capability (before) | Where it lives now |
|---|---|
| Search field, `⌘K` focus, clear button | `PalettePanel.tsx` (`[data-catalog-search]` preserved) |
| Four knowledge tiers with live facet counts | `PalettePanel.tsx` `.tier-row` |
| Category chips derived from placeable parts | `PalettePanel.tsx` `.category-row` **and extended** with a full-category dropdown |
| "N of M identities" total, lazy wider-catalogue load, loading / failed / ready states | `PalettePanel.tsx` `.catalog-meta` |
| Part cards with tinted thumbnails, tier class, armed state | `PalettePanel.tsx` |
| `+` immediate-add button | `PalettePanel.tsx` `.part-add` |
| Paging over a capped result set | `PalettePanel.tsx` **extended**: windowed `searchCatalogPage` paging, at most 60 cards in the DOM |
| Empty state with tier-specific explanation, widen-tier and clear-search | `PalettePanel.tsx` `.parts-empty` |
| Project palette dock, everyday colours, expand to all 322 LDraw colours | `PalettePanel.tsx` `.palette-dock` **and extended** with pinned colour favourites |

### 2.5 Inspector (was `InspectorPanel`)

Moved wholesale to `workbench/InspectorPanel.tsx`; every section is intact.

| Capability (before) | Status |
|---|---|
| Object / Validate tabs with the health dot | kept |
| Selection identity: category, canonical id, name, part id, size | kept |
| Numeric transform: X/Y/Z LDU and RX/RY/RZ degrees | kept, **and extended** by the new Transform section (frames, locks, pivots, steppers) |
| Colour swatches capped at 18 observed, "show all N", applied colour always visible | kept |
| Colour legality row (observed / virtual / no evidence) | kept |
| Connector summary: male, female, LDCad source | kept |
| Ownership lock control with provenance | kept |
| Articulation rows: rotate ±step, slide ±step, moving-part count | kept |
| Data provenance: geometry, connections, identity, colours, usage | kept |
| Empty inspector with parts / modules / revision overview | kept |
| Validation: hero, collisions (with unverified count), connections, loose groups, colour evidence, dimensions | kept |
| Static analysis: mass, balance, footprint, reaches-the-ground, clutch load, coverage note | kept |
| Design constraints list | kept |
| Click-through selection from a validation row | kept |

### 2.6 Timeline (was `Timeline`)

Moved to `workbench/TimelinePanel.tsx`, unchanged, now in a collapsible bottom dock.

| Capability (before) | Status |
|---|---|
| STEPS / HISTORY switch with transaction count | kept |
| RESEQUENCE (derive a verified build order) | kept |
| PLAY / SHOW ALL build playback | kept |
| Step cards with completion state and current step | kept |
| Transaction cards with author lane, operation count, result revision | kept |
| Proposal cards with accept / reject | kept |
| Empty copy for both views | kept |
| Open builder note | kept |

### 2.7 Command deck and dialogs

| Capability (before) | Status |
|---|---|
| `CommandDeck` — all 26 shared mutation capabilities, search, scope, per-capability controls, disabled reasons, proof strip, agent-equivalent line | unchanged file, opened from the toolbar, `⌘/`, or the command palette |
| `ShortcutGuide` (`?`) with replay-welcome | unchanged file |
| `WelcomeGuide`, `markWelcomeSeen` | unchanged file; never opens itself, reached from `ShortcutGuide`'s "Show the welcome guide" |
| Toast: success / error / info, 3.6 s auto-dismiss, manual dismiss | `useWorkbench` + `Workbench.tsx` |

### 2.8 Actions and the command bus

Every one of these still plans through `planSharedMutation` where it did before,
and commits through `cadEngine.execute` with an expected revision.

| Action (before) | Now |
|---|---|
| `dispatch(label, operations)` | `useWorkbench.dispatch` |
| `runSharedMutation(capability, args)` | `useWorkbench.runSharedMutation`, also exposed to extensions as `api.runCapability` |
| `handleSelect` (click, shift-additive, double-click subassembly, connect pairing) | `useWorkbench.handleSelect` — **extended**: connect is now two explicit stages |
| `handleSelectMany` (marquee, additive, count notice) | `useWorkbench.handleSelectMany` |
| `handleTransform` (connector-solved snap) | `useWorkbench.handleTransform` — **extended**: canonicalised, and snapping is now a visible toggle |
| `buildPartAt` (colour legality, subassembly, step) | `useWorkbench.buildPartAt` |
| `armPart` / `placeArmed` / stay-armed placement | `useWorkbench` |
| `addPart` (surface-solved quick add) | `useWorkbench.addPart` |
| `duplicateSelection` (measured offset) | `useWorkbench.duplicateSelection` |
| `deleteSelection` | `useWorkbench.deleteSelection` |
| `rotateSelection` (basis-composed quarter turn) | `useWorkbench.rotateSelection` |
| `recolorSelection` (+ virtual-colour notice) | `useWorkbench.recolorSelection` |
| `protectSelection` / `L` toggle | `useWorkbench.protectSelection` / `toggleProtectSelection` |
| `acceptProposal` / `rejectProposal` | `useWorkbench` |
| `createDemoProposal` (real preflight through the bus) | `useWorkbench.createDemoProposal` |
| `importModel` (LDraw parse + report) | `useWorkbench.importModel` |
| `driveJoint` (articulate) | `useWorkbench.driveJoint` |
| `regenerateBuildOrder` | `useWorkbench.regenerateBuildOrder` |

### 2.9 Keyboard

Every binding that existed is still bound, and all of them are now remappable.

| Before | After |
|---|---|
| `⌘/` command deck | withdrawn — the deck folded into the palette on `⌘P` |
| `⌘K` focus catalogue search | `panel.search` |
| `?` shortcut guide (toggle) | `help.shortcuts` |
| `Esc` cancel placement → stop playback → reject proposal → reset tool and render mode | reserved by the shell, same chain, **extended** with "back one Connect stage" and "clear hide/isolate/ghost" |
| `⌘Z` / `⇧⌘Z` | `edit.undo` / `edit.redo` |
| `⌘D` duplicate | `edit.clone` |
| `Enter` accept proposal | reserved by the shell |
| `Delete` / `Backspace` | `edit.delete` |
| `G` move | `tool.move` |
| `R` rotate tool, or turn the armed ghost | `tool.rotate` (the armed-ghost branch is preserved inside the handler) |
| `C` connect | `tool.connect` |
| `V` / `1` select | `tool.select` |
| `F` frame the model | `view.fit` |
| `L` protect / unlock | `edit.protect` |
| modal gating: no viewport shortcut leaks behind an open dialog | preserved in `Workbench.tsx` |

## 3. Shortcut map

57 commands, all rebindable from the palette's KEYS tab, persisted under
`brickwright.workbench.shortcuts.v1`. The palette's RUN tab also lists the
shared mutating capabilities, which take arguments rather than a chord and open
a form in place; that list is what the Command Deck used to be.

`Mod` is ⌘ on Apple hardware and Ctrl elsewhere, so one saved map works on
both.

`Escape`, `Enter`, `Tab` and `Shift+Tab` are reserved by the shell — a rebind
that claimed one would let an operator lock themselves inside a dialog, so the
keymap editor reports it as a conflict instead.

A chord claimed by two commands fires **neither**, and the KEYS tab names both.
Silently preferring one would make the other look broken.

**Tools**

| Command id | Default chord | Does |
|---|---|---|
| `tool.select` | `v` | Pick parts, shift-drag to box select. |
| `tool.move` | `g` | Drag the translate gizmo on the selection. |
| `tool.rotate` | `r` | Drag the rotate rings on the selection. |
| `tool.connect` | `c` | Mate two parts through their real connectors. |

**Edit**

| Command id | Default chord | Does |
|---|---|---|
| `edit.undo` | `mod+z` | Reverse the last transaction, human or agent. |
| `edit.redo` | `shift+mod+z` | Reapply the last undone transaction. |
| `edit.clone` | `mod+d` | Duplicate the selection one part-width along X. |
| `edit.delete` | `delete` | Remove every selected part in one transaction. |
| `edit.quarter-turn` | `shift+r` | Turn the selection 90° about its own vertical axis. |
| `edit.mirror` | `shift+m` | Reflect the selection through an exact X plane. |
| `edit.array` | `shift+a` | Repeat the selection along an exact vector. |
| `edit.protect` | `l` | Toggle the kernel-enforced agent lock. |
| `edit.paint` | `p` | Recolour the selection to the palette’s active colour. |
| `edit.eyedropper` | `k` | Make the selected part’s colour the active colour. |

**Select**

| Command id | Default chord | Does |
|---|---|---|
| `select.all` | `mod+a` | Select every part in the document. |
| `select.none` | `shift+mod+a` | Deselect everything. |
| `select.inverse` | `mod+i` | Select everything the selection does not cover. |
| `select.connected` | `alt+c` | Expand through mated connectors to the whole rigid island. |
| `select.colour` | `alt+k` | Every part sharing a colour with the selection. |
| `select.subassembly` | `alt+m` | Every part in the selection’s subassemblies. |
| `select.definition` | `alt+p` | Every instance of the selected part numbers. |
| `select.save` | `shift+mod+s` | Name the current selection so it can be recalled. |

**View**

| Command id | Default chord | Does |
|---|---|---|
| `view.fit` | `f` | Reset to isometric and fit everything on screen. |
| `view.iso` | `alt+1` | Look at the model from three-quarters. |
| `view.front` | `alt+2` | Look along +Z. |
| `view.top` | `alt+3` | Look straight down. |
| `view.beauty` | `alt+b` | The normal shaded viewport. |
| `view.connections` | `alt+n` | Draw every compiled connector at its solved world position. |
| `view.violations` | `alt+x` | Highlight parts in a confirmed collision pair. |
| `view.exploded` | `alt+e` | Push subassemblies apart. Display only. |

**Visibility**

| Command id | Default chord | Does |
|---|---|---|
| `visibility.hide` | `h` | Stop drawing the selection. The document is unchanged. |
| `visibility.show-all` | `shift+h` | Clear hide, isolate and ghost. |
| `visibility.isolate` | `shift+i` | Draw only the selection until cleared. |
| `visibility.ghost` | `shift+g` | Draw the selection translucent so context stays readable. |
| `visibility.focus` | `shift+f` | Frame the camera tightly on the selection. |

**Panels**

| Command id | Default chord | Does |
|---|---|---|
| `panel.left` | `mod+b` | Collapse or restore the left dock. |
| `panel.right` | `shift+mod+b` | Collapse or restore the right dock. |
| `panel.bottom` | `mod+j` | Collapse or restore the bottom dock. |
| `panel.search` | `mod+k` | Put the cursor in the catalogue search field. |

**Project**

| Command id | Default chord | Does |
|---|---|---|
| `project.command-palette` | `mod+p` | Find and run any command by name. |
| `project.command-deck` | `mod+/` | The parameterised console for every shared capability. |
| `project.export` | `mod+e` | Download the exact flat .ldr for this revision. |
| `project.resequence` | `—` | Derive a verified attachment-aware build sequence. |

**Help**

| Command id | Default chord | Does |
|---|---|---|
| `help.shortcuts` | `?` | The full command map. |
| `help.welcome` | `—` | Show the first-run orientation again. |
| `help.keymap` | `—` | Rebind any command and see conflicts. |
| `help.reset-workspace` | `—` | Put the dock layout, palette sets and shortcut map back to their defaults. The model is untouched. |


## 4. Layout, docks and presets

`layout.ts` is the model; `Dock.tsx` is the chrome.

- **Docks**: left (palette), right (selection / transform / inspector / connect),
  bottom (timeline). Each resizable, collapsible to a rail, persisted under
  `brickwright.workbench.layout.v1`.
- **Splitters** are focusable `role="separator"` controls: drag, or arrow keys
  (`Shift` for a coarse step, `Home`/`End` for the limits), or double-click to
  collapse. Pointer-only resizing would exclude keyboard operators.
- **Limits**: left 208–460, right 240–520, bottom 108–360 px. The viewport is
  never allowed below 420 × 280; `clampLayout` reduces both docks
  proportionally, then collapses the right dock, rather than overflowing.
- **Presets**: none. The screen-shape presets were removed — they asked the
  operator to classify their monitor before seeing the editor, which
  `clampLayout` does correctly without asking.
- **Progressive disclosure**: every dock section is independently collapsible and
  its open state is persisted under `layout.v6`. Position opens the pose and
  the steppers; Precision holds the reference frame, pivot, axis locks, array,
  mirror, align/distribute and connector seats, and starts closed.
- `help.reset-workspace` in the command palette restores every default. The
  model is never touched by it.

## 5. What is new

Beyond parity:

1. **Extension registry** (§1) — seven slots, priority ordering, clean unmount,
   loud id collisions, per-contribution error boundaries, exclusive modals.
2. **Dockable resizable layout** with persistence and three presets.
3. **Palette**: drag-and-drop placement, favourites, recents, named custom
   palettes, pinned colour favourites, facets for category / footprint /
   connector family / colour availability, **card and list** views (compact was
   removed), keyboard-first search, windowed paging over the whole catalogue.
4. **Transform panel**: world / local / connector reference frames, per-axis
   locks, numeric entry, pivot selection, translate and rotate steppers, align,
   distribute, mirror, array, clone, paint, eyedropper, and a ranked list of
   alternative connector seats for the selected part.
5. **Selection modes**: by part, colour, connected component, subassembly, part
   number, visible region, and inverse; saved selection sets that report how
   much of a stale set survives; hide, isolate, ghost and focus.
6. **Command palette** (`⌘P`) with a remappable, conflict-checked, persisted
   shortcut map.
7. **Connect** as an explicit two-stage interaction: pick the moving part, pick
   the target, review the ranked mates, commit — with cancel and backtrack at
   every stage, and connector pinning on both sides.
8. **Status bar (unmounted).** `StatusBar.tsx` still states the mode, the scope,
   what the next click does, and how to cancel — but `Workbench` does not
   render it. Isolate / hide / ghost currently have no chrome readout of their
   own. Do not document the strip as live until it is mounted again.
9. **Designed states** for empty, loading, invalid selection, unavailable part,
   offline, proposal review and first run.

## 6. Acceptance gates and what proves them

Command output is in the workstream report; this is where each gate is proved.

| Gate | Proof | Result |
|---|---|---|
| Feature parity | §2 above, item by item | 0 capabilities dropped |
| Component tests | `src/editor/workbench/*.test.ts(x)` — registry, layout, selection, shortcuts, panels | 128 tests |
| Numeric vs gizmo equivalence | `transform.test.ts` — both paths funnel through `canonicalisePose`, compared with `canonicalTransform` | 21 tests |
| `npm run test:e2e` | `tools/e2e-smoke.mjs` | `status: passed` |
| find → place | keyboard-only: type, `↓`, `↵`, click viewport | +1 part, +1 revision |
| mate via Connect | 3 stages, seeded source, reviewed preview, commit | `matedEdges: 1`, +1 revision, part count unchanged |
| recolour | palette colour + Paint | `72 → 15` |
| clone | Clone action | +1 part, +1 revision |
| array | parameterised: 3 copies, Y axis, own size | +3 parts, +1 revision |
| isolate | Isolate | `Isolated 3 of 40 parts` was a status-bar readout; that strip is unmounted. Isolation still applies; there is currently no chrome sentence for it |
| numeric transform | typed X, read back, basis checked | field matches document, orthonormality error `0` |
| undo | unwinds the whole workflow | back to the pre-workflow part count, revision monotonic |
| Responsive | 1280×800, 1440×900, 1600×1000, 2560×1080 | no horizontal scroll, no region overflowing the shell, no control under 16 px, viewport ≥ 420×280 at every width |
| Keyboard | Tab sweep + splitter arrow-key resize | 60 controls reached; dock resized 268 → 284 px from the keyboard |
| Screen-reader labelling | every `button`, `input`, `select`, `textarea` in the mounted tree | 0 unnamed |
| Focus trapping | Tab off the last control in the command palette | stays inside the dialog |
| Focus restoration | open then close the palette | focus returns to the control that opened it |
| Contrast | 10 sampled text roles | 4.71:1 – 14.72:1, all above their floor |
| `prefers-reduced-motion` | computed transition duration | `0.15s` → `1e-05s` |
| Visual regression | `artifacts/workbench/` | 17 states |

### Visual-regression states

`layout-1280x800`, `layout-1440x900`, `layout-1600x1000`, `layout-2560x1080`,
`state-default`, `state-transform`, `state-palette-facets`, `state-connect`,
`state-isolate`, `state-dock-collapsed`, `state-command-palette`,
`state-keymap`, `state-keymap-conflict`, `state-validate`,
`state-render-connections`, `state-render-exploded`, `state-timeline-history`.

## 7. What is not proved here

Stated plainly, because an unproved claim that reads like a proved one is worse
than no claim.

1. **Ghosting is capped at 150 parts.** It draws each part individually through
   the renderer's ghost path, so beyond that it refuses and says to use hide or
   isolate instead. The cap is a real limit, not a measured performance ceiling.
2. **`localStorage` is unavailable under the unit-test runner** (jsdom in this
   Node build). Every preference falls back to an in-memory mirror there, so the
   *persistence across a reload* is proved only in the browser run, not in the
   unit tests. The unit tests prove the round-trip through the same API.
3. **Drag-and-drop from the palette into the viewport** is covered by a unit
   test that asserts the drag payload, and by manual use. The drop itself replays
   a pointer sequence on the canvas; the browser run exercises click-to-place,
   not the synthesised drop.
4. **The `connector` reference frame** uses the part's first compiled connector
   when none is pinned. For a part whose connectors do not share an axis this is
   a choice, not a derivation; the control says which frame it is using and
   reports when a part has no compiled connectors at all.
5. **Contrast is sampled on ten text roles**, not swept across every element.
   Older decorative labels elsewhere in the sheet were not all re-measured; the
   two shared tokens they draw from (`--muted`, `--faint`) were raised to 5.2:1
   and 4.7:1 on the panel background.
6. **Trackpad gestures** (pinch-zoom, two-finger orbit) are the renderer's
   `OrbitControls`, unchanged by this workstream and not separately asserted
   here. Mouse and keyboard paths are.
7. **The e2e navigates to `/editor`**, following the platform shell's routing. If
   that path changes, this run needs updating with it.
8. **The acceptance run drives the Vite dev server**, so a file saved while it is
   running triggers an HMR reload and kills the run mid-step. That is a property
   of running it during concurrent editing, not of the editor: two failures seen
   that way were a navigation mid-`evaluate` and a build-guide render exceeding
   its budget under a load average of 17. Both passed unchanged on a quiet
   repository. The build-guide budget was raised to 300 s for that reason; every
   assertion about the guide's contents is unchanged.
