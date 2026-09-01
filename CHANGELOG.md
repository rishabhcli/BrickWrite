# Changelog

Brickwright follows [Semantic Versioning](https://semver.org/). Release tags use
`vMAJOR.MINOR.PATCH`; the package version, this file, and the deployed commit
must agree.

## Unreleased

Shipped on `main` since 0.1.0. Package version remains 0.1.0 until the next
tagged release.

### Product surfaces

- Platform shell with `/`, `/explore`, `/editor`, `/projects`, `/account`,
  `/share/:slug` and `/gallery`. Landing and explore boot without the catalog.
- Ten curated megabuilds (1,080–11,493 parts), kernel-gated, replacing the six
  toy demos. Featured landing build is the Blue Whale Monument.
- "Edit this build" forks a copy into a new project and opens it. "Start from
  scratch" is `/editor?doc=blank`. "Describe another idea" opens a blank project
  with the Generate panel revealed (`?intent=describe`).
- Empty editor viewport offers a starter brick and one-click megabuild forks.
- Design partner (Inspect / Propose / Build), Generate and Refine panels, and
  cloud projects, all mounted as workbench contributions.

### CAD and agent

- Mechanism planners: crane, lattice, SNOT hull, clock faces — real compiled
  parts and joints, with documented scope.
- Project archive export/import (history, notes, constraints).
- Palette drag-and-drop into the viewport; Cards and List layouts only.
- Direct brick drag to move; Reposition on the tool rail.
- Insertability warnings on derived build sequences (`BLOCKED_INSERTION`).
- WebMCP inventories 24 / 28 / 40 on `brickwright.tools/3`. `workspace_focus`
  added; `generation_compile_local` folded into `generation_compile` as
  `useModel: false`.

### Cloud and AI

- Complete-history reads, save-integrity receipts, batched append, retry-safe
  conflict recovery, recoverable invitation delivery. See `docs/cloud-*.md`.
- Bounded AI request lifetimes, cancellation, and stream heartbeats. See
  [AI stream reliability](docs/ai-stream-reliability.md).

### Chrome

- Shared corner radii, a four-size editor type scale (floor 9px), three motion
  durations, and Liquid Glass tokens. Status bar component exists but is not
  mounted; layout presets follow window width.

### Verification

- Vitest suite is ~2,900 tests across 200+ files (`npm run check`).
- Hosted CI: `audit:runtime` + `check` + `demos:check`; `landing` / `production` / `share` block
  deploy; GPU suites (`e2e-smoke`, `renderer`) are signal-only.
- Smoke run no longer depends on a deleted opening rover or an unmounted
  status bar.

## 0.1.0 - 2026-08-27

- Initial public vertical slice: revisioned CAD kernel, real LDraw catalogue,
  renderer, WebMCP command path, local persistence, generation/refinement,
  cloud/project foundations, publication surfaces, and production topology.
