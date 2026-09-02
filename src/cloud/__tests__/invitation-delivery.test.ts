// @vitest-environment edge-runtime
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendInvitationEmail, INVITATION_DELIVERY_TIMEOUT_MS } from '../../../convex/model/invitationDelivery'

const args = () => ({
  endpoint: 'https://mail.example.test/send',
  credential: 'private-credential',
  origin: 'https://brickwrite.example.test',
  invitationId: 'invite_123',
  generation: 0,
  email: 'builder@example.test',
  token: 'private-invitation-token',
  role: 'editor',
  projectName: 'Private project',
  expiresAt: Date.UTC(2026, 8, 5, 14, 32, 0),
})

describe('native Hexclave invitation delivery', () => {
  const nativeArgs = () => ({
    ...args(),
    endpoint: undefined,
    credential: undefined,
    hexclaveProjectId: 'hexclave-fixture-project',
    hexclaveSecretServerKey: 'hexclave-server-secret',
  })

  it('sends escaped transactional email to a new address without creating a user', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const result = await sendInvitationEmail({ ...nativeArgs(), projectName: '<img src=x onerror="bad()"> & friends' })
    expect(result).toMatchObject({ status: 'queued' })
    expect(result.reason).toContain('Hexclave accepted')
    expect(result.reason).toContain('Inbox delivery is not confirmed')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.hexclave.com/api/v1/emails/send-email')
    expect(options.headers).toMatchObject({
      'x-hexclave-project-id': 'hexclave-fixture-project',
      'x-hexclave-access-type': 'server',
      'x-hexclave-secret-server-key': 'hexclave-server-secret',
    })
    expect(options.headers.authorization).toBeUndefined()
    expect(options.redirect).toBe('manual')
    const body = JSON.parse(options.body)
    expect(body.emails).toEqual(['builder@example.test'])
    expect(body.user_ids).toBeUndefined()
    expect(body.all_users).toBeUndefined()
    expect(body.theme_id).toBe(false)
    expect(body.html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; friends')
    expect(body.html).not.toContain('<img')
    expect(body.html).toContain('https://brickwrite.example.test/invite/private-invitation-token')
    expect(JSON.stringify(result)).not.toMatch(/hexclave-server-secret|private-invitation-token/)
  })

  it.each([
    { hexclaveProjectId: '' },
    { hexclaveSecretServerKey: '' },
    { hexclaveApiOrigin: 'http://remote.example.test' },
    { hexclaveApiOrigin: 'https://secret@api.hexclave.com' },
    { hexclaveApiOrigin: 'https://api.hexclave.com/api/v1' },
  ])('refuses invalid native configuration %j without a request', async (update) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await sendInvitationEmail({ ...nativeArgs(), ...update })).toMatchObject({ status: 'not-configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('supports a configured local Hexclave server origin', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await sendInvitationEmail({ ...nativeArgs(), hexclaveApiOrigin: 'http://localhost:8102' })).toMatchObject({
      status: 'queued',
    })
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:8102/api/v1/emails/send-email')
  })

  it.each([
    { 'x-hexclave-actual-status': '403' },
    { 'x-stack-actual-status': '503' },
    { 'x-hexclave-actual-status': 'malformed' },
    { 'x-hexclave-known-error': 'secret-provider-detail' },
    { 'x-stack-known-error': 'secret-provider-detail' },
  ])('does not mistake wrapped errors for email acceptance: %j', async (headers) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('secret response body', { status: 200, headers }))
    vi.stubGlobal('fetch', fetcher)
    const result = await sendInvitationEmail(nativeArgs())
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never falls back between a custom adapter and Hexclave on failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await sendInvitationEmail({ ...nativeArgs(), endpoint: args().endpoint, credential: args().credential }),
    ).toMatchObject({ status: 'failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(args().endpoint)
    expect(fetcher.mock.calls[0][1].headers['x-hexclave-secret-server-key']).toBeUndefined()
  })

  it('does not silently use Hexclave when a custom adapter is only partially configured', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await sendInvitationEmail({ ...nativeArgs(), endpoint: args().endpoint })).toMatchObject({
      status: 'not-configured',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds native submission without SDK retries', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const pending = sendInvitationEmail(nativeArgs())
    await vi.advanceTimersByTimeAsync(INVITATION_DELIVERY_TIMEOUT_MS)
    expect(await pending).toMatchObject({ status: 'failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('invitation email submission', () => {
  it.each([
    { endpoint: undefined },
    { credential: '' },
    { origin: undefined },
    { endpoint: 'http://mail.example.test/send' },
    { endpoint: 'https://user:password@mail.example.test/send' },
    { origin: 'https://brickwrite.example.test/elsewhere' },
    { origin: 'https://brickwrite.example.test/?token=secret' },
    { origin: 'https://user:password@brickwrite.example.test' },
    { origin: 'javascript:alert(1)' },
  ])('refuses missing or unsafe configuration %j without making a request', async (update) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await sendInvitationEmail({ ...args(), ...update })).toMatchObject({ status: 'not-configured' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allows loopback development endpoints without weakening remote HTTPS requirements', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await sendInvitationEmail({ ...args(), endpoint: 'http://127.0.0.1:9090/send', origin: 'http://localhost:4173' }),
    ).toMatchObject({ status: 'queued' })
    expect(JSON.parse(fetcher.mock.calls[0][1].body).invitationUrl).toBe(
      'http://localhost:4173/invite/private-invitation-token',
    )
  })

  it.each([301, 307, 400, 401, 429, 500, 503])(
    'reports HTTP %i without echoing response bodies or automatically retrying',
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(new Response('secret response token', { status }))
      vi.stubGlobal('fetch', fetcher)
      const result = await sendInvitationEmail(args())
      expect(result.status).toBe('failed')
      expect(result.reason).toContain(`HTTP ${status}`)
      expect(result.reason).not.toContain('secret response token')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls[0][1].redirect).toBe('manual')
    },
  )

  it('redacts network exceptions rather than storing credentials, tokens or addresses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('private-credential private-invitation-token builder@example.test')),
    )
    const result = await sendInvitationEmail(args())
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toMatch(/private-credential|private-invitation-token|builder@example.test/)
  })

  it('bounds a stalled provider request even if the transport ignores cancellation', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetcher)
    const pending = sendInvitationEmail(args())
    await vi.advanceTimersByTimeAsync(INVITATION_DELIVERY_TIMEOUT_MS)
    expect(await pending).toMatchObject({ status: 'failed' })
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('when the link stops working', () => {
  /**
   * The message used to say "expires 14 days after the invitation was created"
   * against a seventy-two hour lifetime. A recipient reading it on day five
   * found a dead link and no explanation, and the owner found out by being
   * asked to send another.
   */
  const bodyOf = (fetcher: ReturnType<typeof vi.fn>) =>
    JSON.parse(String((fetcher.mock.calls[0][1] as { body: string }).body)) as { html?: string; expiresAt?: string }

  it('states the invitation’s own expiry, in UTC', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await sendInvitationEmail({
        ...args(),
        endpoint: undefined,
        credential: undefined,
        hexclaveProjectId: 'p',
        hexclaveSecretServerKey: 's',
      }),
    ).toMatchObject({ status: 'queued' })

    const { html } = bodyOf(fetcher)
    expect(html).toContain('2026-09-05 14:32 UTC')
    // The duration it used to restate, and got wrong.
    expect(html).not.toContain('14 days')
  })

  it('hands a custom adapter the same fact rather than making it guess', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await sendInvitationEmail(args())).toMatchObject({ status: 'queued' })
    expect(bodyOf(fetcher).expiresAt).toBe(new Date(Date.UTC(2026, 8, 5, 14, 32, 0)).toISOString())
  })

  it('still sends when the expiry is unusable, without claiming a date', async () => {
    // `new Date(NaN).toISOString()` throws, and a malformed row is not a reason
    // to drop an invitation somebody asked to send.
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    expect(
      await sendInvitationEmail({
        ...args(),
        endpoint: undefined,
        credential: undefined,
        hexclaveProjectId: 'p',
        hexclaveSecretServerKey: 's',
        expiresAt: Number.NaN,
      }),
    ).toMatchObject({ status: 'queued' })
    expect(bodyOf(fetcher).html).toContain('This private link expires')
  })
})
