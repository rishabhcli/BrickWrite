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
| `status` | bottom status bar, right of the built-in readouts | one short inline readout |
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
| Live-kernel status strip with the next-click hint | `ViewportStage.tsx` **and extended** into the new status bar |
| Diagnostic legend per render mode, with the colour key and "back to beauty" | `ViewportStage.tsx` (`RENDER_MODE_COPY` verbatim) |
| Placement HUD with part name, R to turn, Esc to cancel | `ViewportStage.tsx` |
| Empty-build state with "Pick a starter brick" | `states.tsx` `EmptyBuildState`, rendered by `ViewportStage` |
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
| `WelcomeGuide` first-run, `markWelcomeSeen` / `welcomeUnseen` | unchanged file, opened by `Workbench`'s boot effect |
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
| `⌘/` command deck | `project.command-deck` |
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

47 commands, all rebindable from the palette's KEYS tab, persisted under
`brickwright.workbench.shortcuts.v1`. `Mod` is ⌘ on Apple hardware and Ctrl
elsewhere, so one saved map works on both.

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
- **Presets**: Laptop (1280-class), Desktop (1600-class), Ultrawide (2560+).
  Chosen in the status bar; the first run picks one from the window width.
- **Progressive disclosure**: every dock section is independently collapsible and
  its open state is persisted.
- `help.reset-workspace` in the command palette restores every default. The
  model is never touched by it.

## 5. What is new

Beyond parity:

1. **Extension registry** (§1) — seven slots, priority ordering, clean unmount,
   loud id collisions, per-contribution error boundaries, exclusive modals.
2. **Dockable resizable layout** with persistence and three presets.
3. **Palette**: drag-and-drop placement, favourites, recents, named custom
   palettes, pinned colour favourites, facets for category / footprint /
   connector family / colour availability, card / compact / list views,
   keyboard-first search, windowed paging over the whole catalogue.
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
8. **Status bar** that always states the mode, the scope, what the next click
   does, and how to cancel.
9. **Designed states** for empty, loading, invalid selection, unavailable part,
   offline, proposal review and first run.
