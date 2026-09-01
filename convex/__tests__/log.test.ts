// @vitest-environment edge-runtime
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logConvexEvent, redactConvexText } from '../model/log'

/**
 * What may and may not leave the deployment in a log line.
 *
 * This deployment stores an email address in exactly one table and copies it
 * nowhere — not into audit events, not into presence, not into comments. A log
 * line is a copy, and a log line is the one that ends up in a third-party
 * aggregator. So the redactor is asserted directly rather than trusted.
 */

const captured: string[] = []
const capture = () => {
  captured.length = 0
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void captured.push(String(line)))
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void captured.push(String(line)))
}

afterEach(() => vi.restoreAllMocks())

describe('redaction', () => {
  it('strips model and delivery credentials by shape, not by name', () => {
    const text = redactConvexText(
      'sk-ant-api03-abcdefghijklmnop failed with Bearer eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl and INVITATION_EMAIL_TOKEN',
    )
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('c2lnbmF0dXJl')
    expect(text).toContain('sk-ant-***')
    expect(text).toContain('[REDACTED_ENV]')
  })

  it('strips anything email-shaped', () => {
    expect(redactConvexText('could not reach builder.person@example.test')).toBe(
      'could not reach [REDACTED_EMAIL]',
    )
  })

  it('leaves an ordinary message alone', () => {
    expect(redactConvexText('The invitation email request timed out.')).toBe(
      'The invitation email request timed out.',
    )
  })
})

describe('the emitted line', () => {
  it('is one JSON object in the shape the other two surfaces use', () => {
    capture()
    logConvexEvent({ level: 'error', service: 'convex/invitations', message: 'Delivery failed.' })
    expect(captured).toHaveLength(1)
    const payload = JSON.parse(captured[0])
    // Same five keys as `server/log.ts` and `functions/_lib/log.ts`, so one
    // aggregator query finds a failure wherever it happened.
    expect(payload).toMatchObject({ level: 'error', service: 'convex/invitations', message: 'Delivery failed.' })
    expect(typeof payload.ts).toBe('string')
    expect(Number.isFinite(Date.parse(payload.ts))).toBe(true)
  })

  it('carries a redacted cause, never a raw one', () => {
    capture()
    logConvexEvent({
      level: 'error',
      service: 'convex/invitations',
      message: 'Delivery failed.',
      cause: new Error('POST https://mail.test failed for guest@example.test with Bearer abcdefghijkl'),
    })
    const payload = JSON.parse(captured[0])
    expect(payload.cause).not.toContain('guest@example.test')
    expect(payload.cause).not.toContain('abcdefghijkl')
  })

  it('passes detail through the audit redactor, so free text cannot ride along', () => {
    capture()
    logConvexEvent({
      level: 'error',
      service: 'convex/invitations',
      message: 'Delivery failed.',
      detail: { role: 'editor', attempts: 3, note: 'Sent to guest@example.test about the Millennium Falcon build' },
    })
    const payload = JSON.parse(captured[0])
    expect(payload.detail).toMatchObject({ role: 'editor', attempts: 3, redacted: 'note' })
    expect(JSON.stringify(payload)).not.toContain('guest@example.test')
    expect(JSON.stringify(payload)).not.toContain('Millennium')
  })

  it('sends info to stdout and errors to stderr', () => {
    capture()
    logConvexEvent({ level: 'info', service: 'convex/projects', message: 'ok' })
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })
})
