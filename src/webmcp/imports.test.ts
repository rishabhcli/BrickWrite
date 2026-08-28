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
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g
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
})
