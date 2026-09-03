// @vitest-environment node
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

/**
 * The npm scripts must actually start.
 *
 * `server/` names its relative imports `./x.js` because Vercel transpiles each
 * file and copies specifiers through untouched. Node's type stripping resolves
 * specifiers against real files and deliberately does not map `.js` back to
 * `.ts`, so `node server/index.ts` throws ERR_MODULE_NOT_FOUND on its first
 * import. `tools/ts-resolve.mjs` is the loader that closes that gap.
 *
 * Vitest and Vite do the mapping themselves, which is exactly why no test
 * caught this: every other file here imports the modules through the runner.
 * This one spawns the command `package.json` declares, so the flag cannot be
 * dropped again without a red test.
 */
async function scriptCommand(name: string): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const command = manifest.scripts?.[name]
  expect(typeof command, `package.json has no ${name} script`).toBe('string')
  return command
}

describe('the API entry point boots the way its scripts invoke it', () => {
  it.each(['dev:api', 'serve:api'])('%s starts a real node process', async (script) => {
    const command = await scriptCommand(script)
    expect(command.startsWith('node ')).toBe(true)
    const argv = command.slice('node '.length).split(' ')

    // `BRICKWRIGHT_API_LISTEN=0` loads the module and its routes without
    // binding a port. Resolving every import and settling the top-level await
    // is the whole assertion: a failure here exits non-zero and `execFile`
    // rejects, which is what ERR_MODULE_NOT_FOUND did.
    const { stderr } = await run(process.execPath, [...argv], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, BRICKWRIGHT_API_LISTEN: '0' },
      timeout: 30_000,
    })
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND')
  }, 40_000)
})
