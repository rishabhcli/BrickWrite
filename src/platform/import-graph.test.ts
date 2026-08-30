import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two structural guarantees, checked by walking the module graph rather than by
 * reading it.
 *
 * A full `vite build` would prove both more directly, but a build takes tens of
 * seconds and is only run in CI; these assertions have to fail in the same
 * second a bad import is written, which means they have to be a unit test. The
 * build-time evidence is recorded separately in
 * `docs/integration/platform-shell.md`.
 */

const ROOT = resolve(__dirname, '../..')
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

/** Strip comments so a prose mention of a forbidden name is not read as code. */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

interface Specifier {
  request: string
  dynamic: boolean
}

function specifiersOf(source: string): Specifier[] {
  const text = stripNoise(source)
  const found: Specifier[] = []

  // Static `import ... from '…'`, bare `import '…'`, and `export ... from '…'`.
  // `import type` / `export type` are skipped: they are erased before a bundler
  // ever sees them, so they create no edge in the shipped graph.
  const statics = /(?:^|[\s;}])(import|export)(\s+type\s+|\s+|\s*)([^;'"]*?)from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(statics)) {
    const sideEffectOnly = match[5]
    if (sideEffectOnly) {
      found.push({ request: sideEffectOnly, dynamic: false })
      continue
    }
    const isTypeOnly = /^\s+type\s+$/.test(match[2] ?? '')
    if (isTypeOnly) continue
    const clause = match[3] ?? ''
    // `import { type A, type B } from 'x'` erases entirely too.
    const bindings = clause.match(/\{([\s\S]*)\}/)
    if (bindings) {
      const parts = bindings[1]!.split(',').map((part) => part.trim()).filter(Boolean)
      const hasValue = parts.some((part) => !part.startsWith('type '))
      const hasDefaultOrNamespace = /^[^{]*[A-Za-z_$]/.test(clause.split('{')[0] ?? '')
      if (parts.length > 0 && !hasValue && !hasDefaultOrNamespace) continue
    }
    found.push({ request: match[4]!, dynamic: false })
  }

  // Dynamic `import('…')`, excluding the `typeof import('…')` type operator.
  const dynamics = /(\w+\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(dynamics)) {
    if (match[1]?.trim() === 'typeof') continue
    found.push({ request: match[2]!, dynamic: true })
  }

  return found
}

function resolveRelative(fromFile: string, request: string): string | null {
  const base = resolve(dirname(fromFile), request)
  for (const candidate of [base, ...EXTENSIONS.map((ext) => base + ext)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  for (const ext of EXTENSIONS) {
    const indexed = join(base, `index${ext}`)
    if (existsSync(indexed)) return indexed
  }
  return null
}

interface Graph {
  files: string[]
  packages: string[]
  unresolved: string[]
}

function walk(entries: string[], { followDynamic }: { followDynamic: boolean }): Graph {
  const files = new Set<string>()
  const packages = new Set<string>()
  const unresolved = new Set<string>()
  const queue = entries.map((entry) => resolve(ROOT, entry))

  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    if (!existsSync(file)) {
      unresolved.add(file)
      continue
    }
    files.add(file)
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      if (spec.dynamic && !followDynamic) continue
      if (spec.request.startsWith('.')) {
        const target = resolveRelative(file, spec.request)
        if (target) queue.push(target)
        else unresolved.add(`${relative(ROOT, file)} → ${spec.request}`)
        continue
      }
      if (spec.request.startsWith('node:') || spec.request.startsWith('/')) continue
      packages.add(spec.request)
    }
  }

  return {
    files: [...files].map((file) => relative(ROOT, file)),
    packages: [...packages],
    unresolved: [...unresolved],
  }
}

const CLIENT_ENTRIES = ['src/main.tsx', 'src/platform/index.ts']
const FORBIDDEN_IDENTIFIERS = ['HEXCLAVE_SECRET_SERVER_KEY', 'ANTHROPIC_API_KEY', 'HEXCLAVE_SUPER_SECRET_ADMIN_KEY']

describe('client bundle cannot reach a server secret', () => {
  const graph = walk(CLIENT_ENTRIES, { followDynamic: true })

  it('resolves the client entry graph it is asserting over', () => {
    expect(graph.files).toContain('src/main.tsx')
    expect(graph.files).toContain('src/platform/AppShell.tsx')
    expect(graph.files).toContain('src/hexclave/client.ts')
    expect(graph.unresolved, `unresolved imports: ${graph.unresolved.join(', ')}`).toEqual([])
  })

  it('never reaches a server-only module', () => {
    const serverModules = graph.files.filter((file) => /(^|\/)server\//.test(file))
    expect(serverModules, `server modules reachable from the client entry: ${serverModules.join(', ')}`).toEqual([])
    expect(graph.files).not.toContain('convex/model/invitationDelivery.ts')
  })

  it('never reads a server secret', () => {
    const offenders: string[] = []
    for (const file of graph.files) {
      // Comments are stripped first: documenting *why* a key must not appear
      // here is exactly the sort of thing that should stay in the source.
      const code = stripNoise(readFileSync(resolve(ROOT, file), 'utf8'))
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        if (code.includes(identifier)) offenders.push(`${file} reads ${identifier} in code`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('never pulls a server SDK into the browser', () => {
    expect(graph.packages).not.toContain('@anthropic-ai/sdk')
    for (const file of graph.files) {
      const code = stripNoise(readFileSync(resolve(ROOT, file), 'utf8'))
      expect(code, `${file} imports HexclaveServerApp`).not.toMatch(
        /import\s*\{[^}]*HexclaveServerApp[^}]*\}\s*from/,
      )
    }
  })

  it('keeps the server email module honest about being server-only', () => {
    const source = readFileSync(resolve(ROOT, 'src/platform/server/emails.server.ts'), 'utf8')
    expect(source).toContain('HEXCLAVE_SECRET_SERVER_KEY')
    expect(source).toMatch(/typeof window !== 'undefined'/)
  })

  it('has no importer of src/platform/server outside src/platform/server', () => {
    const offenders: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'server') continue
          visit(full)
          continue
        }
        if (!EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
        // Tests are not client modules, and the one that proves the browser
        // guard works has to import the guarded module to prove it.
        if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
        const source = readFileSync(full, 'utf8')
        if (/from\s*['"][^'"]*\/server\/[^'"]*['"]/.test(source) || /import\s*\(\s*['"][^'"]*\/server\/[^'"]*['"]/.test(source)) {
          offenders.push(relative(ROOT, full))
        }
      }
    }
    visit(resolve(ROOT, 'src/platform'))
    expect(offenders, `these import src/platform/server: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('route-level code splitting', () => {
  const eager = walk(['src/platform/index.ts'], { followDynamic: false })
  const landingEntry = walk(['src/main.tsx'], { followDynamic: false })

  it('keeps the renderer out of the shell chunk entirely', () => {
    const rendering = ['three', 'three-mesh-bvh', '@react-three/fiber', '@react-three/drei', 'three-stdlib']
    for (const dependency of rendering) {
      expect(eager.packages, `${dependency} is statically reachable from the shell`).not.toContain(dependency)
    }
    for (const file of eager.files) {
      expect(file, 'the shell statically imports a CAD kernel module').not.toMatch(/^src\/cad\//)
      expect(file, 'the shell statically imports an editor module').not.toMatch(/^src\/editor\//)
    }
  })

  it('keeps Hexclave off the landing document entry', () => {
    expect(landingEntry.packages.some((pkg) => pkg.startsWith('@hexclave/'))).toBe(false)
    expect(landingEntry.files).not.toContain('src/hexclave/client.ts')
    expect(landingEntry.files).not.toContain('src/platform/auth/AccountMenu.tsx')
    expect(landingEntry.files).not.toContain('src/platform/auth/HexclaveLayer.tsx')
  })

  it('reaches the CAD kernel only through dynamic imports', () => {
    const full = walk(['src/platform/index.ts'], { followDynamic: true })
    expect(full.files.some((file) => file.startsWith('src/cad/'))).toBe(true)
    const boot = readFileSync(resolve(ROOT, 'src/platform/boot.ts'), 'utf8')
    expect(boot).toMatch(/await import\('\.\.\/cad\/catalog-loader'\)/)
    expect(boot).not.toMatch(/^import \{[^}]*\} from '\.\.\/cad\//m)
  })

  it('loads every surface lazily, so a route pays only for itself', () => {
    const routes = readFileSync(resolve(ROOT, 'src/platform/routes.ts'), 'utf8')
    expect(routes).not.toMatch(/^import .* from '\.\.\/(cad|editor|features)\//m)
    expect(routes).toMatch(/await import\('\.\/not-installed'\)/)
  })
})
