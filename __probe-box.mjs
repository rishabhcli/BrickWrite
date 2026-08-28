import { chromium } from 'playwright'
const url = 'http://127.0.0.1:4176'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.goto(`${url}/editor`, { waitUntil: 'networkidle' })
await page.locator('canvas').waitFor({ timeout: 60000 })
await page.waitForFunction(() => Boolean(window.__brickwrightRenderer), null, { timeout: 30000 })
const out = await page.evaluate(() => {
  const s = window.__brickwrightRenderer
  const canvas = document.querySelector('canvas')
  const w = canvas.clientWidth, h = canvas.clientHeight
  const box = s.pickRegion({ kind: 'box', x0: w * 0.15, y0: h * 0.15, x1: w * 0.85, y1: h * 0.85 })
  const stats = s.stats()
  return {
    w, h, dpr: window.devicePixelRatio,
    drawing: [canvas.width, canvas.height],
    idPass: stats.idPass,
    count: box.partIds.length,
    first: box.partIds.slice(0, 5),
    pixels: box.pixels.slice(0, 5),
    centreRule: box.centreRuleWouldSelect.length,
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
