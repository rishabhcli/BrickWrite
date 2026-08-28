import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SERVER_EMAIL_MODULE, escapeHtml, renderPlatformEmail } from './emails'

const ROOT = resolve(__dirname, '../..')

describe('email content', () => {
  it('renders an invitation without sending anything', () => {
    const rendered = renderPlatformEmail({
      kind: 'project-invitation',
      projectName: 'Cathedral of St Brick',
      inviterName: 'Ada',
      acceptUrl: 'https://brickwright.example/share/abc',
    })
    expect(rendered.subject).toBe('Ada shared "Cathedral of St Brick" with you')
    expect(rendered.notificationCategoryName).toBe('Transactional')
    expect(rendered.html).toContain('Cathedral of St Brick')
    expect(rendered.html).toContain('https://brickwright.example/share/abc')
  })

  it('renders each publication change as its own message', () => {
    const changes = ['published', 'updated', 'unpublished'] as const
    const subjects = changes.map(
      (change) =>
        renderPlatformEmail({
          kind: 'publication-notification',
          projectName: 'Microscale Docks',
          shareUrl: 'https://brickwright.example/share/docks',
          change,
        }).subject,
    )
    expect(new Set(subjects).size).toBe(3)
    expect(subjects[2]).toContain('no longer published')
  })

  it('escapes operator-supplied names, which are arbitrary text', () => {
    const rendered = renderPlatformEmail({
      kind: 'project-invitation',
      projectName: '<img src=x onerror="alert(1)">',
      inviterName: 'Ada & Co',
      acceptUrl: 'https://brickwright.example/share/abc',
    })
    expect(rendered.html).not.toContain('<img')
    expect(rendered.html).toContain('&lt;img')
    expect(rendered.html).toContain('Ada &amp; Co')
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;')
  })

  it('names where delivery lives without importing it', () => {
    expect(SERVER_EMAIL_MODULE).toBe('src/platform/server/emails.server.ts')
    const source = readFileSync(resolve(ROOT, 'src/platform/emails.ts'), 'utf8')
    expect(source).not.toMatch(/from\s*['"]\.\/server\//)
    expect(source).not.toMatch(/import\s*\(\s*['"]\.\/server\//)
    expect(source).not.toContain('HexclaveServerApp')
  })

  it('refuses to evaluate the server module in a browser', async () => {
    expect(typeof window).toBe('object')
    // The module registry is shared across files in a worker, and
    // `server/emails.server.test.ts` evaluates this module successfully under
    // the node environment. Without resetting, a cached instance resolves here
    // and the guard is never exercised — the assertion would pass on file order
    // rather than on behaviour.
    vi.resetModules()
    await expect(import('./server/emails.server')).rejects.toThrow(/evaluated in a browser/)
  })
})
