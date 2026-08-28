/**
 * @vitest-environment node
 *
 * Runs outside jsdom on purpose: the module under test refuses to evaluate when
 * `window` exists, which is itself asserted from the browser side in
 * `src/platform/emails.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'

const { getEmailTransport, resetEmailTransport, sendPlatformEmail } = await import('./emails.server')

afterEach(() => {
  resetEmailTransport()
  delete process.env.HEXCLAVE_PROJECT_ID
  delete process.env.HEXCLAVE_SECRET_SERVER_KEY
})

describe('server email transport', () => {
  it('reports itself unavailable rather than throwing when the key is absent', () => {
    const transport = getEmailTransport()
    expect(transport.status).toBe('unavailable')
    if (transport.status !== 'unavailable') throw new Error('unreachable')
    expect(transport.reason).toMatch(/HEXCLAVE_SECRET_SERVER_KEY/)
  })

  it('treats a blank key as absent', () => {
    process.env.HEXCLAVE_PROJECT_ID = 'proj'
    process.env.HEXCLAVE_SECRET_SERVER_KEY = '   '
    expect(getEmailTransport().status).toBe('unavailable')
  })

  it('refuses to send, and says why, when there is no transport', async () => {
    const result = await sendPlatformEmail({
      email: {
        kind: 'publication-notification',
        projectName: 'Docks',
        shareUrl: 'https://example.test/s/1',
        change: 'published',
      },
      recipients: { userIds: ['user-1'] },
    })
    expect(result.status).toBe('unavailable')
  })

  it('memoises the transport so browser side effects are never installed twice', () => {
    expect(getEmailTransport()).toBe(getEmailTransport())
  })
})
