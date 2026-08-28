import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate: a marketing route must not download the CAD kernel.
 *
 * Asserted by module evaluation, not by inspection. Each mock factory records
 * the moment it is first evaluated, which happens only when something actually
 * imports the module, so an empty record is proof that nothing did.
 *
 * The two tests run in declaration order in a single isolated file: the landing
 * assertion first, while the record is genuinely untouched, then the editor
 * assertion, which proves the recorder works and is not vacuously passing.
 */

const cad = vi.hoisted(() => ({ imported: [] as string[] }))

vi.mock('../cad/catalog-loader', () => {
  cad.imported.push('cad/catalog-loader')
  return {
    loadCompiledCatalog: async () => ({
      version: 'test',
      identityCount: 2,
      placeableCount: 2,
      colorCount: 1,
      connectorCount: 2,
      aliasCount: 0,
      externalIdentityCount: 0,
    }),
    preloadDocumentGeometry: async () => {},
  }
})

vi.mock('../cad/engine', () => {
  cad.imported.push('cad/engine')
  return { cadEngine: { getDocument: () => ({ parts: {} }) } }
})

vi.mock('../cad/session', () => {
  cad.imported.push('cad/session')
  return { session: { start: async () => {} } }
})

vi.mock('three', () => {
  cad.imported.push('three')
  return {}
})

vi.mock('@react-three/fiber', () => {
  cad.imported.push('@react-three/fiber')
  return {}
})

const { AppShell } = await import('./AppShell')
const { registerRoute, resetRouteRegistry } = await import('./routes')
const { resetBoot } = await import('./boot')
const { installPlatformSurfaces } = await import('./AppShell')

function goTo(path: string) {
  window.history.pushState({}, '', path)
}

beforeEach(() => {
  resetBoot()
  resetRouteRegistry()
  installPlatformSurfaces()
})

afterEach(() => {
  cleanup()
})

describe('route-aware boot', () => {
  it('renders the landing route without importing the catalog, the kernel, the session or Three.js', async () => {
    registerRoute('landing', async () => ({
      default: () => <p>Build real LEGO models in the browser</p>,
    }))
    goTo('/')
    render(<AppShell />)

    await screen.findByText('Build real LEGO models in the browser')
    expect(cad.imported, `landing pulled in: ${cad.imported.join(', ')}`).toEqual([])
  })

  it('proves the recorder works: the editor route does import all of them', async () => {
    registerRoute('editor', async () => ({ default: () => <p>Cockpit</p> }))
    goTo('/editor')
    render(<AppShell />)

    await screen.findByText('Cockpit')
    expect(cad.imported).toContain('cad/catalog-loader')
    expect(cad.imported).toContain('cad/engine')
    expect(cad.imported).toContain('cad/session')
  })
})
