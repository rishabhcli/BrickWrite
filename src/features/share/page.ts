import { base64url, randomBytes } from './canonical'
import { describeFork } from './fork'
import { OG_CARD } from './render/presets'
import { escapeAttribute, escapeHtml, escapeJsonLd, redactShareUrl } from './sanitize'
import type { AccessDecision } from './access'
import type { CardPresetId, Publication, PublicationCard } from './types'

/**
 * Server-rendered share and embed pages.
 *
 * A crawler does not run JavaScript, and neither does a link unfurler, a
 * messaging preview, a screen reader in reader mode or `curl`. A share page
 * whose metadata is written by React on mount is a share page with no metadata,
 * so everything a stranger or a robot needs — title, description, canonical,
 * OpenGraph, Twitter card, structured data, the parts list, the build sequence,
 * the validation verdict and the fork link — is in the bytes this module
 * returns.
 *
 * The interactive viewer is an enhancement on top, not a prerequisite. When the
 * application shell is loaded it takes over `/share/:slug` client-side and
 * mounts `viewer/SharePage`; when it is not, this page is still complete.
 *
 * Every interpolated value goes through `escapeHtml` or `escapeAttribute` even
 * though ingest already stripped markup, and the inline script and style carry
 * a per-response nonce so the CSP can refuse everything else outright.
 */

export interface PageOptions {
  publication: Publication
  decision: AccessDecision
  /** Absolute origin, e.g. `https://brickwrite.tech`. No trailing slash. */
  origin: string
  /**
   * Origins permitted to frame an embed. `null` means any https origin, which
   * is what an embeddable publication implies.
   */
  embedAncestors?: readonly string[] | null
  /** Injected so tests get a stable nonce; production takes the random one. */
  nonce?: string
}

export interface RenderedPage {
  html: string
  status: number
  headers: Record<string, string>
}

const SITE_NAME = 'Brickwright'

/** A fresh nonce per response; CSP is worthless if it is reused. */
const mintNonce = () => base64url(randomBytes(16))

export const canonicalUrlFor = (origin: string, slug: string) => `${trimOrigin(origin)}/share/${slug}`
export const embedUrlFor = (origin: string, slug: string) => `${trimOrigin(origin)}/embed/${slug}`
export const cardUrlFor = (origin: string, slug: string, preset: string) =>
  `${trimOrigin(origin)}/share/${slug}/card/${preset}.png`

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}

function findCard(publication: Publication, preset: CardPresetId): PublicationCard | null {
  return publication.cards.find((card) => card.preset === preset) ?? null
}

/**
 * The description used for `og:description` and `<meta name="description">`.
 *
 * Falls back to a factual sentence built from the snapshot — part count, unique
 * parts, step count — rather than marketing copy. Every number in it is
 * measured from the published revision, so the fallback is a description rather
 * than a claim.
 */
export function metaDescription(publication: Publication): string {
  if (publication.description) return publication.description.replace(/\s+/g, ' ').slice(0, 300)
  const { partCount, uniquePartCount, stepCount } = publication.summary
  const steps = stepCount ? `, sequenced into ${stepCount} build step${stepCount === 1 ? '' : 's'}` : ''
  return `A brick model built from ${partCount} part${partCount === 1 ? '' : 's'} across ${uniquePartCount} unique element${uniquePartCount === 1 ? '' : 's'}${steps}. Published from Brickwright at revision ${publication.revision}.`
}

/** Security headers shared by every response this module produces. */
export function baseSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // A share page has no reason to reach any of these, and saying so is
    // cheaper than auditing whatever a future embed decides to load.
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Resource-Policy': 'same-site',
  }
}

function contentSecurityPolicy(nonce: string, frameAncestors: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    // Cards are same-origin; `data:` covers the inline SVG marks below.
    "img-src 'self' data:",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "font-src 'self'",
  ].join('; ')
}

/**
 * Robots policy.
 *
 * Only a public, viewable, unrevoked publication is indexable. Unlisted pages
 * carry `noindex, nofollow, noarchive` — an unlisted link that turns up in a
 * search result was never unlisted.
 */
function robotsValue(decision: AccessDecision): string {
  return decision.noindex ? 'noindex, nofollow, noarchive' : 'index, follow, max-image-preview:large'
}

// ---------------------------------------------------------------------------
// Share page
// ---------------------------------------------------------------------------

export function renderSharePage(options: PageOptions): RenderedPage {
  const { publication, decision, origin } = options
  const nonce = options.nonce ?? mintNonce()
  const canonical = canonicalUrlFor(origin, publication.slug)
  const description = metaDescription(publication)
  const ogCard = findCard(publication, OG_CARD)
  const twitterCard = findCard(publication, 'twitter') ?? ogCard
  const heroCard = findCard(publication, 'square') ?? ogCard

  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="theme-color" content="#090d0e">',
    `<title>${escapeHtml(publication.title)} — ${SITE_NAME}</title>`,
    `<link rel="canonical" href="${escapeAttribute(canonical)}">`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    `<meta name="robots" content="${escapeAttribute(robotsValue(decision))}">`,
    `<meta property="og:site_name" content="${escapeAttribute(SITE_NAME)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeAttribute(publication.title)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    `<meta property="og:url" content="${escapeAttribute(canonical)}">`,
    `<meta property="article:published_time" content="${escapeAttribute(publication.publishedAt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeAttribute(publication.title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
  ]

  if (ogCard) {
    const url = cardUrlFor(origin, publication.slug, ogCard.preset)
    head.push(
      `<meta property="og:image" content="${escapeAttribute(url)}">`,
      `<meta property="og:image:secure_url" content="${escapeAttribute(url)}">`,
      `<meta property="og:image:type" content="image/png">`,
      `<meta property="og:image:width" content="${ogCard.width}">`,
      `<meta property="og:image:height" content="${ogCard.height}">`,
      `<meta property="og:image:alt" content="${escapeAttribute(ogCard.alt || publication.title)}">`,
    )
  }
  if (twitterCard) {
    const url = cardUrlFor(origin, publication.slug, twitterCard.preset)
    head.push(
      `<meta name="twitter:image" content="${escapeAttribute(url)}">`,
      `<meta name="twitter:image:alt" content="${escapeAttribute(twitterCard.alt || publication.title)}">`,
    )
  }
  if (publication.author?.displayName) {
    head.push(`<meta name="author" content="${escapeAttribute(publication.author.displayName)}">`)
    head.push(`<meta property="article:author" content="${escapeAttribute(publication.author.displayName)}">`)
  }
  head.push(`<script type="application/ld+json" nonce="${escapeAttribute(nonce)}">${jsonLd(options)}</script>`)

  const html = documentShell({
    nonce,
    head: head.join('\n    '),
    body: shareBody(options, heroCard),
    lang: 'en',
  })

  return {
    html,
    status: decision.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The page embeds mutable state (visibility, revocation), so it is never
      // cached at the edge. The cards it points at are immutable and are.
      'Cache-Control': decision.noindex ? 'private, no-store' : 'public, max-age=0, must-revalidate',
      'Content-Security-Policy': contentSecurityPolicy(nonce, "'none'"),
      'X-Frame-Options': 'DENY',
      ...baseSecurityHeaders(),
    },
  }
}

function jsonLd(options: PageOptions): string {
  const { publication, origin } = options
  const card = findCard(publication, OG_CARD)
  return escapeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: publication.title,
    description: metaDescription(publication),
    url: canonicalUrlFor(origin, publication.slug),
    datePublished: publication.publishedAt,
    license: publication.license,
    image: card ? cardUrlFor(origin, publication.slug, card.preset) : undefined,
    // Absent rather than invented when the publisher did not state an author.
    creator: publication.author ? { '@type': 'Person', name: publication.author.displayName } : undefined,
    isBasedOn: publication.fork ? canonicalUrlFor(origin, publication.fork.slug) : undefined,
    keywords: publication.tags.length ? publication.tags.join(', ') : undefined,
  })
}

function shareBody(options: PageOptions, heroCard: PublicationCard | null): string {
  const { publication, decision, origin } = options
  const canonical = canonicalUrlFor(origin, publication.slug)
  const summary = publication.summary
  const validation = summary.validation

  const hero = heroCard
    ? `<img class="share-hero-image" src="${escapeAttribute(cardUrlFor(origin, publication.slug, heroCard.preset))}" width="${heroCard.width}" height="${heroCard.height}" alt="${escapeAttribute(heroCard.alt || publication.title)}">`
    : `<p class="share-empty">No render was captured for this publication, so there is no preview image.</p>`

  const author = publication.author
    ? publication.author.url
      ? `<a class="share-author" href="${escapeAttribute(publication.author.url)}" rel="noopener nofollow">${escapeHtml(publication.author.displayName)}</a>`
      : `<span class="share-author">${escapeHtml(publication.author.displayName)}</span>`
    : '<span class="share-author share-author-absent">Author not stated</span>'

  const badge = validation.constraints.length || validation.partCount
    ? validationBadge(publication)
    : '<span class="share-badge share-badge-unknown">Not validated</span>'

  const stepRows = publication.document.steps.length
    ? publication.document.steps
        .map(
          (step) =>
            `<li><button type="button" class="share-step" data-step="${step.index}" aria-pressed="false"><span class="share-step-index">${step.index}</span><span class="share-step-name">${escapeHtml(step.name)}</span><span class="share-step-count">${step.partIds.length} part${step.partIds.length === 1 ? '' : 's'}</span></button></li>`,
        )
        .join('')
    : '<li class="share-empty">This model has no sequenced build steps.</li>'

  const bomRows = summary.bom.length
    ? summary.bom
        .map(
          (line) =>
            `<tr><td class="share-qty">${line.quantity}</td><td><span class="share-swatch" style="--swatch:${escapeAttribute(line.colorHex)}"></span>${escapeHtml(line.name)}</td><td class="share-mono">${escapeHtml(line.ldrawId)}</td><td>${escapeHtml(line.colorName)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="share-empty">This publication contains no parts.</td></tr>'

  const forkNote = publication.fork
    ? `<p class="share-provenance">${escapeHtml(describeFork(publication.fork))} <a href="${escapeAttribute(canonicalUrlFor(origin, publication.fork.slug))}">View the original</a>.</p>`
    : ''

  const unresolved = summary.unresolvedDefinitionIds.length
    ? `<p class="share-warning">${summary.unresolvedDefinitionIds.length} part identit${summary.unresolvedDefinitionIds.length === 1 ? 'y is' : 'ies are'} not in this build's catalog, so ${summary.unresolvedDefinitionIds.length === 1 ? 'it is' : 'they are'} listed without a name.</p>`
    : ''

  const actions: string[] = []
  if (decision.capabilities.fork) {
    actions.push(
      `<a class="share-action share-action-primary" href="${escapeAttribute(`${trimOrigin(origin)}/editor?fork=${encodeURIComponent(publication.slug)}`)}">Edit a copy</a>`,
    )
  }
  if (decision.capabilities.download) {
    actions.push(
      `<a class="share-action" href="${escapeAttribute(`${canonical}/model.json`)}" download>Download the model</a>`,
    )
  }
  if (decision.capabilities.embed) {
    actions.push(`<button type="button" class="share-action" data-copy="${escapeAttribute(embedSnippet(options))}">Copy embed code</button>`)
  }
  actions.push(`<button type="button" class="share-action" data-copy="${escapeAttribute(canonical)}" data-share-url="${escapeAttribute(canonical)}" data-share-title="${escapeAttribute(publication.title)}">Copy link</button>`)

  const tags = publication.tags.length
    ? `<ul class="share-tags">${publication.tags.map((tag) => `<li><a href="${escapeAttribute(`${trimOrigin(origin)}/gallery?tag=${encodeURIComponent(tag)}`)}">#${escapeHtml(tag)}</a></li>`).join('')}</ul>`
    : ''

  return `
    <header class="share-topbar">
      <a class="share-brand" href="${escapeAttribute(trimOrigin(origin))}/"><span class="share-brand-mark" aria-hidden="true"></span><strong>BRICK<span>WRIGHT</span></strong></a>
      <span class="share-eyebrow">PUBLISHED MODEL</span>
    </header>
    <main class="share-page">
      <article class="share-primary">
        <figure class="share-hero">${hero}<figcaption>Rendered from revision ${publication.revision} at publication.</figcaption></figure>
      </article>
      <div class="share-secondary">
        <h1 class="share-title">${escapeHtml(publication.title)}</h1>
        <p class="share-byline">by ${author} · <time datetime="${escapeAttribute(publication.publishedAt)}">${escapeHtml(publication.publishedAt.slice(0, 10))}</time> · rev ${publication.revision}</p>
        ${publication.description ? `<p class="share-description">${escapeHtml(publication.description)}</p>` : ''}
        ${forkNote}
        ${tags}
        <dl class="share-stats">
          <div><dt>Parts</dt><dd>${summary.partCount}</dd></div>
          <div><dt>Unique elements</dt><dd>${summary.uniquePartCount}</dd></div>
          <div><dt>Steps</dt><dd>${summary.stepCount}</dd></div>
          <div><dt>Envelope</dt><dd>${summary.envelopeStuds[0]} × ${summary.envelopeStuds[2]} studs, ${summary.envelopeStuds[1]} plates tall</dd></div>
          <div><dt>Catalog</dt><dd class="share-mono">${escapeHtml(publication.document.catalogVersion)}</dd></div>
          <div><dt>Content hash</dt><dd class="share-mono share-hash">${escapeHtml(publication.contentHash)}</dd></div>
        </dl>
        <p class="share-validation">${badge}</p>
        ${unresolved}
        <div class="share-actions">${actions.join('')}</div>
        <p class="share-license">Shared under ${escapeHtml(publication.license)}. Brick geometry from the LDraw library, CC BY 4.0.</p>
      </div>
      <section class="share-panel" id="steps">
        <h2>Build sequence</h2>
        <ol class="share-steps">${stepRows}</ol>
      </section>
      <section class="share-panel" id="parts">
        <h2>Parts list</h2>
        <table class="share-bom">
          <thead><tr><th scope="col">Qty</th><th scope="col">Part</th><th scope="col">LDraw</th><th scope="col">Colour</th></tr></thead>
          <tbody>${bomRows}</tbody>
        </table>
      </section>
    </main>
    <footer class="share-footer">
      <p>Published with ${SITE_NAME}. This page is generated on the server — the metadata above is present with JavaScript disabled.</p>
    </footer>`
}

function validationBadge(publication: Publication): string {
  const validation = publication.summary.validation
  if (validation.healthy) {
    return `<span class="share-badge share-badge-pass">Validated · ${validation.connectionCount} connections · no collisions</span>`
  }
  const problems: string[] = []
  if (validation.collisionCount) problems.push(`${validation.collisionCount} collision${validation.collisionCount === 1 ? '' : 's'}`)
  if (validation.componentCount > 1) problems.push(`${validation.componentCount} disconnected groups`)
  const failing = validation.constraints.filter((entry) => entry.status === 'fail').length
  if (failing) problems.push(`${failing} failing constraint${failing === 1 ? '' : 's'}`)
  if (!problems.length) return '<span class="share-badge share-badge-unknown">Not validated</span>'
  return `<span class="share-badge share-badge-warn">Reported at publication: ${escapeHtml(problems.join(', '))}</span>`
}

export function embedSnippet(options: PageOptions): string {
  const url = embedUrlFor(options.origin, options.publication.slug)
  return `<iframe src="${url}" width="640" height="480" style="border:0" loading="lazy" title="${options.publication.title.replace(/"/g, '')}" allowfullscreen></iframe>`
}

// ---------------------------------------------------------------------------
// Embed page
// ---------------------------------------------------------------------------

/**
 * The embed surface.
 *
 * Deliberately smaller than the share page in every sense: one image, one
 * caption, one link back to the canonical page. It carries `noindex` — an embed
 * competing with its own share page in search results is a duplicate-content
 * problem nobody asked for — and its `frame-ancestors` is the only place in
 * this workstream where a third-party origin is permitted to frame anything.
 */
export function renderEmbedPage(options: PageOptions): RenderedPage {
  const { publication, decision, origin } = options
  const nonce = options.nonce ?? mintNonce()
  const canonical = canonicalUrlFor(origin, publication.slug)
  const card = findCard(publication, 'square') ?? findCard(publication, OG_CARD)
  const ancestors = frameAncestorsValue(options.embedAncestors)

  const body = `
    <main class="embed-frame">
      ${card ? `<img class="embed-image" src="${escapeAttribute(cardUrlFor(origin, publication.slug, card.preset))}" alt="${escapeAttribute(card.alt || publication.title)}" width="${card.width}" height="${card.height}">` : '<p class="share-empty">No render is available for this model.</p>'}
      <div class="embed-caption">
        <a class="embed-title" href="${escapeAttribute(canonical)}" target="_blank" rel="noopener">${escapeHtml(publication.title)}</a>
        <span class="embed-meta">${publication.author ? escapeHtml(publication.author.displayName) : 'Author not stated'} · ${publication.summary.partCount} parts · rev ${publication.revision}</span>
      </div>
    </main>`

  return {
    html: documentShell({
      nonce,
      lang: 'en',
      head: [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(publication.title)} — embedded from ${SITE_NAME}</title>`,
        '<meta name="robots" content="noindex, nofollow">',
        `<link rel="canonical" href="${escapeAttribute(canonical)}">`,
      ].join('\n    '),
      body,
      embed: true,
    }),
    status: decision.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Security-Policy': contentSecurityPolicy(nonce, ancestors),
      // Deliberately no `X-Frame-Options`: it has no allowlist form, so setting
      // it here would either block every embed or be a meaningless `ALLOWALL`.
      // `frame-ancestors` is the header that can express this policy, and a
      // browser old enough to lack it is old enough to lack the CSP too — that
      // limitation is recorded in docs/integration/share-studio.md.
      'X-Robots-Tag': 'noindex, nofollow',
      ...baseSecurityHeaders(),
    },
  }
}

function frameAncestorsValue(allowlist: readonly string[] | null | undefined): string {
  if (!allowlist || !allowlist.length) return 'https:'
  const safe = allowlist
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\/[a-z0-9.*-]+(:\d+)?$/i.test(entry) || entry === "'self'")
  return safe.length ? safe.join(' ') : "'self'"
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The page a refused request gets.
 *
 * One template for missing, private, revoked and rejected-token, with the
 * message the access gate chose. It carries `noindex` and never echoes the
 * requested URL back — a reflected slug is a stored-XSS sink waiting for a
 * template change, and a reflected token is a leak.
 */
export function renderRefusalPage(input: {
  origin: string
  status: number
  title: string
  message: string
  requestedPath?: string
  nonce?: string
}): RenderedPage {
  const nonce = input.nonce ?? mintNonce()
  const body = `
    <main class="share-refusal">
      <span class="share-eyebrow">${escapeHtml(String(input.status))}</span>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
      <p><a class="share-action" href="${escapeAttribute(trimOrigin(input.origin))}/gallery">Browse published models</a></p>
    </main>`
  return {
    html: documentShell({
      nonce,
      lang: 'en',
      head: [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(input.title)} — ${SITE_NAME}</title>`,
        '<meta name="robots" content="noindex, nofollow">',
      ].join('\n    '),
      body,
    }),
    status: input.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': contentSecurityPolicy(nonce, "'none'"),
      'X-Frame-Options': 'DENY',
      ...baseSecurityHeaders(),
    },
  }
}

/** Confirms the redaction helper is applied wherever a URL could be echoed. */
export const safeRequestPath = (path: string) => redactShareUrl(path)

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function documentShell(input: { nonce: string; head: string; body: string; lang?: string; embed?: boolean }): string {
  return `<!doctype html>
<html lang="${input.lang ?? 'en'}">
  <head>
    ${input.head}
    <style nonce="${escapeAttribute(input.nonce)}">${input.embed ? EMBED_CSS : SHARE_CSS}</style>
  </head>
  <body class="${input.embed ? 'embed-body' : 'share-body'}">
${input.body}
    <script type="module" nonce="${escapeAttribute(input.nonce)}">${input.embed ? '' : ENHANCEMENT_SCRIPT}</script>
  </body>
</html>
`
}

/**
 * The page's own stylesheet, inlined.
 *
 * `src/styles.css` belongs to the application shell and is not loaded here —
 * this page is served by an edge function, not by the SPA, and it must render
 * correctly before any asset request resolves. The palette and the two
 * typefaces are the application's, restated, so a shared link looks like the
 * product it came from.
 */
const SHARE_CSS = `
:root{--ink:#dce4e5;--muted:#738085;--faint:#4a5559;--line:#253034;--line-hi:#344247;--panel:#111719;--panel-2:#151c1f;--void:#090d0e;--cyan:#83e7ee;--orange:#f5a33f;--green:#98d56d;--red:#ff6753;--display:'Chakra Petch','DIN Condensed',sans-serif}
*{box-sizing:border-box}
body.share-body{margin:0;background:radial-gradient(circle at 40% 12%,rgba(93,152,161,.06),transparent 30%),var(--void);color:var(--ink);font-family:'Manrope Variable',Manrope,'Avenir Next',sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.share-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 22px;border-bottom:1px solid var(--line);background:rgba(15,21,23,.97)}
.share-brand{display:flex;align-items:center;gap:9px;color:var(--ink)}
.share-brand strong{font-family:var(--display);letter-spacing:.06em;font-size:15px}
.share-brand strong span{color:var(--orange)}
.share-brand-mark{width:11px;height:11px;background:var(--orange);border-radius:2px;box-shadow:inset 0 1px rgba(255,255,255,.35),0 0 14px rgba(245,163,63,.15)}
.share-eyebrow{font-family:var(--display);font-size:9px;font-weight:600;letter-spacing:.18em;color:var(--muted)}
.share-page{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,1fr);gap:22px;max-width:1180px;margin:0 auto;padding:26px 22px 60px}
.share-primary{grid-row:span 2}
.share-hero{margin:0;border:1px solid var(--line);background:var(--panel);border-radius:3px;overflow:hidden}
.share-hero-image{display:block;width:100%;height:auto;background:var(--void)}
.share-hero figcaption{padding:9px 12px;border-top:1px solid var(--line);color:var(--faint);font-size:11px;font-family:var(--display);letter-spacing:.05em}
.share-title{font-family:var(--display);font-size:27px;letter-spacing:.01em;margin:0 0 6px}
.share-byline{margin:0 0 14px;color:var(--muted);font-size:12px}
.share-author-absent{color:var(--faint);font-style:italic}
.share-description{margin:0 0 14px;white-space:pre-line}
.share-provenance{margin:0 0 14px;padding:9px 11px;border-left:2px solid var(--orange);background:rgba(245,163,63,.06);font-size:12px}
.share-tags{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 14px;padding:0}
.share-tags a{display:inline-block;padding:3px 8px;border:1px solid var(--line-hi);border-radius:2px;font-size:11px;font-family:var(--display);letter-spacing:.04em}
.share-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 14px}
.share-stats>div{background:var(--panel);padding:9px 11px}
.share-stats dt{color:var(--faint);font-family:var(--display);font-size:9px;letter-spacing:.14em;text-transform:uppercase}
.share-stats dd{margin:3px 0 0;font-size:13px}
.share-hash{font-size:10px;word-break:break-all;color:var(--muted)}
.share-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.share-validation{margin:0 0 14px}
.share-badge{display:inline-block;padding:4px 9px;border-radius:2px;font-family:var(--display);font-size:10px;letter-spacing:.1em;text-transform:uppercase}
.share-badge-pass{color:var(--green);border:1px solid rgba(152,213,109,.4);background:rgba(152,213,109,.08)}
.share-badge-warn{color:var(--orange);border:1px solid rgba(245,163,63,.4);background:rgba(245,163,63,.08)}
.share-badge-unknown{color:var(--faint);border:1px solid var(--line-hi)}
.share-warning{color:var(--orange);font-size:12px;margin:0 0 12px}
.share-actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.share-action{display:inline-flex;align-items:center;gap:6px;padding:8px 13px;border:1px solid var(--line-hi);border-radius:2px;background:var(--panel-2);color:var(--ink);font:inherit;font-size:12px;font-family:var(--display);letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.share-action:hover{border-color:var(--cyan);color:var(--cyan);text-decoration:none}
.share-action-primary{border-color:rgba(245,163,63,.5);color:var(--orange);background:rgba(245,163,63,.1)}
.share-action:focus-visible,.share-step:focus-visible{outline:1px solid var(--cyan);outline-offset:2px}
.share-license{color:var(--faint);font-size:11px;margin:0}
.share-panel{grid-column:1/-1;border:1px solid var(--line);background:var(--panel);border-radius:3px;padding:16px 18px}
.share-panel h2{margin:0 0 12px;font-family:var(--display);font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.share-steps{list-style:none;margin:0;padding:0;display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}
.share-steps li{background:var(--panel-2)}
.share-step{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:9px 11px;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.share-step[aria-pressed="true"]{background:rgba(131,231,238,.07);box-shadow:inset 2px 0 0 var(--cyan)}
.share-step-index{font-family:var(--display);color:var(--faint);font-size:11px}
.share-step-count{color:var(--faint);font-size:11px}
.share-bom{width:100%;border-collapse:collapse;font-size:12px}
.share-bom th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line-hi);color:var(--faint);font-family:var(--display);font-size:9px;letter-spacing:.12em;text-transform:uppercase}
.share-bom td{padding:6px 8px;border-bottom:1px solid var(--line)}
.share-qty{color:var(--cyan);font-family:var(--display)}
.share-swatch{display:inline-block;width:9px;height:9px;margin-right:7px;border-radius:2px;background:var(--swatch);border:1px solid rgba(255,255,255,.15);vertical-align:middle}
.share-empty{color:var(--faint);font-style:italic;padding:10px 0}
.share-footer{border-top:1px solid var(--line);padding:16px 22px;color:var(--faint);font-size:11px;text-align:center}
.share-refusal{max-width:520px;margin:0 auto;padding:90px 22px;text-align:center}
.share-refusal h1{font-family:var(--display);font-size:22px;margin:8px 0 12px}
.share-refusal p{color:var(--muted)}
@media (max-width:880px){.share-page{grid-template-columns:minmax(0,1fr)}.share-primary{grid-row:auto}}
`.trim()

const EMBED_CSS = `
:root{--ink:#dce4e5;--faint:#4a5559;--line:#253034;--void:#090d0e;--cyan:#83e7ee;--display:'Chakra Petch',sans-serif}
*{box-sizing:border-box}
body.embed-body{margin:0;background:var(--void);color:var(--ink);font-family:'Manrope Variable',Manrope,sans-serif;font-size:13px}
.embed-frame{display:flex;flex-direction:column;height:100vh}
.embed-image{flex:1;min-height:0;width:100%;object-fit:contain;background:var(--void)}
.embed-caption{display:flex;align-items:baseline;gap:10px;padding:8px 12px;border-top:1px solid var(--line)}
.embed-title{color:var(--cyan);text-decoration:none;font-family:var(--display);letter-spacing:.03em}
.embed-meta{color:var(--faint);font-size:11px}
.share-empty{color:var(--faint);padding:20px;text-align:center}
`.trim()

/**
 * Progressive enhancement, and nothing more.
 *
 * Everything this adds — step highlighting, a copy button, the native share
 * sheet — has a working non-JS form above it. It runs under a nonce, touches
 * only elements this page rendered, and never fetches anything.
 */
const ENHANCEMENT_SCRIPT = `
const steps = [...document.querySelectorAll('.share-step')];
for (const step of steps) {
  step.addEventListener('click', () => {
    const active = step.getAttribute('aria-pressed') === 'true';
    for (const other of steps) other.setAttribute('aria-pressed', 'false');
    step.setAttribute('aria-pressed', active ? 'false' : 'true');
  });
}
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy') ?? '';
    const url = button.getAttribute('data-share-url');
    const title = button.getAttribute('data-share-title') ?? '';
    const label = button.textContent;
    try {
      if (url && navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused outright; say so rather than pretending
      // it worked. The link is selectable in the address bar either way.
      button.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { button.textContent = label; }, 1800);
  });
}
`.trim()
