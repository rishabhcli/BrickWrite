// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { redactLogText } from './log.ts'

describe('process log redaction', () => {
  it('strips Anthropic keys, generic sk- tokens, bearer headers and JWTs', () => {
    const leaked =
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz ANTHROPIC_API_KEY=set Bearer abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature sk-proj-abcdefghijklmnop'
    const redacted = redactLogText(leaked)
    expect(redacted).toContain('sk-ant-***')
    expect(redacted).toContain('[REDACTED_ENV]')
    expect(redacted).toContain('Bearer ***')
    expect(redacted).toContain('eyJ***')
    expect(redacted).toContain('sk-***')
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })
})
