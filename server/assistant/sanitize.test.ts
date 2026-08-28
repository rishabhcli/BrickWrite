// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sanitizeMessage as clientSanitize } from '../../src/webmcp/contract'
import { MAX_ERROR_MESSAGE_LENGTH, redactSecret, sanitizeMessage } from './sanitize.ts'

/**
 * This file may import from `src/` — the boundary rule is one-way. A test in
 * Node reading the browser's copy of the redaction policy is exactly how the
 * two are kept in step without the API process taking a runtime dependency on
 * the browser module graph.
 */
describe('outbound sanitisation', () => {
  it('removes bearer tokens, api keys, signed URLs, data URLs and blobs', () => {
    expect(sanitizeMessage('failed with Authorization: Bearer abc.def-ghi123')).not.toContain('abc.def-ghi123')
    expect(sanitizeMessage('api_key=sk-live-9182736455')).not.toContain('sk-live-9182736455')
    expect(sanitizeMessage('fetch https://cdn.example.com/a.bin?sig=deadbeefcafe failed')).toContain('[REDACTED_SIGNED_URL]')
    expect(sanitizeMessage(`data:image/png;base64,${'A'.repeat(200)}`)).toBe('[REDACTED_DATA_URL]')
    expect(sanitizeMessage(`blob ${'Z'.repeat(400)}`)).toContain('[REDACTED_BLOB]')
  })

  it('removes an Anthropic key even when it is not in a key=value shape', () => {
    const message = sanitizeMessage('x-api-key header was sk-ant-api03-AAAAbbbbCCCCdddd and it failed')
    expect(message).not.toContain('sk-ant-api03-AAAAbbbbCCCCdddd')
    expect(message).toContain('[REDACTED_KEY]')
  })

  it('removes the configured key by exact match as a last resort', () => {
    const secret = 'totally-opaque-credential-value'
    expect(redactSecret(`upstream said ${secret}`, secret)).toBe('upstream said [REDACTED_KEY]')
    // A short or absent secret is never substring-matched; that would redact prose.
    expect(redactSecret('nothing to do', undefined)).toBe('nothing to do')
    expect(redactSecret('abc', 'abc')).toBe('abc')
  })

  it('strips host paths and never relays a stack trace', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at /Users/someone/app/server/secret.ts:12:3'
    expect(sanitizeMessage(error)).toBe('boom')
    expect(sanitizeMessage('ENOENT /Users/someone/project/key.txt')).toContain('[path]')
    expect(sanitizeMessage('ENOENT /Users/someone/project/key.txt')).not.toContain('someone')
  })

  it('caps one message so a single error cannot flood a context window', () => {
    expect(sanitizeMessage('word '.repeat(5000)).length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH + 1)
  })

  it('agrees with the browser gateway’s redaction policy', () => {
    const samples = [
      'Authorization: Bearer abc.def-ghi123',
      'api_key=sk-live-9182736455',
      'https://cdn.example.com/a.bin?sig=deadbeefcafe',
      'ENOENT: no such file /Users/someone/secret-project/model.ldr',
      `blob ${'Z'.repeat(400)}`,
    ]
    for (const sample of samples) expect(sanitizeMessage(sample)).toBe(clientSanitize(sample))
  })
})
