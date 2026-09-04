#!/usr/bin/env node
/**
 * Composed browser acceptance run.
 *
 * Each workstream owns its own suite under `tools/e2e/`, but they all need the
 * same expensive thing: a built application served over HTTP with real WebGL.
 * Starting one server here and handing every suite the same URL keeps a full
 * acceptance pass to one boot instead of one per suite, and makes a failure
 * attributable to a named suite rather than to "the e2e run".
 *
 * Suites are plain scripts. They exit non-zero on failure and are expected to
 * honour BRICKWRIGHT_E2E_URL rather than starting a server of their own.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.BRICKWRIGHT_E2E_URL ?? `http://127.0.0.1:${process.env.BRICKWRIGHT_E2E_PORT ?? 4174}`
// The port the server is started on follows the URL the suites are given.
// Setting only BRICKWRIGHT_E2E_URL used to start Vite on 4174 and then wait for
// a different port until the deadline — which is the shape of every "the suite
// hung for no reason" report from a machine that already had something on 4174.
const PORT = Number(process.env.BRICKWRIGHT_E2E_PORT ?? new URL(url).port ?? 4174)

const reachable = async () => {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

async function waitForServer(deadlineMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (await reachable()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

// Vite proxies `/api` to this address (`vite.config.ts`), same as local dev
// (`tools/dev.mjs`). Without it, any page that calls the API — analytics on
// every load, the assistant and generation surfaces — gets a 502 from a proxy
// with nothing behind it, which a suite asserting on browser console errors
// then reports as the application's fault rather than the harness's.
const apiUrl = process.env.BRICKWRIGHT_API_URL ?? `http://127.0.0.1:${process.env.BRICKWRIGHT_API_PORT ?? 8787}`

const apiReachable = async () => {
  try {
    await fetch(`${apiUrl}/api/analytics/events`)
    return true
  } catch {
    return false
  }
}

async function waitForApi(deadlineMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    if (await apiReachable()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for the API server at ${apiUrl}`)
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))

let server
let api
try {
  if (!(await reachable())) {
    server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
      { stdio: 'ignore' },
    )
    await waitForServer()
  }

  // Only for the default target: an explicit BRICKWRIGHT_API_URL means the
  // caller already has an API process running somewhere for this run.
  if (!process.env.BRICKWRIGHT_API_URL && !(await apiReachable())) {
    api = spawn(process.execPath, ['--import', './tools/ts-resolve.mjs', 'server/index.ts'], { stdio: 'ignore' })
    await waitForApi()
  }

  const entries = (await readdir('tools/e2e'))
    .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
    .sort()
  // The legacy editor acceptance run predates this directory and still lives at
  // the top level; it is the most important suite, so it runs first.
  const suites = ['../e2e-smoke.mjs', ...entries].filter(
    (suite) => only.length === 0 || only.some((needle) => suite.includes(needle)),
  )

  const results = []
  for (const suite of suites) {
    const path = join('tools/e2e', suite)
    process.stdout.write(`\n=== ${path} ===\n`)
    const code = await run(process.execPath, [path], { BRICKWRIGHT_E2E_URL: url })
    results.push({ path, code })
  }

  process.stdout.write('\n=== acceptance summary ===\n')
  for (const { path, code } of results) {
    process.stdout.write(`${code === 0 ? 'PASS' : 'FAIL'}  ${path}\n`)
  }
  const failed = results.filter((result) => result.code !== 0)
  if (failed.length > 0) throw new Error(`${failed.length} suite(s) failed`)
  process.stdout.write(`\n${results.length} suite(s) passed\n`)
} finally {
  server?.kill()
  api?.kill()
}
