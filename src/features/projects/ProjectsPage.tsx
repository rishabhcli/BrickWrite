import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { IndexedDbDriver, MemoryDriver, ProjectRepository, type ProjectSummary } from '../../cad/persistence'
import { DEMOS } from '../../demos'
import { createConvexCloud, type AccessTokenSource } from '../../cloud/convexClient'
import { CloudProjectStore, type StoredProjectSummary } from '../../cloud/projectStore'
import { PlateAtmosphere } from '../landing/plate'
import { usePointerField } from '../landing/reveal'
import { useAccountSession } from '../../platform/auth/accountSession'
import './projects.css'

const STARTERS = [
  { id: 'blank', title: 'Blank', href: '/editor?doc=blank', demoId: null as string | null },
  { id: 'describe', title: 'Describe', href: '/editor?doc=blank&intent=describe', demoId: null },
  ...DEMOS.slice(0, 4).map((demo) => ({
    id: demo.id,
    title: demo.title,
    href: `/explore?demo=${demo.id}`,
    demoId: demo.id,
  })),
]

/**
 * A standalone token source, rather than importing `cloud/browserRuntime`.
 * That module reaches for `cadEngine`/`session`/`commandBus` to bridge a live
 * kernel into cloud sync — machinery this dashboard has no use for and no
 * reason to pull into a route that never boots the editor.
 */
const dashboardTokenSource: AccessTokenSource = async (args) => {
  try {
    const { getHexclaveClientApp } = await import('../../hexclave/client')
    const app = getHexclaveClientApp()
    return app.status === 'ok' ? await app.data.getConvexClientAuth({})(args) : null
  } catch {
    return null
  }
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const pointer = usePointerField<HTMLDivElement>()
  const account = useAccountSession()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [cloudOnly, setCloudOnly] = useState<StoredProjectSummary[] | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)

  const store = useMemo(
    () => new ProjectRepository(typeof indexedDB !== 'undefined' ? new IndexedDbDriver() : new MemoryDriver()),
    [],
  )

  const loadProjects = useCallback(async () => {
    try {
      setListError(null)
      setProjects(await store.listProjects())
    } catch (cause) {
      setProjects([])
      setListError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [store])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // A build claimed to the cloud from another browser has no local copy here
  // at all, so the list above — IndexedDB only — can never show it. This is
  // the one place this page looks past its own browser, for a real signed-in
  // account only: there is no other device for an anonymous guest session to
  // share a build with.
  useEffect(() => {
    if (account.status !== 'signed-in') {
      setCloudOnly(null)
      setCloudError(null)
      return
    }
    let live = true
    const cloud = createConvexCloud({ tokenSource: dashboardTokenSource })
    if (cloud.status !== 'ready') {
      setCloudOnly(null)
      setCloudError(null)
      return
    }
    void new CloudProjectStore(cloud.backend).listProjects().then((result) => {
      if (!live) return
      if (result.ok) {
        setCloudError(null)
        setCloudOnly(result.value.filter((summary) => !projects.some((local) => local.projectId === summary.localProjectId)))
      } else {
        // Reported, never hidden: an unreachable deployment must not look
        // like an account with nothing saved to it.
        setCloudOnly(null)
        setCloudError(`${result.error.message} ${result.error.repair}`.trim())
      }
    })
    return () => {
      live = false
      void cloud.close()
    }
  }, [account.status, projects])

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        setActionError(null)
        await store.deleteProject(id)
        setProjects((prev) => prev.filter((project) => project.projectId !== id))
        setDeleteConfirm(null)
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [store],
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(
      (project) => project.name.toLowerCase().includes(query) || project.projectId.toLowerCase().includes(query),
    )
  }, [projects, search])

  return (
    <div ref={pointer.ref} className="bw-surface bw-projects-page" data-pointer={pointer.live ? 'live' : 'off'}>
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <div className="bw-shell">
        <section className="bw-projects-hero" aria-labelledby="bw-dashboard-title">
          <div className="bw-projects-header">
            <div className="bw-projects-header-title">
              <h1 className="bw-display x2" id="bw-dashboard-title">
                Models
              </h1>
            </div>
            <div className="bw-projects-actions">
              <Link className="bw-button primary bw-magnet" to="/editor">
                New model{' '}
                <span className="bw-key" aria-hidden="true">
                  →
                </span>
              </Link>
              <Link className="bw-button ghost" to="/explore">
                Demos
              </Link>
            </div>
          </div>
        </section>

        <details className="bw-templates-section bw-templates-disclosure">
          <summary>
            <span>
              <small>Start from a template</small>
              <strong>Blank plate or verified demo</strong>
            </span>
          </summary>
          <div className="bw-templates-grid">
            {STARTERS.map((starter) => {
              const demo = starter.demoId ? DEMOS.find((entry) => entry.id === starter.demoId) : undefined
              return (
                <button
                  key={starter.id}
                  type="button"
                  className="bw-template-card"
                  onClick={() => navigate(starter.href)}
                >
                  {demo ? (
                    <img src={demo.assets.thumbnail.url} alt="" width={360} height={225} />
                  ) : (
                    <div className="bw-template-plate" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                  <h3>{starter.title}</h3>
                </button>
              )
            })}
          </div>
        </details>

        <section className="bw-projects-list-section" aria-labelledby="bw-saved-title">
          <div className="bw-section-head">
            <h2 className="bw-display x3" id="bw-saved-title">
              Saved
            </h2>
          </div>

          <div className="bw-projects-filter-bar">
            <label className="bw-projects-search">
              <span className="bw-visually-hidden">Search models</span>
              <input
                type="search"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search models"
              />
            </label>
          </div>

          {listError ? (
            <div className="bw-projects-empty" role="alert">
              <h3 className="bw-display x3">Saved models could not be read</h3>
              <p>{listError}</p>
            </div>
          ) : null}
          {actionError ? (
            <div className="bw-projects-empty" role="alert">
              <h3 className="bw-display x3">That change did not complete</h3>
              <p>{actionError}</p>
            </div>
          ) : null}

          <div className="bw-projects-grid">
            {loading ? (
              <div className="bw-projects-empty">
                <p>Loading…</p>
              </div>
            ) : listError ? null : filtered.length === 0 ? (
              <div className="bw-projects-empty">
                <h3 className="bw-display x3">{search ? 'Nothing matches' : 'No models yet'}</h3>
                <p>{search ? 'Clear the search to see every saved build.' : 'A blank plate, or any published demo.'}</p>
                <Link className="bw-button primary small" to="/editor?doc=blank">
                  Start a blank build
                </Link>
              </div>
            ) : (
              filtered.map((project) => (
                <article className="bw-project-card" key={project.projectId}>
                  <div className="bw-project-card-header">
                    <h3 className="bw-project-card-title">{project.name}</h3>
                  </div>
                  <div className="bw-project-card-meta">
                    <span>
                      r<b>{project.revision}</b>
                    </span>
                    <span>
                      <b>{project.partCount}</b> parts
                    </span>
                    <span>{new Date(project.savedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="bw-project-card-actions">
                    <Link
                      className="bw-button small primary"
                      to={`/editor?project=${encodeURIComponent(project.projectId)}`}
                    >
                      Open{' '}
                      <span className="bw-key" aria-hidden="true">
                        →
                      </span>
                    </Link>
                    {deleteConfirm === project.projectId ? (
                      <>
                        <button
                          type="button"
                          className="bw-button small"
                          onClick={() => handleDelete(project.projectId)}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className="bw-button small ghost" onClick={() => setDeleteConfirm(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="bw-button small ghost"
                        onClick={() => setDeleteConfirm(project.projectId)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        {cloudError || (cloudOnly && cloudOnly.length > 0) ? (
          <section className="bw-projects-list-section" aria-labelledby="bw-cloud-title">
            <div className="bw-section-head">
              <h2 className="bw-display x3" id="bw-cloud-title">
                Saved to the cloud, not yet in this browser
              </h2>
              <p>Open the editor's Projects panel to download one of these here.</p>
            </div>
            {cloudError ? (
              <div className="bw-projects-empty" role="alert">
                <h3 className="bw-display x3">The cloud list could not be read</h3>
                <p>{cloudError}</p>
              </div>
            ) : (
              <div className="bw-projects-grid">
                {(cloudOnly ?? []).map((project) => (
                  <article className="bw-project-card" key={project.projectId}>
                    <div className="bw-project-card-header">
                      <h3 className="bw-project-card-title">{project.name}</h3>
                    </div>
                    <div className="bw-project-card-meta">
                      <span>
                        r<b>{project.revision}</b>
                      </span>
                      <span>{new Date(project.savedAt).toLocaleDateString()}</span>
                    </div>
                    <div className="bw-project-card-actions">
                      <Link className="bw-button small primary" to="/editor">
                        Open in editor{' '}
                        <span className="bw-key" aria-hidden="true">
                          →
                        </span>
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  )
}

export default ProjectsPage
