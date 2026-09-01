# Integration map

Ten workstreams landed in parallel; this file is still the ownership contract
between them. Surfaces are mounted: `src/App.tsx` lists agent, generate, refine
and cloud contributions. `src/main.tsx` registers landing, explore, editor,
share, gallery and projects; `src/platform/AppShell.tsx` registers account.
`PLATFORM_ROUTES` in `src/platform/routes.ts` is the shell's static table of
paths and boot stages, not the registration list.

## Ownership

A workstream writes only inside the paths it owns. Everything else it needs, it
imports — from the CAD kernel (`src/cad/*`), from `src/platform/contracts.ts`,
or from another workstream's published entry point.

| # | Workstream | Owns |
|---|---|---|
| 1 | Part intelligence | `src/intelligence/**`, `tools/semantic-index.mjs` |
| 2 | Agent workbench | `src/agent/**`, `src/webmcp/**`, `server/assistant/**` |
| 3 | Generation | `src/generation/**` |
| 4 | Refinement | `src/refinement/**` |
| 5 | Workbench UI | `src/editor/workbench/**` |
| 6 | Renderer | `src/editor/render/**`, `src/editor/CadViewport.tsx`, `src/editor/PartBatch.tsx`, `src/editor/PartVisual.tsx`, `src/editor/environment.ts` |
| 7 | Platform & account | `src/platform/**`, `src/hexclave/**` |
| 8 | Cloud projects | `convex/**`, `src/cloud/**` |
| 9 | Publish & share | `src/features/share/**`, `functions/**` |
| 10 | Landing & explore | `src/features/landing/**`, `src/features/explore/**`, `src/demos/**` |

Integration-owned, edited only by the integrator: `src/main.tsx`, `src/App.tsx`,
`src/styles.css`, `package.json`, `vite.config.ts`, `tsconfig.*.json`,
`tools/e2e-smoke.mjs`, `.github/**`.

## Invariants every workstream preserves

- `ModelDocument` is the only truth. React state, Three.js objects, chat
  transcripts and cloud rows are derived views of it.
- Every mutation — human or agent — becomes typed `CadOperation[]` and goes
  through `cadEngine` with an `expectedRevision`. Nothing writes the document
  directly.
- Locked parts, protected regions, collision rejection, constraint solving,
  atomic preflight/apply, shared undo/redo and monotonic revisions all keep
  working.
- Catalog tiers stay honest. `placeable` means compiled geometry exists;
  `modelled` and `catalogued` identities are never silently placed, and no
  procedural stand-in geometry is ever substituted for a missing mesh.
- No invented parts, users, projects, metrics, share links or model output.
  A missing capability reports itself as unavailable.
- Runtime ML calls a real provider. Test doubles exist only in tests.

## Published entry points

Each workstream exports its public surface from `index.ts` in its root
directory and documents it in `docs/integration/<workstream>.md`.
