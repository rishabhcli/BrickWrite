import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ModelDocument } from '../cad/types'
import { resolveAnchors, type AnchorReport } from './comments'
import { UNCONFIGURED_SYNC_STATE, type SyncState } from './outbox'
import type { MirroredProjectStore, StoredProjectSummary } from './projectStore'
import type { CloudCommentRecord, CloudErrorShape } from './protocol'

/**
 * React bindings for the cloud layer.
 *
 * Data and hooks, not page UI: this workstream owns synchronisation, not
 * screens. Everything here is a thin, cancellable read over the stores, so the
 * surfaces that render projects can live wherever they belong.
 *
 * Every hook tolerates a null store, because "signed out, no cloud" is the
 * default state of the application and a hook that threw in it would take the
 * editor down for the people who never asked for an account.
 */

/**
 * The live sync state.
 *
 * `useSyncExternalStore` rather than an effect plus state: the outbox is the
 * source of truth and React should read it, not shadow it.
 */
export function useSyncState(store: MirroredProjectStore | null): SyncState {
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribeSync(onChange) : () => {}),
    [store],
  )
  const snapshot = useCallback(
    () => (store ? store.syncState : UNCONFIGURED_SYNC_STATE),
    [store],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export interface ProjectListState {
  projects: StoredProjectSummary[]
  loading: boolean
  error: CloudErrorShape | null
  refresh: () => void
}

/** The project list, from whichever store is in play. */
export function useProjectList(
  store: { listProjects: MirroredProjectStore['listProjects'] } | null,
): ProjectListState {
  const [projects, setProjects] = useState<StoredProjectSummary[]>([])
  const [loading, setLoading] = useState(store !== null)
  const [error, setError] = useState<CloudErrorShape | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!store) {
      setProjects([])
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void store.listProjects().then((result) => {
      // Guarded because a project list that arrives after the component has
      // moved on would otherwise repopulate a view nobody is looking at.
      if (!live) return
      setLoading(false)
      if (result.ok) {
        setProjects(result.value)
        setError(null)
      } else {
        setError(result.error)
      }
    })
    return () => {
      live = false
    }
  }, [store, nonce])

  return { projects, loading, error, refresh: () => setNonce((value) => value + 1) }
}

/**
 * Comment anchors resolved against the open document.
 *
 * Recomputed whenever the document revision moves, which is exactly when an
 * anchor can go from intact to moved.
 */
export function useAnchorReports(
  document: ModelDocument | null,
  comments: readonly CloudCommentRecord[],
): AnchorReport[] {
  return useMemo(
    () => (document ? resolveAnchors(document, comments) : []),
    [document, comments],
  )
}
