import { describe, expect, it, vi } from 'vitest'
import { logEdgeFailure, redactEdgeText } from './log'

/**
 * What must not reach Cloudflare's log drain.
 *
 * Two kinds of secret arrive here by different routes: model and proxy
 * credentials inside free text, and an unlisted share token as a `?t=` URL
 * parameter. The second was handled by neither redaction — `path` was written
 * verbatim and `redactEdgeText` had no `?t=` rule — and was safe only because
 * both call sites happened to pass `URL.pathname`, which drops the query.
 * `respond.ts` states the stake plainly: a log line carrying `?t=<secret>` hands
 * out a working unlisted link.
 */

const SECRET = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5'

describe('the share surface reaches a log drain at all', () => {
  it('logs an unexpected failure, with the path already redacted', async () => {
    const { handleError } = await import('./respond')
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
    try {
      const response = handleError(new Error('SHARE_KV read failed for pub:slug:my-model'), {
        origin: 'https://brickwrite.tech',
        wantsHtml: false,
        path: '/share/my-model?t=secret-token-value',
      })
      expect(response.status).toBe(500)
      // The body still says nothing: only the log gets the detail.
      await expect(response.text()).resolves.not.toContain('SHARE_KV')
    } finally {
      spy.mockRestore()
    }

    expect(errors).toHaveLength(1)
    const line = JSON.parse(errors[0])
    expect(line.service).toBe('functions/share')
    expect(line.cause).toContain('SHARE_KV read failed')
    // An unlisted token in a logged path is a working link handed to whoever
    // reads the drain.
    expect(errors[0]).not.toContain('secret-token-value')
  })

  it('says nothing for a refusal the caller already understands', async () => {
    const { handleError } = await import('./respond')
    const { ShareError } = await import('../../src/features/share/types')
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
    try {
      handleError(new ShareError('NOT_FOUND', 'No such publication.', 404), {
        origin: 'https://brickwrite.tech',
        wantsHtml: false,
        path: '/share/nope',
      })
    } finally {
      spy.mockRestore()
    }
    expect(errors).toEqual([])
  })
})

describe('edge log redaction', () => {
  it('strips an unlisted share token from a logged path', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      logEdgeFailure({ path: `/share/survey-rover?t=${SECRET}`, detail: 'upstream refused' })
    } finally {
      spy.mockRestore()
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(SECRET)
    expect(JSON.parse(lines[0]).path).toBe('/share/survey-rover?t=redacted')
  })

  it('strips a token that arrives inside the detail or the cause', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      logEdgeFailure({
        path: '/api/publications',
        detail: `fetch https://example.test/share/x?t=${SECRET}&mode=card failed`,
        cause: new Error(`redirect to /share/x?t=${SECRET}`),
      })
    } finally {
      spy.mockRestore()
    }
    const payload = JSON.parse(lines[0])
    expect(lines[0]).not.toContain(SECRET)
    // The rest of the message survives: a redaction that eats the diagnostic is
    // a different kind of failure.
    expect(payload.detail).toContain('&mode=card failed')
    expect(payload.cause).toContain('redirect to /share/x')
  })

  it('keeps redacting the credential shapes it already covered', () => {
    expect(redactEdgeText('key sk-ant-abcdefghijklmnop here')).toBe('key sk-ant-*** here')
    expect(redactEdgeText('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ***')
    expect(redactEdgeText('x-brickwright-proxy-key: hunter2')).toContain('[REDACTED]')
    expect(redactEdgeText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.sig-here')).toBe('eyJ***')
  })

  it('leaves a path with no token untouched', () => {
    expect(redactEdgeText('/api/assistant/stream')).toBe('/api/assistant/stream')
  })
})
