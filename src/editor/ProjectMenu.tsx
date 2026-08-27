import { AlertTriangle, Check, ChevronDown, Copy, GitBranch, Save, Scale, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { catalog } from '../cad/catalog'
import { session, type SessionStatus } from '../cad/session'
import type { ProjectSummary } from '../cad/persistence'

/**
 * Project and legal surface.
 *
 * Two things the kernel already knew but the editor never showed:
 *
 *   - The persistence layer keeps multiple projects, checkpoints and a restore
 *     report. Without a switcher there was no way to reach any of it, and no way
 *     to see whether the open document had been restored from a replayed log or
 *     started fresh.
 *   - The catalog compiler writes a per-dataset licence manifest with attribution
 *     text and explicit review-required flags. Attribution that exists only
 *     inside a build artefact is not attribution.
 *
 * Every action here goes through `session`, which owns flushing the outgoing
 * project before anything replaces the document.
 */

interface DatasetLicence {
  dataset: string
  use: string
  license?: string
  licensePerFile?: boolean
  observedLicenses?: Record<string, number>
  attribution?: string
  note?: string
  shareAlikeReviewRequired?: boolean
  redistributionReviewRequired?: boolean
}

interface LicenceManifest {
  note: string
  datasets: DatasetLicence[]
}

interface ProjectMenuProps {
  documentName: string
  documentId: string
  revision: number
  sessionStatus: SessionStatus
  onNotice: (notice: { kind: 'success' | 'error' | 'info'; title: string; detail: string }) => void
}

export function ProjectMenu({ documentName, documentId, revision, sessionStatus, onNotice }: ProjectMenuProps) {
  const [open, setOpen] = useState<'none' | 'projects' | 'legal'>('none')
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [licences, setLicences] = useState<LicenceManifest | null>(null)
  const [forkName, setForkName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setProjects(await session.listProjects())
  }, [])

  useEffect(() => {
    if (open === 'projects') void refresh()
    if (open === 'legal' && !licences) {
      void fetch(`${import.meta.env.BASE_URL}catalog/${catalog.version}/licenses.json`)
        .then((response) => (response.ok ? (response.json() as Promise<LicenceManifest>) : null))
        .then(setLicences)
        .catch(() => setLicences(null))
    }
  }, [open, licences, refresh])

  useEffect(() => {
    if (open === 'none') return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen('none')
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [open])

  /**
   * Runs a session action, reporting its refusal rather than swallowing it.
   *
   * `openProject` and `deleteProject` both have legitimate refusals — an
   * unplaceable model, the currently open project — and those are the cases an
   * operator most needs told.
   */
  const run = useCallback(
    async (label: string, action: () => Promise<{ ok: boolean; message?: string }>, success: string) => {
      setBusy(true)
      try {
        const result = await action()
        if (result.ok) onNotice({ kind: 'success', title: label, detail: success })
        else onNotice({ kind: 'error', title: label, detail: result.message ?? 'Refused.' })
      } catch (cause) {
        onNotice({ kind: 'error', title: label, detail: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [onNotice, refresh],
  )

  const restore = sessionStatus.restore
  const restoreHeadline =
    restore?.source === 'indexeddb'
      ? restore.replayedTransactions > 0
        ? `Restored from a checkpoint, ${restore.replayedTransactions} transaction${restore.replayedTransactions === 1 ? '' : 's'} replayed`
        : 'Restored from a checkpoint, nothing to replay'
      : restore?.source === 'legacy-localstorage'
        ? 'Migrated from the previous storage format'
        : 'Started from the opening showcase'

  return (
    <div className="project-menu">
      <button
        className="project-identity"
        onClick={() => setOpen(open === 'none' ? 'projects' : 'none')}
        aria-expanded={open !== 'none'}
      >
        <span className={`project-dot ${sessionStatus.error ? 'failing' : sessionStatus.durable ? '' : 'volatile'}`} />
        <div>
          <strong>{documentName}</strong>
          <small>
            {sessionStatus.durable ? 'LOCAL DOCUMENT · AUTOSAVED' : 'IN MEMORY ONLY'}
            {projects.length > 1 ? ` · ${projects.length} PROJECTS` : ''}
          </small>
        </div>
        <ChevronDown size={13} />
      </button>

      {open === 'projects' && (
        <div className="project-panel" role="dialog" aria-label="Projects">
          <header>
            <span className="eyebrow">PROJECTS</span>
            <button onClick={() => setOpen('none')} aria-label="Close projects"><X size={12} /></button>
          </header>

          {/* Shown rather than assumed: an operator should be able to see
              whether this document came from a checkpoint, a replayed log, a
              migration, or a fresh showcase. */}
          <div className="restore-report">
            <strong>{restoreHeadline}</strong>
            <small>revision {revision} · catalog {catalog.version}</small>
            {restore?.warning && <p className="restore-warning"><AlertTriangle size={11} /> {restore.warning}</p>}
            {sessionStatus.error && (
              <p className="restore-warning"><AlertTriangle size={11} /> Autosave failed: {sessionStatus.error}</p>
            )}
          </div>

          <div className="project-actions">
            <button
              disabled={busy}
              onClick={() => void run('Checkpoint', async () => { await session.checkpoint(); return { ok: true } }, `Saved at revision ${revision}.`)}
            >
              <Save size={12} /> Checkpoint now
            </button>
            <button disabled={busy} onClick={() => setOpen('legal')}>
              <Scale size={12} /> Data &amp; licences
            </button>
          </div>

          <div className="project-fork">
            <input
              value={forkName}
              placeholder={`${documentName} (fork)`}
              onChange={(event) => setForkName(event.target.value)}
              aria-label="Fork name"
            />
            <button
              disabled={busy}
              onClick={() =>
                void run('Fork', () => session.forkProject(forkName), 'The fork is now the open project; the original is untouched.').then(
                  () => setForkName(''),
                )
              }
            >
              <GitBranch size={12} /> Fork
            </button>
          </div>

          <ul className="project-list">
            {projects.map((project) => {
              const current = project.projectId === documentId
              return (
                <li key={project.projectId} className={current ? 'current' : undefined}>
                  <button
                    className="project-open"
                    disabled={busy || current}
                    onClick={() => void run('Open project', () => session.openProject(project.projectId), `Now editing "${project.name}".`)}
                  >
                    {current ? <Check size={12} /> : <span className="project-bullet" />}
                    <div>
                      <strong>{project.name}</strong>
                      <small>
                        r{project.revision} · {project.partCount} part{project.partCount === 1 ? '' : 's'} ·{' '}
                        {new Date(project.savedAt).toLocaleString()}
                      </small>
                    </div>
                  </button>
                  <button
                    className="project-delete"
                    disabled={busy || current}
                    title={current ? 'Switch away before deleting this project' : `Delete ${project.name}`}
                    aria-label={`Delete ${project.name}`}
                    onClick={() => void run('Delete project', () => session.deleteProject(project.projectId), `"${project.name}" and its log are gone.`)}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              )
            })}
            {!projects.length && <li className="project-empty">No checkpoints written yet.</li>}
          </ul>
        </div>
      )}

      {open === 'legal' && (
        <div className="project-panel legal" role="dialog" aria-label="Data and licences">
          <header>
            <span className="eyebrow">DATA &amp; LICENCES</span>
            <button onClick={() => setOpen('projects')} aria-label="Back to projects"><X size={12} /></button>
          </header>

          <p className="legal-lede">
            Brickwright compiles third-party datasets. Catalog revision <code>{catalog.version}</code>.
          </p>

          {licences ? (
            <ul className="legal-list">
              {licences.datasets.map((dataset) => (
                <li key={dataset.dataset}>
                  <strong>{dataset.dataset}</strong>
                  <small>{dataset.use}</small>
                  {dataset.observedLicenses && (
                    <em>
                      {Object.entries(dataset.observedLicenses)
                        .map(([licence, count]) => `${licence} · ${count.toLocaleString()} files`)
                        .join(', ')}
                    </em>
                  )}
                  {dataset.license && <em>{dataset.license}</em>}
                  {dataset.attribution && <p>{dataset.attribution}</p>}
                  {dataset.note && <p className="legal-note">{dataset.note}</p>}
                  {/* Review requirements are surfaced, not buried: they are the
                      difference between a local build and one that may be
                      redistributed. */}
                  {(dataset.shareAlikeReviewRequired || dataset.redistributionReviewRequired) && (
                    <p className="legal-review">
                      <AlertTriangle size={11} />
                      {dataset.shareAlikeReviewRequired
                        ? 'ShareAlike scope for the compiled derivative needs a licence review before public redistribution.'
                        : 'Redistribution rights for the compiled derivative are unspecified and need review.'}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="legal-note">The licence manifest for this catalog revision could not be loaded.</p>
          )}

          <p className="legal-trademark">
            LEGO® is a registered trademark of the LEGO Group, which does not sponsor, endorse or
            authorise LDraw or Brickwright. Brickwright is an unofficial tool for designing with
            LEGO-compatible parts.
          </p>
          <button
            className="legal-copy"
            onClick={() => {
              const text = [
                ...(licences?.datasets ?? []).map(
                  (dataset) => `${dataset.dataset} — ${dataset.attribution ?? dataset.note ?? dataset.use}`,
                ),
                'LEGO is a trademark of the LEGO Group, which does not sponsor, endorse or authorize this tool.',
              ].join('\n')
              void navigator.clipboard
                ?.writeText(text)
                .then(() => onNotice({ kind: 'success', title: 'Attribution copied', detail: 'Paste it wherever the compiled assets are redistributed.' }))
                .catch(() => onNotice({ kind: 'error', title: 'Clipboard unavailable', detail: 'This context does not allow clipboard writes.' }))
            }}
          >
            <Copy size={12} /> Copy attribution text
          </button>
        </div>
      )}
    </div>
  )
}
