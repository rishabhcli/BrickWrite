import { lazy } from 'react'
import { Workbench } from './editor/workbench'

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
const CONTRIBUTIONS = [AgentWorkbenchContribution, GeneratePanelContribution, RefinePanelContribution]

export default function App() {
  return <Workbench contributions={CONTRIBUTIONS} />
}
