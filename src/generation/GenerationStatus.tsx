import { Eye, Sparkles } from 'lucide-react'
import { PHASES } from './phases'
import { currentTick, phaseProgress, useGenerateStateBinding } from './statusBinding'
import type { GenerationSession } from './session'
import './panel.css'

/**
 * The status-bar readout.
 *
 * The bottom bar is the one surface visible whatever dock is collapsed, so it
 * carries the two facts that outlive the panel: a generation is running and how
 * far in it is, and a ghost is currently drawn over the model. It renders
 * nothing at all otherwise — an idle readout occupying the bar would be one more
 * thing to learn to ignore.
 */
export function GenerationStatus({ session }: { session: GenerationSession }) {
  const state = useGenerateStateBinding(session)

  if (state.briefPhase === 'compiling') {
    return (
      <span className="bw-gen-status" role="status">
        <Sparkles size={11} aria-hidden="true" /> Compiling brief
      </span>
    )
  }

  if (state.runPhase === 'running') {
    const tick = currentTick(state)
    const percent = Math.round(phaseProgress(state) * 100)
    return (
      <span className="bw-gen-status" role="status">
        <Sparkles size={11} aria-hidden="true" /> Generating {(tick?.candidateIndex ?? 0) + 1}/{state.candidateCount} ·{' '}
        {tick?.phase ?? PHASES[0]} · {percent}%
      </span>
    )
  }

  if (state.ghost) {
    const blocked = state.ghost.collisions > 0 || !state.ghost.healthy
    return (
      <span className="bw-gen-status" data-tone={blocked ? 'bad' : 'ready'} role="status">
        <Eye size={11} aria-hidden="true" /> Ghost candidate · {state.ghost.partCount} parts · r
        {state.ghost.baseRevision}
        {blocked ? ' · blocked' : ''}
      </span>
    )
  }

  return null
}
