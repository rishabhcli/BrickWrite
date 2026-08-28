import { useEffect, useMemo } from 'react'
import { Stethoscope } from 'lucide-react'
import { useRegisterContribution } from '../editor/workbench'
import { ObjectivesDialog } from './ObjectivesDialog'
import { RefineOverlay } from './RefineOverlay'
import { OBJECTIVES_MODAL_ID, RefinePanel } from './RefinePanel'
import { RefinementSession, type RefinementSessionOptions } from './session'

/**
 * Mounts the design doctor into the editor shell.
 *
 * One component registers all three surfaces — the dock panel, the viewport
 * heatmap and the objective reference dialog — because all three read one
 * session and a shared module singleton would leak one editor's search into the
 * next. Creating the session here and closing over it in each `render` keeps the
 * three surfaces in step and disposes the search when the shell unmounts.
 *
 * `src/App.tsx` lists this component in `<Workbench contributions={[…]} />`.
 * Nothing else in the application needs to know refinement exists.
 */
export function RefinePanelContribution({ options }: { options?: RefinementSessionOptions } = {}) {
  const session = useMemo(() => new RefinementSession(options), [options])
  useEffect(() => () => session.dispose(), [session])

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
