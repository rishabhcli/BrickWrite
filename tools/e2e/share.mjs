#!/usr/bin/env node
/**
 * Publish & share acceptance run.
 *
 * Drives the whole surface end to end in a real browser and over real HTTP:
 *
 *   publish → crawl → view → scrub → fork → embed → revoke
 *
 * Two servers are involved, and only one of them is started here. The
 * application comes from BRICKWRIGHT_E2E_URL — `tools/e2e/run-all.mjs` boots it
 * once for every suite. The Cloudflare Pages Functions in `functions/` cannot be
 * served by Vite, so this suite starts the local Pages runner and points it at
 * that same application with `--proxy`. One application boot, one edge process,
 * and the edge process runs the exact modules that deploy to brickwrite.tech.
 *
 * The load-bearing assertion is the crawl: the share page is fetched with
 * `fetch`, not with a browser, and its OpenGraph, Twitter and canonical tags are
 * read out of the raw bytes. A page whose metadata is written by React would
 * fail it.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const appUrl = (process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174').replace(/\/+$/, '')
const edgePort = Number(process.env.SHARE_E2E_PORT ?? 5178)
const edgeUrl = `http://127.0.0.1:${edgePort}`
const dataDirectory = process.env.SHARE_E2E_DATA ?? '.share-e2e'
const publishToken = 'acceptance-publish-token'
const ARTIFACTS = 'artifacts/share'

let edge
const shots = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const started = Date.now()
/** Progress, with elapsed time: a hung gate is otherwise indistinguishable. */
const step = (message) => process.stdout.write(`[${String(Date.now() - started).padStart(6)}ms] ${message}\n`)

const reachable = async (url) => {
  try {
    await fetch(url)
    return true
  } catch {
    return false
  }
}

async function waitFor(url, what, deadlineMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (await reachable(url)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${what} at ${url}`)
}

async function shot(page, name) {
  const path = `${ARTIFACTS}/e2e-${name}.png`
  await page.screenshot({ path, fullPage: false })
  shots.push(path)
}

/** Reads a meta tag out of raw HTML — no DOM, no JavaScript. */
function meta(html, selector) {
  const pattern = new RegExp(`<meta[^>]+${selector}[^>]*>`, 'i')
  const tag = pattern.exec(html)?.[0]
  if (!tag) return null
  return /content="([^"]*)"/i.exec(tag)?.[1] ?? null
}

function linkHref(html, rel) {
  const tag = new RegExp(`<link[^>]+rel="${rel}"[^>]*>`, 'i').exec(html)?.[0]
  return tag ? (/href="([^"]*)"/i.exec(tag)?.[1] ?? null) : null
}

try {
  await mkdir(ARTIFACTS, { recursive: true })
  // A fresh namespace per run: the immutability and revocation assertions are
  // about *this* publication, and a leftover one from a previous run would make
  // a stale pass possible.
  await rm(dataDirectory, { recursive: true, force: true })

  step('waiting for the application server')
  await waitFor(appUrl, 'the application server')

  edge = spawn(
    process.execPath,
    ['functions/_dev/server.mjs', '--port', String(edgePort), '--data', dataDirectory, '--proxy', appUrl],
    { stdio: 'ignore', env: { ...process.env, SHARE_PUBLISH_TOKEN: publishToken, SHARE_ORIGIN: edgeUrl } },
  )
  await waitFor(`${edgeUrl}/share/does-not-exist`, 'the Pages Functions runner')
  step('edge runner up')

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const consoleErrors = []
  page.on('console', (message) => {
    // Vite's HMR socket cannot traverse the Pages-runner proxy, and says so
    // once on every page load. That is an artifact of the local topology, not
    // of the application, so it is not counted as a page error.
    if (message.type() === 'error' && !/websocket|vite/i.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (cause) => consoleErrors.push(cause.message))

  // == 1. publish ===========================================================
  // Share Studio, against the real compiled catalog and real LDraw geometry,
  // rendering real cards in the browser and posting them to the edge.
  await page.goto(
    `${edgeUrl}/src/features/share/dev/studio.html?view=studio&token=${publishToken}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.locator('[data-testid="harness-ready"]').waitFor({ timeout: 180_000 })
  step('harness ready')

  const harness = page.locator('[data-testid="harness-ready"]')
  const catalogVersion = await harness.getAttribute('data-catalog')
  const revision = Number(await harness.getAttribute('data-revision'))
  assert(catalogVersion && catalogVersion !== 'unloaded', 'The harness started without a compiled catalog')
  assert(Number.isInteger(revision), 'The harness did not report a document revision')

  await page.locator('[data-testid="studio-preview"]').waitFor({ timeout: 60_000 })
  // The preview is the artifact: assert it drew something rather than a blank.
  const previewInk = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="studio-preview"]')
    const context = canvas.getContext('2d')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let distinct = new Set()
    for (let index = 0; index < data.length; index += 4 * 97) distinct.add(`${data[index]},${data[index + 1]},${data[index + 2]}`)
    return distinct.size
  })
  assert(previewInk > 12, `Share Studio's preview looks blank (${previewInk} distinct samples)`)
  await shot(page, 'studio')
  step('studio preview drawn')

  // Exercise the controls the studio actually ships, then publish public with
  // fork, download and embed enabled.
  await page.locator('[data-testid="preset-blueprint"]').click()
  await page.locator('[data-testid="preset-studio"]').click()
  await page.locator('[data-testid="crop-square"]').click()
  await page.locator('[data-testid="crop-opengraph"]').click()
  await page.locator('[data-testid="slider-yaw"]').fill('24')
  await page.locator('[data-testid="publish-title"]').fill('Survey Rover')
  await page
    .locator('[data-testid="publish-description"]')
    .fill('A brick-built survey rover assembled from real LDraw parts at exact LDU transforms.')
  await page.locator('[data-testid="publish-tags"]').fill('rover technic showcase')
  await page.locator('[data-testid="visibility-public"]').click()
  for (const capability of ['fork', 'download', 'embed']) {
    const box = page.locator(`[data-testid="capability-${capability}"]`)
    if (!(await box.isChecked())) await box.check()
  }
  await shot(page, 'studio-configured')

  await page.locator('[data-testid="publish-button"]').click()
  step('publishing (renders six full-size crops in the browser)')
  await page.locator('[data-testid="published-link"]').waitFor({ timeout: 300_000 })
  step('published')
  const publishedHref = await page.locator('[data-testid="published-link"]').getAttribute('href')
  const slug = publishedHref.split('/share/')[1]
  assert(/^[a-z0-9][a-z0-9-]*$/.test(slug), `Published to an unusable slug: ${slug}`)
  process.stdout.write(`published ${slug} at revision ${revision}\n`)
  await shot(page, 'published')

  // == 2. crawl, with no JavaScript at all ==================================
  step('crawling the share page with no JavaScript')
  const crawled = await fetch(`${edgeUrl}/share/${slug}`, { headers: { 'User-Agent': 'acceptance-crawler' } })
  assert(crawled.ok, `The share page returned ${crawled.status}`)
  const html = await crawled.text()

  const tags = {
    title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? null,
    canonical: linkHref(html, 'canonical'),
    ogTitle: meta(html, 'property="og:title"'),
    ogDescription: meta(html, 'property="og:description"'),
    ogImage: meta(html, 'property="og:image"'),
    ogUrl: meta(html, 'property="og:url"'),
    ogType: meta(html, 'property="og:type"'),
    twitterCard: meta(html, 'name="twitter:card"'),
    twitterTitle: meta(html, 'name="twitter:title"'),
    twitterImage: meta(html, 'name="twitter:image"'),
    robots: meta(html, 'name="robots"'),
  }
  for (const [name, value] of Object.entries(tags)) {
    assert(value, `The crawled share page has no ${name}`)
  }
  assert(tags.ogTitle === 'Survey Rover', `og:title is "${tags.ogTitle}"`)
  assert(tags.canonical === `${edgeUrl}/share/${slug}`, `canonical is "${tags.canonical}"`)
  assert(tags.ogUrl === tags.canonical, 'og:url and canonical disagree')
  assert(tags.twitterCard === 'summary_large_image', `twitter:card is "${tags.twitterCard}"`)
  assert(tags.robots.startsWith('index'), `a public page must be indexable, robots is "${tags.robots}"`)
  // The parts list and the build sequence are in the bytes too, not just the tags.
  assert(html.includes('Build sequence'), 'The crawled page has no build sequence')
  assert(html.includes('Parts list'), 'The crawled page has no parts list')
  assert(html.includes('Edit a copy'), 'The crawled page has no fork action')
  assert(html.includes(`Rendered from revision ${revision}`), 'The page does not state the published revision')

  // Security headers on the same response.
  const csp = crawled.headers.get('content-security-policy') ?? ''
  assert(csp.includes("frame-ancestors 'none'"), `share page CSP is "${csp}"`)
  assert(!csp.includes('unsafe-inline'), 'share page CSP allows unsafe-inline')
  assert(crawled.headers.get('x-frame-options') === 'DENY', 'share page is framable')
  assert(crawled.headers.get('x-content-type-options') === 'nosniff', 'share page can be sniffed')

  // == 3. og:image is a real render of the published revision ===============
  step('fetching og:image')
  const card = await fetch(tags.ogImage)
  assert(card.ok, `og:image returned ${card.status}`)
  assert(card.headers.get('content-type') === 'image/png', `og:image is ${card.headers.get('content-type')}`)
  const cardBytes = new Uint8Array(await card.arrayBuffer())
  assert(cardBytes.byteLength > 20_000, `og:image is only ${cardBytes.byteLength} bytes`)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  assert(signature.every((byte, index) => cardBytes[index] === byte), 'og:image is not a PNG')
  const width = new DataView(cardBytes.buffer).getUint32(16)
  const height = new DataView(cardBytes.buffer).getUint32(20)
  assert(width === 1200 && height === 630, `og:image is ${width}x${height}, not 1200x630`)
  await writeFile(`${ARTIFACTS}/e2e-og-image.png`, cardBytes)

  // Served immutably, and a conditional request is answered without the bytes.
  assert(
    (card.headers.get('cache-control') ?? '').includes('immutable'),
    'a content-addressed card is not served immutably',
  )
  const conditional = await fetch(tags.ogImage, { headers: { 'If-None-Match': card.headers.get('etag') } })
  assert(conditional.status === 304, `a matching ETag returned ${conditional.status}`)

  // The publication states which revision it captured, and its own hash.
  const summary = await (await fetch(`${edgeUrl}/share/${slug}/summary.json`, { headers: { Accept: 'application/json' } })).json()
  assert(summary.revision === revision, `summary says revision ${summary.revision}, expected ${revision}`)
  assert(/^[0-9a-f]{64}$/.test(summary.contentHash), 'the publication has no content hash')
  const publishedHash = summary.contentHash

  // == 4. view and scrub ====================================================
  await page.goto(`${edgeUrl}/src/features/share/dev/studio.html?view=share&slug=${slug}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.locator('[data-testid="shared-viewer"]').waitFor({ timeout: 180_000 })
  step('viewer mounted')
  await page.locator('[data-testid="share-viewer-canvas"]').waitFor()

  const partCount = Number(await page.locator('[data-testid="part-count"]').innerText())
  assert(partCount > 20, `the viewer reports ${partCount} parts`)
  assert(
    (await page.locator('[data-testid="validation-badge"]').innerText()).length > 0,
    'the viewer shows no validation badge',
  )
  await shot(page, 'viewer')

  // Orbit from the keyboard, and confirm the pixels actually changed.
  const canvas = page.locator('[data-testid="share-viewer-canvas"]')
  const sampleCanvas = () =>
    page.evaluate(() => {
      const element = document.querySelector('[data-testid="share-viewer-canvas"]')
      const { data } = element.getContext('2d').getImageData(0, 0, element.width, element.height)
      let total = 0
      for (let index = 0; index < data.length; index += 4 * 31) total += data[index] + data[index + 1] * 2
      return total
    })
  const beforeOrbit = await sampleCanvas()
  await canvas.focus()
  for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  assert((await canvas.getAttribute('data-yaw')) === '30', 'keyboard orbit did not move the camera')
  assert((await sampleCanvas()) !== beforeOrbit, 'orbiting did not change a single pixel')
  await shot(page, 'viewer-orbited')

  // Scrub the build sequence.
  await page.locator('[data-testid="step-1"]').click()
  await page.waitForTimeout(250)
  assert((await canvas.getAttribute('data-step')) === '1', 'the scrubber did not select step 1')
  const atStepOne = await sampleCanvas()
  await page.locator('[data-testid="step-forward"]').click()
  await page.waitForTimeout(250)
  assert((await canvas.getAttribute('data-step')) === '2', 'the scrubber did not advance')
  assert((await sampleCanvas()) !== atStepOne, 'advancing a step did not change the render')
  const stepLabel = await page.locator('[data-testid="step-label"]').innerText()
  assert(/Step 2 of \d+/.test(stepLabel), `the step label reads "${stepLabel}"`)
  await shot(page, 'viewer-step')

  // Exploded view.
  await page.locator('[data-testid="explode-slider"]').fill('0.7')
  await page.waitForTimeout(300)
  await page.locator('[data-testid="step-all"]').click()
  await page.waitForTimeout(300)
  await shot(page, 'viewer-exploded')

  // == 5. fork ==============================================================
  step('forking')
  await page.locator('[data-testid="fork-button"]').click()
  await page.locator('[data-testid="fork-notice"]').waitFor({ timeout: 30_000 })
  const forkNotice = await page.locator('[data-testid="fork-notice"]').innerText()
  assert(/Saved/.test(forkNotice), `the fork reported: ${forkNotice}`)

  // The fork is a genuinely new project in local storage, and it did not
  // overwrite anything belonging to the publication.
  const projects = await page.evaluate(async () => {
    const open = indexedDB.open('brickwright', 2)
    const database = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
      open.onupgradeneeded = () => undefined
    })
    const request = database.transaction('checkpoints', 'readonly').objectStore('checkpoints').getAll()
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result.map((entry) => ({ id: entry.projectId, revision: entry.revision, parts: Object.keys(entry.document.parts).length, notes: entry.document.notes.length })))
      request.onerror = () => reject(request.error)
    })
  })
  assert(projects.length === 1, `expected exactly one forked project, found ${projects.length}`)
  assert(projects[0].id.startsWith('prj_'), `the fork has id ${projects[0].id}`)
  assert(projects[0].parts === partCount, `the fork has ${projects[0].parts} parts, the publication has ${partCount}`)
  assert(projects[0].notes === 0, 'the fork inherited notes that were never published')
  await shot(page, 'forked')

  // Forking must not have touched the publication.
  const afterFork = await (await fetch(`${edgeUrl}/share/${slug}/summary.json`, { headers: { Accept: 'application/json' } })).json()
  assert(afterFork.contentHash === publishedHash, 'the publication changed when it was forked')

  // == 6. embed =============================================================
  step('embed headers')
  const embed = await fetch(`${edgeUrl}/embed/${slug}`)
  assert(embed.ok, `the embed returned ${embed.status}`)
  const embedCsp = embed.headers.get('content-security-policy') ?? ''
  assert(embedCsp.includes('frame-ancestors https:'), `embed CSP is "${embedCsp}"`)
  assert(!embed.headers.get('x-frame-options'), 'the embed sets X-Frame-Options, which cannot express an allowlist')
  assert((embed.headers.get('x-robots-tag') ?? '').includes('noindex'), 'the embed is indexable')

  // == 7. unlisted tokens ===================================================
  step('unlisted tokens')
  const authorised = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${publishToken}` }
  await fetch(`${edgeUrl}/publications/${slug}/access`, {
    method: 'POST',
    headers: authorised,
    body: JSON.stringify({ visibility: 'unlisted' }),
  })
  assert((await fetch(`${edgeUrl}/share/${slug}`)).status === 404, 'an unlisted page opened without a token')

  const minted = await (
    await fetch(`${edgeUrl}/publications/${slug}/tokens`, {
      method: 'POST',
      headers: authorised,
      body: JSON.stringify({ label: 'acceptance link', scope: { view: true, comment: false, fork: false, download: false, embed: false } }),
    })
  ).json()
  assert(typeof minted.token === 'string' && minted.token.includes('.'), 'no token was minted')
  assert(!('secretHash' in minted.record) || minted.record.secretHash === undefined, 'the mint response leaked the stored hash')

  const withToken = await fetch(`${edgeUrl}/share/${slug}?t=${encodeURIComponent(minted.token)}`)
  assert(withToken.ok, `a valid token returned ${withToken.status}`)
  const unlistedHtml = await withToken.text()
  assert(meta(unlistedHtml, 'name="robots"').startsWith('noindex'), 'an unlisted page is indexable')
  assert(!unlistedHtml.includes(minted.token.split('.')[1]), 'the unlisted page echoed the token secret')
  // The token's scope withheld forking, so the action must be absent.
  assert(!unlistedHtml.includes('Edit a copy'), 'a view-only link offered the fork action')

  const [tokenId] = minted.token.split('.')
  const wrongToken = await fetch(`${edgeUrl}/share/${slug}?t=${tokenId}.${'A'.repeat(43)}`)
  assert(wrongToken.status === 404, `a forged token returned ${wrongToken.status}`)

  const expired = await (
    await fetch(`${edgeUrl}/publications/${slug}/tokens`, {
      method: 'POST',
      headers: authorised,
      body: JSON.stringify({ label: 'already expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
    })
  ).json()
  const expiredResponse = await fetch(`${edgeUrl}/share/${slug}?t=${encodeURIComponent(expired.token)}`)
  assert(expiredResponse.status === 410, `an expired token returned ${expiredResponse.status}`)

  await fetch(`${edgeUrl}/publications/${slug}/tokens/${tokenId}/revoke`, { method: 'POST', headers: authorised, body: '{}' })
  const afterRevokeToken = await fetch(`${edgeUrl}/share/${slug}?t=${encodeURIComponent(minted.token)}`)
  assert(afterRevokeToken.status === 404, `a revoked token returned ${afterRevokeToken.status}`)

  // == 8. revoke the publication ============================================
  await fetch(`${edgeUrl}/publications/${slug}/access`, {
    method: 'POST',
    headers: authorised,
    body: JSON.stringify({ visibility: 'public' }),
  })
  assert((await fetch(`${edgeUrl}/share/${slug}`)).ok, 'the publication did not come back when made public again')

  step('revoking')
  await fetch(`${edgeUrl}/publications/${slug}/revoke`, { method: 'POST', headers: authorised, body: '{}' })
  const revoked = await fetch(`${edgeUrl}/share/${slug}`)
  assert(revoked.status === 410, `a revoked publication returned ${revoked.status}`)
  assert((await fetch(tags.ogImage)).status === 410, 'a revoked publication still serves its card')
  assert((await fetch(`${edgeUrl}/embed/${slug}`)).status === 410, 'a revoked publication is still embeddable')

  await page.goto(`${edgeUrl}/share/${slug}`, { waitUntil: 'domcontentloaded' })
  await shot(page, 'revoked')

  // The gallery is empty once the only publication is withdrawn — and says so.
  const feed = await (await fetch(`${edgeUrl}/publications`, { headers: { Accept: 'application/json' } })).json()
  assert(feed.entries.length === 0, `the gallery still lists ${feed.entries.length} revoked publication(s)`)

  assert(consoleErrors.length === 0, `browser console errors:\n${consoleErrors.join('\n')}`)
  await browser.close()

  process.stdout.write('\n=== share acceptance ===\n')
  process.stdout.write(`slug              ${slug}\n`)
  process.stdout.write(`revision          ${revision}\n`)
  process.stdout.write(`content hash      ${publishedHash}\n`)
  process.stdout.write(`og:image          ${width}x${height}, ${cardBytes.byteLength} bytes\n`)
  process.stdout.write(`crawled title     ${tags.title}\n`)
  process.stdout.write(`canonical         ${tags.canonical}\n`)
  process.stdout.write(`screenshots       ${shots.length} in ${ARTIFACTS}/\n`)
  process.stdout.write('publish, crawl, view, scrub, fork, embed, token and revoke gates all passed\n')
} catch (cause) {
  process.stderr.write(`\nshare acceptance failed: ${cause?.stack ?? cause}\n`)
  process.exitCode = 1
} finally {
  edge?.kill()
}
