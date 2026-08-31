import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { cadEngine } from '../cad/engine'
import type { EngineSnapshot } from '../cad/types'

/** Selector memoization is local to each render, never shared by concurrent renders. */
export function useCadSnapshot<T>(selector: (snapshot: EngineSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const committed = useRef<{ value: T } | null>(null)
  const getSelected = useMemo(() => {
    let previousSnapshot: EngineSnapshot | undefined
    let previousSelection: T
    return () => {
      const snapshot = cadEngine.getSnapshot()
      if (snapshot === previousSnapshot) return previousSelection
      const selected = selector(snapshot)
      const previous = previousSnapshot === undefined ? committed.current : { value: previousSelection }
      previousSnapshot = snapshot
      previousSelection = previous && isEqual(previous.value, selected) ? previous.value : selected
      return previousSelection
    }
  }, [selector, isEqual])
  const selection = useSyncExternalStore(cadEngine.subscribe, getSelected, getSelected)
  useEffect(() => { committed.current = { value: selection } }, [selection])
  return selection
}

const identity = (snapshot: EngineSnapshot) => snapshot
const selectSelection = (snapshot: EngineSnapshot) => snapshot.selection
const selectRevision = (snapshot: EngineSnapshot) => snapshot.document.revision
const selectValidation = (snapshot: EngineSnapshot) => snapshot.validation
export const useCad = () => useCadSnapshot(identity)
export const useCadSelection = () => useCadSnapshot(selectSelection)
export const useCadDocumentRevision = () => useCadSnapshot(selectRevision)
export const useCadValidation = () => useCadSnapshot(selectValidation)
