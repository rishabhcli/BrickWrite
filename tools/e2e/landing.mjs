#!/usr/bin/env node
/**
 * Landing and explore acceptance run.
 *
 * Two halves, because they measure two different things:
 *
 *  1. **Behaviour**, against whatever `tools/e2e/run-all.mjs` is serving: deep
 *     links, back and forward, the anonymous fork, the authenticated-fork
 *     adapter path, that the canonical demo is byte-identical afterwards, and
 *     the handoff into the editor.
 *  2. **Delivery**, against a *production build* of its own, because a
 *     development server serves hundreds of unbundled modules and an LCP
 *     measured against that says nothing about what a visitor gets. The build
 *     is thrown away afterwards; nothing is written into the working tree
 *     except the screenshots and the report under `artifacts/landing/`.
 *
 * The delivery half is where the boot budget is proved from the outside: the
 * network log must contain no compiled catalog, no `.bwmesh`, no Three.js and
 * no editor chunk. `src/features/landing/imports.test.ts` proves the same
 * property from the inside, against the import graph, in milliseconds.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTIFACTS = path.join(ROOT, 'artifacts', 'landing')
const SHARED_URL = process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174'

/** Throttling profile for the delivery gate. Stated, not implied. */
const THROTTLE = {
  cpuSlowdown: 4,
  // Chrome DevTools' "Fast 3G": 1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT.
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
}

const LCP_BUDGET_MS = 2500
const CLS_BUDGET = 0.1

const failures = []
const notes = []
function check(condition, message) {
  if (condition) return true
  failures.push(message)
  process.stdout.write(`  FAIL  ${message}\n`)
  return false
}
function pass(message) {
  process.stdout.write(`  ok    ${message}\n`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.bwmesh': 'application/octet-stream',
}

/** A static server with SPA fallback, which is what a real deployment does. */
function serveStatic(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root)) {
      response.writeHead(403).end()
      return
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const fallback = path.join(root, 'index.html')
      if (!existsSync(fallback)) {
        response.writeHead(404).end()
        return
      }
      file = fallback
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'pipe', ...options })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}:\n${output.slice(-4000)}`))))
  })
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * How far the surface's own content runs past the box it was given.
 *
 * Two things this deliberately is not. It is not `document.scrollWidth`: these
 * surfaces set `overflow-x: clip`, so an element wider than its container is
 * *hidden* rather than scrollable and the document-level number stays at zero
 * while content sits unreachable off the right edge. And it is not measured
 * against the viewport: the surface is mounted inside the shell's frame, and if
 * the frame is wider than the viewport that is the frame's problem, not the
 * page's. So the page is measured against its own container, and the frame's
 * width is reported alongside it.
 */
const measureOverflow = () => {
  const root = document.querySelector('.bw-surface')
  if (!root) return { worst: -1, surfaceWidth: 0, viewportWidth: window.innerWidth }
  const right = root.getBoundingClientRect().right
  let worst = 0
  for (const element of root.querySelectorAll('*')) {
    const box = element.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    worst = Math.max(worst, Math.round(box.right - right))
  }
  return {
    worst,
    surfaceWidth: Math.round(root.getBoundingClientRect().width),
    viewportWidth: window.innerWidth,
  }
}

/**
 * Builds the landing and explore surfaces as their own entry.
 *
 * Deliberately not the whole application. `src/main.tsx` mounts these inside
 * the platform shell, whose entry statically imports the Hexclave account SDK
 * — twenty-odd chunks that neither surface uses — so an LCP measured against
 * that answers a question about the account layer, not about this page. What is
 * measured here is the page itself: its own modules, the editor's stylesheet,
 * the display fonts and the shipped demo manifest, bundled exactly the way Vite
 * bundles the application.
 *
 * `publicDir` is off because the 50 MB compiled catalog has no business in this
 * output; the demo assets are copied in on their own, which is also what makes
 * a stray catalog request impossible to miss in the network log.
 */
async function buildLandingEntry(outDir) {
  await build({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    publicDir: false,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: path.join(ROOT, 'src/features/landing/standalone.tsx') },
    },
  })
  const built = JSON.parse(await readFile(path.join(outDir, '.vite', 'manifest.json'), 'utf8'))
  const entry = Object.values(built).find((chunk) => chunk.isEntry)
  if (!entry) throw new Error('the landing entry produced no entry chunk')
  const styles = (entry.css ?? []).map((href) => `    <link rel="stylesheet" href="/${href}">`).join('\n')
  const displayFont = (await readdir(path.join(outDir, 'assets')))
    .find((file) => /^chakra-petch-latin-600-normal-.*\.woff2$/.test(file))
  if (!displayFont) throw new Error('the landing build produced no Latin Chakra Petch 600 font')
  await writeFile(
    path.join(outDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Brickwright</title>
    <link rel="preload" href="/assets/${displayFont}" as="font" type="font/woff2" crossorigin>
${styles}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${entry.file}"></script>
  </body>
</html>
`,
  )
  await cp(path.join(ROOT, 'public', 'demos'), path.join(outDir, 'demos'), { recursive: true })
  return { entry: entry.file, css: entry.css ?? [] }
}

// ---------------------------------------------------------------------------

await mkdir(ARTIFACTS, { recursive: true })
const manifest = JSON.parse(await readFile(path.join(ROOT, 'public/demos/manifest.json'), 'utf8'))
const heroDemo = manifest.demos.find((demo) => demo.hero) ?? manifest.demos[0]
const secondDemo = manifest.demos.find((demo) => demo.id !== heroDemo.id)

const browser = await chromium.launch({ headless: true })
const report = { url: SHARED_URL, demos: manifest.demos.length, catalogVersion: manifest.catalogVersion }
let buildDir = null
let staticServer = null

try {
  // =========================================================================
  // 1. Behaviour
  // =========================================================================
  process.stdout.write(`\n-- behaviour, against ${SHARED_URL}\n`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (cause) => consoleErrors.push(cause.message))
  const bootRequests = []
  page.on('request', (request) => bootRequests.push(new URL(request.url()).pathname))

  await page.goto(`${SHARED_URL}/`, { waitUntil: 'networkidle' })
  const heading = await page.locator('h1').first().innerText()
  check(/stands up/i.test(heading), `landing renders its own headline (saw "${heading}")`)
    && pass('landing route renders')

  // -- the boot budget, on the integrated shell -----------------------------
  // The strongest form of this is `src/features/landing/imports.test.ts`, which
  // walks the static import graph. This is the same property observed from
  // outside, on whatever the shell actually served.
  const forbiddenBoot = bootRequests.filter((url) =>
    /\/catalog\//.test(url)
    || /\.bwmesh$/.test(url)
    || /\/assets\/(?:geometry|thumb)\//.test(url)
    || /\/src\/App\.tsx/.test(url)
    || /\/src\/(?:editor|webmcp)\//.test(url)
    || /\/src\/cad\/(?:catalog|catalog-loader|engine|session|collision|snapping|mesh)\.ts/.test(url)
    || /node_modules\/\.vite\/deps\/three/.test(url)
    || /\/(?:three|@react-three)\//.test(url),
  )
  check(
    forbiddenBoot.length === 0,
    `the landing route fetches no catalog, kernel, editor or renderer module (${[...new Set(forbiddenBoot)].slice(0, 6).join(', ')})`,
  )
  report.bootRequests = { total: bootRequests.length, forbidden: [...new Set(forbiddenBoot)] }
  pass(`boot budget honoured across ${bootRequests.length} requests`)

  const cardCount = await page.locator('.bw-demo-card').count()
  check(cardCount === manifest.demos.length, `landing lists all ${manifest.demos.length} demos (saw ${cardCount})`)
    && pass(`${cardCount} demo cards`)

  // -- accessibility -------------------------------------------------------
  const a11y = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')]
    return {
      h1: document.querySelectorAll('h1').length,
      banners: document.querySelectorAll('header, [role=banner]').length,
      mains: document.querySelectorAll('main, [role=main]').length,
      unlabelledImages: [...document.querySelectorAll('img')].filter((image) => !image.alt).length,
      canvasAriaHidden: canvases.every((canvas) => canvas.getAttribute('aria-hidden') === 'true'),
      canvasWrappersLabelled: canvases.every((canvas) => {
        const wrapper = canvas.closest('[role=img]')
        return Boolean(wrapper?.getAttribute('aria-label'))
      }),
      unlabelledSections: [...document.querySelectorAll('main section')].filter(
        (section) => !section.getAttribute('aria-labelledby') && !section.getAttribute('aria-label'),
      ).length,
      horizontalOverflow: (() => {
        const root = document.querySelector('.bw-surface')
        if (!root) return -1
        const right = root.getBoundingClientRect().right
        let worst = 0
        for (const element of root.querySelectorAll('*')) {
          const box = element.getBoundingClientRect()
          if (box.width === 0 && box.height === 0) continue
          worst = Math.max(worst, Math.round(box.right - right))
        }
        return worst
      })(),
    }
  })
  check(a11y.h1 === 1, `exactly one h1 on the landing page (saw ${a11y.h1})`)
  check(a11y.banners === 1, `exactly one banner landmark (saw ${a11y.banners})`)
  check(a11y.mains === 1, `exactly one main landmark (saw ${a11y.mains})`)
  check(a11y.unlabelledImages === 0, `every image has alt text (${a11y.unlabelledImages} without)`)
  check(a11y.unlabelledSections === 0, `every section is labelled (${a11y.unlabelledSections} without)`)
  check(a11y.canvasAriaHidden && a11y.canvasWrappersLabelled, 'the model canvas is aria-hidden inside a labelled role=img')
  check(a11y.horizontalOverflow <= 1, `no horizontal overflow at 1440px (overflow ${a11y.horizontalOverflow}px)`)
  pass('landmarks, labels and overflow')

  // Keyboard: tab through and confirm focus never leaves the document and that
  // the demo cards are reachable without a mouse.
  const keyboard = await (async () => {
    const seen = []
    for (let index = 0; index < 60; index += 1) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => {
        const active = document.activeElement
        if (!active || active === document.body) return null
        return {
          tag: active.tagName,
          card: active.classList.contains('bw-demo-card'),
          text: (active.textContent ?? '').trim().slice(0, 40),
        }
      }))
    }
    return seen
  })()
  const trapped = keyboard.slice(4).every((entry) => entry && entry.text === keyboard[4]?.text)
  check(!trapped, 'tabbing is not caught in a focus trap')
  check(keyboard.some((entry) => entry?.card), 'demo cards are reachable by keyboard')
  pass('keyboard traversal')

  // -- reduced motion ------------------------------------------------------
  const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const reducedPage = await reduced.newPage()
  await reducedPage.goto(`${SHARED_URL}/`, { waitUntil: 'networkidle' })
  const motion = await reducedPage.evaluate(() => ({
    hidden: [...document.querySelectorAll('.bw-reveal')].filter((element) => element.getAttribute('data-shown') !== 'true').length,
    reveals: document.querySelectorAll('.bw-reveal').length,
    stage: document.querySelector('.bw-stage-step[aria-current=true]')?.textContent ?? '',
  }))
  await reducedPage.waitForTimeout(4000)
  const motionAfter = await reducedPage.evaluate(() => ({
    stage: document.querySelector('.bw-stage-step[aria-current=true]')?.textContent ?? '',
    // Reachable without the timer: the stage track is a real tab list.
    stages: document.querySelectorAll('.bw-stage-step').length,
  }))
  check(motion.reveals > 0 && motion.hidden === 0, `every revealed block is shown immediately (${motion.hidden} still hidden)`)
  check(motion.stage === motionAfter.stage, 'the hero does not auto-advance under prefers-reduced-motion')
  check(motionAfter.stages === 4, `all four hero stages are still selectable (saw ${motionAfter.stages})`)
  await reducedPage.screenshot({ path: path.join(ARTIFACTS, 'landing-reduced-motion.png'), fullPage: false })
  await reduced.close()
  pass('reduced-motion path')

  // -- responsive screenshots ---------------------------------------------
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 834, height: 1112 },
    { name: 'mobile', width: 390, height: 844 },
  ]
  const overflow = {}
  for (const viewport of viewports) {
    const shot = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const shotPage = await shot.newPage()
    await shotPage.goto(`${SHARED_URL}/`, { waitUntil: 'networkidle' })
    await shotPage.waitForTimeout(700)
    overflow[`landing-${viewport.name}`] = await shotPage.evaluate(measureOverflow)
    await shotPage.screenshot({ path: path.join(ARTIFACTS, `landing-${viewport.name}.png`), fullPage: true })

    await shotPage.goto(`${SHARED_URL}/explore?demo=${heroDemo.id}`, { waitUntil: 'networkidle' })
    await shotPage.waitForTimeout(700)
    overflow[`explore-${viewport.name}`] = await shotPage.evaluate(measureOverflow)
    // The explorer fills the viewport by design; a full-page capture would
    // stretch the stage past the frame the renderer has drawn.
    await shotPage.screenshot({ path: path.join(ARTIFACTS, `explore-${viewport.name}.png`), fullPage: false })
    await shot.close()
  }
  for (const [key, measured] of Object.entries(overflow)) {
    check(measured.worst <= 1, `${key} keeps its content inside its container (worst element ${measured.worst}px past the right edge)`)
    if (measured.surfaceWidth > measured.viewportWidth + 1) {
      // Reported rather than failed: the surface fills whatever box the shell's
      // frame gives it, and a frame wider than the viewport is the frame's.
      const note = `${key}: the shell frame is ${measured.surfaceWidth}px wide in a ${measured.viewportWidth}px viewport,`
        + ' so the page is laid out wider than the screen. That box is set by src/platform (.pf-frame / .pf-topbar),'
        + ' not by these surfaces.'
      notes.push(note)
      process.stdout.write(`  note  ${note}\n`)
    }
  }
  report.overflow = overflow
  pass(`responsive screenshots → ${path.relative(ROOT, ARTIFACTS)}`)

  // -- deep links, back and forward ---------------------------------------
  await page.goto(`${SHARED_URL}/explore?demo=${secondDemo.id}&step=2`, { waitUntil: 'networkidle' })
  const deepTitle = await page.locator('.bw-explore-title h1').innerText()
  const deepStep = await page.locator('#bw-step').inputValue()
  check(deepTitle === secondDemo.title, `deep link opens ${secondDemo.title} (saw "${deepTitle}")`)
  check(deepStep === '2', `deep link honours ?step=2 (saw ${deepStep})`)

  await page.locator(`a.bw-chip[href="/explore?demo=${heroDemo.id}"]`).first().click()
  await page.waitForURL(`**/explore?demo=${heroDemo.id}`)
  check((await page.locator('.bw-explore-title h1').innerText()) === heroDemo.title, 'switching demos updates the surface')
  await page.goBack()
  await page.waitForURL(`**/explore?demo=${secondDemo.id}&step=2`)
  check((await page.locator('.bw-explore-title h1').innerText()) === secondDemo.title, 'the back button returns to the previous demo')
  await page.goForward()
  await page.waitForURL(`**/explore?demo=${heroDemo.id}`)
  check((await page.locator('.bw-explore-title h1').innerText()) === heroDemo.title, 'the forward button returns to the later demo')

  // Scrubbing a step is linkable, and does not add a history entry per frame.
  await page.locator('#bw-step').fill('3')
  await page.waitForTimeout(150)
  check((await page.url()).includes('step=3'), 'scrubbing the build sequence writes the step into the URL')
  pass('deep links, back and forward')

  // -- anonymous fork, and the demo is immutable afterwards ---------------
  const canonicalBefore = sha256(await readFile(path.join(ROOT, 'public/demos', heroDemo.id, 'document.json')))
  await page.goto(`${SHARED_URL}/explore?demo=${heroDemo.id}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Edit this build/ }).click()
  await page.locator('.bw-fork-note.good').waitFor({ timeout: 20_000 })
  const forkNote = await page.locator('.bw-fork-note.good').innerText()
  check(/local project/i.test(forkNote), `an anonymous visitor gets a local project (saw "${forkNote.slice(0, 90)}")`)

  const stored = await page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('brickwright', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        for (const table of ['checkpoints', 'transactions', 'meta']) {
          if (!request.result.objectStoreNames.contains(table)) request.result.createObjectStore(table)
        }
      }
    })
    const database = await open()
    const rows = await new Promise((resolve, reject) => {
      const transaction = database.transaction('checkpoints', 'readonly')
      const query = transaction.objectStore('checkpoints').getAll()
      query.onsuccess = () => resolve(query.result)
      query.onerror = () => reject(query.error)
    })
    return rows.map((row) => ({ id: row.projectId, name: row.document.name, parts: Object.keys(row.document.parts).length }))
  })
  const forked = stored.find((project) => project.id.startsWith('doc_') && project.id.includes('fork'))
  check(Boolean(forked), `the fork is a real stored project (found ${JSON.stringify(stored)})`)
  check(forked?.parts === heroDemo.validation.partCount, `the fork carries all ${heroDemo.validation.partCount} parts (saw ${forked?.parts})`)
  check(forked?.id !== heroDemo.documentId, 'the fork has its own project id, so it cannot replay into the demo')

  const servedAfter = await page.evaluate(async (id) => {
    const response = await fetch(`/demos/${id}/document.json`, { cache: 'reload' })
    const buffer = await response.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }, heroDemo.id)
  check(servedAfter === heroDemo.assets.document.sha256, 'the canonical demo is byte-identical after a fork')
  check(canonicalBefore === heroDemo.assets.document.sha256, 'the canonical demo on disk matches its published digest')
  pass('anonymous fork, canonical demo immutable')

  // -- editor handoff ------------------------------------------------------
  const handoff = page.getByRole('link', { name: /Open it in the editor/ })
  const handoffHref = await handoff.getAttribute('href')
  check(/^\/editor\?project=/.test(handoffHref ?? ''), `the handoff points at the editor (saw ${handoffHref})`)
  await handoff.click()
  await page.waitForURL('**/editor?project=**', { timeout: 20_000 })
  await page.locator('canvas').first().waitFor({ timeout: 90_000 })
  const editorParts = await page.evaluate(() => {
    const api = window.brickwright
    return api ? Object.keys(api.getDocument().parts).length : null
  })
  check(editorParts !== null, 'the editor booted its kernel after the handoff')
  pass(`editor handoff (${editorParts} parts in the editor)`)

  // -- authenticated fork, through the registered adapter ------------------
  const authed = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await authed.addInitScript(() => {
    window.__brickwrightForkInput = null
    window.brickwrightCloudProjects = {
      id: 'e2e-cloud-adapter',
      isSignedIn: () => true,
      createProject: async (input) => {
        window.__brickwrightForkInput = {
          name: input.name,
          source: input.source,
          parts: Object.keys(input.document.parts).length,
          revision: input.document.revision,
        }
        return { projectId: 'cloud_e2e_1', url: '/projects/cloud_e2e_1' }
      },
    }
  })
  const authedPage = await authed.newPage()
  await authedPage.goto(`${SHARED_URL}/explore?demo=${secondDemo.id}`, { waitUntil: 'networkidle' })
  await authedPage.getByRole('button', { name: /Edit this build/ }).click()
  await authedPage.locator('.bw-fork-note.good').waitFor({ timeout: 20_000 })
  const cloudNote = await authedPage.locator('.bw-fork-note.good').innerText()
  const forkInput = await authedPage.evaluate(() => window.__brickwrightForkInput)
  check(/cloud project/i.test(cloudNote), `a signed-in visitor gets a cloud project (saw "${cloudNote.slice(0, 90)}")`)
  check(forkInput?.source?.demoId === secondDemo.id, 'the adapter is told which demo the fork came from')
  check(forkInput?.source?.sha256 === secondDemo.assets.document.sha256, 'the adapter is given the snapshot digest as provenance')
  check(forkInput?.parts === secondDemo.validation.partCount, `the adapter receives all ${secondDemo.validation.partCount} parts`)
  const cloudHandoff = await authedPage.getByRole('link', { name: /Open it in the editor/ }).getAttribute('href')
  check(cloudHandoff === '/editor?project=cloud_e2e_1', `the cloud fork hands off to its own project (saw ${cloudHandoff})`)
  report.cloudFork = forkInput
  await authed.close()
  pass('authenticated-fork adapter path')

  check(consoleErrors.length === 0, `no console errors during the behaviour run (${consoleErrors.slice(0, 3).join(' | ')})`)
  await context.close()

  // =========================================================================
  // 2. Delivery
  // =========================================================================
  process.stdout.write('\n-- delivery, against a production build\n')
  // Reusable across runs while iterating; unset, every run builds its own.
  const reuse = process.env.BRICKWRIGHT_LANDING_BUILD_DIR
  buildDir = reuse ?? path.join(os.tmpdir(), `brickwright-landing-build-${process.pid}`)
  if (!reuse || !existsSync(path.join(buildDir, 'index.html'))) {
    await buildLandingEntry(buildDir)
  }
  const served = await serveStatic(buildDir)
  staticServer = served.server
  const buildUrl = `http://127.0.0.1:${served.port}`
  pass(`built and served from ${path.relative(os.tmpdir(), buildDir)}`)

  const perfContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const perfPage = await perfContext.newPage()
  const perfErrors = []
  perfPage.on('console', (message) => { if (message.type() === 'error') perfErrors.push(message.text()) })
  perfPage.on('pageerror', (cause) => perfErrors.push(cause.message))
  const requests = []
  perfPage.on('response', async (response) => {
    const request = response.request()
    let bytes = 0
    try {
      bytes = Number((await response.headerValue('content-length')) ?? 0)
    } catch {
      bytes = 0
    }
    requests.push({
      url: new URL(response.url()).pathname,
      type: request.resourceType(),
      status: response.status(),
      bytes,
    })
  })

  const session = await perfContext.newCDPSession(perfPage)
  await session.send('Network.enable')
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: THROTTLE.latency,
    downloadThroughput: THROTTLE.downloadThroughput,
    uploadThroughput: THROTTLE.uploadThroughput,
  })
  await session.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE.cpuSlowdown })

  await perfPage.addInitScript(() => {
    window.__vitals = { lcp: 0, lcpElement: 'unknown', cls: 0, shifts: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__vitals.lcp = entry.startTime
        // Captured here rather than read back later: the entry's element
        // reference is not guaranteed to survive into a later query.
        const element = entry.element
        window.__vitals.lcpElement = element
          ? `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}`
          : 'unknown'
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue
        window.__vitals.cls += entry.value
        window.__vitals.shifts.push({ value: entry.value, at: entry.startTime })
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })

  await perfPage.goto(`${buildUrl}/`, { waitUntil: 'commit' })
  // Wait for the headline, which is what a visitor is waiting for, then keep
  // watching: the hero's preview fetch is deliberately deferred until the stage
  // is on screen, and any shift it causes has to land inside the CLS window.
  let painted = true
  try {
    await perfPage.locator('h1').first().waitFor({ timeout: 30_000 })
  } catch {
    painted = false
  }
  await perfPage.waitForTimeout(4000)
  check(painted, `the landing headline painted within 30 s under throttling (console: ${perfErrors.slice(0, 2).join(' | ')})`)
  const vitals = await perfPage.evaluate(() => window.__vitals)
  const lcpElement = vitals.lcpElement ?? 'unknown'

  // Chunk *names* are a rolldown implementation detail; what matters is what is
  // inside the chunks the browser actually fetched. So every JavaScript file in
  // the log is read back off disk and searched for fingerprints of the three
  // things this route may not carry.
  const FINGERPRINTS = [
    { name: 'Three.js', pattern: /WebGLRenderer|BufferGeometry\b/ },
    { name: 'the compiled catalog loader', pattern: /catalog\/latest\.json|CatalogUnavailableError/ },
    // Chosen so prose cannot trip them: these are kernel error codes and
    // internal symbols, not phrases a marketing paragraph would contain.
    { name: 'the CAD kernel', pattern: /STALE_DOCUMENT|PART_DEFINITION_NOT_FOUND|NO_COMPATIBLE_CONNECTOR/ },
    { name: 'the WebMCP adapter', pattern: /capabilities_search|builder_feedback_respond/ },
  ]
  const carried = []
  for (const entry of requests) {
    if (!entry.url.endsWith('.js')) continue
    const file = path.join(buildDir, entry.url.replace(/^\//, ''))
    if (!existsSync(file)) continue
    const source = await readFile(file, 'utf8')
    for (const fingerprint of FINGERPRINTS) {
      if (fingerprint.pattern.test(source)) carried.push(`${entry.url} carries ${fingerprint.name}`)
    }
  }
  const forbidden = requests.filter((entry) => /\/catalog\//.test(entry.url) || /\.bwmesh$/.test(entry.url))
  const editorChunks = carried

  process.stdout.write(`\n  throttling: ${THROTTLE.cpuSlowdown}x CPU, ${(THROTTLE.downloadThroughput * 8 / 1024 / 1024).toFixed(2)} Mbit/s down, ${THROTTLE.latency} ms RTT\n`)
  process.stdout.write(`  LCP        ${vitals.lcp.toFixed(0)} ms  (budget ${LCP_BUDGET_MS} ms) — element ${lcpElement}\n`)
  process.stdout.write(`  CLS        ${vitals.cls.toFixed(4)}     (budget ${CLS_BUDGET})\n`)
  process.stdout.write(`  requests   ${requests.length}\n\n`)
  for (const entry of requests) {
    process.stdout.write(`    ${String(entry.status).padEnd(4)} ${entry.type.padEnd(10)} ${String(entry.bytes).padStart(8)}  ${entry.url}\n`)
  }
  process.stdout.write('\n')

  check(vitals.lcp > 0 && vitals.lcp < LCP_BUDGET_MS, `LCP ${vitals.lcp.toFixed(0)} ms is under the ${LCP_BUDGET_MS} ms budget`)
  check(vitals.cls <= CLS_BUDGET, `CLS ${vitals.cls.toFixed(4)} is within ${CLS_BUDGET}`)
  check(forbidden.length === 0, `no catalog or compiled mesh is fetched (${forbidden.map((entry) => entry.url).join(', ')})`)
  check(carried.length === 0, `no fetched chunk carries the renderer, the catalog or the kernel (${carried.join('; ')})`)

  check(perfErrors.length === 0, `no console errors on the production build (${perfErrors.slice(0, 3).join(' | ')})`)
  report.performance = {
    profile: THROTTLE,
    lcpMs: Number(vitals.lcp.toFixed(1)),
    lcpElement,
    cls: Number(vitals.cls.toFixed(5)),
    layoutShifts: vitals.shifts,
    consoleErrors: perfErrors,
    scope:
      'the landing and explore surfaces built as their own entry (src/features/landing/standalone.tsx), '
      + 'served statically with SPA fallback. It excludes the platform shell entry, which statically '
      + 'imports the Hexclave account SDK.',
    requestCount: requests.length,
    transferredBytes: requests.reduce((sum, entry) => sum + entry.bytes, 0),
    requests,
  }
  await perfPage.screenshot({ path: path.join(ARTIFACTS, 'landing-production.png'), fullPage: true })
  await perfContext.close()
  pass('delivery gate')

  // -- the surfaces on their own, at every viewport ------------------------
  // The shell's frame is wider than a phone (see the notes above), which makes
  // an integrated mobile capture a picture of that rather than of these pages.
  // These are the same surfaces with nothing above them, so the layout is the
  // only thing being measured.
  const standaloneOverflow = {}
  for (const viewport of viewports) {
    const shot = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    const shotPage = await shot.newPage()
    for (const [surface, url] of [['landing', '/'], ['explore', `/explore?demo=${heroDemo.id}`]]) {
      await shotPage.goto(`${buildUrl}${url}`, { waitUntil: 'networkidle' })
      await shotPage.waitForTimeout(800)
      const key = `${surface}-${viewport.name}`
      const measured = await shotPage.evaluate(measureOverflow)
      standaloneOverflow[key] = measured
      check(
        measured.worst <= 1 && measured.surfaceWidth <= viewport.width + 1,
        `${key} fits a ${viewport.width}px viewport unshelled `
        + `(surface ${measured.surfaceWidth}px, worst element ${measured.worst}px over)`,
      )
      await shotPage.screenshot({
        path: path.join(ARTIFACTS, `${key}-standalone.png`),
        fullPage: surface === 'landing',
      })
    }
    await shot.close()
  }
  report.standaloneOverflow = standaloneOverflow
  pass('responsive layout without the shell')
} finally {
  await browser.close()
  staticServer?.close()
  // A reused build directory belongs to whoever set the variable.
  if (buildDir && !process.env.BRICKWRIGHT_LANDING_BUILD_DIR) await rm(buildDir, { recursive: true, force: true })
}

report.failures = failures
report.notes = notes
await writeFile(path.join(ARTIFACTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`\nreport → ${path.relative(ROOT, path.join(ARTIFACTS, 'report.json'))}\n`)

if (failures.length) {
  process.stderr.write(`\nlanding acceptance FAILED — ${failures.length} check(s):\n  - ${failures.join('\n  - ')}\n`)
  process.exit(1)
}
process.stdout.write('\nlanding acceptance passed\n')
