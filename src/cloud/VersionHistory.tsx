import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { CloudOff, GitBranch, History, RotateCcw, Save, X } from 'lucide-react'
import { useFocusTrap } from '../platform'
import type { ModelDocument } from '../cad/types'
import { useCloudSync } from './CloudSyncProvider'
import type { CloudBranchRecord, CloudErrorShape, CloudVersionRecord } from './protocol'
import type { CloudRole } from './protocol'
import { refusalReason } from './permissions'
import type { ProjectLink } from './projectStore'
import { canReachCloud } from './runtime'
import { compareToVersion, restorePlan, summariseDiff, type DocumentDiff } from './versions'
import { formatCount, formatWhen, type CloudWorkbenchApi, type SurfaceNotice } from './surface'
import './cloud.css'

/**
 * Version history: what happened, and how to get back to it without losing
 * anything on the way.
 *
 * Three properties this dialog exists to preserve.
 *
 * **A version is immutable.** Nothing here edits one. Creating a version pins
 * the current document; restoring one *reads* it.
 *
 * **A restore is new work, never a rewind.** `restorePlan` turns "make the
 * document look like this again" into ordinary `CadOperation`s, which are
 * dispatched through the command bus against the revision the plan was computed
 * on. So a restore is preflighted, respects locked regions, lands as one more
 * transaction on the head, is undoable, and cannot silently delete anything
 * committed since the dialog was opened — the kernel refuses a stale expected
 * revision instead. Differences the operation vocabulary cannot express are
 * listed before you commit, not discovered afterwards.
 *
 * **A conflict fork is shown, not hidden.** When two people advanced the same
 * revision, both histories exist on the deployment and both are drawn here side
 * by side. Presenting one of them as "the" history would be the same lie as
 * merging by overwriting.
 */
export function CloudVersionHistory({ api }: { api: CloudWorkbenchApi }) {
  const close = useCallback(() => api.openModal(null), [api])
  const dialogRef = useFocusTrap(true, { onEscape: close })

  return (
    <div className="bw-cloud-backdrop" data-testid="cloud-version-history">
      <div
        className="bw-cloud-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bw-cloud-version-title"
        ref={dialogRef as React.RefObject<HTMLDivElement>}
      >
        <div className="bw-cloud-dialog-head">
          <div>
            <span className="bw-cloud-eyebrow">Cloud</span>
            <h2 id="bw-cloud-version-title">
              <History size={14} aria-hidden="true" /> Version history
            </h2>
          </div>
          <button type="button" className="bw-cloud-btn" onClick={close} aria-label="Close version history">
            <X size={12} aria-hidden="true" /> Close
          </button>
        </div>
        <div className="bw-cloud-dialog-body">
          <VersionHistoryBody api={api} />
        </div>
        <div className="bw-cloud-dialog-foot">
          <span className="bw-cloud-project-meta">
            Document {api.snapshot.document.name} · revision {api.snapshot.document.revision}
          </span>
          <button type="button" className="bw-cloud-btn" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function VersionHistoryBody({ api }: { api: CloudWorkbenchApi }) {
  const { snapshot } = useCloudSync()
  const { configuration, identity, store, links } = snapshot
  const documentId = api.snapshot.document.id

  const [link, setLink] = useState<ProjectLink | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void links.get(documentId).then((found) => {
      if (live) setLink(found ?? null)
    })
    return () => {
      live = false
    }
  }, [links, documentId, snapshot.linksVersion])

  if (configuration.status === 'unconfigured') {
    return (
      <EmptyReason
        title="No cloud is configured, so there are no versions"
        detail={configuration.reason ?? ''}
        extra="Versions, branches and comparison all live on a Convex deployment. Without one, this build keeps the full local transaction log instead — every edit is still recorded, undoable and replayable in this browser."
      />
    )
  }

  if (!canReachCloud(identity)) {
    return (
      <EmptyReason
        title="Sign in to see this project's versions"
        detail={identity.reason ?? 'You are not signed in.'}
        extra="Versions are owned by a Hexclave account. Your local history is unaffected and stays in this browser."
      />
    )
  }

  if (link === undefined) {
    return (
      <p className="bw-cloud-empty" role="status">
        Checking whether this project has a cloud replica…
      </p>
    )
  }

  if (link === null || !store) {
    return (
      <EmptyReason
        title="This project has no cloud replica"
        detail="Nothing has been claimed into the cloud for the document you have open, so there is no version history to show."
        extra="Use “Save to cloud” in the Projects panel to claim it. Claiming uploads the stored checkpoint and every transaction after it, unchanged."
      />
    )
  }

  return <ClaimedHistory api={api} link={link} />
}

function ClaimedHistory({ api, link }: { api: CloudWorkbenchApi; link: ProjectLink }) {
  const { snapshot } = useCloudSync()
  const store = snapshot.store!
  const kernel = snapshot.kernel
  const documentId = api.snapshot.document.id
  const currentRevision = api.snapshot.document.revision

  const [branches, setBranches] = useState<CloudBranchRecord[] | null>(null)
  const [versions, setVersions] = useState<CloudVersionRecord[] | null>(null)
  const [role, setRole] = useState<CloudRole | null | undefined>(undefined)
  const [error, setError] = useState<CloudErrorShape | null>(null)
  const [nonce, refresh] = useReducer((count: number) => count + 1, 0)
  const [notice, setNotice] = useState<SurfaceNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('')
  const [branchName, setBranchName] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [selected, setSelected] = useState<{
    version: CloudVersionRecord
    document: ModelDocument
    diff: DocumentDiff
    summary: string
    identical: boolean
  } | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    void Promise.all([
      store.listBranches(documentId),
      store.listVersions(documentId),
      store.myRole(documentId),
    ]).then(
      ([branchResult, versionResult, roleResult]) => {
        if (!live) return
        if (!branchResult.ok) {
          setError(branchResult.error)
          setBranches([])
        } else {
          setBranches(branchResult.value)
        }
        if (!versionResult.ok) {
          setError((existing) => existing ?? versionResult.error)
          setVersions([])
        } else {
          setVersions(versionResult.value)
        }
        if (!roleResult.ok) {
          setError((existing) => existing ?? roleResult.error)
          setRole(null)
        } else {
          setRole(roleResult.value)
        }
      },
    )
    return () => {
      live = false
    }
  }, [store, documentId, nonce])

  const conflict = useMemo(
    () => (branches ?? []).find((branch) => branch.kind === 'conflict') ?? null,
    [branches],
  )

  const run = useCallback(async (work: () => Promise<SurfaceNotice | null>) => {
    setBusy(true)
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
      setBusy(false)
      refresh()
    }
  }, [])

  const compare = (version: CloudVersionRecord) =>
    run(async () => {
      const document = await store.versionDocument(documentId, version.versionId)
      if (!document.ok) {
        return {
          tone: 'error',
          title: 'That version could not be read',
          detail: `${document.error.message} ${document.error.repair}`,
        }
      }
      const comparison = compareToVersion(api.snapshot.document, document.value)
      setSelected({
        version,
        document: document.value,
        diff: comparison.diff,
        summary: comparison.summary,
        identical: comparison.identical,
      })
      return null
    })

  const restore = () =>
    run(async () => {
      if (!selected) return null
      // Planned against the revision on screen, and dispatched against the same
      // one. If anything landed while this dialog was open the kernel refuses
      // it, which is the whole point of carrying an expected revision.
      const expectedRevision = kernel.document().revision
      const plan = restorePlan(kernel.document(), selected.document)
      if (plan.operations.length === 0) {
        return {
          tone: 'neutral',
          title: 'Nothing to restore',
          detail: 'The open document already matches that version in every field this can express.',
        }
      }
      const dispatched = kernel.dispatch(
        `Restore version “${selected.version.label}”`,
        plan.operations,
        expectedRevision,
      )
      if (!dispatched.ok) {
        return {
          tone: 'error',
          title: 'Restore refused',
          detail: `${dispatched.message}${dispatched.repair ? ` ${dispatched.repair}` : ''} The document is unchanged.`,
        }
      }

      // The restore is now ordinary history at the head. Pinning it as its own
      // version is what makes it reversible in the same way everything else is.
      const pinned = await store.createVersion(
        documentId,
        `Restored “${selected.version.label}”`,
        kernel.document(),
        { notes: `Restored from revision ${selected.version.revision} as revision ${dispatched.revision}.` },
      )
      const unrestorable = plan.unrestorable.length
        ? ` ${formatCount(plan.unrestorable.length, 'difference')} could not be expressed as an operation and ${plan.unrestorable.length === 1 ? 'was' : 'were'} left alone.`
        : ''
      return pinned.ok
        ? {
            tone: plan.unrestorable.length ? 'warn' : 'neutral',
            title: `Restored as revision ${dispatched.revision}`,
            detail: `Applied ${formatCount(plan.operations.length, 'operation')} as one new transaction; nothing was rewound.${unrestorable}`,
          }
        : {
            tone: 'warn',
            title: `Restored as revision ${dispatched.revision}`,
            detail: `Applied ${formatCount(plan.operations.length, 'operation')} as one new transaction. The version marking it could not be created: ${pinned.error.message}${unrestorable}`,
          }
    })

  const saveVersion = () =>
    run(async () => {
      const trimmed = label.trim()
      if (!trimmed) return null
      const created = await store.createVersion(documentId, trimmed, kernel.document())
      setLabel('')
      return created.ok
        ? {
            tone: 'neutral',
            title: `Pinned “${created.value.label}”`,
            detail: `Revision ${created.value.revision} is now an immutable version.`,
          }
        : {
            tone: 'error',
            title: 'Version not created',
            detail: `${created.error.message} ${created.error.repair}`,
          }
    })

  const makeBranch = () =>
    run(async () => {
      const trimmed = branchName.trim()
      if (!trimmed) return null
      const created = await store.createBranch(documentId, trimmed, { kind: 'named' })
      setBranchName('')
      return created.ok
        ? {
            tone: 'neutral',
            title: `Branch “${created.value.name}”`,
            detail: `Forked at revision ${created.value.baseRevision}.`,
          }
        : {
            tone: 'error',
            title: 'Branch not created',
            detail: `${created.error.message} ${created.error.repair}`,
          }
    })

  const recoverAfterClear = useCallback(async () => {
    const filled = await store.backfill(documentId)
    if (!filled.ok) return filled
    await snapshot.handle?.outbox.drain()
    return filled
  }, [documentId, snapshot.handle, store])

  const reconcile = () =>
    run(async () => {
      const resolved = await store.resolveDivergence(documentId)
      if (!resolved.ok) {
        return {
          tone: 'error',
          title: 'Conflict not reconciled',
          detail: `${resolved.error.message} ${resolved.error.repair}`,
        }
      }
      await snapshot.handle?.outbox.drain()
      if (resolved.value.document) await kernel.openProject(documentId)
      return {
        tone: 'neutral',
        title:
          resolved.value.kind === 'conflict-fork'
            ? 'Both histories preserved'
            : 'Divergence reconciled',
        detail:
          resolved.value.kind === 'conflict-fork'
            ? 'Main now follows the cloud head and the local tail is preserved on a conflict branch.'
            : `Recovery completed as ${resolved.value.kind.replace('-', ' ')}.`,
      }
    })

  const retryAuthenticated = () =>
    run(async () => {
      const state = await snapshot.handle?.retryHead()
      if (!state || state.status === 'error' || state.status === 'conflict') {
        return {
          tone: 'error',
          title: 'Retry still refused',
          detail: state?.reason ?? 'The sync runtime is not available.',
        }
      }
      const filled = await recoverAfterClear()
      return filled.ok
        ? {
            tone: 'neutral',
            title: 'Sync resumed',
            detail: `The parked change was accepted and ${filled.value.queued} local change(s) were backfilled.`,
          }
        : {
            tone: 'warn',
            title: 'The head cleared, but backfill did not complete',
            detail: `${filled.error.message} ${filled.error.repair}`,
          }
    })

  const discard = () =>
    run(async () => {
      const discarded = await snapshot.handle?.outbox.discardHead()
      setConfirmDiscard(false)
      if (!discarded || !discarded.ok || !discarded.value) {
        return {
          tone: 'error',
          title: 'Nothing was discarded',
          detail: !discarded
            ? 'The sync runtime is not available.'
            : discarded.ok
              ? 'The queue no longer has a head entry.'
              : `${discarded.error.message} ${discarded.error.repair}`,
        }
      }
      // `discardHead` reports idle optimistically. Drain immediately, then
      // recover anything that could not enter a full queue from the local log.
      await snapshot.handle?.outbox.drain()
      const filled = await recoverAfterClear()
      return filled.ok
        ? {
            tone: 'warn',
            title: 'Queued copy discarded; local work kept',
            detail: `The refused queue entry was removed. ${filled.value.queued} later local change(s) were queued again.`,
          }
        : {
            tone: 'warn',
            title: 'Queued copy discarded; local work kept',
            detail: `Backfill did not complete: ${filled.error.message} ${filled.error.repair}`,
          }
    })

  if (branches === null || versions === null || role === undefined) {
    return (
      <p className="bw-cloud-empty" role="status">
        Reading versions and branches from the deployment…
      </p>
    )
  }

  const byBranch = new Map<string, CloudVersionRecord[]>()
  for (const branch of branches) byBranch.set(branch.branchId, [])
  for (const version of versions) {
    const bucket = byBranch.get(version.branchId)
    if (bucket) bucket.push(version)
    else byBranch.set(version.branchId, [version])
  }
  for (const bucket of byBranch.values()) {
    bucket.sort((a, b) => b.revision - a.revision)
  }

  const sync = snapshot.sync
  const blockedHere = sync.blocked?.localProjectId === documentId
  const versionRefusal = refusalReason(role, 'version.create')
  const restoreRefusal = refusalReason(role, 'version.restore')
  const branchRefusal = refusalReason(role, 'branch.create')
  const discardable =
    blockedHere &&
    sync.status === 'error' &&
    (sync.lastError?.code === 'FORBIDDEN' || sync.lastError?.code === 'PAYLOAD_TOO_LARGE')

  return (
    <>
      {error && (
        <div className="bw-cloud-notice" data-tone="error" role="alert">
          <strong>The deployment refused part of this read</strong>
          <p>
            {error.message} {error.repair}
          </p>
        </div>
      )}

      {!api.online && (
        <div className="bw-cloud-notice" data-tone="warn" role="status">
          <strong>
            <CloudOff size={11} aria-hidden="true" /> This browser is offline
          </strong>
          <p>
            What is listed here is whatever was read before the connection dropped. Creating,
            comparing and restoring all need the deployment, so they will fail until it returns.
          </p>
        </div>
      )}

      {conflict && (
        <div className="bw-cloud-notice" data-tone="warn" role="status">
          <strong>
            <GitBranch size={11} aria-hidden="true" /> This project has a conflict fork
          </strong>
          <p>
            Two histories advanced from revision {conflict.baseRevision}. Neither was discarded:
            “{conflict.name}” holds the tail that lost the race, replayed unchanged — same ids, same
            order — and main holds the one that landed. Both are below.
          </p>
        </div>
      )}

      {blockedHere && sync.status === 'conflict' && (
        <div className="bw-cloud-notice" data-tone="warn" role="status">
          <strong>
            <GitBranch size={11} aria-hidden="true" /> The queued local tail needs reconciliation
          </strong>
          <p>
            The cloud moved past the revision this browser edited. Reconciliation rebases disjoint
            work and creates a conflict branch when both histories touched the same entities.
          </p>
          <div className="bw-cloud-actions">
            <button type="button" className="bw-cloud-btn" data-variant="primary" disabled={busy} onClick={() => void reconcile()}>
              Reconcile
            </button>
          </div>
        </div>
      )}

      {blockedHere && sync.status === 'error' && (
        <div className="bw-cloud-notice" data-tone="error" role="alert">
          <strong>Queued change refused{sync.lastError?.code ? ` · ${sync.lastError.code}` : ''}</strong>
          <p>{sync.lastError?.message ?? sync.reason}</p>
          {sync.lastError?.code === 'PAYLOAD_TOO_LARGE' && (
            <p>Discarding only unblocks the queue. The same edit will return unless it is split into smaller commits.</p>
          )}
          {sync.lastError?.code === 'SCHEMA_MISMATCH' && (
            <p>Reload the application so the client and stored project agree on a document schema. No queue entry will be removed.</p>
          )}
          <div className="bw-cloud-actions">
            {sync.lastError?.code === 'UNAUTHENTICATED' && (
              <button type="button" className="bw-cloud-btn" data-variant="primary" disabled={busy} onClick={() => void retryAuthenticated()}>
                Retry signed-in send
              </button>
            )}
            {sync.lastError?.code === 'SCHEMA_MISMATCH' && (
              <button type="button" className="bw-cloud-btn" onClick={() => window.location.reload()}>
                Reload application
              </button>
            )}
            {discardable && !confirmDiscard && (
              <button type="button" className="bw-cloud-btn" data-variant="danger" disabled={busy} onClick={() => setConfirmDiscard(true)}>
                Discard this queued change
              </button>
            )}
          </div>
          {confirmDiscard && discardable && (
            <div className="bw-cloud-confirm" role="alertdialog" aria-label="Confirm queued change discard">
              <strong>Keep the edit only in this browser?</strong>
              <p>The local transaction log is not deleted. The cloud replica will omit this queued copy.</p>
              <div className="bw-cloud-actions">
                <button type="button" className="bw-cloud-btn" data-variant="danger" disabled={busy} onClick={() => void discard()}>
                  Confirm discard
                </button>
                <button type="button" className="bw-cloud-btn" disabled={busy} onClick={() => setConfirmDiscard(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="bw-cloud-notice" data-tone={notice.tone} role="status">
          <strong>{notice.title}</strong>
          <p>{notice.detail}</p>
        </div>
      )}

      <div className="bw-cloud-inline-form">
        <input
          className="bw-cloud-field"
          aria-label="Label for a new version of the current revision"
          placeholder={`Pin revision ${currentRevision} as…`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveVersion()
          }}
        />
        <button
          type="button"
          className="bw-cloud-btn"
          data-variant="primary"
          disabled={busy || !label.trim() || Boolean(versionRefusal)}
          title={versionRefusal ?? undefined}
          onClick={() => void saveVersion()}
        >
          <Save size={11} aria-hidden="true" /> Save version
        </button>
      </div>

      <div className="bw-cloud-inline-form">
        <input
          className="bw-cloud-field"
          aria-label="Name for a new branch"
          placeholder="New branch from the current head…"
          value={branchName}
          onChange={(event) => setBranchName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void makeBranch()
          }}
        />
        <button
          type="button"
          className="bw-cloud-btn"
          disabled={busy || !branchName.trim() || Boolean(branchRefusal)}
          title={branchRefusal ?? undefined}
          onClick={() => void makeBranch()}
        >
          <GitBranch size={11} aria-hidden="true" /> Branch
        </button>
      </div>

      {branches.length === 0 ? (
        <p className="bw-cloud-empty">
          The deployment reports no branches for this project. The link recorded in this browser
          points at branch <code>{link.branchId}</code>.
        </p>
      ) : (
        <div className="bw-cloud-branches">
          {branches.map((branch) => (
            <section
              key={branch.branchId}
              className="bw-cloud-branch"
              data-kind={branch.kind}
              aria-label={`Branch ${branch.name}`}
            >
              <div className="bw-cloud-branch-head">
                <h3>
                  <GitBranch size={11} aria-hidden="true" /> {branch.name}
                </h3>
                <span className="bw-cloud-badge" data-origin={branch.kind === 'conflict' ? 'remote' : 'cloud'}>
                  {branch.kind}
                </span>
              </div>
              <span className="bw-cloud-project-meta">
                Head revision {branch.headRevision} · forked at {branch.baseRevision} · created{' '}
                {formatWhen(branch.createdAt)}
              </span>
              {branch.proposal && (
                <span className="bw-cloud-project-meta">
                  Merge proposal {branch.proposal.status}: {branch.proposal.summary}
                </span>
              )}
              <div className="bw-cloud-scroll">
                {(byBranch.get(branch.branchId) ?? []).length === 0 ? (
                  <p className="bw-cloud-empty">
                    No versions have been pinned on this branch. Its transaction log is still
                    complete on the deployment.
                  </p>
                ) : (
                  (byBranch.get(branch.branchId) ?? []).map((version) => (
                    <div
                      key={version.versionId}
                      className="bw-cloud-version"
                      data-selected={selected?.version.versionId === version.versionId}
                    >
                      <div className="bw-cloud-version-head">
                        <span className="bw-cloud-version-label">{version.label}</span>
                        <span className="bw-cloud-version-rev">r{version.revision}</span>
                      </div>
                      <span className="bw-cloud-project-meta">{formatWhen(version.createdAt)}</span>
                      {version.notes && <p className="bw-cloud-version-notes">{version.notes}</p>}
                      <div className="bw-cloud-actions">
                        <button
                          type="button"
                          className="bw-cloud-btn"
                          disabled={busy}
                          onClick={() => void compare(version)}
                        >
                          Compare with open document
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {selected && (
        <section className="bw-cloud-branch" aria-label={`Comparison with ${selected.version.label}`}>
          <div className="bw-cloud-branch-head">
            <h3>
              {selected.version.label} <span className="bw-cloud-version-rev">r{selected.version.revision}</span>
            </h3>
            <span className="bw-cloud-project-meta">against revision {currentRevision}</span>
          </div>
          <p className="bw-cloud-version-notes">
            {selected.identical
              ? 'That version and the open document are structurally identical.'
              : `Since that version: ${summariseDiff(selected.diff)}`}
          </p>
          <RestorePreview current={kernel.document()} target={selected.document} />
          <div className="bw-cloud-actions">
            <button
              type="button"
              className="bw-cloud-btn"
              data-variant="primary"
              disabled={busy || selected.identical || Boolean(restoreRefusal)}
              title={restoreRefusal ?? undefined}
              onClick={() => void restore()}
            >
              <RotateCcw size={11} aria-hidden="true" /> Restore as a new revision
            </button>
            <button type="button" className="bw-cloud-btn" onClick={() => setSelected(null)}>
              Close comparison
            </button>
          </div>
          <span className="bw-cloud-project-meta">
            Restoring never rewinds: it lands as one new transaction on revision {currentRevision},
            and is undoable like any other edit.
          </span>
        </section>
      )}
    </>
  )
}

/** What a restore would and would not do, before anybody presses the button. */
function RestorePreview({ current, target }: { current: ModelDocument; target: ModelDocument }) {
  const plan = useMemo(() => restorePlan(current, target), [current, target])
  return (
    <ul className="bw-cloud-diff">
      <li>{formatCount(plan.operations.length, 'operation')} would be applied as one transaction.</li>
      {plan.unrestorable.map((reason) => (
        <li key={reason} className="bw-cloud-unrestorable">
          {reason}
        </li>
      ))}
    </ul>
  )
}

function EmptyReason({ title, detail, extra }: { title: string; detail: string; extra: string }) {
  return (
    <div className="bw-cloud-notice" data-tone="neutral" role="note">
      <strong>
        <CloudOff size={11} aria-hidden="true" /> {title}
      </strong>
      <p>{detail}</p>
      <p>{extra}</p>
    </div>
  )
}
