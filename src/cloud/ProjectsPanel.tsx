import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Cloud, CloudOff, Download, FolderOpen, History, PencilLine, RefreshCw, Trash2, UploadCloud } from 'lucide-react'
import { useFocusTrap } from '../platform'
import { claimIntegrityReport } from './claim'
import { useCloudSync } from './CloudSyncProvider'
import type { CloudErrorShape } from './protocol'
import type { StoredProjectSummary } from './projectStore'
import { canReachCloud, type CloudProjectRow } from './runtime'
import {
  VERSION_HISTORY_MODAL_ID,
  formatCount,
  formatWhen,
  noticeFor,
  type CloudWorkbenchApi,
  type SurfaceNotice,
} from './surface'
import './cloud.css'

/**
 * Projects, as a person uses them.
 *
 * The shape of this panel is decided by one fact: **the default way to run this
 * application has no cloud deployment at all.** So the local list is the
 * primary content and it is fully operable in every state — unconfigured,
 * signed out, offline, conflicted — and the cloud is an annotation on top of
 * it. A panel that hid local projects behind a sign-in wall would take away
 * something that works, in order to advertise something that might not.
 *
 * Nothing here writes the document. Renaming the *open* project goes through
 * `rename_document` on the shared planner, which is the same command bus the
 * agent and the toolbar use, with the kernel checking the revision. Renaming a
 * project that is not open has no engine to run through and rewrites its stored
 * checkpoint instead, which is exactly the split `LocalProjectStore` documents.
 */
export function CloudProjectsPanel({ api }: { api: CloudWorkbenchApi }) {
  const { runtime, snapshot } = useCloudSync()
  const { configuration, identity, store, local, backend, links, kernel } = snapshot
  const configured = configuration.status === 'ready'
  const signedIn = canReachCloud(identity)
  const cloudUsable = configured && signedIn && store !== null && backend !== null
  const documentId = api.snapshot.document.id

  const [rows, setRows] = useState<CloudProjectRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [remote, setRemote] = useState<StoredProjectSummary[] | null>(null)
  const [remoteError, setRemoteError] = useState<CloudErrorShape | null>(null)
  const [nonce, refresh] = useReducer((count: number) => count + 1, 0)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [notice, setNotice] = useState<SurfaceNotice | null>(null)

  // --- Local projects ------------------------------------------------------
  useEffect(() => {
    let live = true
    setListError(null)
    void runtime
      .listLocalProjects()
      .then((listed) => {
        if (live) setRows(listed)
      })
      .catch((cause: unknown) => {
        // Local storage failing is a real, reportable condition — a private
        // window with IndexedDB blocked, say — and not one to swallow.
        if (live) {
          setRows([])
          setListError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      live = false
    }
  }, [runtime, nonce, documentId, snapshot.linksVersion])

  // --- Cloud projects with no copy in this browser -------------------------
  useEffect(() => {
    if (!cloudUsable) {
      setRemote(null)
      setRemoteError(null)
      return
    }
    let live = true
    void store.cloud.listProjects().then((result) => {
      if (!live) return
      if (result.ok) {
        setRemote(result.value)
        setRemoteError(null)
      } else {
        // Reported, never hidden: an unreachable deployment must not look like
        // an account with no projects in it.
        setRemote(null)
        setRemoteError(result.error)
      }
    })
    return () => {
      live = false
    }
  }, [cloudUsable, store, nonce, identity])

  const localIds = useMemo(() => new Set((rows ?? []).map((row) => row.projectId)), [rows])
  const cloudOnly = useMemo(
    () => (remote ?? []).filter((summary) => !localIds.has(summary.localProjectId)),
    [remote, localIds],
  )

  const run = useCallback(
    async (id: string, work: () => Promise<SurfaceNotice | null>) => {
      setBusy(id)
      setNotice(null)
      try {
        const result = await work()
        if (result) setNotice(result)
      } catch (cause: unknown) {
        setNotice({
          tone: 'error',
          title: 'That did not complete',
          detail: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        setBusy(null)
        refresh()
      }
    },
    [],
  )

  // --- Actions -------------------------------------------------------------

  const openProject = (row: CloudProjectRow) =>
    run(row.projectId, async () => {
      const outcome = await kernel.openProject(row.projectId)
      return outcome.ok
        ? { tone: 'neutral', title: `Opened “${row.name}”`, detail: `Revision ${row.revision}.` }
        : { tone: 'warn', title: 'Not opened', detail: outcome.message }
    })

  const commitRename = (row: CloudProjectRow, next: string) =>
    run(row.projectId, async () => {
      const name = next.trim()
      setRenaming(null)
      if (!name || name === row.name) return null
      if (row.open) {
        // The open document is live kernel state. Renaming it is a transaction
        // through the shared planner, so it is undoable, appears in the
        // timeline, and is queued for the cloud like any other edit.
        const ok = api.runCapability('rename_document', { name })
        return ok
          ? { tone: 'neutral', title: 'Renamed', detail: `The open document is now “${name}”.` }
          : {
              tone: 'error',
              title: 'Rename refused',
              detail: 'The command bus refused the rename; the document is unchanged.',
            }
      }
      const result = await (store ?? local).renameProject(row.projectId, name)
      return result.ok
        ? { tone: 'neutral', title: 'Renamed', detail: `“${row.name}” is now “${name}”.` }
        : noticeFor(result.error, 'Rename refused')
    })

  const deleteProject = (row: CloudProjectRow) =>
    run(row.projectId, async () => {
      setConfirming(null)
      const result = await (store ?? local).deleteProject(row.projectId)
      if (!result.ok) return noticeFor(result.error, 'Delete refused')
      runtime.notifyLinksChanged()
      return {
        tone: 'neutral',
        title: `Deleted “${row.name}”`,
        detail: row.link
          ? 'Removed from this browser, and soft-deleted on the deployment so an administrator can still recover it.'
          : 'Removed from this browser.',
      }
    })

  const claimProject = (row: CloudProjectRow) =>
    run(row.projectId, async () => {
      if (!cloudUsable) return null
      const claimed = await store.claim(row.projectId)
      if (!claimed.ok) return noticeFor(claimed.error, 'Not saved to the cloud')
      runtime.notifyLinksChanged()

      // Verified rather than asserted: the claim uploads the stored checkpoint
      // and every transaction after it, and this reads both sides back and
      // compares their canonical serialization. A claim that says "lossless"
      // has been checked.
      const [here, there] = await Promise.all([
        local.loadProject(row.projectId),
        store.cloud.loadProject(claimed.value.projectId),
      ])
      const uploaded = formatCount(claimed.value.transactionsUploaded, 'transaction')
      if (!here.ok || !there.ok || !here.value || !there.value) {
        return {
          tone: 'warn',
          title: `“${row.name}” is in the cloud`,
          detail: `${uploaded} uploaded to revision ${claimed.value.headRevision}. The round trip could not be read back, so losslessness is unverified in this session.`,
        }
      }
      const report = claimIntegrityReport(here.value, there.value)
      return report.lossless
        ? {
            tone: 'neutral',
            title: `“${row.name}” is in the cloud`,
            detail: `${uploaded} uploaded to revision ${claimed.value.headRevision}, and the replica read back identical.`,
          }
        : {
            tone: 'warn',
            title: `“${row.name}” is in the cloud, with differences`,
            detail: `${uploaded} uploaded. The round trip differs: ${report.differences.join(' ')}`,
          }
    })

  const downloadProject = (summary: StoredProjectSummary) =>
    run(summary.projectId, async () => {
      if (!cloudUsable) return null
      const record = await backend.getProject({ projectId: summary.projectId })
      if (!record.ok) return noticeFor(record.error, 'Not downloaded')
      const loaded = await store.cloud.loadProject(summary.projectId)
      if (!loaded.ok) return noticeFor(loaded.error, 'Not downloaded')
      if (!loaded.value) {
        return {
          tone: 'warn',
          title: 'Nothing to download',
          detail: 'The deployment holds no checkpoint for that project yet.',
        }
      }
      const document = loaded.value.document
      await local.saveCheckpoint(document)
      await links.put({
        localProjectId: document.id,
        cloudProjectId: record.value.projectId,
        branchId: record.value.defaultBranchId,
        claimedAt: new Date().toISOString(),
        syncedRevision: document.revision,
      })
      runtime.notifyLinksChanged()
      const opened = await kernel.openProject(document.id)
      return opened.ok
        ? {
            tone: 'neutral',
            title: `Opened “${document.name}”`,
            detail: `Downloaded at revision ${document.revision}. This browser now holds a checkpoint at that revision; the deployment keeps the full transaction history.`,
          }
        : { tone: 'warn', title: 'Downloaded, not opened', detail: opened.message }
    })

  // --- Render --------------------------------------------------------------

  return (
    <div className="bw-cloud" data-testid="cloud-projects-panel">
      <CloudBanner />

      {notice && (
        <div className="bw-cloud-notice" data-tone={notice.tone} role="status">
          <strong>{notice.title}</strong>
          <p>{notice.detail}</p>
        </div>
      )}

      <div className="bw-cloud-inline-form">
        <span className="bw-cloud-eyebrow">In this browser</span>
        <button
          type="button"
          className="bw-cloud-btn"
          onClick={refresh}
          aria-label="Refresh the project list"
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={11} aria-hidden="true" /> Refresh
        </button>
      </div>

      {listError && (
        <div className="bw-cloud-notice" data-tone="error" role="alert">
          <strong>Local storage could not be read</strong>
          <p>{listError}</p>
        </div>
      )}

      {rows === null ? (
        <p className="bw-cloud-empty" role="status">
          Reading the projects saved in this browser…
        </p>
      ) : rows.length === 0 ? (
        <p className="bw-cloud-empty">
          No projects are saved in this browser yet. The document you are editing is checkpointed
          automatically, and will appear here.
        </p>
      ) : (
        <ul className="bw-cloud-list" aria-label="Projects in this browser">
          {rows.map((row) => (
            <li key={row.projectId}>
              <ProjectRow
                row={row}
                busy={busy === row.projectId}
                confirming={confirming === row.projectId}
                renaming={renaming?.id === row.projectId ? renaming.value : null}
                claimBlockedReason={claimBlockedReason(configured, signedIn, api.online && snapshot.online)}
                onOpen={() => openProject(row)}
                onRenameStart={() => setRenaming({ id: row.projectId, value: row.name })}
                onRenameChange={(value) => setRenaming({ id: row.projectId, value })}
                onRenameCommit={(value) => void commitRename(row, value)}
                onRenameCancel={() => setRenaming(null)}
                onDeleteRequest={() => setConfirming(row.projectId)}
                onDeleteConfirm={() => void deleteProject(row)}
                onDeleteCancel={() => setConfirming(null)}
                onClaim={() => void claimProject(row)}
                onHistory={() => api.openModal(VERSION_HISTORY_MODAL_ID)}
              />
            </li>
          ))}
        </ul>
      )}

      {cloudUsable && (
        <>
          <span className="bw-cloud-eyebrow">In the cloud only</span>
          {remoteError ? (
            <div className="bw-cloud-notice" data-tone="error" role="alert">
              <strong>The project list could not be read</strong>
              <p>
                {remoteError.message} {remoteError.repair}
              </p>
            </div>
          ) : remote === null ? (
            <p className="bw-cloud-empty" role="status">
              Reading your cloud projects…
            </p>
          ) : cloudOnly.length === 0 ? (
            <p className="bw-cloud-empty">
              Every project on your account is already in this browser.
            </p>
          ) : (
            <ul className="bw-cloud-list" aria-label="Cloud projects not in this browser">
              {cloudOnly.map((summary) => (
                <li key={summary.projectId}>
                  <div className="bw-cloud-project">
                    <div className="bw-cloud-project-head">
                      <span className="bw-cloud-project-name">{summary.name}</span>
                      <span className="bw-cloud-badge" data-origin="remote">
                        {summary.role ?? 'member'}
                      </span>
                    </div>
                    <span className="bw-cloud-project-meta">
                      Revision {summary.revision} · updated {formatWhen(summary.savedAt)}
                    </span>
                    <div className="bw-cloud-actions">
                      <button
                        type="button"
                        className="bw-cloud-btn"
                        data-variant="primary"
                        disabled={busy === summary.projectId || !api.online}
                        onClick={() => void downloadProject(summary)}
                      >
                        <Download size={11} aria-hidden="true" />
                        {busy === summary.projectId ? 'Downloading…' : 'Download and open'}
                      </button>
                    </div>
                    {!api.online && (
                      <span className="bw-cloud-project-meta">
                        This browser is offline, so nothing can be downloaded.
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

const claimBlockedReason = (configured: boolean, signedIn: boolean, online: boolean): string | null => {
  if (!configured) return 'No cloud deployment is configured in this build.'
  if (!signedIn) return 'Sign in to save this project to the cloud.'
  if (!online) return 'This browser is offline, so nothing can be uploaded right now.'
  return null
}

/**
 * The state of the cloud, said once, at the top.
 *
 * Rendered in every state including the good one, because "where does my work
 * live?" is a question the panel should answer before it is asked.
 */
function CloudBanner() {
  const { snapshot } = useCloudSync()
  const { configuration, identity } = snapshot

  if (configuration.status === 'unconfigured') {
    return (
      <div className="bw-cloud-notice" data-tone="neutral" role="note">
        <strong>
          <CloudOff size={11} aria-hidden="true" /> Local only — no cloud is configured
        </strong>
        <p>{configuration.reason}</p>
        <p>
          Everything below works: projects are saved in this browser, with the full transaction log
          and undo history. Set <code>VITE_CONVEX_URL</code> to add cloud copies.
        </p>
      </div>
    )
  }

  if (!canReachCloud(identity)) {
    return (
      <div className="bw-cloud-notice" data-tone="neutral" role="note">
        <strong>
          <CloudOff size={11} aria-hidden="true" /> Local only — sign in to save to the cloud
        </strong>
        <p>{identity.reason}</p>
        <p>Projects in this browser stay fully usable while you are signed out.</p>
      </div>
    )
  }

  return (
    <div className="bw-cloud-notice" data-tone="active" role="note">
      <strong>
        <Cloud size={11} aria-hidden="true" /> Signed in as {identity.label}
      </strong>
      <p>Projects you save to the cloud are owned by your Hexclave account.</p>
    </div>
  )
}

function ProjectRow({
  row,
  busy,
  confirming,
  renaming,
  claimBlockedReason: blocked,
  onOpen,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onClaim,
  onHistory,
}: {
  row: CloudProjectRow
  busy: boolean
  confirming: boolean
  renaming: string | null
  claimBlockedReason: string | null
  onOpen: () => void
  onRenameStart: () => void
  onRenameChange: (value: string) => void
  onRenameCommit: (value: string) => void
  onRenameCancel: () => void
  onDeleteRequest: () => void
  onDeleteConfirm: () => void
  onDeleteCancel: () => void
  onClaim: () => void
  onHistory: () => void
}) {
  const deleteButton = useRef<HTMLButtonElement>(null)
  const confirmRef = useFocusTrap(confirming, { onEscape: onDeleteCancel, restoreTo: deleteButton })
  const renameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming !== null) renameInput.current?.select()
  }, [renaming !== null])

  return (
    <div className="bw-cloud-project" data-open={row.open} data-testid={`project-${row.projectId}`}>
      <div className="bw-cloud-project-head">
        <span className="bw-cloud-project-name">{row.name}</span>
        <span className="bw-cloud-badge" data-origin={row.link ? 'cloud' : 'local'}>
          {row.link ? 'Cloud' : 'Local'}
        </span>
      </div>
      <span className="bw-cloud-project-meta">
        Revision {row.revision}
        {row.partCount !== null && ` · ${formatCount(row.partCount, 'part')}`} · saved{' '}
        {formatWhen(row.savedAt)}
        {row.open && ' · open now'}
      </span>

      {renaming !== null ? (
        <div className="bw-cloud-inline-form">
          <input
            ref={renameInput}
            className="bw-cloud-field"
            aria-label={`New name for ${row.name}`}
            value={renaming}
            onChange={(event) => onRenameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRenameCommit(renaming)
              if (event.key === 'Escape') {
                event.stopPropagation()
                onRenameCancel()
              }
            }}
          />
          <button
            type="button"
            className="bw-cloud-btn"
            data-variant="primary"
            disabled={!renaming.trim()}
            onClick={() => onRenameCommit(renaming)}
          >
            Save
          </button>
          <button type="button" className="bw-cloud-btn" onClick={onRenameCancel}>
            Cancel
          </button>
        </div>
      ) : confirming ? (
        <div
          className="bw-cloud-confirm"
          role="alertdialog"
          aria-label={`Delete ${row.name}?`}
          ref={confirmRef as React.RefObject<HTMLDivElement>}
        >
          <p>
            Delete “{row.name}” from this browser
            {row.link ? ' and soft-delete its cloud replica' : ''}? This cannot be undone from here.
          </p>
          <div className="bw-cloud-actions">
            <button type="button" className="bw-cloud-btn" data-variant="danger" onClick={onDeleteConfirm}>
              Delete permanently
            </button>
            <button type="button" className="bw-cloud-btn" onClick={onDeleteCancel}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="bw-cloud-actions">
          <button type="button" className="bw-cloud-btn" disabled={busy || row.open} onClick={onOpen}>
            <FolderOpen size={11} aria-hidden="true" /> {row.open ? 'Open now' : 'Open'}
          </button>
          <button type="button" className="bw-cloud-btn" disabled={busy} onClick={onRenameStart}>
            <PencilLine size={11} aria-hidden="true" /> Rename
          </button>
          <button
            ref={deleteButton}
            type="button"
            className="bw-cloud-btn"
            data-variant="danger"
            disabled={busy || row.open}
            title={row.open ? 'Open another project before deleting this one.' : undefined}
            onClick={onDeleteRequest}
          >
            <Trash2 size={11} aria-hidden="true" /> Delete
          </button>
          {row.link ? (
            <button type="button" className="bw-cloud-btn" disabled={!row.open} onClick={onHistory} title={row.open ? undefined : 'Open this project to browse its versions.'}>
              <History size={11} aria-hidden="true" /> Versions
            </button>
          ) : (
            <button
              type="button"
              className="bw-cloud-btn"
              data-variant="primary"
              disabled={busy || blocked !== null}
              title={blocked ?? undefined}
              onClick={onClaim}
            >
              <UploadCloud size={11} aria-hidden="true" /> {busy ? 'Saving…' : 'Save to cloud'}
            </button>
          )}
        </div>
      )}

      {row.open && !confirming && renaming === null && (
        <span className="bw-cloud-project-meta">
          This project is open, so it cannot be deleted from here — autosave would immediately write
          it back.
        </span>
      )}
      {!row.link && blocked && renaming === null && !confirming && (
        <span className="bw-cloud-project-meta">{blocked}</span>
      )}
    </div>
  )
}
