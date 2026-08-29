import { useEffect, useState } from 'react'
import { useCloudSync } from './CloudSyncProvider'
import { describeSync, type SyncReadout } from './syncReadout'
import { VERSION_HISTORY_MODAL_ID, type CloudWorkbenchApi } from './surface'
import './cloud.css'

/**
 * The cloud's one line in the status bar.
 *
 * It is a button rather than a label because there is somewhere real to go from
 * here — the version history, which is also where every one of these states is
 * explained at length — and because a status that cannot be interrogated is
 * where an operator's trust goes to die.
 *
 * The label is computed by `describeSync`, which is the file that owns the rule
 * that matters: it will not print "Synced" unless this browser has watched a
 * change be accepted by the deployment.
 */
export function CloudSyncStatus({ api }: { api: CloudWorkbenchApi }) {
  const { snapshot } = useCloudSync()
  const readout = useSyncReadout(api)

  const summary = readout.repair ? `${readout.reason} ${readout.repair}` : readout.reason

  return (
    <button
      type="button"
      className="bw-cloud-status"
      data-status={readout.status}
      data-tone={readout.tone}
      data-testid="cloud-sync-status"
      aria-label={`Cloud: ${readout.label}. ${summary}`}
      title={summary}
      aria-haspopup="dialog"
      aria-expanded={api.activeModal === VERSION_HISTORY_MODAL_ID}
      onClick={() =>
        api.openModal(api.activeModal === VERSION_HISTORY_MODAL_ID ? null : VERSION_HISTORY_MODAL_ID)
      }
    >
      <span className="bw-cloud-status-dot" aria-hidden="true" />
      <b>{readout.label}</b>
      {readout.pending > 0 && (
        <span className="bw-cloud-status-pending">
          {readout.pending} queued
        </span>
      )}
      {!snapshot.online && readout.status !== 'offline' && <span>offline</span>}
    </button>
  )
}

/**
 * The readout for the open document.
 *
 * `linked` is read from the runtime's recorded project links rather than from
 * the sync queue, because an empty queue is not evidence that a replica exists
 * — an unclaimed project has an empty queue forever.
 */
export function useSyncReadout(api: CloudWorkbenchApi): SyncReadout {
  const { runtime, snapshot } = useCloudSync()
  const documentId = api.snapshot.document.id
  const linked = useProjectLinked(documentId)
  const blockedLocalId = snapshot.sync.blocked?.localProjectId ?? null
  const [blockedProjectName, setBlockedProjectName] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!blockedLocalId || blockedLocalId === documentId) {
      setBlockedProjectName(null)
      return () => {
        live = false
      }
    }
    void runtime.listLocalProjects().then((projects) => {
      if (live) {
        setBlockedProjectName(
          projects.find((project) => project.projectId === blockedLocalId)?.name ?? null,
        )
      }
    })
    return () => {
      live = false
    }
  }, [blockedLocalId, documentId, runtime])

  return describeSync({
    configuration: snapshot.configuration,
    identity: snapshot.identity,
    sync: snapshot.sync,
    linked,
    online: snapshot.online && api.online,
    activeProjectId: documentId,
    blockedProjectName,
  })
}

/** Whether this document has a recorded cloud replica. Re-read when it changes. */
export function useProjectLinked(documentId: string): boolean {
  const { runtime, snapshot } = useCloudSync()
  const [linked, setLinked] = useState(false)

  useEffect(() => {
    let live = true
    void snapshot.links.get(documentId).then((link) => {
      // Guarded: a link resolved after the operator switched projects would
      // report the previous project's cloud status against the new one.
      if (live) setLinked(link !== undefined)
    })
    return () => {
      live = false
    }
    // `linksVersion` moves whenever a claim or a delete rewrites the links,
    // which is the only thing that can change this answer.
  }, [documentId, snapshot.links, snapshot.linksVersion, runtime])

  return linked
}
