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
