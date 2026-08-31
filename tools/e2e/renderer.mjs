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
import { checkCaptureSet } from '../../src/editor/render/capture.ts'

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

/**
 * Names a browser reports when it is rasterising on the CPU.
 *
 * A hosted runner has no GPU, so WebGL falls back to SwiftShader: 3.16 M
 * triangles cost about 9.6 s a frame there, which is 0.1 FPS against a 30 FPS
 * target. That number is a true fact about the runner and says nothing at all
 * about the renderer, so asserting on it makes this suite a machine detector
 * that fails every hosted run for the same non-reason.
 *
 * The timing gates are therefore enforced only where there is a GPU to time.
 * Everything structural stays enforced everywhere, because that is what a
 * batching or geometry regression actually moves — and it is genuinely
 * host-independent: an M3 Max and SwiftShader both report 126 draw calls and
 * 3,160,768 triangles for the same scene.
 */
const SOFTWARE_RASTERISER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i

const measured = {}
let onCpu = false

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * A target that only means something with a GPU behind it.
 *
 * Reported and skipped on a software rasteriser, loudly, so a run that did not
 * gate on speed can never be mistaken for one that did.
 */
function assertTiming(condition, message) {
  if (!onCpu) {
    assert(condition, message)
    return
  }
  console.log(`  not enforced (software rasteriser, no GPU to time): ${message}`)
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
  onCpu = SOFTWARE_RASTERISER.test(prepared.renderer ?? '')
  measured.softwareRasteriser = onCpu
  console.log(`\nGPU reported by the browser: ${prepared.renderer}`)
  console.log(`Benchmark definitions resident: ${prepared.definitions}`)
  if (onCpu) {
    console.log(
      '\nNo GPU here — WebGL is rasterising on the CPU. Frame rate and pick latency are measured and\n'
        + 'reported below but not enforced; draw calls, triangle counts and selection correctness are.',
    )
  }

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
  assertTiming(
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
  assertTiming(
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
    // The title block holds a <p> when nothing is selected and a <button>
    // naming the part when something is, so the block itself is the stable
    // place to read the selection from — a `p` selector finds nothing exactly
    // when there *is* a selection.
    return window.brickwright.getDocument() && document.querySelector('.viewport-title-block')?.textContent
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
      label: document.querySelector('.viewport-title-block')?.textContent,
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
  const lassoSelection = await page.evaluate(() => document.querySelector('.viewport-title-block')?.textContent)
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
  await page.getByRole('radio', { name: 'build', exact: true }).click()
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
    // `frameParts` transitions unless motion is reduced, and its own docstring
    // says to call `settle()` for a deterministic read. Without it the position
    // below is sampled mid-flight: measured, the flap projected to y = -845 in
    // a 712px canvas, so the click landed on nothing and the diagnostic pick
    // that followed reported null. Six frames is a guess; `settle` is the
    // contract.
    surface.settle()
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
    // Reset before asking again. `pick` is the same primitive the click just
    // used, and it deliberately cycles: repeated picks at one pixel walk
    // backwards through depth. Without this the diagnostic below reports the
    // *next* thing behind what the click chose — and with only six parts
    // visible, a couple of steps into the cycle is background.
    surface.resetCycle()
    return {
      picked: surface.pick(at.x, at.y).partId,
      joints: surface.listJoints(),
      at,
      isolated,
      flap: ids.flap,
      mechanism: ids.added,
      selection: document.querySelector('.viewport-title-block')?.textContent,
    }
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
  // Any part of the mechanism is a correct answer: the mast stands on the flap,
  // so the flap's own centre is behind a plate. What matters is that the click
  // landed on the isolated mechanism and not on the model behind it.
  assert(
    jointList.mechanism.includes(jointList.picked),
    `Clicking the mechanism picked ${jointList.picked}, which is not one of ${jointList.mechanism}`,
  )
  assert(
    jointList.joints.length > 0,
    `Selecting the mechanism (picked ${jointList.picked}, viewport reports "${jointList.selection}") surfaced no articulated joint`,
  )
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
  // The mechanism is returned to rest, a plate is placed in a part of its arc
  // that is demonstrably free, and the joint is then dragged through it. Both
  // halves are derived from the joint the kernel published rather than from
  // hard-coded coordinates, so this stays true whatever `3937`/`3938`/`3024`
  // measure.
  const blocked = await page.evaluate(async (context) => {
    const surface = window.__brickwrightRenderer
    await window.brickwright.invoke('undo_edit', {})
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    const summary =
      surface.listJoints().find((entry) => entry.edgeId === context.edgeId) ??
      surface.listJoints().find((entry) => entry.handles.includes('rotate'))
    if (!summary) return { error: 'the joint disappeared after the undo' }

    const model = window.brickwright.getDocument()
    const tip = context.mast.map((id) => model.parts[id]).filter(Boolean).pop()
    if (!tip) return { error: 'no mast to obstruct' }

    // Rodrigues about the joint's own axis, through its own pivot.
    const rotateAboutJoint = (point, radians) => {
      const pivot = summary.pivotLdu
      const axis = summary.axis
      const radius = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]]
      const dot = axis[0] * radius[0] + axis[1] * radius[1] + axis[2] * radius[2]
      const cross = [
        axis[1] * radius[2] - axis[2] * radius[1],
        axis[2] * radius[0] - axis[0] * radius[2],
        axis[0] * radius[1] - axis[1] * radius[0],
      ]
      return radius.map(
        (value, index) =>
          pivot[index] + value * Math.cos(radians) + cross[index] * Math.sin(radians) + axis[index] * dot * (1 - Math.cos(radians)),
      )
    }

    // Try a few angles: the free arc is a property of the parts, so the test
    // finds one the kernel accepts rather than asserting where it is.
    //
    // The obstacle can no longer be a lone plate: the kernel refuses a part left
    // with no clutch and no ground under it. It goes in as a clutched pair
    // instead — the plate standing in the arc and one directly beneath it, LDraw
    // being Y-down — which is the same rule the hinge above is built by.
    let obstacle = null
    let obstacleDegrees = 0
    const refusals = []
    for (const degrees of [-40, -30, -55, 40, 30]) {
      const current = window.brickwright.getDocument()
      const position = rotateAboutJoint(tip.transform.position, (degrees * Math.PI) / 180)
      const preflight = await window.brickwright.invoke('build_preflight', {
        expectedRevision: current.revision,
        label: 'Renderer acceptance obstacle',
        operations: [
          { op: 'add', definitionId: '3024', color: 4, position },
          { op: 'add', definitionId: '3024', color: 4, position: [position[0], position[1] + 8, position[2]] },
        ],
      })
      const proposalId = preflight?.structuredContent?.id
      if (!proposalId) {
        refusals.push({ degrees, stage: 'preflight', why: JSON.stringify(preflight?.structuredContent).slice(0, 160) })
        continue
      }
      const applied = await window.brickwright.invoke('build_apply', { proposalId })
      if (!applied?.structuredContent?.resultRevision) {
        refusals.push({ degrees, stage: 'apply', why: JSON.stringify(applied?.structuredContent).slice(0, 160) })
        continue
      }
      const after = window.brickwright.getDocument()
      const known = new Set(Object.keys(current.parts))
      const added = Object.keys(after.parts).filter((id) => !known.has(id))
      // The upper plate is the one standing in the arc; the other holds it there.
      obstacle = added.sort((a, b) => after.parts[a].transform.position[1] - after.parts[b].transform.position[1])[0] ?? null
      obstacleDegrees = degrees
      break
    }
    if (!obstacle) return { error: `every candidate obstacle position was refused: ${JSON.stringify(refusals)}` }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const joint =
      surface.listJoints().find((entry) => entry.edgeId === context.edgeId) ??
      surface.listJoints().find((entry) => entry.handles.includes('rotate'))
    if (!joint) return { error: 'the joint was lost after adding the obstacle', obstacle }

    // Drag toward the obstacle. Which screen direction that is depends on the
    // camera, so it is measured: a short probe drag reports the sign, and the
    // real drag runs whichever way matches.
    const start = surface.projectPoint(joint.pivotLdu)
    const probe = (dy) => {
      surface.beginJointDrag(joint.edgeId, 'rotate', start.x + 60, start.y)
      const report = surface.updateJointDrag(start.x + 40, start.y + dy)
      surface.cancelJointDrag()
      return report.rotateDegrees
    }
    const sign = Math.sign(probe(60)) === Math.sign(obstacleDegrees) ? 1 : -1

    surface.beginJointDrag(joint.edgeId, 'rotate', start.x + 60, start.y)
    let report = null
    for (let step = 1; step <= 8; step += 1) {
      report = surface.updateJointDrag(start.x + 60 - step * 8, start.y + sign * step * 12)
      await new Promise((resolve) => setTimeout(resolve, 45))
    }
    const readout = document.querySelector('.sweep-readout')?.textContent ?? null
    const blockedFlag = document.querySelector('.sweep-readout')?.getAttribute('data-blocked') ?? null
    // The drag is deliberately left running so the screenshot below shows the
    // live blocking feedback rather than the scene after it was dismissed.
    return {
      obstacle,
      obstacleDegrees,
      sweep: report?.sweep ?? null,
      readout,
      blockedFlag,
      rotateDegrees: report?.rotateDegrees ?? 0,
    }
  }, { edgeId: joint.edgeId, mast: hinge.mast })
  measured.sweep = blocked
  assert(!blocked.error, `The swept-collision case could not be set up: ${blocked.error}`)
  console.log(
    `Swept collision: obstacle ${blocked.obstacle} placed at ${blocked.obstacleDegrees}°; ` +
      `dragged to ${blocked.rotateDegrees.toFixed(1)}°; readout "${blocked.readout}" (blocked=${blocked.blockedFlag}); ` +
      `sweep ${blocked.sweep ? JSON.stringify({ permissible: blocked.sweep.permissibleFraction, samples: blocked.sweep.samples, blocking: blocked.sweep.blocking }) : 'none'}`,
  )
  assert(blocked.sweep, 'Dragging through an obstacle produced no swept report')
  assert(blocked.readout, 'The swept result was never surfaced on the canvas')
  assert(blocked.sweep.blocking, `The sweep reported the full motion clear: ${JSON.stringify(blocked.sweep)}`)
  assert(
    blocked.sweep.permissibleFraction < 1,
    `The sweep named a blocking pair but permitted the whole motion: ${JSON.stringify(blocked.sweep)}`,
  )
  assert(blocked.blockedFlag === 'true', 'The on-canvas readout did not mark the motion as blocked')
  await page.screenshot({ path: `${ARTIFACTS}/sweep-blocked.png` })
  const stillBlocked = await page.evaluate(() => {
    const text = document.querySelector('.sweep-readout')?.textContent ?? null
    window.__brickwrightRenderer.cancelJointDrag()
    return text
  })
  assert(stillBlocked, 'The blocking readout disappeared before the screenshot was taken')

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
    /**
     * One frame's worth of counters.
     *
     * `gl.info.autoReset` is off so that a sample can span every pass between
     * two reads, which means the raw counters *accumulate*. Comparing them
     * directly would show monotonic growth for any scene at all, animating or
     * not — the probe resets on each call, so this brackets exactly one frame.
     */
    const frameTriangles = async () => {
      window.__brickwrightRenderStats()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return window.__brickwrightRenderStats().triangles
    }

    const before = await frameTriangles()
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
      samples.push(await frameTriangles())
    }
    const revision = window.brickwright.getDocument().revision
    return { before, samples, proposalId, revision, model: model.revision }
  })
  assert(!proposal.error, `The proposal reveal could not be set up: ${proposal.error}`)
  const first = proposal.samples[0]
  const last = proposal.samples[proposal.samples.length - 1]
  const distinctCounts = new Set(proposal.samples).size
  measured.proposal = {
    samples: proposal.samples.length,
    beforeProposal: proposal.before,
    firstFrame: first,
    lastFrame: last,
    distinctCounts,
  }
  console.log(
    `Proposal reveal: ${proposal.samples.length} frames sampled; per-frame triangles ` +
      `${proposal.before.toLocaleString()} before the proposal, ${first.toLocaleString()} on the first frame after it, ` +
      `${last.toLocaleString()} once settled, across ${distinctCounts} distinct per-frame counts`,
  )
  // A wave means the frame gets progressively heavier as parts appear, and ends
  // heavier than it started. A proposal that appeared fully formed would show
  // one count for the whole window.
  assert(last > first, `The proposal did not grow across the reveal: ${first} → ${last} triangles per frame`)
  assert(distinctCounts > 5, `Only ${distinctCounts} distinct per-frame counts; no reveal wave was observed`)
  assert(last > proposal.before, 'The settled frame is no heavier than it was before the proposal existed')
  assert(
    proposal.revision === proposal.model,
    `A pending proposal changed the document from revision ${proposal.model} to ${proposal.revision}`,
  )
  await page.screenshot({ path: `${ARTIFACTS}/proposal-reveal.png` })

  // -- reduced motion settles immediately ----------------------------------
  const reduced = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    const frameTriangles = async () => {
      window.__brickwrightRenderStats()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      return window.__brickwrightRenderStats().triangles
    }
    surface.setReducedMotion(true)
    const policy = surface.motionPolicy()
    // One frame for the suppression to take effect, then the scene must be
    // *stationary*: the same proposal that was mid-reveal a moment ago is now
    // fully drawn and stays that way.
    await frameTriangles()
    const first = await frameTriangles()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const later = await frameTriangles()
    surface.setReducedMotion(null)
    return { policy, first, later }
  })
  measured.reducedMotion = reduced
  console.log(
    `Reduced motion: policy ${JSON.stringify(reduced.policy)}, per-frame triangles ` +
      `${reduced.first.toLocaleString()} → ${reduced.later.toLocaleString()} across 600 ms`,
  )
  assert(reduced.policy.animated === false, 'Reduced motion did not suppress animation')
  assert(
    reduced.first === reduced.later,
    `Under reduced motion the scene kept changing: ${reduced.first} → ${reduced.later} triangles per frame`,
  )
  await page.screenshot({ path: `${ARTIFACTS}/reduced-motion.png` })

  // -- capture integrity ----------------------------------------------------
  const capture = await page.evaluate(async () => {
    const surface = window.__brickwrightRenderer
    // The same event `render_capture` dispatches, request id included: that is
    // what puts the renderer into capture mode and reframes the named view, so
    // this drives the production path rather than a shortcut past it.
    let requestId = 0
    const setMode = async (mode) => {
      requestId += 1
      window.dispatchEvent(
        new CustomEvent('brickwright:set-camera-view', {
          detail: { view: 'isometric', mode, requestId: `acceptance_${requestId}` },
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 360))
      return surface.capture()
    }
    const results = []
    for (const mode of ['beauty', 'orthographic', 'silhouette', 'connections', 'exploded', 'violations', 'beauty']) {
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
    window.dispatchEvent(
      new CustomEvent('brickwright:set-camera-view', { detail: { view: 'isometric', mode: 'beauty', requestId: 'acceptance_reset' } }),
    )
    const validation = (await window.brickwright.invoke('validate_model', {}))?.structuredContent
    return { results, collisions: validation?.collisions?.length ?? 0 }
  })
  measured.capture = capture
  console.log(`\nCapture hashes (model has ${capture.collisions} collisions):`)
  for (const shot of capture.results) {
    console.log(
      `  ${shot.requested.padEnd(12)} → mode ${String(shot.mode).padEnd(12)} rev ${shot.revision} ` +
        `hash ${shot.hash} settled ${shot.settled} ${shot.width}×${shot.height}`,
    )
  }
  assert(capture.results.every((shot) => shot.settled), 'A capture was taken while animation was still running')
  assert(capture.results.every((shot) => shot.width > 0 && shot.height > 0), 'A capture read an empty drawing buffer')
  const sameRevision = new Set(capture.results.map((shot) => shot.revision))
  assert(sameRevision.size === 1, `Captures spanned revisions ${[...sameRevision]}; metadata must be revision-exact`)
  assert(
    capture.results.every((shot) => shot.mode === shot.requested),
    `A capture's metadata named a different mode than was requested: ${JSON.stringify(capture.results.map((s) => [s.requested, s.mode]))}`,
  )

  const beautyHashes = capture.results.filter((shot) => shot.requested === 'beauty').map((shot) => shot.hash)
  assert(
    beautyHashes.length === 2 && beautyHashes[0] === beautyHashes[1],
    `The same mode at the same revision produced different hashes: ${beautyHashes}`,
  )

  // Reproducibility and mode-distinctness come from the kernel's own rule rather
  // than a copy of it here. This check and `checkCaptureSet` had drifted: the
  // shared one required *all* modes to differ, including `violations`, which on a
  // clean model is correctly identical to beauty — and nothing called it, so the
  // wrong rule sat there passing its own tests while the truth lived only in this
  // file. Node runs the TypeScript source directly, so there is no reason for two
  // copies.
  const captureFailures = checkCaptureSet(
    capture.results.map((shot) => ({ mode: shot.requested, revision: shot.revision, hash: shot.hash })),
    { collisions: capture.collisions },
  )
  assert(
    captureFailures.length === 0,
    `Capture set failed its contract:\n  ${captureFailures.join('\n  ')}\n${JSON.stringify(capture.results.map((shot) => [shot.requested, shot.hash]))}`,
  )

  const violationsHash = capture.results.find((shot) => shot.requested === 'violations')?.hash
  if (capture.collisions > 0) {
    assert(
      violationsHash !== beautyHashes[0],
      `The model has ${capture.collisions} collisions but the violations view is pixel-identical to beauty`,
    )
  } else {
    console.log('  violations matches beauty, which is correct: the model has no collisions to flag')
  }

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
    await new Promise((resolve) => setTimeout(resolve, 200))
    const asked = surface.restoreContext()
    // The browser hands the context back on a later task, not synchronously, so
    // this polls rather than counting frames: `requestAnimationFrame` is not a
    // reliable clock while a context is gone.
    const deadline = performance.now() + 8000
    while (performance.now() < deadline && surface.stats().contextRestores < 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    const after = surface.stats()
    void asked
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
