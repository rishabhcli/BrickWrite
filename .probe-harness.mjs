import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('console', (m) => process.stdout.write(`[console.${m.type()}] ${m.text()}\n`))
page.on('pageerror', (e) => process.stdout.write(`[pageerror] ${e.message}\n`))
page.on('requestfailed', (r) => process.stdout.write(`[failed] ${r.url()} ${r.failure()?.errorText}\n`))
await page.goto('http://127.0.0.1:5178/src/features/share/dev/studio.html?view=studio&token=dev-publish-token', { waitUntil: 'domcontentloaded' })
try {
  await page.locator('[data-testid="harness-ready"]').waitFor({ timeout: 90_000 })
  process.stdout.write('HARNESS READY\n')
} catch {
  process.stdout.write('NOT READY. body:\n' + (await page.locator('body').innerText()).slice(0, 900) + '\n')
}
await browser.close()
