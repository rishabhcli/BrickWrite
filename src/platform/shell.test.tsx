import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The shell's honest states.
 *
 * Hexclave is genuinely unconfigured in this process — no project ID is
 * injected into a unit-test run — so these tests exercise the real degraded
 * path rather than a simulation of it. That is also the path the browser smoke
 * harness and `vite preview` take.
 */

const cad = vi.hoisted(() => ({
  mode: 'resolve' as 'resolve' | 'reject' | 'defer',
  release: null as null | (() => void),
}))

vi.mock('../cad/catalog-loader', () => ({
  loadCompiledCatalog: async () => {
    if (cad.mode === 'reject') throw new Error('catalog/latest.json → 404 Not Found')
    if (cad.mode === 'defer') await new Promise<void>((resolve) => (cad.release = resolve))
    return {
      version: 'test',
      identityCount: 2,
      placeableCount: 2,
      colorCount: 1,
      connectorCount: 2,
      aliasCount: 0,
      externalIdentityCount: 0,
    }
  },
  preloadDocumentGeometry: async () => {},
}))

vi.mock('../cad/engine', () => ({ cadEngine: { getDocument: () => ({ parts: {} }) } }))
vi.mock('../cad/session', () => ({ session: { start: async () => {} } }))

const { AppShell, installPlatformSurfaces, resetRouteAnnouncement } = await import('./AppShell')
const { registerRoute, resetRouteRegistry } = await import('./routes')
const { resetBoot } = await import('./boot')
const { resetPlatformAnalytics } = await import('./analytics')

function goTo(path: string) {
  window.history.pushState({}, '', path)
}

beforeEach(() => {
  resetBoot()
  resetRouteRegistry()
  resetRouteAnnouncement()
  installPlatformSurfaces()
  resetPlatformAnalytics()
  cad.mode = 'resolve'
  cad.release = null
})

afterEach(() => {
  cleanup()
})

describe('surface not installed', () => {
  it('renders an honest, labelled state instead of crashing', async () => {
    goTo('/gallery')
    render(<AppShell />)

    const heading = await screen.findByRole(
      'heading',
      { name: /the "gallery" surface is not installed in this build/i },
      { timeout: 5_000 },
    )
    expect(heading).not.toBeNull()
    const panel = heading.closest('section')
    expect(panel?.getAttribute('role')).toBe('status')
    expect(panel?.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(screen.getByRole('link', { name: /back to the start/i })).not.toBeNull()
  })

  it('still renders the persistent frame around it', async () => {
    goTo('/gallery')
    render(<AppShell />)
    await screen.findByRole('heading', { name: /not installed in this build/i })
    expect(document.querySelector('.pf-topbar')).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Primary' })).not.toBeNull()
  })
})

describe('unknown address', () => {
  it('says so rather than rendering nothing', async () => {
    goTo('/nowhere-at-all')
    render(<AppShell />)
    expect(await screen.findByRole('heading', { name: /has no page at this address/i })).not.toBeNull()
  })
})

describe('offline', () => {
  it('announces the degradation without blocking local work', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    registerRoute('landing', async () => ({ default: () => <p>Landing</p> }))
    goTo('/')
    render(<AppShell />)

    await screen.findByText('Landing')
    const offline = document.querySelector('.pf-offline')
    expect(offline).not.toBeNull()
    expect(offline?.getAttribute('role')).toBe('status')
    expect(offline?.getAttribute('aria-live')).toBe('polite')
    expect(offline?.textContent).toMatch(/Local editing continues/)
    onLine.mockRestore()
  })

  it('shows nothing when the browser is online', async () => {
    registerRoute('landing', async () => ({ default: () => <p>Landing</p> }))
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')
    expect(document.querySelector('.pf-offline')).toBeNull()
  })
})

describe('loading', () => {
  it('announces a boot in progress with a busy, labelled region', async () => {
    cad.mode = 'defer'
    registerRoute('explore', async () => ({ default: () => <p>Explore</p> }))
    goTo('/explore')
    render(<AppShell />)

    const busy = await screen.findByRole('status')
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(busy.textContent).toMatch(/Loading the compiled catalog/)

    cad.release?.()
    await screen.findByText('Explore')
  })
})

describe('boot failure', () => {
  it('refuses to invent parts, explains why, and offers a real retry', async () => {
    cad.mode = 'reject'
    registerRoute('explore', async () => ({ default: () => <p>Explore</p> }))
    goTo('/explore')
    render(<AppShell />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/cannot start without its compiled catalog/)
    expect(alert.textContent).toMatch(/404 Not Found/)
    expect(alert.textContent).toMatch(/deliberately has no stand-in parts/)

    cad.mode = 'resolve'
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    await screen.findByText('Explore')
  })
})

describe('accounts unavailable', () => {
  it('reports a missing project id as a notice, naming every variable it checked', async () => {
    goTo('/account')
    render(<AppShell />)

    const heading = await screen.findByRole('heading', { name: /no hexclave project configured/i })
    expect(heading).not.toBeNull()
    const panel = heading.closest('section')
    expect(panel?.getAttribute('role')).toBe('status')
    expect(panel?.textContent).toMatch(/Local CAD work is unaffected/)
    expect(panel?.textContent).toMatch(/VITE_HEXCLAVE_PROJECT_ID/)
  })

  it('still offers the local-only account affordance in the frame', async () => {
    registerRoute('landing', async () => ({ default: () => <p>Landing</p> }))
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')

    const note = await screen.findByRole('note')
    expect(note.getAttribute('aria-label')).toMatch(/Local only/)
    expect(note.textContent).toMatch(/no account layer configured/i)
  })
})

describe('signed-out editing', () => {
  function Cockpit() {
    const [parts, setParts] = useState(0)
    return (
      <div>
        <h1>Brickwright editor</h1>
        <p>Parts placed: {parts}</p>
        <button type="button" onClick={() => setParts((value) => value + 1)}>
          Place brick
        </button>
      </div>
    )
  }

  it('boots the editor and keeps it fully usable with no Hexclave user', async () => {
    registerRoute('editor', async () => ({ default: Cockpit }))
    goTo('/editor')
    render(<AppShell />)

    await screen.findByRole('heading', { name: 'Brickwright editor' })
    expect(screen.queryByText(/sign in required/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: /needs an account/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Place brick' }))
    fireEvent.click(screen.getByRole('button', { name: 'Place brick' }))
    await waitFor(() => expect(screen.getByText('Parts placed: 2')).not.toBeNull())
  })

  it('gives the editor the whole viewport, with no application frame above it', async () => {
    registerRoute('editor', async () => ({ default: Cockpit }))
    goTo('/editor')
    render(<AppShell />)

    await screen.findByRole('heading', { name: 'Brickwright editor' })
    expect(document.querySelector('.pf-topbar')).toBeNull()
    expect(document.querySelector('.pf-frame')).toBeNull()
  })
})

describe('telemetry emitted by the shell', () => {
  it('reports the route and its declared boot level, and nothing else', async () => {
    const sink = vi.fn()
    const { setPlatformAnalyticsSink } = await import('./analytics')
    setPlatformAnalyticsSink(sink)

    registerRoute('landing', async () => ({ default: () => <p>Landing</p> }))
    goTo('/')
    render(<AppShell />)
    await screen.findByText('Landing')

    const events = sink.mock.calls.map(([recorded]) => recorded.event)
    expect(events).toContainEqual({ name: 'route.viewed', route: 'landing', boot: 'none' })
    for (const event of events) {
      for (const value of Object.values(event)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true)
      }
    }
    setPlatformAnalyticsSink(null)
  })

  it('records an unregistered route as a named event rather than an error', async () => {
    const sink = vi.fn()
    const { setPlatformAnalyticsSink } = await import('./analytics')
    setPlatformAnalyticsSink(sink)

    goTo('/gallery')
    render(<AppShell />)
    await screen.findByRole('heading', { name: /not installed in this build/i })

    const events = sink.mock.calls.map(([recorded]) => recorded.event)
    expect(events).toContainEqual({ name: 'route.not_installed', route: 'gallery' })
    setPlatformAnalyticsSink(null)
  })
})
