import { useEffect, useMemo } from 'react'
import { Stethoscope } from 'lucide-react'
import { useRegisterContribution } from '../editor/workbench'
import { ObjectivesDialog } from './ObjectivesDialog'
import { RefineOverlay } from './RefineOverlay'
import { OBJECTIVES_MODAL_ID, RefinePanel } from './RefinePanel'
import { disposeRefinementHost, getRefinementSession } from './mcpHost'
import type { RefinementSessionOptions } from './session'

/**
 * Mounts the design doctor into the editor shell.
 *
 * One component registers all three surfaces — the dock panel, the viewport
 * heatmap and the objective reference dialog — because all three read one
 * session. WebMCP uses the same host so an agent's search appears in the
 * overlay. The adapter (and this contribution on unmount) disposes it.
 *
 * `src/App.tsx` lists this component in `<Workbench contributions={[…]} />`.
 * Nothing else in the application needs to know refinement exists.
 */
export function RefinePanelContribution({ options }: { options?: RefinementSessionOptions } = {}) {
  const session = useMemo(() => getRefinementSession(options), [options])
  useEffect(() => () => disposeRefinementHost(), [session])

  useRegisterContribution({
    id: 'refinement.panel',
    slot: 'panel-right',
    priority: 130,
    title: 'Refine',
    icon: <Stethoscope size={13} />,
    render: (api) => <RefinePanel api={api} session={session} />,
  })

  useRegisterContribution({
    id: 'refinement.overlay',
    slot: 'overlay',
    priority: 130,
    render: (api) => <RefineOverlay api={api} session={session} />,
  })

  useRegisterContribution({
    id: OBJECTIVES_MODAL_ID,
    slot: 'modal',
    priority: 130,
    title: 'Objectives',
    render: (api) => <ObjectivesDialog onClose={() => api.openModal(null)} />,
  })

  return null
}

export default RefinePanelContribution
