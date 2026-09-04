import { describe, expect, it } from 'vitest'
import { resolveAccess } from './access'
import { KvPublicationStore } from './backend/kv-store'
import { MemoryKv } from './backend/memory-kv'
import { hostileDocument, privateDocument, SECRETS } from './__fixtures__/model'
import { cardUrlFor, metaDescription, renderEmbedPage, renderRefusalPage, renderSharePage } from './page'
import { createPublication } from './publish'
import type { Publication, PublicationCard } from './types'

/**
 * The server-rendered surface.
 *
 * These assertions are about bytes, not about a DOM: what matters is what a
 * crawler reads out of the response before any script has run. `tools/e2e/
 * share.mjs` proves the same page over real HTTP with JavaScript disabled; this
 * suite proves the template, including every escaping and header rule, without
 * needing a server.
 */

const ORIGIN = 'https://brickwrite.tech'

const card = (preset: PublicationCard['preset'], width: number, height: number): PublicationCard => ({
  preset,
  width,
  height,
  contentType: 'image/png',
  sha256: 'a'.repeat(64),
  byteLength: 1234,
  frames: 1,
  alt: `${preset} render`,
})

async function publicPublication(overrides: Parameters<typeof createPublication>[0] | null = null) {
  return createPublication({
    document: privateDocument(9),
    capabilities: { view: true, comment: false, fork: true, download: true, embed: true },
    title: 'Survey Rover',
    description: 'A rover built from real parts.',
    tags: ['rover', 'showcase'],
    author: { displayName: 'Rishabh Bansal', handle: 'rish', url: 'https://example.com/rish' },
    cards: [
      card('opengraph', 1200, 630),
      card('twitter', 1200, 600),
      card('square', 1200, 1200),
      card('portrait', 1080, 1350),
      card('landscape', 1200, 628),
    ],
    now: new Date('2026-08-27T12:00:00.000Z'),
    ...overrides,
  })
}

async function pageFor(publication: Publication, presentedToken?: string) {
  const kv = new MemoryKv()
  const store = new KvPublicationStore(kv)
  const decision = await resolveAccess({
    publication,
    presentedToken,
    lookupToken: (id) => store.getToken(id),
  })
  return { page: renderSharePage({ publication, decision, origin: ORIGIN, nonce: 'TESTNONCE' }), decision, store }
}

describe('share page metadata', () => {
  it('carries every tag an unfurler needs, in the HTML itself', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)

    expect(page.status).toBe(200)
    expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(page.html).toContain('<title>Survey Rover — Brickwright</title>')
    expect(page.html).toContain(`<link rel="canonical" href="${ORIGIN}/share/${publication.slug}">`)
    expect(page.html).toContain('<meta property="og:title" content="Survey Rover">')
    expect(page.html).toContain('<meta property="og:type" content="article">')
    expect(page.html).toContain('<meta property="og:site_name" content="Brickwright">')
    expect(page.html).toContain(`<meta property="og:url" content="${ORIGIN}/share/${publication.slug}">`)
    expect(page.html).toContain(
      `<meta property="og:image" content="${cardUrlFor(ORIGIN, publication.slug, 'opengraph')}">`,
    )
    expect(page.html).toContain('<meta property="og:image:width" content="1200">')
    expect(page.html).toContain('<meta property="og:image:height" content="630">')
    expect(page.html).toContain('<meta property="og:image:type" content="image/png">')
    expect(page.html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(page.html).toContain(
      `<meta name="twitter:image" content="${cardUrlFor(ORIGIN, publication.slug, 'twitter')}">`,
    )
    expect(page.html).toContain('<meta name="author" content="Rishabh Bansal">')
    expect(page.html).toContain('<meta name="robots" content="index, follow, max-image-preview:large">')
    expect(page.html).toContain('"@type":"CreativeWork"')
  })

  it('points og:image at the exact published revision', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)
    const alt = /<meta property="og:image:alt" content="([^"]*)">/.exec(page.html)?.[1]
    expect(alt).toBe('opengraph render')
    // The card is addressed under this publication's slug, and the slug is
    // bound to one immutable snapshot, so the image cannot drift to a later
    // revision without the URL changing.
    expect(page.html).toContain(`/share/${publication.slug}/card/opengraph.png`)
    expect(page.html).toContain(`<dd class="share-mono share-hash">${publication.contentHash}</dd>`)
    expect(page.html).toContain('Rendered from revision 9 at publication.')
  })

  it('falls back to a measured description rather than marketing copy', async () => {
    const publication = await createPublication({ document: privateDocument(9) })
    const description = metaDescription(publication)
    expect(description).toContain('6 parts')
    expect(description).toContain('2 unique elements')
    expect(description).toContain('3 build steps')
    expect(description).toContain('revision 9')
  })

  it('renders the parts list, the steps and the fork action without JavaScript', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)
    const withoutScripts = page.html.replace(/<script[\s\S]*?<\/script>/g, '')

    expect(withoutScripts).toContain('Build sequence')
    expect(withoutScripts).toContain('Chassis floor')
    expect(withoutScripts).toContain('Parts list')
    expect(withoutScripts).toContain('Brick 2 x 4')
    expect(withoutScripts).toContain('Edit a copy')
    // Attribute-escaped, so the `=` is an entity — which is the point.
    expect(withoutScripts).toContain(`href="${ORIGIN}/editor?fork&#61;${publication.slug}"`)
    expect(withoutScripts).toContain('Download the model')
    expect(withoutScripts).toContain('share-badge')
  })

  it('says "Author not stated" rather than inventing a creator', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    const { page } = await pageFor(publication)
    expect(page.html).toContain('Author not stated')
    expect(page.html).not.toContain('<meta name="author"')
    expect(page.html).not.toContain('"creator"')
  })

  it('marks a publication with no cards honestly instead of shipping a broken image', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    const { page } = await pageFor(publication)
    expect(page.html).not.toContain('og:image')
    expect(page.html).toContain('No render was captured for this publication')
  })

  it('marks a page with public viewing turned off as noindex and no-store', async () => {
    const publication = await createPublication({
      document: privateDocument(2),
      capabilities: { view: false, comment: false, fork: false, download: false, embed: false },
    })
    const { page } = await pageFor(publication)

    expect(page.html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">')
    expect(page.headers['Cache-Control']).toBe('private, no-store')
    // Forking is off, so the action is absent rather than broken. The address
    // is still the publication's real one, so "Copy link" still appears — a
    // publication is always public, however few capabilities it grants.
    expect(page.html).not.toContain('Edit a copy')
    expect(page.html).toContain('Copy link')
  })
})

describe('share page security headers', () => {
  it('sets a strict content security policy with a per-response nonce', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)
    const csp = page.headers['Content-Security-Policy']

    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("script-src 'nonce-TESTNONCE'")
    expect(csp).toContain("style-src 'nonce-TESTNONCE'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(page.html).toContain('<script type="module" nonce="TESTNONCE">')
    expect(page.html).toContain('<style nonce="TESTNONCE">')
  })

  it('refuses to be framed and refuses to be sniffed', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)
    expect(page.headers['X-Frame-Options']).toBe('DENY')
    expect(page.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(page.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(page.headers['Permissions-Policy']).toContain('camera=()')
  })

  it('mints a different nonce for every response', async () => {
    const publication = await publicPublication()
    const kv = new MemoryKv()
    const store = new KvPublicationStore(kv)
    const decision = await resolveAccess({ publication, lookupToken: (id) => store.getToken(id) })
    const first = renderSharePage({ publication, decision, origin: ORIGIN })
    const second = renderSharePage({ publication, decision, origin: ORIGIN })
    const nonceOf = (html: string) => /<style nonce="([^"]+)">/.exec(html)?.[1]
    expect(nonceOf(first.html)).toBeTruthy()
    expect(nonceOf(first.html)).not.toBe(nonceOf(second.html))
  })
})

describe('share page injection resistance', () => {
  it('escapes hostile model, step and subassembly names', async () => {
    const publication = await createPublication({
      document: hostileDocument(),
      title: '"><script>alert(1)</script>',
      description: '</p><img src=x onerror=alert(2)>',
      tags: ['"><svg onload=alert(3)>'],
      author: { displayName: '</title><script>alert(4)</script>', handle: null, url: null },
      cards: [card('opengraph', 1200, 630)],
    })
    const { page } = await pageFor(publication)

    // Parsed rather than pattern-matched: the question is not "does the string
    // contain `<script>`" but "does a browser build a script element out of
    // this", and only a parser answers that. The hostile text survives as inert
    // characters, which is correct — it is the *elements* that must not exist.
    const parsed = new DOMParser().parseFromString(page.html, 'text/html')

    // Exactly the two the template emits: one nonce'd style, one nonce'd module.
    const scripts = [...parsed.querySelectorAll('script')]
    expect(scripts).toHaveLength(2)
    expect(scripts.every((script) => script.getAttribute('nonce') === 'TESTNONCE')).toBe(true)
    expect(parsed.querySelectorAll('svg, iframe, object, embed, form, base')).toHaveLength(0)

    for (const element of parsed.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on'), `${element.tagName} carries ${attribute.name}`).toBe(false)
        expect(attribute.value.toLowerCase()).not.toContain('javascript:')
      }
    }

    // The hostile title is present, as text, in the heading.
    expect(parsed.querySelector('.share-title')?.textContent).toContain('script')
    expect(parsed.querySelector('.share-title')?.querySelector('*')).toBeNull()
  })

  it('escapes the JSON-LD payload so it cannot close its own script tag', async () => {
    const publication = await createPublication({
      document: privateDocument(1),
      title: 'A</script><script>alert(1)</script>',
    })
    const { page } = await pageFor(publication)
    const jsonLd = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(page.html)?.[1]
    expect(jsonLd).toBeTruthy()
    expect(jsonLd).not.toContain('</script>')
    expect(() => JSON.parse(jsonLd!)).not.toThrow()
  })

  it('never renders a private field, whatever the template does', async () => {
    const publication = await publicPublication()
    const { page } = await pageFor(publication)
    for (const [field, secret] of Object.entries(SECRETS)) {
      expect(page.html, `${field} reached the share page`).not.toContain(secret)
    }
  })
})

describe('embed page', () => {
  it('allows framing by https origins and refuses to be indexed', async () => {
    const publication = await publicPublication()
    const kv = new MemoryKv()
    const store = new KvPublicationStore(kv)
    const decision = await resolveAccess({ publication, lookupToken: (id) => store.getToken(id) })
    const page = renderEmbedPage({ publication, decision, origin: ORIGIN, nonce: 'E' })

    expect(page.headers['Content-Security-Policy']).toContain('frame-ancestors https:')
    // The share page's DENY would make an embed impossible, and
    // `X-Frame-Options` has no allowlist form, so it is deliberately absent.
    expect(page.headers['X-Frame-Options']).toBeUndefined()
    expect(page.headers['X-Robots-Tag']).toBe('noindex, nofollow')
    expect(page.html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(page.html).toContain(`<link rel="canonical" href="${ORIGIN}/share/${publication.slug}">`)
    // An embed runs no script of its own.
    expect(page.html).toContain('<script type="module" nonce="E"></script>')
  })

  it('narrows frame-ancestors to a configured allowlist and drops junk entries', async () => {
    const publication = await publicPublication()
    const kv = new MemoryKv()
    const store = new KvPublicationStore(kv)
    const decision = await resolveAccess({ publication, lookupToken: (id) => store.getToken(id) })
    const page = renderEmbedPage({
      publication,
      decision,
      origin: ORIGIN,
      embedAncestors: ['https://partner.example', 'javascript:alert(1)', '*'],
      nonce: 'E',
    })
    expect(page.headers['Content-Security-Policy']).toContain('frame-ancestors https://partner.example')
    expect(page.headers['Content-Security-Policy']).not.toContain('javascript:')
  })
})

describe('refusal page', () => {
  it('says what happened without echoing the request', () => {
    const page = renderRefusalPage({
      origin: ORIGIN,
      status: 404,
      title: 'Not found',
      message: 'No published model was found at this address.',
      nonce: 'R',
    })
    expect(page.status).toBe(404)
    expect(page.headers['Cache-Control']).toBe('no-store')
    expect(page.headers['X-Frame-Options']).toBe('DENY')
    expect(page.html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(page.html).toContain('No published model was found at this address.')
    expect(page.html).toContain('Browse published models')
  })
})
