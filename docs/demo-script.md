# Brickwright demo video — script

A ~5:30 narrated screen recording that explains how the application works, in the order the
architecture actually works: catalog → kernel → generators → validation → agent → delivery.
Every number spoken here is measured and lives in `README.md` / `public/demos/manifest.json`;
don't round them up on camera.

A 90-second cut is at the bottom.

---

## Before you record

```bash
nvm use                 # Node 24
npm run bootstrap
npm run dev:inner       # http://localhost:4173 — credential-free, no accounts in shot
```

- Record at **1600×1000** logical (2× retina). Both docks fit without the layout collapsing.
- Open a second tab on `/explore` and one on `/editor` so cuts are instant.
- Have devtools console open in a **separate window**, not docked — you cut to it once, for WebMCP.
- Pre-fork **Harbour Street** (7,947 parts) into a project before recording. Forking a 14k-part
  megabuild on camera is 6+ seconds of nothing.
- Turn the landing page's motion **on** (it defaults on; the pause control is top-right).

---

## 0:00 — Cold open: the landing page

> **On screen:** `/` at the hero. Let the stud plate animate for two beats, then click one column
> and drop a brick into it.

**VO:** "So this is Brickwright. It's CAD for LEGO. The viewport is the boring part — what I
actually want to show you is that a person and a language model edit the same document here,
through the same code path, and neither one gets a shortcut."

> **On screen:** scroll to the collection strip. Ten thumbnails.

**VO:** "Ten builds ship with it. Smallest is about eight thousand parts, biggest is just under
fifteen thousand. And they're not screenshots. You can open any of them and start moving bricks."

---

## 0:25 — Act 1: the catalog is real, and it says what it doesn't know

> **On screen:** cut to `/editor`. Open the **Parts** panel in the left dock. Type `2x4`.
> Then type `slope 45`. Then type `3023`.

**VO:** "Start with the parts, because everything else depends on them. A compiler takes three
datasets — LDraw for geometry, LDCad's shadow library for how parts connect, Rebrickable for names
and which real sets a part showed up in — and bakes them into fixed runtime files. You get about
eighty-two thousand parts you can search."

> **On screen:** point at the tier badge on a result. Scroll so all three tiers are visible in
> the facet counts.

**VO:** "But it won't hand you a part and stay quiet about it. Nine hundred of these I can
actually place — real geometry, measured size, real connectors. Twenty-two thousand, LDraw knows
the shape but this build has no mesh for it. The other fifty-eight thousand, I know the name and
that it's a real part. That's all."

> **On screen:** search a modelled-only part, try to place it, let the error land. Read it.

**VO:** "Watch what happens if I try to place one of those. It won't fake it. And it tells me which
case I'm in, because 'never heard of it' and 'that's real, I just can't build with it' are
completely different problems. There's no fallback catalog in here either. If the compiled files
are missing, the app doesn't boot."

---

## 1:05 — Act 2: one kernel, and nothing bypasses it

> **On screen:** empty project, **Start with a brick**. Click a second brick onto it — let the
> ghost hang for a beat before committing. Then press **B**, place three more.

**VO:** "This ghost isn't a grid snap. It's running the same solver that runs when I actually
click, so the preview can't lie to me. And where a part sits comes off its own connectors — that's
why slopes and curved bricks and windscreens land where they'd land in real life, instead of at
some height from a table."

> **On screen:** select two parts, press **G**, drag the gizmo. Shift-drag a marquee. **⌘Z**.

**VO:** "That drag was one transaction. So was the drop, so was the recolour. All of it works that
way, because the React tree and the Three.js scene are just views. The document underneath is
plain TypeScript. Rotations are stored as a basis instead of Euler angles, which sounds pedantic
right up until you export a mirrored part and it comes back exactly how it left."

---

## 1:45 — Act 3: building at scale, because brick-by-brick is where quality dies

> **On screen:** ⌘K → command palette → **Build** group. Run `build_enclosure`: 20 × 16 studs,
> 5 courses, floor on, one opening. Let the ghost preview appear before accepting.

**VO:** "Placing a wall brick by brick is slow, and honestly it's where a model produces junk.
Seams stacked on top of each other, courses that don't bond, corners that don't tie together. So
the bricklaying is a solver, and then the kernel checks its work the same way it checks mine."

> **On screen:** accept. Then run `stack_selection`, 4 copies.

**VO:** "That's eighty-four parts, five courses, every one staggered against the one below. Now
stack it — four storeys. Four hundred and twenty parts, three thousand-odd mated connectors, no
collisions, one connected piece. And it sequenced into fifty-three build steps in about a third of
a second."

> **On screen:** ⌘Z once. The whole storey stack disappears. Redo.

**VO:** "Two calls, so one undo takes back a whole storey. The generators just emit ordinary
add-a-part operations, which means everything that guards my edits guards theirs too."

> **On screen:** run `build_structure` — 16 × 14, 3 storeys, windows and a door. Zoom into a
> seated window frame.

**VO:** "Three storeys, windows, a door, one instruction. Look at the window — that's a real frame
sitting in the opening, picked by measuring what fits. Nothing in here estimates. And if the pack
has no frame that wide, the report says so and leaves a bare hole instead of pretending."

---

## 2:45 — Act 4: validation, and being honest about certainty

> **On screen:** open **Model health** in the right dock. Point at a collision verdict's
> certainty label.

**VO:** "Collision runs in three passes. Boxes first, then a bit of slack around parts that are
meant to be touching, then actual triangle-against-triangle. And every answer carries how it got
there — exact, clearance-subtracted, or unknown. So a guess never looks like a verified result on
screen."

> **On screen:** show the statics readout: mass, centre of mass, tipping margin.

**VO:** "Then there's the question collision can't answer, which is whether the thing stands up.
Mass comes from the real enclosed volume of each part. Two numbers in here aren't measurements, and
they say so every time they turn up. Mass runs eight to fifteen percent heavy, because LDraw models
a solid brick — a two-by-four computes at 2.67 grams and the moulded one is 2.32. And clutch
strength is a guess. LEGO doesn't publish it, so it uses a hundred gram-force per stud, which is
the cautious end of what people have measured."

---

## 3:20 — Act 5: the second operator

> **On screen:** right dock → **Agent**. Type a plain request: _"add a parapet around the roof
> deck and tell me if it's stable."_ Let it stream.

**VO:** "Same document, other side. I just talk to it. It reads the model with tools — what's in
the workspace, search the catalog, query the scene — and it can grab actual pixels of the viewport
if it needs to look at something."

> **On screen:** the wave arrives. Hover it so the ghost shows. Accept one, reject one.

**VO:** "It comes back with a wave, and I can hover it to see what it would do. Take this one, skip
that one. Now, the thing to know: it has no commit tool. Not in any mode. All it can do is read and
dry-run. The only way anything lands is me accepting it — and when I accept, it re-checks the
revision. So if I've edited since it planned, it fails and gets told what to fix, instead of
landing on top of my work."

> **On screen:** the autonomy switch. Inspect → Propose → Build. Let the **Grant Build access?**
> confirmation appear; cancel it once, then grant.

**VO:** "These modes aren't a preference. They're different tool sets — twenty-four, twenty-eight,
forty. Switching revokes the old ones before the new ones exist."

> **On screen:** cut to the devtools console window.

```js
await window.brickwright.invoke('catalog_search', { text: 'slope 45', requireGeometry: true })
await window.brickwright.invoke('render_capture', { view: 'front', mode: 'beauty' })
```

**VO:** "And it's not a private channel. Same tools go out over WebMCP — natively if you open this
inside ChatGPT's browser, through this bridge everywhere else. One schema declaration generates
both what the tool advertises and what the gateway checks, so the two can't drift apart."

---

## 4:20 — Act 6: build order, and getting it out

> **On screen:** the **Steps** timeline. Scrub it; let steps highlight their parts in the viewport.

**VO:** "Build order comes out of the connection graph, so every step is checkable. The part you're
adding attaches to something that's already there, or you get told it's starting a separate
subassembly."

> **On screen:** Export Center. Show the five outputs, then generate the printable guide and open
> it in a new tab. Scroll: cover, BOM, step renders with new parts highlighted.

**VO:** "Then getting it out. Flat LDraw, an MPD with a submodel per subassembly, a parts list, a
BrickLink wanted list, and a project archive that carries the history and notes, not just a
snapshot. Plus a printable guide — one HTML file with the pictures baked in, because a build guide
that has to phone home for its own images isn't much of a guide."

---

## 4:55 — Act 7: it survives the tab closing

> **On screen:** reload the page mid-edit. The model comes back. Point at the save indicator.

**VO:** "Let me reload in the middle of an edit. Still here. Locally, every transaction gets
appended to an IndexedDB log on top of a checkpoint, so opening it replays forward. If there's a
hole in that log it stops, rather than applying it out of order. And the indicator tells you
whether saving actually works — durable, memory-only, or failing — instead of a checkmark it can't
stand behind."

**VO:** "Signed in, the same transactions go up in batches. A batch that fails writes nothing. If
the acknowledgement gets lost it retries without duplicating anything. And an upload that got
interrupted picks up on the same fork instead of branching twice."

---

## 5:20 — Close

> **On screen:** back to the megabuild, orbiting slowly. Zoom out until the whole thing frames.

**VO:** "So that's the shape of it. Every edit goes through one code path, whether I made it or the
model did. The catalog is honest about what it can't build. And the model can suggest anything and
commit nothing on its own. Nine hundred placeable parts, three hundred and twenty-two real colours,
and it runs offline the second you clone it."

> **On screen:** hold on the model. Cut.

---

## The 90-second cut

Use this if the audience is technical and impatient. Same recording, four beats.

| Time      | On screen                                              | Line                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Landing hero, drop a brick on the stud plate           | "CAD for LEGO, where you and a language model edit the same document through the same code path."                                                                                                                      |
| 0:15–0:40 | Parts search: `2x4`, then a modelled-only part refused | "Eighty-two thousand real parts, in three tiers. Nine hundred I can place, twenty-two thousand I know the shape of, fifty-eight thousand I only know the name of. It won't guess, and it tells you which one you hit." |
| 0:40–1:10 | `build_structure`, then one ⌘Z                         | "One instruction: three storeys, real window frames sitting in the openings, bonded courses, no collisions. And one undo takes the whole thing back."                                                                  |
| 1:10–1:30 | Agent dock: a wave arrives, accept one                 | "It has no commit tool in any mode. It reads and dry-runs. I accept, and accepting re-checks the revision."                                                                                                            |

---

## Shot notes

- **Don't** demo a fork of a 14k-part build live. Fork before you record, or cut on the click.
- **Do** let placement ghosts sit for a beat before committing — the ghost _is_ the argument that
  preview and commit share a solver. Cutting it makes it look like an ordinary grid snap.
- The blocked-placement ghost turning red with a reason is a stronger shot than a successful
  placement. Deliberately try to put a brick somewhere illegal once.
- Instanced rendering is worth one sentence if you're talking to graphics people: 400 extra parts
  cost 14 extra draw calls, against 810 before edge merging. It doesn't earn a beat otherwise.
- Skip the cloud collaboration/invitation surfaces unless the audience asked. They're real, but
  they need accounts on screen and they don't explain how the application _works_.
- `README.md` still describes the published sets as "1,080–11,493 editable parts". The manifest
  says 7,947–14,714. Trust the manifest, and fix the README before anyone reads along.
