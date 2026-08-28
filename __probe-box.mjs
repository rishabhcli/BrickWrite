import { chromium } from 'playwright'
const url = 'http://127.0.0.1:4176'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 300)))
await page.goto(`${url}/editor`, { waitUntil: 'networkidle' })
await page.locator('canvas').waitFor({ timeout: 60000 })
await page.waitForFunction(() => Boolean(window.__brickwrightRenderer), null, { timeout: 30000 })

const welcome = page.getByRole('button', { name: 'Start building' })
if (await welcome.count()) { await welcome.click().catch(() => {}); await page.waitForTimeout(400) }
await page.evaluate(() => {
  window.__log = []
  const canvas = document.querySelector('canvas')
  canvas.addEventListener('pointerdown', (e) => window.__log.push(['down', e.shiftKey, e.altKey, e.button, Math.round(e.clientX), Math.round(e.clientY)]), true)
  window.addEventListener('pointerup', (e) => window.__log.push(['up', e.shiftKey, e.altKey, e.button]), true)
})
const box = await page.locator('canvas').first().boundingBox()
console.log('canvasBox', JSON.stringify(box))
const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
await page.mouse.move(c.x - 260, c.y - 180)
await page.keyboard.down('Shift')
await page.mouse.down()
await page.mouse.move(c.x - 100, c.y - 60, { steps: 6 })
const mid = await page.evaluate(() => ({ marquee: document.querySelectorAll('.marquee-box').length, log: window.__log }))
console.log('mid', JSON.stringify(mid))
await page.mouse.move(c.x + 240, c.y + 170, { steps: 10 })
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(400)
console.log('after', JSON.stringify(await page.evaluate(() => ({ label: document.querySelector('.viewport-title-block p')?.textContent, log: window.__log }))))
console.log('region', JSON.stringify(await page.evaluate(() => {
  const s = window.__brickwrightRenderer
  const canvas = document.querySelector('canvas')
  const r = s.pickRegion({ kind: 'box', x0: canvas.clientWidth * 0.2, y0: canvas.clientHeight * 0.2, x1: canvas.clientWidth * 0.8, y1: canvas.clientHeight * 0.8 })
  return { n: r.partIds.length, centre: r.centreRuleWouldSelect.length }
})))
await browser.close()
