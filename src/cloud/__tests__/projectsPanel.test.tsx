// `tsconfig.app.json` type-checks `.test.tsx` (its exclude list only names
// `.test.ts`), so the jest-dom matcher augmentation is imported here as well as
// in the shared setup file. The import is idempotent at runtime.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalProjectStore } from '../projectStore'
import { CloudProjectsPanel } from '../ProjectsPanel'
import { SIGNED_OUT_IDENTITY } from '../runtime'
import { blankProject } from './harness'
import { fakeWorkbenchApi, makeUiHarness, SIGNED_IN, withRuntime, type UiHarness } from './uiHarness'

/**
 * The Projects panel, in every state a person can actually be in.
 *
 * The default in this repository has no `VITE_CONVEX_URL`, so the unconfigured
 * path is the one most of these tests exercise: it has to be complete, honest
 * and fully operable, not a stub behind a sign-in wall.
 */

afterEach(cleanup)

async function seed(harness: UiHarness, projects: Array<[string, string]>) {
  const local = new LocalProjectStore(harness.driver)
  for (const [id, name] of projects) {
    await local.saveCheckpoint(blankProject(id, name))
  }
}

async function mount(harness: UiHarness, apiOverrides = {}) {
  const api = fakeWorkbenchApi(harness.engine, apiOverrides)
  await act(async () => {
    render(withRuntime(harness.runtime, <CloudProjectsPanel api={api} />))
  })
  return api
}

describe('Projects panel — unconfigured, which is this build’s default', () => {
  it('says why there is no cloud and still lists local projects', async () => {
    const harness = makeUiHarness()
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness)

    const banner = screen.getByRole('note')
    expect(banner).toHaveTextContent('Local only — no cloud is configured')
    expect(banner).toHaveTextContent('VITE_CONVEX_URL is not set')
    expect(banner).toHaveTextContent('Everything below works')

    await waitFor(() => expect(screen.getByText('Alpha rover')).toBeInTheDocument())
    expect(screen.getByRole('list', { name: 'Projects in this browser' })).toBeInTheDocument()
    // No cloud group at all, rather than an empty one implying an account.
    expect(screen.queryByRole('list', { name: 'Cloud projects not in this browser' })).toBeNull()
  })

  it('offers open, rename and delete, and no cloud action it cannot perform', async () => {
    const harness = makeUiHarness()
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Alpha rover')).toBeInTheDocument())

    const row = screen.getByTestId('project-doc_a')
    expect(within(row).getByRole('button', { name: /Open/ })).toBeEnabled()
    expect(within(row).getByRole('button', { name: /Rename/ })).toBeEnabled()
    expect(within(row).getByRole('button', { name: /Delete/ })).toBeEnabled()
    const claim = within(row).getByRole('button', { name: /Save to cloud/ })
    expect(claim).toBeDisabled()
    expect(claim).toHaveAttribute('title', 'No cloud deployment is configured in this build.')
    expect(row).toHaveTextContent('No cloud deployment is configured in this build.')
  })

  it('opens a project through the session, not by replacing the document', async () => {
    const harness = makeUiHarness()
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Alpha rover')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('project-doc_a')).getByRole('button', { name: /^Open$/ }))
    })
    expect(harness.openedProjects).toEqual(['doc_a'])
    expect(harness.dispatches).toHaveLength(0)
  })
})

describe('Projects panel — states', () => {
  it('shows a loading state before local storage has answered', () => {
    const harness = makeUiHarness()
    render(withRuntime(harness.runtime, <CloudProjectsPanel api={fakeWorkbenchApi(harness.engine)} />))
    expect(screen.getByRole('status')).toHaveTextContent('Reading the projects saved in this browser')
  })

  it('shows a real empty state when this browser holds nothing', async () => {
    const harness = makeUiHarness()
    await mount(harness)
    await waitFor(() =>
      expect(screen.getByText(/No projects are saved in this browser yet/)).toBeInTheDocument(),
    )
    expect(screen.queryByRole('list', { name: 'Projects in this browser' })).toBeNull()
  })

  it('signed out with a deployment configured: local only, sign in to save', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_OUT_IDENTITY })
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness)

    expect(screen.getByRole('note')).toHaveTextContent('Local only — sign in to save to the cloud')
    expect(screen.getByRole('note')).toHaveTextContent('stay fully usable while you are signed out')
    await waitFor(() => expect(screen.getByText('Alpha rover')).toBeInTheDocument())

    const claim = within(screen.getByTestId('project-doc_a')).getByRole('button', { name: /Save to cloud/ })
    expect(claim).toBeDisabled()
    expect(claim).toHaveAttribute('title', 'Sign in to save this project to the cloud.')
  })

  it('offline: local projects work, uploads are refused with the reason', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN, online: false })
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness, { online: false })
    await waitFor(() => expect(screen.getByText('Alpha rover')).toBeInTheDocument())

    const row = screen.getByTestId('project-doc_a')
    expect(within(row).getByRole('button', { name: /Save to cloud/ })).toBeDisabled()
    expect(row).toHaveTextContent('This browser is offline, so nothing can be uploaded right now.')
    expect(within(row).getByRole('button', { name: /^Open$/ })).toBeEnabled()
  })

  it('reports a deployment that refuses the project list, rather than showing none', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN, unreachable: true })
    await seed(harness, [['doc_a', 'Alpha rover']])
    await mount(harness)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The project list could not be read'),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The cloud is unreachable')
    // And the local list is untouched by the cloud failing.
    expect(screen.getByText('Alpha rover')).toBeInTheDocument()
  })
})

describe('Projects panel — mutations', () => {
  it('renames the open project through the shared capability, not the store', async () => {
    const harness = makeUiHarness({ document: blankProject('doc_open', 'Working title') })
    await seed(harness, [['doc_open', 'Working title']])
    const api = await mount(harness)
    await waitFor(() => expect(screen.getByText('Working title')).toBeInTheDocument())

    const row = screen.getByTestId('project-doc_open')
    expect(row).toHaveAttribute('data-open', 'true')
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: /Rename/ }))
    })
    const field = screen.getByLabelText('New name for Working title')
    fireEvent.change(field, { target: { value: 'Rover mark two' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    expect(api.calls.capability).toEqual(['rename_document:{"name":"Rover mark two"}'])
    expect(harness.engine.getSnapshot().document.name).toBe('Rover mark two')
    expect(harness.engine.getSnapshot().document.revision).toBe(1)
  })

  it('renames a project that is not open by rewriting its checkpoint', async () => {
    const harness = makeUiHarness({ document: blankProject('doc_open', 'Open one') })
    await seed(harness, [['doc_open', 'Open one'], ['doc_other', 'Closed one']])
    const api = await mount(harness)
    await waitFor(() => expect(screen.getByText('Closed one')).toBeInTheDocument())

    const row = screen.getByTestId('project-doc_other')
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: /Rename/ }))
    })
    fireEvent.change(screen.getByLabelText('New name for Closed one'), {
      target: { value: 'Archived hull' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(screen.getByText('Archived hull')).toBeInTheDocument())
    // No kernel transaction: the closed project has no engine to run through.
    expect(api.calls.capability).toEqual([])
    expect(harness.engine.getSnapshot().document.revision).toBe(0)
  })

  it('refuses to delete the open project, and says why', async () => {
    const harness = makeUiHarness({ document: blankProject('doc_open', 'Open one') })
    await seed(harness, [['doc_open', 'Open one']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Open one')).toBeInTheDocument())

    const row = screen.getByTestId('project-doc_open')
    expect(within(row).getByRole('button', { name: /Delete/ })).toBeDisabled()
    expect(row).toHaveTextContent('autosave would immediately write it back')
  })

  it('deletes only after an explicit confirmation', async () => {
    const harness = makeUiHarness({ document: blankProject('doc_open', 'Open one') })
    await seed(harness, [['doc_open', 'Open one'], ['doc_other', 'Closed one']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Closed one')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('project-doc_other')).getByRole('button', { name: /Delete/ }),
      )
    })
    const confirm = screen.getByRole('alertdialog', { name: 'Delete Closed one?' })
    expect(confirm).toHaveTextContent('This cannot be undone from here.')
    expect(screen.getByText('Closed one')).toBeInTheDocument()

    // Backing out leaves it alone.
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }))
    })
    expect(screen.getByText('Closed one')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('project-doc_other')).getByRole('button', { name: /Delete/ }),
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    })
    await waitFor(() => expect(screen.queryByText('Closed one')).toBeNull())
    expect(screen.getByText('Open one')).toBeInTheDocument()
  })

  it('claims a local project into the cloud and verifies the round trip', async () => {
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      document: blankProject('doc_open', 'Rover chassis'),
    })
    await seed(harness, [['doc_open', 'Rover chassis']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Rover chassis')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('project-doc_open')).getByRole('button', { name: /Save to cloud/ }),
      )
    })

    await waitFor(() =>
      expect(screen.getByText(/is in the cloud$/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/read back identical/)).toBeInTheDocument()
    // The replica really exists on the deployment, under Alice's subject.
    expect(harness.deployment.projects).toHaveLength(1)
    expect(harness.deployment.projects[0].localProjectId).toBe('doc_open')
    // And the row now offers versions instead of another claim.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('project-doc_open')).getByRole('button', { name: /Versions/ }),
      ).toBeInTheDocument(),
    )
  })

  it('reports a refused claim instead of showing the project as saved', async () => {
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      unreachable: true,
      document: blankProject('doc_open', 'Rover chassis'),
    })
    await seed(harness, [['doc_open', 'Rover chassis']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Rover chassis')).toBeInTheDocument())

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('project-doc_open')).getByRole('button', { name: /Save to cloud/ }),
      )
    })
    await waitFor(() =>
      expect(screen.getByText('Not saved to the cloud')).toBeInTheDocument(),
    )
    expect(
      within(screen.getByTestId('project-doc_open')).getByRole('button', { name: /Save to cloud/ }),
    ).toBeInTheDocument()
  })
})

describe('Projects panel — accessibility', () => {
  it('labels every list and control, and traps focus in the delete confirmation', async () => {
    const harness = makeUiHarness({ document: blankProject('doc_open', 'Open one') })
    await seed(harness, [['doc_open', 'Open one'], ['doc_other', 'Closed one']])
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Closed one')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Refresh the project list' })).toBeInTheDocument()

    const deleteButton = within(screen.getByTestId('project-doc_other')).getByRole('button', {
      name: /Delete/,
    })
    deleteButton.focus()
    await act(async () => {
      fireEvent.click(deleteButton)
    })

    const confirm = screen.getByRole('alertdialog', { name: 'Delete Closed one?' })
    // The trap moves focus into the dialog rather than leaving it behind.
    await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true))

    const buttons = within(confirm).getAllByRole('button')
    buttons[buttons.length - 1].focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(confirm.contains(document.activeElement)).toBe(true)

    // Escape closes, and focus goes back to the control that opened it.
    await act(async () => {
      fireEvent.keyDown(confirm, { key: 'Escape' })
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(
      within(screen.getByTestId('project-doc_other')).getByRole('button', { name: /Delete/ }),
    )
  })
})
