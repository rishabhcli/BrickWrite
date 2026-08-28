import { useEffect, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useRegisterContribution } from '../editor/workbench'
import { CompareDialog } from './CompareDialog'
import { COMPARE_MODAL_ID, GeneratePanel } from './GeneratePanel'
import { GenerationStatus } from './GenerationStatus'
import { GenerationSession, type GenerationSessionOptions } from './session'

/**
 * Mounts generation into the editor shell.
 *
 * One component registers the dock panel, the status readout and the
 * side-by-side comparison dialog, all reading one session. A shared module
 * singleton would carry one editor's candidates — and its outstanding ghost —
 * into the next mount, so the session is created here and disposed with the
 * shell, which withdraws any ghost still on screen.
 *
 * `src/App.tsx` lists this component in `<Workbench contributions={[…]} />`.
 */
export function GeneratePanelContribution({ options }: { options?: GenerationSessionOptions } = {}) {
  const session = useMemo(() => new GenerationSession(options), [options])
  useEffect(() => () => session.dispose(), [session])

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
