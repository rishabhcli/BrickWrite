// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

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

describe('Members panel — delivery retries', () => {
  async function failedInvitation(harness: UiHarness) {
    const store = await claimOpenProject(harness)
    const created = await store.createInvitation(OPEN, 'retry@example.test', 'editor')
    if (!created.ok) throw new Error(created.error.message)
    const row = harness.deployment.invitations.find(row => row._id === created.value.invitationId)!
    row.expiresAt = Date.now() + 86_400_000
    row.deliveryRequestedAt = 0 // completed cooldown in both the UI and fake server clock
    row.deliveryStatus = 'failed'
    row.deliveryReason = 'The email request failed. Delivery is not confirmed.'
    return row
  }

  it('retries a failed delivery on the same invitation instead of minting another link', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const row = await failedInvitation(harness)
    const token = row.token
    await mount(harness)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry delivery' }))
    await screen.findByText('Delivery retry queued')
    expect(row.deliveryStatus).toBe('pending')
    expect(row.deliveryGeneration).toBe(1)
    expect(row.token).toBe(token)
    expect(harness.deployment.invitations).toHaveLength(1)
  })

  it('disables retry during the cooldown and explains when it becomes available', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const row = await failedInvitation(harness)
    row.deliveryRequestedAt = Date.now()
    await mount(harness)
    const retry = await screen.findByRole('button', { name: 'Retry delivery' })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('title', expect.stringContaining('Retry available'))
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeEnabled()
  })

  it('does not offer retry after the endpoint accepted the invitation', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const row = await failedInvitation(harness)
    row.deliveryStatus = 'queued'
    row.deliveryReason = 'The email endpoint accepted the invitation. Inbox delivery is not confirmed.'
    await mount(harness)
    await screen.findByText(/Inbox delivery is not confirmed/)
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument()
  })

  it('enables retry when the cooldown elapses without a manual page refresh', async () => {
    vi.useFakeTimers()
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const row = await failedInvitation(harness)
    row.deliveryRequestedAt = Date.now()
    await mount(harness)
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeEnabled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes an in-flight attempt and stops polling when submission finishes', async () => {
    vi.useFakeTimers()
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN })
    const row = await failedInvitation(harness)
    row.deliveryStatus = 'sending'
    row.deliveryStartedAt = Date.now()
    await mount(harness)
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeDisabled()
    row.deliveryStatus = 'queued'
    row.deliveryReason = 'Hexclave accepted the invitation. Inbox delivery is not confirmed.'
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText(/Hexclave accepted the invitation/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a refused retry visible instead of claiming it was queued', async () => {
    const harness = makeUiHarness({ configured: true, identity: SIGNED_IN,
      wrapBackend: backend => overrideBackend(backend, { retryInvitationDelivery: async () => ({ ok: false,
        error: { code: 'FORBIDDEN', message: 'Your role no longer permits invitations.', repair: 'Reload access.' } }) }) })
    await failedInvitation(harness)
    await mount(harness)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry delivery' }))
    await screen.findByText('Delivery retry refused')
    expect(screen.getByText(/Your role no longer permits/)).toBeInTheDocument()
    expect(screen.queryByText('Delivery retry queued')).not.toBeInTheDocument()
  })
})
