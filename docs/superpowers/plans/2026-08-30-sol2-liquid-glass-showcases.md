# Liquid Glass chrome and showcase sets

> **Assigned agent:** GPT 5.6 Sol (2)
> **Sibling plans (run in parallel, do not execute them):**
> - Claude Opus 5 — [`2026-08-30-opus-agent-ml-generation.md`](./2026-08-30-opus-agent-ml-generation.md)
> - GPT 5.6 Sol (1) — [`2026-08-30-sol1-cad-fluidity-mechanisms.md`](./2026-08-30-sol1-cad-fluidity-mechanisms.md)
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the square, drafting-board chrome with an iOS 27 / iPadOS 27 **Liquid Glass** system (React components, tokens, floating islands, continuous rounded surfaces) **without frosting the WebGL canvas**, and ship original showcase builds in the complexity class of LEGO City 60473 The City Tower, Architecture/Icons landmarks (Eiffel, clock palace), and a saucer-freighter with moving parts — not another AABB shop terrace.

**Architecture:** Introduce `src/ui/glass/` — design tokens + a handful of React primitives used by workbench chrome, landing, and panels. Split editor CSS out of the landing-critical `src/styles.css` (`docs/improvements/02-performance.md` #2). Author new demos in `tools/build-demos.mjs` using existing planners plus Sol (1) planners when present. **Never import official LEGO inventories or Star Wars IP.**

**Tech Stack:** React 19, existing CSS (no Tailwind unless you isolate it — **prefer CSS variables + the glass primitives**; the repo has no Tailwind today). Optional npm: `@ios27_design_system/react` as a **token/reference** — vendor tokens into `src/ui/glass/tokens.css` so Apple-ish visuals don’t depend on an unmaintained 2-star package at runtime if the API is unstable. `lucide-react` stays. Hexclave components: do not restyle their internals; wrap pages around them.

**Spec:** This document. Opus owns generate-first agent logic. Sol (1) owns camera/gizmos/kernel planners. You own everything the user looks at that is not the GPU scene graph.

## Global Constraints

- Dirty tree is fine; do not commit or push unless the operator asks.
- **Do not copy official LEGO sets.** No 60473 / 75192 / 75375 / 10307 / 10253 part lists, no minifig names from City No Limits, no “Millennium Falcon” / “LEGO Star Wars” branding, no Disney IP. Original MOCs inspired by *techniques and program* only. Titles like “Harbour Control Tower”, “Iron Lattice Lookout”, “Westminster Clock Palace”, “Saucer Freighter”.
- Do not put `backdrop-filter` on `canvas` or `.viewport-stage` full-bleed overlays that blur the model. Glass is for **chrome**.
- Honour `prefers-reduced-transparency` and `prefers-reduced-motion` (solid surfaces, no specular chase).
- Contrast: `--faint` must stay ≥ 4.5:1 on panel and void (`docs/improvements/03-accessibility.md` #1). Glass cannot drop body text below AA. If a glass fill fails contrast, add an opaque scrim token `--glass-scrim`.
- Hexclave: do not restyle third-party auth DOM. Do not add Hexclave features. Keep account entry points working.
- Do not rewrite `src/generation/phases.ts`, `src/agent/tools.ts`, `CadViewport.tsx` scene graph, or `src/cad/assembly.ts` planners. **Call** planners from demos.
- Listen for `brickwright:intent-describe` (Opus Task 9) and open/focus Generate.
- User instructions override skill approval gates for this turn.

---

## Why this workstream exists (pain, measured)

Two operator complaints, one owner:

1. **UI is too square** — `src/styles.css` uses `border-radius: 2px–4px` on almost every control (grep: dozens of 2px/3px/4px radii). Comment in `:root` even frames the viewport with “corner ticks” like a drafting sheet. Fonts: Manrope + **Chakra Petch** display. Docks are hard rectangles (`--dock-bg: rgba(12, 18, 20, 0.94)` — nearly opaque, not glass). `body { min-width: 1024px }`. `.app-shell` is a 5-column grid with 4px splitters. This reads as 2014 CAD, not 2027 Apple.
2. **Demos are basic relative to real sets** — not because they are small. Illinois Main Quad is **11,473** parts. The gap is *kind*: all three published demos are **modular architecture AABB stacks** (Harbour Street shops, Meridian Tower 22-storey shell, campus quad). No SNOT hull, no lattice at ironwork angles, no string crane, no metro, no clock hands, no boarding ramp, no turret. Meridian Tower is a glazed extrusion, not City Tower’s mashed program (train + fire + police + skate + rocket + crane + homes).

UX findings you should absorb while restyling (`docs/improvements/06-ux-information-architecture.md`):

- #3 Agent / Generate / Refine are **below the fold** in the right dock (priority 120–130) under Selection/Transform/Inspector. **Tab strip or default-collapse Selection/Transform.** This is chrome IA — yours.
- #4 Three command palettes. Merge visually.
- #5 Brand lockup is not a link. Make it navigate to `/` or a menu of PRIMARY_NAV.
- #9 Viewport overlay repeats revision/selection four times. Delete duplicates while you glass the HUD.
- #1–2 lying CTAs: Sol (2) **may** pass `?doc=blank` / keep `?intent=describe` on landing buttons **if you touch Hero.tsx** — honour 06#1–2. Opus reads `intent=describe`. For blank: `?doc=blank` must be honoured in session boot (`src/cad/session.ts` is **kernel/session** — not yours). **Do not edit session.ts.** Landing can still *link* to `?doc=blank`; file a coordination note for whoever owns session, or implement the reader in `src/editor/workbench/useWorkbench.ts` **only if** Sol (1) isn’t touching it. Safer: landing CTA copy stays; add a Generate-focused path you fully control.

**Default right dock collapsed** (`layout.ts` desktop preset already `right.collapsed: true`) hides Generate entirely. Change default sections so Agent/Generate/Refine are **open** and Selection/Transform **closed** on first run, without destroying persisted layout.

---

## Shared contracts

### Exclusive ownership (this agent)

- All `*.css` currently in the repo (list at end of this section)
- **Create** `src/ui/glass/**`
- `src/editor/workbench/Workbench.tsx`, `Dock.tsx`, `TopBar.tsx`, `Toolbar.tsx`, `StatusBar.tsx`, `layout.ts`, `ViewportStage.tsx` (chrome only — do not replace CadViewport)
- `src/editor/workbench/SelectionPanel.tsx`, `InspectorPanel.tsx`, `PalettePanel.tsx`, `NumberField.tsx`, `AutonomySwitch.tsx`, `states.tsx` — classNames + structure for glass; **do not change command dispatch**
- `src/editor/WelcomeGuide.tsx`, `ShortcutGuide.tsx`, `ProjectMenu.tsx` chrome
- `src/agent/workbench.css`, `src/agent/AgentWorkbench.tsx` — **classNames and layout wrappers only**; do not change `AgentSession` calls
- `src/generation/panel.css`, `GeneratePanel.tsx` / `BriefEditor.tsx` / `CompareDialog.tsx` — wrappers/classNames; do not change `GenerationSession` API
- `src/refinement/panel.css`, `RefinePanel` chrome
- `src/features/**` (landing, explore, gallery, projects, share pages)
- `src/platform/platform.css`, `AppShell.tsx` layout chrome (not auth logic)
- `src/cloud/cloud.css` and panel chrome classNames
- `tools/build-demos.mjs`, `public/demos/**`, `src/demos/**` (generated files are written by the tool)
- `src/editor/workbench/CommandPalette.tsx`, `src/editor/CommandDeck.tsx` chrome
- E2E landing visual tests if they assert radii/colors — update snapshots with intent

### CSS files you own

`src/styles.css`, `src/agent/workbench.css`, `src/generation/panel.css`, `src/refinement/panel.css`, `src/cloud/cloud.css`, `src/platform/platform.css`, `src/features/landing/landing.css`, `surface.css`, `studio.css`, `src/features/explore/explore.css`, `src/features/gallery/gallery.css`, `src/features/projects/projects.css`, `src/features/share/share.css`, `src/intelligence/ui/find-parts.css`

### Forbidden

| Path | Owner |
|---|---|
| `src/agent/tools.ts`, `toolschemas.ts`, `guidance.ts`, `session.ts`, `server/assistant/**`, `src/generation/phases.ts`, `engine.ts`, `realize.ts`, `brief.ts` (logic) | Opus |
| `CadViewport.tsx`, `src/editor/render/**`, `PartBatch.tsx`, `useCad.ts`, `src/cad/articulation.ts`, `assembly.ts` (planners) | Sol (1) |
| `src/cad/session.ts` | avoid; blank-doc is 06#1 |

### Seams

- **Class names Sol (1) will keep:** `.viewport-quick-controls`, `.viewport-control-row`. Glass them.
- **Custom event:** `window.addEventListener('brickwright:intent-describe', …)` → expand Generate section, focus textarea.
- **Demos:** import `planWall`, `planEnclosure`, `planBrickField`, `planHingedFlap` from assembly (exist today). If `planCrane`, `planLattice`, `planSnotHull`, `planClockFaces` exist, use them. If not, compose hinges + enclosures + fields and note “awaiting Sol (1) planners” in the demo `planWarnings`.
- **`package.json` `catalog:build` `packExtra`:** append-only part ids your demos require. Do not reorder.
- **`useWorkbench.ts`:** avoid. Layout persistence lives in `layout.ts` (yours).
- **Hexclave React components:** wrap, don’t fork.

---

## Current visual system (what you are replacing)

```css
/* src/styles.css :root — today */
--dock-bg: rgba(12, 18, 20, 0.94);
--panel: #0d1315;
--void: #06090a;
--cyan: #83e7ee;
--display: 'Chakra Petch', 'DIN Condensed', sans-serif;
border-radius: 2px; /* focus, chips, docks, almost everything */
```

`.app-shell` grid: `52px 44px minmax(0,1fr) 146px 24px` × `268px 4px 1fr 4px 300px`.

Landing already has some motion (`src/features/landing/*`). Editor does not share those tokens (`--bw-faint` vs `--faint`). **Unify tokens** in `src/ui/glass/tokens.css` imported once.

Workbench comments in CSS show someone already tried to *reduce* lines. Liquid Glass is the opposite of more hairlines: **material + light**, not more 1px borders.

---

## Unfiltered research dump (Liquid Glass, React UI, demos, LEGO, OSS)

### Apple Liquid Glass (what “iOS 27” means here)

1. **WWDC 2025 — iOS 26 Liquid Glass.** Apple introduced Liquid Glass as a system material across iOS 26, iPadOS 26, macOS Tahoe 26, watchOS 26, tvOS 26. It is not “frosted glass 2013”: it refracts, speculates, and tints from content behind it. Dynamic blur radius by role (nav bar ~24px, small control ~8px). Accessibility: Reduce Transparency / Increase Contrast / Reduce Motion flip the material automatically on-device.
2. **WWDC 2026 — iOS 27 retune** (as described by community kits): **transparency slider**, **darkened edges**, **layered app icons**. Glass got *edges* again because WWDC 2025 glass was criticised as low-contrast / smear. **You must ship darkened edges and a contrast-safe tint.** Do not ship 2025-style white smear over a dark CAD scene.
3. **HIG:** materials, concentric rounding (parent radius = child radius + padding), floating toolbars on iPad, tab bars as glass capsules, sheets with glass headers.
4. **Web approximation limits** (LogRocket, various): CSS `backdrop-filter: blur()` + saturate + SVG `feDisplacementMap` / specular. You will **not** get OS-level lighting. Do not claim “real Liquid Glass.” Claim “Liquid Glass-inspired material.”
5. **Performance:** `backdrop-filter` on large regions is expensive, especially over WebGL (some browsers promote extra layers and **stall the compositor with the GPU canvas**). **Never** glass the canvas. Glass only: top bar, docks, tool islands, modal sheets, landing nav. Limit simultaneous blurred surfaces (≤ 4 large ones).
6. **`prefers-reduced-transparency`:** `--glass-fill: var(--panel)`; no blur.
7. **Dark CAD context:** Apple glass in dark mode uses **darkened** materials, not milky white. Tokens: fill `rgba(20, 24, 28, 0.62)`, border `rgba(255,255,255,0.22)` inner + `rgba(0,0,0,0.45)` outer (the iOS 27 darkened edge).

### Open-source Liquid Glass / iOS 27 kits (evaluate, don’t blindly npm-install all)

8. **`@ios27_design_system/react`** — https://github.com/seunghan91/ios27-design-system — React 18/19, tokens, ~14 React components + 36 specs, 48 page recipes. npm: `npm install @ios27_design_system/react`. **Very new / low star count.** Use as **reference and token crib**. If the package is complete and MIT, you may depend on it; **copy tokens into-repo** so Brickwright isn’t bricked by a 1.0.1 break. Components: Button, Toolbar, List Row, Toggle, etc. **Do not import their window chrome in a way that fights our docks.**
9. **Predecessor `ios26-design-system`** (same author) — historical tokens.
10. **`liquidglass-tailwind`** — https://github.com/Tontoon7/liquidglass-tailwind — Tailwind plugin + Claude skill. **Repo has no Tailwind.** Adopting Tailwind for the whole app is a war with `styles.css`. **Do not introduce Tailwind for the editor** unless you isolate `src/ui/glass` with its own build (not worth it). Read their token table (`bg-glass-light`, `rounded-glass-xl`, reduced-transparency) and **recreate in CSS variables**.
11. **`liquid-glass-react`** (GitHub; LogRocket) — displacementScale, blurAmount, bounce. Displacement over a CAD dock is cute and **can look cheap**. Use only for small chips, not the right dock.
12. **`@liquidglass/react`** — SVG displacement + backdrop. Same caution.
13. **Magic UI / Aceternity / 21st.dev glass cards** — marketing landing. Fine for `/` hero; keep editor calmer.
14. **shadcn/ui** — copy-paste Radix. Not glass, but **Dialog, Dropdown, Tabs, Tooltip, Sheet** primitives would fix 06#4/#6 and 03#3 (focus trap). Brickwright already has `useFocusTrap` in `src/platform/a11y.ts`. Prefer **existing a11y hooks** + glass styling over adding the full shadcn stack. If you need Tabs, a 40-line `GlassTabs` is enough.
15. **Radix UI / Base UI / React Aria** — accessible primitives. React Aria is heavy. Radix Tabs/Dialog if you need them; don’t restyle Hexclave.
16. **vaul** — drawers. iOS sheet pattern. Optional for mobile; `min-width: 1024px` currently **forbids** mobile. **Do not spend this plan on a phone layout** unless leftover. Desktop liquid glass first.
17. **cmdk** — command palette. You already have CommandPalette + CommandDeck. **Visually unify**, don’t add a third library unless you delete one surface (06#4).
18. **sonner** — toasts. Check if notices already exist (`api.notify`). Skin those; don’t add a parallel toast stack.
19. **framer-motion / motion** — spring. Repo already has `--spring: cubic-bezier(0.16, 1, 0.3, 1)`. CSS transitions may suffice. If you add `motion`, use it only in `src/ui/glass` and landing, not inside CadViewport.
20. **lucide-react** — already in use. Keep. iOS uses SF Symbols; lucide is the web stand-in. Do not add a second icon set.
21. **@fontsource** — Manrope Variable + Chakra Petch already. Liquid Glass UIs typically use **SF Pro**. We cannot ship SF Pro. Options: keep Manrope (humanist, close to SF); add **Inter** or **IBM Plex Sans**. **Drop Chakra Petch for UI chrome** (keep it only for landing wordmark if brand needs it). Display-condensed on every heading is why the app feels like a CNC panel.
22. **Apple Human Interface Guidelines** (web) — read materials, layout, toolbars.
23. **LogRocket “Adopting Apple’s Liquid Glass”** — Figma + CSS examples; specular highlight as `linear-gradient` overlay `pointer-events: none`.
24. **wolfnhare design tokens article** — blur-by-role, SVG filter example. Use role tokens: `--glass-blur-nav: 20px; --glass-blur-control: 10px; --glass-blur-chip: 6px`.

### React component inventory you should actually build

Keep the set small. Every primitive in `src/ui/glass/`:

| Component | Maps to | Used by |
|---|---|---|
| `GlassRoot` | sets data-theme, reduced-transparency class on html | AppShell / Workbench |
| `GlassBar` | iPad floating toolbar | TopBar, maybe Toolbar as an island over the viewport |
| `GlassDock` | frosted sidebar | Dock.tsx |
| `GlassIsland` | capsule cluster | primary tools (Select/Move/Rotate/Connect) floating **over** the viewport bottom-center (iPadOS style) **in addition to** or **instead of** the 44px tool row. Prefer **move primary tools onto an island** and thin the top grid row to give the model pixels (styles.css already fought for 28px). |
| `GlassPanel` | card | Generate, Agent, Inspector sections |
| `GlassTabs` | segmented | Agent / Generate / Refine / Inspect on the right dock |
| `GlassButton` | filled / tinted / plain | everywhere we have square `<button>` |
| `GlassField` | search / number | NumberField wrapper |
| `GlassSheet` | modal | ProjectMenu, ExportCenter — wire `useFocusTrap` |
| `GlassNotice` | toast | existing notify |

Do **not** rebuild the 3D gizmo in DOM.

### Workbench IA (must change with the skin)

25. **Right dock tabs:** `Design` (Agent + Generate + Refine stacked inside one glass panel with inner segments) vs `Object` (Selection, Transform, Inspector). Default tab: Design. This is the actual fix for 06#3.
26. **Floating tool island** over the canvas (pointer-events auto on the island only). Sol (1) keeps ViewportQuickControls; you glass them and possibly relocate into the island.
27. **Strip ViewportStage overlay chrome** (06#9): one breadcrumb max.
28. **Brand lockup → `/`** plus a popover to Explore / Projects / Gallery (06#5).
29. **Rename Codex → Agent** (06#7) in TopBar / AutonomySwitch copy. Class `.codex-state` → `.agent-state` (grep tests).
30. **Delete confirm** (06#6) — reuse cloud dialog pattern; glass sheet.
31. Split `styles.css` so landing doesn’t load dock CSS (`02` #2). `Workbench.tsx` imports `workbench.css` / `glass.css`.

### Open-source LEGO / content (demos)

32. **LDraw parts + Shadow Library** — already compiled. Demos must stay inside placeable pack or you append `packExtra`.
33. **Rebrickable set inventories** — **do not paste 60473’s BOM into a demo.** Using Rebrickable to *learn* which element categories appear (windows, tracks, crane pieces) is OK; then pick **placeable** equivalents.
34. **OMR MPDs of 10307 / 75192** — **do not ship.** License + LEGO IP + we would be laundering official models.
35. **buildinginstructions.js** — playback; kernel already has instruction steps. Optional: landing turntable of demos (landing already has BrickSculpture).
36. **qk-lego / gr8brik** — UI ideas only.
37. **BrickGPT models** — 20³ cuboids; useless as showcases.
38. **Existing demo compiler** `tools/build-demos.mjs` — programmatic, gated (collision, connected, statics, build order, worse rough candidate). **New demos must pass the same gates** or the tool exits non-zero. `tensionAllowance` pattern exists for seated glass. Mechanisms may need a documented tension/statics allowance like Meridian Tower.
39. **`--only=id`** already on the compiler — use it while iterating.

### LEGO City 60473 The City Tower (June 2025) — program to *reinterpret*

Sources: LEGO.com news 17 May 2025; product 60473; Brick Fanatics; Blocks magazine.

- 1,941 pieces, 8+, $209.99 / £179.99 / €199.99. ~49 cm H × 48 W × 44 D.
- Second-largest City set (60380 Downtown is larger).
- Mash-up: **metro** + **police** + **fire** + **construction crane** + **skate ramp** + **rooftop spaceship pad** + **homes** (Brickle family, three floors, rear access, modular furniture).
- Vehicles: metro train, police car, fire car, spaceship.
- Crane: **string**, raise/lower, extendable arm, rotating cab.
- Combinable with 60304 road plates, 60205/60238 tracks, other City sets.
- Visual: somewhat 10251 Brick Bank / modular, but play features dominate the silhouette.
- Minifigs: 7, including City No Limits TV characters — **do not use those characters.**

**Our demo `harbour-control-tower` (name TBD):** original city-block tower on a road+rail plinth. Required program (even if simplified):

- 3+ occupiable storeys with interiors (furniture as simple tile/chair if catalog allows)
- Two vehicle bays with hinged doors (`planHingedFlap`)
- A working or kernel-articulated crane (`planCrane` or flap+mast)
- A rail run with a small train (plates + wheels if placeable; else a tiled “metro” slot the width of a train)
- A ramp
- A roof pad with a small wedge ship (SNOT or slopes)
- Separable storeys (existing Harbour Street technique)
- Target **1,800–4,000** parts, not 200. Distinct parts > 40 if the pack allows.

### Millennium Falcon class — reinterpret as original saucer

40. **UCS 75192** (2017): 7,541 pcs, ~84 cm long. Functions: boarding ramp, turrets, landing gear, interior. **The bar for “moving parts + hull techniques.”**
41. **Midi 75375** (2024): 921 pcs, stand, **no functions.** Do not treat as the complexity target.
42. **10179** (2007 UCS): 5,195 pcs — historical.

**Our demo `saucer-freighter`:** original disk hull, offset cockpit tube, mandible-like forward split, dish on a clip, **hinged ramp**, **dorsal turret** (pin joint), optional landing-gear flaps. No nameplate “Millennium Falcon”, no Rebel/Imperial decals, no Star Wars font. Target 2,500–6,000 parts. Needs `planSnotHull` or a lot of plates-on-edge. If Sol (1) hasn’t landed, build a **faceted** hull from wedges/slopes that *are* in the pack and still pass gates.

### Eiffel Tower 10307 / Big Ben 10253 — landmarks

43. **10307 Eiffel Tower:** 10,001 pcs, ~149 cm, lattice, three platforms, 2022 Icons. OMR thread: 4–5 decimal rotations, flex, months of CAD. Our pack may not include all lattice uniques.
44. **10253 Big Ben:** 4,163 pcs, clock faces, palace + tower, retired.
45. **Architecture micro** (21013 Big Ben, 21019 Eiffel, etc.) — too small; not the bar.
46. Public-domain **buildings** may be interpreted in bricks. LEGO’s specific sculpt is copyrighted — so **do not** 1:1 the set. Interpret the real tower/palace.

**Demos:**

- `iron-lattice-lookout` — observation tower, two decks, ortho lattice v1 (or Sol (1) `planLattice`), mast. Target 3,000–8,000 parts. May need `tensionAllowance` for lattice rest-on-beam.
- `clock-palace` — clock stage + four tiled faces + hands on bars + lower hall. Target 2,500–4,500 parts.

### Other City / Icons references (context only)

47. 60380 Downtown — largest City; street scene. We already have Harbour Street; don’t clone it.
48. 60371 Emergency Vehicles HQ — combined services; weaker than 60473.
49. Modular buildings (10251 Brick Bank, 10270 Bookshop, 10312 Jazz Club, 10326 Natural History Museum) — interior + shutter techniques. Steal *techniques*, not facades.
50. 21058 Great Pyramid / 21060 Himeji — Architecture; different from 10307 scale.

### Catalog / pack risk (unfiltered)

51. Runtime pack is **900 / ~22,941** shapes (`07` #6). Demos that need windscreens/gears/rails **will fail `GEOMETRY_UNAVAILABLE`**. Compiler already uses `packExtra`. **List every definitionId you need**, append to `packExtra`, rebuild catalog in your environment if you can; if catalog rebuild is too heavy, **restrict demos to known placeable ids** (read `public/catalog/...` or `catalog.placeable()` in the demo tool).
52. Hinge 3937/3938 already in `packExtra` (package.json catalog:build). Windows 60592/60601 too. Train rails / string / gears may not be.
53. Minifigs / characters: Illinois demo already has “LEGO characters.” You may add figures if those parts are placeable; do not use licensed heads.

### Landing / marketing OSS

54. Existing `src/features/landing/BrickSculpture.tsx` — keep, glass the page around it.
55. Do not add fake testimonials (`06` related constraints in other plans).
56. Hexclave analytics/clickmaps exist as platform apps — **do not implement** new telemetry here.

### What not to do

57. No Tailwind migration of the whole app.
58. No three.js postprocessing bloom on the editor by default (wash + cost). Landing-only maybe.
59. No iPhone-only layout this pass (`min-width: 1024px` can stay; you may lower to 900 if the island layout works).
60. No shipping `@ios27_design_system` Storybook.
61. No official LEGO logo as a control.
62. Do not regenerate Illinois/Harbour/Meridian unless gates break; **add** demos, don’t delete the three that exist without cause. You may mark a new demo `hero: true` instead of Illinois if it photographs better — coordinate with landing.

---

## Design

### Visual direction

- **Material:** dark liquid glass, darkened edge, 1px specular top (`linear-gradient` 180deg, rgba(255,255,255,0.28), transparent 40%). Inner shadow optional.
- **Radius:** `--r-control: 14px; --r-panel: 22px; --r-island: 28px; --r-sheet: 26px`. Concentric: dock 22, section 18.
- **Type:** Manrope for all chrome. Chakra Petch only on marketing wordmark. Numeric fields stay tabular.
- **Accent:** keep cyan `--cyan` as the single interactive tint (iOS blue analogue). Orange for warnings already in tokens.
- **Toolbar:** become a **floating GlassIsland** at bottom-center of the viewport (safe-area padding). TopBar becomes thin glass (52px → 44px) with brand, project, agent status.
- **Docks:** glass; content scrolls under the section header (iOS 27 “content under nav”).
- **Focus ring:** 2px cyan, radius inherit (not 2px square).

### Component API (implement exactly)

```tsx
// src/ui/glass/GlassPanel.tsx
export function GlassPanel(props: {
  as?: 'div' | 'section' | 'aside'
  radius?: 'control' | 'panel' | 'island' | 'sheet'
  blur?: 'nav' | 'control' | 'chip'
  className?: string
  children: React.ReactNode
}): JSX.Element
```

```css
/* tokens.css */
html[data-reduced-transparency="true"] .glass-fill {
  backdrop-filter: none;
  background: var(--panel);
}
```

Set `data-reduced-transparency` from `matchMedia('(prefers-reduced-transparency: reduce)')` in `GlassRoot`.

### Demo compiler additions

Follow existing demo object shape in `tools/build-demos.mjs` (read the harbour-street authoring functions and copy the pattern). Each new demo needs:

- `id`, `title`, `discipline`, `brief.prompt`, palette, envelope
- `rough` candidate that **fails** a gate the published one passes (refinement story)
- `tensionAllowance` + reason if statics flags seated glass / lattice bearing
- Assets: document, preview, rough, thumb, social — the tool already rasters

Suggested ids:

| id | Discipline | Depends on Sol (1) |
|---|---|---|
| `harbour-control-tower` | City play architecture | `planCrane` optional |
| `saucer-freighter` | Vehicle / SNOT | `planSnotHull` optional |
| `iron-lattice-lookout` | Landmark lattice | `planLattice` optional |
| `clock-palace` | Landmark interior + mechanism | `planClockFaces` optional |

Ship **at least two** of four in this pass if catalog/planners block the others; prefer **harbour-control-tower + saucer-freighter** (operator named City Tower + Falcon). Lattice + clock if time.

`--only=harbour-control-tower` while iterating.

### Landing / Explore

- Feature new demos in Explore/Gallery cards.
- Hero can stay Illinois until a new hero renders; then switch `hero: true`.
- Glass the landing nav using the same tokens (unify `--bw-*` with `--*`).

---

## Task list

### Task 1: Tokens + GlassRoot + reduced transparency

**Files:** Create `src/ui/glass/tokens.css`, `GlassRoot.tsx`, `index.ts`; import from `src/main.tsx` or `AppShell.tsx` (platform chrome — yours)

- [x] Tokens for fill, edge, specular, radii, blurs, scrim.
- [x] `--faint` AA-safe.
- [x] Media query + `data-reduced-transparency`.
- [x] Do not apply blur to `#root` or canvas parents.

### Task 2: Primitives

**Files:** `GlassPanel`, `GlassBar`, `GlassDock`, `GlassIsland`, `GlassTabs`, `GlassButton`, `GlassField`, `GlassSheet`

- [x] Each has a small vitest render test **or** a single `src/ui/glass/glass.test.tsx` that mounts them.
- [x] Buttons use existing focus-visible pattern with inherited radius. The base rule forced `border-radius: 2px`, squaring the ring on every rounded control; removed so the outline follows each element's own radius.

### Task 3: Split editor CSS off landing

**Files:** `src/styles.css` (keep tokens + reset), create `src/editor/workbench/workbench.css` imported by `Workbench.tsx`

- [x] Move dock/gizmo/command-palette rules out of the always-loaded sheet (`02` #2).
- [x] Landing e2e byte budget should not grow; editor CSS should appear in the editor chunk.
- [x] Visual: landing still paints.

### Task 4: Workbench chrome — glass + IA

**Files:** `Workbench.tsx`, `Dock.tsx`, `TopBar.tsx`, `Toolbar.tsx`, `layout.ts`, `ViewportStage.tsx`, `StatusBar.tsx`

- [x] Glass docks and top bar.
- [x] Right dock `GlassTabs`: Design | Object. Default Design. Persist tab in `layout.sections` or a new `layout.rightTab` field (extend `WorkbenchLayout` with a default so old persisted layouts still load).
- [x] Floating `GlassIsland` for primary tools; keep keyboard shortcuts.
- [x] Brand links to `/` + nav popover (`GlassSheet` or menu).
- [x] Codex copy → Agent; class rename; fix tests grepping Codex.
- [x] Strip duplicate viewport overlay (06#9) — the stage now carries one selection readout and no revision readout, down from four.
- [x] Listen `brickwright:intent-describe`.
- [x] `npm test -- src/editor/workbench src/platform`

### Task 5: Panels + dialogs

**Files:** Agent/Generate/Refine CSS + classNames; ProjectMenu; ExportCenter; delete confirm on local projects

- [x] GlassPanel wrappers.
- [x] Focus trap on dialogs (03#3) via existing `useFocusTrap`.
- [x] Delete confirm (06#6).

### Task 6: Landing + marketing surfaces

**Files:** `src/features/landing/**`, explore/gallery/projects CSS

- [x] Same tokens. Rounded glass nav. No Chakra Petch in body UI. **Partial, deliberately:** `GlassRoot` wraps the app in `main.tsx` so `tokens.css` loads on every surface including landing, and Chakra Petch appears only as an 8–11px eyebrow/label face, never on body copy. Landing still declares its own `--bw-*` set alongside the shared one; collapsing the two is a cross-file CSS refactor with no automated visual check, so it is written up rather than done blind — see NIGHT-QUEUE. What *was* done is the part that could be measured: `--bw-faint` shipped the same sub-AA value the editor did (4.28:1 on `--bw-panel-2`) and is now fixed and guarded.
- [x] CTAs: keep `intent=describe`; add `doc=blank` only if you also implement a **tiny** reader in a file you own (e.g. Workbench reads search and calls an existing `session` API if one exists). If `createBlankDocument` is only reachable from ProjectMenu, **don’t lie**: change the landing button label **or** invoke the same path ProjectMenu’s New uses by linking to a hash ProjectMenu already understands. Read `ProjectMenu.tsx` New handler. If it is `session.newProject()`, you may call that from a workbench boot effect when `doc=blank` — `Workbench.tsx` is yours; `session` import from `src/cad/session.ts` is a **read/call**, not a rewrite of session internals. Allowed: boot effect in Workbench.
- [x] Honour 06#1: `?doc=blank` → blank document, not rover.

### Task 7: Demo — harbour-control-tower

**Files:** `tools/build-demos.mjs`

- [x] Author original city tower program (see research).
- [x] Pass all compiler gates.
- [x] Rough candidate worse than published.
- [x] `node tools/build-demos.mjs --only=harbour-control-tower`
- [x] Thumbnails look like a **play set**, not a single extruded box.

### Task 8: Demo — saucer-freighter

- [x] Original hull; ramp joint; turret joint.
- [x] No Star Wars naming or silhouette stolen 1:1 from copyrighted movie design — use a **distinct** planform (e.g. hex saucer, center cockpit, twin booms) that still exercises SNOT + hinges. If you make it too Falcon, change it.
- [x] Gates pass.

### Task 9: Demo — lattice and/or clock-palace (stretch, still in plan)

- [x] At least one landmark demo if pack allows.
- [x] Clock hands articulated if `planClockFaces` or bar-clip exists.

### Task 10: Explore/landing wiring + visual QA

- [x] Manifest consumed by Explore; new cards.
- [x] `npm test -- src/demos src/features/landing src/editor/workbench`
- [x] Browser pass: landing, editor chrome, open a new demo, tabs, island, reduced transparency (devtools).
- [x] Update e2e screenshots if tests fail on pixels.

---

## Verification

```sh
npm test -- src/ui src/editor/workbench src/features src/demos src/platform --maxWorkers=2
node tools/build-demos.mjs --check   # if new demos committed
```

Browser (required):

- Landing: glass nav, no unreadable text.
- Editor: rounded docks, island tools, Design tab visible without scrolling a 1600×1000 window.
- Generate/Agent usable; `?intent=describe` focuses prompt.
- `?doc=blank` is actually blank.
- New demos load, orbit (Sol (1) camera), articulations drag if present.
- Toggle OS reduce transparency: surfaces go opaque, still AA.

---

## Success criteria

1. Chrome radii ≥ 14px on controls; no 2px square buttons in the workbench primary path.
2. Liquid-glass tokens with darkened edge + reduced-transparency fallback.
3. Design tab (Agent/Generate/Refine) visible above the fold.
4. Canvas not blurred.
5. At least two new gated demos in a **different discipline** than “modular AABB architecture.”
6. Zero official LEGO set inventories or Star Wars / City No Limits IP.
7. No kernel/generation/camera rewrites in this diff.
8. Hexclave sign-in still works.

---

## Coordination log

- Opus: `brickwright:intent-describe`; Generate session types unchanged; glass classNames only on AgentWorkbench.
- Sol (1): `.viewport-quick-controls` will be glass/island; keep the class. Don’t backdrop-filter the canvas. Planners `planCrane` / `planSnotHull` / `planLattice` / `planClockFaces` consumed here when present.
- Catalog `packExtra` appends may collide — rebase, don’t rewrite the list.
