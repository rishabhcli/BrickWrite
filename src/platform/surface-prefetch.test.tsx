import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate: the surface's own bundle downloads *beside* the boot, not after it.
 *
 * `lazy()` runs its factory when the lazy element first renders, and the shell
 * only renders the surface once the boot gate resolves. That put the editor's
 * whole bundle — the workbench, Three.js, the renderer, about 400 KiB gzip —
 * behind the catalog fetch, the session restore and the geometry warm, though
 * nothing about them is ordered. Two independent network waits ran in series
 * for no reason other than where `lazy` happened to be called.
 *
 * The prefetch is not unconditional, and the second test is why: `cad/engine`
 * builds the showcase document at module scope and throws without the compiled
 * pack, so the surface may download only once the parts tier is resident.
 * Ordering is asserted by holding each phase open, so a pass cannot come from
 * a fast machine winning a race.
 */

const gate = vi.hoisted(() => ({
  order: [] as string[],
  releaseCatalog: null as null | (() => void),
  releaseSession: null as null | (() => void),
}))

vi.mock('../cad/catalog-loader', () => ({
  loadCompiledCatalog: vi.fn(() => {
    gate.order.push('catalog:start')
    return new Promise((resolve) => {
      gate.releaseCatalog = () => {
        gate.order.push('catalog:done')
        resolve({
          version: 'test',
          identityCount: 22941,
          placeableCount: 900,
          colorCount: 322,
          connectorCount: 324331,
          aliasCount: 1150,
          externalIdentityCount: 58833,
        })
      }
    })
  }),
  preloadDocumentGeometry: vi.fn(async () => {
    gate.order.push('geometry')
  }),
}))

vi.mock('../cad/engine', () => ({
  cadEngine: { getDocument: () => ({ parts: {} }) },
}))

vi.mock('../cad/session', () => ({
  session: {
    start: vi.fn(() => {
      gate.order.push('session:start')
      return new Promise<void>((resolve) => {
        gate.releaseSession = () => {
          gate.order.push('session:done')
          resolve()
        }
      })
    }),
    openProject: vi.fn(),
    createProject: vi.fn(),
  },
}))

const { AppShell, installPlatformSurfaces } = await import('./AppShell')
const { registerRoute, resetRouteRegistry } = await import('./routes')
const { resetBoot } = await import('./boot')

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Drain everything already resolvable, leaving only the held phases pending. */
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await turn()
}

/**
 * Turn until `mark` has been recorded, or give up loudly.
 *
 * Every assertion here is about *order*, never about elapsed time, so waiting
 * on the mark rather than on a turn count is what keeps a loaded machine from
 * reporting a scheduling delay as a regression. The deadline is generous for
 * the same reason: it exists to produce a readable failure, not to measure
 * anything.
 */
const until = async (mark: string) => {
  const deadline = Date.now() + 10_000
  while (!gate.order.includes(mark) && Date.now() < deadline) await turn()
  if (!gate.order.includes(mark)) throw new Error(`"${mark}" never happened; order was ${gate.order.join(' → ')}`)
}

beforeEach(() => {
  resetBoot()
  resetRouteRegistry()
  installPlatformSurfaces()
  gate.order = []
  gate.releaseCatalog = null
  gate.releaseSession = null
  window.history.pushState({}, '', '/editor')
})

afterEach(() => {
  cleanup()
})

describe('surface prefetch', () => {
  it('downloads the editor surface while the session is still being restored', async () => {
    registerRoute('editor', async () => {
      gate.order.push('surface')
      return { default: () => <p>Cockpit</p> }
    })

    render(<AppShell />)
    await settle()
    gate.releaseCatalog!()
    await settle()

    // The session restore is still open here, and the surface has already been
    // fetched: the two waits overlap instead of queueing.
    expect(gate.order).toContain('session:start')
    expect(gate.order).not.toContain('session:done')
    expect(
      gate.order.indexOf('surface'),
      `surface still waiting on the boot; order was ${gate.order.join(' → ')}`,
    ).toBeGreaterThan(-1)

    gate.releaseSession!()
    await settle()
    await screen.findByText('Cockpit', undefined, { timeout: 10_000 })
    // Stated as an ordering too, so the guarantee survives a reader who does
    // not follow why the assertions above are taken mid-flight.
    expect(gate.order.indexOf('surface')).toBeLessThan(gate.order.indexOf('session:done'))
    expect(gate.order.indexOf('surface')).toBeLessThan(gate.order.indexOf('geometry'))
  }, 30_000)

  it('never evaluates a kernel-importing surface before the parts tier is resident', async () => {
    registerRoute('editor', async () => {
      gate.order.push('surface')
      return { default: () => <p>Cockpit</p> }
    })

    render(<AppShell />)
    await until('catalog:start')
    await settle()

    // The compiled pack has not landed, so nothing may have imported a module
    // that reads it at evaluation time.
    expect(gate.order).toEqual(['catalog:start'])

    gate.releaseCatalog!()
    await until('surface')
    expect(gate.order.indexOf('catalog:done')).toBeLessThan(gate.order.indexOf('surface'))

    gate.releaseSession!()
    await screen.findByText('Cockpit', undefined, { timeout: 10_000 })
  }, 30_000)

  it('starts a "none" surface immediately, with no catalog at all', async () => {
    registerRoute('landing', async () => {
      gate.order.push('surface')
      return { default: () => <p>Build real LEGO models in the browser</p> }
    })
    window.history.pushState({}, '', '/')

    render(<AppShell />)
    await screen.findByText('Build real LEGO models in the browser', undefined, { timeout: 10_000 })
    // Nothing but the surface: a `boot: 'none'` route waits for no tier, so it
    // must not have asked for one. (`AccountGate` swapping in the real Hexclave
    // layer remounts the subtree, which can fetch the surface twice; that is a
    // module-registry hit in a real build, and not what this asserts.)
    expect(new Set(gate.order)).toEqual(new Set(['surface']))
  }, 30_000)
})
