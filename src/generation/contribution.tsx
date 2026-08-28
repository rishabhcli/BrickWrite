import { useEffect, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useRegisterContribution } from '../editor/workbench'
import { CompareDialog } from './CompareDialog'
import { COMPARE_MODAL_ID, GeneratePanel } from './GeneratePanel'
import { GenerationStatus } from './GenerationStatus'
import { disposeGenerationHost, getGenerationSession } from './mcpHost'
import type { GenerationSessionOptions } from './session'

/**
 * Mounts generation into the editor shell.
 *
 * One component registers the dock panel, the status readout and the
 * side-by-side comparison dialog, all reading one session. WebMCP uses the
 * same host so an agent's candidates appear in the panel. The adapter (and
 * this contribution on unmount) disposes it so a remount cannot inherit the
 * previous editor's ghost.
 *
 * `src/App.tsx` lists this component in `<Workbench contributions={[…]} />`.
 */
export function GeneratePanelContribution({ options }: { options?: GenerationSessionOptions } = {}) {
  const session = useMemo(() => getGenerationSession(options), [options])
  useEffect(() => () => disposeGenerationHost(), [session])

  useRegisterContribution({
    id: 'generation.panel',
    slot: 'panel-right',
    priority: 125,
    title: 'Generate',
    icon: <Sparkles size={13} />,
    render: (api) => <GeneratePanel api={api} session={session} />,
  })

  useRegisterContribution({
    id: 'generation.status',
    slot: 'status',
    priority: 125,
    render: () => <GenerationStatus session={session} />,
  })

  useRegisterContribution({
    id: COMPARE_MODAL_ID,
    slot: 'modal',
    priority: 125,
    title: 'Compare candidates',
    render: (api) => (
      <CompareDialog
        candidates={session.getState().run?.candidates ?? []}
        selectedId={session.getState().selectedCandidateId}
        onSelect={(candidateId) => session.selectCandidate(candidateId)}
        onClose={() => api.openModal(null)}
      />
    ),
  })

  return null
}

export default GeneratePanelContribution
