import { lazy } from 'react'
import { config as configureZod } from 'zod'
import { Workbench } from './editor/workbench'
// Editor foundation establishes the shared reset and tokens before the lazy
// Workbench module mounts its chrome stylesheet.
import './styles.css'

/**
 * Stop zod probing for `eval` before the editor defines a schema.
 *
 * zod feature-detects its JIT by calling `new Function` once and catching the
 * failure. Under a Content-Security-Policy the attempt is reported even though
 * the throw is swallowed and nothing breaks, so the deployed editor logged a
 * `script-src` violation per load for a question zod was only asking.
 *
 * Nothing is given up by answering it in advance: the compiler is opt-in via
 * `zod/compile` and this app never opts in, so `jitless` disables a fast path
 * that was never running. See zod's own note beside `allowsEval`.
 *
 * Here rather than in `main.tsx` because the entry is landing-critical and
 * importing zod there put 24 KiB of gzipped schema code in front of the
 * marketing page. This module is the lazily loaded editor route, which is
 * where the schemas — and the violation — actually are.
 */
configureZod({ jitless: true })

// Contributions register optional workbench surfaces and can arrive after the
// core CAD cockpit paints. Keeping them behind lazy boundaries removes the
// assistant SDK, generation pipeline and refinement worker from the editor's
// critical chunk without changing the shared command kernel they call into.
const AgentWorkbenchContribution = lazy(() =>
  import('./agent').then((module) => ({ default: module.AgentWorkbenchContribution })),
)
const GeneratePanelContribution = lazy(() =>
  import('./generation').then((module) => ({ default: module.GeneratePanelContribution })),
)
const RefinePanelContribution = lazy(() =>
  import('./refinement').then((module) => ({ default: module.RefinePanelContribution })),
)

const CloudProjectsContribution = lazy(() =>
  import('./cloud').then((module) => ({ default: module.CloudProjectsContribution })),
)

/**
 * Composition root.
 *
 * Everything the editor does now lives in `src/editor/workbench`: the shell owns
 * layout and the keyboard, `useWorkbench` owns the state and every action that
 * reaches the kernel, and each panel is a view over that. What is left here is
 * the one decision that belongs to the application rather than to the workbench
 * — which extension contributions are mounted.
 *
 * Other workstreams add their surfaces by exporting a zero-prop component that
 * calls `useRegisterContribution`, and listing it below. Nothing else in this
 * file changes when the editor grows a panel.
 */
const CONTRIBUTIONS = [
  AgentWorkbenchContribution,
  GeneratePanelContribution,
  RefinePanelContribution,
  CloudProjectsContribution,
]

export default function App() {
  return <Workbench contributions={CONTRIBUTIONS} />
}
