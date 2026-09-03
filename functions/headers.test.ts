// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * The two deployments must agree, and their rules must match request paths.
 *
 * `X-Frame-Options: DENY` used to sit under `/index.html` in both configs. Both
 * platforms match a header rule against the **request** path, and the
 * application is reached at `/`, `/editor`, `/gallery` — paths that arrive at
 * index.html through a rewrite (`public/_redirects`, `vercel.json` rewrites)
 * and never match that rule. So the page with the fork button was the one
 * surface with no frame protection, while `functions/embed/[slug].ts` argues
 * that framing a page with a fork button is the case that matters.
 */
const root = new URL('../', import.meta.url)

async function cloudflareBlocks(): Promise<Map<string, string[]>> {
  const text = await readFile(new URL('public/_headers', root), 'utf8')
  const blocks = new Map<string, string[]>()
  let current: string | null = null
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!line.startsWith(' ')) {
      current = line.trim()
      blocks.set(current, [])
    } else if (current) {
      blocks.get(current)!.push(line.trim())
    }
  }
  return blocks
}

async function vercelCatchAll(): Promise<Map<string, string>> {
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'))
  const rule = config.headers.find((entry: { source: string }) => entry.source === '/(.*)')
  expect(rule, 'vercel.json has no catch-all header rule').toBeTruthy()
  return new Map(rule.headers.map((h: { key: string; value: string }) => [h.key, h.value]))
}

describe('frame protection reaches the application, not just index.html', () => {
  it('denies framing from the Cloudflare catch-all', async () => {
    const blocks = await cloudflareBlocks()
    expect(blocks.get('/*')).toContain('X-Frame-Options: DENY')
    // A rule keyed on the literal file cannot carry it: no request arrives there.
    expect(blocks.get('/index.html') ?? []).not.toContain('X-Frame-Options: DENY')
  })

  it('denies framing from the Vercel catch-all', async () => {
    expect((await vercelCatchAll()).get('X-Frame-Options')).toBe('DENY')
  })

  it('leaves the embed route framable, which is its whole purpose', async () => {
    // `!` removes an inherited header. The embed sets a CSP `frame-ancestors`
    // allowlist in code and deliberately omits XFO, which has no allowlist
    // form — inheriting DENY would block every embed.
    expect((await cloudflareBlocks()).get('/embed/*')).toContain('! X-Frame-Options')
  })

  it('states frame-ancestors in both policies, so the CSP says it too', async () => {
    const cloudflare = (await cloudflareBlocks()).get('/*')!.join(' ')
    const vercel = (await vercelCatchAll()).get('Content-Security-Policy-Report-Only')!
    for (const policy of [cloudflare, vercel]) expect(policy).toContain("frame-ancestors 'none'")
  })

  it('keeps the two deployments telling the browser the same thing', async () => {
    const cloudflare = new Map(
      (await cloudflareBlocks())
        .get('/*')!
        .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]),
    )
    const vercel = await vercelCatchAll()
    for (const [key, value] of vercel) expect(cloudflare.get(key), `${key} differs between deployments`).toBe(value)
  })
})
