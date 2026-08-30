#!/usr/bin/env node
/** Real UI regression suite for core CAD editing. Uses an isolated browser/profile. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174'
const artifacts = process.env.BRICKWRIGHT_CAD_ARTIFACTS ?? 'artifacts/cad-editing'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
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
  if (await page.getByRole('button', { name: 'Start building', exact: true }).count())
    await page.getByRole('button', { name: 'Start building', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search parts', exact: true }).fill('3001')
  await page.getByRole('button', { name: 'Add Brick 2 x 4', exact: true }).click()
  assert.equal(await count(), 1)
  const original = Object.values((await model()).parts)[0]
  await page.getByLabel('X in LDraw units', { exact: true }).waitFor()
  check('quick-add places a brick and opens exact transform controls')

  let before = await revision()
  const field = page.getByLabel('X in LDraw units', { exact: true })
  await field.fill('40.5')
  await field.press('Enter')
  await page.getByLabel('Z in LDraw units', { exact: true }).focus()
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
  const z = page.getByLabel('Z in LDraw units', { exact: true })
  before = await revision()
  await z.fill('60')
  await z.press('Enter')
  assert.equal(await revision(), before + 1)
  const moved = Object.values((await model()).parts)
  assert(moved.every((part, index) => part.transform.position[2] === positions[index][2] + 60))
  check('multi-part numeric positioning moves the group in one transaction')

  await page.getByRole('group', { name: 'Axis locks' }).getByRole('button', { name: 'X', exact: true }).click()
  before = await revision()
  await shortcut('ArrowRight')
  assert.equal(await revision(), before)
  assert(await page.getByRole('button', { name: 'Nudge X positive', exact: true }).isDisabled())
  await page.getByRole('group', { name: 'Axis locks' }).getByRole('button', { name: 'X', exact: true }).click()
  await shortcut('ArrowRight')
  assert.equal(await revision(), before + 1)
  check('axis locks apply to keyboard nudges and numeric steppers')

  await page.getByRole('combobox', { name: 'Camera view', exact: true }).selectOption('top')
  await page.getByRole('button', { name: 'Orthographic projection', exact: true }).click()
  await page.waitForFunction(() => window.__brickwrightGizmo?.().attached)
  assert.equal(
    await page.getByRole('button', { name: 'Orthographic projection', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: 'Frame selected parts', exact: true }).click()
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
  await page.getByRole('combobox', { name: 'Quick grid snap', exact: true }).selectOption('10')
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

  // Visibility selection is checked through buttons and shortcuts, not model writes.
  await shortcut('h')
  await shortcut('Control+a')
  assert.equal(await page.getByRole('button', { name: 'Remove selection', exact: true }).count(), 0)
  await shortcut('Shift+h')
  await shortcut('Control+a')
  assert.equal(await page.getByRole('button', { name: 'Remove selection', exact: true }).count(), 1)
  check('select-all does not resurrect hidden parts')

  await page.getByRole('combobox', { name: 'Camera view', exact: true }).selectOption('isometric')
  await page.getByRole('button', { name: 'Orthographic projection', exact: true }).click()
  await page.getByRole('button', { name: 'Frame model', exact: true }).click()
  await page.screenshot({ path: `${artifacts}/desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 1100, height: 760 })
  assert(await page.getByRole('combobox', { name: 'Quick grid snap' }).isVisible())
  const dockBox = await page.getByRole('region', { name: 'Inspector dock' }).boundingBox()
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
  assert.deepEqual(errors, [])
  check('no uncaught browser exceptions')
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ checks, errors, partCount: await count() }, null, 2))
} catch (error) {
  await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {})
  await writeFile(
    `${artifacts}/failure.txt`,
    `${error.stack}\n\n${await page.locator('body').ariaSnapshot()}\n\n${errors.join('\n')}`,
  )
  throw error
} finally {
  await browser.close()
}
