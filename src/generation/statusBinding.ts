import { useSyncExternalStore } from 'react'
import type { GenerateState, GenerationSession } from './session'

/**
 * The store binding, in its own module.
 *
 * The status readout and the panel both subscribe to one session, and the status
 * bar must not have to import the panel — and the panel's stylesheet — to do it.
 */
export function useGenerateStateBinding(session: GenerationSession): GenerateState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}

export { currentTick, phaseProgress } from './session'
