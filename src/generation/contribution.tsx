import { useEffect, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useRegisterContribution, type WorkbenchApi } from '../editor/workbench'
import { claimGeneratePrompt } from '../editor/workbench/promptFocus'
import { CompareDialog } from './CompareDialog'
import { COMPARE_MODAL_ID, GeneratePanel } from './GeneratePanel'
import { GenerationStatus } from './GenerationStatus'
import { disposeGenerationHost, getGenerationSession } from './host'
import { useGenerateStateBinding } from './statusBinding'
import type { GenerationSession, GenerationSessionOptions } from './session'

/**
 * Focuses the prompt when the landing page sent somebody here to describe a
 * build.
 *
 * `?intent=describe` is written by the landing page's "describe it" call to
 * action. The workbench shell owns that query parameter — it reveals the
 * Generate surface and then consumes the parameter from the address bar — so
 * reading the URL here as well would be a race against that consumption, won
 * only by the order React happens to run effects in. Instead the shell
 * announces the intent and this listens for it, which is the seam the two
 * workstreams agreed on.
 */
function useDescribeIntent(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const focusPrompt = () => {
      // The field is already mounted here. The shell still owns the late-mount
      // case (panel appearing because of the intent); this covers a panel that
      // was already on the page when the event arrived.
      claimGeneratePrompt()
    }
    // For a panel already mounted when the intent arrives. A panel that mounts
    // *because* of the intent cannot hear this — the shell focuses the prompt
    // itself for that case, which needs no cooperation from here.
    window.addEventListener('brickwright:intent-describe', focusPrompt)
    return () => window.removeEventListener('brickwright:intent-describe', focusPrompt)
  }, [])
}

export function GeneratePanelContribution({ options }: { options?: GenerationSessionOptions } = {}) {
  const session = useMemo(() => getGenerationSession(options), [options])
  useEffect(() => () => disposeGenerationHost(), [session])
  useDescribeIntent()

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
    render: (api) => <CompareCandidatesModal api={api} session={session} />,
  })

  return null
}

/**
 * Live comparison, not a snapshot taken at contribution-register time.
 *
 * The modal slot re-renders when the workbench API changes, not when the
 * generation session does. Reading `getState()` inline would freeze the table
 * on whatever candidates existed the last time the engine emitted.
 */
function CompareCandidatesModal({ api, session }: { api: WorkbenchApi; session: GenerationSession }) {
  const state = useGenerateStateBinding(session)
  const candidates = state.run?.candidates ?? []
  useEffect(() => {
    if (!candidates.length) api.openModal(null)
  }, [api, candidates.length])
  if (!candidates.length) return null
  return (
    <CompareDialog
      candidates={candidates}
      selectedId={state.selectedCandidateId}
      onSelect={(candidateId) => session.selectCandidate(candidateId)}
      onClose={() => api.openModal(null)}
    />
  )
}

export default GeneratePanelContribution
