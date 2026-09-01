import { spawn } from 'node:child_process'
import process from 'node:process'

/**
 * One local development command for the whole application.
 *
 * Vite proxies `/api` to port 8787, so starting only Vite leaves the design
 * partner and generation surfaces mounted but unable to do their job. Hexclave
 * launches this process with the project's environment injected; both children
 * inherit that same environment and neither credential enters the browser
 * bundle.
 */

const commands = [
  { name: 'api', args: ['--import', './tools/ts-resolve.mjs', 'server/index.ts'] },
  { name: 'vite', args: ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'] },
]

const children = commands.map(({ name, args }) => {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  child.on('error', (cause) => {
    process.stderr.write(`[dev] ${name} failed to start: ${String(cause)}\n`)
    shutdown(1)
  })
  return { name, child }
})

let stopping = false
let killTimer

function shutdown(code, signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  killTimer = setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 5_000)
  killTimer.unref()
}

for (const { name, child } of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`
    process.stderr.write(`[dev] ${name} stopped unexpectedly (${detail}); stopping the other service.\n`)
    shutdown(code && code > 0 ? code : 1)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0, signal))
}

await Promise.all(
  children.map(
    ({ child }) =>
      new Promise((resolve) => {
        child.once('exit', resolve)
      }),
  ),
)

if (killTimer) clearTimeout(killTimer)
