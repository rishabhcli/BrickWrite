# Brickwright — on-screen action script

**Target runtime: three minutes.** Actions follow `demo-voiceover.md` in order.
Quoted openings identify the matching spoken paragraphs.

## Recording and timing

- Rehearse the voiceover as one continuous, upbeat read. Expression cues stay off the audio
  track. Match the actions to the spoken lines and use brief visual holds for breathing room.
- Adjust the delivery during rehearsal and verify the finished audio and video each run
  exactly three minutes.
- Record the actual interactions first, then edit them to the narration. Agent processing and
  loading times vary; trim waiting time between actions while preserving their order and results.
- Keep the navigation in beat 04 continuous so the viewer sees the page transition.
- Prioritize successful placement, useful previews, the agent's visible contribution, and the
  finished model. Keep the delivery straightforward and enthusiastic.

## Setup

```bash
nvm use && npm run bootstrap
npm run dev:inner       # http://localhost:4173
```

- **1600×1000** logical resolution. Devtools in a separate window.
- Pre-build a wall: blank document → `⌘K` → **Build** → `build_wall`, 12 studs wide,
  4 courses. Save it as the project used for the demo.
- Prepare an open project that restores this wall when the editor loads. Rehearse the
  landing-to-editor transition and confirm the wall appears.
- Start the recording on `/`. Set autonomy to **Propose** before returning to the landing page.
- Have Codex connected and ready off-screen. Rehearse the catalog search, roof proposal,
  acceptance, Build edit, undo, and redo with the actual document.
- Lock a base-wall piece before recording and leave the roof editable. Beat 11's protection
  claim refers to that piece staying in place as the roof changes.

### Verify the spoken claims

The committed `public/catalog/2026-07/coverage.json` reports **81,774 searchable identities**
and **900 parts with compiled geometry**. Beat 01 celebrates full-catalog **search**; beat 02
explicitly identifies the ready-to-place editor library. Keep that distinction in the narration.

On `/`, confirm the five site tools:

```js
window.brickwright.tools.map(t => t.name)
window.brickwright.tools.length
```

In the editor, inspect the live inventory in each autonomy mode. The voiceover describes what
the modes enable rather than quoting editor counts that can change.

## 01 — The catalog

**“Brickwright brings LEGO building into your browser…”**

Start on the landing hero with the app name legible. Scroll to the collection and orbit a
spotlight model. Pair the catalog line with a simple title: **Full LEGO parts catalog search**
and **81,774 indexed identities**. Finish on a strong model view.

## 02 — Hands-on building

**“For hands-on building, the editor includes…”**

Use a recorded editor close-up: search the palette, choose a color, and drag a ready-to-place
piece onto a compatible connection. Show the preview and completed placement. Caption:
**900 ready-to-place parts · Real geometry**. This is a feature insert; return to the landing
page for the following tool-discovery sequence.

## 03 — WebMCP discovery

**“And Brickwright makes that same workspace available…”**

Show the landing page beside its console. Run:

```js
document.modelContext
window.brickwright.tools.map(t => t.name)
```

Frame the five tool names legibly. Hold long enough to connect the narration to the registered
inventory. Use the actual discovered tool descriptions when illustrating arguments and results.

## 04 — Live navigation

**“Let's start on the landing page…”**

Run overview and reveal `currentSurface`, the available tools, and `nextStep`:

```js
await window.brickwright.invoke('brickwright_overview', {})
```

At **“Watch this”**, call:

```js
await window.brickwright.invoke('brickwright_navigate', { surface: 'editor' })
```

Keep the browser and console visible continuously through the transition. Let the editor load
and the workspace tools register. End on the saved wall.

## 05 — Place a roof slope

**“Here's our model: a brick wall ready for a roof…”**

Search `slope 45`. Select **Brick Sloped 45° 2 x 2**, part **3039**, in a color available for
that part. Drag it onto a compatible top-edge connection. Show the placement preview, then
commit the piece. Leave the remaining roof area ready for Codex's proposal.

## 06 — Inspect the connection

**“Now I can orbit the model…”**

Orbit slowly to show the placed slope and its connection to the wall. Show the selected piece
and relevant validation information. Keep the model large enough for the viewer to understand
the placement. Finish at a clear three-quarter angle.

## 07 — Codex joins the workspace

**“Here's Codex on my Mac…”**

Bring Codex beside the browser in split screen. Keep the same wall visible. Show Codex's
native WebMCP discovery and overview call, with tool names and results readable.

## 08 — Request the roof

**“I'll ask: add a row of roof slopes…”**

Enter this request:

> Add a row of roof slopes along the top of this wall, all facing outward. Continue from the
> slope already placed. Search for ready-to-place parts and preview the remaining roof pieces.

Show `catalog_search` with `requireGeometry: true` and the returned part identities. Keep
Codex's actual call log beside the model as it prepares the edit.

## 09 — Review and accept

**“In Propose mode, the agent runs preflight…”**

Show `build_preflight` and the proposal in the review dock. Hover or select the proposal so
its translucent preview appears on the model. Inspect the roof from a clear angle, then accept
it. Hold on the newly committed pieces as the final sentence lands.

## 10 — Choose the autonomy level

**“Three autonomy modes let me choose…”**

Open the autonomy menu with **Inspect**, **Propose**, and **Build** legible. Show Inspect,
then Propose, with a compact view of their live tool inventories:

```js
window.brickwright.tools.map(t => t.name)
```

Highlight read tools on Inspect and `build_preflight` / `proposal_create` on Propose. End with
Build visible in the menu, ready for the next beat.

## 11 — Direct edits, undo, and redo

**“Let's switch to Build…”**

Select **Build**. Ask Codex:

> Extend the roof by one compatible slope using a direct edit. Keep the locked wall piece
> in place and check the new connection.

Show the actual write call and the resulting addition. Keep the protected wall piece visible.
Use **Undo**, then **Redo**, through the editor controls to compare and restore the addition.
Finish with the extended roof in place.

## 12 — Finished build and invitation

**“That's Brickwright…”**

Return to a large viewport and orbit the finished wall and roof. Keep the project in focus
while the narration recaps catalog search, the editor, and agent collaboration. Bring in
**brickwrite.tech** for the closing invitation. End with the closing invitation and master the finished
video to exactly three minutes.

## Final recording checks

- Each of the twelve action beats matches its voiceover paragraph and opening words.
- Both exported tracks measure 180 seconds; word count alone is a pacing estimate.
- The successful placements, accepted proposal, direct edit, undo, and redo are visible.
- The native Codex sequence shows actual discovered tools and executed calls. A console-only
  demonstration should be labeled as such and paired with narration describing that workflow.
- The full-catalog search claim stays paired with the separate ready-to-place library count.
- The closing frame shows the completed model and **brickwrite.tech** clearly.
