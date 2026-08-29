import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The boot budget, enforced against the source rather than against a screenshot.
 *
 * The landing route paints before anything CAD-shaped is fetched. That is a
 * property of the *static* import graph: whatever these modules import at the
 * top level lands in the chunk that has to arrive before the first paint, and
 * whatever they reach through `import()` does not.
 *
 * So this walks the static graph from each surface's entry module and fails if
 * it reaches the compiled catalog, the kernel, the renderer, the WebMCP adapter
 * or the account SDK. The acceptance run asserts the same thing from the other
 * end, against a real network log; this one fails in milliseconds, in CI,
 * without a browser, the moment somebody adds the import.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
/** Modules a pre-catalog surface may not pull into its first chunk. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^three($|\/)/, why: 'the Three.js renderer' },
  { pattern: /^@react-three\//, why: 'the React Three Fiber renderer' },
  { pattern: /^three-mesh-bvh$/, why: 'the collision BVH' },
  { pattern: /^@hexclave\//, why: 'the account SDK, which carries Stripe, Radix and rrweb' },
  { pattern: /^src\/cad\/catalog\.ts$/, why: 'the catalog registry' },
  { pattern: /^src\/cad\/catalog-loader\.ts$/, why: 'the compiled catalog loader' },
  { pattern: /^src\/cad\/engine\.ts$/, why: 'the CAD kernel' },
  { pattern: /^src\/cad\/session\.ts$/, why: 'the project session' },
  { pattern: /^src\/cad\/collision\.ts$/, why: 'the collision kernel' },
  { pattern: /^src\/cad\/snapping\.ts$/, why: 'the connector solver' },
  { pattern: /^src\/cad\/mesh\.ts$/, why: 'the compiled mesh decoder' },
  { pattern: /^src\/App\.tsx$/, why: 'the editor' },
  { pattern: /^src\/webmcp\//, why: 'the WebMCP adapter' },
  { pattern: /^src\/editor\//, why: 'the editor UI' },
]

const ENTRIES = [
  'src/features/landing/LandingPage.tsx',
  'src/features/explore/ExplorePage.tsx',
  'src/features/landing/index.ts',
]

/** Static `import`/`export ... from` specifiers, ignoring `import(...)`. */
function staticSpecifiers(source: string): string[] {
  const found: string[] = []
  // Strip dynamic imports first so their specifiers can never be mistaken for
  // static ones; they are precisely the boundary this test is measuring.
  const withoutDynamic = source.replace(/\bimport\s*\(/g, 'DYNAMIC_IMPORT(')
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutDynamic)) !== null) found.push(match[1])
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  while ((match = bare.exec(withoutDynamic)) !== null) found.push(match[1])
  return found
}

function resolve(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        if (readFileSync(candidate).byteLength >= 0) return candidate
      } catch {
        // A directory, not a file; keep looking.
      }
    }
  }
  return null
}

interface GraphNode {
  file: string
  importedBy: string[]
}

/** Every module reachable from `entry` through static imports only. */
function staticGraph(entry: string): Map<string, GraphNode> {
  const seen = new Map<string, GraphNode>()
  const queue: Array<{ file: string; trail: string[] }> = [{ file: path.join(ROOT, entry), trail: [entry] }]
  const external: Array<{ specifier: string; trail: string[] }> = []

  while (queue.length) {
    const { file, trail } = queue.shift()!
    const key = path.relative(ROOT, file)
    if (seen.has(key)) continue
    seen.set(key, { file: key, importedBy: trail })
    if (/\.(css|json)$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const specifier of staticSpecifiers(source)) {
      const resolved = resolve(specifier, file)
      if (resolved) queue.push({ file: resolved, trail: [...trail, path.relative(ROOT, resolved)] })
      else external.push({ specifier, trail: [...trail, specifier] })
    }
  }

  for (const entryPoint of external) {
    seen.set(entryPoint.specifier, { file: entryPoint.specifier, importedBy: entryPoint.trail })
  }
  return seen
}

describe.each(ENTRIES)('%s', (entry) => {
  const graph = staticGraph(entry)

  it.each(FORBIDDEN)('does not statically reach $why', ({ pattern, why }) => {
    const offenders = [...graph.values()].filter((node) => pattern.test(node.file))
    const trails = offenders.map((node) => node.importedBy.join(' → ')).join('\n  ')
    expect(
      offenders,
      `${entry} must not pull in ${why} before it paints. Reached via:\n  ${trails}\n`
      + 'Load it through a dynamic import() instead, which puts it in its own chunk.',
    ).toEqual([])
  })

  it('reaches the demo manifest, which is the only data it needs to paint', () => {
    expect([...graph.keys()]).toContain('src/demos/manifest.generated.ts')
  })
})

describe('the envelope renderer', () => {
  it('is only ever reached through a dynamic import', () => {
    for (const entry of ['src/features/landing/Hero.tsx', 'src/features/explore/ExplorePage.tsx']) {
      const source = readFileSync(path.join(ROOT, entry), 'utf8')
      expect(source, `${entry} should lazy-load EnvelopeView`).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(/)
      expect(staticSpecifiers(source).some((specifier) => specifier.includes('EnvelopeView'))).toBe(false)
    }
  })

  it('keeps the project store behind a dynamic import in the fork path', () => {
    const source = readFileSync(path.join(ROOT, 'src/features/explore/fork.ts'), 'utf8')
    expect(source).toMatch(/await import\('\.\.\/\.\.\/cad\/persistence'\)/)
    expect(staticSpecifiers(source).some((specifier) => specifier.includes('cad/persistence'))).toBe(false)
  })
})
