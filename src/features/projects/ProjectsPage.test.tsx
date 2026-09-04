import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The dashboard's cloud section.
 *
 * The local "Saved" grid already had no test coverage before this and stays
 * that way here — these tests are scoped to what this change actually added:
 * a build claimed to the cloud from another browser is invisible to the local
 * IndexedDB list this page otherwise reads, so it needs its own fetch, its
 * own account gate, and its own honest error state.
 */

interface FakeCloudSummary {
  projectId: string
  localProjectId: string
  name: string
  revision: number
  savedAt: string
  partCount: null
  origin: 'cloud'
  role: null
  visibility: null
}

type FakeListResult =
  | { ok: true; value: FakeCloudSummary[] }
  | { ok: false; error: { code: string; message: string; repair: string } }

const cloud = vi.hoisted(() => ({
  accountStatus: 'signed-in' as 'signed-in' | 'signed-out' | 'restricted' | 'expired',
  cloudStatus: 'ready' as 'ready' | 'unconfigured',
  listProjects: vi.fn(
    async (): Promise<FakeListResult> => ({
      ok: true,
      value: [],
    }),
  ),
  close: vi.fn(async () => {}),
}))

vi.mock('../../platform/auth/accountSession', () => ({
  useAccountSession: () => ({ status: cloud.accountStatus }),
}))

vi.mock('../../cloud/convexClient', () => ({
  createConvexCloud: () =>
    cloud.cloudStatus === 'ready'
      ? { status: 'ready' as const, url: 'https://example.convex.cloud', backend: {}, close: cloud.close }
      : { status: 'unconfigured' as const, reason: 'no deployment' },
}))

vi.mock('../../cloud/projectStore', () => ({
  CloudProjectStore: class {
    listProjects() {
      return cloud.listProjects()
    }
  },
}))

const { ProjectsPage } = await import('./ProjectsPage')

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  cloud.accountStatus = 'signed-in'
  cloud.cloudStatus = 'ready'
  cloud.listProjects.mockClear()
  cloud.listProjects.mockImplementation(async () => ({ ok: true, value: [] }))
  cloud.close.mockClear()
})

afterEach(cleanup)

describe('the cloud-only section', () => {
  it('does not query the cloud for a signed-out visitor', async () => {
    cloud.accountStatus = 'signed-out'
    renderPage()
    await waitFor(() => expect(screen.getByText('No models yet')).toBeInTheDocument())
    expect(cloud.listProjects).not.toHaveBeenCalled()
    expect(screen.queryByText(/Saved to the cloud/)).toBeNull()
  })

  it('does not query the cloud for an anonymous or restricted guest session', async () => {
    cloud.accountStatus = 'restricted'
    renderPage()
    await waitFor(() => expect(screen.getByText('No models yet')).toBeInTheDocument())
    expect(cloud.listProjects).not.toHaveBeenCalled()
  })

  it('shows nothing extra when no cloud deployment is configured', async () => {
    cloud.cloudStatus = 'unconfigured'
    renderPage()
    await waitFor(() => expect(screen.getByText('No models yet')).toBeInTheDocument())
    expect(cloud.listProjects).not.toHaveBeenCalled()
    expect(screen.queryByText(/Saved to the cloud/)).toBeNull()
  })

  it('lists a build the cloud has that this browser does not, for a signed-in account', async () => {
    cloud.listProjects.mockImplementation(async () => ({
      ok: true,
      value: [
        {
          projectId: 'prj_1',
          localProjectId: 'doc_from_another_browser',
          name: 'Survey Rover',
          revision: 4,
          savedAt: '2026-09-01T00:00:00.000Z',
          partCount: null,
          origin: 'cloud' as const,
          role: null,
          visibility: null,
        },
      ],
    }))
    renderPage()
    await waitFor(() => expect(screen.getByText('Survey Rover')).toBeInTheDocument())
    expect(screen.getByText(/Saved to the cloud, not yet in this browser/)).toBeInTheDocument()
  })

  it('reports a cloud read failure rather than showing an empty section', async () => {
    cloud.listProjects.mockImplementation(async () => ({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'The deployment could not be reached.', repair: 'Try again shortly.' },
    }))
    renderPage()
    await waitFor(() => expect(screen.getByText('The cloud list could not be read')).toBeInTheDocument())
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument()
  })
})
