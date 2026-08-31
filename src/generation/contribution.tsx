import { useEffect, useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useRegisterContribution } from '../editor/workbench'
import { CompareDialog } from './CompareDialog'
import { COMPARE_MODAL_ID, GeneratePanel } from './GeneratePanel'
import { GenerationStatus } from './GenerationStatus'
import { disposeGenerationHost, getGenerationSession } from './host'
import type { GenerationSessionOptions } from './session'

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
      // After the reveal has had a frame to open the section. A focus call into
      // a panel that is still collapsed lands on nothing.
      requestAnimationFrame(() => {
        window.document.querySelector<HTMLTextAreaElement>('textarea[data-generation-prompt]')?.focus()
      })
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
