import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { IndexedDbDriver, MemoryDriver, ProjectRepository, type ProjectSummary } from '../../cad/persistence'
import { DEMOS } from '../../demos'
import { PlateAtmosphere } from '../landing/plate'
import { usePointerField } from '../landing/reveal'
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

export function ProjectsPage() {
  const navigate = useNavigate()
  const pointer = usePointerField<HTMLDivElement>()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const store = useMemo(
    () => new ProjectRepository(typeof indexedDB !== 'undefined' ? new IndexedDbDriver() : new MemoryDriver()),
    [],
  )

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await store.listProjects())
    } catch {
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [store])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await store.deleteProject(id)
        setProjects((prev) => prev.filter((project) => project.projectId !== id))
        setDeleteConfirm(null)
      } catch (err) {
        console.error('Failed to delete project', err)
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
              <span className="bw-eyebrow accent">{projects.length} saved</span>
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
            <span className="bw-section-index">This browser</span>
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

          <div className="bw-projects-grid">
            {loading ? (
              <div className="bw-projects-empty">
                <p>Loading…</p>
              </div>
            ) : filtered.length === 0 ? (
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
      </div>
    </div>
  )
}

export default ProjectsPage
