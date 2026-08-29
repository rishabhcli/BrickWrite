// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalProjectStore, type MirroredProjectStore } from '../projectStore'
import { SIGNED_OUT_IDENTITY } from '../runtime'
import { refusalReason } from '../permissions'
import { CloudMembersPanel } from '../MembersPanel'
import { addMember, BOB, CAROL } from './harness'
import {
  fakeWorkbenchApi,
  makeUiHarness,
  overrideBackend,
  SIGNED_IN,
  withRuntime,
  type UiHarness,
} from './uiHarness'

afterEach(cleanup)

const OPEN = 'doc_ui'

async function claimOpenProject(harness: UiHarness): Promise<MirroredProjectStore> {
  const local = new LocalProjectStore(harness.driver)
  await local.saveCheckpoint(harness.engine.getSnapshot().document)
  const store = harness.runtime.getSnapshot().store
  if (!store) throw new Error('This harness has no cloud store.')
  const claimed = await store.claim(OPEN)
  if (!claimed.ok) throw new Error(claimed.error.message)
  harness.runtime.notifyLinksChanged()
  return store
}

async function mount(harness: UiHarness) {
  const api = fakeWorkbenchApi(harness.engine)
  await act(async () => {
    render(withRuntime(harness.runtime, <CloudMembersPanel api={api} />))
  })
  return api
}

describe('Members panel — gate states', () => {
  it('renders the four gate states before fetching', async () => {
    const unconfigured = makeUiHarness()
    await mount(unconfigured)
    expect(screen.getByTestId('cloud-members-panel')).toHaveTextContent('Collaboration needs a cloud deployment')
    cleanup()

    const signedOut = makeUiHarness({ configured: true, identity: SIGNED_OUT_IDENTITY })
    await mount(signedOut)
    expect(screen.getByTestId('cloud-members-panel')).toHaveTextContent('Sign in to share this project')
    cleanup()

    const checking = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const api = fakeWorkbenchApi(checking.engine)
    render(withRuntime(checking.runtime, <CloudMembersPanel api={api} />))
    expect(screen.getByText('Checking collaboration access…')).toBeInTheDocument()
    cleanup()

    const unclaimed = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await mount(unclaimed)
    await waitFor(() =>
      expect(screen.getByTestId('cloud-members-panel')).toHaveTextContent('Save this project to the cloud first'),
    )
  })
})

describe('Members panel — claimed project', () => {
  it('disables invite for a viewer with the refusal reason', async () => {
    const alice = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(alice)
    const link = await alice.runtime.getSnapshot().links.get(OPEN)
    if (!link) throw new Error('missing link')
    await addMember(alice.deployment, alice.backend, link.cloudProjectId, BOB, 'viewer')

    const bob = makeUiHarness({
      configured: true,
      deployment: alice.deployment,
      driver: alice.driver,
      as: BOB,
      identity: { status: 'signed-in', reason: null, userId: BOB.subject, label: 'Bob' },
      document: alice.engine.getSnapshot().document,
    })
    await mount(bob)
    await waitFor(() => expect(screen.getByLabelText('Collaborator email')).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled()
    expect(screen.getByTestId('cloud-members-panel')).toHaveTextContent(refusalReason('viewer', 'member.invite')!)
  })

  it('offers no role picker or leave control on the owner’s row', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    const row = screen.getByText('Alice').closest('li')
    expect(row).toBeTruthy()
    expect(within(row!).queryByRole('combobox', { name: /Role for/ })).toBeNull()
    expect(within(row!).queryByRole('button', { name: /Leave|Remove/ })).toBeNull()
  })

  it('badges an invitation past expiresAt as expired even while the server says pending', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    const store = harness.runtime.getSnapshot().store!
    const created = await store.createInvitation(OPEN, 'stale@example.test', 'editor')
    expect(created.ok).toBe(true)
    const row = harness.deployment.invitations.find((entry) => entry.email === 'stale@example.test')
    if (!row) throw new Error('invitation missing')
    row.expiresAt = Date.now() - 1_000
    await mount(harness)
    await waitFor(() => expect(screen.getByText('stale@example.test')).toBeInTheDocument())
    expect(screen.getByText('expired')).toBeInTheDocument()
  })

  it('confirms before demoting, naming the sync consequence', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    const link = await harness.runtime.getSnapshot().links.get(OPEN)
    if (!link) throw new Error('missing link')
    await addMember(harness.deployment, harness.backend, link.cloudProjectId, BOB, 'editor')
    await mount(harness)
    await waitFor(() => expect(screen.getByLabelText('Role for Bob')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Role for Bob'), { target: { value: 'viewer' } })
    const dialog = await screen.findByRole('alertdialog', { name: /Confirm demoting Bob/ })
    expect(dialog).toHaveTextContent('will not be able to save changes they have not yet synced')
  })

  it('keeps other rows interactive while one row is busy', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeUiHarness({
      configured: true,
      identity: SIGNED_IN,
      wrapBackend: (backend) =>
        overrideBackend(backend, {
          setMemberRole: async (args) => {
            await gate
            return backend.setMemberRole(args)
          },
        }),
    })
    await claimOpenProject(harness)
    const link = await harness.runtime.getSnapshot().links.get(OPEN)
    if (!link) throw new Error('missing link')
    await addMember(harness.deployment, harness.backend, link.cloudProjectId, BOB, 'editor')
    await addMember(harness.deployment, harness.backend, link.cloudProjectId, CAROL, 'editor')
    await mount(harness)
    await waitFor(() => expect(screen.getByLabelText('Role for Bob')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Role for Carol'), { target: { value: 'commenter' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm role change' }))
    expect(screen.getByLabelText('Role for Bob')).not.toBeDisabled()
    release()
    await waitFor(() => expect(screen.getByLabelText('Role for Carol')).toHaveValue('commenter'))
  })

  it('surfaces delivery status when email is not configured', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    await claimOpenProject(harness)
    await mount(harness)
    await waitFor(() => expect(screen.getByLabelText('Collaborator email')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Collaborator email'), { target: { value: 'new@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => expect(screen.getByText(/Invited new@example.test/)).toBeInTheDocument())
    expect(screen.getByTestId('cloud-members-panel').textContent).toMatch(/not configured/i)
  })
})
