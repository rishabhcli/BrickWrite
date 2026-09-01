import { describe, expect, it } from 'vitest'

/**
 * `zod-jitless` reaches for an internal of zod's: the global object zod uses to
 * hold its configuration. That is a deliberate trade — it is the only way to
 * answer the JIT probe both before the first schema is built and without
 * pulling zod into the landing entry — but an internal can be renamed, and the
 * only symptom would be a Content-Security-Policy violation quietly returning
 * to production.
 *
 * So this asserts the coupling holds against the installed zod rather than
 * against a copy of what it used to do.
 */
describe('zod jitless', () => {
  it('is honoured by the zod that is actually installed', async () => {
    await import('./zod-jitless')
    const { config } = await import('zod')
    expect(config().jitless).toBe(true)
  })

  it('leaves the JIT off once a schema is built', async () => {
    await import('./zod-jitless')
    const { z } = await import('zod')
    // Building and parsing an object schema is what reads the probe.
    const schema = z.object({ id: z.string(), n: z.number() })
    expect(schema.parse({ id: 'a', n: 1 })).toEqual({ id: 'a', n: 1 })
    expect(config_jitless()).toBe(true)
    function config_jitless() {
      return (globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig?.jitless
    }
  })
})
