import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The account product, across every state it can be in.
 *
 * Hexclave is mocked here rather than left unconfigured because these are the
 * states that only exist once there *is* an account layer: a signed-in menu, an
 * expired session, a restricted user. The unconfigured path is covered by
 * `shell.test.tsx`, which runs against the real SDK failing to construct.
 */

type MockUser = {
  id: string
  displayName: string | null
  primaryEmail: string | null
  profileImageUrl: string | null
  isRestricted: boolean
  restrictedReason: { type: string } | null
  restrictedByAdminReason: string | null
}

const hex = vi.hoisted(() => ({
  user: null as MockUser | null,
  redirectToSignIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}))

vi.mock('../../hexclave/client', () => ({
  getHexclaveClientApp: () => ({
    status: 'ok' as const,
    data: { redirectToSignIn: hex.redirectToSignIn, signOut: hex.signOut },
  }),
  resetHexclaveClientApp: () => {},
}))

vi.mock('@hexclave/react', () => ({
  HexclaveProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  HexclaveTheme: ({ children }: { children: ReactNode }) => <>{children}</>,
  useUser: () => hex.user,
  useHexclaveApp: () => ({ redirectToSignIn: hex.redirectToSignIn, signOut: hex.signOut }),
  UserAvatar: () => <span data-testid="avatar" />,
  AuthPage: ({ type }: { type: string }) => <div data-testid="hexclave-auth-page">{type}</div>,
  AccountSettings: () => <div data-testid="hexclave-account-settings" />,
  getPagePrompt: () => ({ title: 'Sign In', fullPrompt: '', upgradePrompt: null, latestVersion: 1 }),
}))

vi.mock('../../cad/catalog-loader', () => ({
  loadCompiledCatalog: async () => ({
    version: 'test',
    identityCount: 1,
    placeableCount: 1,
    colorCount: 1,
    connectorCount: 1,
    aliasCount: 0,
    externalIdentityCount: 0,
  }),
  preloadDocumentGeometry: async () => {},
}))
vi.mock('../../cad/engine', () => ({ cadEngine: { getDocument: () => ({ parts: {} }) } }))
vi.mock('../../cad/session', () => ({ session: { start: async () => {} } }))

const { AppShell, installPlatformSurfaces } = await import('../AppShell')
const { registerRoute, resetRouteRegistry } = await import('../routes')
const { resetBoot } = await import('../boot')
const { resetSessionMemory } = await import('./account')
const { safeReturnTo } = await import('./AuthRoutes')
const { resetPlatformAnalytics, drainPlatformAnalytics } = await import('../analytics')

function signedIn(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'user-1',
    displayName: 'Ada Lovelace',
    primaryEmail: 'ada@example.test',
    profileImageUrl: null,
    isRestricted: false,
    restrictedReason: null,
    restrictedByAdminReason: null,
    ...overrides,
  }
}

function goTo(path: string) {
  window.history.pushState({}, '', path)
}

beforeEach(() => {
  resetBoot()
  resetRouteRegistry()
  installPlatformSurfaces()
  resetSessionMemory()
  resetPlatformAnalytics()
  hex.user = null
  hex.redirectToSignIn.mockClear()
  hex.signOut.mockClear()
  registerRoute('landing', async () => ({ default: () => <p>Landing</p> }))
})

afterEach(() => {
  cleanup()
})

describe('signed out', () => {
  it('says the work is local, not that the door is locked', async () => {
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')

    const note = await screen.findByRole('note')
    expect(note.getAttribute('aria-label')).toBe('Local only. Sign in to save to the cloud')
    expect(note.textContent).toMatch(/Sign in to save to the cloud/)
  })

  it('offers keyboard-reachable, labelled sign-in and sign-up carrying a return-to', async () => {
    goTo('/gallery')
    render(<AppShell />)
    await screen.findByRole('heading', { name: /not installed in this build/i })

    const signIn = screen.getByRole('link', { name: 'Sign in' })
    const signUp = screen.getByRole('link', { name: 'Create account' })
    expect(signIn.getAttribute('href')).toBe('/auth/sign-in?return_to=%2Fgallery')
    expect(signUp.getAttribute('href')).toBe('/auth/sign-up?return_to=%2Fgallery')
    signIn.focus()
    expect(document.activeElement).toBe(signIn)
  })
})

describe('the signed-in account menu', () => {
  beforeEach(() => {
    hex.user = signedIn()
  })

  it('is a labelled dialog that traps focus and restores it on close', async () => {
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')

    const trigger = await screen.findByRole('button', { name: /Ada Lovelace/ })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'Account' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id)

    // Focus lands on the first control inside the dialog.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('a, button'))
    expect(controls.length).toBeGreaterThan(2)
    const first = controls[0]!
    const last = controls[controls.length - 1]!

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('reaches account settings and cloud projects by name', async () => {
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    const settings = await screen.findByRole('link', { name: 'Account settings' })
    expect(settings.getAttribute('href')).toBe('/account')
    expect(screen.getByRole('link', { name: 'Your cloud projects' }).getAttribute('href')).toBe('/projects')
  })

  it('signs out through the SDK and remembers that it was deliberate', async () => {
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(hex.signOut).toHaveBeenCalledTimes(1))
    expect(drainPlatformAnalytics().map((entry) => entry.event.name)).toContain('auth.signed_out')
  })

  it('marks the operator identity so session replay cannot record it', async () => {
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')
    const trigger = await screen.findByRole('button', { name: /Ada Lovelace/ })
    expect(trigger.querySelector('.pf-private')?.textContent).toBe('Ada Lovelace')
  })
})

describe('a guarded surface', () => {
  it('redirects with a return-to and explains itself while it does', async () => {
    goTo('/projects')
    render(<AppShell />)

    const heading = await screen.findByRole('heading', { name: /needs an account/i })
    const panel = heading.closest('section')!
    await waitFor(() => expect(hex.redirectToSignIn).toHaveBeenCalledTimes(1))
    // Scoped to the panel: the frame carries its own "Sign in" control, and
    // both are correct — this asserts the one the guard put there.
    expect(within(panel).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/auth/sign-in?return_to=%2Fprojects',
    )
    expect(panel.textContent).toMatch(/editor does not need this/i)
  })

  it('lets a signed-in operator straight through', async () => {
    hex.user = signedIn()
    registerRoute('projects', async () => ({ default: () => <p>Your projects</p> }))
    goTo('/projects')
    render(<AppShell />)
    expect(await screen.findByText('Your projects')).not.toBeNull()
    expect(hex.redirectToSignIn).not.toHaveBeenCalled()
  })

  it('tells an expired session apart from a fresh one', async () => {
    hex.user = signedIn()
    registerRoute('projects', async () => ({ default: () => <p>Your projects</p> }))
    goTo('/projects')
    const view = render(<AppShell />)
    await screen.findByText('Your projects')

    hex.user = null
    view.rerender(<AppShell />)

    const heading = await screen.findByRole('heading', { name: /your sign-in has expired/i })
    expect(heading.closest('section')?.textContent).toMatch(/Nothing was lost/)
    expect(screen.getByRole('button', { name: /sign in again/i })).not.toBeNull()
    expect(screen.getByRole('link', { name: /keep working locally/i }).getAttribute('href')).toBe('/editor')
  })

  it('does not accuse the network when the operator signed out on purpose', async () => {
    hex.user = signedIn()
    goTo('/')
    const view = render(<AppShell />)
    await screen.findByText('Landing')
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    hex.user = null
    view.rerender(<AppShell />)
    const note = await screen.findByRole('note')
    expect(note.getAttribute('aria-label')).toMatch(/^Local only/)
  })
})

describe('a restricted user', () => {
  it('is told what to do about it, and is not treated as signed out', async () => {
    hex.user = signedIn({ isRestricted: true, restrictedReason: { type: 'email_not_verified' } })
    registerRoute('projects', async () => ({ default: () => <p>Your projects</p> }))
    goTo('/projects')
    render(<AppShell />)

    const heading = await screen.findByRole('heading', { name: /verify your email address/i })
    expect(heading.closest('section')?.getAttribute('role')).toBe('status')
    expect(screen.getByRole('link', { name: /open account settings/i }).getAttribute('href')).toBe('/account')
    expect(screen.queryByText('Your projects')).toBeNull()
    expect(drainPlatformAnalytics().map((entry) => entry.event)).toContainEqual({
      name: 'auth.restricted',
      restriction: 'email_not_verified',
    })
  })

  it('surfaces an administrator restriction with the reason the operator may see', async () => {
    hex.user = signedIn({
      isRestricted: true,
      restrictedReason: { type: 'restricted_by_administrator' },
      restrictedByAdminReason: 'Pending manual review',
    })
    registerRoute('projects', async () => ({ default: () => <p>Your projects</p> }))
    goTo('/projects')
    render(<AppShell />)

    await screen.findByRole('heading', { name: /administrator has restricted/i })
    expect(screen.getByText('Pending manual review')).not.toBeNull()
  })

  it('is still let into account settings, which is where the fix lives', async () => {
    hex.user = signedIn({ isRestricted: true, restrictedReason: { type: 'email_not_verified' } })
    goTo('/account')
    render(<AppShell />)

    expect(await screen.findByTestId('hexclave-account-settings')).not.toBeNull()
    expect(screen.getByRole('heading', { name: /verify your email address/i })).not.toBeNull()
  })
})

describe('hosted sign-in and sign-up', () => {
  it('renders the real Hexclave auth component on Brickwright routes', async () => {
    goTo('/auth/sign-in')
    render(<AppShell />)
    expect((await screen.findByTestId('hexclave-auth-page')).textContent).toBe('sign-in')
    expect(screen.getByRole('heading', { name: /sign in to brickwright/i })).not.toBeNull()

    cleanup()
    goTo('/auth/sign-up')
    render(<AppShell />)
    expect((await screen.findByTestId('hexclave-auth-page')).textContent).toBe('sign-up')
  })

  it('offers a way past the account entirely', async () => {
    goTo('/auth/sign-in')
    render(<AppShell />)
    await screen.findByTestId('hexclave-auth-page')
    expect(screen.getByRole('link', { name: /continue without an account/i }).getAttribute('href')).toBe('/editor')
  })

  it('sends a signed-in operator on to where they were going', async () => {
    hex.user = signedIn()
    registerRoute('projects', async () => ({ default: () => <p>Your projects</p> }))
    goTo('/auth/sign-in?return_to=%2Fprojects')
    render(<AppShell />)
    expect(await screen.findByText('Your projects')).not.toBeNull()
  })

  it('refuses an off-site return-to, which would be an account takeover', () => {
    expect(safeReturnTo('/projects', '/')).toBe('/projects')
    expect(safeReturnTo('//evil.example/steal', '/')).toBe('/')
    expect(safeReturnTo('https://evil.example', '/')).toBe('/')
    expect(safeReturnTo(null, '/gallery')).toBe('/gallery')
  })

  it('says so when asked for an auth page it does not host', async () => {
    goTo('/auth/password-reset')
    render(<AppShell />)
    expect(
      await screen.findByRole('heading', { name: /does not host that authentication page/i }),
    ).not.toBeNull()
  })
})

describe('account settings', () => {
  it('mounts the real Hexclave settings surface under a single page heading', async () => {
    hex.user = signedIn()
    goTo('/account')
    render(<AppShell />)

    expect(await screen.findByTestId('hexclave-account-settings')).not.toBeNull()
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]!.textContent).toBe('Your Brickwright account')
  })

  it('sends a signed-out visitor to sign in with a return-to', async () => {
    goTo('/account')
    render(<AppShell />)
    const heading = await screen.findByRole('heading', { name: /needs an account/i })
    const panel = heading.closest('section')!
    expect(within(panel).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/auth/sign-in?return_to=%2Faccount',
    )
  })
})
