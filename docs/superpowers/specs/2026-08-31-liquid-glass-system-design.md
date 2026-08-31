# Liquid Glass material system

Replaces the flat-blur `src/ui/glass` chrome with a genuinely refractive,
backdrop-adaptive, spring-driven material.

## Decisions

| Question | Decision |
|---|---|
| Fidelity | Hybrid. Real displacement-map lensing on hero chrome; the WebGL viewport itself is never filtered. |
| Scope | Foundation + CAD editor deep; other surfaces inherit the same primitives. |
| Dependencies | `motion` 13.1.1 (MIT), pinned exact. See the note below on the two that were removed. |
| Adaptivity | Backdrop-adaptive material, single dark theme. No light theme. |
| Motion | Two tiers: `intent` (expressive) and `work` (near-instant). |
| Structure | New `src/ui/liquid`; `src/ui/glass` deleted. |

Liquid Glass shipped in macOS 26 Tahoe. This targets that language and its
documented behaviours; no macOS 27-specific claims are made anywhere.

### The two dependencies that did not survive

`liquid-glass-react` 1.1.1 was chosen deliberately and then removed on evidence,
not on preference. The audit was clean — no network calls, no `eval`, no storage
access, MIT `LICENSE` in the tarball — but mounted in the browser it failed in
two ways that no amount of configuration fixes:

- **It cannot be a lining.** Its glass element sizes from padding and children.
  Used as a backdrop layer it has neither, so `.glass` and `.glass__warp`
  measured `0x0` and painted nothing, while `.glass__warp` held the only
  `filter: url(...)` in the tree.
- **It requires Tailwind.** Its edge and over-light layers are built from
  `bg-black`, `mix-blend-overlay` and `text-white`. This project loads no
  Tailwind, so those elements are inert — and the `overLight` adaptation is
  implemented entirely through them.

Making it work meant targeting its internal `.glass` class from outside,
reimplementing several Tailwind utilities, and correcting a `blurAmount` that
resolved to `blur(324px)`. `displacement.ts` plus the filter in `lens.tsx` is
less code than those three workarounds, and it binds to our own tokens and
accessibility contracts instead of fighting them.

`@use-gesture/react` was removed as simply unused: this pass ships no drag,
fling or pinch on chrome. It should come back with that work, not before it.

## Architecture

```
src/ui/liquid/
  LiquidStage.tsx     provider: one rAF pointer, capability probe, performance
                      state, LazyMotion, and the html[data-*] attributes
  capability.ts       feature detection and the tier decision
  LiquidMaterial.tsx  useLiquidSurface — resolves one surface's material
  lens.tsx            the tier-1 lining: SVG filter, specular, glow, rim
  displacement.ts     the rounded-rect normal map, cached by geometry
  luminance.ts        colour maths, luminance fields, the over-light grade
  rect.ts             shared box tracking and scene-overlap geometry
  motion.ts           intent/work springs, reduced-motion policy
  tokens.css          the token substrate
  material.css        .liquid-* classes
  <9 primitives>      GlassBar, GlassDock, GlassPanel, GlassIsland, GlassSheet,
                      GlassNotice, GlassButton, GlassField, GlassTabs
```

**Layering constraint.** `src/ui/liquid` must never import from `src/editor/**`.
`main.tsx` deliberately keeps Three.js out of the landing bundle, and
`ui/liquid` is imported by the landing page. The renderer's quality tier and
gesture state are therefore **pushed in** by `CadViewport` through
`useLiquidPerformance()`, never pulled. For the same reason `liquid/motion.ts`
reads `prefers-reduced-motion` itself rather than importing the equivalent from
`src/editor/render/motion.ts`.

The migration budgeted for a long coexistence between two systems. It turned out
to be seven import lines, so `src/ui/glass` was deleted outright and the planned
ESLint burn-down allowlist was never needed. `contrast.test.ts` moved first
regardless: `src/styles.css:12` documents that it verifies the *global*
`--faint` token, so letting it die with the old module would have silently
dropped app-wide coverage.

## The material

| Tier | Composition | Used when |
|---|---|---|
| lensed | displacement-map refraction with per-channel dispersion, over `backdrop-filter: blur() saturate()`, plus pointer-tracked specular and a two-tone rim | hero roles, capable browser, quality tier ≥ `balanced`, no gesture in flight |
| blur | `backdrop-filter: blur() saturate(120%)`, inner/outer edge, 1px specular | everything else, and any demotion |
| opaque | solid `--panel`, no blur, no filter | `prefers-reduced-transparency`, `prefers-contrast: more`, or no backdrop-filter support |

Hero roles are `GlassBar`, `GlassDock`, `GlassSheet`, `GlassIsland`. Panels,
buttons, fields and tabs stay on blur: refraction on a 34px pill is invisible
and still costs a compositor layer, and a lensed panel inside a lensed dock
refracts an already-refracted backdrop, which reads as smeared rather than deep.

Demotion is automatic and reversible. Lensing drops to blur while a gesture is
in flight and restores 180 ms after settle — promotion is delayed so the gaps
between pointer events during a slow drag cannot flicker the tier; demotion is
immediate, because the frame that needs the cheaper material is the one already
in flight.

### The lens

The displacement map encodes a **quarter-round fillet**, not a ramp. Refraction
follows the slope of the surface, and a real fillet is flat through the middle
and turns vertical at the very rim, so almost all of the bend happens in the
last few pixels. A smoothstep ramp spreads the same displacement evenly across
the band, which reads as an embossed border rather than a lensed edge. The slope
is unbounded at the rim, so it saturates at `MAX_SLOPE`.

Above that sit three layers that carry the rest of the illusion: a
pointer-tracked specular; an inner ring set in by the same band the bend uses,
because thick glass gathers light just inside its edge; and a rim lit from
above and shaded below, since a hairline of even brightness all the way round
reads as a drawn border rather than as thickness.

### Adaptation

`CadViewport` samples the scene at 2 Hz into a 32x32 grid and pushes it to the
stage; each surface averages only the cells under its own box and grades its
rim, specular and tint across the result. `preserveDrawingBuffer: true` on the
Canvas is what makes the readback legal.

Over bright content the scrim gets **darker**, not lighter. Apple can lighten
its material because it flips label colour in the same breath; this chrome
cannot, because its text colours come from app CSS on every consumer and
inverting them centrally would mean touching each one and re-deriving the whole
contrast suite. So what adapts is the scrim's depth and the rim's direction: the
surface thickens to keep its text legible and the edge inverts, which is the cue
that actually reads as glass responding to what is behind it.

### Compositing

The lining sits at `z-index: -1` inside the host, which paints it above the
host's background and below its content. That is what lets it be a lining rather
than a wrapper — wrapping would insert a box into flex and grid layouts that
already work.

Two constraints follow, and both were learned the hard way:

- The host must form a stacking context, but **`isolation: isolate` must not be
  what forms it**: isolation creates a backdrop root and would leave the lining
  with nothing behind it to refract.
- The stacking declarations live in an `@layer liquid-stacking` layer.
  Unlayered, `z-index: 0` overrode `workbench.css`'s own values on `.topbar`
  (20), `.dock` (8) and `.toolbar-island` (18) and dropped the entire toolbar
  island behind the WebGL canvas — confirmed by `elementFromPoint` returning
  `CANVAS` at a button's own centre. An unlayered declaration beats every
  layered one, so the layer lets an authored `z-index` win while still covering
  a host that has none.

### Retired overrides

`workbench.css` re-declared material on the primitives at equal specificity and
later in the cascade, which silently re-flattened them. Retired: the shared
`.topbar.glass-bar, .dock.glass-dock, .toolbar-island.glass-island` block; the
`background-color` on the topbar and dock rules; `.dock`'s and `.topbar`'s own
`background` and `backdrop-filter`; the material on `.viewport-control-row`,
`.topbar-nav-menu`, `.workspace-popover` and `.placement-bar`; and the
primitives' entries in the reduced-transparency media block, which they answer
themselves through their tier. Hand-rolled `backdrop-filter` declarations in
`workbench.css` went from 33 to 24.

### Coverage

Lensed, because they genuinely float over the rendered model: the toolbar
island, both viewport control rows, the workspace popover, the topbar
navigation menu and the placement bar. The topbar and docks are lensed too, but
sit beside or above the canvas, so their adaptation stays inert by design.

Still on hand-rolled material, inheriting the token substrate but not the
lensed tier: 24 declarations in `workbench.css` (panels, timeline, command
palette, dialogs), plus `platform.css` (4), the landing trio (6),
`explore.css` (2), `cloud.css` (2) and `panel.css` (1) — 50 in total across the
app. Gallery, projects, explore, share and the platform shell were never
converted to the primitives.

## Motion

| Tier | Spring | Applies to |
|---|---|---|
| `intent` | stiffness 220, damping 26, mass 1 | sheet present, panel open, palette, dock tear-off |
| `work` | stiffness 520, damping 40, mass 0.6 | drag, orbit, scrub, hover, sliders |

`LazyMotion` with `domAnimation` in `strict` mode keeps the animation runtime
small — `m.*` components only, no `motion.*`. Reduced motion jumps to the
settled state rather than running the same animation faster, mirroring the
policy in `src/editor/render/motion.ts`.

`GlassSheet` animates its arrival only. `hidden` collapses a closed sheet to
`display: none`, which consumers and tests already rely on, and nothing animates
out of `display: none`; animating the dismissal would mean owning unmount
timing, which the primitive leaves with its consumer.

## What verification found

Confirmed in Chromium against the running editor: six surfaces resolve to
`lensed`, each with a correctly sized warp layer carrying
`backdrop-filter: blur() saturate() url(#…)` and the nine-primitive filter
chain; the specular tracks the shared pointer; z-order and hit-testing are
intact; no console errors.

Three things were measured rather than assumed, and each changed the design:

- **A whole-canvas average is the wrong signal.** With a bright wall filling
  half the frame the mean still read 0.19, because the rest of the scene is
  near-black. Surfaces now read only the cells their own box covers.
- **A 16x16 sample is too coarse.** The brightest cell in a framed model read
  0.283 at 16, because each cell averaged a brick face with the dark gaps around
  it; at 32 the same face resolves at 0.724. The readback costs the same — the
  stall is pipeline depth, not the kilobyte copied.
- **A threshold is the wrong shape for the adaptation.** A popover half over a
  white plate measured 0.218 with its brightest cell at 0.582: genuinely between
  the two treatments, and a boolean has to answer it wrongly either way. The rim,
  specular and tint now interpolate across a continuous 0..1 instead.

The sampler also retired itself on its very first reading, because that one
allocates the readback path and measured 4 ms against a 3 ms budget. It now
skips the warm-up sample and takes three consecutive overruns to stand down.

**One limitation remains architectural, not a defect.** In the editor's grid the
topbar sits *above* the canvas and the docks *beside* it, so nothing but the
opaque page background is behind them — there is nothing there to refract, and
their adaptation correctly stays inert. Only the floating chrome genuinely
overlaps the model. Getting the full effect on the topbar and docks would mean
letting the canvas run full-bleed behind them so the chrome floats over content,
which is how the Apple language earns its look. That changes usable canvas area
and touches the grid every panel depends on, so it is recorded here rather than
made unilaterally.

## Testing

- `contrast.test.ts` — relocated from the deleted module; guards the global
  `--faint` token against every surface it lands on.
- `capability.test.ts` — the tier decision, including that a preference beats a
  capability and a capability beats an optimisation.
- `material.test.ts` — the TypeScript mirrors of the radius, blur and lens
  tokens against `tokens.css`; that no rule targets `#root`, `canvas`, `body` or
  `html`; that the stacking guarantee stays layered; that nothing forms a
  backdrop root.
- `stage.test.tsx` — exactly one pointer listener however many surfaces mount;
  document attributes set and restored; settle timing in both directions; and
  the backdrop path end to end, with layout stubbed, asserting that a bright
  scene flips a surface, a dark one does not, and a bright scene the surface
  does not overlap is ignored.
- `luminance.test.ts` — colour maths, the luminance field, the continuous
  grade, and that the threshold clears the dark palette while sitting below the
  light-grey faces models are built from.
- `rect.test.ts` — scene overlap, including that the docks and topbar measure
  zero against the canvas.
- `displacement.test.ts` — the geometry cache key, and that a missing 2D canvas
  yields null rather than throwing.
- `primitives.test.tsx` — ported wholesale from the deleted module: roles,
  semantics, roving tabs, keyboard navigation.
