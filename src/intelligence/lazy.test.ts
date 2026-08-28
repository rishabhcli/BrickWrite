import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './parts/__fixtures__/real-catalog'

/**
 * The four-megabyte latent index must not be a tax on importing this module.
 *
 * A marketing route that happens to pull in the part API, or an editor session
 * that only ever looks parts up by number, should never pay for the semantic
 * index. This runs in its own file because it is a statement about module
 * state at import time, which no other test may have already disturbed.
 */

let disk: DiskFetch

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
}, 120_000)

afterAll(() => disk.restore())

const semanticRequests = () => disk.requests.filter((path) => path.includes('semantic-index'))

describe('lazy loading', () => {
  it('reads nothing until a semantic query runs', async () => {
    const intelligence = await import('./index')
    expect(disk.requests, 'importing the entry point fetched something').toHaveLength(0)

    // Warming the symbolic indexes fetches the catalog payload it is built
    // from, and still not the latent index.
    await intelligence.warmPartIntelligence()
    expect(disk.requests.length).toBeGreaterThan(0)
    expect(semanticRequests()).toHaveLength(0)
    expect(intelligence.residentSemanticIndex()).toBeNull()

    // A resolve that explicitly opts out stays on the symbolic path.
    const symbolic = await intelligence.resolvePartIntent('brick 2 x 4', { limit: 3, semantic: false })
    expect(symbolic.matches[0].canonicalId).toBe('3001')
    expect(semanticRequests()).toHaveLength(0)

    // The first semantic query is what pays for it.
    const semantic = await intelligence.resolvePartIntent('something smooth to finish a wall', { limit: 3 })
    expect(semantic.matches.length).toBeGreaterThan(0)
    expect(semanticRequests().length).toBeGreaterThan(0)
    expect(intelligence.residentSemanticIndex()).not.toBeNull()

    // And it is paid once: the second query reuses the decoded index.
    const before = semanticRequests().length
    await intelligence.resolvePartIntent('a curved slope', { limit: 3 })
    expect(semanticRequests()).toHaveLength(before)
  }, 120_000)
})
