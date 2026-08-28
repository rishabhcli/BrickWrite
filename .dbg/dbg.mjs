import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
const url = 'http://127.0.0.1:4174'
async function available() { try { return (await fetch(url)).ok } catch { return false } }
let server
if (!(await available())) {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: 'ignore' })
  for (let i = 0; i < 120; i++) { if (await available()) break; await new Promise(r => setTimeout(r, 200)) }
}
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
await page.goto(url, { waitUntil: 'networkidle' })
await page.locator('canvas').waitFor({ timeout: 30000 })
await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 30000 })
try { await page.getByRole('button', { name: 'Start building' }).click({ timeout: 5000 }) } catch {}
console.log('errors after boot:', JSON.stringify(errors, null, 1))
const box = await page.locator('canvas').boundingBox()
console.log('canvas box', box)
await page.locator('canvas').click({ position: { x: box.width/2, y: box.height/2 } })
await page.waitForTimeout(400)
console.log('selection', await page.evaluate(() => window.brickwright.getDocument() && document.querySelector('.viewport-title-block p')?.textContent))
await page.keyboard.press('g')
await page.waitForTimeout(400)
console.log('tool', await page.locator('.primary-tools .tool-button[aria-pressed="true"]').textContent())
await page.waitForFunction(() => Boolean(window.__brickwrightGizmo), null, { timeout: 5000 })
const g = await page.evaluate(() => window.__brickwrightGizmo())
console.log('gizmo', g)
const before = await page.evaluate(() => window.brickwright.getDocument().revision)
const handle = { x: box.x + g.centre[0], y: box.y + g.centre[1] }
await page.mouse.move(handle.x, handle.y)
await page.mouse.down()
await page.mouse.move(handle.x + 70, handle.y - 40, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(1200)
const after = await page.evaluate(() => window.brickwright.getDocument().revision)
console.log('revision', before, '->', after)
console.log('toast', await page.evaluate(() => document.querySelector('.toast')?.textContent ?? null))
console.log('errors:', JSON.stringify(errors.slice(0, 8), null, 1))
await browser.close()
server?.kill('SIGTERM')
