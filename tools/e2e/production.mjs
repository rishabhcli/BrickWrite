#!/usr/bin/env node
/**
 * Production-bundle runtime gate.
 *
 * The normal acceptance server is Vite's development graph. That is ideal for
 * tracing features, but it cannot catch a minifier or chunking regression that
 * leaves the deployed root blank. `npm run check` has already built `dist/`;
 * this suite serves those exact bytes and proves both a light route and the CAD
 * route can execute without a browser exception.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = Number(process.env.BRICKWRIGHT_PREVIEW_PORT ?? 4175)
const origin = `http://127.0.0.1:${PORT}`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Same list `tools/e2e/renderer.mjs` matches on.
 *
 * This suite asserts that the built bundle *executes*, which is host-independent
 * — but how long it takes to execute is not. A hosted runner has no GPU, so the
 * editor's WebGL boot goes through SwiftShader and the wait for
 * `window.brickwright` blew a flat 30 s ceiling on every hosted run, skipping
 * the deploy for a reason that has nothing to do with the bundle. The assertion
 * is unchanged; only the patience is.
 */
const SOFTWARE_RASTERISER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i

async function rendererName(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    if (!gl) return 'none'
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    return (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'unknown'
  })
}

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(origin)).ok) return
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for production preview at ${origin}`)
}

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore' },
)

let browser
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (cause) => errors.push(cause.stack ?? cause.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('requestfailed', (request) => errors.push(`${request.failure()?.errorText ?? 'request failed'} ${request.url()}`))

  const landing = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert(landing?.ok(), `Production landing returned ${landing?.status() ?? 'no response'}`)
  await page.locator('.bw-landing').waitFor({ timeout: 15_000 })
  assert(errors.length === 0, `Production landing emitted browser errors:\n${errors.join('\n')}`)

  const gpu = await rendererName(page)
  const onCpu = SOFTWARE_RASTERISER.test(gpu)
  // Six times, measured against the renderer suite's own figure: SwiftShader
  // costs about 9.6 s a frame where a GPU costs milliseconds.
  const bootTimeout = onCpu ? 180_000 : 30_000
  process.stdout.write(`GPU reported by the browser: ${gpu}${onCpu ? ' — widening the editor boot wait, not the assertion' : ''}\n`)

  const editor = await page.goto(`${origin}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  assert(editor?.ok(), `Production editor returned ${editor?.status() ?? 'no response'}`)
  await page.locator('canvas').first().waitFor({ timeout: bootTimeout })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: bootTimeout })
  assert(errors.length === 0, `Production editor emitted browser errors:\n${errors.join('\n')}`)

  process.stdout.write('production bundle executed landing and editor with no browser errors\n')
} finally {
  await browser?.close()
  server.kill()
}
