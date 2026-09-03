# Brickwright — WebMCP Challenge draft

Preparation only. Do not submit or publish this entry.

## Project name

Brickwright

## Elevator pitch

Build with an AI, not around one. Brickwright is browser-based brick CAD where people and agents share real parts, a live 3D model, connection checks, and an undo stack through WebMCP.

## About the project

### Inspiration

I wanted an AI design partner I could actually build with—not another chat box that describes something beautiful and leaves me to reconstruct it by hand.

Brick building makes that distinction wonderfully concrete. A roof is not just a roof-shaped image. It is a collection of real parts, facing particular directions, attached at particular points. An assistant can sound convincing and still suggest a piece that does not exist, put two bricks through each other, or change the one detail I wanted to keep.

Brickwright grew out of a question I care about: **what if a person and an agent could work on the same creative object, with the same tools and the same consequences?** I wanted to keep the satisfying part of building—making decisions, trying ideas, finding the right silhouette—while giving an agent a useful way to help with the repetitive and technical work.

### What it does

Brickwright is a browser-based 3D CAD workspace for brick models. You can search real parts, place and connect them, move and recolor them, organize subassemblies, inspect problems, and undo changes. The model remains an editable document, not a generated picture.

An agent can join that same workspace through WebMCP. It can read the current model and selection, search the catalog, inspect connection possibilities, propose edits, validate a design, and—in Build mode—apply changes through the same command bus as the human editor.

The collaboration I designed for is simple: a builder shapes a model, asks for help with a roof or repeating structure, reviews the proposed geometry in context, then keeps building by hand. There is no need to export a file to a separate assistant and reconcile two competing copies afterward. A proposal can be previewed as a translucent ghost before it becomes part of the model.

The work also has somewhere to go: Brickwright can export LDraw models, a bill of materials, project archives, and printable build guides. Ten editable demo builds provide starting points for exploring the editor rather than confronting every visitor with an empty canvas.

### Why WebMCP is the right fit

3D editing is a difficult interface to automate by guessing at pixels. A screenshot can show a brick, but it cannot reliably tell an agent its identity, connector frames, protected state, or the revision of the document it is about to change.

WebMCP lets Brickwright expose those meanings directly. Instead of teaching an assistant where a button happens to sit, the page offers named capabilities with structured inputs and results. The agent gets precise state; the person still gets a visual, hands-on workspace.

That is the user-experience improvement I find most exciting: **the assistant does not replace the interface or work around it. It becomes another operator of the same application.** A human can make a careful local adjustment while an agent handles a repetitive operation, and both changes belong to one history. If the human changes the document while the agent is planning, revision checks make the stale plan fail rather than silently overwrite newer work.

### How I implemented WebMCP

The integration is a real application surface, not a collection of prompts attached to a demo.

**1. Discovery starts at the front door.** `src/webmcp/site.ts` registers five site-level tools on every route: `brickwright_overview`, `brickwright_navigate`, `brickwright_tools_list`, `brickwright_demos_list`, and `brickwright_autonomy`. An agent given only the homepage can learn where it is, discover what is available, and navigate into the editor. Opening the workspace adds the document tools without requiring the agent to click through the interface blindly.

**2. Tools are registered with the browser.** `src/webmcp/register.ts` sends descriptors to `document.modelContext.registerTool(...)`. Each descriptor supplies a name, description, input schema, and executable handler. The registrar supports both synchronous and promise-returning host implementations. A separate `window.brickwright.invoke(...)` bridge exposes the same handlers for development in browsers without native WebMCP; that fallback is not presented as proof of a native host connection.

**3. The contract and the implementation agree.** CAD operation schemas live in `src/webmcp/contract.ts`. Zod definitions generate the advertised JSON Schema and validate incoming requests, so the vocabulary the agent sees is the vocabulary the application accepts. Tools such as `workspace_get`, `catalog_search`, `capabilities_search`, and `capabilities_help` let the agent discover state and operations rather than invent them. Results carry structured data; failures provide repair guidance instead of an unhelpful success-shaped response.

**4. Preview and mutation are distinct.** In `src/webmcp/adapter.ts`, `build_preflight` validates an operation batch against the current document and creates a visible proposal without committing its parts. `proposal_create` exposes the same preview behavior. In Build mode, `build_apply` commits an eligible proposal atomically, while `action_mutate` routes supported operations through shared capability planners. These paths reach the same CAD engine used by manual editing, rather than modifying the Three.js scene behind the document's back.

**5. The available tool inventory follows the working mode.** Inspect exposes document reads; Propose adds previews; Build adds direct document writes. Mode-scoped registrations use an `AbortController`, so changing modes aborts the old registrations before the replacement inventory is registered. The mode is visible in the editor and available through `brickwright_autonomy`. This is an explicit collaboration control, not a claim that tool visibility alone is a security boundary. Kernel checks still enforce document revision, protected parts, and locked subassemblies.

**6. The agent can check what it made.** `validate_model` exposes model health, and `render_capture` returns live rendered pixels with document and camera metadata. An agent can combine exact structural information with the visual result. Tool-profile hashes and catalog versions also let callers detect when the surface they planned against has changed.

A representative interaction is: orient with `brickwright_overview`, open the editor with `brickwright_navigate`, read `workspace_get`, search `catalog_search` with `requireGeometry: true`, then call `build_preflight` using the current `expectedRevision`. The builder reviews the ghost. In Build mode, an eligible proposal can be committed with `build_apply` and subsequently reversed through the shared history.

### How it is built

The application uses TypeScript, React, Vite, Three.js, and React Three Fiber. The CAD document is independent of the renderer: positions and orientations, part identities, connections, constraints, and transactions are application data; the viewport is a view of that data.

Real LDraw geometry and LDCad connection metadata ground placement and connectivity. The catalog distinguishes parts that can actually be placed from identities that are only searchable. A missing mesh is reported as `GEOMETRY_UNAVAILABLE`, not replaced with an invented shape. Collision checks combine a broad phase with mesh-level confirmation and report uncertainty where appropriate. That matters more to me than making every answer look confident.

Cloud project features use Convex and Hexclave. The frontend is deployed on Cloudflare Pages, with server-side assistant and generation routes on Vercel. The WebMCP CAD surface is separate from those model-provider routes: an external browser agent can operate the local document through the page's tools without making Brickwright's built-in AI service the only way to collaborate.

### Challenges I ran into

The hardest part was not exposing a function. It was deciding what an agent needs to know before the function is safe and useful to call.

One particularly instructive problem was discovery. Registering a rich tool surface only inside the editor leaves an agent opening the homepage with nothing to work with. The small, always-on site host fixes that first interaction, and a dedicated browser acceptance suite checks the registration path.

Another challenge was keeping previews, commits, undo, and concurrent human edits consistent. A proposal needs a known base revision, and applying it must not quietly bypass protection or collision checks. Building the integration around one command bus made those behaviors shared rather than maintaining a separate, weaker “AI version” of the editor.

Finally, geometric honesty is hard. A catalog identity is not a mesh, a plausible arrangement is not a valid connection, and a computed structural check is not a real-world load test. Brickwright makes those distinctions visible instead of hiding them behind confident language.

### Accomplishments I am proud of

I am proudest that WebMCP reaches into the actual product: discovery, navigation, selection, catalog intelligence, proposals, model validation, editing, and export. It is not a disconnected proof of concept.

I am also proud of the small interaction that defines the whole project: an agent can leave an idea as geometry in the builder's workspace, and the builder can inspect it, change their mind, or continue by hand. The model is still theirs.

### What I learned

Building for agents made me build a more explicit application for people. Clear capability boundaries, useful errors, reversible transactions, and honest state are good interface design regardless of who is operating the tool.

I learned to treat an agent integration as a product contract, not just an API wrapper: discovery comes before execution, proposed work is different from committed work, and verification belongs in the workflow rather than only in the demo narration.

Codex was part of the development workflow. I used AI assistance for implementation, debugging, test work, and iteration, while grounding the project description in the repository and checking behavior rather than treating generated code as evidence that something works. The built-in assistant and generation layer are separate from the WebMCP integration described above.

### What's next

I want to expand the placeable geometry catalog, improve guidance for more complicated connections and mechanisms, and make the human-agent review loop feel even more immediate. I also want broader native-client interoperability testing and more physical builds to compare with the computed checks.

The ambition is not to automate away the pleasure of building. It is to give more people a capable partner while keeping the decisions, the model, and the ability to change course in their hands.

## Built with

WebMCP, TypeScript, React, Three.js, React Three Fiber, Vite, Zod, LDraw, LDCad, Convex, Hexclave, Cloudflare Pages, Vercel, IndexedDB, Vitest, Playwright, OpenAI Codex

## Links

- Live app: https://brickwrite.tech
- Public source: https://github.com/rishabhcli/BrickWrite
- License: AGPL-3.0-only; GitHub detects AGPL-3.0.
- Demo video: TODO — public YouTube URL, under 3 minutes, with audio.

## Official additional-info draft

- 28249 Submitter Type: Individual (existing Devpost team has only the creator).
- 28250 Country of residence: TODO — confirm United States; do not infer residency from location alone.
- 28251 Organization: Not applicable if entering as an individual.
- 28252 App Status: New. Repository's first commit is August 27, 2026, within the August 25–September 4 event window. Review if there was a pre-existing project not represented in this history.
- 28253 Existing-project updates: Not applicable — new project for this challenge. The implementation includes the shared CAD kernel, real-part catalog, browser editor, and WebMCP discovery, preview, validation, and mutation tools.
- 28254 Live URL: https://brickwrite.tech
- 28255 Testing instructions: See below.
- 28256 Public code: https://github.com/rishabhcli/BrickWrite
- 28257 Tested clients: Codex macOS application. I tested the WebMCP tools with Codex against the browser workspace. The repository also includes a Chromium/Playwright acceptance harness that records document.modelContext registrations and invokes their handlers, plus Vitest contract and adapter tests. The automated recorder and in-page bridge are development checks, not substitutes for native-client testing.
- 28258 AI tools: OpenAI Codex was used in the development workflow for implementation, debugging, tests, and iteration. The application also has a separate built-in assistant/generation layer, with Anthropic SDK integration in the repository. WebMCP itself exposes the browser application's tools to an external agent; it is not the model provider. Only add other tools or particular model claims when confirmed.
- 28259 Learning: Significant (draft self-assessment, based on the learning narrative above).
- 28260 Career AI value: Yes (draft self-assessment: schema-driven tools, revision-aware mutations, agent evaluation, and human-in-the-loop design).

## Judge testing instructions

1. Open https://brickwrite.tech in a WebMCP-capable browser. The landing page should expose `brickwright_overview`, `brickwright_navigate`, `brickwright_tools_list`, `brickwright_demos_list`, and `brickwright_autonomy`.
2. Ask the agent to call `brickwright_overview`, then `brickwright_navigate` with `{ "surface": "editor", "blank": true }`. A blank local document is the simplest test; the demo catalog offers larger examples.
3. Call `workspace_get` and `catalog_search` with `{ "text": "brick 2 x 4", "requireGeometry": true }`. Read the returned schemas and use the reported revision and actual catalog IDs rather than guessing values.
4. Leave the editor in Propose mode. Ask for a small, valid brick arrangement using `build_preflight`; inspect the visible ghost/proposal and its validation result. Review and apply through the human interface.
5. For direct agent edits, explicitly choose Build mode and discover the newly available tools. Try a supported change, inspect the result, and undo it. Protect a part and confirm an attempted agent edit is refused. Make a manual change and verify a preflight using an older revision is rejected.
6. Use `validate_model` and `render_capture` to inspect the result, then try LDraw or BOM export. Geometry and structural checks are computational checks, not certification of physical strength.
7. Core local CAD does not require credentials. Cloud project/account functions are separate and require sign-in. The built-in model-provider features are not needed to exercise the core WebMCP tools.

For a reproducible local check: Node 24, `npm run bootstrap`, then `npm run dev:inner`. `npm test -- src/webmcp` checks the contracts/adapters. `tools/e2e/webmcp.mjs` is the browser registration/execute acceptance suite using a host recorder. The normal-browser bridge is `window.brickwright.invoke(name, input)`; it should not be confused with native-host verification.

## Media preparation

- Existing screenshot candidates: docs/assets/brickwright-console.png, docs/assets/brickwright-palette.png, docs/assets/brickwright-articulation.png.
- Suggested gallery: an understandable editor overview; a live ghost proposal with validation; a human adjustment followed by agent help; a build guide/export.
- Existing recording plan: docs/demo-actions.md and docs/demo-voiceover.md. Target two minutes. Show live tool discovery, a real catalog lookup, a visible proposal, and a reversible change. Verify tool counts before recording; do not read stale counts from the script.
- No media uploaded by this draft document. A video placeholder is recorded here; never use a fabricated YouTube URL.

## Readiness notes — not part of the public story

- Not authorized for final submission. User explicitly requested draft-only preparation.
- Public YouTube demo URL is intentionally pending at the builder's request. Codex macOS client confirmed by the builder. Country of residence still needs confirmation.
- Local workflow state and recorded rules acknowledgment were absent at the start of this task. Do not manufacture an acknowledgment. Use the guided start/rules-review flow before a final submission review.
- Focused WebMCP test run on September 3, 2026: 6 files and 96 tests passed. This is not a full regression run or native-client certification.
- Security scan: no high-confidence secret patterns. Generic credential-like assignments occur in seven test fixtures; keep the final security result at review until those are cleared. `.env.local` is ignored by git; only `.env.example` is tracked.
- Existing unrelated source edits and demo scripts are preserved. No commit, push, or application deployment is part of this task.

## Saved-draft verification

- Main title, pitch, story, technology tags, and app/repository links saved through Devpost. Story readback matches after normalizing Devpost's Markdown-to-text conversion.
- Additional-info answers saved with Save & continue, then reopened and verified. Country remains blank. A clear pending-video note is saved in private testing instructions; the video URL is empty rather than fabricated.
- The builder confirmed Codex macOS as the tested client.
- Devpost's project update made the portfolio page public. This is distinct from entering the challenge: the live WebMCP entry still has no submission timestamp. No final Submit action or terms acceptance occurred.
- Draft editor: https://devpost.com/submit-to/31011-the-webmcp-challenge/manage/submissions/1169669/project-overview
- Portfolio page: https://devpost.com/software/brickwright
- Readiness: close; country, actual video, and final rules/security review remain. No thumbnail or gallery assets were uploaded in this task.
