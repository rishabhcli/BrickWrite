#!/usr/bin/env node
/**
 * Renderer acceptance run.
 *
 * Two pages, for two different questions.
 *
 *   The **benchmark page** answers "how fast is the renderer". It loads only
 *   `src/editor/render/benchmarkEntry.ts` — real compiled LDraw geometry, real
 *   materials, real batching, real environment and shadows — with nothing else
 *   on the page, so a frame time is attributable to the renderer rather than to
 *   the renderer plus a React tree, a catalogue panel and a command deck.
 *
 *   The **editor page** answers "does it work". Every interaction is driven
 *   through the production control surface (`window.__brickwrightRenderer`) or
 *   through real pointer events, never through a reimplementation of the
 *   behaviour inside `page.evaluate`. A test that reimplements picking proves
 *   the test works.
 *
 * Every performance number printed here is measured on the machine running it.
 * Nothing is asserted from intuition and nothing is rounded in the renderer's
 * favour: a missed target prints the measured value and fails.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

/**
 * The server to drive.
 *
 * `run-all.mjs` boots one server for every suite and passes its URL here, so a
 * full acceptance pass costs one startup rather than one per suite. Starting a
 * server of our own is the fallback for running this file alone.
 */
const url = process.env.BRICKWRIGHT_E2E_URL ?? process.env.BRICKWRIGHT_RENDERER_URL ?? 'http://127.0.0.1:4176'
const OWNS_SERVER = !process.env.BRICKWRIGHT_E2E_URL
const ARTIFACTS = 'artifacts/renderer'
let server

/** Targets. Stated here so a failure reads as "missed X", not as a bare throw. */
const TARGET = {
  fpsAt5000: 30,
  pickP95Ms: 50,
  drawCallDeltaFor400: 40,
}

const measured = {}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function available() {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await available()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

/**
 * A bare page that loads the benchmark module and nothing else.
 *
 * Served by intercepting a path on the dev server's own origin, so the module
 * import is same-origin and Vite transforms it exactly as it would for the
 * application. Adding an HTML file to the repository for this would have put a
 * build artefact in the source tree for the sake of a test.
 */
const BENCH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>renderer benchmark</title>
<style>html,body{margin:0;background:#0b1012;overflow:hidden}</style></head>
<body>
<script type="module">
  // The benchmark imports the viewport's real modules, and two of them are
  // .tsx, so the dev server's React Refresh transform expects its preamble to
  // have run. Installing it here is what lets the measurement use the
  // production components rather than a copy of them written for the test.
  import RefreshRuntime from '/@react-refresh'
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
  window.__vite_plugin_react_preamble_installed__ = true
</script>
<script type="module">
  import('/src/editor/render/benchmarkEntry.ts').then(() => { window.__benchLoaded = true })
    .catch((cause) => { window.__benchError = String(cause && cause.stack || cause) })
</script>
</body></html>`

const percentile = (values, fraction) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]
}

try {
  if (!(await available())) {
    if (!OWNS_SERVER) throw new Error(`BRICKWRIGHT_E2E_URL points at ${url}, which is not reachable`)
    server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4176', '--strictPort'],
      { stdio: 'ignore' },
    )
    await waitForServer()
  }
  await mkdir(ARTIFACTS, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: [
      // Ask for real hardware acceleration. Chromium falls back to SwiftShader
      // when it cannot get it, and the renderer string is reported below so the
      // numbers are always attributable to what actually ran them.
      '--use-angle=default',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
    ],
  })

  // =========================================================================
  // Benchmark page
  // =========================================================================
  /**
   * The dev server's hot-reload socket is not part of what is being measured.
   *
   * Chromium's local-network access checks block it for a page served from
   * 127.0.0.1 in headless mode, and Vite logs the failure as a console error.
   * Failing the renderer's acceptance run on that would be failing on the
   * harness. Everything else is still fatal.
   */
  const isHarnessNoise = (text) =>
    /\[vite\]|@vite\/client|Vite server|WebSocket connection to 'ws:|ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS|failed to connect to websocket/.test(
      text,
    )

  const bench = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const benchErrors = []
  bench.on('pageerror', (cause) => benchErrors.push(cause.message))
  bench.on('console', (message) => {
    if (message.type() === 'error' && !isHarnessNoise(message.text())) benchErrors.push(message.text())
  })
  await bench.route('**/__renderer-bench', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: BENCH_HTML }),
  )
  await bench.goto(`${url}/__renderer-bench`, { waitUntil: 'domcontentloaded' })
  await bench.waitForFunction(() => window.__benchLoaded || window.__benchError, null, { timeout: 60_000 })
  const loadError = await bench.evaluate(() => window.__benchError ?? null)
  assert(!loadError, `The benchmark module failed to load: ${loadError}`)

  const prepared = await bench.evaluate(() => window.__brickwrightBench.prepare())
  assert(prepared.definitions >= 4, `Expected several placeable definitions to benchmark, saw ${prepared.definitions}`)
  measured.gpu = prepared.renderer
  console.log(`\nGPU reported by the browser: ${prepared.renderer}`)
  console.log(`Benchmark definitions resident: ${prepared.definitions}`)

  // -- gate 1: sustained frame rate at 2,000 and 5,000 parts ----------------
  const runs = []
  for (const count of [2000, 5000]) {
    const result = await bench.evaluate(
      (parts) => window.__brickwrightBench.run({ count: parts, durationMs: 3000 }),
      count,
    )
    runs.push(result)
    await bench.screenshot({ path: `${ARTIFACTS}/benchmark-${count}.png` })
    console.log(
      `\n${count} parts — mean ${result.frames.meanFps.toFixed(1)} FPS, ` +
        `p50 ${result.frames.p50Fps.toFixed(1)}, p5 ${result.frames.p5Fps.toFixed(1)}, ` +
        `worst ${result.frames.minFps.toFixed(1)}; ` +
        `mean frame ${result.frames.meanFrameMs.toFixed(2)} ms, p95 ${result.frames.p95FrameMs.toFixed(2)} ms; ` +
        `${result.frames.drawCalls} draw calls, ${result.frames.triangles.toLocaleString()} triangles, ` +
        `${result.frames.frames} frames measured`,
    )
    console.log(
      `${String(count).padStart(5)} parts — renderer cost with the display taken out of it: ` +
        `mean ${result.cost.meanMs.toFixed(2)} ms, p50 ${result.cost.p50Ms.toFixed(2)} ms, ` +
        `p95 ${result.cost.p95Ms.toFixed(2)} ms → ceiling ${result.cost.ceilingFps.toFixed(0)} FPS ` +
        `over ${result.cost.frames} drained frames`,
    )
  }
  measured.frames = runs.map((run) => ({ parts: run.parts, ...run.frames, cost: run.cost }))

  const atFiveThousand = runs.find((run) => run.parts === 5000)
  // The sustained figure is the 5th percentile of instantaneous rate: the slow
  // frames are what an operator feels, and a mean can hide a stutter entirely.
  const sustained = atFiveThousand.frames.p5Fps
  assert(
    sustained >= TARGET.fpsAt5000,
    `Sustained frame rate at 5,000 parts was ${sustained.toFixed(1)} FPS (p5), below the ${TARGET.fpsAt5000} FPS target. ` +
      `Mean ${atFiveThousand.frames.meanFps.toFixed(1)}, worst frame ${atFiveThousand.frames.minFps.toFixed(1)} FPS.`,
  )

  // -- gate 2: pick latency p95 --------------------------------------------
  // Measured against the 5,000-part scene still resident, which is the hard
  // case: the id pass draws the same batches the beauty pass does.
  const picks = await bench.evaluate(() => window.__brickwrightBench.picks(240))
  measured.picks = picks
  console.log(
    `\nPick latency over ${picks.picks} picks (5,000-part scene, ${picks.hits} hits): ` +
      `mean ${picks.meanMs.toFixed(2)} ms, p50 ${picks.p50Ms.toFixed(2)} ms, ` +
      `p95 ${picks.p95Ms.toFixed(2)} ms, worst ${picks.maxMs.toFixed(2)} ms; ` +
      `the first pick, which compiles the identity shader and allocates its target, took ${picks.firstMs.toFixed(2)} ms`,
  )
  assert(picks.picks >= 200, `Expected at least 200 picks, measured ${picks.picks}`)
  assert(picks.hits > picks.picks * 0.2, `Only ${picks.hits} of ${picks.picks} picks hit geometry; the grid missed the model`)
  assert(
    picks.p95Ms < TARGET.pickP95Ms,
    `Pick latency p95 was ${picks.p95Ms.toFixed(2)} ms, above the ${TARGET.pickP95Ms} ms target`,
  )

  // -- gate 4: draw calls stay near-flat as parts are added ------------------
  const drawCalls = await bench.evaluate(() => window.__brickwrightBench.drawCallDelta({ base: 600, extra: 400 }))
  measured.drawCalls = drawCalls
  console.log(
    `\nDraw calls: ${drawCalls.before} before, ${drawCalls.after} after adding 400 parts ` +
      `(delta ${drawCalls.delta}); triangles ${drawCalls.trianglesBefore.toLocaleString()} → ${drawCalls.trianglesAfter.toLocaleString()}`,
  )
  assert(
    drawCalls.delta < TARGET.drawCallDeltaFor400,
    `400 extra parts added ${drawCalls.delta} draw calls; instancing and merged edges should keep this near-flat`,
  )
  assert(
    drawCalls.trianglesAfter > drawCalls.trianglesBefore,
    `The counters must describe geometry that is actually drawn: triangles went ${drawCalls.trianglesBefore} → ${drawCalls.trianglesAfter}`,
  )

  // -- gate 3: region selection reads covered pixels -------------------------
  const region = await bench.evaluate(() => window.__brickwrightBench.regionCorrectness())
  measured.region = region
  await bench.screenshot({ path: `${ARTIFACTS}/region-correctness.png` })
  console.log(
    `\nRegion correctness — beam by pixels: [${region.beamCoveredPixels}], by centre: [${region.beamCentreRule}]; ` +
      `buried by pixels: [${region.buriedCoveredPixels}], by centre: [${region.buriedCentreRule}]; ` +
      `occluder at the buried centre: ${region.occluderConfirmed}`,
  )
  assert(
    region.occluderConfirmed === 'blocker',
    `The arrangement is not occluding: a pick at the buried part's own centre returned ${region.occluderConfirmed}`,
  )
  assert(
    region.beamCoveredPixels.includes('beam'),
    'A part whose pixels are inside the lasso was not selected, so selection is not reading covered pixels',
  )
  assert(
    !region.beamCentreRule.includes('beam'),
    'The beam’s projected centre was inside the lasso, so this arrangement does not distinguish the two rules',
  )
  assert(
    !region.buriedCoveredPixels.includes('buried'),
    'A fully occluded part was selected, so selection is not respecting depth',
  )
  assert(
    region.buriedCentreRule.includes('buried'),
    'The buried part’s centre was outside the lasso, so this arrangement does not distinguish the two rules',
  )

  await bench.evaluate(() => window.__brickwrightBench.dispose())
  assert(benchErrors.length === 0, `The benchmark page logged errors: ${benchErrors.slice(0, 3).join(' | ')}`)
  await bench.close()

  // =========================================================================
  // Editor page
  // =========================================================================
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error' && !isHarnessNoise(message.text())) errors.push(message.text())
  })
  page.on('pageerror', (cause) => errors.push(cause.message))

  // The shell registers the editor as its own route; the site root is the
  // landing page and carries no viewport.
  await page.goto(`${url}/editor`, { waitUntil: 'networkidle' })
  await page.locator('canvas').waitFor({ timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 60_000 })
  // Dismiss the first-run guide if this profile has not seen it.
  const welcome = page.getByRole('button', { name: 'Start building' })
  if (await welcome.count()) await welcome.click().catch(() => {})
  await page.waitForFunction(() => Boolean(window.__brickwrightRenderer), null, { timeout: 30_000 })

  const surfaceVersion = await page.evaluate(() => window.__brickwrightRenderer.version)
  assert(surfaceVersion === 1, `Unexpected control-surface version ${surfaceVersion}`)

  const canvasBox = await page.locator('canvas').first().boundingBox()
  const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 }

  // -- single pick ----------------------------------------------------------
  // A grid sweep finds a pixel that is genuinely on the model, so the
  // assertions below are about picking rather than about where the showcase
  // happens to sit.
  const hit = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    for (let row = 4; row < 26; row += 1) {
      for (let column = 4; column < 26; column += 1) {
        const x = (column / 30) * width
        const y = (row / 30) * height
        const result = window.__brickwrightRenderer.pick(x, y)
        if (result.partId) return { x, y, ...result }
      }
    }
    return null
  })
  assert(hit, 'A sweep across the viewport found no pickable geometry at all')
  console.log(`\nSingle pick: ${hit.partId} at (${hit.x.toFixed(0)}, ${hit.y.toFixed(0)}) in ${hit.latencyMs.toFixed(2)} ms`)

  const clickSelected = await page.evaluate(async (point) => {
    window.__brickwrightRenderer.resetCycle()
    const canvas = document.querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    const options = { clientX: rect.left + point.x, clientY: rect.top + point.y, bubbles: true, button: 0, detail: 1 }
    canvas.dispatchEvent(new PointerEvent('pointerdown', options))
    window.dispatchEvent(new PointerEvent('pointerup', options))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return window.brickwright.getDocument() && document.querySelector('.viewport-title-block p')?.textContent
  }, { x: hit.x, y: hit.y })
  console.log(`Click selection reported: ${clickSelected}`)

  // -- occlusion cycling ----------------------------------------------------
  // Repeated picks at one pixel must walk strictly backwards through depth. The
  // pixel is searched for rather than assumed: a point on the model's
  // silhouette has nothing behind it, and cycling there would "pass" by
  // returning one part and then background, which demonstrates nothing.
  const cycled = await page.evaluate(() => {
    const surface = window.__brickwrightRenderer
    const canvas = document.querySelector('canvas')
    const walk = (x, y) => {
      surface.resetCycle()
      const seen = []
      for (let step = 0; step < 6; step += 1) {
        const result = surface.pick(x, y, { cycle: true })
        seen.push({ partId: result.partId, depth: result.cycleDepth })
        if (!result.partId) break
      }
      return seen
    }
    let best = []
    for (let row = 6; row < 30; row += 1) {
      for (let column = 6; column < 30; column += 1) {
        const x = (column / 36) * canvas.clientWidth
        const y = (row / 36) * canvas.clientHeight
        const seen = walk(x, y)
        const distinct = new Set(seen.filter((entry) => entry.partId).map((entry) => entry.partId))
        if (distinct.size > best.length) best = seen
        if (distinct.size >= 3) return { point: { x, y }, seen }
      }
    }
    return { point: null, seen: best }
  })
  measured.cycle = cycled
  console.log(
    `Occlusion cycle at one pixel: ${cycled.seen.map((entry) => entry.partId ?? 'background').join(' → ')}` +
      (cycled.point ? ` (at ${cycled.point.x.toFixed(0)}, ${cycled.point.y.toFixed(0)})` : ''),
  )
  assert(cycled.seen.length > 0 && cycled.seen[0].partId, 'The first pick of a cycle returned nothing')
  const distinct = new Set(cycled.seen.filter((entry) => entry.partId).map((entry) => entry.partId))
  assert(
    distinct.size >= 2,
    `Cycling never reached a second part at any pixel; it walked ${JSON.stringify(cycled.seen)}`,
  )
  // Strictly backwards: each step must return something the walk has not
  // already returned, which is what "monotonic in depth" means in practice.
  assert(
    distinct.size === cycled.seen.filter((entry) => entry.partId).length,
    `Cycling repeated a part rather than stepping past it: ${JSON.stringify(cycled.seen)}`,
  )

  // -- box selection --------------------------------------------------------
  await page.mouse.move(centre.x - 260, centre.y - 180)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move(centre.x - 100, centre.y - 60, { steps: 6 })
  const marqueeVisible = await page.locator('.marquee-box').count()
  await page.mouse.move(centre.x + 240, centre.y + 170, { steps: 10 })
  await page.screenshot({ path: `${ARTIFACTS}/box-select.png` })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  // The selection travels through the kernel and back out as a React snapshot;
  // reading the label in the same tick reads the previous render.
  await page.waitForTimeout(400)
  assert(marqueeVisible === 1, 'Shift-dragging did not draw a selection rectangle')
  const boxSelection = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const region = window.__brickwrightRenderer.pickRegion({
      kind: 'box',
      x0: canvas.clientWidth * 0.2,
      y0: canvas.clientHeight * 0.2,
      x1: canvas.clientWidth * 0.8,
      y1: canvas.clientHeight * 0.8,
    })
    return {
      label: document.querySelector('.viewport-title-block p')?.textContent,
      byPixels: region.partIds.length,
      byCentre: region.centreRuleWouldSelect.length,
    }
  })
  measured.boxSelect = boxSelection
  console.log(
    `Box selection: "${boxSelection.label}"; over the same region the covered-pixel rule finds ` +
      `${boxSelection.byPixels} parts and the old projected-centre rule ${boxSelection.byCentre}`,
  )
  assert(
    /\d+ parts selected/.test(boxSelection.label ?? ''),
    `Box selection did not select a region, viewport reports "${boxSelection.label}"`,
  )
  assert(boxSelection.byPixels > 1, 'A box over most of the model covered at most one part')

  // -- lasso selection ------------------------------------------------------
  await page.evaluate(() => window.__brickwrightRenderer.pickRegion({ kind: 'box', x0: 0, y0: 0, x1: 1, y1: 1 }))
  await page.keyboard.down('Alt')
  await page.mouse.move(centre.x - 200, centre.y - 140)
  await page.mouse.down()
  const lassoPath = [
    [centre.x + 190, centre.y - 150],
    [centre.x + 210, centre.y + 160],
    [centre.x - 180, centre.y + 170],
  ]
  for (const [x, y] of lassoPath) await page.mouse.move(x, y, { steps: 8 })
  const lassoVisible = await page.locator('.lasso-overlay').count()
  await page.screenshot({ path: `${ARTIFACTS}/lasso-select.png` })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.waitForTimeout(400)
  assert(lassoVisible === 1, 'Alt-dragging did not draw a lasso')
  const lassoSelection = await page.evaluate(() => document.querySelector('.viewport-title-block p')?.textContent)
  console.log(`Lasso selection: ${lassoSelection}`)
  assert(
    /\d+ parts selected/.test(lassoSelection ?? ''),
    `Lasso selection selected nothing, viewport reports "${lassoSelection}"`,
  )

  // -- isolation by connection distance -------------------------------------
  const isolation = await page.evaluate(async (partId) => {
    const before = window.__brickwrightRenderer.getVisibility()
    const isolated = await window.__brickwrightRenderer.setVisibility({ isolateSeedIds: [partId], hops: 1 })
    const widened = await window.__brickwrightRenderer.setVisibility({ hops: 3 })
    const cleared = await window.__brickwrightRenderer.setVisibility({ isolateSeedIds: null })
    return { before, isolated, widened, cleared }
  }, hit.partId)
  measured.isolation = isolation
  console.log(
    `Isolation: all ${isolation.before.solid} solid → 1 hop ${isolation.isolated.solid} solid / ` +
      `${isolation.isolated.ghosted} ghosted → 3 hops ${isolation.widened.solid} solid ` +
      `(derived on ${isolation.widened.derivedOn}) → cleared ${isolation.cleared.solid}`,
  )
  assert(isolation.isolated.solid < isolation.before.solid, 'Isolating one part did not reduce the solid set')
  assert(isolation.widened.solid >= isolation.isolated.solid, 'Widening the hop count did not include more parts')
  assert(isolation.cleared.solid === isolation.before.solid, 'Clearing the isolation did not restore the full model')

  // -- named views ----------------------------------------------------------
  const views = await page.evaluate(() => {
    const saved = window.__brickwrightRenderer.saveView('inspection')
    window.__brickwrightRenderer.frameParts(Object.keys(window.brickwright.getDocument().parts).slice(0, 3))
    const moved = window.__brickwrightRenderer.saveView('scratch')
    const restored = window.__brickwrightRenderer.restoreView('inspection')
    const after = window.__brickwrightRenderer.saveView('after')
    return { saved, moved, restored, after, list: window.__brickwrightRenderer.listViews().map((v) => v.name) }
  })
  assert(views.restored, 'Restoring a named view failed')
  const drift = Math.hypot(
    views.after.position[0] - views.saved.position[0],
    views.after.position[1] - views.saved.position[1],
    views.after.position[2] - views.saved.position[2],
  )
  console.log(`Named views ${JSON.stringify(views.list)}; restore drift ${drift.toFixed(4)} scene units`)
  assert(drift < 1e-3, `Restoring a named view left the camera ${drift} units away from where it was saved`)

  // -- section plane, manipulated on the canvas -----------------------------
  const section = await page.evaluate(() => {
    const surface = window.__brickwrightRenderer
    const plane = surface.addSectionPlane('y')
    const before = surface.stats()
    // Grab the plane's own offset handle where it is drawn, and drag it.
    const handle = surface.projectPoint(plane.origin)
    const grabbed = surface.beginSectionDrag(plane.id, 'offset', handle.x, handle.y)
    const moved = surface.updateSectionDrag(handle.x, handle.y - 140)
    surface.endSectionDrag()
    return { plane, grabbed, moved, before: before.drawCalls, planes: surface.listSectionPlanes().length }
  })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${ARTIFACTS}/section-plane.png` })
  measured.section = section
  const sectionTravel = Math.hypot(
    section.moved.origin[0] - section.plane.origin[0],
    section.moved.origin[1] - section.plane.origin[1],
    section.moved.origin[2] - section.plane.origin[2],
  )
  console.log(`Section plane: grabbed ${section.grabbed}, moved ${sectionTravel.toFixed(2)} LDU along its normal`)
  assert(section.grabbed, 'The section plane handle refused the grab')
  assert(sectionTravel > 1, `Dragging the section handle moved the plane ${sectionTravel} LDU`)
  const sectionRemoved = await page.evaluate((id) => window.__brickwrightRenderer.removeSectionPlane(id), section.plane.id)
  assert(sectionRemoved, 'Removing the section plane failed')

  // -- a hinge to drag ------------------------------------------------------
  // Built through the kernel's own command path, so the joint under test is a
  // real connection edge rather than an assertion about one. Applying a
  // proposal is a mutation, so the session is put into build autonomy first —
  // through the same control an operator uses, not by reaching past it.
  await page.locator('.autonomy-switch').getByRole('button', { name: 'build' }).click()
  await page.waitForFunction(
    () => window.brickwright?.tools?.has?.('build_apply') ?? false,
    null,
    { timeout: 10_000 },
  )

  const hinge = await page.evaluate(async () => {
    const model = window.brickwright.getDocument()
    const positions = Object.values(model.parts).map((part) => part.transform.position)
    const mean = (axis) => positions.reduce((total, position) => total + position[axis], 0) / Math.max(1, positions.length)
    const top = Math.min(...positions.map((position) => position[1]))
    // Directly above the model, not beside it. The showcase carries a hard
    // envelope constraint on its footprint in studs, so a hinge placed 240 LDU
    // to one side is refused by the kernel — correctly. LDraw's +Y is down, so
    // "above" is a *smaller* Y, and height is not part of that envelope.
    const origin = [mean(0), top - 400, mean(2)]
    const mast = (level) => [origin[0] + 10, origin[1] - 8 * level, origin[2]]
    const operations = [
      { op: 'add', definitionId: '3937', color: 4, position: origin },
      { op: 'add', definitionId: '3938', color: 14, position: origin },
      { op: 'add', definitionId: '3024', color: 15, position: mast(1) },
      { op: 'add', definitionId: '3024', color: 15, position: mast(2) },
      { op: 'add', definitionId: '3024', color: 15, position: mast(3) },
      { op: 'add', definitionId: '3024', color: 15, position: mast(4) },
    ]
    const preflight = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Renderer acceptance hinge',
      operations,
    })
    const proposalId = preflight?.structuredContent?.id
    if (!proposalId) return { error: JSON.stringify(preflight?.structuredContent).slice(0, 300) }
    const applied = await window.brickwright.invoke('build_apply', { proposalId })
    if (!applied?.structuredContent?.resultRevision) {
      return { error: JSON.stringify(applied?.structuredContent).slice(0, 300) }
    }
    const after = window.brickwright.getDocument()
    // Identify the new parts by diffing, not by definition id: the showcase may
    // already contain a hinge, and picking the first match by definition would
    // aim every later step at somebody else's brick.
    const before = new Set(Object.keys(model.parts))
    const added = Object.values(after.parts).filter((part) => !before.has(part.id))
    return {
      revision: after.revision,
      added: added.map((part) => part.id),
      base: added.find((part) => part.definitionId === '3937')?.id ?? null,
      flap: added.find((part) => part.definitionId === '3938')?.id ?? null,
      mast: added.filter((part) => part.definitionId === '3024').map((part) => part.id),
    }
  })
  assert(!hinge.error, `Could not build the acceptance hinge: ${hinge.error}`)
  assert(hinge.flap && hinge.base, 'The acceptance hinge produced no hinge parts')
  assert(hinge.added.length === 6, `Expected six new parts for the hinge, saw ${hinge.added.length}`)
  console.log(`\nAcceptance hinge: base ${hinge.base}, flap ${hinge.flap}, mast ${hinge.mast.join(', ')}`)

  // Frame it and select the flap with a real click, so the joint list is
  // populated the way an operator would populate it.
  // Isolating the mechanism before articulating it is both the real workflow and
  // what makes this deterministic: with the rest of the model hidden it is not
  // drawn, so it cannot be what the click lands on.
  const jointList = await page.evaluate(async (ids) => {
    const surface = window.__brickwrightRenderer
    const isolated = await surface.setVisibility({ isolateSeedIds: [ids.flap], hops: 6, outside: 'hidden' })
    surface.frameParts([ids.base, ids.flap])
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const at = surface.screenPositionOf(ids.flap)
    const canvas = document.querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    const options = { clientX: rect.left + at.x, clientY: rect.top + at.y, bubbles: true, button: 0, detail: 1 }
    surface.resetCycle()
    canvas.dispatchEvent(new PointerEvent('pointerdown', options))
    window.dispatchEvent(new PointerEvent('pointerup', options))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { picked: surface.pick(at.x, at.y).partId, joints: surface.listJoints(), at, isolated, flap: ids.flap }
  }, hinge)
  measured.joints = jointList.joints
  console.log(
    `\nIsolated the mechanism to ${jointList.isolated.solid} solid parts; clicking the flap picked ${jointList.picked}`,
  )
  console.log(`Joints for the selected flap: ${jointList.joints.map((joint) => `${joint.family}/${joint.kind}`).join(', ') || 'none'}`)
  assert(
    jointList.isolated.solid <= 8,
    `Isolating the mechanism left ${jointList.isolated.solid} parts solid; the hinge and its mast are six`,
  )
  assert(
    jointList.picked === jointList.flap,
    `Clicking the flap picked ${jointList.picked} rather than ${jointList.flap}`,
  )
  assert(jointList.joints.length > 0, `Selecting the flap (picked ${jointList.picked}) surfaced no articulated joint`)
  const joint = jointList.joints.find((entry) => entry.handles.includes('rotate'))
  assert(joint, 'The hinge offered no rotation handle')
  await page.screenshot({ path: `${ARTIFACTS}/joint-handles.png` })

  // -- joint drag: escape restores the exact starting transform -------------
  const cancelled = await page.evaluate(async (edgeId) => {
    const surface = window.__brickwrightRenderer
    const before = window.brickwright.getDocument()
    const summary = surface.listJoints().find((entry) => entry.edgeId === edgeId)
    const poses = Object.fromEntries(
      Object.entries(before.parts).map(([id, part]) => [id, JSON.stringify(part.transform)]),
    )
    const start = surface.projectPoint(summary.pivotLdu)
    const grabbed = surface.beginJointDrag(edgeId, 'rotate', start.x + 60, start.y)
    const during = surface.updateJointDrag(start.x + 30, start.y + 70)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const cancelReport = surface.cancelJointDrag()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const after = window.brickwright.getDocument()
    const changed = Object.entries(after.parts).filter(([id, part]) => poses[id] !== JSON.stringify(part.transform))
    return {
      grabbed,
      previewCount: during.previewCount,
      rotateDegrees: during.rotateDegrees,
      commits: cancelReport.commits,
      revisionBefore: before.revision,
      revisionAfter: after.revision,
      changed: changed.map(([id]) => id),
    }
  }, joint.edgeId)
  measured.jointCancel = cancelled
  console.log(
    `Joint drag cancelled: grabbed ${cancelled.grabbed}, previewed ${cancelled.previewCount} parts at ` +
      `${cancelled.rotateDegrees.toFixed(1)}°, commits ${cancelled.commits}, ` +
      `revision ${cancelled.revisionBefore} → ${cancelled.revisionAfter}, changed parts [${cancelled.changed}]`,
  )
  assert(cancelled.grabbed, 'The joint handle refused the grab')
  assert(cancelled.previewCount > 0, 'Dragging the joint previewed no parts')
  assert(cancelled.commits === 0, `Cancelling the drag committed ${cancelled.commits} transactions`)
  assert(
    cancelled.revisionAfter === cancelled.revisionBefore,
    `Cancelling the drag moved the document from revision ${cancelled.revisionBefore} to ${cancelled.revisionAfter}`,
  )
  assert(
    cancelled.changed.length === 0,
    `Cancelling the drag left ${cancelled.changed.length} parts at a different transform: ${cancelled.changed}`,
  )

  // -- joint drag: release commits exactly one transaction -------------------
  const committed = await page.evaluate(async (edgeId) => {
    const surface = window.__brickwrightRenderer
    const before = window.brickwright.getDocument()
    const summary = surface.listJoints().find((entry) => entry.edgeId === edgeId)
    const start = surface.projectPoint(summary.pivotLdu)
    surface.beginJointDrag(edgeId, 'rotate', start.x + 60, start.y)
    let report = null
    for (let step = 1; step <= 6; step += 1) {
      report = surface.updateJointDrag(start.x + 60 - step * 8, start.y + step * 12)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    // Let the swept check catch up: it runs on its own cadence so it never
    // becomes the reason a frame is late.
    await new Promise((resolve) => setTimeout(resolve, 260))
    const sweptReport = surface.updateJointDrag(start.x + 4, start.y + 84)
    const commit = surface.commitJointDrag()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const after = window.brickwright.getDocument()
    return {
      rotateDegrees: report.rotateDegrees,
      sweep: sweptReport.sweep,
      commits: commit.commits,
      revisionBefore: before.revision,
      revisionAfter: after.revision,
      label: after.parts && window.brickwright.getDocument().revision,
      moved: Object.keys(after.parts).filter(
        (id) => JSON.stringify(after.parts[id].transform) !== JSON.stringify(before.parts[id]?.transform),
      ).length,
    }
  }, joint.edgeId)
  measured.jointCommit = committed
  console.log(
    `Joint drag committed: ${committed.rotateDegrees.toFixed(1)}°, ${committed.commits} transaction(s), ` +
      `revision ${committed.revisionBefore} → ${committed.revisionAfter}, ${committed.moved} parts moved; ` +
      `sweep ${committed.sweep ? `${committed.sweep.samples} samples, permissible ${(committed.sweep.permissibleFraction * 100).toFixed(0)}%` : 'not run'}`,
  )
  assert(committed.commits === 1, `Releasing the drag committed ${committed.commits} transactions, expected exactly 1`)
  assert(committed.revisionAfter === committed.revisionBefore + 1, 'Releasing the drag did not produce exactly one revision')
  assert(committed.moved > 1, `Only ${committed.moved} part moved; the drag should carry the whole rigid island`)
  assert(committed.sweep, 'The drag produced no swept-collision report')

  // -- swept collision reports the first blocking pair -----------------------
  // A plate is placed in the mast's arc, then the joint is dragged through it.
  const blocked = await page.evaluate(async (context) => {
    const surface = window.__brickwrightRenderer
    const model = window.brickwright.getDocument()
    const summary = surface.listJoints().find((entry) => entry.edgeId === context.edgeId)
    if (!summary) return { error: 'the joint disappeared before the sweep test' }

    // Derive the obstacle from the motion: whatever the parts measure, this
    // lands in the arc.
    surface.beginJointDrag(context.edgeId, 'rotate', 0, 0)
    surface.cancelJointDrag()

    const mast = Object.values(model.parts).filter((part) => part.definitionId === '3024')
    const tip = mast[mast.length - 1]
    if (!tip) return { error: 'no mast to obstruct' }

    // Place the obstacle a little way around the arc from the tip, at the same
    // radius from the pivot.
    const pivot = summary.pivotLdu
    const radius = [tip.transform.position[0] - pivot[0], tip.transform.position[1] - pivot[1], tip.transform.position[2] - pivot[2]]
    const angle = -0.7
    const axis = summary.axis
    const dot = axis[0] * radius[0] + axis[1] * radius[1] + axis[2] * radius[2]
    const cross = [
      axis[1] * radius[2] - axis[2] * radius[1],
      axis[2] * radius[0] - axis[0] * radius[2],
      axis[0] * radius[1] - axis[1] * radius[0],
    ]
    const rotated = radius.map((value, index) =>
      value * Math.cos(angle) + cross[index] * Math.sin(angle) + axis[index] * dot * (1 - Math.cos(angle)),
    )
    const position = [pivot[0] + rotated[0], pivot[1] + rotated[1], pivot[2] + rotated[2]]

    const preflight = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Renderer acceptance obstacle',
      operations: [{ op: 'add', definitionId: '3024', color: 4, position }],
    })
    const proposalId = preflight?.structuredContent?.id
    if (!proposalId) return { error: JSON.stringify(preflight?.structuredContent).slice(0, 300) }
    const applied = await window.brickwright.invoke('build_apply', { proposalId })
    if (!applied?.structuredContent?.resultRevision) return { error: JSON.stringify(applied?.structuredContent).slice(0, 300) }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const refreshed = surface.listJoints().find((entry) => entry.edgeId === context.edgeId)
      ?? surface.listJoints().find((entry) => entry.handles.includes('rotate'))
    if (!refreshed) return { error: 'the joint was lost after adding the obstacle' }

    const start = surface.projectPoint(refreshed.pivotLdu)
    surface.beginJointDrag(refreshed.edgeId, 'rotate', start.x + 60, start.y)
    let report = null
    for (let step = 1; step <= 8; step += 1) {
      report = surface.updateJointDrag(start.x + 60 - step * 12, start.y - step * 10)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const readout = document.querySelector('.sweep-readout')?.textContent ?? null
    const blockedFlag = document.querySelector('.sweep-readout')?.getAttribute('data-blocked') ?? null
    surface.cancelJointDrag()
    return { sweep: report?.sweep ?? null, readout, blockedFlag, rotateDegrees: report?.rotateDegrees ?? 0 }
  }, { edgeId: joint.edgeId })
  measured.sweep = blocked
  assert(!blocked.error, `The swept-collision case could not be set up: ${blocked.error}`)
  console.log(
    `Swept collision: readout "${blocked.readout}" (blocked=${blocked.blockedFlag}); ` +
      `dragged to ${blocked.rotateDegrees.toFixed(1)}°, ` +
      `sweep ${blocked.sweep ? JSON.stringify({ permissible: blocked.sweep.permissibleFraction, blocking: blocked.sweep.blocking }) : 'none'}`,
  )
  assert(blocked.sweep, 'Dragging through an obstacle produced no swept report')
  assert(blocked.readout, 'The swept result was never surfaced on the canvas')
  assert(
    blocked.sweep.blocking !== null || blocked.sweep.permissibleFraction < 1,
    `The sweep reported the full motion clear even though a part was placed in the arc: ${JSON.stringify(blocked.sweep)}`,
  )
  await page.screenshot({ path: `${ARTIFACTS}/sweep-blocked.png` })

  await page.evaluate(() => window.__brickwrightRenderer.setVisibility({ isolateSeedIds: null, outside: 'ghost' }))

  // -- no mutation during a full animation cycle ---------------------------
  // The engine itself is instrumented: any transaction at all during the
  // window is a failure, not just an unexpected one.
  const animation = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    const start = window.brickwright.getDocument().revision
    surface.setReducedMotion(false)
    // Watch for two full seconds of animation frames.
    const frames = []
    const started = performance.now()
    while (performance.now() - started < 2000) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      frames.push(window.brickwright.getDocument().revision)
    }
    return { start, frames: frames.length, revisions: [...new Set(frames)] }
  })
  measured.animation = animation
  console.log(`\nAnimation cycle: ${animation.frames} frames, revisions seen ${JSON.stringify(animation.revisions)}`)
  assert(
    animation.revisions.length === 1 && animation.revisions[0] === animation.start,
    `The document changed during an animation cycle: revisions ${JSON.stringify(animation.revisions)}`,
  )

  // -- proposal reveal animation -------------------------------------------
  const proposal = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    surface.setReducedMotion(false)
    const model = window.brickwright.getDocument()
    const operations = Array.from({ length: 60 }, (_, index) => ({
      op: 'add',
      definitionId: index % 2 ? '3024' : '3005',
      color: index % 2 ? 15 : 4,
      position: [(index % 10) * 20 - 400, -200 - Math.floor(index / 10) * 24, -400],
    }))
    const before = surface.stats().triangles
    const preflight = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Renderer acceptance proposal',
      operations,
    })
    const proposalId = preflight?.structuredContent?.id
    if (!proposalId) return { error: JSON.stringify(preflight?.structuredContent).slice(0, 300) }

    const samples = []
    const started = performance.now()
    while (performance.now() - started < 1600) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      samples.push(surface.stats().triangles)
    }
    const revision = window.brickwright.getDocument().revision
    return { before, samples, proposalId, revision, model: model.revision }
  })
  assert(!proposal.error, `The proposal reveal could not be set up: ${proposal.error}`)
  const revealGrew = proposal.samples.some((value, index) => index > 0 && value > proposal.samples[index - 1])
  measured.proposal = { samples: proposal.samples.length, grew: revealGrew }
  console.log(
    `Proposal reveal: ${proposal.samples.length} frames sampled, triangle count ` +
      `${Math.min(...proposal.samples).toLocaleString()} → ${Math.max(...proposal.samples).toLocaleString()}, ` +
      `monotonic growth observed: ${revealGrew}`,
  )
  assert(revealGrew, 'The proposal appeared fully formed; no reveal wave was observed')
  assert(
    proposal.revision === proposal.model,
    `A pending proposal changed the document from revision ${proposal.model} to ${proposal.revision}`,
  )
  await page.screenshot({ path: `${ARTIFACTS}/proposal-reveal.png` })

  // -- reduced motion settles immediately ----------------------------------
  const reduced = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    surface.setReducedMotion(true)
    const policy = surface.motionPolicy()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const first = surface.stats().triangles
    await new Promise((resolve) => setTimeout(resolve, 500))
    const later = surface.stats().triangles
    surface.setReducedMotion(null)
    return { policy, first, later }
  })
  measured.reducedMotion = reduced
  console.log(
    `Reduced motion: policy ${JSON.stringify(reduced.policy)}, triangles ${reduced.first.toLocaleString()} → ${reduced.later.toLocaleString()}`,
  )
  assert(reduced.policy.animated === false, 'Reduced motion did not suppress animation')
  assert(
    Math.abs(reduced.later - reduced.first) < Math.max(2000, reduced.first * 0.02),
    `Under reduced motion the scene kept changing: ${reduced.first} → ${reduced.later} triangles`,
  )
  await page.screenshot({ path: `${ARTIFACTS}/reduced-motion.png` })

  // -- capture integrity ----------------------------------------------------
  const capture = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    const setMode = async (mode) => {
      window.dispatchEvent(new CustomEvent('brickwright:set-camera-view', { detail: { view: 'isometric', mode } }))
      await new Promise((resolve) => setTimeout(resolve, 320))
      return surface.capture()
    }
    const results = []
    for (const mode of ['beauty', 'silhouette', 'violations', 'connections', 'beauty']) {
      const shot = await setMode(mode)
      results.push({
        mode: shot.renderMode,
        requested: mode,
        revision: shot.documentRevision,
        hash: shot.pixelHash,
        settled: shot.settled,
        width: shot.width,
        height: shot.height,
        bytes: shot.dataUrl.length,
      })
    }
    window.dispatchEvent(new CustomEvent('brickwright:set-camera-view', { detail: { view: 'isometric', mode: 'beauty' } }))
    return results
  })
  measured.capture = capture
  console.log('\nCapture hashes:')
  for (const shot of capture) {
    console.log(
      `  ${shot.requested.padEnd(12)} → mode ${String(shot.mode).padEnd(12)} rev ${shot.revision} ` +
        `hash ${shot.hash} settled ${shot.settled} ${shot.width}×${shot.height}`,
    )
  }
  assert(capture.every((shot) => shot.settled), 'A capture was taken while animation was still running')
  assert(capture.every((shot) => shot.width > 0 && shot.height > 0), 'A capture read an empty drawing buffer')
  const sameRevision = new Set(capture.map((shot) => shot.revision))
  assert(sameRevision.size === 1, `Captures spanned revisions ${[...sameRevision]}; metadata must be revision-exact`)
  const beautyHashes = capture.filter((shot) => shot.requested === 'beauty').map((shot) => shot.hash)
  assert(
    beautyHashes.length === 2 && beautyHashes[0] === beautyHashes[1],
    `The same mode at the same revision produced different hashes: ${beautyHashes}`,
  )
  const distinctHashes = new Set(capture.map((shot) => shot.hash))
  assert(
    distinctHashes.size >= 4,
    `Only ${distinctHashes.size} distinct hashes across 5 captures of 4 modes; diagnostic views are not distinguishable`,
  )

  // -- the agent capture path still returns pixels and the right revision ---
  const agentCapture = await page.evaluate(async () => {
    const result = await window.brickwright.invoke('render_capture', { view: 'front', mode: 'beauty' })
    return {
      revision: result?.structuredContent?.documentRevision,
      live: window.brickwright.getDocument().revision,
      hasImage: (result?.content ?? []).some((entry) => entry.type === 'image' && entry.data?.length > 1000),
    }
  })
  console.log(`Agent capture: revision ${agentCapture.revision} (live ${agentCapture.live}), image present ${agentCapture.hasImage}`)
  assert(agentCapture.hasImage, 'render_capture returned no pixels')
  assert(
    agentCapture.revision === agentCapture.live,
    `render_capture reported revision ${agentCapture.revision} while the document was at ${agentCapture.live}`,
  )

  // -- context loss and recovery -------------------------------------------
  const contextLoss = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    const before = surface.stats()
    surface.loseContext()
    await new Promise((resolve) => setTimeout(resolve, 120))
    surface.restoreContext()
    // Give the browser several frames to hand the context back and the scene to
    // rebuild its environment map and identity target.
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const after = surface.stats()
    const canvas = document.querySelector('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    return {
      before: { drawCalls: before.drawCalls, triangles: before.triangles },
      after: { drawCalls: after.drawCalls, triangles: after.triangles },
      losses: after.contextLosses,
      restores: after.contextRestores,
      contextLost: context ? context.isContextLost() : null,
    }
  })
  measured.contextLoss = contextLoss
  console.log(
    `\nContext loss: ${contextLoss.losses} loss(es), ${contextLoss.restores} restore(s); ` +
      `context lost now: ${contextLoss.contextLost}; ` +
      `triangles ${contextLoss.before.triangles.toLocaleString()} → ${contextLoss.after.triangles.toLocaleString()}`,
  )
  assert(contextLoss.losses >= 1, 'Forcing a context loss did not fire the lost event')
  assert(contextLoss.restores >= 1, 'The context was never restored')
  assert(contextLoss.contextLost === false, 'The WebGL context is still lost after the restore')
  assert(contextLoss.after.triangles > 0, 'The scene drew nothing after the context was restored')

  // A pick after the restore proves the identity target came back too, not
  // merely that something is on screen.
  const pickAfterRestore = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    for (let row = 4; row < 26; row += 1) {
      for (let column = 4; column < 26; column += 1) {
        const result = window.__brickwrightRenderer.pick((column / 30) * canvas.clientWidth, (row / 30) * canvas.clientHeight)
        if (result.partId) return result.partId
      }
    }
    return null
  })
  console.log(`Pick after context restore: ${pickAfterRestore}`)
  assert(pickAfterRestore, 'Picking stopped working after the context was restored')
  await page.screenshot({ path: `${ARTIFACTS}/context-restored.png` })

  // -- resource accounting over a hundred selections ------------------------
  const leak = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    const ids = Object.keys(window.brickwright.getDocument().parts)
    const before = surface.resources()
    const geometriesBefore = surface.stats().geometries
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const at = surface.screenPositionOf(ids[cycle % ids.length])
      if (at) surface.pick(at.x, at.y, { cycle: cycle % 3 === 0 })
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { before, after: surface.resources(), geometriesBefore, geometriesAfter: surface.stats().geometries }
  })
  measured.leak = leak
  console.log(
    `\nResource accounting over 100 picks: registry ${leak.before.total} → ${leak.after.total}; ` +
      `GPU geometries ${leak.geometriesBefore} → ${leak.geometriesAfter}`,
  )
  assert(
    leak.after.total <= leak.before.total,
    `The resource registry grew from ${leak.before.total} to ${leak.after.total} across 100 picks`,
  )
  assert(
    leak.geometriesAfter <= leak.geometriesBefore + 2,
    `GPU geometries grew from ${leak.geometriesBefore} to ${leak.geometriesAfter} across 100 picks`,
  )

  await page.screenshot({ path: `${ARTIFACTS}/final.png` })
  await writeFile(`${ARTIFACTS}/measurements.json`, `${JSON.stringify(measured, null, 2)}\n`)

  // Errors from other workstreams' code should not silently pass, but they are
  // reported rather than thrown here: this run owns the renderer.
  if (errors.length) {
    console.log(`\nConsole errors observed on the editor page (${errors.length}):`)
    for (const message of errors.slice(0, 5)) console.log(`  - ${message}`)
  }

  console.log('\n─────────────────────────────────────────────')
  console.log('RENDERER ACCEPTANCE — measured on this machine')
  console.log('─────────────────────────────────────────────')
  console.log(`GPU                       ${measured.gpu}`)
  for (const run of measured.frames) {
    console.log(
      `${String(run.parts).padStart(5)} parts             ` +
        `mean ${run.meanFps.toFixed(1)} FPS · p50 ${run.p50Fps.toFixed(1)} · sustained (p5) ${run.p5Fps.toFixed(1)} · ` +
        `worst ${run.minFps.toFixed(1)} · ${run.drawCalls} draw calls · ` +
        `uncapped ceiling ${run.cost.ceilingFps.toFixed(0)} FPS (${run.cost.meanMs.toFixed(2)} ms/frame)`,
    )
  }
  console.log(
    `Pick latency              p50 ${measured.picks.p50Ms.toFixed(2)} ms · p95 ${measured.picks.p95Ms.toFixed(2)} ms ` +
      `over ${measured.picks.picks} picks · first (cold shader) ${measured.picks.firstMs.toFixed(2)} ms`,
  )
  console.log(
    `Draw calls +400 parts     ${measured.drawCalls.before} → ${measured.drawCalls.after} (delta ${measured.drawCalls.delta})`,
  )
  console.log('─────────────────────────────────────────────')
  console.log(`\nRenderer acceptance run passed. Artifacts in ${ARTIFACTS}/`)

  await page.close()
  await browser.close()
} finally {
  server?.kill()
}
