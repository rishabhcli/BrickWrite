#!/usr/bin/env node
/** Real UI regression suite for core CAD editing. Uses an isolated browser/profile. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174'
const artifacts = process.env.BRICKWRIGHT_CAD_ARTIFACTS ?? 'artifacts/cad-editing'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true, args: [
  // Match renderer.mjs: request hardware, retain software fallback, report the
  // actual renderer below. The 11k model is not a tiny SwiftShader smoke scene.
  '--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
page.setDefaultTimeout(30000)
const errors = []
const checks = []
page.on('dialog', (dialog) => dialog.dismiss())
page.on('pageerror', (error) => errors.push(error.message))
const model = () => page.evaluate(() => window.brickwright.getDocument())
const count = async () => Object.keys((await model()).parts).length
const revision = async () => (await model()).revision
const check = (label) => {
  checks.push(label)
  console.log(`PASS ${label}`)
}
const canvas = () => page.getByRole('application', { name: 'CAD viewport' })
/** `GRID_PRESETS` in `src/editor/workbench/transform.ts`; alt+g wraps through them. */
const GRID_PRESET_COUNT = 5
const shortcut = async (key) => {
  await canvas().focus()
  await page.keyboard.press(key)
}
const stableGizmo = async () => {
  await page.waitForFunction(() => window.__brickwrightGizmo?.().attached)
  const info = await page.evaluate(() => window.__brickwrightGizmo())
  const box = await canvas().boundingBox()
  return { x: box.x + info.centre[0], y: box.y + info.centre[1] }
}
try {
  await page.goto(`${origin}/editor?doc=blank`, { waitUntil: 'domcontentloaded' })
  await page.locator('canvas').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => Boolean(window.brickwright))
  const gpu = await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unreported'
  })
  console.log(`GPU ${gpu}`)
  if (await page.getByRole('button', { name: 'Start building', exact: true }).count())
    await page.getByRole('button', { name: 'Start building', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search parts', exact: true }).fill('3001')
  await page.getByRole('button', { name: 'Add Brick 2 x 4', exact: true }).click()
  assert.equal(await count(), 1)
  const original = Object.values((await model()).parts)[0]
  // Scoped to the HUD, not the page.
  //
  // The exact-transform fields exist on two surfaces — the Selection HUD, which
  // follows the selection, and the Object tools sheet in the right dock — so a
  // page-wide `getByLabel('X in LDraw units')` is ambiguous as soon as both are
  // open, and Playwright's strict mode fails the run rather than picking one.
  // The HUD is the surface that is present whenever anything is selected, which
  // makes it the stable one to drive. What this suite asserts is that typing a
  // coordinate commits one transaction and moves the part; which of the two
  // surfaces hosts the field is not part of that property. `tools/e2e-smoke.mjs`
  // scopes the same lookup to `.dock-right` for the same reason.
  const hud = page.getByRole('toolbar', { name: 'Selection HUD' })
  await hud.getByLabel('X in LDraw units', { exact: true }).waitFor()
  check('quick-add places a brick and opens exact transform controls')

  let before = await revision()
  const field = hud.getByLabel('X in LDraw units', { exact: true })
  await field.fill('40.5')
  await field.press('Enter')
  await hud.getByLabel('Z in LDraw units', { exact: true }).focus()
  assert.equal(await revision(), before + 1)
  assert.equal((await model()).parts[original.id].transform.position[0], 40.5)
  before = await revision()
  await field.fill('125')
  await field.press('Escape')
  assert.equal(await field.inputValue(), '40.5')
  await field.fill('')
  await field.press('Tab')
  assert.equal(await revision(), before)
  assert.equal(await field.inputValue(), '40.5')
  check('exact coordinates commit once; Escape and empty drafts never edit the model')

  await shortcut('Control+c')
  await shortcut('Control+v')
  await shortcut('Control+v')
  assert.equal(await count(), 3)
  await shortcut('Control+z')
  assert.equal(await count(), 2)
  await shortcut('Control+Shift+z')
  assert.equal(await count(), 3)
  check('copy and repeated paste create clear-space copies with undo/redo')
  await shortcut('Control+x')
  assert.equal(await count(), 2)
  await shortcut('Control+v')
  assert.equal(await count(), 3)
  check('cut and paste restore a part without losing its pose')

  before = await revision()
  const search = page.getByRole('textbox', { name: 'Search parts', exact: true })
  await search.fill('3001')
  await search.press('Control+a')
  await search.press('Control+c')
  await search.press('Control+z')
  assert.equal(await revision(), before)
  check('text-field select-all, copy and undo do not mutate CAD')

  await shortcut('Control+a')
  const positions = Object.values((await model()).parts).map((part) => part.transform.position)
  await page.getByRole('radio', { name: 'Move', exact: true }).click()
  const z = hud.getByLabel('Z in LDraw units', { exact: true })
  before = await revision()
  await z.fill('60')
  await z.press('Enter')
  assert.equal(await revision(), before + 1)
  const moved = Object.values((await model()).parts)
  assert(moved.every((part, index) => part.transform.position[2] === positions[index][2] + 60))
  check('multi-part numeric positioning moves the group in one transaction')

  // Frames, pivots, locks, array, mirror and align live on the Precision sheet
  // now, which stays shut until it is reached for. Reaching for it is part of
  // the flow under test, not a detail to work around.
  const precision = page.locator('[data-section="transform.precision"] .dock-section-toggle')
  if ((await precision.getAttribute('aria-expanded')) !== 'true') await precision.click()
  await page.getByRole('group', { name: 'Axis locks' }).waitFor()

  await page.getByRole('group', { name: 'Axis locks' }).getByRole('button', { name: 'X', exact: true }).click()
  before = await revision()
  await shortcut('ArrowRight')
  assert.equal(await revision(), before)
  assert(await page.getByRole('button', { name: 'Nudge X positive', exact: true }).isDisabled())
  await page.getByRole('group', { name: 'Axis locks' }).getByRole('button', { name: 'X', exact: true }).click()
  await shortcut('ArrowRight')
  assert.equal(await revision(), before + 1)
  check('axis locks apply to keyboard nudges and numeric steppers')

  await page.getByRole('button', { name: 'Top view', exact: true }).click()
  // Driven by chord, because the viewport chrome no longer carries these two.
  //
  // `Orthographic projection` and `Frame selected parts` were buttons on the
  // viewport until the chrome stopped offering the same action in four places;
  // `viewport-overlays.test.tsx` now asserts both are absent, and they are
  // reached as commands instead — `alt+o` and `shift+f`, per `shortcuts.ts`.
  // The property under test is unchanged: orthographic top view is still
  // editable, and framing preserves the view direction. Render mode is read off
  // `data-render-mode` on the viewport shell rather than from a button's
  // `aria-pressed`, which is the state the button used to report anyway.
  await shortcut('Alt+o')
  await page.waitForFunction(() => window.__brickwrightGizmo?.().attached)
  assert.equal(await page.locator('.viewport-shell').getAttribute('data-render-mode'), 'orthographic')
  await shortcut('Shift+f')
  const camera = await page.evaluate(() => window.__brickwrightRenderer.cameraPose())
  assert(camera.pitchDeg > 89)
  check('orthographic top view stays editable and focus preserves the view direction')

  const projectedStud = () =>
    page.evaluate(() => {
      const a = window.__brickwrightRenderer.projectPoint([0, 0, 0])
      const b = window.__brickwrightRenderer.projectPoint([20, 0, 0])
      return Math.hypot(b.x - a.x, b.y - a.y)
    })
  const beforeZoom = await projectedStud()
  await shortcut('=')
  assert((await projectedStud()) > beforeZoom * 1.1)
  check('keyboard zoom changes orthographic scale, not just camera distance')

  // Centre handle dragged in a top view is a real X/Z plane gesture.
  await page.getByRole('button', { name: 'Connector snapping', exact: true }).click()
  // Half stud is reached by cycling, not by its own button.
  //
  // The viewport island used to carry all five snap increments; it now carries
  // one button that cycles the coarse pair (1 stud ↔ 1 plate) and reports
  // whatever increment is live, with the finer three reachable through the
  // Precision sheet or `alt+g` — `GRID_PRESETS` in `transform.ts` is the list.
  // Cycling until the label reads the wanted increment keeps this independent
  // of which one the editor happened to open on.
  let snapped = false
  for (let attempt = 0; attempt < GRID_PRESET_COUNT; attempt += 1) {
    if (await page.getByRole('button', { name: 'Snap half stud', exact: true }).count()) {
      snapped = true
      break
    }
    await shortcut('Alt+g')
  }
  assert(snapped, 'alt+g never reached the half-stud snap increment')
  before = await revision()
  let handle = await stableGizmo()
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 85, handle.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction((rev) => window.brickwright.getDocument().revision === rev + 1, before)
  check('pointer gizmo drag commits the whole group exactly once')

  before = await revision()
  handle = await stableGizmo()
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 60, handle.y, { steps: 8 })
  await page.keyboard.press('Escape')
  await page.mouse.move(handle.x + 100, handle.y, { steps: 4 })
  await page.mouse.up()
  assert.equal(await revision(), before)
  check('Escape cancels a live drag without a document transaction')

  // Visibility selection is checked through chrome and shortcuts, not model writes.
  //
  // Read off the Selection HUD rather than a `Remove selection` button. That
  // button is gone — `shell.test.tsx` asserts a control with no subject is not
  // in the opening chrome, and deleting a selection now lives in the HUD's own
  // more-menu. The HUD is the better signal anyway: it renders exactly when
  // something is selected, which is the property under test. Selecting all
  // while everything is hidden must leave it absent.
  await shortcut('h')
  await shortcut('Control+a')
  assert.equal(await hud.count(), 0)
  await shortcut('Shift+h')
  await shortcut('Control+a')
  assert.equal(await hud.count(), 1)
  assert(Number(await page.locator('.selection-hud-count').innerText()) > 0)
  check('select-all does not resurrect hidden parts')

  await page.getByRole('button', { name: 'Isometric view', exact: true }).click()
  await shortcut('Alt+o')
  await page.getByRole('button', { name: 'Frame model', exact: true }).click()
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 1100, height: 760 })
  // Matched by prefix, not by a fixed increment. One button reports whichever
  // increment is live — this run has already cycled it — and what a narrow
  // viewport has to prove is that the control is still on screen.
  assert(await page.getByRole('button', { name: /^Snap / }).isVisible())
  const dockBox = await page.getByRole('region', { name: 'Design and object dock' }).boundingBox()
  for (const label of ['Nudge Z positive', 'Turn Z positive']) {
    const box = await page.getByRole('button', { name: label, exact: true }).boundingBox()
    assert(box.x >= dockBox.x && box.x + box.width <= dockBox.x + dockBox.width, `${label} is clipped by the dock`)
  }
  check('all axis steppers fit in a narrow inspector')
  await page.screenshot({ path: `${artifacts}/laptop.png`, fullPage: true })
  const saved = await model()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await canvas().waitFor()
  await page.waitForFunction(() => Boolean(window.brickwright))
  assert.deepEqual((await model()).parts, saved.parts)
  check('edits survive a page reload through local autosave')
  // Sol-1 fluidity gates: production surface + real native pointer input.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await shortcut('v')
  const pose = () => page.evaluate(() => window.__brickwrightRenderer.cameraPose())
  const orbit = async () => {
    const rect = await canvas().boundingBox()
    await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height * 0.65)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width * 0.74, rect.y + rect.height * 0.7, { steps: 12 })
    await page.mouse.up()
  }
  await page.evaluate(() => window.__brickwrightRenderer.setReducedMotion(false))
  await page.getByRole('button', { name: 'Front view', exact: true }).click()
  const flight = await page.evaluate(async () => {
    const samples = []
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      samples.push(window.__brickwrightRenderer.cameraPose().yawDeg)
    }
    return samples
  })
  assert(new Set(flight.map(yaw => yaw.toFixed(3))).size > 2, 'named view must interpolate')
  await page.evaluate(() => window.__brickwrightRenderer.settle())
  assert(Math.abs((await pose()).yawDeg % 360) < 0.05)
  check('named views interpolate and explicit settle lands at the exact view')
  const beforeOrbit = await pose()
  await orbit()
  const releasedOrbit = await pose()
  await page.waitForTimeout(120)
  const afterOrbit = await pose()
  assert(Math.abs(afterOrbit.yawDeg - beforeOrbit.yawDeg) > 1)
  assert(Math.abs(afterOrbit.yawDeg - releasedOrbit.yawDeg) > 0.01, 'orbit should damp after release')
  assert(afterOrbit.enabled && afterOrbit.pointerOwner === 'none')
  check('left orbit crosses click slop, damps after release, and returns ownership')
  await page.evaluate(() => window.__brickwrightRenderer.settle())
  let rect = await canvas().boundingBox()
  const beforePan = await pose()
  await page.mouse.move(rect.x + rect.width * 0.55, rect.y + rect.height * 0.7)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height * 0.7, { steps: 10 })
  await page.mouse.up({ button: 'right' })
  await page.evaluate(() => window.__brickwrightRenderer.settle())
  const afterPan = await pose()
  assert(Math.hypot(...afterPan.target.map((v, i) => v - beforePan.target[i])) > 0.01)
  assert.equal(await page.getByRole('menu').count(), 0, 'pan must not open a context menu')
  const beforeWheel = await pose()
  await page.mouse.move(rect.x + rect.width * 0.75, rect.y + rect.height * 0.4)
  await page.mouse.wheel(0, -160)
  await page.waitForTimeout(100)
  await page.evaluate(() => window.__brickwrightRenderer.settle())
  const afterWheel = await pose()
  assert(afterWheel.distance < beforeWheel.distance)
  assert(Math.hypot(...afterWheel.target.map((v, i) => v - beforeWheel.target[i])) > 0.001)
  check('right drag pans and wheel dollies toward the cursor')

  // No pointer event handler on render-only meshes: selection is GPU-only and
  // the original instance buffers must remain alive during a selection change.
  await page.evaluate(async () => { const {cadEngine} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/engine.ts').at(-1).name); cadEngine.setSelection([]) })
  const beforeBuffers = await page.evaluate(() => window.__brickwrightRenderer.stats().instanceBuffers)
  await page.evaluate(async () => {
    const {cadEngine} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/engine.ts').at(-1).name)
    cadEngine.setSelection([Object.keys(cadEngine.getSnapshot().document.parts)[0]])
  })
  await page.waitForFunction(async () => (await window.brickwright.invoke('workspace_get')).structuredContent.selection.length === 1)
  const afterBuffers = await page.evaluate(() => window.__brickwrightRenderer.stats().instanceBuffers)
  assert.deepEqual(afterBuffers, beforeBuffers)
  check('selection-only updates retain the exact original instance buffers')
  await shortcut('g')
  await stableGizmo()
  const gizmoSize = await page.evaluate(() => window.__brickwrightGizmo().screenPixels)
  assert(gizmoSize >= 96, `gizmo too small: ${gizmoSize}px`)
  check(`gizmo projected hit extent is at least 96px (${gizmoSize.toFixed(1)}px)`)

  // Placement exclusivity and Escape recovery use the real palette action.
  await page.evaluate(() => window.__brickwrightRenderer.setReducedMotion(true))
  await page.getByRole('button', { name: 'Isometric view', exact: true }).click()
  await page.getByRole('button', {name:'Frame model', exact:true}).click()
  rect = await canvas().boundingBox()
  await page.getByRole('textbox', { name: 'Search parts', exact: true }).fill('3001')
  await page.getByRole('button', { name: 'Pick up Brick 2 x 4 to place in the viewport', exact: true }).click()
  const landing = await page.evaluate(() => {
    const part = Object.values(window.brickwright.getDocument().parts)[0]
    const [x,y,z] = part.transform.position
    return window.__brickwrightRenderer.projectPoint([x,y-24,z])
  })
  await page.mouse.move(rect.x + landing.x, rect.y + landing.y)
  await page.waitForFunction(() => document.querySelector('.placement-bar')?.getAttribute('data-legal') === 'true')
  assert.equal((await pose()).pointerOwner, 'placement')
  assert.equal((await pose()).enabled, false)
  const beforePlacementCount = await count()
  const beforePlacementRevision = await revision()
  await page.mouse.click(rect.x + landing.x, rect.y + landing.y)
  await page.waitForFunction(total => Object.keys(window.brickwright.getDocument().parts).length === total + 1, beforePlacementCount)
  assert.equal(await revision(), beforePlacementRevision + 1)
  await shortcut('Escape')
  assert.equal((await pose()).enabled, true)
  await shortcut('v')
  const recovery = await pose()
  await orbit()
  await page.evaluate(() => window.__brickwrightRenderer.settle())
  assert(Math.abs((await pose()).yawDeg - recovery.yawDeg) > 1)
  check('click placement commits once; Escape cancels repeat placement and restores orbit')

  // Build a real kernel hinge, then exercise a physical pointer drag + undo.
  await page.evaluate(async () => {
    const {cadEngine} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/engine.ts').at(-1).name)
    const {createBlankDocument} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/sample.ts').at(-1).name)
    const {planCrane} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/assembly.ts').at(-1).name)
    cadEngine.replaceDocument(createBlankDocument('Fluidity crane QA'))
    const result = cadEngine.execute('Crane QA', planCrane({boomStuds: 6}).operations, 'human')
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    cadEngine.setSelection(Object.values(cadEngine.getSnapshot().document.parts).filter(p => p.definitionId === '3938').map(p => p.id))
  })
  await page.evaluate(() => window.__brickwrightRenderer.setReducedMotion(true))
  await page.getByRole('button', { name: 'Right view', exact: true }).click()
  await page.getByRole('button', {name: 'Frame model', exact: true}).click()
  await page.waitForFunction(() => window.__brickwrightRenderer.listJoints().length > 0)
  const joint = await page.evaluate(() => window.__brickwrightRenderer.listJoints()[0])
  const arc = await page.evaluate(() => {
    const surface = window.__brickwrightRenderer
    const [x,y,z] = surface.listJoints()[0].pivotLdu
    return {start:surface.projectPoint([x,y,z+52]), end:surface.projectPoint([x,y+52,z])}
  })
  const beforeJointRevision = await revision()
  const beforeJointParts = (await model()).parts
  rect = await canvas().boundingBox()
  await page.mouse.move(rect.x + arc.start.x, rect.y + arc.start.y)
  await page.mouse.down()
  assert.equal((await pose()).pointerOwner, 'joint', `native ring did not grab ${joint.edgeId}`)
  await page.mouse.move(rect.x + arc.end.x, rect.y + arc.end.y, {steps:12})
  await page.mouse.up()
  assert.equal(await revision(), beforeJointRevision + 1)
  assert.notDeepEqual((await model()).parts, beforeJointParts)
  assert.equal((await pose()).enabled, true)
  await shortcut('Control+z')
  assert.deepEqual((await model()).parts, beforeJointParts)
  check('hinge drag sweeps, commits once, releases camera, and undoes')

  await page.evaluate(async () => {
    const {cadEngine} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/engine.ts').at(-1).name)
    const document = await fetch('/demos/illinois-main-quad/document.json').then(r => r.json())
    cadEngine.replaceDocument({...document, id:'sol1-illinois-qa'})
    cadEngine.setSelection([])
  })
  await page.getByRole('button', { name: 'Isometric view', exact: true }).click()
  await page.getByRole('button', {name:'Frame model', exact:true}).click()
  await page.waitForFunction(() => window.__brickwrightRenderer.stats().batchEdgeVertices > 0)
  await page.waitForFunction(() => window.__brickwrightRenderer.stats().identityWarmupComplete)
  assert((await count()) > 11000)
  const largeStats = await page.evaluate(() => window.__brickwrightRenderer.stats())
  assert(largeStats.batchEdgeVertices > 0)
  const largeBefore = largeStats.instanceBuffers
  await page.evaluate(async () => { const {cadEngine} = await import(performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname === '/src/cad/engine.ts').at(-1).name); cadEngine.setSelection([Object.keys(cadEngine.getSnapshot().document.parts)[100]]) })
  assert.deepEqual(await page.evaluate(() => window.__brickwrightRenderer.stats().instanceBuffers), largeBefore)
  const warmPicks = await page.evaluate(() => {
    const surface = window.__brickwrightRenderer
    const point = surface.screenPositionOf(Object.keys(window.brickwright.getDocument().parts)[100])
    return Array.from({length: 8}, () => surface.pick(point.x, point.y))
  })
  assert(warmPicks.every(pick => pick.partId), 'warm picks must resolve real geometry')
  console.log(JSON.stringify({largeModelParts:await count(), batchEdgeVertices:largeStats.batchEdgeVertices, qualityTier:largeStats.qualityTier, warmPickMs:warmPicks.map(pick => pick.latencyMs)}))
  await page.screenshot({path:`${artifacts}/illinois-edges.png`, fullPage:true})
  check('11k Illinois model retains edges and selection preserves original instance buffers')
  assert.deepEqual(errors, [])
  check('no uncaught browser exceptions')
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ checks, errors, gpu, partCount: await count() }, null, 2))
} catch (error) {
  console.error(error)
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true, timeout: 10000 }).catch(() => {})
  const snapshot = await page.locator('body').ariaSnapshot({timeout:10000}).catch(cause => `Snapshot unavailable: ${cause.message}`)
  await writeFile(
    `${artifacts}/failure.txt`,
    `${error.stack}\n\n${snapshot}\n\n${errors.join('\n')}`,
  )
  throw error
} finally {
  await browser.close()
}
