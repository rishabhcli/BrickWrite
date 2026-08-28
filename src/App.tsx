import { Workbench } from './editor/workbench'
import { AgentWorkbenchContribution } from './agent'

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
const CONTRIBUTIONS = [AgentWorkbenchContribution]

export default function App() {
  return <Workbench contributions={CONTRIBUTIONS} />
}
