import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The editor lazy-chunk contract: `adapter.ts` may register the new tools, but
 * it must not pull generation, refinement, part intelligence or share into the
 * workbench's first chunk. Those modules load through `import()` inside execute.
 */

const ROOT = path.resolve(__dirname, '../..')

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/generation\//, why: 'the generation pipeline' },
  { pattern: /^src\/refinement\//, why: 'the refinement search' },
  { pattern: /^src\/intelligence\//, why: 'part intelligence' },
  { pattern: /^src\/features\/share\//, why: 'the share / publication stack' },
]

function staticSpecifiers(source: string): string[] {
  const found: string[] = []
  const withoutDynamic = source.replace(/\bimport\s*\(/g, 'DYNAMIC_IMPORT(')
  // A brace list may span lines; anything else may not.
  //
  // The previous pattern used `[^;\n]*?`, which stopped at the first newline —
  // so a multi-line `import { a, b } from '…'`, which is how this codebase
  // imports more than one name, was invisible. That left the whole guard blind
  // to the regression it exists to catch: the adapter reaches
  // `src/cad/capabilities.ts` through exactly such an import, and the old
  // pattern reported it unreachable.
  //
  // Letting `[\s\S]*?` run for every statement would over-match instead — a
  // bare `export function` would lazily swallow lines until it found some later
  // `from`, inventing edges. Crossing lines is therefore allowed only inside
  // `{ … }`, which is the only place a real specifier list wraps.
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:\{[\s\S]*?\}|[^;\n]*?)\s*from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutDynamic)) !== null) found.push(match[1])
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  while ((match = bare.exec(withoutDynamic)) !== null) found.push(match[1])
  return found
}

function resolve(specifier: string, fromFile: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate
  }
  return null
}

function staticGraph(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [path.join(ROOT, entry)]
  while (queue.length) {
    const file = queue.shift()!
    const key = path.relative(ROOT, file)
    if (seen.has(key)) continue
    seen.add(key)
    if (/\.(css|json)$/.test(file) || !existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const specifier of staticSpecifiers(source)) {
      const resolved = resolve(specifier, file)
      if (resolved) queue.push(resolved)
    }
  }
  return [...seen]
}

describe('WebMCP adapter import graph', () => {
  const graph = staticGraph('src/webmcp/adapter.ts')

  it.each(FORBIDDEN)('does not statically reach $why', ({ pattern, why }) => {
    const offenders = graph.filter((file) => pattern.test(file))
    expect(offenders, `adapter.ts must not statically pull in ${why}. Reached:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('reaches the new surface modules, which hold the dynamic import() calls', () => {
    expect(graph).toEqual(expect.arrayContaining([
      'src/webmcp/surfaces/intelligence.ts',
      'src/webmcp/surfaces/projects.ts',
      'src/webmcp/surfaces/generation.ts',
      'src/webmcp/surfaces/refinement.ts',
      'src/webmcp/surfaces/share.ts',
    ]))
    expect(graph).not.toContain('src/webmcp/surfaces/shareHost.ts')
    expect(graph).not.toContain('src/generation/mcpHost.ts')
    expect(graph).not.toContain('src/refinement/mcpHost.ts')
  })

  it('sees dependencies imported through a multi-line specifier list', () => {
    // The guard is only worth anything if it can read the imports this codebase
    // actually writes. `adapter.ts` reaches the shared capability vocabulary
    // through a wrapped `import { … } from '../cad/capabilities'`, and a
    // line-bounded pattern missed it — reporting a graph of 42 files that was
    // really larger, and silently excusing anything reachable only that way.
    expect(graph).toContain('src/cad/capabilities.ts')
    expect(graph).toContain('src/cad/engine.ts')
  })

  it('does not invent edges from statements that are not imports', () => {
    // The opposite failure: a pattern permissive enough to cross lines will,
    // from a bare `export function`, swallow whatever comes next until it finds
    // a `from` and report a dependency that does not exist.
    const invented = staticSpecifiers(
      ["export function nothing() {", "  return 1", "}", "", "const x = 2", "import { a } from './real'"].join('\n'),
    )
    expect(invented).toEqual(['./real'])
  })
})

/**
 * The site host sits in the landing document's entry chunk — `AppShell` imports
 * it so `brickwright_navigate` can reach the router — so its static graph is
 * the one thing standing between "tools on every page" and putting the CAD
 * kernel, the demo manifest and zod in front of the landing page's first paint.
 */
describe('WebMCP site host import graph', () => {
  const graph = staticGraph('src/webmcp/site.ts')

  it.each([
    { pattern: /^src\/cad\//, why: 'the CAD kernel' },
    { pattern: /^src\/editor\//, why: 'the editor' },
    { pattern: /^src\/generation\//, why: 'the generation pipeline' },
    { pattern: /^src\/refinement\//, why: 'the refinement search' },
    { pattern: /^src\/demos\//, why: 'the demo manifest' },
    { pattern: /^src\/webmcp\/adapter\.ts$/, why: 'the editor adapter' },
  ])('does not statically reach $why', ({ pattern, why }) => {
    const offenders = graph.filter((file) => pattern.test(file))
    expect(offenders, `site.ts must not statically pull in ${why}. Reached:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('keeps zod out, because it ships in front of the landing page', () => {
    const offenders = graph.filter((file) => {
      if (!existsSync(path.join(ROOT, file))) return false
      return staticSpecifiers(readFileSync(path.join(ROOT, file), 'utf8')).some((spec) => /^zod(\/|$)/.test(spec))
    })
    expect(offenders, `these put zod in the entry chunk: ${offenders.join(', ')}`).toEqual([])
  })

  it('reaches the shell router seam it navigates through', () => {
    expect(graph).toContain('src/features/landing/navigation.ts')
    expect(graph).toContain('src/platform/routes.ts')
    expect(graph).toContain('src/webmcp/register.ts')
  })
})
