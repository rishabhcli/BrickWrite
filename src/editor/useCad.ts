import { useSyncExternalStore } from 'react'
import { cadEngine } from '../cad/engine'

export function useCad() {
  return useSyncExternalStore(cadEngine.subscribe, cadEngine.getSnapshot, cadEngine.getSnapshot)
}
