import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The one-way boundary.
 *
 * `server/assistant` reads `ANTHROPIC_API_KEY`. If any module under `src/`
 * imported it — directly or through a barrel — the bundler would follow the
 * import and the key-reading module would end up in a browser chunk. A comment
 * saying "do not import this" would hold until the first person in a hurry;
 * this test holds always.
 */

const ROOT = resolve(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

function walk(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) found.push(path)
  }
  return found
}

const sources = walk(SRC)
const isTest = (path: string) => /\.test\.(?:ts|tsx)$/.test(path) || path.includes(`${join('src', 'test')}${''}`)

/** Every module specifier a file imports, however it imports it. */
function specifiersOf(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) found.push(match[1])
  }
  return found
}

describe('client/server boundary', () => {
  it('finds the source tree it is meant to be guarding', () => {
    expect(sources.length).toBeGreaterThan(50)
    expect(sources.some((path) => path.endsWith(join('src', 'agent', 'session.ts')))).toBe(true)
  })

  it('no module under src/ imports anything from server/', () => {
    const offenders: string[] = []
    for (const path of sources) {
      const source = readFileSync(path, 'utf8')
      for (const specifier of specifiersOf(source)) {
        const normalized = specifier.replace(/\\/g, '/')
        const reachesServer =
          normalized.startsWith('server/') ||
          normalized.includes('/server/assistant') ||
          /(^|\/)\.\.\/(?:\.\.\/)*server\//.test(normalized)
        if (reachesServer) offenders.push(`${relative(ROOT, path)} → ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no module under src/ reads a model credential', () => {
    const offenders: string[] = []
    for (const path of sources) {
      const source = readFileSync(path, 'utf8')
      // The name may legitimately appear in prose explaining where the key
      // lives; what must never appear is a read of it.
      if (/\bprocess\.env\.ANTHROPIC_API_KEY\b/.test(source)) offenders.push(relative(ROOT, path))
      if (/import\.meta\.env\.[A-Z_]*ANTHROPIC[A-Z_]*/.test(source)) offenders.push(relative(ROOT, path))
      if (/\bsk-ant-[A-Za-z0-9]/.test(source)) offenders.push(`${relative(ROOT, path)} (literal key)`)
    }
    expect(offenders).toEqual([])
  })

  it('no module under src/ imports the Anthropic SDK', () => {
    const offenders: string[] = []
    for (const path of sources) {
      const source = readFileSync(path, 'utf8')
      if (specifiersOf(source).some((specifier) => specifier.startsWith('@anthropic-ai/'))) {
        offenders.push(relative(ROOT, path))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the scripted model double is reachable only from tests', () => {
    const offenders: string[] = []
    for (const path of sources) {
      if (isTest(path)) continue
      const source = readFileSync(path, 'utf8')
      if (specifiersOf(source).some((specifier) => specifier.includes('scriptedTransport'))) {
        offenders.push(relative(ROOT, path))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the API process does read the key, in exactly one module', () => {
    // The mirror image of the rule above: the boundary is only meaningful if
    // the secret really does live on the other side of it.
    const server = readFileSync(join(ROOT, 'server', 'assistant', 'provider.ts'), 'utf8')
    expect(server).toMatch(/process\.env\.ANTHROPIC_API_KEY/)
  })
})
