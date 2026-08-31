import { describe, expect, it } from 'vitest'

/**
 * The suite must not be able to read the developer's environment.
 *
 * Six cloud tests assert the *unconfigured* path — the honest local-only mode a
 * visitor with no deployment gets — and they can only do that if the harness has
 * no deployment either. With a real `.env.local`, three of them failed; so the
 * tests most likely to break belonged to whoever was actually working on the
 * cloud path, and CI never saw it.
 *
 * Two mechanisms were needed and neither is obvious, which is why this exists
 * rather than a comment. `vite.config.ts` points `envDir` at a directory holding
 * no `.env` files while `VITEST` is set — and that alone was not enough, because
 * Vite also exposes any *shell* variable matching `envPrefix`. It additionally
 * deletes every `VITE_*` key from `process.env`. Both were verified by running
 * the cloud suite with a shell export and a real `.env.local` in place.
 *
 * `test.env` cannot substitute: it reaches `process.env` only, and `vi.stubEnv`
 * reaches neither. Injection goes through a constructor argument —
 * `createConvexCloud({ url })` — which is how the configured-path tests work.
 */
describe('the test environment', () => {
  it('exposes no VITE_ variable through import.meta.env', () => {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
    const leaked = Object.keys(env).filter((key) => key.startsWith('VITE_') && env[key])
    expect(
      leaked,
      `These reached the suite from a .env file or the shell: ${leaked.join(', ')}. ` +
        'The cloud suite asserts the unconfigured path and cannot do that against a real deployment.',
    ).toEqual([])
  })

  it('exposes no VITE_ variable through process.env either', () => {
    const leaked = Object.keys(process.env).filter((key) => key.startsWith('VITE_') && process.env[key])
    expect(leaked).toEqual([])
  })

  it('reports the cloud as unconfigured, which is what the six tests rest on', async () => {
    const { convexUrlFromEnv } = await import('../cloud/convexClient')
    expect(convexUrlFromEnv()).toBeNull()
  })
})
